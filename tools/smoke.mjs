#!/usr/bin/env node
/**
 * Headless smoke test: serves dist/ with `vite preview`, boots the game in headless Chromium
 * (SwiftShader WebGL2), drives movement, captures screenshots + stats into smoke-output/.
 *
 * Usage: npm run build && npm run smoke [-- --dev] [-- --keep-open]
 *   --dev        use the Vite dev server instead of the production build
 *   --width/--height  viewport size (default 1280x720)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const useDev = args.includes('--dev');
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const width = Number(argVal('--width', 1280));
const height = Number(argVal('--height', 720));
const port = useDev ? 5199 : 4199;
const outDir = 'smoke-output';
mkdirSync(outDir, { recursive: true });

if (!useDev && !existsSync('dist/index.html')) {
  console.error('dist/ missing – run `npm run build` first (or pass --dev).');
  process.exit(2);
}

const server = spawn('npx', ['vite', useDev ? 'dev' : 'preview', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BROWSER: 'none' },
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const base = `http://localhost:${port}/`;
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not start:\n' + serverLog);
}

const report = { consoleErrors: [], consoleWarnings: [], pageErrors: [], steps: [], ok: false };
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') report.consoleErrors.push(msg.text());
    else if (t === 'warning') report.consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => report.pageErrors.push(String(err?.stack || err)));

  const t0 = Date.now();
  await page.goto(`${base}?autostart=1&nolock=1&smoke=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__RIFTFALL__?.ready === true, null, { timeout: 180_000 });
  report.bootMs = Date.now() - t0;
  // Record movement events in-page: SwiftShader runs at a few FPS, so single snapshots can miss
  // short states; the event log is timing-independent.
  await page.evaluate(() => {
    const ev = window.__RIFTFALL__.game.events;
    window.__events = [];
    for (const type of ['player:jump', 'player:slideStart', 'player:dash', 'player:mantle', 'player:land']) {
      ev.on(type, (e) => window.__events.push({ type, double: e.double }));
    }
  });
  await sleep(2500);

  const snap = async (name) => {
    await page.screenshot({ path: `${outDir}/${name}.png` });
    const s = await page.evaluate(() => window.__RIFTFALL__.snapshot());
    report.steps.push({ name, ...s });
    return s;
  };
  const hold = async (keys, ms) => {
    for (const k of keys) await page.keyboard.down(k);
    await sleep(ms);
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
  };
  const look = (yawDeg, pitchDeg = 0) =>
    page.evaluate(([y, p]) => window.__RIFTFALL__.setLook(y, p), [yawDeg, pitchDeg]);

  const start = await snap('01-spawn');
  await hold(['KeyW'], 1200);
  await snap('02-walk');
  await hold(['ShiftLeft', 'KeyW'], 1200);
  await page.keyboard.press('Space');
  // Second press only once airborne (frame times vary wildly under SwiftShader).
  await page.waitForFunction(() => window.__RIFTFALL__.snapshot().state === 'air', null, { timeout: 5000 });
  await sleep(150);
  await page.keyboard.press('Space');
  await sleep(600);
  await snap('03-sprint-doublejump');
  // Slide test on a clear lane through the arena (z = 10, running towards +X).
  await page.evaluate(() => window.__RIFTFALL__.teleport(-10, 0.1, 10, -90, 0));
  await sleep(600);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await sleep(1200);
  await page.keyboard.down('KeyC');
  await sleep(500);
  const slide = await page.evaluate(() => window.__RIFTFALL__.snapshot());
  report.steps.push({ name: 'slide-probe', ...slide });
  await page.keyboard.up('KeyC');
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.press('KeyQ');
  await sleep(400);
  await snap('04-after-dash');
  for (const [i, yaw] of [90, 180, 270].entries()) {
    await look(yaw, -5);
    await sleep(500);
    await snap(`05-view-${i}`);
  }
  await page.keyboard.press('F3');
  await sleep(700);
  await snap('06-debug-overlay');
  await page.keyboard.press('F3');
  await page.keyboard.press('Backquote');
  await sleep(300);
  await page.keyboard.type('help');
  await page.keyboard.press('Enter');
  await sleep(300);
  await snap('07-console');
  await page.keyboard.press('Backquote');
  const end = report.steps[report.steps.length - 1];
  const moved = Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2]);
  report.movedMeters = moved;
  const events = await page.evaluate(() => window.__events);
  const count = (t) => events.filter((e) => e.type === t).length;
  report.events = {
    jump: count('player:jump'),
    doubleJump: events.filter((e) => e.double).length,
    slide: count('player:slideStart'),
    dash: count('player:dash'),
    land: count('player:land'),
  };
  report.slideDetected = report.events.slide > 0 || slide.state === 'slide';
  report.ok =
    report.pageErrors.length === 0 &&
    moved > 2 &&
    report.events.jump > 0 &&
    report.events.doubleJump > 0 &&
    report.slideDetected &&
    report.events.dash > 0;
} catch (err) {
  report.fatal = String(err?.stack || err);
} finally {
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}
console.info(
  JSON.stringify(
    {
      ok: report.ok,
      bootMs: report.bootMs,
      events: report.events,
      moved: report.movedMeters,
      slide: report.slideDetected,
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      fatal: report.fatal,
    },
    null,
    2,
  ),
);
process.exit(report.ok ? 0 : 1);
