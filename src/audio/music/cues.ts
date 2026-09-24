/**
 * Positional hint cues (M10): the tell of an elite emerging / noticing the player and the generic
 * boss cue. Mono (HRTF panner input), rendered once offline and registered in the audio engine
 * (registerBuffer), so they play through its voice management on the sfx bus. Distinct from every
 * enemy voice on purpose: a bright metallic "shing" over a b2 horn for elites, a giant low horn
 * cluster with choir for bosses – the player hears what arrives and from where.
 */
import { MUSIC, MUSIC_CUES } from '../../defs/music';
import type { Kit } from '../arsenalKit';
import { renderSample } from './instruments';

interface CueRecipe {
  readonly seconds: number;
  readonly draw: (k: Kit) => void;
}

export const CUE_RECIPES: Readonly<Record<string, CueRecipe>> = {
  [MUSIC_CUES.elite.spawn.id]: {
    seconds: 2.2,
    draw: (k) => {
      // A suction swell into a bright ring and a two-note horn falling a semitone.
      k.swell(0, {
        color: 'white',
        filter: 'bandpass',
        freq: 700,
        q: 3,
        sweepTo: 3600,
        attack: 0.45,
        hold: 0.45,
        release: 0.05,
        peak: 0.35,
        expRise: true,
      });
      const at = 0.46;
      k.ring(at, 1850, [1, 1.51, 2.24, 2.97], 1.3, 0.5);
      k.click(at, 5200, 0.004, 0.5);
      const horn = k.bus({ drive: 1.6, lowpass: 1500 });
      horn.note(at, 'sawtooth', 110, 110, 0.03, 0.25, 0.25, 0.4);
      horn.note(at + 0.3, 'sawtooth', 116.54, 110, 0.03, 0.45, 0.6, 0.45);
      k.thump(at, { f0: 90, f1: 42, pitchTime: 0.1, decay: 0.5, peak: 0.6 });
    },
  },
  [MUSIC_CUES.elite.alert.id]: {
    seconds: 1.2,
    draw: (k) => {
      // A sharp warning chime with a rattling tail.
      k.ring(0, 2400, [1, 1.34, 1.87, 2.51], 0.7, 0.55);
      k.ring(0.09, 2400 * 1.06, [1, 1.34, 1.87], 0.5, 0.35);
      k.click(0, 6000, 0.003, 0.5);
      k.ticks(0.02, 8, 0.3, 3800, 5, 0.2);
      k.thump(0, { f0: 140, f1: 70, pitchTime: 0.05, decay: 0.2, peak: 0.35 });
    },
  },
  [MUSIC_CUES.boss.id]: {
    seconds: 4,
    draw: (k) => {
      // A giant horn cluster (root, b2, fifth) swelling open and closed, a choir, the sub.
      const horn = k.bus({ drive: 1.4, lowpass: 2200 });
      for (const [f, peak] of [
        [55, 0.4],
        [58.27, 0.3],
        [82.41, 0.28],
        [110, 0.22],
      ] as const) {
        horn.note(0.1, 'sawtooth', f, f * 0.985, 0.5, 1.6, 1.2, peak, {
          lowpass: 900,
          vibrato: { rate: 4.2, depth: f * 0.004 },
        });
      }
      k.choir(0.2, [110, 116.54, 164.81], 0.6, 1.4, 1.2, 0.45);
      k.thump(0.1, { f0: 60, f1: 30, pitchTime: 0.5, decay: 1.6, peak: 0.8, drive: 1 });
      k.ring(0.1, 73.4, [1, 2.02, 2.74, 4.1], 2.6, 0.2);
      k.noise(0.1, { color: 'brown', filter: 'lowpass', freq: 240, decay: 1.4, peak: 0.5 });
    },
  },
};

/** Render every cue (mono one-shots); ids that fail are left out. */
export async function renderCues(): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  for (const [id, recipe] of Object.entries(CUE_RECIPES)) {
    const buf = await renderSample({
      channels: 1,
      rate: MUSIC.render.sampleRate,
      seconds: recipe.seconds,
      mode: 'oneshot',
      seed: `${MUSIC.seed}:cue:${id}`,
      draw: recipe.draw,
    });
    if (buf) out.set(id, buf);
  }
  return out;
}
