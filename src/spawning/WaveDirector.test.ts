import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { EnemyManagerApi, EnemySpawnOptions, EnemyTargetApi, SpawnPointDef } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { SPAWN_POINTS, WAVES } from '../defs/waves';
import { WaveDirector, type WaveDirectorDeps } from './WaveDirector';
import { waveTotal } from './waveFormula';

const M = WAVES.classic;
const DT = 1 / 60;

interface Spawned {
  id: number;
  type: string;
  position: Vector3;
  health: number;
  speed: number;
  damage: number;
  point: string | null;
}

class FakeEnemies implements EnemyManagerApi {
  alive = 0;
  capacity = 64;
  readonly spawned: Spawned[] = [];
  /** Spawn calls that fail from now on (-1 = forever). */
  failures = 0;
  cleared = 0;
  spawnPoints: readonly SpawnPointDef[] | null = null;
  private nextId = 1;
  readonly stats = { alive: 0, byType: {}, aiMs: 0 };

  spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null {
    if (this.failures !== 0) {
      if (this.failures > 0) this.failures--;
      return null;
    }
    this.alive++;
    const id = this.nextId++;
    this.spawned.push({
      id,
      type,
      position: new Vector3(position.x, position.y, position.z),
      health: opts?.healthMultiplier ?? 1,
      speed: opts?.speedMultiplier ?? 1,
      damage: opts?.damageMultiplier ?? 1,
      point: opts?.spawnPoint?.id ?? null,
    });
    return id;
  }
  kill(n = this.alive): void {
    this.alive = Math.max(0, this.alive - n);
  }
  clear(): void {
    this.alive = 0;
    this.cleared++;
  }
  killAll(): number {
    const n = this.alive;
    this.alive = 0;
    return n;
  }
  setSpawnPoints(points: readonly SpawnPointDef[] | null): void {
    this.spawnPoints = points;
  }
  fixedUpdate(): void {}
  update(): void {}
  dispose(): void {}
}

function target(): EnemyTargetApi & { alive: boolean } {
  return {
    position: new Vector3(0, 0, 0),
    eyePosition: new Vector3(0, 1.6, 0),
    velocity: new Vector3(),
    alive: true,
    damage: () => 0,
  };
}

function point(id: string, x: number, z: number, zone = 'main'): SpawnPointDef {
  return { id, position: new Vector3(x, 0, z), yaw: 0, zone, kind: 'rift' };
}

/** Rifts: one in front of the camera (looks down −Z), others behind / to the side. */
const POINTS = [point('front', 0, -20), point('behind', 0, 20), point('left', -20, 5), point('right', 20, 5)];

function setup(over: Partial<WaveDirectorDeps> = {}) {
  const events = new EventBus<GameEvents>();
  const enemies = new FakeEnemies();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.05, 400);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  const log: string[] = [];
  const payloads: { type: string; payload: unknown }[] = [];
  for (const type of ['wave:intermission', 'wave:start', 'wave:progress', 'wave:complete'] as const) {
    events.on(type, (p) => {
      log.push(type);
      payloads.push({ type, payload: { ...p } });
    });
  }
  const t = target();
  const waves = new WaveDirector({
    events,
    enemies,
    spawnPoints: POINTS,
    target: t,
    camera,
    rng: new Rng('waves-test'),
    ...over,
  });
  const tick = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) waves.fixedUpdate(DT);
  };
  const last = <K extends keyof GameEvents>(type: K): GameEvents[K] =>
    [...payloads].reverse().find((p) => p.type === type)!.payload as GameEvents[K];
  return { events, enemies, camera, waves, tick, log, last, target: t };
}

describe('WaveDirector', () => {
  it('runs intermission → wave → complete → intermission', () => {
    const { waves, enemies, tick, log, last } = setup();
    expect(waves.state).toBe('idle');
    expect(enemies.spawnPoints).toBe(POINTS); // leash relocation uses the map's rifts
    waves.start();
    expect(waves.state).toBe('intermission');
    expect(last('wave:intermission')).toEqual({ nextWave: 1, duration: M.firstIntermission });
    expect(waves.wave).toBe(0);

    tick(M.firstIntermission + DT);
    expect(waves.state).toBe('active');
    expect(waves.wave).toBe(1);
    expect(last('wave:start')).toEqual({ wave: 1, total: waveTotal(M, 1), kind: 'normal' });
    // Nothing emerges before the start delay (sting + banner).
    tick(M.startDelay - 0.1);
    expect(enemies.spawned.length).toBe(0);

    // Spawn everything, killing as they come.
    for (let i = 0; i < 60 * 60 && enemies.spawned.length < waveTotal(M, 1); i++) {
      waves.fixedUpdate(DT);
      enemies.kill(1);
    }
    expect(enemies.spawned.length).toBe(waveTotal(M, 1));
    expect(enemies.spawned.every((s) => s.type === 'swarmer')).toBe(true);
    expect(log).toContain('wave:progress');
    enemies.kill();
    waves.fixedUpdate(DT);
    expect(last('wave:complete').wave).toBe(1);
    expect(last('wave:complete').duration).toBeGreaterThan(0);
    expect(waves.state).toBe('intermission');
    expect(last('wave:intermission')).toEqual({ nextWave: 2, duration: M.intermission });
    expect(waves.remaining).toBe(0);
  });

  it('never exceeds max alive and reports remaining = queued + alive', () => {
    const { waves, enemies, tick, last } = setup();
    waves.setWave(12);
    const max = waves.plan.maxAlive;
    expect(max).toBeLessThanOrEqual(60);
    expect(waves.plan.total).toBeGreaterThan(max);
    tick(60);
    expect(enemies.alive).toBe(max);
    expect(waves.remaining).toBe(waves.plan.total);
    expect(last('wave:progress')).toEqual({ wave: 12, remaining: waves.plan.total, alive: max });
    enemies.kill(5);
    tick(5);
    expect(enemies.alive).toBe(max);
    expect(waves.remaining).toBe(waves.plan.total - 5);
  });

  it('spawns bursts from one rift with the wave multipliers, preferring rifts out of view', () => {
    const { waves, enemies, tick } = setup();
    waves.setWave(4);
    tick(30);
    expect(enemies.spawned.length).toBeGreaterThan(5);
    const p = waves.plan;
    for (const s of enemies.spawned) {
      expect(s.health).toBeCloseTo(p.health);
      expect(s.speed).toBeCloseTo(p.speed);
      expect(s.damage).toBeCloseTo(p.damage);
      expect(s.point).not.toBeNull();
      const rift = POINTS.find((r) => r.id === s.point)!;
      expect(s.position.distanceTo(rift.position)).toBeLessThanOrEqual(M.cadence.spread + 1e-6);
    }
    // The rift in front of the camera is in view: the others are used.
    expect(enemies.spawned.some((s) => s.point === 'front')).toBe(false);
    // Consecutive bursts never share a rift.
    const bursts: string[] = [];
    for (const s of enemies.spawned) if (bursts[bursts.length - 1] !== s.point) bursts.push(s.point!);
    expect(new Set(bursts).size).toBeGreaterThan(1);
  });

  it('uses a rift in view when the line of sight is blocked', () => {
    const { waves, enemies, tick } = setup({
      spawnPoints: [point('front', 0, -20), point('front2', 3, -24)],
      lineOfSight: () => false,
    });
    waves.setWave(1);
    tick(10);
    expect(enemies.spawned.length).toBeGreaterThan(0);
  });

  it('only spawns in active zones', () => {
    const { waves, enemies, tick } = setup({
      spawnPoints: [point('lab', 0, 20, 'lab'), point('hall', 20, 0, 'hall')],
      isZoneActive: (z) => z === 'hall',
    });
    waves.setWave(3);
    tick(20);
    expect(enemies.spawned.length).toBeGreaterThan(0);
    expect(enemies.spawned.every((s) => s.point === 'hall')).toBe(true);
  });

  it('announces tank waves and queues the tank', () => {
    const { waves, enemies, last } = setup();
    waves.setWave(5);
    expect(enemies.cleared).toBe(1);
    expect(last('wave:start').kind).toBe('tank');
    for (let i = 0; i < 60 * 120 && waves.queued > 0; i++) {
      waves.fixedUpdate(DT);
      enemies.kill(1);
    }
    expect(enemies.spawned.filter((s) => s.type === 'tank').length).toBe(1);
    // Spitters are unlocked by now.
    expect(enemies.spawned.some((s) => s.type === 'spitter')).toBe(true);
  });

  it('skips the intermission on demand and stops cleanly', () => {
    const { waves, tick, last } = setup();
    waves.start(3);
    expect(last('wave:intermission').nextWave).toBe(3);
    waves.skipIntermission();
    expect(waves.state).toBe('active');
    expect(waves.wave).toBe(3);
    waves.stop();
    expect(waves.state).toBe('over');
    tick(10);
    expect(waves.state).toBe('over');
    waves.skipIntermission(); // no-op outside an intermission
    expect(waves.state).toBe('over');
    waves.reset();
    expect(waves.state).toBe('idle');
    expect(waves.wave).toBe(0);
  });

  it('freezes while the player is dead', () => {
    const { waves, enemies, tick, target } = setup();
    waves.setWave(2);
    target.alive = false;
    tick(20);
    expect(enemies.spawned.length).toBe(0);
    target.alive = true;
    tick(5);
    expect(enemies.spawned.length).toBeGreaterThan(0);
  });

  it('retries failed spawns and drops them eventually so the wave can finish', () => {
    const { waves, enemies, tick, last } = setup();
    waves.setWave(1);
    enemies.failures = 3;
    tick(M.startDelay + 1);
    // Transient failures: retried, nothing lost.
    for (let i = 0; i < 60 * 60 && waves.queued > 0; i++) {
      waves.fixedUpdate(DT);
      enemies.kill(1);
    }
    expect(enemies.spawned.length).toBe(waveTotal(M, 1));
    enemies.kill();
    waves.fixedUpdate(DT);
    expect(last('wave:complete').wave).toBe(1);

    // Permanent failure: every queued spawn is dropped after maxSpawnFailures tries.
    waves.setWave(1);
    enemies.failures = -1;
    for (let i = 0; i < 60 * 60 * 30 && waves.state === 'active'; i++) waves.fixedUpdate(DT);
    expect(waves.state).toBe('intermission');
    expect(last('wave:complete').wave).toBe(1);
  });

  it('never queues unknown types and falls back without spawn points', () => {
    const { waves, enemies, tick } = setup({
      spawnPoints: [],
      isKnownType: (t) => t === 'swarmer',
      randomPoint: (c, r, out) => {
        out.set(c.x + r, c.y, c.z);
        return true;
      },
    });
    waves.setWave(5);
    expect(waves.plan.counts[waves.plan.typeIds.indexOf('tank')]).toBe(0);
    tick(10);
    expect(enemies.spawned.length).toBeGreaterThan(0);
    for (const s of enemies.spawned) {
      expect(s.point).toBeNull();
      expect(Math.hypot(s.position.x, s.position.z)).toBeGreaterThan(SPAWN_POINTS.fallbackRadius - 2);
    }
  });

  it('samples the fallback nav points and keeps one in the distance band', () => {
    let n = 0;
    const { waves, enemies, tick } = setup({
      spawnPoints: [],
      // Alternates between a point next to the player and one at a fair distance.
      randomPoint: (c, _r, out) => {
        const d = n++ % 2 === 0 ? 2 : SPAWN_POINTS.preferredDistance;
        out.set(c.x + d, c.y, c.z);
        return true;
      },
    });
    waves.setWave(1);
    tick(10);
    expect(enemies.spawned.length).toBeGreaterThan(0);
    for (const s of enemies.spawned) {
      expect(Math.hypot(s.position.x, s.position.z)).toBeGreaterThan(
        SPAWN_POINTS.minDistance - M.cadence.spread,
      );
    }
  });

  it('is deterministic for a seed', () => {
    const run = (): string[] => {
      const { waves, enemies, tick } = setup();
      waves.setWave(9);
      tick(40);
      return enemies.spawned.map((s) => `${s.type}@${s.point}:${s.position.x.toFixed(3)}`);
    };
    expect(run()).toEqual(run());
  });
});
