import { describe, expect, it, vi } from 'vitest';
import { WAVES } from '../defs/waves';
import { createWaveCommands, waveStatus, type WaveCommandDeps } from './waveCommands';
import { createWavePlan, planWave } from './waveFormula';

function fakeWaves(state: WaveCommandDeps['waves']['state'] = 'idle') {
  const plan = planWave(WAVES.classic, 5, 64, createWavePlan(WAVES.classic));
  const w = {
    wave: 0,
    state,
    remaining: 0,
    queued: 0,
    nextWave: 1,
    intermissionLeft: 0,
    plan,
    start: vi.fn((n?: number) => {
      w.state = 'intermission';
      w.nextWave = n ?? 1;
    }),
    setWave: vi.fn((n: number) => {
      w.state = 'active';
      w.wave = n;
      w.remaining = plan.total;
    }),
    skipIntermission: vi.fn(() => {
      w.state = 'active';
      w.wave = w.nextWave;
    }),
    stop: vi.fn(() => {
      w.state = 'over';
    }),
  };
  return w;
}

describe('wave console commands', () => {
  it('jumps to a wave, skips the intermission, restarts and stops', async () => {
    const waves = fakeWaves();
    const [cmd] = createWaveCommands({ waves });
    expect(cmd!.name).toBe('wave');
    expect(await cmd!.run(['7'])).toContain('Welle 7');
    expect(waves.setWave).toHaveBeenCalledWith(7);
    expect(await cmd!.run(['skip'])).toBe('Keine Pause aktiv');
    expect(await cmd!.run(['start', '3'])).toContain('Welle 3');
    expect(waves.start).toHaveBeenLastCalledWith(3);
    expect(await cmd!.run(['skip'])).toContain('Welle 3');
    expect(await cmd!.run(['stop'])).toBe('Wellen gestoppt');
    expect(() => cmd!.run(['0'])).toThrow();
    expect(() => cmd!.run(['abc'])).toThrow();
    expect(cmd!.complete!(['s'])).toEqual(['skip', 'start', 'stop']);
  });

  it('describes the state and the current plan', () => {
    const waves = fakeWaves();
    expect(waveStatus({ waves })).toContain('nicht gestartet');
    waves.state = 'intermission';
    waves.nextWave = 2;
    waves.intermissionLeft = 4.25;
    expect(waveStatus({ waves })).toBe('Pause vor Welle 2: noch 4.3 s');
    waves.setWave(5);
    const s = waveStatus({ waves });
    expect(s).toContain('Welle 5 (tank)');
    expect(s).toContain('tank×1');
    expect(s).toContain('max. gleichzeitig');
  });
});
