#!/usr/bin/env node
/**
 * Wave scenario on a wave map (default: the research lab): boots the production build in headless
 * Chromium, skips the intermission, lets enemies spawn, chase and attack (god mode), looks at them,
 * kills them, checks wave completion and the game-over flow. Screenshots + report in smoke-output/.
 *
 * Usage: npm run build && node tools/waves.mjs [--map lab] [--preset low]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const map = argVal('--map', 'lab');
const preset = argVal('--preset', 'low');
const port = 4499;
mkdirSync('smoke-output', { recursive: true });

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'],
  { stdio: 'ignore' },
);
const base = `http://localhost:${port}/`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* retry */
  }
  await sleep(200);
}

const report = { map, pageErrors: [], consoleErrors: [], ok: false };
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => report.pageErrors.push(String(e?.stack || e)));
  page.on('console', (m) => m.type() === 'error' && report.consoleErrors.push(m.text()));
  const t0 = Date.now();
  await page.goto(`${base}?autostart=1&nolock=1&smoke=1&map=${map}&preset=${preset}`);
  await page.waitForFunction(() => window.__RIFTFALL__?.ready === true, null, { timeout: 240_000 });
  report.bootMs = Date.now() - t0;
  const exec = (line) => page.evaluate((l) => window.__RIFTFALL__.exec(l), line);
  await page.evaluate(() => {
    const g = window.__RIFTFALL__.game;
    window.__ev = {};
    for (const t of [
      'wave:intermission',
      'wave:start',
      'wave:complete',
      'enemy:spawned',
      'enemy:alert',
      'enemy:attack',
      'enemy:died',
      'player:damaged',
      'player:died',
      'run:over',
      'combat:kill',
    ]) {
      g.sys.events.on(t, () => (window.__ev[t] = (window.__ev[t] ?? 0) + 1));
    }
    window.__info = () => {
      const s = g.sys;
      return {
        wave: s.waves.wave,
        waveState: s.waves.state,
        alive: s.enemies.alive,
        nav: s.nav.stats.mode,
        polys: s.nav.stats.polys,
        fps: g.loop.stats.frameDelta > 0 ? 1 / g.loop.stats.frameDelta : 0,
        drawCalls: s.render.stats.drawCalls,
        run: s.runFlow.state,
        hp: s.health.health,
      };
    };
    /** Aim the player at the nearest living enemy (smoke only). */
    window.__lookAtEnemy = () => {
      const s = g.sys;
      let best = null;
      let bestD = Infinity;
      for (const t of s.combat.targets) {
        if (!t.alive || t.team !== 'enemy') continue;
        const d = t.aimPoint.distanceTo(s.player.eyePosition);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) return false;
      const dx = best.aimPoint.x - s.player.eyePosition.x;
      const dy = best.aimPoint.y - s.player.eyePosition.y;
      const dz = best.aimPoint.z - s.player.eyePosition.z;
      s.player.yaw = Math.atan2(-dx, -dz);
      s.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      return true;
    };
  });
  await exec('god on');
  await exec('infammo on');
  await sleep(2000);
  await page.screenshot({ path: 'smoke-output/waves-00-start.png' });
  await exec('wave skip');
  // Let the wave spawn and the enemies reach the player.
  await page
    .waitForFunction(() => (window.__ev['enemy:spawned'] ?? 0) >= 3, null, { timeout: 120_000, polling: 250 })
    .catch(() => {});
  report.afterSpawn = await page.evaluate(() => window.__info());
  await sleep(8000);
  await page.evaluate(() => window.__lookAtEnemy());
  await sleep(600);
  await page.screenshot({ path: 'smoke-output/waves-01-enemies.png' });
  // Shoot at whatever is closest for a while.
  const canvas = await page.$('#game-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.__lookAtEnemy());
    await page.mouse.down();
    await sleep(700);
    await page.mouse.up();
  }
  await page.screenshot({ path: 'smoke-output/waves-02-fight.png' });
  report.midFight = await page.evaluate(() => window.__info());
  // Spawn a tank and a spitter close by for a look.
  await exec('enemy spawn tank 1 9');
  await exec('enemy spawn spitter 2 12');
  await sleep(6000);
  await page.evaluate(() => window.__lookAtEnemy());
  await sleep(500);
  await page.screenshot({ path: 'smoke-output/waves-03-types.png' });
  // Clear the wave (the director keeps spawning its queue): kill until wave:complete fires.
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__ev['wave:complete'] ?? 0) >= 1)) break;
    await exec('enemy kill');
    await sleep(2500);
  }
  // Game over flow.
  await exec('god off');
  await exec('run kill');
  await page
    .waitForFunction(() => (window.__ev['run:over'] ?? 0) >= 1, null, { timeout: 30_000, polling: 250 })
    .catch(() => {});
  await sleep(1500);
  await page.screenshot({ path: 'smoke-output/waves-04-gameover.png' });
  report.events = await page.evaluate(() => window.__ev);
  report.end = await page.evaluate(() => window.__info());
  const e = report.events;
  report.ok =
    report.pageErrors.length === 0 &&
    (e['wave:start'] ?? 0) >= 1 &&
    (e['enemy:spawned'] ?? 0) >= 3 &&
    (e['enemy:attack'] ?? 0) >= 1 &&
    (e['enemy:died'] ?? 0) >= 1 &&
    (e['wave:complete'] ?? 0) >= 1 &&
    (e['run:over'] ?? 0) >= 1;
} catch (err) {
  report.fatal = String(err?.stack || err);
} finally {
  writeFileSync('smoke-output/waves-report.json', JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
}
console.info(
  JSON.stringify(
    {
      ok: report.ok,
      bootMs: report.bootMs,
      events: report.events,
      afterSpawn: report.afterSpawn,
      end: report.end,
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      fatal: report.fatal,
    },
    null,
    2,
  ),
);
process.exit(report.ok ? 0 : 1);
