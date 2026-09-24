#!/usr/bin/env node
/**
 * M4 economy scenario on a wave map (default: the research lab). Boots the production build in
 * headless Chromium and plays the whole economy loop with real inputs – teleport next to an object,
 * look at it, press / hold F; mouse clicks to shoot, W to walk into pickups – and uses dev commands
 * only for setup (god mode, starting the wave, topping up points, spawning test subjects):
 *
 *   1. the run starts with 500 points (economy and HUD),
 *   2. wave 1: enemies breach a rift seal (seal:broken), the pistol kills them → economy:points
 *      with the reasons hit / kill / headshot (+ the wave bonus),
 *   3. the first door, paid with the earned points (door:opened, zone:activated, navmesh path),
 *   4. a wall weapon, then its ammo, 5. a Rift-Kiste roll and taking the weapon,
 *   6. a perk machine (the perk's stat modifiers show in the stat table),
 *   7. the breached seal repaired by holding interact (seal:repaired, repair points),
 *   8. every power-up type spawned and collected by walking into it, each effect checked,
 *   9. death → game over → "Neu starten": 500 points, doors closed, perks gone, seals intact.
 *
 * Screenshots: smoke-output/economy-*.png, report: smoke-output/economy-report.json. Exit code 0
 * only when every check passed (and the page threw nothing).
 *
 * Usage: npm run build && node tools/economy.mjs [--map lab] [--preset low] [--port 4599] [--dist dist]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const map = argVal('--map', 'lab');
const preset = argVal('--preset', 'low');
const port = Number(argVal('--port', 4599));
const dist = argVal('--dist', 'dist');
const OUT = 'smoke-output';
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`${dist}/ missing – run \`npm run build\` first.`);
  process.exit(2);
}

/** Start points of a wave map run (defs/economy.ts ECONOMY.startPoints). */
const START_POINTS = 500;
/** Horizontal distance (m) from an interactable's prompt anchor to where the player stands. */
const STAND = { door: 1.3, wallBuy: 1.15, box: 1.2, perk: 1.1, seal: 1.4 };
/** A navmesh path "reaches" its goal when its last corner is this close (m, XZ). */
const PATH_REACH = 1;

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--outDir', dist],
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

const report = {
  map,
  preset,
  ok: false,
  checks: [],
  notes: [],
  pageErrors: [],
  consoleErrors: [],
};
const t0 = Date.now();
/** The game page (module scope: the report reads its event log even after a failure). */
let page = null;

/** Record a check (never throws: the scenario goes on to collect every failure). */
function check(name, ok, detail = {}) {
  report.checks.push({ name, ok: !!ok, ...detail });
  console.info(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  return !!ok;
}
const note = (msg) => {
  report.notes.push(msg);
  console.info(`note ${msg}`);
};

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
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => report.pageErrors.push(String(e?.stack || e)));
  page.on('console', (m) => m.type() === 'error' && report.consoleErrors.push(m.text()));
  await page.goto(`${base}?autostart=1&nolock=1&smoke=1&map=${map}&preset=${preset}`);
  await page.waitForFunction(() => window.__RIFTFALL__?.ready === true, null, { timeout: 240_000 });
  report.bootMs = Date.now() - t0;

  await page.evaluate(installHarness);

  // --- page helpers --------------------------------------------------------------------------
  const exec = (line) => page.evaluate((l) => window.__RIFTFALL__.exec(l), line);
  const h = (fn, arg) => page.evaluate(fn, arg);
  const info = () => h(() => window.__h.info());
  const count = (type) => h((t) => window.__ev[t] ?? 0, type);
  const events = (type, phase) =>
    h(([t, p]) => window.__log.filter((e) => e.t === t && (p === undefined || e.phase === p)), [type, phase]);
  const setPhase = (p) => h((x) => (window.__phase = x), p);
  /** Poll `fn(arg)` in the page until truthy; false on timeout (never throws). */
  const until = (fn, arg, timeout = 30_000, polling = 150) =>
    page
      .waitForFunction(fn, arg, { timeout, polling })
      .then(() => true)
      .catch(() => false);
  const untilEvent = (type, from, timeout = 30_000) =>
    until(([t, n]) => (window.__ev[t] ?? 0) > n, [type, from], timeout);
  /** Let `n` unpaused frames pass (the aim harness applies the look once per frame). */
  const frames = async (n = 2) => {
    const start = await h(() => window.__frames);
    await until(([s, k]) => window.__frames >= s + k, [start, n], 20_000, 50);
  };
  const shot = (name) => page.screenshot({ path: `${OUT}/economy-${name}.png` }).catch(() => {});
  const aimPoint = (p) => h((q) => (window.__aim = q ? { kind: 'point', ...q } : null), p);

  const canvas = await page.$('#game-canvas');
  const cbox = await canvas.boundingBox();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);

  /** One trigger pull: press until the weapon reports a shot (or `timeout`), release. */
  const fireOnce = async (timeout = 5000) => {
    const before = await count('weapon:fired');
    await page.mouse.down();
    const ok = await untilEvent('weapon:fired', before, timeout);
    await page.mouse.up();
    return ok;
  };
  /** `n` trigger pulls (semi-automatic weapons fire once per pull, automatic ones at least once). */
  const fireShots = async (n) => {
    let ok = true;
    for (let i = 0; i < n; i++) ok = (await fireOnce()) && ok;
    return ok;
  };
  /** Reload by key when the magazine is empty (or `force` and not full); waits for the new rounds. */
  const reload = async (force = false) => {
    const a = (await info()).ammo;
    if (!a || a.reserve <= 0 || (!force && a.mag > 0) || a.mag >= a.magSize) return false;
    const before = await count('weapon:reloadEnd');
    await page.keyboard.press('KeyR');
    return untilEvent('weapon:reloadEnd', before, 20_000);
  };
  /** Stand in front of an interactable (see __h.standAt), wait until the interaction focuses it. */
  const approach = async (id, anchor, out, dist) => {
    await h(([a, o, d]) => window.__h.standAt(a, o, d), [anchor, out, dist]);
    await frames(3);
    return until((want) => window.__h.focusId() === want, id, 20_000);
  };
  /** Press F once (a tap is latched even inside one frame). */
  const pressInteract = () => page.keyboard.press('KeyF');
  /** Collect a power-up with real movement: spawn it ahead (`powerup <type>`), walk into it. */
  const collectPowerUp = async (type) => {
    await h(() => window.__h.powerUpLane());
    await frames(2);
    const before = await h(
      (t) => window.__log.filter((e) => e.t === 'powerup:collected' && e.type === t).length,
      type,
    );
    await exec(`powerup ${type}`);
    const spawned = await until(
      (t) => window.__log.some((e) => e.t === 'powerup:spawned' && e.type === t),
      type,
      10_000,
    );
    await page.keyboard.down('KeyW');
    const got = await until(
      ([t, n]) => window.__log.filter((e) => e.t === 'powerup:collected' && e.type === t).length > n,
      [type, before],
      30_000,
      50,
    );
    await page.keyboard.up('KeyW');
    await frames(2);
    return { spawned, collected: got };
  };
  const pointsOf = async (reason, phase) =>
    (await events('economy:points', phase)).filter((e) => e.reason === reason);

  // =============================================================================================
  // 1. Start
  // =============================================================================================
  await setPhase('start');
  await frames(4);
  const startInfo = await info();
  report.start = startInfo;
  check('start: 500 points', startInfo.points === START_POINTS, { points: startInfo.points });
  const hudStart = await until((p) => window.__h.hudPoints() === p, START_POINTS, 20_000);
  check('start: HUD shows 500 points', hudStart, { hud: await h(() => window.__h.hudPoints()) });
  check('start: only the start zone is active', startInfo.zones.length === 1, { zones: startInfo.zones });
  await shot('00-start');
  // Too poor for the door: the purchase is refused (economy:purchase ok=false), nothing changes.
  {
    const d = await h(() => window.__h.firstDoor());
    if (d && startInfo.points < d.price) {
      const focusedPoor = await approach(d.id, d.anchor, d.out, STAND.door);
      const prompt = await h(() => window.__log.filter((e) => e.t === 'interact:focus').pop() ?? null);
      const before = await count('economy:purchase');
      await pressInteract();
      const tried = await untilEvent('economy:purchase', before, 15_000);
      const attempt = (await events('economy:purchase', 'start')).pop();
      check(
        'start: unaffordable door refused (economy:purchase ok=false)',
        focusedPoor && prompt?.affordable === false && tried && attempt?.ok === false,
        { prompt, attempt },
      );
      check(
        'start: refused door stays closed, points unchanged',
        (await h((id) => window.__h.doorState(id), d.id)) === 'closed' &&
          (await info()).points === startInfo.points,
        { points: (await info()).points },
      );
      await shot('00-door-refused');
      await h(() => window.__h.backToSpawn());
      await frames(2);
    }
  }

  // =============================================================================================
  // 2. Wave 1: enemies breach a seal, the pistol earns points
  // =============================================================================================
  await setPhase('combat');
  await exec('god on');
  await exec('wave skip');
  const spawned = await until(() => (window.__ev['enemy:spawned'] ?? 0) >= 1, null, 120_000);
  check('combat: wave 1 enemies spawn', spawned, { info: await info() });
  // The enemies have to tear down at least one bar before we shoot: the seal is breached by them.
  const breached = await until(() => (window.__ev['seal:broken'] ?? 0) >= 1, null, 150_000);
  const brokenByEnemies = await events('seal:broken', 'combat');
  check('seal: enemies breach a rift seal (seal:broken)', breached && brokenByEnemies.length > 0, {
    broken: brokenByEnemies.length,
  });
  if (breached) {
    await h((id) => window.__h.lookAtSeal(id), brokenByEnemies[0].sealId);
    await frames(3);
    await shot('01-breach');
  }
  await h(() => window.__h.backToSpawn());
  await frames(2);
  const pistolId = (await info()).weapon;
  // Kill the wave with the pistol: body shots (hit, then kill) and head shots (headshot kills).
  const zoneOf = new Map();
  const combatDeadline = Date.now() + 360_000;
  let lastPick = null;
  while (Date.now() < combatDeadline) {
    const st = await info();
    if ((await count('wave:complete')) >= 1) break;
    const reasons = await h(() => {
      const r = {};
      for (const e of window.__log) if (e.t === 'economy:points') r[e.reason] = (r[e.reason] ?? 0) + 1;
      return r;
    });
    const pick = await h(() => window.__h.nearestEnemy());
    if (!pick) {
      await sleep(400);
      continue;
    }
    if (!zoneOf.has(pick.id)) {
      const zone = !reasons.kill ? 'body' : !reasons.headshot ? 'head' : pick.id % 2 === 0 ? 'head' : 'body';
      zoneOf.set(pick.id, zone);
    }
    await h(([id, zone]) => (window.__aim = { kind: 'target', id, zone }), [pick.id, zoneOf.get(pick.id)]);
    if (lastPick !== pick.id) await frames(2);
    lastPick = pick.id;
    if (st.ammo && st.ammo.mag <= 0) {
      await reload();
      continue;
    }
    await fireOnce();
    await frames(1);
  }
  await aimPoint(null);
  const waveDone = (await count('wave:complete')) >= 1;
  check('combat: wave 1 cleared with the pistol', waveDone, { info: await info() });
  if (!waveDone) {
    note('wave 1 not cleared in time – remaining enemies killed by console (enemy kill)');
    await exec('enemy kill');
  }
  // Setup: no further waves while the purchases are tested.
  await exec('wave stop');
  const combatPoints = await events('economy:points', 'combat');
  const byReason = (r) => combatPoints.filter((e) => e.reason === r && e.delta > 0);
  report.combatPoints = {
    hit: byReason('hit').length,
    kill: byReason('kill').length,
    headshot: byReason('headshot').length,
    wave: byReason('wave').map((e) => e.delta),
    earned: combatPoints.filter((e) => e.delta > 0).reduce((a, e) => a + e.delta, 0),
  };
  check('points: hit reward (economy:points reason hit)', byReason('hit').length > 0, report.combatPoints);
  check('points: kill reward (reason kill)', byReason('kill').length > 0, report.combatPoints);
  check('points: headshot reward (reason headshot)', byReason('headshot').length > 0, report.combatPoints);
  if (waveDone) check('points: wave bonus (reason wave)', byReason('wave').length > 0, report.combatPoints);
  const pistolKills = (await events('enemy:died', 'combat')).filter(
    (e) => e.source === 'player' && e.weaponId === pistolId,
  );
  check('combat: kills credited to the pistol', pistolKills.length > 0, {
    pistol: pistolId,
    kills: pistolKills.length,
  });
  const afterCombat = await info();
  check(
    'points: balance grew by the earnings',
    afterCombat.points === START_POINTS + report.combatPoints.earned,
    {
      points: afterCombat.points,
      earned: report.combatPoints.earned,
    },
  );
  await shot('02-combat');

  // =============================================================================================
  // 3. The first door
  // =============================================================================================
  await setPhase('door');
  await h(() => window.__h.backToSpawn());
  await frames(2);
  const door = await h(() => window.__h.firstDoor());
  if (!check('door: a closed door near the spawn', door !== null, {})) throw new Error('no door');
  const pathBefore = await h(([a, b]) => window.__h.pathReach(a, b), [door.from, door.behind]);
  check('door: closed door blocks the navmesh path', pathBefore.gap > PATH_REACH, { path: pathBefore });
  let funds = 'earned';
  if (afterCombat.points < door.price) {
    funds = 'dev';
    await exec(`points ${door.price - afterCombat.points}`);
  }
  report.doorFunds = funds;
  const focused = await approach(door.id, door.anchor, door.out, STAND.door);
  check('door: interaction focuses the door', focused, { focus: await h(() => window.__h.focusId()) });
  await shot('03-door-prompt');
  const pointsBeforeDoor = (await info()).points;
  const doorEv = await count('door:opened');
  await pressInteract();
  const opened = await untilEvent('door:opened', doorEv, 20_000);
  const doorPurchase = (await events('economy:purchase', 'door')).find((e) => e.kind === 'door');
  const zonesOn = (await events('zone:activated', 'door')).map((e) => e.zone);
  check('door: F buys and opens it (door:opened)', opened, { door: door.id });
  check('door: paid with the door price', doorPurchase?.ok === true && doorPurchase.cost === door.price, {
    purchase: doorPurchase,
    funds,
  });
  check('door: points deducted', (await info()).points === pointsBeforeDoor - door.price, {
    before: pointsBeforeDoor,
    after: (await info()).points,
  });
  check('door: zone behind it activated (zone:activated)', zonesOn.includes(door.zoneBehind), {
    zones: zonesOn,
    expected: door.zoneBehind,
  });
  const doorOpen = await until((id) => window.__h.doorState(id) === 'open', door.id, 30_000);
  const pathAfter = await h(([a, b]) => window.__h.pathReach(a, b), [door.from, door.behind]);
  check('door: navmesh path leads through the open door', doorOpen && pathAfter.gap <= PATH_REACH, {
    state: await h((id) => window.__h.doorState(id), door.id),
    path: pathAfter,
  });
  await shot('04-door-open');

  // Setup: enough points for every purchase below.
  await exec('points 20000');

  // =============================================================================================
  // 4. Wall weapon + its ammo
  // =============================================================================================
  await setPhase('wallbuy');
  const wb = await h(() => window.__h.firstWallBuy());
  if (!check('wallbuy: an unowned wall weapon', wb !== null, {})) throw new Error('no wall buy');
  check('wallbuy: interaction focuses the board', await approach(wb.id, wb.anchor, null, STAND.wallBuy), {
    focus: await h(() => window.__h.focusId()),
    wallBuy: wb.id,
  });
  await shot('05-wallbuy-prompt');
  const equipBefore = await count('weapon:equipped');
  let pts = (await info()).points;
  await pressInteract();
  const bought = await until(
    (w) =>
      window.__log.some((e) => e.t === 'economy:purchase' && e.kind === 'weapon' && e.item === w && e.ok),
    wb.weaponId,
    15_000,
  );
  check('wallbuy: weapon bought (economy:purchase weapon)', bought, { weapon: wb.weaponId, price: wb.price });
  check('wallbuy: weapon price deducted', (await info()).points === pts - wb.price, {
    before: pts,
    after: (await info()).points,
  });
  const equipped = await until(
    ([w, n]) =>
      (window.__ev['weapon:equipped'] ?? 0) > n && window.__RIFTFALL__.game.sys.weapons.currentWeaponId === w,
    [wb.weaponId, equipBefore],
    30_000,
  );
  check('wallbuy: bought weapon in hand', equipped, { current: (await info()).weapon });
  // Spend some rounds: a full weapon refuses the refill ("Munition voll").
  await fireShots(3);
  await frames(3);
  const ammoBefore = await h((w) => window.__h.ammoOf(w), wb.weaponId);
  const ammoOffered = await until(
    ([id, cost]) => {
      const f = window.__RIFTFALL__.game.sys.interaction.focused;
      return f?.id === id && f.cost() === cost;
    },
    [wb.id, wb.ammoPrice],
    20_000,
  );
  check('wallbuy: ammo offered after firing', ammoOffered, { ammo: ammoBefore, ammoPrice: wb.ammoPrice });
  pts = (await info()).points;
  await pressInteract();
  const ammoBought = await until(
    (w) =>
      window.__log.some(
        (e) => e.t === 'economy:purchase' && e.kind === 'ammo' && e.item === `ammo:${w}` && e.ok,
      ),
    wb.weaponId,
    15_000,
  );
  await frames(2);
  const ammoAfter = await h((w) => window.__h.ammoOf(w), wb.weaponId);
  check(
    'wallbuy: ammo bought and refilled',
    ammoBought &&
      ammoAfter &&
      ammoAfter.reserve >= ammoAfter.maxReserve &&
      ammoAfter.mag >= ammoAfter.magSize,
    { before: ammoBefore, after: ammoAfter, points: [pts, (await info()).points], ammoPrice: wb.ammoPrice },
  );
  check('wallbuy: ammo price deducted', (await info()).points === pts - wb.ammoPrice, {
    before: pts,
    after: (await info()).points,
  });
  await shot('06-wallbuy');

  // =============================================================================================
  // 5. Rift-Kiste: roll and take the weapon
  // =============================================================================================
  await setPhase('box');
  const box = await h(() => window.__h.boxInfo());
  if (!check('box: a Rift-Kiste on the map', box !== null, {})) throw new Error('no box');
  check('box: interaction focuses the box', await approach(box.id, box.anchor, box.out, STAND.box), {
    focus: await h(() => window.__h.focusId()),
    location: box.location,
  });
  pts = (await info()).points;
  const boxOpenedBefore = await count('box:opened');
  await pressInteract();
  const rolled = await untilEvent('box:opened', boxOpenedBefore, 15_000);
  const boxPurchase = (await events('economy:purchase', 'box')).find((e) => e.kind === 'box');
  check(
    'box: roll bought (box:opened, box price)',
    rolled && boxPurchase?.ok && boxPurchase.cost === box.price,
    {
      purchase: boxPurchase,
    },
  );
  check('box: price deducted', (await info()).points === pts - box.price, {
    before: pts,
    after: (await info()).points,
  });
  await frames(6);
  await shot('07-box-rolling');
  const resolved = await until(() => window.__log.some((e) => e.t === 'box:resolved'), null, 90_000);
  const result = (await events('box:resolved', 'box'))[0]?.weaponId ?? null;
  check('box: roll resolves to a weapon (box:resolved)', resolved && result !== null, { weapon: result });
  const offerFocused = await until(
    () => {
      const s = window.__RIFTFALL__.game.sys;
      return (
        s.interactables.box?.state === 'offering' && s.interaction.focused?.id === s.interactables.box.id
      );
    },
    null,
    30_000,
  );
  await shot('08-box-offer');
  await pressInteract();
  const taken = await until(
    (w) => w !== null && window.__RIFTFALL__.game.sys.weapons.slotIds.includes(w),
    result,
    20_000,
  );
  check('box: F takes the offered weapon', offerFocused && taken, {
    weapon: result,
    slots: (await info()).slots,
    boxState: await h(() => window.__RIFTFALL__.game.sys.interactables.box?.state),
  });
  await frames(6);
  await shot('09-box-taken');

  // =============================================================================================
  // 6. Perk machine
  // =============================================================================================
  await setPhase('perk');
  const perk = await h(() => window.__h.firstPerk());
  if (!check('perk: an available perk machine', perk !== null, {})) throw new Error('no perk machine');
  check('perk: interaction focuses the machine', await approach(perk.id, perk.anchor, null, STAND.perk), {
    focus: await h(() => window.__h.focusId()),
    perk: perk.perkId,
  });
  await shot('10-perk-prompt');
  pts = (await info()).points;
  const perkEv = await count('perk:acquired');
  await pressInteract();
  const perkGot = await untilEvent('perk:acquired', perkEv, 15_000);
  await frames(3);
  const perkAfter = await h((p) => window.__h.perkEffect(p), perk);
  check('perk: bought (perk:acquired, owned)', perkGot && perkAfter.owned, {
    perk: perk.perkId,
    owned: perkAfter,
  });
  check('perk: price deducted', (await info()).points === pts - perk.price, {
    before: pts,
    after: (await info()).points,
    price: perk.price,
  });
  check('perk: stat modifiers applied', perkAfter.statsOk, { stats: perkAfter.stats });
  if (perkAfter.maxHealth !== null) {
    check('perk: max health follows the stat', perkAfter.maxHealth.ok, perkAfter.maxHealth);
  }
  await shot('11-perk');

  // =============================================================================================
  // 7. Repair the breached seal by holding interact
  // =============================================================================================
  await setPhase('seal');
  const seal = await h(
    (ids) => window.__h.brokenSeal(ids),
    brokenByEnemies.map((e) => e.sealId),
  );
  if (check('seal: a seal breached by enemies is still open', seal !== null, {})) {
    check('seal: interaction focuses the seal', await approach(seal.id, seal.anchor, seal.out, STAND.seal), {
      focus: await h(() => window.__h.focusId()),
      seal: seal.id,
    });
    let repairs = 0;
    for (let i = 0; i < seal.broken; i++) {
      const before = await count('seal:repaired');
      await page.keyboard.down('KeyF');
      if (i === 0) {
        await frames(3);
        await shot('12-seal-repair');
      }
      const ok = await untilEvent('seal:repaired', before, 30_000);
      await page.keyboard.up('KeyF');
      await frames(2);
      if (!ok) break;
      repairs++;
    }
    const repaired = (await events('seal:repaired', 'seal')).filter((e) => e.sealId === seal.id);
    const repairPoints = await pointsOf('repair', 'seal');
    const sealNow = await h((id) => window.__h.sealState(id), seal.id);
    check('seal: hold interact repairs bar by bar (seal:repaired)', repaired.length === seal.broken, {
      broken: seal.broken,
      repaired: repaired.length,
      holds: repairs,
      seal: sealNow,
    });
    check('seal: repaired seal is intact again', sealNow.up === sealNow.segments, sealNow);
    check(
      'seal: repairs pay points (reason repair)',
      repairPoints.length === repaired.length && repairPoints.length > 0,
      {
        repairPoints,
      },
    );
    await shot('13-seal-repaired');
  }

  // =============================================================================================
  // 8. Power-ups: spawn each type, walk into it, check its effect
  // =============================================================================================
  await setPhase('powerups');
  const types = await h(() => window.__h.powerUpTypes());
  check('powerups: type list read from the console', types.length > 0, { types });
  report.powerUpTypes = types;
  const tested = new Set();
  // Riss-Kollaps: kills every enemy with credit and pays its bonus.
  {
    await h(() => window.__h.powerUpLane());
    await exec('enemy spawn swarmer 3 8');
    await until(() => window.__RIFTFALL__.game.sys.enemies.alive >= 3, null, 30_000);
    const alive = (await info()).alive;
    const r = await collectPowerUp('nuke');
    await until(() => window.__RIFTFALL__.game.sys.enemies.alive === 0, null, 20_000);
    const nukePoints = await pointsOf('nuke', 'powerups');
    const after = await info();
    check(
      'powerup nuke: collected, every enemy dies, bonus paid',
      r.collected && alive >= 3 && after.alive === 0 && nukePoints.length === 1 && nukePoints[0].delta > 0,
      { ...r, aliveBefore: alive, aliveAfter: after.alive, nukePoints },
    );
    tested.add('nuke');
    await shot('14-powerup-nuke');
  }
  // Versiegelung: every seal restored, armor refilled, its bonus paid (collected twice: once more
  // under Doppelte Punkte below – the bonus must double).
  const carpenter = async () => {
    await h(() => window.__h.powerUpLane());
    await exec('seal break');
    const before = await h(() => window.__h.powerUpState('carpenter'));
    const paid = (await pointsOf('carpenter', 'powerups')).length;
    const r = await collectPowerUp('carpenter');
    const st = await h(() => window.__h.powerUpState('carpenter'));
    const bonus = (await pointsOf('carpenter', 'powerups')).slice(paid);
    return { r, before, st, bonus: bonus[0]?.delta ?? 0, paidEvents: bonus.length };
  };
  const carp1 = await carpenter();
  check(
    'powerup carpenter: collected, seals restored, armor full, bonus paid',
    carp1.r.collected &&
      carp1.before.brokenSegments > 0 &&
      carp1.st.brokenSegments === 0 &&
      carp1.before.armor < carp1.before.maxArmor &&
      carp1.st.armor >= carp1.st.maxArmor &&
      carp1.paidEvents === 1 &&
      carp1.bonus > 0,
    carp1,
  );
  tested.add('carpenter');
  // Doppelte Punkte: the points multiplier doubles – a real earning (the carpenter bonus) doubles.
  {
    const r = await collectPowerUp('doublePoints');
    const st = await h(() => window.__h.powerUpState('doublePoints'));
    const carp2 = await carpenter();
    check('powerup doublePoints: collected, multiplier ×2', r.collected && st.active && st.multiplier === 2, {
      ...r,
      ...st,
    });
    check(
      'powerup doublePoints: earnings double (carpenter bonus ×2)',
      carp2.r.collected && carp2.bonus === 2 * carp1.bonus,
      {
        single: carp1.bonus,
        doubled: carp2.bonus,
      },
    );
    tested.add('doublePoints');
  }
  // Todesstoß: any hit kills – one round of a hitscan weapon drops a tank.
  {
    const r = await collectPowerUp('instakill');
    const st = await h(() => window.__h.powerUpState('instakill'));
    const hitscan = await h(() => window.__h.selectHitscan());
    if (hitscan) await page.keyboard.press(`Digit${hitscan.slot + 1}`);
    await until(
      (w) => {
        const ws = window.__RIFTFALL__.game.sys.weapons;
        return ws.currentWeaponId === w && ws.state === 'idle';
      },
      hitscan?.weaponId,
      20_000,
    );
    await exec('enemy spawn tank 1 9');
    // Console spawns rise out of the floor first: wait until the tank can be seen (and hit).
    await until(() => window.__h.nearestEnemy() !== null, null, 120_000, 250);
    const tank = await h(() => window.__h.nearestEnemy());
    let tankDead = false;
    let shots = 0;
    if (tank) {
      await h((id) => (window.__aim = { kind: 'target', id, zone: 'body' }), tank.id);
      await frames(2);
      for (; shots < 3 && !tankDead; shots++) {
        await fireOnce();
        tankDead = await until(
          (id) => window.__log.some((e) => e.t === 'enemy:died' && e.id === id),
          tank.id,
          4000,
        );
      }
    }
    await aimPoint(null);
    check(
      'powerup instakill: collected, one shot kills a tank',
      r.collected && st.active && st.instakill && tankDead,
      {
        ...r,
        ...st,
        weapon: hitscan,
        tank,
        tankDead,
        shots,
      },
    );
    tested.add('instakill');
    await shot('15-powerup-instakill');
  }
  // Zeitdehnung: enemies run slowed.
  {
    const r = await collectPowerUp('slowmo');
    const st = await h(() => window.__h.powerUpState('slowmo'));
    check(
      'powerup slowmo: collected, enemies slowed',
      r.collected && st.active && st.timeScale > 0 && st.timeScale < 1,
      {
        ...r,
        ...st,
      },
    );
    tested.add('slowmo');
    await shot('16-powerup-slowmo');
  }
  // Munitionsreste: a quarter of the reserve back (spend a magazine's worth first).
  {
    await h(() => window.__h.powerUpLane());
    await frames(2);
    await fireShots(3);
    await reload(true);
    const before = await h(() => window.__h.ammoNow());
    const r = await collectPowerUp('ammoScrap');
    const after = await h(() => window.__h.ammoNow());
    check('powerup ammoScrap: collected, reserve grows', r.collected && after.reserve > before.reserve, {
      ...r,
      before,
      after,
    });
    tested.add('ammoScrap');
  }
  // Munitionsflut: every carried weapon full (magazine and reserve).
  {
    await h(() => window.__h.powerUpLane());
    await frames(2);
    await fireShots(3);
    await reload(true);
    await fireShots(2);
    const before = await h(() => window.__h.ammoNow());
    const r = await collectPowerUp('maxAmmo');
    await frames(2);
    const full = await h(() => window.__h.allAmmoFull());
    check('powerup maxAmmo: collected, every weapon full', r.collected && full.ok, { ...r, before, full });
    tested.add('maxAmmo');
  }
  // Anything the table has beyond these: collected at least.
  for (const t of types) {
    if (tested.has(t)) continue;
    const r = await collectPowerUp(t);
    check(`powerup ${t}: collected`, r.collected, r);
  }
  const collectedTypes = new Set((await events('powerup:collected', 'powerups')).map((e) => e.type));
  check(
    'powerups: every type collected',
    types.every((t) => collectedTypes.has(t)),
    {
      types,
      collected: [...collectedTypes],
    },
  );
  await shot('17-powerups');

  // =============================================================================================
  // 9. Death → game over → restart
  // =============================================================================================
  await setPhase('death');
  report.beforeDeath = await info();
  await exec('god off');
  await h(() => window.__h.powerUpLane());
  await exec('enemy spawn swarmer 4 3');
  // God mode is off: the enemies hurt the player for real.
  const hurtByEnemies = await until(
    () => window.__log.some((e) => e.t === 'player:damaged' && e.phase === 'death'),
    null,
    150_000,
  );
  check('death: enemies hurt the player without god mode', hurtByEnemies, { hp: (await info()).hp });
  // Regeneration outpaces the melee cadence at SwiftShader frame rates (a natural death takes
  // minutes): give the enemies a moment, then finish through the regular damage path.
  let died = await until(() => (window.__ev['player:died'] ?? 0) >= 1, null, 20_000);
  report.deathCause = died ? 'enemies' : 'hurt';
  if (!died) {
    await exec('hurt 100000');
    died = await until(() => (window.__ev['player:died'] ?? 0) >= 1, null, 20_000);
  }
  if (!died) {
    report.deathCause = 'console';
    note('`hurt` did not kill the player – `run kill`');
    await exec('run kill');
    died = await until(() => (window.__ev['run:over'] ?? 0) >= 1, null, 30_000);
  }
  const over = await until(() => (window.__ev['run:over'] ?? 0) >= 1, null, 60_000);
  check('death: player dies → game over (run:over)', died && over, { cause: report.deathCause });
  const restartButton = '.gameover .menu-btn--primary:not([disabled])';
  const buttonReady = await page
    .waitForSelector(restartButton, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  await sleep(600);
  await shot('18-gameover');
  const restartEv = await count('run:restart');
  if (buttonReady) await page.click(restartButton);
  const restarted = await untilEvent('run:restart', restartEv, 20_000);
  check('restart: "Neu starten" restarts the run (run:restart)', buttonReady && restarted, { buttonReady });
  await setPhase('restart');
  await until(() => !window.__RIFTFALL__.game.loop.paused, null, 20_000);
  await frames(4);
  const fresh = await h(([a, b]) => window.__h.freshRun(a, b), [door.from, door.behind]);
  report.afterRestart = fresh;
  check('restart: points back to 500', fresh.points === START_POINTS, { points: fresh.points });
  check(
    'restart: HUD shows 500 points',
    await until((p) => window.__h.hudPoints() === p, START_POINTS, 20_000),
    {
      hud: await h(() => window.__h.hudPoints()),
    },
  );
  check('restart: every door closed', fresh.doorsClosed, { doors: fresh.doors });
  check(
    'restart: only the start zone active',
    fresh.zones.length === 1 && fresh.zones[0] === startInfo.zones[0],
    {
      zones: fresh.zones,
    },
  );
  check('restart: the door blocks the navmesh again', fresh.path.gap > PATH_REACH, { path: fresh.path });
  check('restart: perks gone', fresh.perks.length === 0 && fresh.modifiedStats.length === 0, {
    perks: fresh.perks,
    modifiedStats: fresh.modifiedStats,
    maxHealth: fresh.maxHealth,
  });
  check('restart: seals intact', fresh.brokenSegments === 0, { brokenSegments: fresh.brokenSegments });
  check(
    'restart: no power-up running or lying around',
    fresh.powerUps.timed.length === 0 &&
      fresh.powerUps.pickups === 0 &&
      !fresh.powerUps.instakill &&
      fresh.powerUps.timeScale === 1,
    fresh.powerUps,
  );
  check(
    'restart: start loadout, box idle, full health',
    fresh.slots.filter(Boolean).length === startInfo.slots.filter(Boolean).length &&
      fresh.slots[0] === startInfo.slots[0] &&
      fresh.boxState === 'idle' &&
      fresh.hp === fresh.maxHealth &&
      fresh.maxHealth === startInfo.maxHp,
    {
      slots: fresh.slots,
      start: startInfo.slots,
      boxState: fresh.boxState,
      hp: fresh.hp,
      maxHealth: fresh.maxHealth,
    },
  );
  await shot('19-restart');
} catch (err) {
  report.fatal = String(err?.stack || err);
} finally {
  if (page) {
    const state = await page
      .evaluate(() => ({ events: window.__ev, log: window.__log, end: window.__h?.info() }))
      .catch(() => null);
    if (state) Object.assign(report, state);
  }
  report.durationMs = Date.now() - t0;
  report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  report.ok =
    !report.fatal && report.pageErrors.length === 0 && report.checks.length > 0 && report.failed.length === 0;
  writeFileSync(`${OUT}/economy-report.json`, JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
}
console.info(
  JSON.stringify(
    {
      ok: report.ok,
      bootMs: report.bootMs,
      durationMs: report.durationMs,
      checks: `${report.checks.length - report.failed.length}/${report.checks.length}`,
      failed: report.failed,
      doorFunds: report.doorFunds,
      deathCause: report.deathCause,
      combatPoints: report.combatPoints,
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      fatal: report.fatal,
    },
    null,
    2,
  ),
);
process.exit(report.ok ? 0 : 1);

// =============================================================================================
// In-page harness (serialized into the page by page.evaluate)
// =============================================================================================

/**
 * Event log + counters, the per-frame aim (the player looks at a point or at an enemy's hitbox:
 * applied right after the frame's mouse look, before the ticks – shots resolve against what was
 * aimed at) and the query helpers the scenario reads (window.__h).
 */
function installHarness() {
  const g = window.__RIFTFALL__.game;
  const s = g.sys;
  const V = s.player.position.constructor;
  const ev = (window.__ev = {});
  const log = (window.__log = []);
  window.__phase = 'boot';
  window.__frames = 0;
  window.__aim = null;

  const COPY = {
    'economy:points': (e) => ({ delta: e.delta, total: e.total, reason: e.reason }),
    'economy:purchase': (e) => ({ item: e.item, kind: e.kind, cost: e.cost, ok: e.ok }),
    'door:opened': (e) => ({ doorId: e.doorId, zones: [...e.zones] }),
    'zone:activated': (e) => ({ zone: e.zone }),
    'box:opened': () => ({}),
    'box:resolved': (e) => ({ weaponId: e.weaponId }),
    'box:moved': (e) => ({ from: e.from, to: e.to }),
    'perk:acquired': (e) => ({ perkId: e.perkId, slot: e.slot }),
    'perk:lost': (e) => ({ perkId: e.perkId }),
    'powerup:spawned': (e) => ({ id: e.id, type: e.type }),
    'powerup:collected': (e) => ({ type: e.type, duration: e.duration }),
    'powerup:expired': (e) => ({ type: e.type }),
    'seal:broken': (e) => ({ sealId: e.sealId }),
    'seal:repaired': (e) => ({ sealId: e.sealId, planks: e.planks }),
    'enemy:died': (e) => ({ id: e.id, type: e.type, weaponId: e.weaponId, zone: e.zone, source: e.source }),
    'combat:kill': (e) => ({ targetId: e.targetId, zone: e.zone, weaponId: e.weaponId }),
    'weapon:equipped': (e) => ({ weaponId: e.weaponId, slot: e.slot }),
    'interact:focus': (e) => ({ id: e.id, prompt: e.prompt, cost: e.cost, affordable: e.affordable }),
    'player:damaged': (e) => ({ amount: e.amount }),
    'player:died': () => ({}),
    'run:over': (e) => ({ wave: e.wave, kills: e.kills, score: e.score }),
    'run:restart': () => ({}),
    'wave:start': (e) => ({ wave: e.wave }),
    'wave:complete': (e) => ({ wave: e.wave }),
  };
  const COUNT_ONLY = [
    'enemy:spawned',
    'enemy:attack',
    'weapon:fired',
    'weapon:reloadEnd',
    'combat:damage',
    'wave:intermission',
  ];
  for (const [t, copy] of Object.entries(COPY)) {
    s.events.on(t, (e) => {
      ev[t] = (ev[t] ?? 0) + 1;
      log.push({ t, phase: window.__phase, ...copy(e) });
    });
  }
  for (const t of COUNT_ONLY) s.events.on(t, () => (ev[t] = (ev[t] ?? 0) + 1));

  // --- aim: after the mouse look of every unpaused frame ---
  const cam = s.playerCamera;
  const applyLook = cam.applyLook.bind(cam);
  const aimAt = (from, p) => {
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const dz = p.z - from.z;
    s.player.yaw = Math.atan2(-dx, -dz);
    const off = Number.isFinite(cam.aimPitchOffset) ? cam.aimPitchOffset : 0;
    s.player.pitch = Math.atan2(dy, Math.hypot(dx, dz)) - off;
  };
  const tp = new V();
  const liveTarget = (id) => s.combat.targets.find((t) => t.id === id && t.alive) ?? null;
  const zonePoint = (t, zone, out) => {
    const hb = t.hitboxes.find((b) => b.zone === zone);
    if (!hb) return out.copy(t.aimPoint);
    if (hb.shape === 'sphere') return out.copy(hb.a);
    return out.copy(hb.a).add(hb.b).multiplyScalar(0.5);
  };
  cam.applyLook = (...a) => {
    const r = applyLook(...a);
    window.__frames++;
    const aim = window.__aim;
    if (aim?.kind === 'point') aimAt(s.player.eyePosition, aim);
    else if (aim?.kind === 'target') {
      const t = liveTarget(aim.id);
      if (t) aimAt(s.render.camera.position, zonePoint(t, aim.zone, tp));
    }
    return r;
  };

  const flat = (x, z) => {
    const l = Math.hypot(x, z);
    return l > 1e-6 ? { x: x / l, z: z / l } : { x: 0, z: 1 };
  };
  const spawn = s.level.spawn;
  const distToSpawn = (p) => Math.hypot(p.x - spawn.position.x, p.z - spawn.position.z);
  const floor = new V();

  window.__h = {
    info() {
      const a = s.weapons.ammo;
      return {
        points: s.economy.points,
        wave: s.waves.wave,
        waveState: s.waves.state,
        alive: s.enemies.alive,
        run: s.runFlow.state,
        hp: s.health.health,
        maxHp: s.health.maxHealth,
        armor: s.health.armor,
        zones: [...s.zones.active],
        weapon: s.weapons.currentWeaponId,
        slots: [...s.weapons.slotIds],
        ammo: a ? { mag: a.mag, reserve: a.reserve, magSize: a.magSize } : null,
        perks: [...s.perks.owned],
        focus: s.interaction.focused?.id ?? null,
        pos: [s.player.position.x, s.player.position.y, s.player.position.z].map((v) => +v.toFixed(2)),
        fps: g.loop.stats.frameDelta > 0 ? +(1 / g.loop.stats.frameDelta).toFixed(1) : 0,
      };
    },
    focusId: () => s.interaction.focused?.id ?? null,
    hudPoints() {
      const t = document.querySelector('.hud-points__value')?.textContent ?? '';
      const digits = t.replace(/[^0-9]/g, '');
      return digits === '' ? null : Number(digits);
    },
    backToSpawn() {
      window.__aim = null;
      s.player.teleport(spawn.position, spawn.yaw);
      s.player.pitch = 0;
    },
    /** Nearest living enemy the camera sees (static line of sight to its aim point). */
    nearestEnemy() {
      const eye = s.render.camera.position;
      let best = null;
      let bestD = Infinity;
      for (const t of s.combat.targets) {
        if (!t.alive || t.team !== 'enemy') continue;
        const d = t.aimPoint.distanceTo(eye);
        if (d < bestD && s.combat.lineOfSight(eye, t.aimPoint)) {
          bestD = d;
          best = t;
        }
      }
      return best ? { id: best.id, dist: +bestD.toFixed(2) } : null;
    },
    /**
     * Teleport in front of an interactable's prompt anchor, `dist` m away along `out` (XZ); without
     * `out`, opposite the nearest obstacle around the anchor (the wall / cabinet it sits on). The
     * aim follows the anchor from now on.
     */
    standAt(anchor, out, dist) {
      let o = out;
      if (!o) {
        let best = null;
        let bestD = Infinity;
        for (const [x, z] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const hit = s.physics.raycast(anchor, { x, y: 0, z }, 4, { excludeCollider: s.player.collider });
          const d = hit ? hit.distance : 4;
          if (d < bestD) {
            bestD = d;
            best = { x: -x, z: -z };
          }
        }
        o = best;
      }
      const x = anchor.x + o.x * dist;
      const z = anchor.z + o.z * dist;
      const y = s.nav.closestPoint({ x, y: anchor.y - 1, z }, floor) ? floor.y : 0;
      s.player.teleport({ x, y: y + 0.02, z }, Math.atan2(o.x, o.z));
      s.player.pitch = 0;
      window.__aim = { kind: 'point', x: anchor.x, y: anchor.y, z: anchor.z };
      return { x, y, z };
    },
    /** The closed door nearest to the spawn: prompt anchor on the spawn side, points on both sides. */
    firstDoor() {
      let best = null;
      for (const d of s.interactables.doors) {
        if (d.state !== 'closed') continue;
        const [a, b] = d.sides;
        const near = distToSpawn(a.position) <= distToSpawn(b.position) ? a : b;
        const far = near === a ? b : a;
        const dd = distToSpawn(near.position);
        if (best && best.d <= dd) continue;
        const c = d.slot.position;
        const out = flat(near.position.x - c.x, near.position.z - c.z);
        const back = flat(far.position.x - c.x, far.position.z - c.z);
        best = {
          d: dd,
          id: d.id,
          price: d.price,
          anchor: { x: near.position.x, y: near.position.y, z: near.position.z },
          out,
          from: { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
          behind: { x: c.x + back.x * 3, y: c.y, z: c.z + back.z * 3 },
          zoneBehind: near === a ? d.slot.zoneB : d.slot.zoneA,
        };
      }
      return best;
    },
    doorState: (id) => s.interactables.doors.find((d) => d.id === id)?.state ?? null,
    pathReach(from, to) {
      const out = [];
      const n = s.nav.findPath(from, to, out);
      if (n <= 0) return { n, gap: 1e9 };
      const last = out[n - 1];
      return { n, gap: +Math.hypot(last.x - to.x, last.z - to.z).toFixed(2) };
    },
    /** Nearest wall buy to the spawn whose weapon is not carried. */
    firstWallBuy() {
      let best = null;
      for (const w of s.interactables.wallBuys) {
        if (w.owned) continue;
        const d = distToSpawn(w.position);
        if (best && best.d <= d) continue;
        best = {
          d,
          id: w.id,
          weaponId: w.weaponId,
          price: w.weaponPrice,
          ammoPrice: w.ammoPrice,
          anchor: { x: w.position.x, y: w.position.y, z: w.position.z },
        };
      }
      return best;
    },
    ammoOf(id) {
      const a = s.weapons.ammoOf(id);
      return a ? { mag: a.mag, reserve: a.reserve, magSize: a.magSize, maxReserve: a.maxReserve } : null;
    },
    ammoNow() {
      const id = s.weapons.currentWeaponId;
      return id ? { id, ...window.__h.ammoOf(id) } : null;
    },
    allAmmoFull() {
      const weapons = s.weapons.slotIds.filter(Boolean).map((id) => ({ id, ...window.__h.ammoOf(id) }));
      return { ok: weapons.every((w) => w.reserve >= w.maxReserve && w.mag >= w.magSize), weapons };
    },
    boxInfo() {
      const b = s.interactables.box;
      if (!b) return null;
      const l = b.location;
      return {
        id: b.id,
        price: b.price,
        location: l.id,
        anchor: { x: l.anchor.x, y: l.anchor.y, z: l.anchor.z },
        out: flat(l.anchor.x - l.position.x, l.anchor.z - l.position.z),
      };
    },
    /** Nearest available perk machine to the spawn, with the stat values its perk modifies. */
    firstPerk() {
      let best = null;
      for (const m of s.interactables.perkMachines) {
        if (m.availability !== 'available') continue;
        const d = distToSpawn(m.position);
        if (best && best.d <= d) continue;
        best = { d, m };
      }
      if (!best) return null;
      const m = best.m;
      const def = s.perks.def(m.perkId);
      const mods = (def?.modifiers ?? []).map((x) => ({
        stat: x.stat,
        op: x.op,
        value: x.value,
        before: s.stats.value(x.stat),
      }));
      return {
        id: m.id,
        perkId: m.perkId,
        price: m.price,
        anchor: { x: m.position.x, y: m.position.y, z: m.position.z },
        mods,
        maxHealthBefore: s.health.maxHealth,
      };
    },
    perkEffect(perk) {
      const stats = perk.mods.map((m) => {
        const after = s.stats.value(m.stat);
        const expected = m.op === 'mul' ? m.before * m.value : m.before + m.value;
        return { ...m, after, expected, ok: after !== m.before && Math.abs(after - expected) < 1e-6 };
      });
      const hp = perk.mods.find((m) => m.stat === 'maxHealth');
      return {
        owned: s.perks.has(perk.perkId),
        stats,
        statsOk: stats.length > 0 && stats.every((x) => x.ok),
        maxHealth: hp
          ? {
              before: perk.maxHealthBefore,
              after: s.health.maxHealth,
              stat: s.stats.value('maxHealth'),
              ok:
                s.health.maxHealth === s.stats.value('maxHealth') &&
                s.health.maxHealth > perk.maxHealthBefore,
            }
          : null,
      };
    },
    /** A seal (of `ids`, the ones the enemies broke) with bars down; stand on its open side. */
    brokenSeal(ids) {
      const list = s.seals?.seals ?? [];
      const seal = list.find((x) => ids.includes(x.id) && x.up < x.segments);
      if (!seal) return null;
      return {
        id: seal.id,
        broken: seal.segments - seal.up,
        anchor: { x: seal.position.x, y: seal.position.y, z: seal.position.z },
        out: flat(seal.frame.fx, seal.frame.fz),
      };
    },
    sealState(id) {
      const seal = (s.seals?.seals ?? []).find((x) => x.id === id);
      return seal ? { id, up: seal.up, segments: seal.segments } : null;
    },
    lookAtSeal(id) {
      const seal = (s.seals?.seals ?? []).find((x) => x.id === id);
      if (!seal) return;
      const o = flat(seal.frame.fx, seal.frame.fz);
      window.__h.standAt(seal.position, o, 4.5);
    },
    /** Spawn position facing the start direction (open floor ahead): the power-up walking lane. */
    powerUpLane() {
      window.__aim = null;
      s.player.teleport(spawn.position, spawn.yaw);
      s.player.pitch = 0;
    },
    /** Every power-up id (the console's `powerup list`: "<id> – <name>" per line). */
    async powerUpTypes() {
      const lines = await window.__h.consoleOut('powerup list');
      return lines
        .flatMap((l) => l.split('\n'))
        .map((l) => l.split(' – ')[0].trim())
        .filter((id) => /^[A-Za-z][A-Za-z0-9]*$/.test(id));
    },
    /** Run a console line and return what it printed (the command's own lines). */
    async consoleOut(line) {
      const c = s.devConsole;
      const out = [];
      const print = c.print;
      c.print = function (text, kind) {
        if (kind !== 'input') out.push(text);
        return print.call(this, text, kind);
      };
      try {
        await c.execute(line);
      } finally {
        delete c.print;
      }
      return out;
    },
    powerUpState(type) {
      return {
        active: s.powerUps.isActive(type),
        remaining: s.powerUps.remaining(type),
        multiplier: s.economy.multiplier,
        instakill: s.enemies.instakill,
        timeScale: s.enemies.timeScale,
        brokenSegments: s.seals?.brokenSegments ?? 0,
        armor: s.health.armor,
        maxArmor: s.health.maxArmor,
      };
    },
    /** Slot of a carried hitscan weapon (the instakill test shoots one round). */
    selectHitscan() {
      const ids = s.weapons.slotIds;
      for (let i = 0; i < ids.length; i++) {
        const def = ids[i] ? s.weapons.effectiveDef(ids[i]) : null;
        if (def && def.kind === 'hitscan') return { slot: i, weaponId: ids[i] };
      }
      return null;
    },
    freshRun(from, behind) {
      const doors = s.interactables.doors.map((d) => ({ id: d.id, state: d.state }));
      return {
        points: s.economy.points,
        doors,
        doorsClosed: doors.length > 0 && doors.every((d) => d.state === 'closed'),
        zones: [...s.zones.active],
        path: window.__h.pathReach(from, behind),
        perks: [...s.perks.owned],
        modifiedStats: s.stats.modified(),
        maxHealth: s.health.maxHealth,
        hp: s.health.health,
        brokenSegments: s.seals?.brokenSegments ?? 0,
        powerUps: {
          timed: [...s.powerUps.activeTimed],
          pickups: s.powerUps.pickupCount,
          instakill: s.enemies.instakill,
          timeScale: s.enemies.timeScale,
        },
        slots: [...s.weapons.slotIds],
        boxState: s.interactables.box?.state ?? null,
      };
    },
  };
}
