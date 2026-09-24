import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { DamageInfo, SpawnPointDef } from '../../core/contracts';
import { ENEMIES, ENEMY_AI } from '../../defs/enemies';
import { SEALS } from '../../defs/seals';
import { SealSystem } from '../../seals/SealSystem';
import { frontDistance } from '../../seals/sealGeometry';
import type { Enemy } from '../Enemy';
import { DT, createEnemyHarness } from '../testFakes';
import { breachAnimProgress, createBreachPlan, swingDuration } from './breach';

const seconds = (s: number): number => Math.round(s / DT);

/** A rift 20 m north of the player, enemies emerging towards +Z (the player). */
const SPAWN: SpawnPointDef = {
  id: 'rift_n',
  position: new Vector3(0, 0, -20),
  yaw: 0,
  zone: 'hall',
  kind: 'rift',
};

function setup(player = { x: 0, y: 0, z: 0 }) {
  const h = createEnemyHarness({ player });
  const seals = new SealSystem({ events: h.events, spawnPoints: [SPAWN] });
  h.manager.setBreach(seals);
  const broken: number[] = [];
  let time = 0;
  h.events.on('seal:broken', () => broken.push(time));
  const tick = (n: number, each?: () => void): void =>
    h.tick(n, (t) => {
      time = t;
      each?.();
    });
  const spawn = (type: string, at: { x: number; y: number; z: number } = SPAWN.position): Enemy => {
    const id = h.manager.spawn(type, at, { spawnPoint: SPAWN });
    const e = h.manager.enemies.find((x) => x.id === id);
    if (!e) throw new Error('spawn failed');
    return e;
  };
  return { h, seals, broken, tick, spawn, seal: seals.seal(SPAWN.id)! };
}

function hit(amount: number): DamageInfo {
  return {
    amount,
    zone: 'body',
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'rifle',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
  };
}

describe('breach plan (swing timing fitted to the segment time)', () => {
  it('whole swings per segment, phases scaled, animation progress monotonic', () => {
    const def = ENEMIES.swarmer;
    const plan = createBreachPlan(def, [0, 1], [0.4, 0.32], [0.58, 0.72]);
    expect(plan.attackId).toBe(def.breach!.attack);
    expect(plan.swingsPerSegment * swingDuration(plan)).toBeCloseTo(def.breach!.segmentTime);
    let last = -1;
    for (let t = 0; t < swingDuration(plan); t += 0.01) {
      const p = breachAnimProgress(plan, t);
      expect(p).toBeGreaterThanOrEqual(last - 1e-9);
      last = p;
    }
    // No usable attack: one strike at the end of each segment time, no animation.
    const bare = createBreachPlan({ attacks: [], breach: undefined }, [], [], []);
    expect(bare.animId).toBe(-1);
    expect(bare.windup).toBeCloseTo(ENEMY_AI.breach.fallback.segmentTime);
  });
});

describe('enemies at a sealed rift (breach state)', () => {
  it('wait behind the seal until every segment is torn down, then enter', () => {
    const t = setup();
    // The burst jitter put this one in front of the seal: it emerges in the pen behind it.
    const e = spawn(t, 'swarmer', { x: 2.5, y: 0, z: -17 });
    expect(frontDistance(t.seal.frame, e.position)).toBeLessThan(0);
    t.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    expect(e.state).toBe('breach');
    expect(e.override).toBe('hold');
    const at = e.position.clone();
    const segTime = ENEMIES.swarmer.breach!.segmentTime;

    // Tearing: bars fall one per segment time, the enemy never leaves its spot.
    let guard = 0;
    while (t.seal.up > 0 && guard++ < seconds(30)) {
      t.tick(1);
      if (t.seal.up > 0) {
        expect(e.state).toBe('breach');
        expect(e.position.distanceTo(at)).toBeLessThan(1e-6);
      }
    }
    expect(t.seal.up).toBe(0);
    expect(t.broken).toHaveLength(SEALS.segments);
    for (let i = 1; i < t.broken.length; i++) {
      expect(t.broken[i]! - t.broken[i - 1]!).toBeCloseTo(segTime, 1);
    }
    // Swings are telegraphed like attacks (sound cues).
    expect(t.h.byType('enemy:attack').length).toBeGreaterThanOrEqual(SEALS.segments);

    // Open: it enters and hunts the player.
    t.tick(seconds(1));
    expect(e.state === 'active' || e.state === 'attack').toBe(true);
    expect(e.override).not.toBe('hold');
    expect(e.position.z).toBeGreaterThan(at.z + 1);
    // Nothing left to tear: the next one walks straight in.
    const next = spawn(t, 'swarmer');
    t.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    expect(next.state).not.toBe('breach');
  });

  it('several enemies tear faster; repairs buy time; a stagger returns the enemy to the seal', () => {
    const t = setup();
    const a = spawn(t, 'swarmer');
    const b = spawn(t, 'swarmer', { x: -1, y: 0, z: -20 });
    t.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    expect(a.state).toBe('breach');
    expect(b.state).toBe('breach');
    const segTime = ENEMIES.swarmer.breach!.segmentTime;
    t.tick(seconds(segTime * 1.6));
    // Two tearers: about two bars per segment time.
    expect(t.seal.up).toBeLessThanOrEqual(SEALS.segments - 2);
    const left = t.seal.up;
    t.seals.repair(SPAWN.id, 2);
    expect(t.seal.up).toBe(Math.min(SEALS.segments, left + 2));

    // A heavy hit staggers it; afterwards it goes back to tearing.
    t.h.combat.dealDamage(a, hit(ENEMIES.swarmer.stagger.threshold + 1));
    t.tick(2);
    expect(a.state).toBe('stagger');
    t.tick(seconds(ENEMIES.swarmer.stagger.duration) + 2);
    expect(a.state).toBe('breach');
  });

  it('enemies spawned on top of each other ease apart and stay in the pen', () => {
    const t = setup();
    const a = spawn(t, 'swarmer');
    const b = spawn(t, 'swarmer');
    t.tick(seconds(ENEMIES.swarmer.emergeTime) + seconds(1));
    expect(a.state).toBe('breach');
    const minD = ENEMIES.swarmer.nav.radius * 2;
    expect(a.position.distanceTo(b.position)).toBeGreaterThan(minD * 0.95);
    for (const e of [a, b]) expect(frontDistance(t.seal.frame, e.position)).toBeLessThan(0);
  });

  it('a player hugging the seal gets swiped through it; the enemy then goes back to tearing', () => {
    const plane = SPAWN.position.z + SEALS.gates.rift.offset;
    const near = setup({ x: 0, y: 0, z: plane + 0.35 });
    const e = near.spawn('swarmer');
    near.tick(seconds(ENEMIES.swarmer.emergeTime) + 1);
    let attacked = false;
    let backToSeal = false;
    near.tick(seconds(4), () => {
      if (e.state === 'attack') attacked = true;
      else if (attacked && e.state === 'breach') backToSeal = true;
    });
    expect(attacked).toBe(true);
    expect(backToSeal).toBe(true);
    expect(near.h.player.totalDamage).toBeGreaterThan(0);
    expect(frontDistance(near.seal.frame, e.position)).toBeLessThan(0);

    // Three meters back the lattice keeps them off.
    const safe = setup({ x: 0, y: 0, z: plane + 3 });
    const f = safe.spawn('swarmer');
    safe.tick(seconds(ENEMIES.swarmer.emergeTime) + seconds(5));
    expect(f.state).toBe('breach');
    expect(safe.h.player.totalDamage).toBe(0);
    expect(safe.seal.up).toBeLessThan(SEALS.segments);
  });

  it('a player on their side of the seal frees them at once', () => {
    const t = setup({ x: 0, y: 0, z: -21.5 });
    const e = spawn(t, 'swarmer');
    t.tick(seconds(ENEMIES.swarmer.emergeTime) + 3);
    expect(e.state).not.toBe('breach');
    expect(t.seal.up).toBe(SEALS.segments);
  });

  it('without seals (or an open seal) nothing changes; a tank tears two bars per slam', () => {
    const plain = createEnemyHarness();
    const id = plain.manager.spawn('swarmer', { x: 0, y: 0, z: -20 }, { spawnPoint: SPAWN });
    plain.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    expect(plain.manager.enemies.find((x) => x.id === id)!.state).not.toBe('breach');

    const t = setup();
    const tank = spawn(t, 'tank');
    t.tick(seconds(ENEMIES.tank.emergeTime) + 2);
    expect(tank.state).toBe('breach');
    t.tick(seconds(ENEMIES.tank.breach!.segmentTime + 0.2));
    expect(t.seal.up).toBe(SEALS.segments - ENEMIES.tank.breach!.segmentsPerTear);
  });
});

function spawn(t: ReturnType<typeof setup>, type: string, at?: { x: number; y: number; z: number }): Enemy {
  return t.spawn(type, at);
}
