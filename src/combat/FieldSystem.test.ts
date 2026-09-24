import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { AreaDamageSource, ExplosionApi } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { ARSENAL } from '../defs/combat';
import type { ExplosionDef, FieldDef } from '../defs/weapons';
import type { SpecialHit } from '../weapons/fire/types';
import { CombatWorld } from './CombatWorld';
import { FieldSystem } from './FieldSystem';
import { FakeTarget, buildTestLevel } from './testFakes';

const DT = 1 / 60;
const COLLAPSE: ExplosionDef = {
  radius: 5,
  damage: 600,
  minFalloffMultiplier: 0.4,
  element: 'void',
  impulse: 10,
  propImpulse: 500,
  selfDamageScale: 0,
  shake: 0.6,
  vfx: 'explosion.void',
  audio: 'explosion.void',
};
const PULL: FieldDef = {
  kind: 'pull',
  radius: 7,
  duration: 3.5,
  dps: 40,
  element: 'void',
  strength: 22,
  collapse: COLLAPSE,
  vfx: 'field.pull.void',
  audio: 'field.pull.void',
};
const FIRE: FieldDef = { ...PULL, kind: 'damage', radius: 2.4, duration: 4, dps: 45, element: 'fire', strength: 0, collapse: null, vfx: 'field.damage.fire' };
const FROST: FieldDef = { ...PULL, kind: 'slow', radius: 6, duration: 5, dps: 0, element: 'ice', strength: 0.35, collapse: null, vfx: 'field.slow.ice' };
const FROM: AreaDamageSource = { weaponId: 'blackhole', source: 'player', statusBuildup: 1 };

function setup(capacity?: number) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: -0.5, z: 0 }, size: { x: 60, y: 1, z: 60 } },
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -4 }, size: { x: 8, y: 3, z: 0.3 } },
    ]),
  );
  const blasts: { at: Vec3Like; def: ExplosionDef; from: AreaDamageSource }[] = [];
  const explosions: ExplosionApi = {
    explode: (at, def, from) => {
      blasts.push({ at: { x: at.x, y: at.y, z: at.z }, def, from: { ...from } });
      return 0;
    },
  };
  const visuals: string[] = [];
  const specials: SpecialHit[] = [];
  const fields = new FieldSystem({
    events,
    combat,
    explosions,
    capacity,
    specials: { onHit: (h) => void specials.push({ ...h }) },
    vfx: {
      projectileStart: () => 0,
      projectileMove: () => {},
      projectileEnd: () => {},
      beam: () => {},
      fieldStart: (v) => {
        visuals.push(`start ${v}`);
        return visuals.length;
      },
      fieldEnd: (h) => void visuals.push(`end ${h}`),
      charge: () => {},
      update: () => {},
      clear: () => {},
    },
  });
  const spawned: GameEvents['field:spawned'][] = [];
  const ended: number[] = [];
  events.on('field:spawned', (e) => spawned.push({ ...e, position: { ...e.position } }));
  events.on('field:ended', (e) => ended.push(e.id));
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) fields.fixedUpdate(DT);
  };
  return { combat, fields, blasts, visuals, specials, spawned, ended, run };
}

describe('FieldSystem', () => {
  it('ticks dps to damageables inside (line of sight), scaled by areaScale', () => {
    const t = setup();
    const inside = new FakeTarget({ x: 1, y: 0, z: 0 }, 1000);
    const behindWall = new FakeTarget({ x: 0, y: 0, z: -6 }, 1000);
    const outside = new FakeTarget({ x: 12, y: 0, z: 0 }, 1000);
    for (const f of [inside, behindWall, outside]) t.combat.register(f);
    t.fields.spawn({ x: 0, y: 1, z: 0 }, PULL, { ...FROM, areaScale: 2 });
    t.run(1);
    const ticks = Math.round(1 / ARSENAL.fields.tickInterval);
    expect(inside.received).toHaveLength(ticks);
    expect(inside.received[0]!.amount).toBeCloseTo(PULL.dps * ARSENAL.fields.tickInterval * 2, 6);
    expect(inside.received[0]!.element).toBe('void');
    expect(inside.received[0]!.statusBuildup).toBe(1);
    expect(behindWall.received).toHaveLength(0);
    expect(outside.received).toHaveLength(0);
  });

  it('floor fields snap to the floor and cover a cylinder', () => {
    const t = setup();
    const id = t.fields.spawn({ x: 0, y: 1.2, z: 3 }, FIRE, FROM);
    expect(id).toBeGreaterThan(0);
    expect(t.spawned[0]!.position.y).toBeCloseTo(0, 6);
    expect(t.spawned[0]).toMatchObject({ kind: 'damage', element: 'fire', radius: 2.4, duration: 4 });
    const standing = new FakeTarget({ x: 1, y: 0, z: 3 }, 1000);
    const high = new FakeTarget({ x: 0, y: 5, z: 3 }, 1000);
    t.combat.register(standing);
    t.combat.register(high);
    t.run(0.5);
    expect(standing.received.length).toBeGreaterThan(0);
    expect(high.received).toHaveLength(0);
  });

  it('pull: horizontal velocity towards the center, eased in the core, capped', () => {
    const t = setup();
    t.fields.spawn({ x: 0, y: 1, z: 0 }, PULL, FROM);
    const out = new Vector3();
    expect(t.fields.pullAt({ x: 4, y: 0, z: 0 }, out)).toBe(true);
    expect(out.x).toBeLessThan(0);
    expect(out.y).toBe(0);
    const P = ARSENAL.fields.pull;
    expect(-out.x).toBeCloseTo(Math.min(PULL.strength * P.responseTime, 4 / P.arrivalTime, P.maxSpeed), 6);
    // In the core: slower (eased), never overshooting.
    t.fields.pullAt({ x: 0.2, y: 0, z: 0 }, out);
    expect(-out.x).toBeLessThanOrEqual(0.2 / P.arrivalTime + 1e-9);
    expect(t.fields.pullAt({ x: 20, y: 0, z: 0 }, out)).toBe(false);
    expect(out.length()).toBe(0);
  });

  it('slow: the strongest slow field at a point, 1 outside', () => {
    const t = setup();
    t.fields.spawn({ x: 0, y: 0.5, z: 5 }, FROST, FROM);
    t.fields.spawn({ x: 1, y: 0.5, z: 5 }, { ...FROST, strength: 0.6 }, FROM);
    expect(t.fields.slowAt({ x: 0, y: 0, z: 5 })).toBeCloseTo(0.35, 9);
    expect(t.fields.slowAt({ x: 30, y: 0, z: 5 })).toBe(1);
  });

  it('collapses into its explosion at the end, events and visuals start/end once', () => {
    const t = setup();
    const special = { kind: 'fieldOnKill', chance: 1, field: FIRE } as const;
    const id = t.fields.spawn({ x: 0, y: 1, z: 0 }, PULL, { ...FROM, special, areaScale: 1.5 });
    t.run(PULL.duration - 0.1);
    expect(t.blasts).toHaveLength(0);
    t.run(0.2);
    expect(t.fields.active).toBe(0);
    expect(t.blasts).toHaveLength(1);
    expect(t.blasts[0]!.def).toBe(COLLAPSE);
    expect(t.blasts[0]!.from).toMatchObject({ weaponId: 'blackhole', areaScale: 1.5, special });
    expect(t.ended).toEqual([id]);
    expect(t.visuals).toEqual(['start field.pull.void', 'end 1']);
  });

  it('reports ticks to the specials, refuses spawns beyond the pool, clear() ends all without collapse', () => {
    const t = setup(2);
    const target = new FakeTarget({ x: 0.5, y: 0, z: 0 }, 1000);
    t.combat.register(target);
    const special = { kind: 'lifesteal', fraction: 0.05 } as const;
    expect(t.fields.spawn({ x: 0, y: 1, z: 0 }, PULL, { ...FROM, special })).toBeGreaterThan(0);
    expect(t.fields.spawn({ x: 0, y: 1, z: 0 }, FIRE, FROM)).toBeGreaterThan(0);
    expect(t.fields.spawn({ x: 0, y: 1, z: 0 }, FIRE, FROM)).toBe(0);
    t.run(0.3);
    expect(t.specials.length).toBeGreaterThan(0);
    expect(t.specials.every((h) => h.via === 'tick' && h.primary)).toBe(true);
    t.fields.clear();
    expect(t.fields.active).toBe(0);
    expect(t.ended).toHaveLength(2);
    expect(t.blasts).toHaveLength(0);
  });
});
