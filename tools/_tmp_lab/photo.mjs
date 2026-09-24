// Temporary lab photo harness (deleted after the work package).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const preset = argVal('--preset', 'high');
const prefix = argVal('--prefix', 'lab');
const spots = JSON.parse(argVal('--spots', '[[0,0,27,0,0]]'));
const execs = JSON.parse(argVal('--exec', '[]'));
const width = Number(argVal('--w', '1280'));
const height = Number(argVal('--h', '720'));
const port = 4787;
const outDir = 'tools/_tmp_lab/shots';
mkdirSync(outDir, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--config', 'tools/_tmp_lab/vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const base = `http://localhost:${port}/`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* retry */ }
  await sleep(200);
}
const errors = [];
const logs = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); else logs.push(m.text()); });
  await page.goto(`${base}?autostart=1&nolock=1&smoke=1&preset=${preset}`);
  await page.waitForFunction(() => window.__RIFTFALL__?.ready === true, null, { timeout: 300_000 });
  await page.addStyleTag({ content: '#hud{display:none!important}' });
  await page.evaluate(() => window.__RIFTFALL__.exec('rscale 1'));
  await page.evaluate(() => window.__RIFTFALL__.exec('noclip on'));
  await sleep(2000);
  for (const cmd of execs) await page.evaluate((c) => window.__RIFTFALL__.exec(c), cmd);
  for (const [i, s] of spots.entries()) {
    await page.evaluate((sp) => window.__RIFTFALL__.teleport(...sp), s);
    await sleep(2200);
    await page.screenshot({ path: `${outDir}/${prefix}-${i}.png` });
  }
  const info = await page.evaluate(() => window.__RIFTFALL__.snapshot());
  writeFileSync(`${outDir}/${prefix}-info.json`, JSON.stringify({ preset, info, errors, logs: logs.slice(-40) }, null, 2));
  console.info(JSON.stringify({ preset, errors: errors.slice(0, 20), drawCalls: info.drawCalls, triangles: info.triangles, fps: info.fps }));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
