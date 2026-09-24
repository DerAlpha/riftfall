/**
 * Sting realization (pure): a StingDef pattern (defs/music MUSIC_STINGS: scale degrees, beats) →
 * concrete notes in the playing theme's key, register and tempo. Stings therefore always fit the
 * music under them – a wave start in the rift sounds octatonic, the lab's in D minor.
 */
import { INSTRUMENT_RECIPES, type InstrumentSlot, type MusicThemeDef, type StingDef } from '../../defs/music';
import { NATURAL, rangeOf } from './composer';
import { SCALES } from '../../defs/music';
import { degreeNote } from './theory';

export interface ResolvedStingNote {
  readonly slot: InstrumentSlot;
  /** MIDI note (pitched slots) or a transposition around NATURAL. */
  readonly note: number;
  /** Audio time (s). */
  readonly time: number;
  readonly dur: number;
  readonly vel: number;
  /** Playback-rate multiplier reached after glideTime (s). */
  readonly glide: number;
  readonly glideTime: number;
}

/** The tonic moved into the lowest octave of a slot's register. */
export function registerBase(tonic: number, slot: InstrumentSlot): number {
  const [lo] = rangeOf(slot);
  let base = tonic;
  while (base < lo) base += 12;
  while (base > lo + 11) base -= 12;
  return base;
}

/**
 * Notes of `def` played by `theme` from `start` (s); `earliest` drops pickups that would fall
 * before it; `transpose` in semitones. Slots missing from the theme's palette are skipped.
 */
export function resolveSting(
  def: StingDef,
  theme: MusicThemeDef,
  start: number,
  earliest: number,
  transpose = 0,
): ResolvedStingNote[] {
  const beat = 60 / theme.tempo;
  const scale = SCALES[theme.scale];
  const out: ResolvedStingNote[] = [];
  for (const n of def.notes) {
    const inst = theme.palette[n.slot];
    if (!inst) continue;
    const time = start + n.at * beat;
    if (time < earliest - 1e-6) continue;
    let note = NATURAL;
    if (INSTRUMENT_RECIPES[inst.recipe].pitched) {
      const base = registerBase(theme.key, n.slot);
      note =
        base +
        (degreeNote(theme.key, scale, n.degree ?? 0) - theme.key) +
        (n.semi ?? 0) +
        transpose +
        12 * (n.octave ?? 0);
    }
    out.push({
      slot: n.slot,
      note,
      time,
      dur: n.dur * beat,
      vel: n.vel,
      glide: n.glide ?? 1,
      glideTime: (n.glideBeats ?? 0) * beat,
    });
  }
  return out;
}
