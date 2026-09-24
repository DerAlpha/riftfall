import { describe, expect, it } from 'vitest';
import type { MusicIntensitySource, MusicState, MusicStingId } from '../../defs/music';
import { createMusicCommands, musicStatus, type MusicCommandDeps } from './musicCommands';
import type { MusicStatus } from './MusicSystem';

function fakeMusic() {
  const calls: string[] = [];
  const status: MusicStatus = {
    enabled: true,
    volume: 0.48,
    context: 'running',
    state: 'wave',
    autoState: 'wave',
    forced: null,
    theme: 'lab',
    playing: 'lab',
    route: 'game',
    tempo: 104,
    bar: 12,
    intensity: 0.62,
    source: 'model',
    model: 0.58,
    layers: ['ambient', 'low', 'mid', 'high'],
    voices: 23,
    dropped: 0,
    timer: true,
    hold: false,
    renderedThemes: 2,
    megabytes: 12.5,
    pendingTheme: null,
  };
  const music: MusicCommandDeps['music'] = {
    get status() {
      return status;
    },
    forceState: (s: MusicState | null) => calls.push(`force:${s}`),
    setIntensity: (v: number | null, src?: MusicIntensitySource) => calls.push(`intensity:${v}:${src}`),
    setMapTheme: (id: string) => calls.push(`theme:${id}`),
    sting: (id: MusicStingId) => {
      calls.push(`sting:${id}`);
      return id !== 'nuke';
    },
    setBossTheme: (id: string | null) => calls.push(`boss:${id}`),
  };
  const [cmd] = createMusicCommands({ music });
  return { cmd: cmd!, calls, deps: { music } };
}

describe('music dev commands', () => {
  it('prints the status', () => {
    const { cmd, deps } = fakeMusic();
    const text = String(cmd.run([]));
    expect(text).toBe(musicStatus(deps));
    expect(text).toContain('wave');
    expect(text).toContain('104 BPM');
    expect(text).toContain('ambient low mid high');
  });

  it('forces states and intensity, switches themes, plays stings, drives the boss hook', () => {
    const { cmd, calls } = fakeMusic();
    cmd.run(['state', 'boss']);
    cmd.run(['state', 'auto']);
    cmd.run(['intensity', '0.75']);
    cmd.run(['intensity', 'auto']);
    cmd.run(['theme', 'rift']);
    expect(String(cmd.run(['theme', 'mars']))).toContain('lab');
    cmd.run(['sting', 'waveStart']);
    expect(String(cmd.run(['sting', 'nuke']))).toContain('gedrosselt');
    cmd.run(['boss', 'boss']);
    cmd.run(['boss', 'off']);
    expect(calls).toEqual([
      'force:boss',
      'force:null',
      'intensity:0.75:dev',
      'intensity:null:dev',
      'theme:rift',
      'theme:mars',
      'sting:waveStart',
      'sting:nuke',
      'boss:boss',
      'boss:null',
    ]);
  });

  it('rejects bad arguments and completes sub-commands', () => {
    const { cmd } = fakeMusic();
    expect(() => cmd.run(['state', 'dancing'])).toThrow();
    expect(() => cmd.run(['intensity', '2'])).toThrow();
    expect(() => cmd.run(['intensity'])).toThrow();
    expect(() => cmd.run(['sting', 'fanfare'])).toThrow();
    expect(() => cmd.run(['bogus'])).toThrow();
    expect(cmd.complete?.([''])).toContain('intensity');
    expect(cmd.complete?.(['state', ''])).toContain('gameover');
    expect(cmd.complete?.(['theme', ''])).toContain('orbital');
    expect(cmd.complete?.(['sting', ''])).toContain('bossAppear');
  });
});
