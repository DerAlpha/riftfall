#!/usr/bin/env node
/**
 * Photo mode for art-direction passes: boots the production build in headless Chromium with a
 * forced preset, teleports to a list of viewpoints and saves screenshots to smoke-output/photo-*.png.
 *
 * Usage: npm run build && node tools/photo.mjs [--preset ultra] [--hud] [--spots '[[x,y,z,yaw,pitch],...]']
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
const map = argVal('--map', 'testroom');
const preset = argVal('--preset', 'ultra');
const showHud = args.includes('--hud');
const prefix = argVal('--prefix', 'photo');
const DEFAULT_SPOTS = [
  [0, 0, 25, 0, -2],
  [0, 0, 25, 0, 28],
  [-18, 0, 18, -45, 2],
  [0, 0, -14, 0, 0],
  [-14, 0, 8, 90, 4],
  [24, 0, 26, 0, 0],
  [14, 0, -18, 150, 10],
];
const spots = JSON.parse(argVal('--spots', JSON.stringify(DEFAULT_SPOTS)));
const port = 4299;
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

const errors = [];
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
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}?autostart=1&nolock=1&smoke=1&map=${map}&preset=${preset}`);
  await page.waitForFunction(() => window.__RIFTFALL__?.ready === true, null, { timeout: 240_000 });
  if (!showHud) await page.addStyleTag({ content: '#hud{display:none!important}' });
  // Fix dynamic resolution at full scale so shots are comparable.
  await page.evaluate(() => window.__RIFTFALL__.exec('rscale 1'));
  await sleep(3000);
  for (const cmd of JSON.parse(argVal('--exec', '[]')))
    await page.evaluate((c) => window.__RIFTFALL__.exec(c), cmd);
  for (const [i, s] of spots.entries()) {
    await page.evaluate((sp) => window.__RIFTFALL__.teleport(...sp), s);
    await sleep(2500);
    await page.screenshot({ path: `smoke-output/${prefix}-${i}.png` });
  }
  const info = await page.evaluate(() => ({
    ...window.__RIFTFALL__.snapshot(),
    passes: window.__RIFTFALL__.game.sys.render.composerInfo,
  }));
  writeFileSync(`smoke-output/${prefix}-info.json`, JSON.stringify({ preset, info, errors }, null, 2));
  console.info(
    JSON.stringify({ preset, errors: errors.length, drawCalls: info.drawCalls, triangles: info.triangles }),
  );
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
