/**
 * Music theory helpers (pure, no Web Audio): scale degrees, diatonic chords, voice leading,
 * Euclidean rhythms and a rule-based motif generator. The composer builds every pattern from
 * these, so the procedural music stays in key, moves smoothly and phrases like a melody.
 */
import type { Rng } from '../../core/Rng';
import type { ChordColor } from '../../defs/music';

/** Equal-tempered frequency of a MIDI note. */
export function midiHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** ((a % m) + m) % m */
export function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/**
 * MIDI note of scale `degree` above `tonic` (degrees beyond the scale continue in the next
 * octave, negative ones go below).
 */
export function degreeNote(tonic: number, scale: readonly number[], degree: number): number {
  const len = scale.length;
  const octave = Math.floor(degree / len);
  return tonic + octave * 12 + scale[mod(degree, len)]!;
}

/** Pitch classes (0..11, relative to C) of a scale on `tonic`. */
export function scalePitchClasses(tonic: number, scale: readonly number[]): number[] {
  return scale.map((s) => mod(tonic + s, 12));
}

/**
 * Scale degrees (relative to the tonic) stacked on `root` for a chord colour: thirds within the
 * scale (triad, seventh), a suspended second, an added ninth or a bare fifth (power chord).
 */
export function chordDegrees(root: number, color: ChordColor): number[] {
  switch (color) {
    case 'seventh':
      return [root, root + 2, root + 4, root + 6];
    case 'sus2':
      return [root, root + 1, root + 4];
    case 'add9':
      return [root, root + 2, root + 4, root + 8];
    case 'power':
      return [root, root + 4];
    case 'triad':
    default:
      return [root, root + 2, root + 4];
  }
}

/** Chord pitch classes (0..11) of degree `root` in the scale on `tonic`. */
export function chordPitchClasses(
  tonic: number,
  scale: readonly number[],
  root: number,
  color: ChordColor,
): number[] {
  const out: number[] = [];
  for (const d of chordDegrees(root, color)) {
    const pc = mod(degreeNote(tonic, scale, d), 12);
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

/** Every MIDI note in [low, high] whose pitch class is in `pcs`, ascending. */
export function notesInRange(pcs: readonly number[], low: number, high: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) if (pcs.includes(mod(m, 12))) out.push(m);
  return out;
}

/** Low register: intervals closer than this (semitones) below `MUDDY_BELOW` sound muddy. */
const MUDDY_INTERVAL = 5;
const MUDDY_BELOW = 55;
const MUDDY_PENALTY = 6;
/** Doubling a chord tone other than the root (voice-leading cost in semitones). */
const DOUBLING_PENALTY = 2.5;
/** Candidates considered per voicing search (keeps the combination count small). */
const MAX_CANDIDATES = 14;

/**
 * Voice leading: the voicing (`voices` notes in [low, high], ascending, every chord tone present
 * when there are enough voices) that moves least from `prev` – common tones stay, the others move
 * by the smallest steps. Without `prev` the voicing centres on `center`. Muddy close intervals in
 * the low register are penalized. Deterministic (ties: the lower voicing).
 */
export function voiceLead(
  prev: readonly number[] | null,
  pcs: readonly number[],
  low: number,
  high: number,
  voices: number,
  center = (low + high) / 2,
): number[] {
  // pcs[0] is the chord root: doubling it is fine, doubling the others (the third) is avoided.
  const root = pcs[0];
  let cand = notesInRange(pcs, low, high);
  if (cand.length === 0) return [];
  const k = Math.max(1, Math.min(voices, cand.length));
  if (cand.length > MAX_CANDIDATES) {
    // Keep the candidates nearest the previous voicing / centre.
    const ref = prev && prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : center;
    cand = [...cand]
      .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b)
      .slice(0, MAX_CANDIDATES)
      .sort((a, b) => a - b);
  }
  const needAll = k >= pcs.length;
  let best: number[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  const pick: number[] = [];
  const score = (): void => {
    if (needAll) {
      for (const pc of pcs) if (!pick.some((m) => mod(m, 12) === pc)) return;
    }
    let cost = 0;
    if (prev && prev.length === pick.length) {
      for (let v = 0; v < pick.length; v++) cost += Math.abs(pick[v]! - prev[v]!);
    } else if (prev && prev.length > 0) {
      for (const m of pick) cost += Math.min(...prev.map((p) => Math.abs(p - m)));
    } else {
      const mean = pick.reduce((a, b) => a + b, 0) / pick.length;
      cost += Math.abs(mean - center) * 2;
    }
    for (let v = 1; v < pick.length; v++) {
      if (pick[v - 1]! < MUDDY_BELOW && pick[v]! - pick[v - 1]! < MUDDY_INTERVAL) cost += MUDDY_PENALTY;
    }
    for (let v = 0; v < pick.length; v++) {
      const pc = mod(pick[v]!, 12);
      if (pc === root) continue;
      for (let w = v + 1; w < pick.length; w++) if (mod(pick[w]!, 12) === pc) cost += DOUBLING_PENALTY;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = [...pick];
    }
  };
  const walk = (from: number): void => {
    if (pick.length === k) {
      score();
      return;
    }
    for (let c = from; c <= cand.length - (k - pick.length); c++) {
      pick.push(cand[c]!);
      walk(c + 1);
      pick.pop();
    }
  };
  walk(0);
  return best ?? cand.slice(0, k);
}

/**
 * Euclidean rhythm: `k` onsets spread as evenly as possible over `n` steps (Bresenham form of
 * Bjorklund's algorithm), rotated by `rotate` steps. euclid(3, 8) = the tresillo x..x..x.
 */
export function euclid(k: number, n: number, rotate = 0): boolean[] {
  const out = new Array<boolean>(Math.max(0, n)).fill(false);
  if (n <= 0 || k <= 0) return out;
  const kk = Math.min(k, n);
  for (let i = 0; i < n; i++) out[mod(i + rotate, n)] = (i * kk) % n < kk;
  return out;
}

export interface MotifNote {
  /** Step offset from the motif start (16ths). */
  readonly step: number;
  readonly dur: number;
  /** Scale degree relative to the tonic. */
  readonly degree: number;
}

export interface MotifOptions {
  /** Total length in steps. */
  readonly steps: number;
  /** Steps per felt beat (strong beats land on chord tones). */
  readonly beatSteps: number;
  /** Chord (scale degrees, any octave) sounding at a step. */
  readonly chordAt: (step: number) => readonly number[];
  /** Scale length (degrees per octave). */
  readonly scaleLength: number;
  /** Allowed degree range. */
  readonly low: number;
  readonly high: number;
  /** Rhythm cells (step durations) to draw from; the last note is held to the end. */
  readonly cells: readonly (readonly number[])[];
  /** Share of leaps (vs. steps) between notes. */
  readonly leapChance: number;
}

/**
 * Nearest degree to `d` whose pitch class (mod scaleLength) is in `chord`; ties go in direction
 * `prefer` (+1 up, −1 down) and `avoid` (e.g. the previous note) is only taken when nothing else
 * is within reach.
 */
export function nearestChordDegree(
  d: number,
  chord: readonly number[],
  scaleLength: number,
  prefer = -1,
  avoid: number | null = null,
): number {
  let best = d;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let o = -scaleLength; o <= scaleLength; o++) {
    const c = d + o;
    const pc = mod(c, scaleLength);
    if (!chord.some((x) => mod(x, scaleLength) === pc)) continue;
    const dist = Math.abs(o) + (Math.sign(o) === -Math.sign(prefer) ? 0.01 : 0) + (c === avoid ? 1.5 : 0);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * A melodic motif by common-practice rules: rhythm from cells, an arch contour, mostly stepwise
 * motion, a leap is recovered by a step the other way, strong beats (and the last note) sit on
 * chord tones, and the line stays in range. Deterministic for a given rng state.
 */
export function generateMotif(rng: Rng, o: MotifOptions): MotifNote[] {
  // Rhythm.
  const durs: number[] = [];
  let filled = 0;
  let guard = 0;
  while (filled < o.steps && guard++ < 64) {
    const cell = rng.pick(o.cells);
    for (const d of cell) {
      if (filled >= o.steps) break;
      const dur = Math.min(d, o.steps - filled);
      durs.push(dur);
      filled += dur;
    }
  }
  // Pitches.
  const notes: MotifNote[] = [];
  const mid = Math.round((o.low + o.high) / 2);
  let degree = nearestChordDegree(mid - 2 + rng.int(0, 2), o.chordAt(0), o.scaleLength);
  let lastLeap = 0;
  let step = 0;
  for (let n = 0; n < durs.length; n++) {
    if (n > 0) {
      // Arch: rise over the first ~60 %, fall afterwards.
      const rising = step < o.steps * 0.6;
      let dir = rng.chance(0.72) === rising ? 1 : -1;
      let size = 1;
      if (lastLeap !== 0) {
        dir = -Math.sign(lastLeap);
        lastLeap = 0;
      } else if (rng.chance(o.leapChance)) {
        size = rng.int(2, 4);
        lastLeap = dir * size;
      }
      degree += dir * size;
      if (degree > o.high) degree -= 2 * size;
      if (degree < o.low) degree += 2 * size;
      degree = Math.max(o.low, Math.min(o.high, degree));
    }
    const strong = step % o.beatSteps === 0 || n === durs.length - 1;
    if (strong) {
      // Snap onto a chord tone in the direction of motion, not back onto the previous note.
      const prev = n > 0 ? notes[n - 1]!.degree : null;
      const dir = prev === null ? -1 : degree >= prev ? 1 : -1;
      const snapped = nearestChordDegree(degree, o.chordAt(step), o.scaleLength, dir, prev);
      if (snapped >= o.low && snapped <= o.high) degree = snapped;
    }
    notes.push({ step, dur: durs[n]!, degree });
    step += durs[n]!;
  }
  return notes;
}
