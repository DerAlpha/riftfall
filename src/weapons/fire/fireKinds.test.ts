/**
 * The fire kinds through the real WeaponSystem (M5): beams (ray + chain, cone), charge, spin-up,
 * projectile weapons, the fire-time specials (splitShot, critBurst, ricochet), Rift Forge /
 * attachment mods, and every beam / charge / spin-up weapon of the roster as designed.
 */
import { describe, expect, it } from 'vitest';
import type { ArsenalVfxApi } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents, Vec3Like } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { ARSENAL } from '../../defs/combat';
import { FORGE } from '../../defs/forge';
import { WEAPONS, WEAPON_IDS, getWeaponDef, type WeaponDef } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../testFakes';
import { WeaponSystem } from '../WeaponSystem';
import { Arsenal } from './Arsenal';
import { chargeDamageFactor } from './fireMath';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };

/** Deterministic aim: no spread, no random recoil, no pattern climb. */
function precise(def: WeaponDef, over: Partial<WeaponDef> = {}): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]], patternRepeatFrom: 0 },
    ...over,
  };
}

interface VfxCalls {
  beams: { visual: string; from: Vec3Like; to: Vec3Like; arcs: number }[];
  charges: { visual: string; amount: number }[];
}

function setup(
  defs: Record<string, WeaponDef>,
  loadout: string[],
  walls: Parameters<typeof buildTestLevel>[0] = [],
) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const camera = new FakeCamera(player);
  const render = fakeRenderCamera(EYE);
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -40 }, size: { x: 40, y: 3, z: 0.5 } },
      ...walls,
    ]),
  );
  const calls: VfxCalls = { beams: [], charges: [] };
  const vfx: ArsenalVfxApi = {
    projectileStart: () => 1,
    projectileMove: () => {},
    projectileEnd: () => {},
    beam: (visual, from, to, _arcs, arcs) =>
      void calls.beams.push({ visual, from: { ...from }, to: { ...to }, arcs }),
    fieldStart: () => 1,
    fieldEnd: () => {},
    charge: (visual, amount) => void calls.charges.push({ visual, amount }),
    update: () => {},
    clear: () => {},
  };
  const arsenal = new Arsenal({ events, combat, vfx, seed: 'test' });
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera,
      render,
      combat,
      arsenal,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout, slots: loadout.length, seed: 'fire', defs: (id) => defs[id] ?? getWeaponDef(id) },
  );
  const log: { type: keyof GameEvents; p: unknown }[] = [];
  for (const type of [
    'weapon:fired',
    'weapon:beam',
    'weapon:charge',
    'weapon:spin',
    'weapon:reloadStart',
    'weapon:dryFire',
    'combat:damage',
    'combat:tracer',
    'weapon:modsChanged',
    'forge:upgraded',
    'projectile:spawned',
  ] as const) {
    events.on(type, (p: unknown) => log.push({ type, p: structuredClone(p) }));
  }
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      arsenal.fixedUpdate(DT);
      weapons.update(DT);
      arsenal.update(DT, 1);
      weapons.updateVisuals(DT);
      input.endFrame();
    }
  };
  const of = <K extends keyof GameEvents>(type: K): GameEvents[K][] =>
    log.filter((e) => e.type === type).map((e) => e.p as GameEvents[K]);
  const equip = (): void => {
    for (let i = 0; i < 300 && weapons.state !== 'idle'; i++) frame();
  };
  return { events, input, player, camera, combat, arsenal, weapons, calls, log, frame, of, equip };
}

describe('beam weapons', () => {
  const beam = precise(WEAPONS.chainlightning);

  it('tick at the beam rate while held, drain ammo per second, chain to nearby enemies', () => {
    const t = setup({ chainlightning: beam }, ['chainlightning']);
    t.equip();
    const primary = new FakeTarget({ x: 0, y: 0.35, z: -8 }, 1e6);
    const hop1 = new FakeTarget({ x: 2, y: 0, z: -9 }, 1e6);
    const hop2 = new FakeTarget({ x: 4, y: 0, z: -10 }, 1e6);
    const tooFar = new FakeTarget({ x: 20, y: 0, z: -10 }, 1e6);
    for (const f of [primary, hop1, hop2, tooFar]) t.combat.register(f);
    t.input.press('fire');
    t.frame(60);
    expect(t.of('weapon:beam')).toEqual([{ weaponId: 'chainlightning', active: true }]);
    expect(t.weapons.beamFiring).toBe(true);
    const ticks = t.of('weapon:fired').length;
    expect(ticks).toBeGreaterThanOrEqual(beam.beam!.tickRate - 1);
    expect(ticks).toBeLessThanOrEqual(beam.beam!.tickRate + 1);
    expect(primary.received).toHaveLength(ticks);
    expect(primary.received[0]!.kind).toBe('beam');
    expect(primary.received[0]!.element).toBe('shock');
    expect(primary.received[0]!.statusBuildup).toBeGreaterThan(0);
    const keep = beam.beam!.chain!.damageKeep;
    expect(hop1.received[0]!.amount).toBeCloseTo(beam.damage.base * keep, 6);
    expect(hop2.received[0]!.amount).toBeCloseTo(beam.damage.base * keep * keep, 6);
    expect(tooFar.received).toHaveLength(0);
    expect(t.weapons.ammo!.mag).toBe(beam.magazine - beam.beam!.ammoPerSecond);
    // Drawn every frame from the muzzle as shown, with the chain arcs.
    const last = t.calls.beams.at(-1)!;
    expect(last.visual).toBe('beam.lightning');
    expect(last.from).toEqual({ x: 0.2, y: 1.45, z: -0.5 });
    expect(last.arcs).toBe(2);
    t.input.release('fire');
    t.frame(10);
    expect(t.of('weapon:beam').at(-1)).toEqual({ weaponId: 'chainlightning', active: false });
    const drawn = t.calls.beams.length;
    const hits = primary.received.length;
    t.frame(10);
    expect(primary.received).toHaveLength(hits);
    expect(t.calls.beams).toHaveLength(drawn);
  });

  it('stops when empty (auto reload) or when a reload is pressed', () => {
    const t = setup({ chainlightning: { ...beam, magazine: 5 } }, ['chainlightning']);
    t.equip();
    t.input.press('fire');
    t.frame(60);
    expect(t.of('weapon:beam').map((e) => e.active)).toEqual([true, false]);
    expect(t.of('weapon:reloadStart')).toHaveLength(1);
    t.input.release('fire');
    for (let i = 0; i < 600 && t.weapons.state !== 'idle'; i++) t.frame();
    t.input.press('fire');
    t.frame(20);
    expect(t.weapons.beamFiring).toBe(true);
    expect(t.weapons.ammo!.mag).toBeLessThan(5);
    t.input.tap('reload');
    t.frame(1);
    expect(t.weapons.beamFiring).toBe(false);
    expect(t.of('weapon:beam').at(-1)!.active).toBe(false);
  });

  it('cone beams hit everything inside the cone with line of sight, up to the wall', () => {
    const cone = precise(WEAPONS.flamethrower);
    const t = setup(
      { flamethrower: cone },
      ['flamethrower'],
      [{ material: 'concrete_wall', center: { x: -3, y: 1.5, z: -4 }, size: { x: 1.5, y: 3, z: 0.3 } }],
    );
    t.equip();
    const center = new FakeTarget({ x: 0, y: 0.4, z: -5 }, 1e6);
    const side = new FakeTarget({ x: 1.1, y: 0.4, z: -6 }, 1e6);
    const outside = new FakeTarget({ x: 5, y: 0.4, z: -5 }, 1e6);
    const shielded = new FakeTarget({ x: -3.2, y: 0.4, z: -8 }, 1e6);
    const beyond = new FakeTarget({ x: 0, y: 0.4, z: -14 }, 1e6);
    for (const f of [center, side, outside, shielded, beyond]) t.combat.register(f);
    t.input.press('fire');
    t.frame(30);
    expect(center.received.length).toBeGreaterThan(3);
    expect(side.received.length).toBe(center.received.length);
    expect(center.received[0]!.element).toBe('fire');
    expect(outside.received).toHaveLength(0);
    expect(shielded.received).toHaveLength(0);
    expect(beyond.received).toHaveLength(0);
  });
});

describe('charge weapons', () => {
  const rail = precise(WEAPONS.railgun);

  it('fizzle below minCharge (no shot, ammo kept); a full charge fires at full damage', () => {
    const t = setup({ railgun: rail }, ['railgun']);
    t.equip();
    const target = new FakeTarget({ x: 0, y: 0.35, z: -20 }, 1e6);
    t.combat.register(target);
    const c = rail.charge!;
    t.input.press('fire');
    t.frame(Math.floor((c.minCharge * c.time) / DT) - 2);
    expect(t.weapons.chargeLevel).toBeGreaterThan(0);
    t.input.release('fire');
    t.frame(2);
    expect(t.of('weapon:fired')).toHaveLength(0);
    expect(t.weapons.chargeLevel).toBe(0);
    expect(t.of('weapon:charge').at(-1)!.amount).toBe(0);
    expect(t.weapons.ammo!.mag).toBe(rail.magazine);
    t.input.press('fire');
    t.frame(Math.ceil(c.time / DT) + 2);
    expect(t.weapons.chargeLevel).toBe(1);
    // Charge glow drawn while charging.
    expect(t.calls.charges.at(-1)).toEqual({ visual: 'charge.rail', amount: 1 });
    t.input.release('fire');
    t.frame(2);
    expect(t.of('weapon:fired')).toHaveLength(1);
    expect(t.weapons.ammo!.mag).toBe(rail.magazine - 1);
    expect(target.received[0]!.amount).toBeCloseTo(rail.damage.base, 3);
    expect(t.calls.charges.at(-1)).toEqual({ visual: 'charge.rail', amount: 0 });
  });

  it('a partial charge scales the damage; auto-release fires by itself and needs a new press', () => {
    const t = setup({ railgun: rail }, ['railgun']);
    t.equip();
    const target = new FakeTarget({ x: 0, y: 0.35, z: -20 }, 1e6);
    t.combat.register(target);
    const c = rail.charge!;
    t.input.press('fire');
    const ticks = Math.round((0.6 * c.time) / DT);
    t.frame(ticks);
    const level = t.weapons.chargeLevel;
    t.input.release('fire');
    t.frame(1);
    expect(target.received[0]!.amount).toBeCloseTo(rail.damage.base * chargeDamageFactor(level, c), 3);
    // Wait out the recovery, then hold through full + autoReleaseAfter.
    t.frame(Math.ceil(60 / rail.rpm / DT) + 2);
    t.input.press('fire');
    t.frame(Math.ceil((c.time + c.autoReleaseAfter) / DT) + 3);
    expect(t.of('weapon:fired')).toHaveLength(2);
    // Still holding: no new charge until the trigger is released and pressed again.
    t.frame(Math.ceil(60 / rail.rpm / DT) + 30);
    expect(t.weapons.chargeLevel).toBe(0);
    t.input.release('fire');
    t.frame(1);
    t.input.press('fire');
    t.frame(5);
    expect(t.weapons.chargeLevel).toBeGreaterThan(0);
  });

  it('a switch cancels the charge (weapon:charge 0)', () => {
    const t = setup({ railgun: rail }, ['railgun', 'pistol']);
    t.equip();
    t.input.press('fire');
    t.frame(20);
    expect(t.weapons.chargeLevel).toBeGreaterThan(0);
    t.input.tap('weapon2');
    t.frame(1);
    expect(t.weapons.chargeLevel).toBe(0);
    expect(t.of('weapon:charge').at(-1)).toEqual({ weaponId: 'railgun', amount: 0 });
    expect(t.of('weapon:fired')).toHaveLength(0);
  });
});

describe('spin-up', () => {
  const mini = precise(WEAPONS.minigun);

  it('no shot before the barrels reach startFraction; the rate follows the spin; spins down', () => {
    const t = setup({ minigun: mini }, ['minigun']);
    t.equip();
    const s = mini.spinUp!;
    t.input.press('fire');
    const before = Math.floor((s.startFraction * s.time) / DT) - 1;
    t.frame(before);
    expect(t.of('weapon:fired')).toHaveLength(0);
    expect(t.weapons.spinLevel).toBeGreaterThan(0);
    t.frame(Math.ceil(s.time / DT));
    const ramp = t.of('weapon:fired').length;
    expect(ramp).toBeGreaterThan(0);
    // Less than a full-rate second worth over the ramp…
    expect(ramp).toBeLessThan((mini.rpm / 60) * s.time);
    // … full rate once spun up.
    t.frame(60);
    const full = t.of('weapon:fired').length - ramp;
    expect(full).toBeGreaterThanOrEqual(Math.floor(mini.rpm / 60) - 1);
    expect(t.of('weapon:spin').at(-1)!.amount).toBe(1);
    t.input.release('fire');
    t.frame(Math.ceil(s.spinDown / DT) + 1);
    expect(t.weapons.spinLevel).toBe(0);
    expect(t.of('weapon:spin').at(-1)!.amount).toBe(0);
  });

  it('a tap does not fire a spin-up weapon', () => {
    const t = setup({ minigun: mini }, ['minigun']);
    t.equip();
    t.input.tap('fire');
    t.frame(60);
    expect(t.of('weapon:fired')).toHaveLength(0);
  });
});

describe('projectile weapons and fire-time specials', () => {
  it('spawn projectiles from the rendered camera, drawn from the muzzle; hits land', () => {
    const plasma = precise(WEAPONS.plasma);
    const t = setup({ plasma }, ['plasma']);
    t.equip();
    const target = new FakeTarget({ x: 0, y: 0.35, z: -12 }, 1e6);
    t.combat.register(target);
    t.input.tap('fire');
    t.frame(1);
    expect(t.of('projectile:spawned')).toHaveLength(1);
    expect(t.of('projectile:spawned')[0]).toMatchObject({ weaponId: 'plasma', visual: 'projectile.plasma' });
    expect(t.of('projectile:spawned')[0]!.position).toEqual({ x: 0.2, y: 1.45, z: -0.5 });
    t.frame(30);
    expect(target.received[0]!.kind).toBe('projectile');
    expect(target.received[0]!.zone).toBe('body');
    expect(target.received[0]!.amount).toBeCloseTo(plasma.damage.base, 6);
    // Its splash follows (explosion damage on the same target).
    expect(target.received.some((d) => d.kind === 'explosion')).toBe(true);
  });

  it('splitShot fans extra rays in the view plane', () => {
    const fan = precise(WEAPONS.riftripper);
    const t = setup({ riftripper: fan }, ['riftripper']);
    t.equip();
    const angle = (fan.special as { angleDeg: number }).angleDeg;
    const dist = 12;
    const lateral = Math.tan((angle * Math.PI) / 180) * dist;
    const targets = [0, 1, -1, 2, -2].map((k) => new FakeTarget({ x: k * lateral, y: 0.35, z: -dist }, 1e6));
    for (const f of targets) t.combat.register(f);
    t.input.tap('fire');
    t.frame(2);
    expect(targets.every((f) => f.received.length === 1)).toBe(true);
    expect(t.of('combat:tracer')).toHaveLength(5);
  });

  it('critBurst: every Nth shot hits for the multiplier with the crit tracer color', () => {
    const def = precise(WEAPONS.pistol, {
      special: { kind: 'critBurst', everyNth: 3, multiplier: 2.5 },
      tracer: { ...WEAPONS.pistol.tracer, everyNth: 0 },
    });
    const t = setup({ pistol: def }, ['pistol']);
    t.equip();
    const target = new FakeTarget({ x: 0, y: 0.35, z: -10 }, 1e6);
    t.combat.register(target);
    for (let i = 0; i < 3; i++) {
      t.input.tap('fire');
      t.frame(Math.ceil(60 / def.rpm / DT) + 2);
    }
    const amounts = target.received.map((d) => d.amount);
    expect(amounts[2]! / amounts[0]!).toBeCloseTo(2.5, 6);
    expect(t.of('combat:tracer')).toHaveLength(1);
    expect(t.of('combat:tracer')[0]!.color).toBe(ARSENAL.specials.critTracerColor);
  });

  it('ricochet bounces a ray off the wall towards the nearest enemy (world tracer segment)', () => {
    const def = precise(WEAPONS.pistol, { special: { kind: 'ricochet', bounces: 1, damageKeep: 0.5 } });
    const t = setup(
      { pistol: def },
      ['pistol'],
      [{ material: 'concrete_wall', center: { x: 0, y: 1.5, z: -6 }, size: { x: 6, y: 3, z: 0.3 } }],
    );
    t.equip();
    const side = new FakeTarget({ x: 4, y: 0, z: -3 }, 1e6);
    t.combat.register(side);
    t.input.tap('fire');
    t.frame(2);
    expect(side.received).toHaveLength(1);
    const segments = t.of('combat:tracer').filter((e) => e.segment);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.from.z).toBeCloseTo(-5.85 + 0.03, 1);
  });
});

describe('Rift Forge and attachments (setWeaponMods)', () => {
  it('upgrades rename, refill, announce; attachments are validated', () => {
    const t = setup({}, ['rifle']);
    t.equip();
    t.input.press('fire');
    t.frame(30);
    t.input.release('fire');
    const before = t.weapons.ammo!.mag;
    expect(before).toBeLessThan(WEAPONS.rifle.magazine);
    t.weapons.setWeaponMods('rifle', { tier: 1, attachments: ['reddot', 'thermal', 'choke', 'nope'] });
    expect(t.of('forge:upgraded')).toEqual([
      { weaponId: 'rifle', tier: 1, name: WEAPONS.rifle.upgrades[0]!.name },
    ]);
    // One optic slot (the later one wins), incompatible and unknown ids dropped.
    expect(t.of('weapon:modsChanged').at(-1)).toEqual({
      weaponId: 'rifle',
      tier: 1,
      attachments: ['thermal'],
      element: null,
    });
    expect(t.weapons.currentDef!.name).toBe(WEAPONS.rifle.upgrades[0]!.name);
    expect(t.weapons.tierOf('rifle')).toBe(1);
    expect(t.weapons.modsOf('rifle')!.attachments).toEqual(['thermal']);
    if (FORGE.refillOnUpgrade) expect(t.weapons.ammo!.mag).toBe(t.weapons.currentDef!.magazine + 1);
    // Same tier again: no forge event, no refill; tier is clamped to the def's tiers.
    t.weapons.setWeaponMods('rifle', { tier: 9, element: 'fire' });
    expect(t.of('forge:upgraded').at(-1)!.tier).toBe(3);
    expect(t.weapons.currentDef!.damage.element).toBe('fire');
    expect(t.weapons.setWeaponMods('shotgun', { tier: 1 })).toBe(false);
  });

  it('heavy weapons slow the carrier (carry speed through the ADS provider)', () => {
    const t = setup({}, ['minigun', 'pistol']);
    t.equip();
    expect(t.weapons.carrySpeedMultiplier).toBe(WEAPONS.minigun.carrySpeedMultiplier);
    t.input.tap('weapon2');
    for (let i = 0; i < 200 && t.weapons.currentWeaponId !== 'pistol'; i++) t.frame();
    expect(t.weapons.carrySpeedMultiplier).toBe(1);
  });
});

describe('roster: beam, charge and spin-up weapons through the weapon system', () => {
  const defs = WEAPON_IDS.map((id) => WEAPONS[id] as WeaponDef);
  for (const def of defs.filter((d) => d.kind === 'beam')) {
    it(`${def.id}: ticks at its rate and drains its cell per second`, () => {
      const t = setup({}, [def.id]);
      t.equip();
      t.input.press('fire');
      t.frame(60);
      const ticks = t.of('weapon:fired').length;
      expect(Math.abs(ticks - def.beam!.tickRate)).toBeLessThanOrEqual(1);
      expect(def.magazine - t.weapons.ammo!.mag).toBe(
        Math.min(def.magazine, Math.floor(def.beam!.ammoPerSecond)),
      );
    });
  }
  for (const def of defs.filter((d) => d.kind === 'charge')) {
    it(`${def.id}: full charge after charge.time, one shot per release`, () => {
      const t = setup({}, [def.id]);
      t.equip();
      t.input.press('fire');
      t.frame(Math.ceil(def.charge!.time / DT) + 1);
      expect(t.weapons.chargeLevel).toBe(1);
      t.input.release('fire');
      t.frame(1);
      expect(t.of('weapon:fired')).toHaveLength(1);
    });
  }
  for (const def of defs.filter((d) => d.spinUp)) {
    it(`${def.id}: first shot once spun to startFraction`, () => {
      const t = setup({}, [def.id]);
      t.equip();
      t.input.press('fire');
      const s = def.spinUp!;
      let firstAt = -1;
      for (let i = 0; i < 120 && firstAt < 0; i++) {
        t.frame();
        if (t.of('weapon:fired').length > 0) firstAt = (i + 1) * DT;
      }
      expect(firstAt).toBeGreaterThan(s.startFraction * s.time - 2 * DT);
      expect(firstAt).toBeLessThan(s.startFraction * s.time + 3 * DT);
    });
  }
});
