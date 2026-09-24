import { describe, expect, it } from 'vitest';
import type {
  AreaDamageSource,
  ArsenalVfxApi,
  Damageable,
  ExplosionApi,
  FieldApi,
} from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { DamageElement, GameEvents, Vec3Like } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { ARSENAL } from '../../defs/combat';
import type { ExplosionDef, FieldDef, WeaponSpecialDef } from '../../defs/weapons';
import { WeaponSpecials, statusBuildupFor } from './WeaponSpecials';
import { createSpecialHit, type HitVia } from './types';

const SMALL: ExplosionDef = {
  radius: 2.5,
  damage: 90,
  minFalloffMultiplier: 0.35,
  element: 'shock',
  impulse: 3.5,
  propImpulse: 120,
  selfDamageScale: 0,
  shake: 0.14,
  vfx: 'explosion.shock',
  audio: 'explosion.shock.small',
};
const POOL: FieldDef = {
  kind: 'damage',
  radius: 2.4,
  duration: 4,
  dps: 45,
  element: 'fire',
  strength: 0,
  collapse: null,
  vfx: 'field.damage.fire',
  audio: 'field.damage.fire',
};

function setup(opts: { wall?: boolean } = {}) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel(
      opts.wall
        ? [{ material: 'concrete_wall', center: { x: 3, y: 1.5, z: 0 }, size: { x: 0.3, y: 3, z: 8 } }]
        : [],
    ),
  );
  const blasts: { at: Vec3Like; def: ExplosionDef; from: AreaDamageSource }[] = [];
  const explosions: ExplosionApi = {
    explode: (at, def, from) => {
      blasts.push({ at: { x: at.x, y: at.y, z: at.z }, def, from: { ...from } });
      return 0;
    },
  };
  const spawned: { at: Vec3Like; def: FieldDef; from: AreaDamageSource }[] = [];
  const fields: FieldApi = {
    spawn: (at, def, from) => {
      spawned.push({ at: { x: at.x, y: at.y, z: at.z }, def, from: { ...from } });
      return spawned.length;
    },
    pullAt: (_p, out) => {
      out.set(0, 0, 0);
      return false;
    },
    slowAt: () => 1,
    active: 0,
    fixedUpdate: () => {},
    update: () => {},
    clear: () => {},
  };
  const beams: { from: Vec3Like; to: Vec3Like; arcs: number }[] = [];
  const vfx: ArsenalVfxApi = {
    projectileStart: () => 0,
    projectileMove: () => {},
    projectileEnd: () => {},
    beam: (_v, from, to, _arcs, n) => void beams.push({ from: { ...from }, to: { ...to }, arcs: n }),
    fieldStart: () => 0,
    fieldEnd: () => {},
    charge: () => {},
    update: () => {},
    clear: () => {},
  };
  const status: { target: number; element: DamageElement; amount: number }[] = [];
  const heals: number[] = [];
  const specials = new WeaponSpecials({
    combat,
    explosions,
    fields,
    vfx,
    status: { applyElement: (t, element, amount) => void status.push({ target: t.id, element, amount }) },
    heal: (n) => void heals.push(n),
    seed: 'test',
  });
  const hit = (
    special: WeaponSpecialDef,
    target: Damageable,
    over: Partial<{ via: HitVia; primary: boolean; applied: number; killed: boolean }> = {},
  ): void => {
    const h = createSpecialHit();
    h.special = special;
    h.via = over.via ?? 'direct';
    h.weaponId = 'w';
    h.source = 'player';
    h.target = target;
    h.point = { x: target.aimPoint.x, y: target.aimPoint.y, z: target.aimPoint.z };
    h.applied = over.applied ?? 40;
    h.killed = over.killed ?? false;
    h.primary = over.primary ?? true;
    specials.onHit(h);
  };
  return { combat, specials, blasts, spawned, beams, status, heals, hit };
}

describe('WeaponSpecials', () => {
  it('explosiveRounds: primary direct/tick hits roll the chance, blasts and arcs never do', () => {
    const t = setup();
    const target = new FakeTarget({ x: 0, y: 0, z: -5 }, 1000);
    const always: WeaponSpecialDef = { kind: 'explosiveRounds', chance: 1, explosion: SMALL };
    t.hit(always, target);
    t.hit(always, target, { via: 'tick' });
    t.hit(always, target, { via: 'blast' });
    t.hit(always, target, { via: 'arc' });
    t.hit(always, target, { primary: false });
    expect(t.blasts).toHaveLength(2);
    expect(t.blasts[0]!.def).toBe(SMALL);
    expect(t.blasts[0]!.from).toMatchObject({
      weaponId: 'w',
      source: 'player',
      special: null,
      statusBuildup: statusBuildupFor('shock'),
    });
    // A chance of 0.25 procs about a quarter of the time (seeded).
    const u = setup();
    const quarter: WeaponSpecialDef = { kind: 'explosiveRounds', chance: 0.25, explosion: SMALL };
    for (let i = 0; i < 400; i++) u.hit(quarter, target);
    expect(u.blasts.length).toBeGreaterThan(70);
    expect(u.blasts.length).toBeLessThan(130);
  });

  it('chainArc: hop by hop to the nearest enemies in range with line of sight, arc damage, a flash', () => {
    const t = setup({ wall: true });
    const first = new FakeTarget({ x: 0, y: 0, z: 0 }, 1000);
    const near = new FakeTarget({ x: 0, y: 0, z: -2 }, 1000);
    const next = new FakeTarget({ x: 0, y: 0, z: -5 }, 1000);
    const walled = new FakeTarget({ x: 5, y: 0, z: 0 }, 1000);
    const far = new FakeTarget({ x: 0, y: 0, z: -30 }, 1000);
    for (const f of [first, near, next, walled, far]) t.combat.register(f);
    const arc: WeaponSpecialDef = { kind: 'chainArc', chance: 1, count: 3, range: 6, damage: 50 };
    t.hit(arc, first);
    expect(first.received).toHaveLength(0);
    expect(near.received).toHaveLength(1);
    expect(next.received).toHaveLength(1);
    expect(walled.received).toHaveLength(0);
    expect(far.received).toHaveLength(0);
    expect(near.received[0]).toMatchObject({
      amount: 50,
      element: ARSENAL.specials.arcElement,
      kind: 'beam',
    });
    // Arcs are inert: an arc hit never arcs again.
    t.hit(arc, first, { via: 'arc' });
    expect(near.received).toHaveLength(1);
    // The flash is drawn for arcDuration: hit point → near → next (one extra arc segment).
    t.specials.update(0.01);
    expect(t.beams).toHaveLength(1);
    expect(t.beams[0]!.arcs).toBe(1);
    t.specials.update(ARSENAL.specials.arcDuration);
    t.specials.update(0.01);
    expect(t.beams).toHaveLength(1);
  });

  it('selectChain skips dead bodies, non-enemies and the start; stops when nothing is in range', () => {
    const t = setup();
    const first = new FakeTarget({ x: 0, y: 0, z: 0 }, 1000);
    const dead = new FakeTarget({ x: 1, y: 0, z: 0 }, 0);
    const a = new FakeTarget({ x: 3, y: 0, z: 0 }, 1000);
    const b = new FakeTarget({ x: 3, y: 0, z: 4 }, 1000);
    for (const f of [first, dead, a, b]) t.combat.register(f);
    const out: Damageable[] = [];
    expect(t.specials.selectChain(first, 5, 5, out).map((d) => d.id)).toEqual([a.id, b.id]);
  });

  it('elementProc builds status on primary hits (not on arcs); lifesteal heals from every source hit', () => {
    const t = setup();
    const target = new FakeTarget({ x: 0, y: 0, z: -3 }, 1000);
    t.hit({ kind: 'elementProc', element: 'poison', chance: 1, amount: 12 }, target);
    t.hit({ kind: 'elementProc', element: 'poison', chance: 1, amount: 12 }, target, { via: 'arc' });
    t.hit({ kind: 'elementProc', element: 'poison', chance: 1, amount: 12 }, target, { via: 'blast' });
    expect(t.status).toEqual([
      { target: target.id, element: 'poison', amount: 12 },
      { target: target.id, element: 'poison', amount: 12 },
    ]);
    t.hit({ kind: 'lifesteal', fraction: 0.02 }, target, { applied: 200, via: 'arc', primary: false });
    t.hit({ kind: 'lifesteal', fraction: 0.02 }, target, { applied: 0 });
    expect(t.heals).toEqual([4]);
  });

  it('fieldOnKill: a kill (any delivery) leaves the field at the body, carrying the special along', () => {
    const t = setup();
    const target = new FakeTarget({ x: 2, y: 0, z: -3 }, 1000);
    const special: WeaponSpecialDef = { kind: 'fieldOnKill', chance: 1, field: POOL };
    t.hit(special, target, { killed: false });
    expect(t.spawned).toHaveLength(0);
    t.hit(special, target, { killed: true, via: 'tick' });
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.def).toBe(POOL);
    expect(t.spawned[0]!.at).toEqual({ x: 2, y: 0.9, z: -3 });
    expect(t.spawned[0]!.from).toMatchObject({ special, statusBuildup: statusBuildupFor('fire') });
  });

  it('fire-time specials are not interpreted per hit; build-up factors by element', () => {
    const t = setup();
    const target = new FakeTarget({ x: 0, y: 0, z: -3 }, 1000);
    t.hit({ kind: 'splitShot', count: 4, angleDeg: 6 }, target);
    t.hit({ kind: 'critBurst', everyNth: 3, multiplier: 2 }, target);
    t.hit({ kind: 'ricochet', bounces: 2, damageKeep: 0.8 }, target);
    expect(t.blasts.length + t.spawned.length + t.status.length + t.heals.length).toBe(0);
    expect(statusBuildupFor('physical')).toBe(0);
    expect(statusBuildupFor('fire')).toBeGreaterThan(0);
  });
});
