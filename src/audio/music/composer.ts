/**
 * Procedural composer (pure): a theme def → seeded phrases of note events per layer, in the
 * theme's key and meter. Built on real harmony: a diatonic chord progression per phrase (picked
 * from the theme's candidates), voice-led pad / string / stab voicings, bass lines on the chord
 * roots with approach notes into chord changes, arpeggios over the chord tones, a rule-based lead
 * motif (stated, re-harmonized, answered, cadenced), drum grooves per style from backbeats and
 * Euclidean rhythms, and textures placed by the seeded rng.
 *
 * Every event carries a `tier`: the (absolute) intensity from which it plays – on top of its layer
 * being on – so a layer grows denser with intensity (ghost hats, 16th fills, the lead) instead of
 * switching as a block. Same theme → same music, every session (MUSIC.seed).
 */
import { Rng } from '../../core/Rng';
import {
  MUSIC,
  MUSIC_LAYERS,
  MUSIC_THEMES,
  SCALES,
  type DrumStyle,
  type InstrumentSlot,
  type MusicLayer,
  type MusicThemeDef,
} from '../../defs/music';
import {
  chordDegrees,
  chordPitchClasses,
  degreeNote,
  euclid,
  generateMotif,
  mod,
  nearestChordDegree,
  voiceLead,
  type MotifNote,
} from './theory';

/** Note value of unpitched slots: 60 = the sample's own pitch (other values transpose, e.g. toms). */
export const NATURAL = 60;

export interface NoteEvent {
  /** Step (16th) inside its bar. */
  readonly step: number;
  /** Index into MUSIC_LAYERS. */
  readonly layer: number;
  readonly slot: InstrumentSlot;
  /** MIDI note (pitched slots) or a transposition around NATURAL (percussion). */
  readonly note: number;
  /** Length in steps (gate of sustained voices, cut of mono one-shots). */
  readonly dur: number;
  readonly vel: number;
  /** Plays from this intensity on. */
  readonly tier: number;
}

/** A sustained event from an earlier bar still sounding at a bar line (re-struck when a layer comes in). */
export interface HoldRef {
  readonly event: NoteEvent;
  /** Steps it has already sounded at this bar's start. */
  readonly elapsed: number;
}

export interface ComposedBar {
  readonly steps: number;
  /** Chord (scale degrees) of this bar. */
  readonly chord: readonly number[];
  /** Sorted by step. */
  readonly events: readonly NoteEvent[];
  readonly holds: readonly HoldRef[];
}

export interface ComposedPhrase {
  readonly bars: readonly ComposedBar[];
  /** Progression (scale degrees, one per chord span). */
  readonly progression: readonly number[];
}

export interface ComposedTheme {
  readonly def: MusicThemeDef;
  readonly phrases: readonly ComposedPhrase[];
  /** Phrase play order (indices into `phrases`), looped. */
  readonly order: readonly number[];
  readonly tonic: number;
  readonly scale: readonly number[];
  /** Seconds per step (16th). */
  readonly stepDur: number;
}

export const LAYER_INDEX: Readonly<Record<MusicLayer, number>> = {
  ambient: 0,
  low: 1,
  mid: 2,
  high: 3,
  peak: 4,
};

/** Slots whose notes sustain (live envelopes, re-struck from holds). */
export const HELD_SLOTS: ReadonlySet<InstrumentSlot> = new Set<InstrumentSlot>([
  'drone',
  'pad',
  'strings',
  'sub',
  'choir',
]);

/** Slots that play one note at a time (a new note cuts the previous one – drums choke like a drum machine). */
export const MONO_SLOTS: ReadonlySet<InstrumentSlot> = new Set<InstrumentSlot>([
  'bass',
  'lead',
  'sub',
  'kick',
  'snare',
]);

/** Resolve a map id to its theme (unknown maps: MUSIC.fallbackTheme). */
export function themeIdForMap(mapId: string | null | undefined): string {
  if (mapId && Object.prototype.hasOwnProperty.call(MUSIC.mapThemes, mapId)) return MUSIC.mapThemes[mapId]!;
  return MUSIC.fallbackTheme;
}

/** Theme def by id (unknown ids: the fallback theme). */
export function getThemeDef(id: string): MusicThemeDef {
  return MUSIC_THEMES[id] ?? MUSIC_THEMES[MUSIC.fallbackTheme]!;
}

/** Theme of a boss enemy type (M6: MUSIC.bossThemes, else the generic boss theme). */
export function bossThemeFor(type: string | null): string {
  if (type && Object.prototype.hasOwnProperty.call(MUSIC.bossThemes, type)) return MUSIC.bossThemes[type]!;
  return MUSIC.bossTheme;
}

export function stepDuration(def: MusicThemeDef): number {
  return 60 / def.tempo / 4;
}

export function rangeOf(slot: string): readonly [number, number] {
  return MUSIC.ranges[slot] ?? [48, 72];
}

/** Shift `note` by octaves into [center − 6, center + 5]. */
export function foldAround(note: number, center: number): number {
  let n = note;
  while (n < center - 6) n += 12;
  while (n > center + 5) n -= 12;
  return n;
}

/** The drone's pedal note: the tonic in the drone register (the only note the drone plays). */
export function droneNoteFor(def: MusicThemeDef): number {
  return foldAround(def.key, Math.max(rangeOf('drone')[0] + 6, def.key));
}

// ---------------------------------------------------------------------------
// Event builder
// ---------------------------------------------------------------------------

class BarBuilder {
  readonly events: NoteEvent[] = [];
  constructor(readonly steps: number) {}

  add(
    layer: MusicLayer,
    slot: InstrumentSlot,
    step: number,
    note: number,
    dur: number,
    vel: number,
    tier: number,
  ): void {
    if (step < 0 || step >= this.steps || !(dur > 0)) return;
    this.events.push({
      step,
      layer: LAYER_INDEX[layer],
      slot,
      note,
      dur,
      vel: Math.max(0.05, Math.min(1, vel)),
      tier,
    });
  }

  /** Remove events of `slot` at `step` (an approach note replaces the pulse there). */
  remove(slot: InstrumentSlot, step: number): void {
    for (let e = this.events.length - 1; e >= 0; e--) {
      if (this.events[e]!.slot === slot && this.events[e]!.step === step) this.events.splice(e, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

interface DrumContext {
  readonly b: BarBuilder;
  readonly n: number;
  readonly beat: number;
  readonly bar: number;
  readonly bars: number;
  readonly rng: Rng;
}

/** Eighth-note groups (in steps) of an odd bar: 2+2+3 (7/8), 2+3, 2+2+2+3 (9/8) … */
export function oddGroups(steps: number): number[] {
  const eighths = Math.max(1, Math.round(steps / 2));
  const groups: number[] = [];
  let left = eighths;
  while (left > 0) {
    if (left === 3 || left === 1) {
      groups.push(left);
      left = 0;
    } else {
      groups.push(2);
      left -= 2;
    }
  }
  return groups.map((g) => g * 2);
}

function hats(c: DrumContext, baseTier: number, fillTier: number, every = 2): void {
  for (let s = 0; s < c.n; s++) {
    if (s % every === 0) c.b.add('mid', 'hat', s, NATURAL, 1, s % c.beat === 0 ? 0.6 : 0.42, baseTier);
    else if (fillTier < 1) c.b.add('mid', 'hat', s, NATURAL, 1, 0.26, fillTier);
  }
}

function euclidHits(
  c: DrumContext,
  layer: MusicLayer,
  slot: InstrumentSlot,
  k: number,
  vel: number,
  tier: number,
  notes: readonly number[] = [NATURAL],
): void {
  const pattern = euclid(k, c.n, c.rng.int(0, c.n - 1));
  let idx = 0;
  for (let s = 0; s < c.n; s++) {
    if (!pattern[s]) continue;
    c.b.add(layer, slot, s, notes[idx++ % notes.length]!, 1, vel * (0.85 + c.rng.next() * 0.3), tier);
  }
}

function drumBar(style: DrumStyle, c: DrumContext): void {
  const { b, n, beat } = c;
  const last = c.bar === c.bars - 1;
  const half = Math.floor(n / 2);
  switch (style) {
    case 'industrial':
      b.add('mid', 'kick', 0, NATURAL, 1, 0.95, 0);
      b.add('mid', 'kick', half, NATURAL, 1, 0.85, 0);
      b.add('mid', 'kick', half + 2, NATURAL, 1, 0.6, 0.55);
      b.add('mid', 'kick', half - 2, NATURAL, 1, 0.55, 0.72);
      for (let s = beat; s < n; s += beat * 2) b.add('mid', 'snare', s, NATURAL, 1, 0.8, 0.18);
      hats(c, 0, 0.6);
      euclidHits(c, 'mid', 'metal', 3, 0.5, 0.3);
      euclidHits(c, 'mid', 'perc', 2, 0.45, 0.48);
      b.add('peak', 'kick', n - 1, NATURAL, 1, 0.6, 0.85);
      b.add('peak', 'kick', half - 1, NATURAL, 1, 0.55, 0.9);
      for (let s = 2; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.45, 0.82);
      break;
    case 'heavy':
      for (let s = 0; s < n; s += beat) b.add('mid', 'kick', s, NATURAL, 1, 0.95, 0);
      for (let s = 2; s < n; s += beat) b.add('mid', 'kick', s, NATURAL, 1, 0.65, 0.5);
      for (let s = beat; s < n; s += beat * 2) b.add('mid', 'snare', s, NATURAL, 1, 0.9, 0.08);
      hats(c, 0.2, 0.3, 2);
      euclidHits(c, 'mid', 'metal', 5, 0.55, 0.34);
      for (let s = 3; s < n; s += beat) b.add('peak', 'kick', s, NATURAL, 1, 0.6, 0.85);
      for (let s = 2; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.5, 0.8);
      b.add('peak', 'snare', n - 2, NATURAL, 1, 0.6, 0.92);
      break;
    case 'tribal': {
      const tresillo = euclid(3, 8);
      for (let s = 0; s < n; s++) if (tresillo[s % 8]) b.add('mid', 'kick', s, NATURAL, 1, 0.9, 0);
      euclidHits(c, 'mid', 'tom', 5, 0.7, 0.14, [NATURAL, NATURAL - 5, NATURAL - 8, NATURAL + 3]);
      for (let s = 0; s < n; s++)
        b.add('mid', 'hat', s, NATURAL, 1, s % 2 === 0 ? 0.5 : 0.28, s % 2 === 0 ? 0.2 : 0.55);
      for (let s = beat; s < n; s += beat * 2) b.add('mid', 'snare', s, NATURAL, 1, 0.6, 0.45);
      euclidHits(c, 'mid', 'metal', 3, 0.5, 0.3, [NATURAL, NATURAL + 7, NATURAL + 5]);
      euclidHits(c, 'peak', 'tom', 7, 0.75, 0.82, [NATURAL - 5, NATURAL - 8, NATURAL - 12]);
      b.add('peak', 'kick', n - 2, NATURAL, 1, 0.7, 0.85);
      b.add('peak', 'kick', half + 2, NATURAL, 1, 0.65, 0.88);
      break;
    }
    case 'sparse':
      b.add('mid', 'kick', 0, NATURAL, 1, 0.85, 0);
      b.add('mid', 'kick', beat + 1, NATURAL, 1, 0.5, 0.55);
      b.add('mid', 'snare', beat, NATURAL, 1, 0.55, 0.28);
      for (let s = 0; s < n; s += 2) b.add('mid', 'hat', s, NATURAL, 1, s % beat === 0 ? 0.4 : 0.26, 0.52);
      euclidHits(c, 'mid', 'metal', 3, 0.55, 0.12, [NATURAL, NATURAL + 7, NATURAL + 12, NATURAL + 5]);
      euclidHits(c, 'mid', 'perc', 5, 0.4, 0.6);
      for (let s = 3; s < n; s += 3) b.add('peak', 'kick', s, NATURAL, 1, 0.6, 0.85);
      for (let s = 3; s < n; s += beat) b.add('peak', 'openHat', s, NATURAL, 1, 0.4, 0.82);
      break;
    case 'halftime':
      b.add('mid', 'kick', 0, NATURAL, 1, 0.95, 0);
      b.add('mid', 'kick', half + 2, NATURAL, 1, 0.75, 0);
      b.add('mid', 'snare', half, NATURAL, 1, 0.8, 0.2);
      hats(c, 0.25, 0.62);
      euclidHits(c, 'mid', 'perc', 7, 0.35, 0.6);
      euclidHits(c, 'mid', 'metal', 2, 0.45, 0.4, [NATURAL + 12, NATURAL + 7]);
      for (let s = beat; s < n; s += beat * 2) b.add('peak', 'kick', s, NATURAL, 1, 0.7, 0.8);
      for (let s = 2; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.42, 0.82);
      break;
    case 'broken': {
      const groups = oddGroups(n);
      let at = 0;
      groups.forEach((g, gi) => {
        const lastGroup = gi === groups.length - 1;
        if (lastGroup && groups.length > 1) b.add('mid', 'snare', at, NATURAL, 1, 0.8, 0.15);
        else b.add('mid', 'kick', at, NATURAL, 1, gi === 0 ? 0.95 : 0.7, gi === 0 ? 0 : 0.3);
        b.add('peak', 'kick', at + g - 1, NATURAL, 1, 0.55, 0.85);
        b.add('peak', 'tom', at + g - 2, NATURAL - 5 - gi * 2, 1, 0.6, 0.84);
        at += g;
      });
      for (let s = 0; s < n; s += 2) b.add('mid', 'hat', s, NATURAL, 1, 0.4, 0.3);
      euclidHits(c, 'mid', 'metal', 3, 0.55, 0.25, [NATURAL, NATURAL - 3, NATURAL + 6]);
      euclidHits(c, 'mid', 'perc', 2, 0.5, 0.45, [NATURAL, NATURAL + 5]);
      for (let s = 1; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.4, 0.82);
      break;
    }
    case 'electro':
      for (let s = 0; s < n; s += beat) b.add('mid', 'kick', s, NATURAL, 1, 0.8, 0);
      for (let s = beat; s < n; s += beat * 2) b.add('mid', 'snare', s, NATURAL, 1, 0.65, 0.3);
      for (let s = 2; s < n; s += 4) b.add('mid', 'hat', s, NATURAL, 1, 0.5, 0.1);
      for (let s = 1; s < n; s += 2) b.add('mid', 'hat', s, NATURAL, 1, 0.24, 0.6);
      euclidHits(c, 'mid', 'perc', 3, 0.4, 0.5, [NATURAL, NATURAL + 7, NATURAL + 12]);
      for (let s = 2; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.4, 0.82);
      b.add('peak', 'kick', n - 1, NATURAL, 1, 0.5, 0.88);
      break;
    case 'heartbeat':
      b.add('mid', 'kick', 0, NATURAL, 1, 0.8, 0);
      b.add('mid', 'kick', 2, NATURAL - 2, 1, 0.55, 0);
      b.add('mid', 'kick', half, NATURAL, 1, 0.5, 0.75);
      b.add('mid', 'kick', half + 2, NATURAL - 2, 1, 0.35, 0.75);
      break;
    case 'boss':
      for (let s = 0; s < n; s += beat) b.add('mid', 'kick', s, NATURAL, 1, 0.95, 0);
      for (let s = beat; s < n; s += beat * 2) b.add('mid', 'snare', s, NATURAL, 1, 0.9, 0);
      for (let s = 1; s < n; s++) if (s % beat !== 0) b.add('mid', 'kick', s, NATURAL, 1, 0.5, 0.62);
      hats(c, 0.2, 0.7);
      euclidHits(c, 'mid', 'metal', 5, 0.55, 0.3);
      euclidHits(c, 'mid', 'perc', 3, 0.45, 0.5);
      for (let s = 2; s < n; s += 4) b.add('peak', 'openHat', s, NATURAL, 1, 0.5, 0.8);
      if (c.bar % 2 === 0) b.add('peak', 'crash', 0, NATURAL, 1, 0.7, 0.85);
      break;
  }
  // Riser into the next phrase; fills at the phrase end (toms, snare roll) and a lighter one mid-phrase.
  if (last) {
    b.add('mid', 'riser', 0, NATURAL, n, 0.9, 0.5);
    const toms = [NATURAL + 7, NATURAL + 3, NATURAL, NATURAL - 5];
    for (let k = 0; k < 4; k++) b.add('peak', 'tom', n - 4 + k, toms[k]!, 1, 0.65 + k * 0.1, 0.8);
    for (let k = 3; k >= 1; k--) b.add('peak', 'snare', n - k, NATURAL, 1, 0.45 + (3 - k) * 0.15, 0.86);
  } else if (c.bar === Math.floor(c.bars / 2) - 1) {
    b.add('peak', 'tom', n - 2, NATURAL + 3, 1, 0.6, 0.88);
    b.add('peak', 'tom', n - 1, NATURAL - 2, 1, 0.7, 0.88);
  }
  if (c.bar === 0) b.add('peak', 'crash', 0, NATURAL, 1, 0.85, 0.75);
  else if (c.bar === Math.floor(c.bars / 2)) b.add('peak', 'crash', 0, NATURAL, 1, 0.7, 0.9);
}

// ---------------------------------------------------------------------------
// Bass
// ---------------------------------------------------------------------------

function bassBar(
  def: MusicThemeDef,
  b: BarBuilder,
  root: number,
  fifth: number,
  approach: number | null,
): void {
  const n = b.steps;
  const beat = def.beatSteps;
  switch (def.style.bass) {
    case 'pulse16':
      for (let s = 0; s < n; s++) {
        const onBeat = s % beat === 0;
        const vel = onBeat ? 0.9 : s % 2 === 0 ? 0.7 : 0.55;
        b.add('low', 'bass', s, root, 1, vel, s % 2 === 0 ? 0 : 0.45);
      }
      b.remove('bass', n - 2);
      b.add('low', 'bass', n - 2, root + 12, 1, 0.75, 0.6);
      break;
    case 'pulse8':
      for (let s = 0; s < n; s += 2) b.add('low', 'bass', s, root, 2, s % beat === 0 ? 0.85 : 0.65, 0);
      b.remove('bass', 6);
      b.add('low', 'bass', 6, root + 12, 2, 0.7, 0.5);
      b.add('low', 'bass', n - 1, root, 1, 0.55, 0.6);
      break;
    case 'gallop':
      for (let s = 0; s < n; s += beat) {
        b.add('low', 'bass', s, root, 2, 0.9, 0);
        b.add('low', 'bass', s + 2, root, 1, 0.65, 0.3);
        b.add('low', 'bass', s + 3, root, 1, 0.65, 0.3);
      }
      break;
    case 'octaves':
      for (let s = 0; s < n; s += 2)
        b.add('low', 'bass', s, (s / 2) % 2 === 0 ? root : root + 12, 2, 0.75, 0);
      break;
    case 'tresillo': {
      const t = euclid(3, 8);
      for (let s = 0; s < n; s++) if (t[s % 8]) b.add('low', 'bass', s, root, 3, 0.85, 0);
      b.add('low', 'bass', n - 2, fifth, 2, 0.6, 0.5);
      break;
    }
    case 'sparse':
    default:
      b.add('low', 'bass', 0, root, n, 0.85, 0);
      if (n >= 12)
        b.add('low', 'bass', Math.floor(n / 2) + (n % 4 === 0 ? 0 : 1), fifth, Math.floor(n / 2), 0.6, 0.4);
      break;
  }
  if (approach !== null) {
    const at = n - 2;
    b.remove('bass', at);
    b.remove('bass', at + 1);
    b.add('low', 'bass', at, approach, 2, 0.75, 0.35);
  }
}

// ---------------------------------------------------------------------------
// Arpeggio
// ---------------------------------------------------------------------------

function arpBar(def: MusicThemeDef, b: BarBuilder, pool: readonly number[], rng: Rng, start: number): number {
  if (pool.length === 0) return start;
  const n = b.steps;
  const rate = def.style.arpRate;
  const len = pool.length;
  let idx = start;
  let dir = 1;
  const pick = (k: number): number => {
    switch (def.style.arp) {
      case 'down':
        return pool[len - 1 - mod(k, len)]!;
      case 'updown': {
        const cycle = Math.max(1, 2 * len - 2);
        const p = mod(k, cycle);
        return pool[p < len ? p : cycle - p]!;
      }
      case 'broken': {
        const p = mod(k, 2 * len);
        return pool[Math.min(len - 1, (p >> 1) + (p & 1) * 2)]!;
      }
      case 'walk': {
        if (k === start) return pool[mod(idx, len)]!;
        let next = idx + dir;
        if (rng.chance(0.3)) dir = -dir;
        if (next < 0 || next >= len) {
          dir = -dir;
          next = idx + dir;
        }
        idx = Math.max(0, Math.min(len - 1, next));
        return pool[idx]!;
      }
      case 'up':
      default:
        return pool[mod(k, len)]!;
    }
  };
  let k = start;
  for (let s = 0; s < n; s += rate) {
    const accent = s % def.beatSteps === 0;
    b.add('high', 'arp', s, pick(k++), rate * 2, accent ? 0.8 : 0.62, 0);
    // Denser with intensity: the in-between 16ths.
    if (rate === 2) b.add('high', 'arp', s + 1, pick(k + 1), 2, 0.45, 0.7);
  }
  return def.style.arp === 'walk' ? idx : k;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const LEAD_CELLS: readonly (readonly number[])[] = [
  [4, 4, 8],
  [6, 2, 8],
  [2, 2, 4, 8],
  [8, 4, 4],
  [4, 2, 2, 8],
  [3, 3, 2, 8],
  [12, 4],
];
const LEAD_SPAN_DEGREES = 9;

/** Degree range [lo, hi] whose notes lie inside [low, high] (MIDI). */
function degreeWindow(tonic: number, scale: readonly number[], low: number, high: number): [number, number] {
  let lo = 0;
  while (degreeNote(tonic, scale, lo) < low) lo++;
  while (degreeNote(tonic, scale, lo - 1) >= low) lo--;
  let hi = lo;
  while (degreeNote(tonic, scale, hi + 1) <= high) hi++;
  return [lo, hi];
}

function composePhrase(
  def: MusicThemeDef,
  progression: readonly number[],
  rng: Rng,
  motifSeed: Rng,
): ComposedPhrase {
  const scale = SCALES[def.scale];
  const tonic = def.key;
  const len = scale.length;
  const bars = def.phraseBars;
  const chordOf = (bar: number): number => progression[Math.floor(bar / def.chordBars) % progression.length]!;
  const barSteps = (bar: number): number => def.meter[bar % def.meter.length]!;
  const builders: BarBuilder[] = [];
  const barStart: number[] = [];
  let total = 0;
  for (let bar = 0; bar < bars; bar++) {
    builders.push(new BarBuilder(barSteps(bar)));
    barStart.push(total);
    total += barSteps(bar);
  }
  /** Steps from bar `bar` to the end of its chord span. */
  const chordSpan = (bar: number): number => {
    let s = 0;
    let b = bar;
    do {
      s += barSteps(b);
      b++;
    } while (b < bars && b % def.chordBars !== 0);
    return s;
  };

  const [padLo, padHi] = rangeOf('pad');
  const [strLo, strHi] = rangeOf('strings');
  const [stabLo, stabHi] = rangeOf('stab');
  const [choirLo, choirHi] = rangeOf('choir');
  const [arpLo] = rangeOf('arp');
  const [leadLo, leadHi] = rangeOf('lead');
  const padVoices = def.chordColor === 'power' ? 3 : 4;
  let padPrev: number[] | null = null;
  let strPrev: number[] | null = null;
  let stabPrev: number[] | null = null;
  let arpIdx = 0;
  const droneNote = droneNoteFor(def);

  // Textures: bars (not the first / last) and on-beat steps, drawn once per phrase.
  const textureBars = new Set<number>();
  for (let t = 0; t < def.style.textures && bars > 2; t++) textureBars.add(rng.int(1, bars - 2));

  for (let bar = 0; bar < bars; bar++) {
    const b = builders[bar]!;
    const n = b.steps;
    const rootDeg = chordOf(bar);
    const pcs = chordPitchClasses(tonic, scale, rootDeg, def.chordColor);
    const change = bar % def.chordBars === 0;
    const span = chordSpan(bar);
    const rootNote = foldAround(degreeNote(tonic, scale, rootDeg), tonic + 3);
    const fifthNote = foldAround(degreeNote(tonic, scale, rootDeg + 4), rootNote + 5);

    // --- ambient: drone pedal, pad chords, choir, textures, the reverse swell into the next phrase.
    if (bar % 4 === 0) {
      let droneSteps = 0;
      for (let k = bar; k < Math.min(bars, bar + 4); k++) droneSteps += barSteps(k);
      b.add('ambient', 'drone', 0, droneNote, droneSteps, 0.8, 0);
    }
    if (change) {
      padPrev = voiceLead(padPrev, pcs, padLo, padHi, padVoices);
      for (const m of padPrev) b.add('ambient', 'pad', 0, m, span, 0.62, 0);
      if (def.style.choirEvery > 0 && bar % def.style.choirEvery === 0) {
        const cv = voiceLead(null, pcs.slice(0, 2), choirLo, choirHi, 2, (choirLo + choirHi) / 2 - 3);
        for (const m of cv) b.add('ambient', 'choir', 0, m, Math.min(span, n * 2), 0.6, 0.38);
      }
    }
    if (bar === bars - 1) b.add('ambient', 'swell', 0, NATURAL, n, 0.85, 0.22);
    if (textureBars.has(bar)) {
      const beats = Math.max(1, Math.floor(n / def.beatSteps));
      const at = rng.int(0, beats - 1) * def.beatSteps;
      const slot: InstrumentSlot = rng.chance(0.5) ? 'scrape' : 'fx';
      b.add('ambient', slot, at, NATURAL + rng.int(-2, 2), def.beatSteps * 2, 0.6 + rng.next() * 0.3, 0.12);
    }

    // --- low: sub on the chord root, the bass line with an approach note into the next chord.
    if (change) b.add('low', 'sub', 0, foldAround(rootNote, rangeOf('sub')[0] + 12), span, 0.85, 0);
    const lastOfSpan = (bar + 1) % def.chordBars === 0 || bar === bars - 1;
    const nextRoot = chordOf((bar + 1) % bars);
    let approach: number | null = null;
    if (lastOfSpan && nextRoot !== rootDeg) {
      const nextNote = foldAround(degreeNote(tonic, scale, nextRoot), tonic + 3);
      const above = foldAround(degreeNote(tonic, scale, nextRoot + 1), nextNote + 2);
      const below = foldAround(degreeNote(tonic, scale, nextRoot - 1), nextNote - 2);
      approach = Math.abs(above - rootNote) < Math.abs(below - rootNote) ? above : below;
    }
    bassBar(def, b, rootNote, fifthNote, approach);

    // --- mid / peak: the groove.
    drumBar(def.style.drums, { b, n, beat: def.beatSteps, bar, bars, rng });

    // --- high: arpeggio, strings, (lead below).
    const pool: number[] = [];
    for (let m = arpLo; m < arpLo + 12 * def.style.arpOctaves; m++)
      if (pcs.includes(mod(m, 12))) pool.push(m);
    arpIdx = arpBar(def, b, pool, rng, arpIdx);
    if (change) {
      strPrev = voiceLead(strPrev, pcs, strLo, strHi, 3);
      for (const m of strPrev) b.add('high', 'strings', 0, m, span, 0.6, 0.15);
    }

    // --- peak: distorted power chords, chord stabs.
    for (let s = 0; s < n; s += 2) {
      if (s % 8 === 6) continue;
      b.add(
        'peak',
        'dist',
        s,
        foldAround(rootNote, tonic + 10),
        2,
        s % def.beatSteps === 0 ? 0.9 : 0.7,
        0.82,
      );
    }
    if (change) {
      stabPrev = voiceLead(stabPrev, pcs, stabLo, stabHi, 3);
      for (const m of stabPrev) b.add('peak', 'stab', 0, m, 4, 0.8, 0.9);
    }
  }

  // --- lead: motif A (bars 0–1), re-harmonized (2–3), answer B (4–5), A cadencing on the tonic (6–7).
  if (bars >= 4) {
    const [dLo, dHi] = degreeWindow(tonic, scale, leadLo, leadHi);
    const lo = dLo + 1;
    const hi = Math.min(dHi, lo + LEAD_SPAN_DEGREES);
    const chordAtAbs = (absStep: number): readonly number[] => {
      let bar = 0;
      while (bar < bars - 1 && barStart[bar + 1]! <= absStep) bar++;
      return chordDegrees(chordOf(bar), def.chordColor);
    };
    const unit = barStart[Math.min(2, bars)] ?? total;
    const motif = (offset: number, r: Rng): MotifNote[] =>
      generateMotif(r, {
        steps: Math.min(unit, total - offset),
        beatSteps: def.beatSteps,
        chordAt: (s) => chordAtAbs(offset + s),
        scaleLength: len,
        low: lo,
        high: hi,
        cells: LEAD_CELLS,
        leapChance: 0.28,
      });
    const a = motif(0, motifSeed);
    const answer = motif(unit * 2, motifSeed);
    const place = (notes: readonly MotifNote[], offset: number, shift: number, cadence: boolean): void => {
      notes.forEach((m, k) => {
        const abs = offset + m.step;
        if (abs >= total) return;
        let deg = m.degree + shift;
        const lastNote = k === notes.length - 1;
        if ((abs - offset) % def.beatSteps === 0 || lastNote)
          deg = nearestChordDegree(deg, chordAtAbs(abs), len);
        if (cadence && lastNote) deg = nearestChordDegree(deg, [0], len);
        deg = Math.max(lo, Math.min(hi, deg));
        let bar = 0;
        while (bar < bars - 1 && barStart[bar + 1]! <= abs) bar++;
        const dur = Math.min(m.dur, total - abs);
        builders[bar]!.add(
          'high',
          'lead',
          abs - barStart[bar]!,
          degreeNote(tonic, scale, deg),
          dur,
          0.75,
          def.leadTier,
        );
      });
    };
    const shift = chordOf(Math.min(bars - 1, 2)) - chordOf(0);
    place(a, 0, 0, false);
    place(a, unit, mod(shift + 3, len) - 3, false);
    if (bars >= 6) place(answer, unit * 2, 0, false);
    if (bars >= 8) place(a, unit * 3, 0, true);
  }

  // Sort, then collect the holds (sustained events still sounding at later bar lines).
  const holds: HoldRef[][] = builders.map(() => []);
  builders.forEach((b, bar) => {
    b.events.sort((x, y) => x.step - y.step || x.layer - y.layer);
    for (const e of b.events) {
      if (!HELD_SLOTS.has(e.slot)) continue;
      const start = barStart[bar]! + e.step;
      const end = start + e.dur;
      for (let later = bar + 1; later < bars && barStart[later]! < end; later++) {
        holds[later]!.push({ event: e, elapsed: barStart[later]! - start });
      }
    }
  });
  return {
    progression,
    bars: builders.map((b, bar) => ({
      steps: b.steps,
      chord: chordDegrees(chordOf(bar), def.chordColor),
      events: b.events,
      holds: holds[bar]!,
    })),
  };
}

const cache = new Map<string, ComposedTheme>();

/** Compose (and cache) a theme: phrase A and B, played A A B A. Deterministic per theme id. */
export function composeTheme(themeId: string): ComposedTheme {
  const def = getThemeDef(themeId);
  const hit = cache.get(def.id);
  if (hit) return hit;
  const rng = new Rng(`${MUSIC.seed}:${def.id}`);
  const progRng = rng.fork('progression');
  const aIdx = progRng.int(0, def.progressions.length - 1);
  let bIdx = def.progressions.length > 1 ? progRng.int(0, def.progressions.length - 2) : aIdx;
  if (def.progressions.length > 1 && bIdx >= aIdx) bIdx++;
  const motifRng = rng.fork('motif');
  const a = composePhrase(def, def.progressions[aIdx]!, rng.fork('phraseA'), motifRng);
  const b = composePhrase(def, def.progressions[bIdx]!, rng.fork('phraseB'), motifRng);
  const theme: ComposedTheme = {
    def,
    phrases: [a, b],
    order: [0, 0, 1, 0],
    tonic: def.key,
    scale: SCALES[def.scale],
    stepDur: stepDuration(def),
  };
  cache.set(def.id, theme);
  return theme;
}

/** Layer name of an event. */
export function layerOf(e: NoteEvent): MusicLayer {
  return MUSIC_LAYERS[e.layer]!;
}
