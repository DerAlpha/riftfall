/**
 * Procedural dynamic music (M10): themes per map, layers, intensity model, states, stings and the
 * elite / boss hint cues. Everything musical is data here; audio/music/* realizes it (composer →
 * seeded patterns in the theme's key, instruments rendered once per theme, a lookahead sequencer).
 *
 * Units: MIDI note numbers, beats / steps (16th notes) for musical time, seconds for mixing, linear
 * gains. Scales are semitone offsets from the tonic.
 */
import type { AchievementTier } from '../core/events';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Vertical layers, faded in with rising intensity (ambient is the bed of every playing state). */
export const MUSIC_LAYERS = ['ambient', 'low', 'mid', 'high', 'peak'] as const;
export type MusicLayer = (typeof MUSIC_LAYERS)[number];

/**
 * Music states. `off`: nothing plays (boot, before the first menu). `intermission` is the calm
 * state of every map – maps without waves (the calibration hall) stay in it.
 */
export const MUSIC_STATES = ['off', 'menu', 'intermission', 'wave', 'boss', 'gameover'] as const;
export type MusicState = (typeof MUSIC_STATES)[number];

/**
 * Output routes: `game` = the music bus (fades with the pause, ducked under voice lines); `menu` =
 * music volume straight to the master (plays on while paused: start screen, game over); `ui` = the
 * ui bus (quiet UI stings).
 */
export type MusicRoute = 'game' | 'menu' | 'ui';

/** Who sets the intensity: the built-in model, the M6 spawn director (wins when present), the dev console. */
export type MusicIntensitySource = 'model' | 'director' | 'dev';

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  /** Hijaz: the augmented second gives the biodome its exotic, ritual colour. */
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  /** Half-whole diminished: symmetric, no tonal centre – the rift. */
  octatonic: [0, 1, 3, 4, 6, 7, 9, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
} as const satisfies Record<string, readonly number[]>;
export type ScaleId = keyof typeof SCALES;

/**
 * Instrument slots of a theme palette. Default layers: drone/pad/choir/swell/scrape/fx → ambient,
 * bass/sub → low, kick/snare/hat/metal/perc/riser → mid (base groove), arp/strings/lead → high,
 * openHat/tom/crash/dist/stab (+ extra kicks and snares) → peak.
 */
export const INSTRUMENT_SLOTS = [
  'drone',
  'pad',
  'choir',
  'swell',
  'scrape',
  'fx',
  'bass',
  'sub',
  'kick',
  'snare',
  'hat',
  'openHat',
  'metal',
  'perc',
  'tom',
  'crash',
  'riser',
  'arp',
  'strings',
  'lead',
  'dist',
  'stab',
] as const;
export type InstrumentSlot = (typeof INSTRUMENT_SLOTS)[number];

/** Procedural instrument recipes (audio/music/instruments.ts). `loop` recipes sustain (pads, leads). */
export const INSTRUMENT_RECIPES = {
  // Sustained (seamless loops, pitched by playback rate, enveloped live).
  'pad.analog': { loop: true, pitched: true, stereo: true, dark: true },
  'pad.glass': { loop: true, pitched: true, stereo: true, dark: true },
  'pad.breath': { loop: true, pitched: true, stereo: true, dark: true },
  'pad.metal': { loop: true, pitched: true, stereo: true, dark: true },
  'drone.dark': { loop: true, pitched: true, stereo: true, dark: true },
  'drone.ice': { loop: true, pitched: true, stereo: true, dark: false },
  'drone.organic': { loop: true, pitched: true, stereo: true, dark: true },
  'drone.rift': { loop: true, pitched: true, stereo: true, dark: true },
  'strings.ensemble': { loop: true, pitched: true, stereo: true, dark: false },
  'choir.dark': { loop: true, pitched: true, stereo: true, dark: true },
  'lead.sine': { loop: true, pitched: true, stereo: false, dark: false },
  'lead.saw': { loop: true, pitched: true, stereo: false, dark: false },
  'sub.sine': { loop: true, pitched: true, stereo: false, dark: true },
  // Pitched one-shots.
  'bass.pulse': { loop: false, pitched: true, stereo: false, dark: true },
  'bass.fm': { loop: false, pitched: true, stereo: false, dark: true },
  'bass.round': { loop: false, pitched: true, stereo: false, dark: true },
  'dist.saw': { loop: false, pitched: true, stereo: false, dark: false },
  'arp.glass': { loop: false, pitched: true, stereo: false, dark: false },
  'arp.pluck': { loop: false, pitched: true, stereo: false, dark: false },
  'arp.square': { loop: false, pitched: true, stereo: false, dark: false },
  'arp.marimba': { loop: false, pitched: true, stereo: false, dark: false },
  'arp.ring': { loop: false, pitched: true, stereo: false, dark: false },
  'stab.brass': { loop: false, pitched: true, stereo: true, dark: false },
  'stab.choir': { loop: false, pitched: true, stereo: true, dark: true },
  // Percussion and textures (unpitched one-shots; rate only for humanization / toms).
  'kick.industrial': { loop: false, pitched: false, stereo: false, dark: false },
  'kick.deep': { loop: false, pitched: false, stereo: false, dark: true },
  'kick.soft': { loop: false, pitched: false, stereo: false, dark: true },
  'snare.industrial': { loop: false, pitched: false, stereo: false, dark: false },
  'snare.clap': { loop: false, pitched: false, stereo: true, dark: false },
  'snare.rim': { loop: false, pitched: false, stereo: false, dark: false },
  'hat.closed': { loop: false, pitched: false, stereo: false, dark: false },
  'hat.open': { loop: false, pitched: false, stereo: false, dark: false },
  'hat.shaker': { loop: false, pitched: false, stereo: false, dark: false },
  'metal.anvil': { loop: false, pitched: false, stereo: false, dark: false },
  'metal.pipe': { loop: false, pitched: false, stereo: false, dark: false },
  'metal.glass': { loop: false, pitched: false, stereo: false, dark: false },
  'metal.wood': { loop: false, pitched: false, stereo: false, dark: false },
  'perc.glitch': { loop: false, pitched: false, stereo: true, dark: false },
  'perc.drip': { loop: false, pitched: false, stereo: false, dark: false },
  'perc.ping': { loop: false, pitched: false, stereo: false, dark: false },
  'tom.floor': { loop: false, pitched: false, stereo: false, dark: true },
  'tom.tribal': { loop: false, pitched: false, stereo: false, dark: true },
  'crash.impact': { loop: false, pitched: false, stereo: true, dark: false },
  /** Bar-long (rendered at the theme's tempo). */
  'riser.noise': { loop: false, pitched: false, stereo: true, dark: false, bar: true },
  'swell.reverse': { loop: false, pitched: false, stereo: true, dark: true, bar: true },
  'scrape.metal': { loop: false, pitched: false, stereo: true, dark: false },
} as const satisfies Record<
  string,
  { loop: boolean; pitched: boolean; stereo: boolean; dark: boolean; bar?: boolean }
>;
export type InstrumentRecipe = keyof typeof INSTRUMENT_RECIPES;

/** Sound-design knobs of a recipe (each recipe reads the ones it knows; all optional). */
export interface InstrumentParams {
  /** 0..1 filter openness / harmonic brightness. */
  readonly bright: number;
  /** 0..1 saturation. */
  readonly drive: number;
  /** Chorus detune of stacked voices (cents). */
  readonly detune: number;
  /** One-shot decay (s). */
  readonly decay: number;
  /** Vibrato depth (cents) of sustained voices. */
  readonly vibrato: number;
  /** 0..1 breath / noise share. */
  readonly noise: number;
  /** Base pitch of drums (Hz). */
  readonly pitch: number;
}

export interface InstrumentDef {
  readonly recipe: InstrumentRecipe;
  /** Mix level inside its layer (linear, after per-sample peak normalization). */
  readonly gain: number;
  readonly params?: Readonly<Partial<InstrumentParams>>;
}

export type DrumStyle =
  | 'industrial'
  | 'tribal'
  | 'sparse'
  | 'heavy'
  | 'halftime'
  | 'broken'
  | 'electro'
  | 'heartbeat'
  | 'boss';
export type BassStyle = 'pulse8' | 'pulse16' | 'gallop' | 'octaves' | 'sparse' | 'tresillo';
export type ArpStyle = 'up' | 'down' | 'updown' | 'walk' | 'broken';
/** Chord tones stacked on each degree: triad, 7th chord, sus2, add9, or a bare power chord. */
export type ChordColor = 'triad' | 'seventh' | 'sus2' | 'add9' | 'power';

export interface MusicStyleDef {
  readonly drums: DrumStyle;
  readonly bass: BassStyle;
  readonly arp: ArpStyle;
  /** Steps (16ths) per arpeggio note at the arp's base density (16ths fill in at high intensity). */
  readonly arpRate: 1 | 2 | 3;
  /** Octaves the arpeggio spans. */
  readonly arpOctaves: 1 | 2;
  /** Textures (scrapes, fx) per phrase at full density. */
  readonly textures: number;
  /** A choir swell every n bars (0 = never). */
  readonly choirEvery: number;
}

export interface MusicThemeDef {
  readonly id: string;
  readonly name: string;
  /** Tonic as a MIDI note in the bass octave (36–47). */
  readonly key: number;
  readonly scale: ScaleId;
  /** Quarter notes per minute. */
  readonly tempo: number;
  /** Steps (16ths) per bar, cycled over the phrase: [16] = 4/4, [12] = 6/8, several = shifting meter. */
  readonly meter: readonly number[];
  /** Steps per felt beat (accents, beat quantization): 4 simple, 6 compound, 2 odd eighth meters. */
  readonly beatSteps: number;
  /** Delay of odd 16ths (fraction of a step). */
  readonly swing: number;
  readonly phraseBars: number;
  readonly chordBars: number;
  /** Candidate progressions (scale degrees, 0 = tonic); the seeded composer picks phrase A and B. */
  readonly progressions: readonly (readonly number[])[];
  readonly chordColor: ChordColor;
  readonly style: MusicStyleDef;
  /** The lead melody enters from this intensity (inside the high layer). */
  readonly leadTier: number;
  /** Intensity cap of the calm state (default MUSIC.states.intermission.max). */
  readonly calmMax?: number;
  /** Per-layer mix (linear, default 1). */
  readonly mix?: Readonly<Partial<Record<MusicLayer, number>>>;
  readonly palette: Readonly<Partial<Record<InstrumentSlot, InstrumentDef>>>;
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const i = (recipe: InstrumentRecipe, gain: number, params?: Partial<InstrumentParams>): InstrumentDef =>
  params ? { recipe, gain, params } : { recipe, gain };

/** Research lab: clinical dread, a Carpenter-style pulsing bass, glass arps, a theremin lead. */
const LAB: MusicThemeDef = {
  id: 'lab',
  name: 'Forschungslabor',
  key: 38,
  scale: 'aeolian',
  tempo: 104,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 5, 3, 4],
    [0, 5, 0, 6],
    [0, 3, 5, 4],
    [0, 6, 5, 4],
  ],
  chordColor: 'triad',
  style: {
    drums: 'industrial',
    bass: 'pulse16',
    arp: 'up',
    arpRate: 2,
    arpOctaves: 2,
    textures: 3,
    choirEvery: 8,
  },
  leadTier: 0.72,
  palette: {
    drone: i('drone.dark', 0.5, { bright: 0.3 }),
    pad: i('pad.analog', 0.42, { bright: 0.28, detune: 9 }),
    choir: i('choir.dark', 0.24),
    swell: i('swell.reverse', 0.4),
    scrape: i('scrape.metal', 0.2),
    fx: i('perc.ping', 0.16, { pitch: 1320 }),
    bass: i('bass.pulse', 0.55, { bright: 0.35, drive: 0.3 }),
    sub: i('sub.sine', 0.42),
    kick: i('kick.industrial', 0.8, { drive: 0.4 }),
    snare: i('snare.clap', 0.5),
    hat: i('hat.closed', 0.26),
    openHat: i('hat.open', 0.22),
    metal: i('metal.pipe', 0.22),
    perc: i('perc.glitch', 0.16),
    tom: i('tom.floor', 0.55),
    crash: i('crash.impact', 0.6),
    riser: i('riser.noise', 0.32),
    arp: i('arp.glass', 0.3, { bright: 0.5 }),
    strings: i('strings.ensemble', 0.34, { bright: 0.35 }),
    lead: i('lead.sine', 0.3, { vibrato: 14 }),
    dist: i('dist.saw', 0.34, { drive: 0.8 }),
    stab: i('stab.brass', 0.42),
  },
};

/** Arctic station: icy, sparse, glassy – 6/8, sus2 chords, glass chimes and bowed glass. */
const ARCTIC: MusicThemeDef = {
  id: 'arctic',
  name: 'Polarstation',
  key: 42,
  scale: 'dorian',
  tempo: 76,
  meter: [12],
  beatSteps: 6,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 3, 0, 6],
    [0, 6, 3, 0],
    [0, 2, 3, 6],
  ],
  chordColor: 'sus2',
  style: {
    drums: 'sparse',
    bass: 'sparse',
    arp: 'walk',
    arpRate: 2,
    arpOctaves: 2,
    textures: 4,
    choirEvery: 0,
  },
  leadTier: 0.6,
  palette: {
    drone: i('drone.ice', 0.46, { bright: 0.6 }),
    pad: i('pad.glass', 0.4, { bright: 0.55 }),
    swell: i('swell.reverse', 0.36),
    scrape: i('scrape.metal', 0.2, { bright: 0.85 }),
    fx: i('perc.drip', 0.2, { pitch: 1900 }),
    bass: i('bass.round', 0.5),
    sub: i('sub.sine', 0.4),
    kick: i('kick.soft', 0.72),
    snare: i('snare.rim', 0.36),
    hat: i('hat.closed', 0.18, { bright: 0.8 }),
    openHat: i('hat.open', 0.16),
    metal: i('metal.glass', 0.26),
    perc: i('hat.shaker', 0.16),
    tom: i('tom.floor', 0.45),
    crash: i('crash.impact', 0.5),
    riser: i('riser.noise', 0.28),
    arp: i('arp.glass', 0.32, { bright: 0.8 }),
    strings: i('strings.ensemble', 0.3, { bright: 0.55 }),
    lead: i('lead.sine', 0.28, { vibrato: 8 }),
    dist: i('dist.saw', 0.26, { drive: 0.5 }),
    stab: i('stab.choir', 0.4),
  },
};

/** Biodome: organic, ritual – Hijaz mode, tresillo toms and shakers, breath pads, wet drips. */
const BIODOME: MusicThemeDef = {
  id: 'biodome',
  name: 'Biodom',
  key: 40,
  scale: 'phrygianDominant',
  tempo: 96,
  meter: [16],
  beatSteps: 4,
  swing: 0.12,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 1, 0, 6],
    [0, 1, 5, 6],
    [0, 6, 5, 1],
  ],
  chordColor: 'triad',
  style: {
    drums: 'tribal',
    bass: 'tresillo',
    arp: 'broken',
    arpRate: 2,
    arpOctaves: 1,
    textures: 5,
    choirEvery: 8,
  },
  leadTier: 0.7,
  palette: {
    drone: i('drone.organic', 0.5),
    pad: i('pad.breath', 0.42, { noise: 0.5 }),
    choir: i('choir.dark', 0.22),
    swell: i('swell.reverse', 0.36),
    fx: i('perc.drip', 0.26, { pitch: 1300 }),
    bass: i('bass.fm', 0.52, { bright: 0.25 }),
    sub: i('sub.sine', 0.4),
    kick: i('kick.deep', 0.8),
    snare: i('snare.rim', 0.36),
    hat: i('hat.shaker', 0.24),
    openHat: i('hat.shaker', 0.2, { decay: 0.2 }),
    metal: i('metal.wood', 0.3),
    perc: i('perc.drip', 0.18, { pitch: 900 }),
    tom: i('tom.tribal', 0.62),
    crash: i('crash.impact', 0.5),
    riser: i('riser.noise', 0.28),
    arp: i('arp.marimba', 0.4),
    strings: i('strings.ensemble', 0.28, { bright: 0.25 }),
    lead: i('lead.sine', 0.26, { vibrato: 18, noise: 0.45 }),
    dist: i('dist.saw', 0.3, { drive: 0.6 }),
    stab: i('stab.choir', 0.42),
  },
};

/** Reactor: industrial, heavy, fast – phrygian power chords, galloping FM bass, anvils. */
const REACTOR: MusicThemeDef = {
  id: 'reactor',
  name: 'Reaktor',
  key: 36,
  scale: 'phrygian',
  tempo: 140,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 1, 0, 1],
    [0, 6, 5, 1],
    [0, 1, 6, 5],
  ],
  chordColor: 'power',
  style: {
    drums: 'heavy',
    bass: 'gallop',
    arp: 'updown',
    arpRate: 1,
    arpOctaves: 1,
    textures: 3,
    choirEvery: 0,
  },
  leadTier: 0.75,
  palette: {
    drone: i('drone.dark', 0.5, { bright: 0.5, drive: 0.5 }),
    pad: i('pad.metal', 0.38),
    swell: i('swell.reverse', 0.36),
    scrape: i('scrape.metal', 0.24),
    fx: i('perc.glitch', 0.2),
    bass: i('bass.fm', 0.58, { bright: 0.6, drive: 0.6 }),
    sub: i('sub.sine', 0.44),
    kick: i('kick.industrial', 0.85, { drive: 0.8 }),
    snare: i('snare.industrial', 0.55),
    hat: i('hat.closed', 0.24),
    openHat: i('hat.open', 0.22),
    metal: i('metal.anvil', 0.26),
    perc: i('metal.pipe', 0.2),
    tom: i('tom.floor', 0.55),
    crash: i('crash.impact', 0.6),
    riser: i('riser.noise', 0.32),
    arp: i('arp.square', 0.24, { bright: 0.6 }),
    strings: i('strings.ensemble', 0.3, { bright: 0.7 }),
    lead: i('lead.saw', 0.26, { vibrato: 20 }),
    dist: i('dist.saw', 0.42, { drive: 1 }),
    stab: i('stab.brass', 0.46),
  },
};

/** Orbital ring: spacious, weightless – dorian add9 chords, half-time drums, sequenced 16th arps. */
const ORBITAL: MusicThemeDef = {
  id: 'orbital',
  name: 'Orbitalring',
  key: 45,
  scale: 'dorian',
  tempo: 112,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 3, 0, 6],
    [0, 2, 3, 6],
    [0, 6, 2, 3],
  ],
  chordColor: 'add9',
  style: {
    drums: 'halftime',
    bass: 'pulse8',
    arp: 'up',
    arpRate: 1,
    arpOctaves: 2,
    textures: 3,
    choirEvery: 4,
  },
  leadTier: 0.7,
  palette: {
    drone: i('drone.ice', 0.42, { bright: 0.35 }),
    pad: i('pad.analog', 0.4, { bright: 0.45, detune: 12 }),
    choir: i('choir.dark', 0.2),
    swell: i('swell.reverse', 0.36),
    fx: i('perc.ping', 0.14, { pitch: 880 }),
    bass: i('bass.pulse', 0.5, { bright: 0.55 }),
    sub: i('sub.sine', 0.4),
    kick: i('kick.soft', 0.75),
    snare: i('snare.clap', 0.44),
    hat: i('hat.closed', 0.2),
    openHat: i('hat.open', 0.2),
    metal: i('metal.glass', 0.2),
    perc: i('hat.shaker', 0.16),
    tom: i('tom.floor', 0.45),
    crash: i('crash.impact', 0.5),
    riser: i('riser.noise', 0.3),
    arp: i('arp.square', 0.26, { bright: 0.45 }),
    strings: i('strings.ensemble', 0.3, { bright: 0.45 }),
    lead: i('lead.sine', 0.28, { vibrato: 10 }),
    dist: i('dist.saw', 0.28, { drive: 0.6 }),
    stab: i('stab.brass', 0.4),
  },
};

/** Rift: surreal, dissonant – octatonic diminished harmony, 7/8 5/8 7/8 9/8, ring-mod arps, choir. */
const RIFT: MusicThemeDef = {
  id: 'rift',
  name: 'Riss',
  key: 44,
  scale: 'octatonic',
  tempo: 118,
  meter: [14, 10, 14, 18],
  beatSteps: 2,
  swing: 0,
  phraseBars: 8,
  chordBars: 1,
  progressions: [
    [0, 1, 0, 5, 0, 3, 6, 1],
    [0, 3, 1, 6, 0, 5, 3, 1],
  ],
  chordColor: 'seventh',
  style: {
    drums: 'broken',
    bass: 'sparse',
    arp: 'walk',
    arpRate: 1,
    arpOctaves: 2,
    textures: 6,
    choirEvery: 2,
  },
  leadTier: 0.6,
  palette: {
    drone: i('drone.rift', 0.5),
    pad: i('pad.metal', 0.36),
    choir: i('choir.dark', 0.32),
    swell: i('swell.reverse', 0.4),
    scrape: i('scrape.metal', 0.26),
    fx: i('perc.glitch', 0.24),
    bass: i('bass.fm', 0.52, { bright: 0.4 }),
    sub: i('sub.sine', 0.42),
    kick: i('kick.deep', 0.78),
    snare: i('snare.industrial', 0.46),
    hat: i('hat.closed', 0.2),
    openHat: i('hat.open', 0.2),
    metal: i('metal.anvil', 0.24),
    perc: i('perc.glitch', 0.2),
    tom: i('tom.tribal', 0.55),
    crash: i('crash.impact', 0.55),
    riser: i('riser.noise', 0.3),
    arp: i('arp.ring', 0.26),
    strings: i('strings.ensemble', 0.3, { bright: 0.3 }),
    lead: i('lead.sine', 0.28, { vibrato: 40 }),
    dist: i('dist.saw', 0.34, { drive: 0.9 }),
    stab: i('stab.choir', 0.44),
  },
};

/** Calibration hall: light, clean calibration synth – lydian, soft electro groove, beeps. */
const TESTROOM: MusicThemeDef = {
  id: 'testroom',
  name: 'Kalibrierhalle',
  key: 36,
  scale: 'lydian',
  tempo: 100,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 1, 0, 1],
    [0, 4, 5, 1],
    [0, 5, 3, 1],
  ],
  chordColor: 'add9',
  style: {
    drums: 'electro',
    bass: 'octaves',
    arp: 'up',
    arpRate: 2,
    arpOctaves: 2,
    textures: 3,
    choirEvery: 0,
  },
  leadTier: 0.8,
  // Shooting the calibration targets may bring in the groove (no waves here).
  calmMax: 0.66,
  palette: {
    drone: i('drone.ice', 0.34, { bright: 0.4 }),
    pad: i('pad.glass', 0.4, { bright: 0.45 }),
    swell: i('swell.reverse', 0.3),
    fx: i('perc.ping', 0.2, { pitch: 1760 }),
    bass: i('bass.round', 0.48),
    sub: i('sub.sine', 0.34),
    kick: i('kick.soft', 0.7),
    snare: i('snare.clap', 0.4),
    hat: i('hat.closed', 0.22),
    openHat: i('hat.open', 0.18),
    metal: i('metal.glass', 0.2),
    perc: i('perc.ping', 0.14, { pitch: 2640 }),
    tom: i('tom.floor', 0.42),
    crash: i('crash.impact', 0.44),
    riser: i('riser.noise', 0.26),
    arp: i('arp.square', 0.26, { bright: 0.35 }),
    strings: i('strings.ensemble', 0.28, { bright: 0.55 }),
    lead: i('lead.saw', 0.22, { vibrato: 8, bright: 0.35 }),
    dist: i('dist.saw', 0.22, { drive: 0.4 }),
    stab: i('stab.brass', 0.34),
  },
};

/** Start screen: slow, epic minor – heartbeat, choir, a music-box arp and the theremin melody. */
const MENU: MusicThemeDef = {
  id: 'menu',
  name: 'Hauptmenü',
  key: 38,
  scale: 'aeolian',
  tempo: 72,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 2,
  progressions: [
    [0, 5, 2, 6],
    [0, 5, 3, 4],
  ],
  chordColor: 'add9',
  style: {
    drums: 'heartbeat',
    bass: 'sparse',
    arp: 'walk',
    arpRate: 2,
    arpOctaves: 2,
    textures: 2,
    choirEvery: 4,
  },
  leadTier: 0.5,
  palette: {
    drone: i('drone.dark', 0.46, { bright: 0.2 }),
    pad: i('pad.analog', 0.4, { bright: 0.2, detune: 8 }),
    choir: i('choir.dark', 0.3),
    swell: i('swell.reverse', 0.34),
    scrape: i('scrape.metal', 0.14),
    bass: i('bass.round', 0.44),
    sub: i('sub.sine', 0.36),
    kick: i('kick.deep', 0.5),
    tom: i('tom.floor', 0.4),
    crash: i('crash.impact', 0.4),
    arp: i('arp.glass', 0.3, { bright: 0.65 }),
    strings: i('strings.ensemble', 0.3, { bright: 0.3 }),
    lead: i('lead.sine', 0.3, { vibrato: 12 }),
    stab: i('stab.choir', 0.36),
  },
};

/** Generic boss theme (M6 bosses may name their own): harmonic minor, 150 bpm, choir and brass. */
const BOSS: MusicThemeDef = {
  id: 'boss',
  name: 'Boss',
  key: 37,
  scale: 'harmonicMinor',
  tempo: 150,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 8,
  chordBars: 1,
  progressions: [
    [0, 5, 4, 0, 0, 5, 4, 4],
    [0, 3, 4, 4, 0, 1, 4, 4],
  ],
  chordColor: 'triad',
  style: {
    drums: 'boss',
    bass: 'pulse16',
    arp: 'updown',
    arpRate: 1,
    arpOctaves: 2,
    textures: 3,
    choirEvery: 2,
  },
  leadTier: 0.5,
  palette: {
    drone: i('drone.dark', 0.5, { bright: 0.45, drive: 0.6 }),
    pad: i('pad.metal', 0.36),
    choir: i('choir.dark', 0.34),
    swell: i('swell.reverse', 0.38),
    scrape: i('scrape.metal', 0.22),
    bass: i('bass.fm', 0.56, { bright: 0.5, drive: 0.5 }),
    sub: i('sub.sine', 0.44),
    kick: i('kick.industrial', 0.85, { drive: 0.7 }),
    snare: i('snare.industrial', 0.55),
    hat: i('hat.closed', 0.22),
    openHat: i('hat.open', 0.2),
    metal: i('metal.anvil', 0.24),
    perc: i('metal.pipe', 0.2),
    tom: i('tom.tribal', 0.6),
    crash: i('crash.impact', 0.62),
    riser: i('riser.noise', 0.3),
    arp: i('arp.square', 0.24, { bright: 0.55 }),
    strings: i('strings.ensemble', 0.32, { bright: 0.6 }),
    lead: i('lead.saw', 0.26, { vibrato: 16 }),
    dist: i('dist.saw', 0.4, { drive: 1 }),
    stab: i('stab.brass', 0.48),
  },
};

/** Quiet UI stings (level up, achievements): bells in a bright major key, always rendered. */
const UI_KIT: MusicThemeDef = {
  id: 'ui',
  name: 'UI',
  key: 43,
  scale: 'major',
  tempo: 132,
  meter: [16],
  beatSteps: 4,
  swing: 0,
  phraseBars: 1,
  chordBars: 1,
  progressions: [[0]],
  chordColor: 'add9',
  style: {
    drums: 'electro',
    bass: 'sparse',
    arp: 'up',
    arpRate: 1,
    arpOctaves: 1,
    textures: 0,
    choirEvery: 0,
  },
  leadTier: 1,
  palette: {
    arp: i('arp.glass', 0.5, { bright: 0.75 }),
    pad: i('pad.glass', 0.3, { bright: 0.6 }),
    metal: i('metal.glass', 0.3),
  },
};

export const MUSIC_THEMES: Readonly<Record<string, MusicThemeDef>> = {
  [LAB.id]: LAB,
  [ARCTIC.id]: ARCTIC,
  [BIODOME.id]: BIODOME,
  [REACTOR.id]: REACTOR,
  [ORBITAL.id]: ORBITAL,
  [RIFT.id]: RIFT,
  [TESTROOM.id]: TESTROOM,
  [MENU.id]: MENU,
  [BOSS.id]: BOSS,
  [UI_KIT.id]: UI_KIT,
};

// ---------------------------------------------------------------------------
// Stings (patterns realized with the current theme's instruments, in its key)
// ---------------------------------------------------------------------------

export const MUSIC_STING_IDS = [
  'waveStart',
  'waveComplete',
  'pause',
  'gameOver',
  'bossAppear',
  'bossDefeated',
  'nuke',
  'instakill',
  'levelUp',
  'achievement',
] as const;
export type MusicStingId = (typeof MUSIC_STING_IDS)[number];

/**
 * One note of a sting: `at` / `dur` in beats; pitch = scale `degree` (0 = tonic, may exceed the
 * scale or go negative) + chromatic `semi` in the slot's register (`octave` shifts it). `glide`:
 * playback-rate multiplier reached after `glideBeats` (tape stop, falling clusters).
 */
export interface StingNoteDef {
  readonly slot: InstrumentSlot;
  readonly at: number;
  readonly dur: number;
  readonly vel: number;
  readonly degree?: number;
  readonly semi?: number;
  readonly octave?: number;
  readonly glide?: number;
  readonly glideBeats?: number;
}

export interface StingDef {
  /** `ui` stings use the UI kit (not the playing theme). */
  readonly route: MusicRoute;
  /** Grid the sting lands on (next beat / half beat of the playing theme) or `none` (now). */
  readonly quantize: 'beat' | 'half' | 'none';
  /** A grid point farther away than this (s) is not waited for: the next half beat, else now. */
  readonly maxWait: number;
  readonly gain: number;
  /** The same sting again within this time (s) is dropped. */
  readonly minInterval: number;
  /** Music drop: every layer dips to `gain` for `beats` after the hit (nuke). */
  readonly drop?: { readonly beats: number; readonly gain: number };
  /** Legacy one-shot (audio/enemySynth) played instead while the theme is not rendered yet. */
  readonly fallback?: { readonly id: string; readonly bus: 'music' | 'ui' };
  readonly notes: readonly StingNoteDef[];
}

const n = (
  slot: InstrumentSlot,
  at: number,
  dur: number,
  vel: number,
  o: Partial<Omit<StingNoteDef, 'slot' | 'at' | 'dur' | 'vel'>> = {},
): StingNoteDef => ({ slot, at, dur, vel, ...o });

export const MUSIC_STINGS: Readonly<Record<MusicStingId, StingDef>> = {
  /** Dread hit: impact, sub, a b2 cluster on the brass/choir stab, distorted root, tom pickup. */
  waveStart: {
    route: 'game',
    quantize: 'beat',
    maxWait: 0.45,
    gain: 0.85,
    minInterval: 2,
    fallback: { id: 'sting.wave.start', bus: 'music' },
    notes: [
      n('crash', 0, 4, 1),
      n('kick', 0, 1, 1),
      n('sub', 0, 3, 0.9, { degree: 0, glide: 0.94, glideBeats: 3 }),
      n('stab', 0, 2.5, 0.85, { degree: 0 }),
      n('stab', 0, 2.5, 0.7, { degree: 0, semi: 1 }),
      n('stab', 0, 2.5, 0.75, { degree: 4 }),
      n('dist', 0, 1.5, 0.7, { degree: 0, octave: -1 }),
      n('choir', 0.02, 3, 0.55, { degree: 0 }),
      n('choir', 0.02, 3, 0.45, { degree: 4 }),
      n('tom', -0.5, 0.5, 0.6),
      n('tom', -0.25, 0.5, 0.75),
      n('metal', 0, 2, 0.6),
    ],
  },
  /** "Welle geschafft": a rising open fifth over the tonic, bell arpeggio, strings resolve (no third). */
  waveComplete: {
    route: 'game',
    quantize: 'beat',
    maxWait: 0.45,
    gain: 0.75,
    minInterval: 2,
    fallback: { id: 'sting.wave.complete', bus: 'music' },
    notes: [
      n('sub', 0, 3, 0.7, { degree: 0 }),
      n('strings', 0, 3.5, 0.6, { degree: 0 }),
      n('strings', 0.25, 3.25, 0.5, { degree: 4 }),
      n('strings', 0.5, 3, 0.45, { degree: 7 }),
      n('arp', 0, 1, 0.7, { degree: 0 }),
      n('arp', 0.5, 1, 0.65, { degree: 4 }),
      n('arp', 1, 1, 0.6, { degree: 7 }),
      n('arp', 1.5, 2, 0.55, { degree: 8 }),
      n('pad', 0, 4, 0.5, { degree: 0 }),
      n('pad', 0, 4, 0.4, { degree: 4 }),
      n('metal', 1.5, 2, 0.35),
    ],
  },
  /** Pause: the tonic chord on the pad slows down like a stopping tape (menu route, before the suspend). */
  pause: {
    route: 'menu',
    quantize: 'none',
    maxWait: 0,
    gain: 0.6,
    minInterval: 1.2,
    notes: [
      n('pad', 0, 2.2, 0.8, { degree: 0, glide: 0.5, glideBeats: 2 }),
      n('pad', 0, 2.2, 0.7, { degree: 2, glide: 0.5, glideBeats: 2 }),
      n('pad', 0, 2.2, 0.7, { degree: 4, glide: 0.5, glideBeats: 2 }),
      n('sub', 0, 2, 0.6, { degree: 0, glide: 0.5, glideBeats: 2 }),
      n('arp', 0, 1, 0.45, { degree: 7, glide: 0.6, glideBeats: 1.5 }),
    ],
  },
  /** Game over: impact, a falling b2 cluster, the sub sinking, a last heartbeat (menu route). */
  gameOver: {
    route: 'menu',
    quantize: 'none',
    maxWait: 0,
    gain: 0.9,
    minInterval: 3,
    fallback: { id: 'sting.gameover', bus: 'ui' },
    notes: [
      n('crash', 0, 6, 1),
      n('kick', 0, 1, 1),
      n('sub', 0, 5, 1, { degree: 0, glide: 0.6, glideBeats: 5 }),
      n('stab', 0, 3, 0.8, { degree: 0, glide: 0.84, glideBeats: 3 }),
      n('stab', 0, 3, 0.65, { degree: 0, semi: 1, glide: 0.84, glideBeats: 3 }),
      n('stab', 0, 3, 0.6, { degree: 4, glide: 0.84, glideBeats: 3 }),
      n('choir', 0.05, 5, 0.6, { degree: 0, glide: 0.89, glideBeats: 5 }),
      n('choir', 0.05, 5, 0.5, { degree: 2, glide: 0.89, glideBeats: 5 }),
      n('kick', 4, 1, 0.55),
      n('kick', 4.5, 1, 0.4),
    ],
  },
  /** A boss arrives: impact, tritone + b2 cluster on brass and choir, drums, the sub drops an octave. */
  bossAppear: {
    route: 'game',
    quantize: 'beat',
    maxWait: 0.5,
    gain: 0.95,
    minInterval: 4,
    notes: [
      n('crash', 0, 6, 1),
      n('kick', 0, 1, 1),
      n('sub', 0, 4, 1, { degree: 0, glide: 0.5, glideBeats: 4 }),
      n('stab', 0, 3, 0.9, { degree: 0 }),
      n('stab', 0, 3, 0.7, { degree: 0, semi: 1 }),
      n('stab', 0, 3, 0.7, { degree: 0, semi: 6 }),
      n('choir', 0, 4, 0.7, { degree: 0 }),
      n('choir', 0, 4, 0.6, { degree: 0, semi: 6 }),
      n('dist', 0, 2, 0.8, { degree: 0, octave: -1 }),
      n('tom', 0.5, 0.5, 0.8),
      n('tom', 0.75, 0.5, 0.85),
      n('tom', 1, 0.5, 1),
      n('metal', 0, 3, 0.7),
    ],
  },
  /** The boss falls: impact and a major (picardy) resolution on strings and bells. */
  bossDefeated: {
    route: 'game',
    quantize: 'beat',
    maxWait: 0.5,
    gain: 0.85,
    minInterval: 3,
    notes: [
      n('crash', 0, 5, 0.9),
      n('sub', 0, 4, 0.8, { degree: 0 }),
      n('stab', 0, 3, 0.7, { degree: 0 }),
      n('stab', 0, 3, 0.6, { degree: 0, semi: 4 }),
      n('stab', 0, 3, 0.6, { degree: 4 }),
      n('strings', 0, 4, 0.6, { degree: 0, semi: 4 }),
      n('strings', 0, 4, 0.6, { degree: 7 }),
      n('arp', 0.5, 1, 0.6, { degree: 4 }),
      n('arp', 1, 1, 0.6, { degree: 7 }),
      n('arp', 1.5, 2, 0.6, { degree: 7, semi: 4 }),
    ],
  },
  /** Nuke: the music drops out for a beat under a huge tonic hit. */
  nuke: {
    route: 'game',
    quantize: 'half',
    maxWait: 0.3,
    gain: 0.85,
    minInterval: 1.5,
    drop: { beats: 1.5, gain: 0.15 },
    notes: [
      n('crash', 0, 4, 1),
      n('kick', 0, 1, 1),
      n('sub', 0, 3, 1, { degree: 0, glide: 0.7, glideBeats: 3 }),
      n('stab', 0, 2, 0.9, { degree: 0 }),
      n('stab', 0, 2, 0.8, { degree: 4 }),
      n('stab', 0, 2, 0.7, { degree: 7 }),
      n('dist', 0, 1.5, 0.8, { degree: 0, octave: -1 }),
    ],
  },
  /** Instakill: a sinister b2 ostinato on the arp over a tritone choir stab. */
  instakill: {
    route: 'game',
    quantize: 'half',
    maxWait: 0.3,
    gain: 0.7,
    minInterval: 1.5,
    notes: [
      n('arp', 0, 0.25, 0.8, { degree: 7 }),
      n('arp', 0.25, 0.25, 0.7, { degree: 7, semi: 1 }),
      n('arp', 0.5, 0.25, 0.8, { degree: 7 }),
      n('arp', 0.75, 0.25, 0.7, { degree: 7, semi: 1 }),
      n('arp', 1, 0.25, 0.8, { degree: 7 }),
      n('arp', 1.25, 0.5, 0.7, { degree: 7, semi: 1 }),
      n('choir', 0, 1.5, 0.55, { degree: 0 }),
      n('choir', 0, 1.5, 0.45, { degree: 0, semi: 6 }),
      n('metal', 0, 1, 0.5),
    ],
  },
  /** Level up (M9): a bright rising major-9 bell arpeggio over a glass pad – quiet, on the ui bus. */
  levelUp: {
    route: 'ui',
    quantize: 'none',
    maxWait: 0,
    gain: 0.34,
    minInterval: 1,
    notes: [
      n('arp', 0, 1, 0.7, { degree: 0 }),
      n('arp', 0.25, 1, 0.7, { degree: 2 }),
      n('arp', 0.5, 1, 0.7, { degree: 4 }),
      n('arp', 0.75, 1, 0.75, { degree: 6 }),
      n('arp', 1, 2, 0.8, { degree: 8 }),
      n('pad', 0, 2.5, 0.5, { degree: 0 }),
      n('pad', 0, 2.5, 0.45, { degree: 4 }),
      n('metal', 1, 1.5, 0.5),
    ],
  },
  /** Achievement (M9): a shimmering bell chord; higher tiers ring higher (MUSIC.achievementTierSemis). */
  achievement: {
    route: 'ui',
    quantize: 'none',
    maxWait: 0,
    gain: 0.36,
    minInterval: 0.8,
    notes: [
      n('arp', 0, 2, 0.75, { degree: 0 }),
      n('arp', 0.05, 2, 0.65, { degree: 4 }),
      n('arp', 0.1, 2, 0.6, { degree: 8 }),
      n('arp', 0.5, 2, 0.55, { degree: 9 }),
      n('pad', 0, 2, 0.45, { degree: 0 }),
      n('metal', 0.5, 1.5, 0.45),
    ],
  },
};

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** One layer threshold: switched on at `on`, off again only below `off` (hysteresis). */
export interface LayerThreshold {
  readonly on: number;
  readonly off: number;
}

export interface MusicStatePolicy {
  /** `map`: the map theme, `boss`: the boss theme, `current`: whatever plays, else a theme id. */
  readonly theme: 'map' | 'boss' | 'current' | 'menu';
  readonly route: 'game' | 'menu';
  /** Intensity clamp (a fixed value when min === max). */
  readonly min: number;
  readonly max: number;
  readonly layers: readonly MusicLayer[];
  /** Low-pass over the whole theme (Hz, 0 = open). */
  readonly lowpass: number;
}

export const MUSIC = {
  /** Seed prefix of the composer and the renders: identical music every session. */
  seed: 'riftfall-music',
  /** Unknown map ids play this theme. */
  fallbackTheme: 'lab',
  menuTheme: 'menu',
  bossTheme: 'boss',
  uiTheme: 'ui',
  /** Map id → theme id (M7 maps are ready by id). */
  mapThemes: {
    lab: 'lab',
    testroom: 'testroom',
    arctic: 'arctic',
    biodome: 'biodome',
    reactor: 'reactor',
    orbital: 'orbital',
    rift: 'rift',
  } as Readonly<Record<string, string>>,
  /** M6: boss enemy type → its theme (missing: `bossTheme`). */
  bossThemes: {} as Readonly<Record<string, string>>,

  /**
   * Lookahead sequencer: a timer every `interval` s schedules every note starting before
   * now + `lookahead` on the AudioContext clock (main-thread stalls up to lookahead − interval
   * are inaudible). A hidden tab throttles timers to ~1 s: `hiddenLookahead` then. A timer later
   * than `maxLate` behind the grid skips the missed notes instead of bursting them.
   */
  scheduler: {
    interval: 0.1,
    lookahead: 0.4,
    hiddenLookahead: 1.3,
    maxLate: 0.05,
    /** A new theme starts this long after the request (s). */
    startDelay: 0.06,
    /** While no AudioContext exists yet, check for one this often (s). */
    contextPoll: 0.25,
  },
  /** Voice limits (preallocated slots): per theme player and for stings. `reserve`: slots only important notes may take. */
  voices: { perPlayer: 40, stings: 28, reserve: 6 },

  /** Offline instrument renders (audio/music/instruments.ts). */
  render: {
    /** Bright instruments; `dark` recipes render at `darkRate` (half the memory, nothing lost). */
    sampleRate: 32000,
    darkRate: 22050,
    /** Sustained loops: body length (s) on a 1/loopSeconds Hz grid + crossfade folded into the loop. */
    loopSeconds: 2,
    droneLoopSeconds: 4,
    loopCrossfade: 0.3,
    normalizePeak: 0.9,
    trimThreshold: 0.0005,
    endFade: 0.004,
    /** One-shot render length (s) unless the recipe needs more. */
    oneShotSeconds: 1.2,
    /** Parallel offline renders. */
    concurrency: 2,
    /** Pitched samples are rendered every `rootSpacing` semitones over the slot's range (±6 → ≤ a tritone of resampling). */
    rootSpacing: 12,
    noiseSeconds: 4,
  },

  /** Registers per slot (MIDI) – voicings, bass lines and melodies stay inside. */
  ranges: {
    bass: [28, 52],
    sub: [24, 47],
    dist: [33, 57],
    pad: [50, 74],
    strings: [55, 79],
    choir: [50, 74],
    arp: [62, 86],
    lead: [62, 86],
    stab: [48, 72],
    drone: [26, 49],
  } as Readonly<Record<string, readonly [number, number]>>,

  /** Live envelope of sustained voices (s). */
  envelopes: {
    drone: { attack: 2, release: 2.5 },
    pad: { attack: 0.9, release: 1.6 },
    strings: { attack: 0.35, release: 0.9 },
    choir: { attack: 0.8, release: 1.4 },
    lead: { attack: 0.06, release: 0.25 },
    sub: { attack: 0.02, release: 0.12 },
    /** One-shots cut before their end (staccato bass, choked hats). */
    cut: 0.03,
  } as const,

  mix: {
    /** Everything the music system plays (before the engine's music volume and master). */
    master: 0.5,
    layers: { ambient: 0.9, low: 0.9, mid: 0.85, high: 0.8, peak: 0.85 } satisfies Record<MusicLayer, number>,
    /** Tempo-synced ping-pong echo per theme (space for arps and leads, no convolver). */
    echo: {
      beats: 0.75,
      feedback: 0.38,
      damp: 2600,
      wet: 0.55,
      send: { ambient: 0.12, low: 0, mid: 0.05, high: 0.4, peak: 0.08 } satisfies Record<MusicLayer, number>,
    },
    /** The player's own gunfire ducks the music a little (gunfire stays dominant). */
    fireDuck: { gain: 0.72, attack: 0.02, release: 0.45 },
    /** Velocity → gain: vel^curve. */
    velocityCurve: 1.6,
    /** Cosmetic humanization: timing (s) and velocity (±) of non-drum notes. */
    humanize: { time: 0.006, velocity: 0.08 },
  },

  layers: {
    thresholds: {
      ambient: { on: 0, off: -1 },
      low: { on: 0.16, off: 0.1 },
      mid: { on: 0.36, off: 0.27 },
      high: { on: 0.54, off: 0.44 },
      peak: { on: 0.8, off: 0.7 },
    } satisfies Record<MusicLayer, LayerThreshold>,
    /** A layer that changed stays at least this many bars before it may change back. */
    minBars: 2,
    /** Layer fades (beats) from the bar line. */
    fadeInBeats: 2,
    fadeOutBeats: 4,
    /** A layer just above its threshold plays at this share, full `span` above it. */
    partialGain: 0.7,
    span: 0.25,
  },

  /**
   * Built-in intensity model (until the M6 spawn director sets it): living enemies near the player
   * (weighted by distance, type and elite), recent damage, kills per second, low health and the
   * wave clock – smoothed (fast rise, slow fall).
   */
  intensity: {
    /** Enemy polling (s, game time). */
    pollInterval: 0.25,
    /** Enemies within `radius` m count, fully within `near` m. */
    radius: 24,
    near: 7,
    /** Threat of one enemy per type (unknown: 1), elites ×elite. */
    typeWeight: { swarmer: 0.6, spitter: 1, tank: 2.4 } as Readonly<Record<string, number>>,
    eliteWeight: 2,
    /** Threat → intensity: 1 − exp(−threat / threatScale), times `threat` below. */
    threatScale: 4,
    weights: { threat: 0.55, damage: 0.3, kills: 0.2, health: 0.2 },
    /** Damage (HP) decays with this half-life (s); `fullDamage` HP within it = full damage term. */
    damageHalfLife: 4,
    fullDamage: 45,
    /** Kill rate (EMA time constant s) and the rate (kills/s) that saturates the term. */
    killTau: 3,
    fullKillRate: 1.5,
    /** Health below this fraction raises intensity (and darkens the mix, `danger`). */
    lowHealth: 0.35,
    /** Wave start push: +start decaying over `startSeconds`; base per wave number up to `perWaveMax`. */
    wave: { start: 0.35, startSeconds: 18, perWave: 0.02, perWaveMax: 0.2 },
    /** Smoothing time constants (s): rise fast, fall slowly; director values are trusted more. */
    riseTau: 1.2,
    fallTau: 7,
    directorTau: 0.6,
    /** A director value older than this (s, game time) is ignored – the model takes over again. */
    directorTimeout: 5,
  },

  /** Low health darkens the game-route mix: low-pass towards `cutoff` (Hz) as health falls. */
  danger: { cutoff: 1400, open: 20000, response: 0.6 },

  states: {
    off: { theme: 'current', route: 'game', min: 0, max: 0, layers: [], lowpass: 0 },
    menu: {
      theme: 'menu',
      route: 'menu',
      min: 0.62,
      max: 0.62,
      layers: ['ambient', 'low', 'mid', 'high'],
      lowpass: 0,
    },
    intermission: {
      theme: 'map',
      route: 'game',
      min: 0,
      max: 0.3,
      layers: ['ambient', 'low', 'mid', 'high', 'peak'],
      lowpass: 0,
    },
    wave: {
      theme: 'map',
      route: 'game',
      min: 0.18,
      max: 1,
      layers: ['ambient', 'low', 'mid', 'high', 'peak'],
      lowpass: 0,
    },
    boss: {
      theme: 'boss',
      route: 'game',
      min: 0.72,
      max: 1,
      layers: ['ambient', 'low', 'mid', 'high', 'peak'],
      lowpass: 0,
    },
    gameover: {
      theme: 'current',
      route: 'menu',
      min: 0.05,
      max: 0.05,
      layers: ['ambient'],
      lowpass: 480,
    },
  } satisfies Record<MusicState, MusicStatePolicy>,

  /** Crossfades (s): theme changes, route moves (game ↔ menu), the whole music on/off. */
  fades: { theme: 1.6, themeIn: 0.8, route: 0.8, stop: 0.5, filter: 1.2 },

  /** Per-id minimum spacing plus a global token bucket (bursts of achievements at the run's end). */
  stingLimit: { burst: 3, refillPerSecond: 0.5 },
  /** Achievement sting transposition per tier (semitones). */
  achievementTierSemis: { bronze: 0, silver: 2, gold: 4, platinum: 7 } satisfies Record<AchievementTier, number>,
  /** Wave starts of special kinds (swarm / tank waves) are transposed (semitones). */
  specialWaveSemis: -2,

  /** Music is off (no scheduler, no renders) below this master × music volume. */
  minVolume: 0.001,
} as const;

/**
 * Positional hint cues (M10, audio/music/cues.ts): a distinct tell where an elite emerges or first
 * notices the player, and the generic boss cue (M6 bosses: `bossCues` per type). Rendered once,
 * registered in the audio engine (HRTF, sfx bus, voice-limited); rate limited per kind.
 */
export const MUSIC_CUES = {
  elite: {
    spawn: { id: 'enemy.elite.hint', gain: 0.8, maxDistance: 70, minInterval: 0.6 },
    alert: { id: 'enemy.elite.alert', gain: 0.7, maxDistance: 60, minInterval: 0.4 },
    pitchVariance: 0.03,
    /** Elite ids remembered (spawn → alert); beyond this the oldest are forgotten. */
    maxTracked: 64,
  },
  boss: { id: 'enemy.boss.hint', gain: 1, maxDistance: 160, minInterval: 2 },
  bossCues: {} as Readonly<Record<string, string>>,
} as const;
