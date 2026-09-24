import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { RUN } from '../defs/waves';
import { createRunCommands, formatClock, runStatus } from './runCommands';
import { RunFlow } from './RunFlow';

describe('run console commands', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('prints the live statistics, kills the player and restarts the run', async () => {
    const events = new EventBus<GameEvents>();
    const flow = new RunFlow({ events, setTimeScale: () => {} });
    const [cmd] = createRunCommands({ run: flow });
    const log: string[] = [];
    for (const t of ['player:died', 'run:over', 'run:restart'] as const) events.on(t, () => log.push(t));
    expect(await cmd!.run(['kill'])).toContain('Kein laufender Lauf');
    flow.begin('lab');
    flow.fixedUpdate(125);
    expect(await cmd!.run([])).toContain('Karte lab');
    expect(runStatus({ run: flow })).toContain('Zeit 2:05');
    expect(await cmd!.run(['kill'])).toBe('Spieler gefallen');
    vi.advanceTimersByTime(RUN.death.gameOverDelay * 1000);
    expect(await cmd!.run(['restart'])).toBe('Lauf neu gestartet');
    expect(log).toEqual(['player:died', 'run:over', 'run:restart']);
    expect(() => cmd!.run(['nope'])).toThrow();
    expect(cmd!.complete!(['r'])).toEqual(['restart']);
    flow.dispose();
  });

  it('formats clocks', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(61.9)).toBe('1:01');
    expect(formatClock(3661)).toBe('1:01:01');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});
