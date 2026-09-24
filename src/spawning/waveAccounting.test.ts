/**
 * WaveDirector against the real EnemyManager (enemies package fakes for nav / visuals): the
 * director's `remaining` / maxAlive accounting when enemies disappear or appear behind its back
 * (dev console `enemy kill` / `enemy clear` / `enemy spawn`, leash relocation).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SpawnPointDef } from '../core/contracts';
import { Rng } from '../core/Rng';
import { WAVES } from '../defs/waves';
import { DT, createEnemyHarness } from '../enemies/testFakes';
import { WaveDirector } from './WaveDirector';

function rift(id: string, x: number, z: number): SpawnPointDef {
  return { id, position: new Vector3(x, 0, z), yaw: 0, zone: 'main', kind: 'rift' };
}

function setup() {
  const h = createEnemyHarness();
  // FakePlayer has 100 000 HP: it never dies in these runs.
  const waves = new WaveDirector({
    events: h.events,
    enemies: h.manager,
    spawnPoints: [rift('a', 20, 0), rift('b', -20, 4), rift('c', 0, 22)],
    target: h.player,
    camera: null,
    rng: new Rng('wave-accounting'),
  });
  const log: string[] = [];
  h.events.on('wave:start', (e) => log.push(`start:${e.wave}`));
  h.events.on('wave:complete', (e) => log.push(`complete:${e.wave}`));
  let maxAliveSeen = 0;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      waves.fixedUpdate(DT);
      h.tick(1);
      maxAliveSeen = Math.max(maxAliveSeen, h.manager.alive);
    }
  };
  return { ...h, waves, log, tick, maxAlive: () => maxAliveSeen };
}

describe('WaveDirector accounting with the real EnemyManager', () => {
  it('keeps remaining = queued + alive through console kills and clears; completes exactly once', () => {
    const s = setup();
    s.waves.setWave(4);
    const total = s.waves.remaining;
    expect(total).toBe(s.waves.plan.total);
    // Let a few bursts out.
    let guard = 0;
    while (s.manager.alive < 4 && guard++ < 60 * 30) s.tick();
    expect(s.manager.alive).toBeGreaterThanOrEqual(4);
    // `enemy kill` (nuke with credit): remaining drops by the killed ones at once.
    expect(s.manager.killAll(true)).toBeGreaterThan(0);
    expect(s.waves.remaining).toBe(s.waves.queued);
    // More out, then `enemy clear` (no death events).
    guard = 0;
    while (s.manager.alive < 3 && s.waves.queued > 0 && guard++ < 60 * 30) s.tick();
    s.manager.clear();
    expect(s.waves.remaining).toBe(s.waves.queued);
    // Drain the queue, killing everything that emerges.
    guard = 0;
    while (s.waves.state === 'active' && guard++ < 60 * 300) {
      s.tick();
      if (s.manager.alive > 0) s.manager.killAll(true);
    }
    expect(s.waves.state).toBe('intermission');
    expect(s.log.filter((l) => l === 'complete:4').length).toBe(1);
    for (let i = 0; i < 60; i++) s.tick();
    expect(s.log.filter((l) => l.startsWith('complete')).length).toBe(1);
  });

  it('counts console spawns: never above maxAlive, the wave waits for them', () => {
    const s = setup();
    s.waves.start(1);
    expect(s.waves.state).toBe('intermission');
    // `enemy spawn swarmer 5` during the intermission.
    for (let i = 0; i < 5; i++) s.manager.spawn('swarmer', { x: 30 + i, y: 0, z: 30 });
    s.waves.skipIntermission();
    const plan = s.waves.plan;
    expect(s.waves.remaining).toBe(plan.total + 5);
    let guard = 0;
    while (s.waves.queued > 0 && guard++ < 60 * 300) {
      s.tick();
      // Keep the console five alive, kill only director spawns beyond them.
      if (s.manager.alive > plan.maxAlive - 1) s.manager.killAll(true);
    }
    expect(s.maxAlive()).toBeLessThanOrEqual(plan.maxAlive);
    // Queue drained but enemies alive: no completion yet.
    for (let i = 0; i < 30; i++) s.tick();
    if (s.manager.alive > 0) expect(s.waves.state).toBe('active');
    s.manager.killAll(true);
    s.tick(2);
    expect(s.waves.state).toBe('intermission');
    expect(s.log).toEqual(['start:1', 'complete:1']);
  });

  it('keeps counting leashed / relocated enemies as alive (they re-emerge, the wave waits)', () => {
    const s = setup();
    s.waves.setWave(1);
    let guard = 0;
    while (s.waves.queued > 0 && guard++ < 60 * 120) s.tick();
    const alive = s.manager.alive;
    expect(alive).toBe(WAVES.classic.total.base);
    // Run far away: the leash relocates them to the spawn points near the player.
    s.player.position.set(400, 0, 400);
    s.player.eyePosition.set(400, 1.6, 400);
    s.tick(60 * 20);
    expect(s.manager.stats.relocations).toBeGreaterThan(0);
    expect(s.manager.alive).toBe(alive);
    expect(s.waves.remaining).toBe(alive);
    expect(s.waves.state).toBe('active');
  });
});
