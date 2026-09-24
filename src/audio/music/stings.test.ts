import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { AUDIO } from '../../defs/audio';
import { MUSIC_STINGS, MUSIC_THEMES, SCALES } from '../../defs/music';
import { AudioEventBridge } from '../AudioEventBridge';
import { NATURAL } from './composer';
import { registerBase, resolveSting } from './stings';
import { mod, scalePitchClasses } from './theory';

describe('stings', () => {
  it('realize in the playing theme: its key, register and tempo', () => {
    const lab = MUSIC_THEMES.lab!;
    const notes = resolveSting(MUSIC_STINGS.waveComplete, lab, 10, 10);
    const beat = 60 / lab.tempo;
    const pcs = scalePitchClasses(lab.key, SCALES[lab.scale]);
    for (const n of notes) {
      expect(n.time).toBeGreaterThanOrEqual(10);
      if (n.note !== NATURAL) expect(pcs).toContain(mod(n.note, 12));
    }
    const arps = notes.filter((n) => n.slot === 'arp');
    [0, 0.5 * beat, beat, 1.5 * beat].forEach((t, i) => expect(arps[i]!.time - 10).toBeCloseTo(t, 9));
    // Open fifth over the tonic: tonic, fifth, octave, ninth of the arp register.
    const base = registerBase(lab.key, 'arp');
    expect(arps.map((n) => n.note - base)).toEqual([0, 7, 12, 14]);
    // The rift plays the same sting octatonically.
    const rift = resolveSting(MUSIC_STINGS.waveComplete, MUSIC_THEMES.rift!, 0, 0);
    const riftPcs = scalePitchClasses(MUSIC_THEMES.rift!.key, SCALES.octatonic);
    for (const n of rift) if (n.note !== NATURAL) expect(riftPcs).toContain(mod(n.note, 12));
  });

  it('transposes, drops pickups before the earliest time and skips slots the theme lacks', () => {
    const lab = MUSIC_THEMES.lab!;
    const plain = resolveSting(MUSIC_STINGS.waveStart, lab, 5, 0);
    const up = resolveSting(MUSIC_STINGS.waveStart, lab, 5, 0, 2);
    plain.forEach((n, i) => {
      if (n.note !== NATURAL) expect(up[i]!.note - n.note).toBe(2);
    });
    // The tom pickups fall before the downbeat: dropped when that is too early.
    expect(plain.filter((n) => n.slot === 'tom')).toHaveLength(2);
    expect(resolveSting(MUSIC_STINGS.waveStart, lab, 5, 5).filter((n) => n.slot === 'tom')).toHaveLength(0);
    // The menu theme has no dist slot.
    expect(resolveSting(MUSIC_STINGS.nuke, MUSIC_THEMES.menu!, 0, 0).some((n) => n.slot === 'dist')).toBe(
      false,
    );
    // Glides (tape stop, falling clusters) keep their multiplier and span beats.
    const pause = resolveSting(MUSIC_STINGS.pause, lab, 0, 0);
    expect(pause.every((n) => n.glide < 1 && n.glideTime > 0)).toBe(true);
  });

  it('the UI stings come from the UI kit, the others from the theme', () => {
    expect(MUSIC_STINGS.levelUp.route).toBe('ui');
    expect(MUSIC_STINGS.achievement.route).toBe('ui');
    expect(MUSIC_STINGS.pause.route).toBe('menu');
    expect(MUSIC_STINGS.gameOver.route).toBe('menu');
    const kit = MUSIC_THEMES.ui!;
    for (const id of ['levelUp', 'achievement'] as const) {
      for (const n of MUSIC_STINGS[id].notes) expect(kit.palette[n.slot]).toBeDefined();
    }
  });

  it('the audio bridge hands its wave / game over stings over to the music system', () => {
    const events = new EventBus<GameEvents>();
    const ids: string[] = [];
    const bridge = new AudioEventBridge(events, {
      play: (id) => ids.push(id),
      startLoop: () => 0,
      stopLoop: () => undefined,
    });
    events.emit('wave:start', { wave: 1, total: 3 });
    expect(ids).toEqual([AUDIO.stings.waveStart.id]);
    bridge.handOverStings();
    ids.length = 0;
    events.emit('wave:start', { wave: 2, total: 3 });
    events.emit('wave:complete', { wave: 2, duration: 10 });
    events.emit('player:died', { position: { x: 0, y: 0, z: 0 } });
    expect(ids).toEqual([]);
    bridge.dispose();
  });
});
