/**
 * Every special of the roster is live in play (M5 review): each Rift Forge tier's special and each
 * wonder weapon's base special, fired through the real WeaponSystem + Arsenal (projectiles,
 * explosions, fields, specials) against dummies, does what its kind promises.
 */
import { describe, expect, it } from 'vitest';
import type { ArsenalVfxApi } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { DamageElement, GameEvents } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { WEAPONS, WEAPON_IDS, getWeaponDef, type WeaponDef, type WeaponSpecialDef } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../testFakes';
import { WeaponSystem } from '../WeaponSystem';
import { specialAt } from '../resolveWeapon';
import { Arsenal } from './Arsenal';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };
/** Feet height that puts a FakeTarget's aim point at eye height (straight ahead). */
const FEET = EYE.y - 1.25;
/** Most sim time a case may fire before its special must have shown. */
const MAX_FIRE = 8;

/** Deterministic aim: no spread, no random recoil, no pattern climb. */
function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]], patternRepeatFrom: 0 },
  };
}

const NULL_VFX: ArsenalVfxApi = {
  projectileStart: () => 1,
  projectileMove: () => {},
  projectileEnd: () => {},
  beam: () => {},
  fieldStart: () => 1,
  fieldEnd: () => {},
  charge: () => {},
  update: () => {},
  clear: () => {},
};

function setup(id: string, tier: number, walls: Parameters<typeof buildTestLevel>[0] = []) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -40 }, size: { x: 40, y: 3, z: 0.5 } },
      ...walls,
    ]),
  );
  const heals: number[] = [];
  const arsenal = new Arsenal({
    events,
    combat,
    vfx: NULL_VFX,
    seed: 'live',
    heal: (amount) => void heals.push(amount),
  });
  const procs: { element: DamageElement; amount: number }[] = [];
  arsenal.setStatus({ applyElement: (_t, element, amount) => void procs.push({ element, amount }) });
  const base = precise(WEAPONS[id as keyof typeof WEAPONS] as WeaponDef);
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera(EYE),
      combat,
      arsenal,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout: [id], slots: 1, seed: 'live', defs: (w) => (w === id ? base : getWeaponDef(w)) },
  );
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
  for (let i = 0; i < 300 && weapons.state !== 'idle'; i++) frame();
  weapons.setWeaponMods(id, { tier });
  weapons.infiniteAmmo = true;
  const fields: GameEvents['field:spawned'][] = [];
  events.on('field:spawned', (e) => fields.push({ ...e, position: { ...e.position } }));
  const segments: GameEvents['combat:tracer'][] = [];
  events.on('combat:tracer', (e) => e.segment && segments.push({ ...e }));
  const spawnedDamage: number[] = [];
  const spawn = arsenal.projectiles.spawn.bind(arsenal.projectiles);
  arsenal.projectiles.spawn = (opts) => {
    spawnedDamage.push(opts.damage.damage);
    return spawn(opts);
  };
  return { events, input, combat, arsenal, weapons, frame, heals, procs, fields, segments, spawnedDamage };
}

type Live = ReturnType<typeof setup>;

/** Pull the trigger the way the weapon wants it until `done` or MAX_FIRE seconds of sim time. */
function fireUntil(t: Live, done: () => boolean): void {
  const def = t.weapons.currentDef!;
  const limit = Math.round(MAX_FIRE / DT);
  let frames = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n && !done(); i++, frames++) t.frame();
  };
  while (frames < limit && !done()) {
    if (def.kind === 'charge' && def.charge) {
      t.input.press('fire');
      run(Math.ceil(def.charge.time / DT) + 2);
      t.input.release('fire');
      run(Math.ceil(60 / def.rpm / DT) + 2);
    } else if (def.kind === 'beam' || def.fireMode === 'auto' || def.fireMode === 'pump') {
      t.input.press('fire');
      run(1);
    } else {
      t.input.tap('fire');
      const burst = def.burst ? (def.burst.count - 1) * (60 / def.burst.rpm) : 0;
      run(Math.ceil((60 / def.rpm + burst) / DT) + 2);
    }
  }
  t.input.release('fire');
  // Projectiles in flight, fields ticking.
  run(Math.round(1.5 / DT));
}

/** A tough dummy straight ahead at `dist` and neighbours for arcs / blasts. */
function cluster(t: Live, dist: number, health = 1e9): FakeTarget[] {
  const spots = [
    [0, 0],
    [1.4, 0],
    [-1.4, 0],
    [0, -1.6],
    [2.8, 0.5],
  ] as const;
  return spots.map(([x, dz]) => {
    const f = new FakeTarget({ x, y: FEET, z: -dist + dz }, health);
    t.combat.register(f);
    return f;
  });
}

/** Where a case engages: inside every weapon's effective reach (flamethrower cone 9 m). */
const RANGE = 6;

interface Case {
  id: string;
  tier: number;
  special: WeaponSpecialDef;
}

const cases: Case[] = [];
for (const id of WEAPON_IDS) {
  const base = WEAPONS[id] as WeaponDef;
  let previous: WeaponSpecialDef | null = null;
  for (const tier of [0, 1, 2, 3]) {
    const special = specialAt(base, tier);
    if (special && special !== previous) cases.push({ id, tier, special });
    previous = special;
  }
}

describe('every special of the roster is live in play', () => {
  it('covers every special kind', () => {
    const kinds = new Set(cases.map((c) => c.special.kind));
    expect([...kinds].sort()).toEqual(
      [
        'chainArc',
        'critBurst',
        'elementProc',
        'explosiveRounds',
        'fieldOnKill',
        'lifesteal',
        'ricochet',
        'splitShot',
      ].sort(),
    );
    expect(cases.length).toBeGreaterThanOrEqual(WEAPON_IDS.length * 3);
  });

  for (const { id, tier, special } of cases) {
    it(`${id} tier ${tier}: ${special.kind}`, () => {
      switch (special.kind) {
        case 'explosiveRounds': {
          const t = setup(id, tier);
          cluster(t, RANGE);
          fireUntil(t, () => t.arsenal.specials.stats.explosions > 0);
          expect(t.arsenal.specials.stats.explosions).toBeGreaterThan(0);
          return;
        }
        case 'chainArc': {
          const t = setup(id, tier);
          const [, ...others] = cluster(t, RANGE);
          const arced = (): boolean =>
            others.some((o) => o.received.some((d) => d.kind === 'beam' && d.element === 'shock'));
          fireUntil(t, () => t.arsenal.specials.stats.arcs > 0 && arced());
          expect(t.arsenal.specials.stats.arcs).toBeGreaterThan(0);
          expect(arced()).toBe(true);
          return;
        }
        case 'elementProc': {
          const t = setup(id, tier);
          cluster(t, RANGE);
          const own = (): boolean => t.procs.some((p) => p.element === special.element);
          fireUntil(t, own);
          expect(own()).toBe(true);
          return;
        }
        case 'lifesteal': {
          const t = setup(id, tier);
          cluster(t, RANGE);
          fireUntil(t, () => t.heals.length > 0);
          expect(t.heals.reduce((s, h) => s + h, 0)).toBeGreaterThan(0);
          return;
        }
        case 'splitShot': {
          const t = setup(id, tier);
          cluster(t, RANGE);
          const def = t.weapons.currentDef!;
          const perPull = Math.max(1, Math.floor(def.pellets)) + special.count;
          fireUntil(t, () => t.weapons.stats.shots >= 2);
          if (def.kind === 'projectile') {
            expect(t.arsenal.projectiles.stats.spawned).toBe(t.weapons.stats.shots * perPull);
          } else {
            expect(t.weapons.stats.pellets).toBe(t.weapons.stats.shots * perPull);
          }
          return;
        }
        case 'critBurst': {
          const t = setup(id, tier);
          const [target] = cluster(t, RANGE);
          const n = special.everyNth;
          fireUntil(t, () => t.weapons.stats.shots >= n + 1);
          const def = t.weapons.currentDef!;
          const amounts =
            def.kind === 'projectile'
              ? t.spawnedDamage
              : target!.received
                  .filter((d) => d.kind === 'bullet' || d.kind === 'pellet')
                  .map((d) => d.amount);
          expect(amounts.length).toBeGreaterThan(n);
          const plain = Math.min(...amounts);
          expect(Math.max(...amounts) / plain).toBeCloseTo(special.multiplier, 3);
          return;
        }
        case 'ricochet': {
          // Aimed at a wall with nobody on the line: the round bounces to the dummy off to the side.
          const t = setup(id, tier, [
            { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -8 }, size: { x: 8, y: 3, z: 0.3 } },
          ]);
          const side = new FakeTarget({ x: 3, y: FEET, z: -5 }, 1e9);
          t.combat.register(side);
          fireUntil(t, () => t.segments.length > 0 && side.received.length > 0);
          expect(t.segments.length).toBeGreaterThan(0);
          expect(side.received.length).toBeGreaterThan(0);
          return;
        }
        case 'fieldOnKill': {
          // A file of weak dummies straight ahead: every pull kills.
          const t = setup(id, tier);
          for (let i = 0; i < 16; i++) {
            t.combat.register(new FakeTarget({ x: (i % 2) * 0.4 - 0.2, y: FEET, z: -4 - i * 0.7 }, 1));
          }
          const own = (): boolean =>
            t.fields.some((f) => f.kind === special.field.kind && f.element === special.field.element);
          fireUntil(t, own);
          expect(own()).toBe(true);
          return;
        }
      }
    });
  }
});
