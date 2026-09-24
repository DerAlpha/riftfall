/**
 * Vertical-slice logic loop without rendering: WaveDirector drives the real EnemyManager (enemies
 * package fakes for nav / visuals), enemies hurt the real PlayerHealth through a target adapter,
 * RunFlow turns the death into run:over, RunStats counts, the audio bridge reacts.
 */
import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnemyTargetApi, PlayOptions, SpawnPointDef } from '../core/contracts';
import type { GameEvents, Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { RUN, WAVES } from '../defs/waves';
import { AudioEventBridge, type AudioBridgeTarget } from '../audio/AudioEventBridge';
import { DT, createEnemyHarness } from '../enemies/testFakes';
import { PlayerHealth } from '../player/PlayerHealth';
import { WaveDirector } from '../spawning/WaveDirector';
import { RunFlow } from './RunFlow';
import type { RunSummary } from './RunFlow';

function rift(id: string, x: number, z: number): SpawnPointDef {
  return { id, position: new Vector3(x, 0, z), yaw: 0, zone: 'main', kind: 'rift' };
}

function setup() {
  let health: PlayerHealth | null = null;
  // Game.ts's adapter: the player's pose + PlayerHealth (direction forwarded for the HUD indicator).
  const target: EnemyTargetApi = {
    position: new Vector3(0, 0, 0),
    eyePosition: new Vector3(0, 1.62, 0),
    velocity: new Vector3(),
    get alive() {
      return !(health?.dead ?? false);
    },
    yaw: 0,
    damage: (amount: number, direction?: Vec3Like) => health?.damage(amount, direction) ?? 0,
  };
  const h = createEnemyHarness({ manager: { target } });
  health = new PlayerHealth({ events: h.events });
  const waves = new WaveDirector({
    events: h.events,
    enemies: h.manager,
    spawnPoints: [rift('a', 18, 0), rift('b', -18, 4), rift('c', 0, 20)],
    target,
    camera: null,
    rng: new Rng('run-loop'),
  });
  const shown: RunSummary[] = [];
  const scales: number[] = [];
  const flow = new RunFlow({
    events: h.events,
    setTimeScale: (s) => scales.push(s),
    showGameOver: (s) => shown.push(s),
    getPlayerPosition: () => target.position,
  });
  const plays: { id: string; opts: PlayOptions }[] = [];
  const audio: AudioBridgeTarget = {
    play: (id, opts) => plays.push({ id, opts: { ...opts } }),
    startLoop: () => 1,
    stopLoop: () => {},
  };
  let clock = 0;
  const bridge = new AudioEventBridge(
    h.events,
    audio,
    () => clock,
    () => 0.5,
  );
  bridge.setEnemySource(h.manager);
  const log: (keyof GameEvents)[] = [];
  for (const t of ['wave:start', 'wave:complete', 'player:died', 'run:over'] as const)
    h.events.on(t, () => log.push(t));
  const tick = (): void => {
    clock += DT;
    waves.fixedUpdate(DT);
    h.tick(1);
    health.fixedUpdate(DT);
    flow.fixedUpdate(DT);
    bridge.update(DT, target.eyePosition);
  };
  return { ...h, health: health!, target, waves, flow, shown, scales, plays, bridge, log, tick };
}

describe('run loop (waves → enemies → death → game over)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears a wave, then the enemies of the next one kill the player and the run ends', () => {
    const s = setup();
    s.flow.begin('lab');
    s.waves.start(1);
    // Wave 1: let everything spawn, then kill it (credited to the player).
    let guard = 0;
    while (s.waves.state !== 'active' && guard++ < 60 * 60) s.tick();
    expect(s.waves.wave).toBe(1);
    while (s.waves.queued > 0 && guard++ < 60 * 120) {
      s.tick();
      if (s.manager.alive > 0) s.manager.killAll(true);
    }
    for (let i = 0; i < 5; i++) s.tick();
    expect(s.log).toContain('wave:complete');
    expect(s.flow.stats.kills).toBe(WAVES.classic.total.base);
    expect(s.flow.stats.wavesCompleted).toBe(1);

    // Wave 2: nobody shoots back.
    guard = 0;
    while (s.flow.state === 'running' && guard++ < 60 * 240) s.tick();
    expect(s.flow.state).toBe('dying');
    expect(s.health.dead).toBe(true);
    expect(s.log.filter((l) => l === 'player:died').length).toBe(1);
    expect(s.scales[s.scales.length - 1]).toBe(RUN.death.slowScale);
    // The director freezes with the player dead.
    const queued = s.waves.queued;
    for (let i = 0; i < 120; i++) s.tick();
    expect(s.waves.queued).toBe(queued);

    vi.advanceTimersByTime(RUN.death.gameOverDelay * 1000);
    expect(s.flow.state).toBe('over');
    expect(s.log[s.log.length - 1]).toBe('run:over');
    const summary = s.shown[0]!;
    expect(summary.wave).toBe(2);
    expect(summary.kills).toBe(WAVES.classic.total.base);
    expect(summary.wavesCompleted).toBe(1);
    expect(summary.damageTaken).toBeGreaterThanOrEqual(100);
    expect(summary.score).toBeGreaterThan(0);

    // Audio heard the whole thing: rift tears, attacks, the stings.
    const ids = s.plays.map((p) => p.id);
    expect(ids).toContain('sting.wave.start');
    expect(ids).toContain('sting.wave.complete');
    expect(ids).toContain('sting.gameover');
    expect(ids.some((id) => id === 'rift.tear' || id.endsWith('.spawn'))).toBe(true);
    expect(ids).toContain('enemy.swarmer.bite');

    // Restart: stats reset, the run goes on.
    s.flow.restart();
    s.manager.clear();
    s.health.reset();
    s.waves.reset();
    s.waves.start(1);
    expect(s.flow.state).toBe('running');
    expect(s.flow.stats.kills).toBe(0);
    for (let i = 0; i < 60 * (WAVES.classic.firstIntermission + 1); i++) s.tick();
    expect(s.waves.state).toBe('active');
  });
});
