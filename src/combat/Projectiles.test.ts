import { describe, expect, it } from 'vitest';
import { Group, Scene, Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { PROJECTILES, PROJECTILE_POOL } from '../defs/enemies';
import { FakePlayer } from '../enemies/testFakes';
import { CombatWorld } from './CombatWorld';
import { ProjectileSystem, maxLobTime, solveLob } from './Projectiles';
import { FakeTarget, buildTestLevel } from './testFakes';

const DT = 1 / 60;
const ACID = PROJECTILES['acid.glob'];

function setup(
  boxes: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } }[] = [],
) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events });
  const root = new Group();
  root.add(
    buildTestLevel([
      { material: 'floor_concrete', center: { x: 0, y: -0.25, z: 0 }, size: { x: 200, y: 0.5, z: 200 } },
      ...boxes.map((b) => ({ material: 'concrete_wall', ...b })),
    ]),
  );
  combat.setLevel(root);
  const player = new FakePlayer(0, 0, 0);
  const spawned: string[] = [];
  const decals: string[] = [];
  const vfx = {
    spawn: (effect: string) => void spawned.push(effect),
    decal: (kind: string) => void decals.push(kind),
  };
  const scene = new Scene();
  const proj = new ProjectileSystem({ events, combat, target: player, vfx, scene });
  const impacts: GameEvents['combat:impact'][] = [];
  events.on('combat:impact', (e) => impacts.push({ ...e, point: { ...e.point }, normal: { ...e.normal } }));
  return { events, combat, player, proj, impacts, spawned, decals, scene };
}

describe('solveLob', () => {
  it('lands exactly on a static aim point (analytic gravity)', () => {
    const v = { x: 0, y: 0, z: 0 };
    const o = { x: 0, y: 1.5, z: -12 };
    const aim = { x: 3, y: 1.2, z: 0 };
    const t = solveLob(o, aim, { x: 0, y: 0, z: 0 }, 1, ACID, v);
    expect(t).toBeGreaterThanOrEqual(ACID.minFlightTime);
    expect(t).toBeLessThanOrEqual(ACID.maxFlightTime);
    const x = o.x + v.x * t;
    const y = o.y + v.y * t - 0.5 * ACID.gravity * t * t;
    const z = o.z + v.z * t;
    expect(x).toBeCloseTo(aim.x, 6);
    expect(y).toBeCloseTo(aim.y, 6);
    expect(z).toBeCloseTo(aim.z, 6);
    // Lobbed: it rises first.
    expect(v.y).toBeGreaterThan(0);
  });

  it('flattens the arc under a ceiling, but never beyond the launch speed cap', () => {
    const o = { x: 0, y: 1.5, z: -20 };
    const aim = { x: 0, y: 1.2, z: 0 };
    const still = { x: 0, y: 0, z: 0 };
    const v = { x: 0, y: 0, z: 0 };
    const apex = (vy: number): number => o.y + (vy * vy) / (2 * ACID.gravity);
    solveLob(o, aim, still, 1, ACID, v);
    expect(apex(v.y)).toBeGreaterThan(4); // free lob: well above a 4 m corridor ceiling
    const t = solveLob(o, aim, still, 1, ACID, v, 3, 3.6);
    expect(apex(v.y)).toBeLessThanOrEqual(3.6 + 1e-6);
    // Still lands on the aim point.
    expect(o.z + v.z * t).toBeCloseTo(aim.z, 6);
    expect(o.y + v.y * t - 0.5 * ACID.gravity * t * t).toBeCloseTo(aim.y, 6);
    // A crawlspace: the horizontal speed stays capped (it hits the ceiling rather than turn hitscan).
    solveLob(o, aim, still, 1, ACID, v, 3, o.y + 0.05);
    expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(ACID.maxLaunchSpeed + 1e-6);
    // maxLobTime: no limit without a ceiling; the flattest arc when the target is above it.
    expect(maxLobTime(0, 0, Number.POSITIVE_INFINITY, 16)).toBe(Number.POSITIVE_INFINITY);
    expect(maxLobTime(0, 3, 2, 16)).toBeCloseTo(Math.sqrt(6 / 16));
  });

  it('leads a moving target (converged prediction)', () => {
    const v = { x: 0, y: 0, z: 0 };
    const o = { x: 0, y: 1.5, z: -14 };
    const aim = { x: 0, y: 1.2, z: 0 };
    const vel = { x: 5, y: 0, z: 0 };
    const t = solveLob(o, aim, vel, 1, ACID, v);
    expect(o.x + v.x * t).toBeCloseTo(aim.x + vel.x * t, 2);
    expect(o.z + v.z * t).toBeCloseTo(aim.z, 6);
  });
});

describe('ProjectileSystem', () => {
  it('a lobbed glob with lead hits a strafing player; without lead it misses the body', () => {
    for (const lead of [1, 0]) {
      const s = setup();
      const speed = 5;
      s.player.velocity.set(speed, 0, 0);
      const origin = new Vector3(0, 1.5, -14);
      const aim = new Vector3(0, s.player.eyePosition.y - 0.45, 0);
      expect(s.proj.lob('acid.glob', origin, aim, s.player.velocity, lead)).toBe(true);
      let t = 0;
      for (let i = 0; i < 180 && s.proj.stats.active > 0; i++) {
        t += DT;
        s.player.setPosition(speed * t, 0, 0);
        s.proj.fixedUpdate(DT);
      }
      expect(s.proj.stats.active).toBe(0);
      const direct = s.player.hits.some((h) => Math.abs(h.amount - ACID.damage) < 1e-6);
      if (lead === 1) {
        expect(direct).toBe(true);
        expect(s.impacts.length).toBe(1);
        expect(s.impacts[0]!.surface).toBe('slime');
        expect(s.impacts[0]!.kind).toBe('projectile');
        // Direction points from the player towards the shooter.
        expect(s.player.hits[0]!.direction!.z).toBeLessThan(0);
      } else {
        expect(direct).toBe(false);
      }
    }
  });

  it('a long lob in a low corridor passes under the ceiling and hits the player', () => {
    const ceiling = { center: { x: 0, y: 4.25, z: -10 }, size: { x: 6, y: 0.5, z: 30 } };
    const s = setup([ceiling]);
    const origin = new Vector3(0, 1.45, -20);
    const aim = new Vector3(0, s.player.eyePosition.y - 0.45, 0);
    expect(s.proj.lob('acid.glob', origin, aim, s.player.velocity, 1)).toBe(true);
    for (let i = 0; i < 180 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(s.impacts).toHaveLength(1);
    expect(s.impacts[0]!.normal.y).toBeGreaterThan(-0.5); // not the ceiling
    expect(s.player.hits.some((h) => Math.abs(h.amount - ACID.damage) < 1e-6)).toBe(true);
    // The extra splash burst plays at world impacts only (not in the player's face).
    expect(s.spawned).not.toContain(ACID.impactEffect.effect);
  });

  it('an ally standing under the lob path is no ceiling (the arc stays a lob)', () => {
    const flight = (withAlly: boolean): { ticks: number; maxY: number } => {
      const s = setup();
      // Head top at 2.06 m, above the mouth: an upward ceiling probe from the path would hit it.
      if (withAlly) s.combat.register(new FakeTarget({ x: 0, y: 0.3, z: -7 }));
      const aim = new Vector3(0, s.player.eyePosition.y - 0.45, 0);
      s.proj.lob('acid.glob', new Vector3(0, 1.45, -14), aim, s.player.velocity, 1, { source: 'enemy' });
      let ticks = 0;
      let maxY = 0;
      for (; s.proj.stats.active > 0 && ticks < 200; ticks++) {
        s.proj.fixedUpdate(DT);
        s.proj.forEachProjectile((_x, y) => (maxY = Math.max(maxY, y)));
      }
      return { ticks, maxY };
    };
    const free = flight(false);
    expect(free.maxY).toBeGreaterThan(2.5);
    expect(flight(true)).toEqual(free);
  });

  it('splash falls off with distance and a floor impact leaves a burning puddle', () => {
    const s = setup();
    // Straight down onto the floor 1.2 m from the player.
    s.proj.fire('acid.glob', { x: 1.2 + ACID.splash.innerRadius, y: 3, z: 0 }, { x: 0, y: -8, z: 0 });
    for (let i = 0; i < 60 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(s.impacts).toHaveLength(1);
    expect(s.impacts[0]!.decal).toBe(true);
    expect(s.player.hits).toHaveLength(1);
    const splash = s.player.hits[0]!.amount;
    expect(splash).toBeGreaterThan(ACID.splash.damage * ACID.splash.minFactor);
    expect(splash).toBeLessThan(ACID.splash.damage);
    expect(s.proj.stats.puddles).toBe(1);
    expect(s.decals).toContain('slime');
    expect(s.spawned).toContain(ACID.impactEffect.effect);

    // Step into the puddle: damage ticks at the def's interval.
    const P = ACID.puddle;
    s.player.setPosition(1.2 + ACID.splash.innerRadius, 0, 0);
    const before = s.player.hits.length;
    for (let i = 0; i < Math.round(1 / DT); i++) s.proj.fixedUpdate(DT);
    const ticks = s.player.hits.length - before;
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(1 / P.tickInterval) - 1);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(1 / P.tickInterval));
    expect(s.player.hits[s.player.hits.length - 1]!.amount).toBeCloseTo(P.dps * P.tickInterval);
    // Out of it: nothing; and it dries up.
    s.player.setPosition(10, 0, 0);
    const out = s.player.hits.length;
    for (let i = 0; i < Math.round(P.duration / DT); i++) s.proj.fixedUpdate(DT);
    expect(s.player.hits.length).toBe(out);
    expect(s.proj.stats.puddles).toBe(0);
  });

  it('overlapping puddles do not stack their damage', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.proj.spawnPuddle('acid.glob', { x: i * 0.2, y: 0, z: 0 });
    s.player.setPosition(0.3, 0, 0);
    for (let i = 0; i < Math.round(1 / DT); i++) s.proj.fixedUpdate(DT);
    const P = ACID.puddle;
    expect(s.player.totalDamage).toBeLessThanOrEqual(P.dps * 1 + 1e-6);
    expect(s.player.totalDamage).toBeGreaterThan(P.dps * 0.5);
  });

  it('a wall hit drops the puddle to the floor below', () => {
    const s = setup([{ center: { x: 0, y: 2, z: -4 }, size: { x: 6, y: 4, z: 0.5 } }]);
    s.player.setPosition(0, 0, 20);
    s.proj.fire('acid.glob', { x: 0, y: 1.5, z: 2 }, { x: 0, y: 1, z: -14 });
    for (let i = 0; i < 60 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(s.impacts).toHaveLength(1);
    expect(s.impacts[0]!.normal.z).toBeGreaterThan(0.9);
    expect(s.proj.stats.puddles).toBe(1);
  });

  it('splash and puddles never reach through the wall the glob hit', () => {
    const wall = { center: { x: 0, y: 2, z: -1 }, size: { x: 6, y: 4, z: 0.2 } };
    const shoot = (playerZ: number) => {
      const s = setup([wall]);
      // 1 m beside the glob's line: it flies past the player.
      s.player.setPosition(1, 0, playerZ);
      // Splats on the near face (z = −1.1), within splash range of both sides.
      s.proj.fire('acid.glob', { x: 0, y: 1.2, z: -3 }, { x: 0, y: 0, z: 14 });
      for (let i = 0; i < 60 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
      expect(s.impacts).toHaveLength(1);
      expect(s.impacts[0]!.normal.z).toBeLessThan(-0.9);
      expect(s.proj.stats.puddles).toBe(1); // ran down to the floor in front of the wall
      const splash = s.player.hits.length;
      for (let i = 0; i < Math.round(1 / DT); i++) s.proj.fixedUpdate(DT);
      return { splash, burns: s.player.hits.length - splash };
    };
    // Behind the wall, hugging it: nothing.
    expect(shoot(-0.5)).toEqual({ splash: 0, burns: 0 });
    // Control: as close on the near side, splash and puddle both reach.
    const near = shoot(-1.6);
    expect(near.splash).toBe(1);
    expect(near.burns).toBeGreaterThan(0);
  });

  it('enemy globs pass through enemies (no friendly fire) and never hit their owner', () => {
    const s = setup();
    const ally = new FakeTarget({ x: 0, y: 0, z: -6 });
    s.combat.register(ally);
    s.player.setPosition(0, 0, 0);
    s.proj.fire(
      'acid.glob',
      { x: 0, y: 1.2, z: -8 },
      { x: 0, y: 0.5, z: 14 },
      { owner: null, source: 'enemy' },
    );
    for (let i = 0; i < 90 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(ally.received).toHaveLength(0);
    expect(s.player.hits.length).toBeGreaterThan(0);
  });

  it('passing an enemy that clips into a wall does not tunnel the glob through the wall', () => {
    const s = setup([{ center: { x: 0, y: 2, z: -1 }, size: { x: 6, y: 4, z: 0.2 } }]);
    // Body capsule (radius 0.24) centred inside the wall, poking 1 cm out of its near face.
    const ally = new FakeTarget({ x: 0, y: 0, z: -1.1 + 0.24 - 0.01 });
    s.combat.register(ally);
    s.player.setPosition(0, 0, 3);
    s.proj.fire('acid.glob', { x: 0, y: 1.15, z: -3 }, { x: 0, y: 0.5, z: 14 }, { source: 'enemy' });
    for (let i = 0; i < 90 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(s.impacts).toHaveLength(1);
    expect(s.impacts[0]!.point.z).toBeCloseTo(-1.1, 3);
    expect(s.player.hits).toHaveLength(0);
    expect(ally.received).toHaveLength(0);
  });

  it('pools: capacity is a hard limit, freed slots are reused, unknown ids are refused', () => {
    const s = setup();
    s.player.alive = false;
    for (let i = 0; i < PROJECTILE_POOL.projectiles; i++) {
      expect(s.proj.fire('acid.glob', { x: i, y: 50, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(true);
    }
    expect(s.proj.fire('acid.glob', { x: 0, y: 50, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
    expect(s.proj.fire('nope', { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
    for (let i = 0; i < 400 && s.proj.stats.active > 0; i++) s.proj.fixedUpdate(DT);
    expect(s.proj.stats.active).toBe(0);
    expect(s.proj.fire('acid.glob', { x: 0, y: 50, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(true);
    s.proj.clear();
    expect(s.proj.stats.active).toBe(0);
  });

  it('renders all blobs with one InstancedMesh and disposes it', () => {
    const s = setup();
    s.player.alive = false;
    s.proj.fire('acid.glob', { x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 });
    s.proj.spawnPuddle('acid.glob', { x: 3, y: 0, z: 0 });
    s.proj.fixedUpdate(DT);
    s.proj.update(DT, 0.5);
    const mesh = s.proj.mesh!;
    expect(mesh.parent).toBe(s.scene);
    expect(mesh.count).toBe(2);
    // HDR color (blooms).
    expect(Math.max(...(mesh.instanceColor!.array as Float32Array).slice(0, 3))).toBeGreaterThan(1);
    s.proj.dispose();
    expect(mesh.parent).toBeNull();
    expect(s.proj.fire('acid.glob', { x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(false);
  });
});
