import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { RUN } from '../defs/waves';
import { RunFlow, type RunSummary } from './RunFlow';

const D = RUN.death;

function setup() {
  const events = new EventBus<GameEvents>();
  const scales: number[] = [];
  const cameraDrops: number[] = [];
  const shown: RunSummary[] = [];
  const log: string[] = [];
  for (const type of ['player:died', 'run:over', 'run:restart'] as const)
    events.on(type, () => log.push(type));
  const overs: GameEvents['run:over'][] = [];
  events.on('run:over', (e) => overs.push({ ...e }));
  const flow = new RunFlow({
    events,
    setTimeScale: (s) => scales.push(s),
    onDeathCamera: (d) => cameraDrops.push(d),
    showGameOver: (s) => shown.push(s),
    getPlayerPosition: () => ({ x: 1, y: 2, z: 3 }),
  });
  const health = (h: number): void =>
    events.emit('player:healthChanged', { health: h, maxHealth: 100, armor: 0, maxArmor: 100 });
  return { events, flow, scales, cameraDrops, shown, log, overs, health };
}

describe('RunFlow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('death → slow motion + camera drop → run:over + game over screen after the delay', () => {
    const { events, flow, scales, cameraDrops, shown, log, overs, health } = setup();
    let died: GameEvents['player:died'] | null = null;
    events.on('player:died', (e) => (died = { position: { ...e.position } }));
    flow.begin('lab');
    expect(flow.state).toBe('running');
    expect(scales).toEqual([1]);

    // Some play.
    events.emit('wave:start', { wave: 4, total: 20 });
    events.emit('enemy:died', {
      id: 7,
      type: 'swarmer',
      position: { x: 0, y: 0, z: 0 },
      weaponId: 'rifle',
      zone: 'head',
      elite: false,
      source: 'player',
    });
    flow.fixedUpdate(30);

    health(40);
    expect(flow.state).toBe('running');
    health(0);
    expect(flow.state).toBe('dying');
    expect(log).toEqual(['player:died']);
    expect(died).toEqual({ position: { x: 1, y: 2, z: 3 } });
    expect(scales[scales.length - 1]).toBe(D.slowScale);
    expect(cameraDrops).toEqual([D.cameraDropSeconds]);
    // Health events during the sequence change nothing; stats stop counting.
    health(0);
    flow.fixedUpdate(10);
    expect(log).toEqual(['player:died']);

    // The slow motion eases towards the end scale (real time).
    expect(flow.deathTime).toBe(0);
    for (let i = 0; i < 120; i++) flow.update(1 / 60);
    expect(flow.deathTime).toBeCloseTo(2);
    expect(scales[scales.length - 1]).toBeCloseTo(D.endScale, 2);
    expect(scales.every((s) => s >= D.endScale - 1e-9 && s <= 1)).toBe(true);

    vi.advanceTimersByTime(D.gameOverDelay * 1000 - 10);
    expect(shown.length).toBe(0);
    vi.advanceTimersByTime(20);
    expect(flow.state).toBe('over');
    expect(log).toEqual(['player:died', 'run:over']);
    expect(overs[0]).toMatchObject({ mapId: 'lab', mode: RUN.defaultMode, wave: 4, kills: 1, headshots: 1 });
    expect(overs[0]!.timeSurvived).toBeCloseTo(30);
    expect(overs[0]!.score).toBeGreaterThan(0);
    expect(shown.length).toBe(1);
    expect(shown[0]).toMatchObject({ wave: 4, kills: 1, score: overs[0]!.score, accuracy: 0 });
    expect(flow.summary).toBe(shown[0]);
  });

  it('restart: time scale back to 1, stats reset, run:restart, running again', () => {
    const { flow, scales, log, health, events } = setup();
    flow.begin('testroom', 'classic');
    events.emit('wave:start', { wave: 2, total: 10 });
    health(0);
    vi.advanceTimersByTime(D.gameOverDelay * 1000);
    expect(flow.state).toBe('over');
    flow.restart();
    expect(log).toEqual(['player:died', 'run:over', 'run:restart']);
    expect(flow.state).toBe('running');
    expect(flow.mapId).toBe('testroom');
    expect(scales[scales.length - 1]).toBe(1);
    expect(flow.stats.wave).toBe(0);
    // A second death works the same way.
    health(0);
    vi.advanceTimersByTime(D.gameOverDelay * 1000);
    expect(log.filter((l) => l === 'run:over').length).toBe(2);
  });

  it('reacts to a player:died emitted elsewhere without emitting it again', () => {
    const { events, flow, log } = setup();
    flow.begin('lab');
    events.emit('player:died', { position: { x: 0, y: 0, z: 0 } });
    expect(flow.state).toBe('dying');
    expect(log).toEqual(['player:died']);
    vi.advanceTimersByTime(D.gameOverDelay * 1000);
    expect(log).toEqual(['player:died', 'run:over']);
  });

  it('ignores deaths outside a running run and cancels the sequence on abandon', () => {
    const { flow, log, health, scales, shown } = setup();
    health(0); // idle: start screen / calibration without a run
    expect(flow.state).toBe('idle');
    expect(log).toEqual([]);
    flow.begin('lab');
    flow.kill();
    expect(flow.state).toBe('dying');
    flow.abandon();
    expect(flow.state).toBe('idle');
    expect(scales[scales.length - 1]).toBe(1);
    vi.advanceTimersByTime(D.gameOverDelay * 2000);
    expect(shown.length).toBe(0);
    expect(log).toEqual(['player:died']);
  });

  it('dispose restores the time scale and unsubscribes', () => {
    const { flow, scales, health, log } = setup();
    flow.begin('lab');
    health(0);
    flow.dispose();
    expect(scales[scales.length - 1]).toBe(1);
    vi.advanceTimersByTime(D.gameOverDelay * 2000);
    expect(log).toEqual(['player:died']);
    health(0);
    expect(log).toEqual(['player:died']);
  });
});
