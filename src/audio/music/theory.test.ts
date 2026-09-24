import { describe, expect, it } from 'vitest';
import { Rng } from '../../core/Rng';
import { SCALES } from '../../defs/music';
import {
  chordDegrees,
  chordPitchClasses,
  degreeNote,
  euclid,
  generateMotif,
  midiHz,
  mod,
  nearestChordDegree,
  scalePitchClasses,
  voiceLead,
} from './theory';

const D2 = 38;

describe('music theory', () => {
  it('maps scale degrees across octaves', () => {
    const aeolian = SCALES.aeolian;
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => degreeNote(D2, aeolian, d))).toEqual([
      38, 40, 41, 43, 45, 46, 48, 50,
    ]);
    expect(degreeNote(D2, aeolian, -1)).toBe(36);
    expect(degreeNote(D2, aeolian, 14)).toBe(62);
    expect(midiHz(69)).toBeCloseTo(440);
    expect(midiHz(57)).toBeCloseTo(220);
  });

  it('stacks diatonic chords per colour', () => {
    // D minor: i = D F A, iv = G Bb D, VI = Bb D F, v = A C E.
    expect(chordPitchClasses(D2, SCALES.aeolian, 0, 'triad')).toEqual([2, 5, 9]);
    expect(chordPitchClasses(D2, SCALES.aeolian, 3, 'triad')).toEqual([7, 10, 2]);
    expect(chordPitchClasses(D2, SCALES.aeolian, 5, 'triad')).toEqual([10, 2, 5]);
    expect(chordPitchClasses(D2, SCALES.aeolian, 0, 'power')).toEqual([2, 9]);
    expect(chordPitchClasses(D2, SCALES.aeolian, 0, 'sus2')).toEqual([2, 4, 9]);
    expect(chordDegrees(1, 'seventh')).toEqual([1, 3, 5, 7]);
    // Harmonic minor has a major dominant (the leading tone).
    expect(chordPitchClasses(37, SCALES.harmonicMinor, 4, 'triad')).toEqual([8, 0, 3]);
    // Octatonic thirds stack to diminished seventh chords.
    const dim7 = chordPitchClasses(44, SCALES.octatonic, 0, 'seventh');
    const intervals = dim7.map((pc, i) => mod(dim7[(i + 1) % 4]! - pc, 12));
    expect(intervals).toEqual([3, 3, 3, 3]);
  });

  it('voice-leads with minimal motion, keeps common tones and covers every chord tone', () => {
    // C major (C4 E4 G4) → A minor: C and E stay, G moves up a step to A.
    expect(voiceLead([60, 64, 67], [9, 0, 4], 55, 79, 3)).toEqual([60, 64, 69]);
    // C major → F major: C stays, E → F, G → A.
    expect(voiceLead([60, 64, 67], [5, 9, 0], 55, 79, 3)).toEqual([60, 65, 69]);
    const pcs = chordPitchClasses(D2, SCALES.aeolian, 0, 'triad');
    let prev: number[] | null = null;
    for (const root of [0, 3, 5, 4, 0]) {
      const next = voiceLead(prev, chordPitchClasses(D2, SCALES.aeolian, root, 'triad'), 50, 74, 4);
      expect(next).toHaveLength(4);
      for (const m of next) expect(m >= 50 && m <= 74).toBe(true);
      const chord = chordPitchClasses(D2, SCALES.aeolian, root, 'triad');
      for (const pc of chord) expect(next.some((m) => mod(m, 12) === pc)).toBe(true);
      if (prev) {
        const motion = next.reduce((sum, m, i) => sum + Math.abs(m - prev![i]!), 0);
        expect(motion).toBeLessThanOrEqual(8);
      }
      prev = next;
    }
    // Four voices over a triad double the root, not the third.
    const v = voiceLead(null, pcs, 50, 74, 4);
    const counts = new Map<number, number>();
    for (const m of v) counts.set(mod(m, 12), (counts.get(mod(m, 12)) ?? 0) + 1);
    expect(counts.get(2)).toBe(2);
    expect(counts.get(5)).toBe(1);
  });

  it('builds Euclidean rhythms (tresillo, cinquillo) with exactly k onsets', () => {
    const str = (p: boolean[]) => p.map((x) => (x ? 'x' : '.')).join('');
    expect(str(euclid(3, 8))).toBe('x..x..x.');
    expect(str(euclid(5, 8))).toBe('x.xx.xx.');
    for (const [k, n] of [
      [3, 16],
      [5, 16],
      [7, 12],
      [4, 4],
      [0, 8],
    ] as const) {
      expect(euclid(k, n).filter(Boolean)).toHaveLength(k);
      expect(euclid(k, n, 3).filter(Boolean)).toHaveLength(k);
    }
  });

  it('snaps to chord tones in the direction of motion and avoids repeating the previous note', () => {
    const triad = [0, 2, 4];
    expect(nearestChordDegree(1, triad, 7, 1)).toBe(2);
    expect(nearestChordDegree(1, triad, 7, -1)).toBe(0);
    expect(nearestChordDegree(3, triad, 7, 1, 4)).toBe(2);
    expect(nearestChordDegree(7, triad, 7)).toBe(7);
  });

  it('generates deterministic, singable motifs that land on chord tones', () => {
    const opts = {
      steps: 32,
      beatSteps: 4,
      chordAt: (s: number) => (s < 16 ? [0, 2, 4] : [3, 5, 7]),
      scaleLength: 7,
      low: 14,
      high: 24,
      cells: [
        [4, 4, 8],
        [2, 2, 4, 8],
        [6, 2, 8],
      ],
      leapChance: 0.28,
    };
    const a = generateMotif(new Rng('motif-test'), opts);
    const b = generateMotif(new Rng('motif-test'), opts);
    expect(a).toEqual(b);
    expect(a.reduce((s, n) => s + n.dur, 0)).toBe(32);
    let steps = 0;
    for (let k = 0; k < a.length; k++) {
      const n = a[k]!;
      expect(n.degree >= opts.low && n.degree <= opts.high).toBe(true);
      if (n.step % 4 === 0 || k === a.length - 1) {
        expect(opts.chordAt(n.step).map((d) => mod(d, 7))).toContain(mod(n.degree, 7));
      }
      if (k > 0 && Math.abs(n.degree - a[k - 1]!.degree) <= 2) steps++;
    }
    // Mostly steps and small skips, not random leaps.
    expect(steps / Math.max(1, a.length - 1)).toBeGreaterThanOrEqual(0.5);
    // Another seed, another motif.
    expect(generateMotif(new Rng('other'), opts)).not.toEqual(a);
    expect(scalePitchClasses(D2, SCALES.aeolian)).toEqual([2, 4, 5, 7, 9, 10, 0]);
  });
});
