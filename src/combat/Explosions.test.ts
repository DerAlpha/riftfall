import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerDamageKind } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { ARSENAL } from '../defs/combat';
import type { ExplosionDef } from '../defs/weapons';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import type { SpecialHit } from '../weapons/fire/types';
import { CombatWorld } from './CombatWorld';
import { Explosions, type ExplosionPlayer } from './Explosions';
import { FakeTarget, buildTestLevel } from './testFakes';

const BLAST: ExplosionDef = {
  radius: 4,
  damage: 200,
  minFalloffMultiplier: 0.25,
  element: 'fire',
  impulse: 8,
  propImpulse: 300,
  selfDamageScale: 0.5,
  shake: 0.6,
  vfx: 'explosion.fire',
  audio: 'explosion.fire',
};

class FakePlayer implements ExplosionPlayer {
  readonly position = new Vector3(0, 0, 0);
  readonly eyePosition = new Vector3(0, 1.6, 0);
  alive = true;
  readonly hits: { amount: number; dir: Vec3Like | undefined; kind: PlayerDamageKind | undefined }[] = [];
  damage(amount: number, direction?: Vec3Like, kind?: PlayerDamageKind): number {
    this.hits.push({ amount, dir: direction ? { ...direction } : undefined, kind });
    return amount;
  }
}

function setup(opts: { wall?: boolean } = {}) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel(
      opts.wall
        ? [{ material: 'concrete_wall', center: { x: 0, y: 1.5, z: -2 }, size: { x: 6, y: 3, z: 0.3 } }]
        : [],
    ),
  );
  const player = new FakePlayer();
  player.position.set(0, 0, 20);
  player.eyePosition.set(0, 1.6, 20);
  const specials: SpecialHit[] = [];
  const explosions = new Explosions({
    events,
    combat,
    player,
    specials: { onHit: (h) => void specials.push({ ...h, point: { ...h.point } }) },
  });
  const blasts: GameEvents['combat:explosion'][] = [];
  const shakes: number[] = [];
  events.on('combat:explosion', (e) => blasts.push({ ...e, position: { ...e.position } }));
  events.on('camera:shake', (e) => shakes.push(e.trauma));
  return { events, combat, player, explosions, blasts, shakes, specials };
}

const FROM = { weaponId: 'gl', source: 'player' as const, statusBuildup: 1 };

describe('Explosions', () => {
  it('damage falls off linearly to the nearest hitbox surface, only inside the radius', () => {
    const t = setup();
    const near = new FakeTarget({ x: 0, y: 0, z: 0 }, 1000);
    const mid = new FakeTarget({ x: 2.24, y: 0, z: 0 }, 1000);
    const far = new FakeTarget({ x: 6, y: 0, z: 0 }, 1000);
    for (const f of [near, mid, far]) t.combat.register(f);
    const hits = t.explosions.explode({ x: 0, y: 1.1, z: 0 }, BLAST, FROM);
    expect(hits).toBe(2);
    // Inside the body capsule: full damage.
    expect(near.received[0]!.amount).toBeCloseTo(200, 6);
    expect(near.received[0]!.kind).toBe('explosion');
    expect(near.received[0]!.element).toBe('fire');
    expect(near.received[0]!.statusBuildup).toBe(1);
    // 2.24 − 0.24 (body radius) = 2 m from the surface: halfway → 1 − 0.75 × 0.5.
    expect(mid.received[0]!.amount).toBeCloseTo(200 * 0.625, 3);
    expect(mid.received[0]!.direction.x).toBeGreaterThan(0.9);
    expect(mid.received[0]!.impulse).toBeCloseTo(8 * 0.625, 3);
    expect(far.received).toHaveLength(0);
  });

  it('needs line of sight: a wall shields the target', () => {
    const t = setup({ wall: true });
    const behind = new FakeTarget({ x: 0, y: 0, z: -3.5 }, 1000);
    const front = new FakeTarget({ x: 0, y: 0, z: 1.5 }, 1000);
    t.combat.register(behind);
    t.combat.register(front);
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, FROM);
    expect(behind.received).toHaveLength(0);
    expect(front.received).toHaveLength(1);
  });

  it('spares the source team, scales by areaScale, reports hits to the specials (first is primary)', () => {
    const t = setup();
    const a = new FakeTarget({ x: 1, y: 0, z: 0 }, 1000);
    const b = new FakeTarget({ x: -1, y: 0, z: 0 }, 1000);
    t.combat.register(a);
    t.combat.register(b);
    const special = { kind: 'lifesteal', fraction: 0.1 } as const;
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, { ...FROM, areaScale: 2, special });
    expect(a.received[0]!.amount).toBeGreaterThan(200);
    expect(t.specials).toHaveLength(2);
    expect(t.specials[0]!.via).toBe('blast');
    expect(t.specials.map((h) => h.primary)).toEqual([true, false]);
    // No special: no reports.
    t.specials.length = 0;
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, FROM);
    expect(t.specials).toHaveLength(0);
  });

  it('hurts the player: its own blasts by selfDamageScale, other sources fully, kind explosion, towards the blast', () => {
    const t = setup();
    t.player.position.set(0, 0, 2);
    t.player.eyePosition.set(0, 1.6, 2);
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, FROM);
    expect(t.player.hits).toHaveLength(1);
    const own = t.player.hits[0]!;
    expect(own.kind).toBe('explosion');
    expect(own.dir!.z).toBeLessThan(-0.5);
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, { ...FROM, source: 'enemy' });
    expect(t.player.hits[1]!.amount).toBeCloseTo(own.amount / BLAST.selfDamageScale, 6);
    // Out of range: nothing.
    t.player.position.set(0, 0, 10);
    t.player.eyePosition.set(0, 1.6, 10);
    t.explosions.explode({ x: 0, y: 1, z: 0 }, BLAST, FROM);
    expect(t.player.hits).toHaveLength(2);
  });

  it('emits combat:explosion with the def preset/sound and shakes by distance', () => {
    const t = setup();
    t.player.eyePosition.set(0, 1.6, 6);
    t.explosions.explode({ x: 0, y: 1.6, z: 0 }, BLAST, FROM);
    expect(t.blasts).toEqual([
      { position: { x: 0, y: 1.6, z: 0 }, radius: 4, element: 'fire', vfx: 'explosion.fire', audio: 'explosion.fire' },
    ]);
    const reach = BLAST.radius * ARSENAL.explosions.shakeReach;
    expect(t.shakes[0]).toBeCloseTo(BLAST.shake * (1 - 6 / reach), 6);
    t.player.eyePosition.set(0, 1.6, 40);
    t.explosions.explode({ x: 0, y: 1.6, z: 0 }, BLAST, FROM);
    expect(t.shakes).toHaveLength(1);
  });

  it('pushes dynamic props in the radius (lifting them)', async () => {
    const physics = await PhysicsWorld.create();
    const events = new EventBus<GameEvents>();
    const combat = new CombatWorld({ events, physics });
    combat.setLevel(buildTestLevel([]));
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 20 }, undefined, { kind: 'world', surface: 'concrete' });
    const crate = physics.addDynamicBox({ x: 2, y: 0.5, z: 0 }, { x: 0.4, y: 0.4, z: 0.4 }, null, {
      data: { kind: 'prop', surface: 'metal' },
    });
    const far = physics.addDynamicBox({ x: 12, y: 0.5, z: 0 }, { x: 0.4, y: 0.4, z: 0.4 }, null, {
      data: { kind: 'prop', surface: 'metal' },
    });
    physics.step(1 / 60);
    const explosions = new Explosions({ events, combat, physics });
    explosions.explode({ x: 0, y: 0.5, z: 0 }, BLAST, FROM);
    expect(explosions.stats.props).toBe(1);
    const v = crate.linvel();
    expect([v.x, v.y, v.z, crate.mass()]).toEqual([]);
    expect(v.x).toBeGreaterThan(1);
    expect(v.y).toBeGreaterThan(0.5);
    expect(Math.hypot(far.linvel().x, far.linvel().y)).toBeLessThan(1e-6);
    physics.dispose();
  });
});
