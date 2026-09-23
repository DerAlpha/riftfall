import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../combat/testFakes';
import { GAMEPAD } from '../defs/input';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { WEAPONS, getWeaponDef, type WeaponDef } from '../defs/weapons';
import { fakeSettings } from '../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from './testFakes';
import { WeaponSystem, type WeaponSystemOptions } from './WeaponSystem';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };

type Recorded = { [K in keyof GameEvents]: { type: K; tick: number; p: GameEvents[K] } }[keyof GameEvents];

const RECORDED: (keyof GameEvents)[] = [
  'weapon:fired',
  'weapon:dryFire',
  'weapon:reloadStart',
  'weapon:reloadStep',
  'weapon:reloadEnd',
  'weapon:equipStart',
  'weapon:equipped',
  'weapon:holsterStart',
  'weapon:adsChanged',
  'weapon:melee',
  'weapon:inspect',
  'weapon:inventoryChanged',
  'combat:damage',
  'combat:kill',
  'combat:impact',
  'combat:tracer',
];

/** Zero spread/recoil randomness variant of a def (deterministic aim for hit tests). */
function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0 },
  };
}

function setup(options: WeaponSystemOptions & { withLevel?: boolean; physics?: PhysicsWorld } = {}) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const settings = fakeSettings();
  const player = new FakePlayer();
  const camera = new FakeCamera(player);
  const render = fakeRenderCamera(EYE);
  const combat = new CombatWorld({ events, physics: options.physics ?? null });
  if (options.withLevel !== false) {
    combat.setLevel(
      buildTestLevel([
        { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -30 }, size: { x: 20, y: 3, z: 0.5 } },
      ]),
    );
  }
  let tick = 0;
  const log: Recorded[] = [];
  for (const type of RECORDED) {
    events.on(type, (p: unknown) => log.push({ type, tick, p: structuredClone(p) } as Recorded));
  }
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings,
      player,
      camera,
      render,
      combat,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout: ['pistol', 'rifle', 'shotgun'], slots: 3, seed: 'test', ...options },
  );
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      weapons.update(DT);
      input.endFrame();
      tick++;
    }
  };
  const of = <K extends keyof GameEvents>(type: K) =>
    log.filter((e) => e.type === type) as { type: K; tick: number; p: GameEvents[K] }[];
  /** Run frames until `pred` holds (max `limit` frames). */
  const until = (pred: () => boolean, limit = 600): number => {
    for (let i = 0; i < limit; i++) {
      if (pred()) return i;
      frame();
    }
    throw new Error('condition not reached');
  };
  const equip = (): void => {
    until(() => weapons.state === 'idle');
  };
  return {
    events,
    input,
    settings,
    player,
    camera,
    render,
    combat,
    weapons,
    log,
    frame,
    of,
    until,
    equip,
    get tick() {
      return tick;
    },
  };
}

describe('WeaponSystem: inventory and switching', () => {
  it('equips the first loadout weapon and hooks into player + camera', () => {
    const t = setup();
    expect(t.weapons.currentWeaponId).toBe('pistol');
    expect(t.weapons.state).toBe('equipping');
    expect(t.player.adsProvider).toBe(t.weapons);
    expect(t.camera.lookModifier).toBe(t.weapons);
    expect(t.weapons.slotIds).toEqual(['pistol', 'rifle', 'shotgun']);
    expect(t.of('weapon:equipStart')[0]!.p).toMatchObject({ weaponId: 'pistol', slot: 0, previous: null });
    t.equip();
    expect(t.of('weapon:equipped')).toHaveLength(1);
    expect(t.weapons.ammo).toEqual({ mag: 13, reserve: WEAPONS.pistol.reserve, magSize: 12 });
    t.weapons.dispose();
    expect(t.player.adsProvider).toBeNull();
    expect(t.camera.lookModifier).toBeNull();
  });

  it('switch = holster time + equip time; no shots in between', () => {
    const t = setup();
    t.equip();
    const start = t.tick;
    t.input.press('weapon2');
    t.input.press('fire');
    t.frame();
    const holster = t.of('weapon:holsterStart');
    expect(holster).toHaveLength(1);
    expect(holster[0]!.p).toMatchObject({ weaponId: 'pistol', next: 'rifle', slot: 0 });
    expect(holster[0]!.p.duration).toBeCloseTo(WEAPONS.pistol.holsterTime, 9);
    // The switch is announced at once: holster + equip, from the pistol.
    const eqStart = t.of('weapon:equipStart')[1]!;
    expect(eqStart.p).toMatchObject({ weaponId: 'rifle', slot: 1, previous: 'pistol' });
    expect(eqStart.tick).toBe(start);
    expect(eqStart.p.duration).toBeCloseTo(WEAPONS.pistol.holsterTime + WEAPONS.rifle.equipTime, 9);
    expect(t.weapons.currentWeaponId).toBe('pistol');
    t.until(() => t.weapons.currentWeaponId === 'rifle');
    expect((t.tick - start) * DT).toBeCloseTo(WEAPONS.pistol.holsterTime, 1);
    expect(t.of('weapon:equipStart')).toHaveLength(2);
    t.until(() => t.of('weapon:equipped').length === 2);
    const equipped = t.of('weapon:equipped')[1]!;
    expect((equipped.tick - start) * DT).toBeCloseTo(WEAPONS.pistol.holsterTime + WEAPONS.rifle.equipTime, 1);
    // The held trigger did not fire during the switch.
    expect(t.of('weapon:fired').filter((e) => e.tick < equipped.tick)).toHaveLength(0);
    t.input.release('fire');
    expect(t.weapons.currentWeaponId).toBe('rifle');
  });

  it('wheel next/prev cycles slots; a quick back-switch mid-equip holsters faster', () => {
    const t = setup();
    t.equip();
    t.input.tap('weaponNext');
    t.until(() => t.weapons.currentWeaponId === 'rifle' && t.weapons.state === 'equipping');
    // Half-way through the rifle equip, go back.
    t.frame(Math.round(WEAPONS.rifle.equipTime / 2 / DT));
    t.input.tap('weaponPrev');
    t.frame();
    const back = t.of('weapon:holsterStart').at(-1)!;
    expect(back.p.weaponId).toBe('rifle');
    expect(back.p.next).toBe('pistol');
    expect(back.p.duration).toBeLessThan(WEAPONS.rifle.holsterTime * 0.7);
    t.until(() => t.weapons.currentWeaponId === 'pistol' && t.weapons.state === 'idle');
    // Next from the last slot wraps around.
    t.input.tap('weapon3');
    t.until(() => t.weapons.currentWeaponId === 'shotgun' && t.weapons.state === 'idle');
    t.input.tap('weaponNext');
    t.until(() => t.weapons.currentWeaponId === 'pistol' && t.weapons.state === 'idle');
  });

  it('give: refills an owned weapon, fills a free slot, or replaces the current one (CoD rule)', () => {
    const t = setup({ loadout: ['pistol'], slots: 2 });
    t.equip();
    t.weapons.give('rifle');
    t.until(() => t.weapons.currentWeaponId === 'rifle' && t.weapons.state === 'idle');
    expect(t.weapons.slotIds).toEqual(['pistol', 'rifle']);
    t.weapons.give('shotgun');
    expect(t.weapons.slotIds).toEqual(['pistol', 'shotgun']);
    expect(t.weapons.currentWeaponId).toBe('shotgun');
    expect(t.of('weapon:equipStart').at(-1)!.p).toMatchObject({ weaponId: 'shotgun', previous: 'rifle' });
    t.weapons.give('nope'); // unknown ids never crash
    expect(t.weapons.slotIds).toEqual(['pistol', 'shotgun']);
    const inv = t.of('weapon:inventoryChanged').at(-1)!.p;
    expect(inv.slots).toEqual(['pistol', 'shotgun']);
    expect(inv.current).toBe(1);
  });
});

describe('WeaponSystem: fire timing', () => {
  it('full auto fires at the exact rpm on the fixed tick (first shot without delay)', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.weapons.infiniteAmmo = true;
    const start = t.tick;
    t.input.press('fire');
    t.frame(600);
    const fired = t.of('weapon:fired');
    expect(fired[0]!.tick).toBe(start);
    const interval = 60 / WEAPONS.rifle.rpm;
    const expected = Math.floor((599 * DT) / interval + 1e-9) + 1;
    expect(fired).toHaveLength(expected);
    const span = (fired.at(-1)!.tick - fired[0]!.tick) * DT;
    expect(span / (fired.length - 1)).toBeCloseTo(interval, 3);
    // Releasing stops at once; no stored credit makes the next burst start faster.
    t.input.release('fire');
    t.frame(60);
    const n = t.of('weapon:fired').length;
    expect(n).toBe(expected);
  });

  it('semi-auto needs a new press; presses during the cycle are buffered', () => {
    const t = setup();
    t.equip();
    t.input.press('fire');
    t.frame(60);
    expect(t.of('weapon:fired')).toHaveLength(1);
    t.input.release('fire');
    t.frame(2);
    const first = t.tick;
    t.input.press('fire');
    t.frame();
    t.input.release('fire');
    t.frame(2);
    t.input.press('fire'); // 3 ticks after the shot: inside the cycle, buffered
    t.frame();
    t.input.release('fire');
    t.frame(30);
    const fired = t.of('weapon:fired');
    expect(fired).toHaveLength(3);
    expect(fired[1]!.tick).toBe(first);
    const gap = (fired[2]!.tick - fired[1]!.tick) * DT;
    expect(gap).toBeGreaterThanOrEqual(60 / WEAPONS.pistol.rpm - 1e-9);
    expect(gap).toBeLessThan(60 / WEAPONS.pistol.rpm + DT + 1e-9);
  });

  it('pump shotgun repeats at the pump rate while held; tracers for the first pellets', () => {
    const t = setup({ loadout: ['shotgun'] });
    t.equip();
    t.input.press('fire');
    t.frame(Math.ceil((2 * 60) / WEAPONS.shotgun.rpm / DT) + 1);
    expect(t.of('weapon:fired')).toHaveLength(3);
    expect(t.of('combat:tracer')).toHaveLength(3 * WEAPONS.shotgun.tracer.pellets);
    expect(t.weapons.ammo!.mag).toBe(WEAPONS.shotgun.magazine - 3);
  });

  it('dry fire clicks when empty without reserve', () => {
    const def: WeaponDef = { ...WEAPONS.pistol, magazine: 1, reserve: 0, chambered: false };
    const t = setup({ loadout: ['pistol'], defs: (id) => (id === 'pistol' ? def : getWeaponDef(id)) });
    t.equip();
    t.input.tap('fire');
    t.frame(30);
    t.input.tap('fire');
    t.frame(30);
    expect(t.of('weapon:fired')).toHaveLength(1);
    expect(t.of('weapon:dryFire')).toHaveLength(1);
    expect(t.of('weapon:reloadStart')).toHaveLength(0);
  });
});

describe('WeaponSystem: reload', () => {
  it('tactical reload keeps the chambered round (+1) and takes only what is missing', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 5);
    t.input.release('fire');
    t.frame(10);
    expect(t.weapons.ammo!.mag).toBe(28);
    t.input.tap('reload');
    t.frame();
    const start = t.of('weapon:reloadStart')[0]!;
    expect(start.p).toMatchObject({ weaponId: 'rifle', empty: false });
    expect(start.p.duration).toBeCloseTo(WEAPONS.rifle.reload.tactical, 9);
    t.until(() => t.of('weapon:reloadEnd').length === 1);
    expect(t.of('weapon:reloadStep').map((e) => e.p.step)).toEqual(['magOut', 'magIn']);
    expect(t.of('weapon:reloadEnd')[0]!.p.completed).toBe(true);
    expect(t.weapons.ammo!.mag).toBe(33);
    expect(t.weapons.ammo!.reserve).toBe(WEAPONS.rifle.reserve - 5);
    const took = (t.of('weapon:reloadEnd')[0]!.tick - start.tick) * DT;
    expect(took).toBeCloseTo(WEAPONS.rifle.reload.tactical, 1);
  });

  it('empty reload is automatic, longer, releases the bolt and fills to the magazine size', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.weapons.ammo!.mag === 0);
    t.input.release('fire');
    t.until(() => t.of('weapon:reloadStart').length === 1, 30);
    const start = t.of('weapon:reloadStart')[0]!;
    expect(start.p.empty).toBe(true);
    expect(start.p.duration).toBeCloseTo(WEAPONS.rifle.reload.empty, 9);
    t.until(() => t.of('weapon:reloadEnd').length === 1);
    expect(t.of('weapon:reloadStep').map((e) => e.p.step)).toEqual(['magOut', 'magIn', 'boltRelease']);
    expect(t.weapons.ammo!.mag).toBe(32);
    expect(t.weapons.ammo!.reserve).toBe(WEAPONS.rifle.reserve - 32);
  });

  it('a sprint press before the commit point cancels without ammo change; fire interrupts before magOut', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 3);
    t.input.release('fire');
    t.frame(10);
    t.input.tap('reload');
    t.frame(Math.round(0.8 / DT));
    expect(t.weapons.blocksSprint).toBe(true);
    t.input.tap('sprint');
    t.frame();
    expect(t.of('weapon:reloadEnd')[0]!.p.completed).toBe(false);
    expect(t.weapons.state).not.toBe('reloading');
    expect(t.weapons.ammo).toMatchObject({ mag: 30, reserve: WEAPONS.rifle.reserve });

    // Fire right after starting a tactical reload: the reload is dropped and the shot goes out.
    t.input.tap('reload');
    t.frame(3);
    t.input.tap('fire');
    t.frame();
    expect(t.of('weapon:reloadEnd')).toHaveLength(2);
    expect(t.of('weapon:reloadEnd')[1]!.p.completed).toBe(false);
    expect(t.of('weapon:fired')).toHaveLength(4);

    // After magIn the reload is committed: a sprint press no longer cancels it, the swap
    // finishes while sprinting.
    t.input.tap('reload');
    t.frame(Math.ceil(WEAPONS.rifle.reload.tacticalSteps[1]!.at / DT) + 2);
    expect(t.weapons.blocksSprint).toBe(true);
    t.input.tap('sprint');
    t.frame();
    expect(t.weapons.state).toBe('reloading');
    expect(t.weapons.blocksSprint).toBe(false);
    expect(t.weapons.ammo!.mag).toBe(33);
    t.until(() => t.of('weapon:reloadEnd').length === 3);
    expect(t.of('weapon:reloadEnd')[2]!.p.completed).toBe(true);
    expect(t.weapons.blocksSprint).toBe(false);
  });

  it('a sprint press during a reload is honoured before the weapon ticks (toggle sprint keeps it)', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 3);
    t.input.release('fire');
    t.frame(10);
    t.input.tap('reload');
    t.frame(5);
    expect(t.weapons.blocksSprint).toBe(true);
    // Same frame: the player controller (ticking first) already sees the press.
    t.input.tap('sprint');
    expect(t.weapons.blocksSprint).toBe(false);
    // A frame without a tick latches the press for the next tick.
    t.weapons.update(DT);
    t.input.endFrame();
    expect(t.weapons.blocksSprint).toBe(false);
    t.frame();
    expect(t.weapons.state).not.toBe('reloading');
    expect(t.of('weapon:reloadEnd')[0]!.p.completed).toBe(false);
  });

  it('shotgun reloads shell by shell and fire interrupts between shells', () => {
    const t = setup({ loadout: ['shotgun'] });
    const ps = WEAPONS.shotgun.reload.perShell!;
    t.equip();
    for (let i = 0; i < 3; i++) {
      t.input.tap('fire');
      t.frame(Math.ceil(60 / WEAPONS.shotgun.rpm / DT) + 1);
    }
    expect(t.weapons.ammo!.mag).toBe(5);
    t.input.tap('reload');
    t.frame();
    const start = t.of('weapon:reloadStart')[0]!;
    expect(start.p.duration).toBeCloseTo(ps.start + 3 * ps.shell + ps.end, 9);
    t.until(() => t.of('weapon:reloadStep').length === 2);
    const shells = t.of('weapon:reloadStep');
    expect(shells.every((e) => e.p.step === 'shellIn')).toBe(true);
    expect((shells[0]!.tick - start.tick) * DT).toBeCloseTo(ps.start + ps.insertAt, 1);
    expect((shells[1]!.tick - shells[0]!.tick) * DT).toBeCloseTo(ps.shell, 1);
    expect(t.weapons.ammo!.mag).toBe(7);
    const firedBefore = t.of('weapon:fired').length;
    t.input.tap('fire');
    t.frame();
    const interruptTick = t.tick;
    t.until(() => t.of('weapon:fired').length === firedBefore + 1, 60);
    const end = t.of('weapon:reloadEnd')[0]!;
    expect(end.p.completed).toBe(false);
    const shot = t.of('weapon:fired').at(-1)!;
    expect((shot.tick - interruptTick) * DT).toBeLessThan(ps.end + 3 * DT);
    expect(t.weapons.ammo).toMatchObject({ mag: 6, reserve: WEAPONS.shotgun.reserve - 2 });
  });

  it('shotgun: a sprint press ends the shell reload (shells stay); fire during the close fires after it', () => {
    const t = setup({ loadout: ['shotgun'] });
    const ps = WEAPONS.shotgun.reload.perShell!;
    t.equip();
    for (let i = 0; i < 3; i++) {
      t.input.tap('fire');
      t.frame(Math.ceil(60 / WEAPONS.shotgun.rpm / DT) + 1);
    }
    t.input.tap('reload');
    t.frame();
    t.until(() => t.of('weapon:reloadStep').length === 1);
    t.input.tap('sprint');
    t.frame();
    expect(t.of('weapon:reloadEnd')[0]!.p.completed).toBe(false);
    expect(t.weapons.state).not.toBe('reloading');
    expect(t.weapons.ammo!.mag).toBe(WEAPONS.shotgun.magazine - 2);

    // One shell missing: start → insert → close. Fire pressed early in the close is not lost.
    t.input.tap('reload');
    t.frame();
    t.until(() => t.of('weapon:reloadStep').length === 3);
    t.until(() => t.weapons.ammo!.mag === WEAPONS.shotgun.magazine);
    t.frame(Math.ceil((ps.shell - ps.insertAt) / DT) + 1);
    const fired = t.of('weapon:fired').length;
    t.input.tap('fire');
    t.frame();
    expect(t.weapons.state).toBe('reloading');
    // Longer than the press buffer: the queued shot still goes out when the close ends.
    t.until(() => t.of('weapon:reloadEnd').length === 2, Math.ceil(ps.end / DT) + 2);
    t.frame();
    expect(t.of('weapon:fired')).toHaveLength(fired + 1);
  });

  it('shotgun reload from empty fills the tube and ends with a pump', () => {
    const t = setup({ loadout: ['shotgun'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.weapons.ammo!.mag === 0);
    t.input.release('fire');
    t.until(() => t.of('weapon:reloadEnd').length === 1);
    const steps = t.of('weapon:reloadStep').map((e) => e.p.step);
    expect(steps.filter((s) => s === 'shellIn')).toHaveLength(WEAPONS.shotgun.magazine);
    expect(steps.at(-1)).toBe('pump');
    expect(t.of('weapon:reloadEnd')[0]!.p.completed).toBe(true);
    expect(t.weapons.ammo!.mag).toBe(WEAPONS.shotgun.magazine);
  });
});

describe('WeaponSystem: sprint, ADS, recoil', () => {
  it('no shots while sprinting; fire blocks sprint; sprint-to-fire delay after it', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.player.sprinting = true;
    t.frame();
    expect(t.weapons.state).toBe('sprinting');
    expect(t.weapons.blocksSprint).toBe(false);
    t.input.press('fire');
    expect(t.weapons.blocksSprint).toBe(true);
    t.frame(30);
    expect(t.of('weapon:fired')).toHaveLength(0);
    // The player controller honours blocksSprint: the sprint ends.
    t.player.sprinting = false;
    const stop = t.tick;
    t.until(() => t.of('weapon:fired').length === 1, 60);
    const first = t.of('weapon:fired')[0]!.tick;
    expect((first - stop) * DT).toBeGreaterThanOrEqual(WEAPONS.rifle.sprintToFireTime - 1e-9);
    expect((first - stop) * DT).toBeLessThan(WEAPONS.rifle.sprintToFireTime + 2 * DT);
  });

  it('ADS blends in/out with the weapon times and drives zoom, sensitivity and move speed', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    const a = WEAPONS.rifle.ads;
    t.input.press('ads');
    t.frame(Math.ceil(a.inTime / DT));
    expect(t.weapons.adsAmount).toBe(1);
    expect(t.of('weapon:adsChanged')[0]!.p).toEqual({ aiming: true, weaponId: 'rifle' });
    expect(t.weapons.fovMultiplier).toBeCloseTo(a.zoom, 9);
    expect(t.weapons.adsMoveSpeedMultiplier).toBe(a.moveSpeedMultiplier);
    expect(t.weapons.blocksSprint).toBe(true);
    const look = { yaw: 0.1, pitch: 0 };
    t.weapons.modifyLook(look);
    expect(look.yaw).toBeCloseTo(
      0.1 * t.settings.current.controls.adsSensitivityMultiplier * a.sensitivityMultiplier,
      9,
    );
    // ADS is refused while reloading and resumes afterwards (still held).
    t.weapons.refillAmmo();
    t.input.press('fire');
    t.frame(3);
    t.input.release('fire');
    t.input.tap('reload');
    t.frame(Math.ceil(a.outTime / DT) + 1);
    expect(t.weapons.adsAmount).toBe(0);
    t.until(() => t.weapons.state === 'idle');
    t.frame(Math.ceil(a.inTime / DT));
    expect(t.weapons.adsAmount).toBe(1);
    t.input.release('ads');
    t.frame(Math.ceil(a.outTime / DT));
    expect(t.weapons.adsAmount).toBe(0);
    expect(t.of('weapon:adsChanged').at(-1)!.p.aiming).toBe(false);
  });

  it('recoil kicks are eased through the camera and recover fully without counter-pull', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 10);
    t.input.release('fire');
    t.frame(240);
    const kicks = t.camera.recoil.filter((r) => r.duration > 0);
    expect(kicks).toHaveLength(10);
    expect(kicks.every((k) => k.pitch > 0 && k.duration === WEAPONS.rifle.recoil.kickTime)).toBe(true);
    const total = t.camera.recoil.reduce((s, r) => s + r.pitch, 0);
    expect(Math.abs(total)).toBeLessThan(1e-9);
    expect(t.weapons.recoilOffsetPitch).toBe(0);
    expect(t.camera.punches).toBe(10);
  });

  it('pulling down against the recoil is kept (recovery only returns the unrecovered part)', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 6);
    t.input.release('fire');
    const kick = t.camera.kickPitch;
    // The player pulls down by the whole kick in one frame.
    t.camera.lookDelta.pitch = -kick;
    t.weapons.update(DT);
    t.camera.lookDelta.pitch = 0;
    t.frame(240);
    const recovered = t.camera.recoil.filter((r) => r.duration === 0).reduce((s, r) => s + r.pitch, 0);
    expect(Math.abs(recovered)).toBeLessThan(kick * 0.2);
  });

  it('spread grows with bloom and movement and shows on the crosshair', () => {
    const t = setup({ loadout: ['rifle'] });
    const S = WEAPONS.rifle.spread;
    t.equip();
    const still = t.weapons.spread;
    expect(t.weapons.spreadDegrees).toBeCloseTo(S.hip, 9);
    t.player.horizontalSpeed = 9;
    expect(t.weapons.spread).toBeGreaterThan(still);
    t.player.horizontalSpeed = 0;
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 6);
    expect(t.weapons.spreadDegrees).toBeGreaterThan(S.hip + 5 * S.perShotBloom);
    // A sustained spray reaches the bloom cap; after it the cone recovers fully.
    t.until(() => t.of('weapon:fired').length === 16);
    expect(t.weapons.spreadDegrees).toBeCloseTo(S.hip + S.bloomMax, 6);
    t.input.release('fire');
    t.frame(Math.ceil((S.recoveryDelay + S.bloomMax / S.recoveryPerSec) / DT) + 2);
    expect(t.weapons.spreadDegrees).toBeCloseTo(S.hip, 9);
  });

  it('tracers start with the first shot of every burst; shotIndex restarts after a pause', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.press('fire');
    t.until(() => t.of('weapon:fired').length === 7);
    t.input.release('fire');
    const every = WEAPONS.rifle.tracer.everyNth;
    expect(t.of('combat:tracer')).toHaveLength(Math.ceil(7 / every));
    expect(t.of('weapon:fired').map((e) => e.p.shotIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    t.frame(Math.ceil(WEAPONS.rifle.recoil.resetTime / DT) + 2);
    t.input.tap('fire');
    t.frame();
    expect(t.of('weapon:fired').at(-1)!.p.shotIndex).toBe(0);
    expect(t.of('combat:tracer')).toHaveLength(Math.ceil(7 / every) + 1);
  });
});

describe('WeaponSystem: hits, damage and melee', () => {
  const preciseDefs = (id: string) => {
    const d = getWeaponDef(id);
    return d ? precise(d) : undefined;
  };

  it('a pistol headshot deals head damage in one combat:damage event with impact + tracer', () => {
    const t = setup({ loadout: ['pistol'], defs: preciseDefs });
    const target = new FakeTarget({ x: 0, y: 0, z: -10 });
    t.combat.register(target);
    t.equip();
    t.input.tap('fire');
    t.frame();
    const dmg = t.of('combat:damage');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.p).toMatchObject({
      targetId: target.id,
      zone: 'head',
      weaponId: 'pistol',
      source: 'player',
    });
    expect(dmg[0]!.p.amount).toBeCloseTo(
      WEAPONS.pistol.damage.base * WEAPONS.pistol.damage.headMultiplier,
      6,
    );
    const impact = t.of('combat:impact')[0]!.p;
    expect(impact).toMatchObject({ surface: 'flesh', decal: false, kind: 'bullet' });
    const tracer = t.of('combat:tracer')[0]!.p;
    expect(tracer.from).toEqual({ x: 0.2, y: 1.45, z: -0.5 });
    // Head sphere r = 0.14 at y 1.62, the eye ray at y 1.6.
    expect(tracer.to.z).toBeCloseTo(-10 + Math.sqrt(0.14 * 0.14 - 0.02 * 0.02), 6);
    expect(target.received[0]!.kind).toBe('bullet');
  });

  it('shotgun pellets aggregate to one damage event per target', () => {
    const t = setup({ loadout: ['shotgun'] });
    const target = new FakeTarget({ x: 0, y: 0.25, z: -3 }, 1000);
    t.combat.register(target);
    t.equip();
    t.input.tap('fire');
    t.frame();
    const dmg = t.of('combat:damage');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.p.amount).toBeGreaterThan(WEAPONS.shotgun.damage.base * 4);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]!.kind).toBe('pellet');
    const flesh = t.of('combat:impact').filter((e) => e.p.surface === 'flesh');
    expect(flesh.length).toBeGreaterThan(4);
    expect(flesh.every((e) => e.p.kind === 'pellet' && !e.p.decal)).toBe(true);
  });

  it('rifle bullets penetrate glass (reduced damage); concrete stops them', () => {
    const t = setup({ loadout: ['rifle'], defs: preciseDefs, withLevel: false });
    t.combat.setLevel(
      buildTestLevel([
        { material: 'glass', center: { x: 0, y: 1.5, z: -4 }, size: { x: 4, y: 3, z: 0.04 } },
        { material: 'concrete_wall', center: { x: 3, y: 1.5, z: -6 }, size: { x: 2, y: 3, z: 0.3 } },
      ]),
    );
    const behindGlass = new FakeTarget({ x: 0, y: 0, z: -8 });
    const behindWall = new FakeTarget({ x: 3, y: 0, z: -8 });
    t.combat.register(behindGlass);
    t.combat.register(behindWall);
    t.equip();
    t.input.tap('fire');
    t.frame();
    const dmg = t.of('combat:damage');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.p.targetId).toBe(behindGlass.id);
    const d = WEAPONS.rifle.damage;
    expect(dmg[0]!.p.amount).toBeCloseTo(d.base * d.headMultiplier * WEAPONS.rifle.penetration.damageKeep, 6);
    const impacts = t.of('combat:impact').map((e) => e.p.surface);
    expect(impacts).toEqual(['glass', 'flesh']);
    t.player.yaw = -Math.atan2(3, 8);
    t.frame(20);
    const before = t.of('combat:impact').length;
    t.input.tap('fire');
    t.frame();
    expect(t.of('combat:damage')).toHaveLength(1);
    // Through the glass, stopped by the concrete block in front of the second target.
    expect(
      t
        .of('combat:impact')
        .slice(before)
        .map((e) => e.p.surface),
    ).toEqual(['glass', 'concrete']);
    expect(t.of('combat:impact').at(-1)!.p).toMatchObject({ surface: 'concrete', decal: true });
  });

  it('shots push dynamic props and leave no floating decal on them', async () => {
    const physics = await PhysicsWorld.create();
    const t = setup({ loadout: ['pistol'], defs: preciseDefs, physics });
    const body = physics.addDynamicBox({ x: 0, y: 1.6, z: -6 }, { x: 0.4, y: 0.4, z: 0.4 }, null, {
      data: { kind: 'prop', surface: 'metal' },
    });
    t.equip();
    t.input.tap('fire');
    t.frame();
    const impact = t.of('combat:impact').at(-1)!.p;
    expect(impact).toMatchObject({ surface: 'metal', decal: false });
    physics.step(DT);
    expect(body.linvel().z).toBeLessThan(0);
    physics.dispose();
  });

  it('melee hits the target in the cone after hitTime and respects the cooldown', () => {
    const t = setup({ loadout: ['rifle'] });
    const target = new FakeTarget({ x: 0.2, y: 0, z: -1.4 }, 500);
    t.combat.register(target);
    t.equip();
    t.input.tap('melee');
    t.frame();
    const melee = t.of('weapon:melee');
    expect(melee).toHaveLength(1);
    expect(melee[0]!.p).toMatchObject({ weaponId: 'rifle', hit: true });
    expect(t.weapons.state).toBe('meleeing');
    expect(t.of('combat:damage')).toHaveLength(0);
    t.frame(Math.ceil(WEAPONS.rifle.melee.hitTime / DT) + 1);
    const dmg = t.of('combat:damage');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.p.amount).toBe(WEAPONS.rifle.melee.damage);
    expect(target.received[0]!.kind).toBe('melee');
    // Pressing again mid-swing does nothing.
    t.input.tap('melee');
    t.frame();
    expect(t.of('weapon:melee')).toHaveLength(1);
    t.until(() => t.weapons.state === 'idle');
    // Still cooling down.
    t.input.tap('melee');
    t.frame();
    expect(t.of('weapon:melee')).toHaveLength(1);
    t.frame(Math.ceil(WEAPONS.rifle.melee.cooldown / DT));
    t.input.tap('melee');
    t.frame();
    expect(t.of('weapon:melee')).toHaveLength(2);
  });

  it('melee misses targets outside the cone', () => {
    const t = setup({ loadout: ['rifle'] });
    t.combat.register(new FakeTarget({ x: 1.6, y: 0, z: 0.2 }));
    t.equip();
    t.input.tap('melee');
    t.frame(40);
    expect(t.of('weapon:melee')[0]!.p.hit).toBe(false);
    expect(t.of('combat:damage')).toHaveLength(0);
  });

  it('inspect plays from idle and is cancelled by aiming', () => {
    const t = setup({ loadout: ['rifle'] });
    t.equip();
    t.input.tap('inspect');
    t.frame();
    expect(t.of('weapon:inspect')[0]!.p.duration).toBe(WEAPONS.rifle.inspectTime);
    expect(t.weapons.state).toBe('inspecting');
    t.input.press('ads');
    t.frame();
    expect(t.weapons.state).toBe('idle');
  });
});

describe('WeaponSystem: aim assist', () => {
  it('only bends gamepad look near a target; mouse input is untouched', () => {
    const t = setup({ loadout: ['rifle'] });
    // Target slightly to the left of the aim.
    const angle = GAMEPAD.aimAssist.magnetismDeg * 0.5 * (Math.PI / 180);
    const target = new FakeTarget({ x: -Math.tan(angle) * 10, y: 0.35, z: -10 });
    t.combat.register(target);
    t.equip();
    const mouse = { yaw: 0.01, pitch: 0 };
    t.weapons.modifyLook(mouse);
    expect(mouse).toEqual({ yaw: 0.01, pitch: 0 });
    t.input.device = 'gamepad';
    const pad = { yaw: 0.01, pitch: 0 };
    t.weapons.modifyLook(pad);
    expect(pad.yaw).toBeLessThan(0.01);
    t.settings.update('controls', { aimAssist: false });
    const off = { yaw: 0.01, pitch: 0 };
    t.weapons.modifyLook(off);
    expect(off.yaw).toBe(0.01);
  });
});
