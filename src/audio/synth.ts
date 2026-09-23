/**
 * Procedural sound effects, rendered once per sample rate with OfflineAudioContext and cached.
 *
 * Every sound is layered from a few building blocks – filtered noise bursts (texture), pitched
 * sine glides (weight/punch), inharmonic partial rings (metal) and soft saturation – each with
 * its own envelope. Variants of one id are rendered in a single offline pass, seeded with Rng
 * (`AUDIO.synth.seed:id:variant`), so the results are identical every session.
 *
 * The frequencies/levels inside the recipes are sound-design constants (like shader constants);
 * global synth tuning (variants, normalization, loop length) lives in AUDIO.synth.
 */
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import {
  audibleLength,
  fadeOutTail,
  fillBrown,
  fillPink,
  fillWhite,
  makeLoopable,
  normalizeChannels,
  normalizeRms,
} from './dsp';
import { WEAPON_SYNTH_DEFS, weaponSynthAlias } from './weaponSynth';

const log = createLogger('Synth');
const S = AUDIO.synth;

type NoiseColor = 'white' | 'pink' | 'brown';
type NoiseTables = Record<NoiseColor, AudioBuffer>;

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/** Octaves between the lowest audible frequency and Nyquist (spectral span of the noise tables). */
const AUDIBLE_LOW_HZ = 20;
/** RMS of uniform noise in [-1, 1]. */
const WHITE_NOISE_RMS = 1 / Math.sqrt(3);
const MAX_NOISE_COMPENSATION = 6;

/**
 * Gain that makes a filtered noise burst about as loud as the unfiltered table: a filter keeps
 * only part of the spectrum (white noise: a share of the bandwidth in Hz; pink: a share of the
 * octaves), so without this, narrow noise layers vanish next to sine layers of equal `peak`.
 * Pure – exported for tests.
 */
export function noiseCompensation(
  color: NoiseColor,
  filter: BiquadFilterType,
  freq: number,
  q: number,
  nyquist: number,
): number {
  if (color === 'brown') return 1;
  const f = Math.min(Math.max(freq, AUDIBLE_LOW_HZ * 2), nyquist * 0.98);
  let share: number;
  if (color === 'white') {
    if (filter === 'bandpass') share = Math.min(nyquist, f / Math.max(0.1, q)) / nyquist;
    else if (filter === 'lowpass') share = f / nyquist;
    else if (filter === 'highpass') share = (nyquist - f) / nyquist;
    else share = 1;
  } else {
    const span = Math.log2(nyquist / AUDIBLE_LOW_HZ);
    // Bandpass bandwidth in octaves for a given Q.
    if (filter === 'bandpass') share = (2 * Math.asinh(1 / (2 * Math.max(0.1, q)))) / Math.LN2 / span;
    else if (filter === 'lowpass') share = Math.log2(f / AUDIBLE_LOW_HZ) / span;
    else if (filter === 'highpass') share = Math.log2(nyquist / f) / span;
    else share = 1;
  }
  return Math.min(MAX_NOISE_COMPENSATION, Math.max(1, Math.sqrt(1 / Math.max(1e-3, Math.min(1, share)))));
}

interface HitOptions {
  color: NoiseColor;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  /** Exponential filter sweep target over the decay. */
  sweepTo?: number;
  attack?: number;
  decay: number;
  peak: number;
  pan?: number;
  rate?: number;
}

export class SynthGraph {
  constructor(
    readonly ctx: OfflineAudioContext,
    private readonly out: AudioNode,
    readonly rng: Rng,
    private readonly noise: NoiseTables,
  ) {}

  /** Multiplier 1 ± amount (per-variant humanization). */
  jitter(amount: number): number {
    return 1 + (this.rng.next() * 2 - 1) * amount;
  }

  /** Chain nodes and route the last one to the output (optionally panned in stereo renders). */
  private route(nodes: AudioNode[], pan = 0): void {
    for (let i = 0; i < nodes.length - 1; i++) (nodes[i] as AudioNode).connect(nodes[i + 1] as AudioNode);
    let last = nodes[nodes.length - 1] as AudioNode;
    if (pan !== 0 && this.ctx.destination.channelCount > 1) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      last.connect(p);
      last = p;
    }
    last.connect(this.out);
  }

  private envelope(t: number, attack: number, decay: number, peak: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    // ~-35 dB after `decay` seconds.
    g.gain.setTargetAtTime(0, t + attack, decay / 4);
    return g;
  }

  private noiseSource(color: NoiseColor, t: number, dur: number, rate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    const buf = this.noise[color];
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t, this.rng.next() * buf.duration * 0.9);
    src.stop(t + dur);
    return src;
  }

  /** Filtered noise burst. `peak` is bandwidth-compensated (see noiseCompensation). */
  hit(t: number, o: HitOptions): void {
    const attack = o.attack ?? 0.001;
    const dur = attack + o.decay * 1.3;
    const q = o.q ?? 0.707;
    const src = this.noiseSource(o.color, t, dur, o.rate ?? 1);
    const f = this.ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + dur);
    f.Q.value = q;
    const gain = o.peak * noiseCompensation(o.color, o.filter, o.freq, q, this.ctx.sampleRate / 2);
    this.route([src, f, this.envelope(t, attack, o.decay, gain)], o.pan ?? 0);
  }

  /** Sustained filtered noise (flat level) – loop textures. Returns the filter for modulation. */
  bed(
    t: number,
    dur: number,
    color: NoiseColor,
    filter: BiquadFilterType,
    freq: number,
    q: number,
    level: number,
    pan = 0,
  ): BiquadFilterNode {
    const src = this.noiseSource(color, t, dur);
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = level;
    this.route([src, f, g], pan);
    return f;
  }

  /** Pitched glide (kick-drum style body). `drive` > 0 adds tanh saturation for grit. */
  thump(
    t: number,
    f0: number,
    f1: number,
    decay: number,
    peak: number,
    drive = 0,
    type: OscillatorType = 'sine',
  ): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + decay);
    o.start(t);
    o.stop(t + decay * 1.4 + 0.01);
    const nodes: AudioNode[] = [o];
    if (drive > 0) nodes.push(this.shaper(drive));
    nodes.push(this.envelope(t, 0.002, decay, peak));
    this.route(nodes);
  }

  /** Inharmonic partials – struck metal. Higher partials decay faster. */
  ring(t: number, base: number, ratios: readonly number[], decay: number, peak: number): void {
    ratios.forEach((ratio, i) => {
      const o = this.ctx.createOscillator();
      o.frequency.value = base * ratio * this.jitter(0.01);
      o.start(t);
      const d = decay / (1 + i * 0.5);
      o.stop(t + d * 1.4 + 0.01);
      this.route([o, this.envelope(t, 0.001, d, peak / (1 + i * 0.6))]);
    });
  }

  /** Band-limited oscillator sweep (sci-fi zaps, UI blips). */
  tone(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    attack: number,
    decay: number,
    peak: number,
    lowpass = 0,
  ): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    o.start(t);
    o.stop(t + attack + decay * 1.4 + 0.01);
    const nodes: AudioNode[] = [o];
    if (lowpass > 0) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      nodes.push(f);
    }
    nodes.push(this.envelope(t, attack, decay, peak));
    this.route(nodes);
  }

  shaper(drive: number): WaveShaperNode {
    const n = 1024;
    const curve = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    const ws = this.ctx.createWaveShaper();
    ws.curve = curve;
    ws.oversample = '2x';
    return ws;
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

type Recipe = (g: SynthGraph, t: number) => void;

export interface SynthDef {
  readonly variants: number;
  /** Seconds rendered per variant (one-shots are trimmed afterwards). */
  readonly duration: number;
  readonly channels: 1 | 2;
  /** Relative peak level after normalization. */
  readonly level: number;
  readonly loop?: boolean;
  readonly recipe: Recipe;
}

interface SurfaceVoice {
  body: { color: NoiseColor; freq: number; q: number; decay: number; peak: number };
  click: { freq: number; decay: number; peak: number };
  thump: { f0: number; f1: number; decay: number; peak: number };
  /** Delay of the softer toe-roll layer after the heel strike. */
  toe: number;
  ring?: { base: number; ratios: readonly number[]; decay: number; peak: number };
  grit?: { freq: number; decay: number; peak: number };
  rattle?: { count: number; span: number; freq: number; peak: number };
}

const SURFACE_VOICES: Record<'metal' | 'concrete' | 'grate' | 'rubber' | 'default', SurfaceVoice> = {
  metal: {
    body: { color: 'white', freq: 1900, q: 1.5, decay: 0.07, peak: 0.5 },
    click: { freq: 4200, decay: 0.012, peak: 0.55 },
    thump: { f0: 125, f1: 58, decay: 0.07, peak: 0.42 },
    toe: 0.045,
    ring: { base: 430, ratios: [1, 2.76, 5.4, 8.93], decay: 0.22, peak: 0.1 },
  },
  concrete: {
    body: { color: 'pink', freq: 950, q: 1.1, decay: 0.06, peak: 0.6 },
    click: { freq: 2800, decay: 0.01, peak: 0.45 },
    thump: { f0: 105, f1: 52, decay: 0.07, peak: 0.42 },
    toe: 0.05,
    grit: { freq: 3400, decay: 0.05, peak: 0.16 },
  },
  grate: {
    body: { color: 'white', freq: 2600, q: 2.4, decay: 0.05, peak: 0.42 },
    click: { freq: 4600, decay: 0.01, peak: 0.5 },
    thump: { f0: 120, f1: 60, decay: 0.06, peak: 0.36 },
    toe: 0.04,
    ring: { base: 1250, ratios: [1, 1.93, 3.31], decay: 0.1, peak: 0.07 },
    rattle: { count: 5, span: 0.075, freq: 3600, peak: 0.32 },
  },
  rubber: {
    body: { color: 'pink', freq: 420, q: 0.8, decay: 0.07, peak: 0.75 },
    click: { freq: 1800, decay: 0.008, peak: 0.14 },
    thump: { f0: 88, f1: 45, decay: 0.085, peak: 0.5 },
    toe: 0.055,
  },
  default: {
    body: { color: 'pink', freq: 800, q: 1, decay: 0.06, peak: 0.6 },
    click: { freq: 2400, decay: 0.01, peak: 0.35 },
    thump: { f0: 105, f1: 55, decay: 0.07, peak: 0.42 },
    toe: 0.05,
  },
};

function footstep(surface: keyof typeof SURFACE_VOICES): Recipe {
  const s = SURFACE_VOICES[surface];
  return (g, t0) => {
    const t = t0 + g.rng.next() * 0.004;
    const tone = g.jitter(0.08);
    // Heel strike: transient + body + weight.
    g.hit(t, {
      color: 'white',
      filter: 'highpass',
      freq: s.click.freq * tone,
      decay: s.click.decay,
      peak: s.click.peak * g.jitter(0.15),
    });
    g.hit(t, {
      color: s.body.color,
      filter: 'bandpass',
      freq: s.body.freq * tone,
      q: s.body.q,
      attack: 0.002,
      decay: s.body.decay * g.jitter(0.15),
      peak: s.body.peak * g.jitter(0.1),
    });
    g.thump(t, s.thump.f0 * g.jitter(0.1), s.thump.f1, s.thump.decay, s.thump.peak * g.jitter(0.1));
    // Toe roll: softer, slightly brighter second contact.
    const toe = t + s.toe * g.jitter(0.2);
    g.hit(toe, {
      color: s.body.color,
      filter: 'bandpass',
      freq: s.body.freq * tone * 1.25,
      q: s.body.q,
      attack: 0.003,
      decay: s.body.decay * 0.7,
      peak: s.body.peak * 0.35 * g.jitter(0.2),
    });
    if (s.ring)
      g.ring(
        t,
        s.ring.base * g.jitter(0.12),
        s.ring.ratios,
        s.ring.decay * g.jitter(0.15),
        s.ring.peak * g.jitter(0.2),
      );
    if (s.grit) {
      g.hit(t + 0.004, {
        color: 'white',
        filter: 'bandpass',
        freq: s.grit.freq * tone,
        q: 0.7,
        decay: s.grit.decay,
        peak: s.grit.peak * g.jitter(0.25),
      });
    }
    if (s.rattle) {
      for (let i = 0; i < s.rattle.count; i++) {
        const dt = 0.006 + g.rng.next() * s.rattle.span;
        const fade = 1 - dt / (s.rattle.span * 1.2);
        g.hit(t + dt, {
          color: 'white',
          filter: 'bandpass',
          freq: s.rattle.freq * g.jitter(0.25),
          q: 6,
          decay: 0.012,
          peak: s.rattle.peak * fade * g.jitter(0.3),
        });
      }
    }
  };
}

const jump: Recipe = (g, t) => {
  // Push-off scuff + a short upward air whoosh.
  g.hit(t, { color: 'white', filter: 'highpass', freq: 2600, decay: 0.01, peak: 0.35 });
  g.hit(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 900 * g.jitter(0.1),
    q: 1.1,
    attack: 0.002,
    decay: 0.05,
    peak: 0.5,
  });
  g.thump(t, 140 * g.jitter(0.08), 80, 0.07, 0.45);
  g.hit(t + 0.015, {
    color: 'pink',
    filter: 'bandpass',
    freq: 450,
    sweepTo: 1700 * g.jitter(0.1),
    q: 0.9,
    attack: 0.035,
    decay: 0.15,
    peak: 0.4,
  });
};

const jumpDouble: Recipe = (g, t) => {
  // Boot thruster: resonant noise sweep down, sub kick, a bright zap and a hiss tail.
  g.hit(t, {
    color: 'white',
    filter: 'bandpass',
    freq: 2400 * g.jitter(0.1),
    sweepTo: 520,
    q: 1.6,
    attack: 0.004,
    decay: 0.2,
    peak: 0.8,
  });
  g.thump(t, 125 * g.jitter(0.08), 42, 0.2, 0.5, 1.5);
  g.tone(t, 'sawtooth', 950 * g.jitter(0.08), 240, 0.002, 0.11, 0.14, 2600);
  g.hit(t + 0.02, { color: 'white', filter: 'highpass', freq: 4200, attack: 0.01, decay: 0.24, peak: 0.12 });
};

const land: Recipe = (g, t) => {
  g.thump(t, 92 * g.jitter(0.1), 40, 0.14, 0.55, 0.8);
  g.hit(t, { color: 'pink', filter: 'lowpass', freq: 1300 * g.jitter(0.15), decay: 0.08, peak: 0.8 });
  g.hit(t, { color: 'white', filter: 'highpass', freq: 3000, decay: 0.012, peak: 0.45 });
  g.hit(t + 0.012, {
    color: 'white',
    filter: 'bandpass',
    freq: 2100 * g.jitter(0.2),
    q: 1,
    decay: 0.12,
    peak: 0.3,
  });
};

const landHeavy: Recipe = (g, t) => {
  g.thump(t, 72 * g.jitter(0.08), 27, 0.36, 0.7, 2.6);
  g.hit(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 2100,
    sweepTo: 500,
    attack: 0.002,
    decay: 0.16,
    peak: 1.1,
  });
  g.hit(t, { color: 'white', filter: 'highpass', freq: 2500, decay: 0.016, peak: 0.55 });
  g.ring(t, 176 * g.jitter(0.1), [1, 2.41, 4.07, 6.3], 0.6, 0.2);
  for (let i = 0; i < 6; i++) {
    const dt = 0.03 + g.rng.next() * 0.28;
    g.hit(t + dt, {
      color: 'white',
      filter: 'bandpass',
      freq: 3000 * g.jitter(0.3),
      q: 3,
      decay: 0.02,
      peak: 0.25 * (1 - dt),
    });
  }
};

const slide: Recipe = (g, t) => {
  const dur = S.slideLoopSeconds + S.slideLoopCrossfade;
  // Friction band that wanders (surface irregularities), left/right decorrelated.
  for (const pan of [-0.55, 0.55]) {
    const f = g.bed(t, dur, 'pink', 'bandpass', 1150, 0.9, 0.8, pan);
    for (let k = 0; k <= Math.ceil(dur / 0.18); k++) {
      f.frequency.linearRampToValueAtTime(1150 * g.jitter(0.3), t + k * 0.18);
    }
  }
  g.bed(t, dur, 'brown', 'lowpass', 260, 0.7, 0.35);
  g.bed(t, dur, 'white', 'highpass', 5200, 0.7, 0.05);
  // Sparse grit ticks.
  const ticks = Math.round(dur * 14);
  for (let i = 0; i < ticks; i++) {
    g.hit(t + g.rng.next() * (dur - 0.02), {
      color: 'white',
      filter: 'bandpass',
      freq: 3200 * g.jitter(0.35),
      q: 4,
      decay: 0.008,
      peak: 0.12 * g.jitter(0.5),
      pan: g.rng.next() * 1.2 - 0.6,
    });
  }
};

const dash: Recipe = (g, t) => {
  // Two panned resonant sweeps = wide whoosh, plus a sub kick and a sharp onset.
  g.hit(t, {
    color: 'white',
    filter: 'bandpass',
    freq: 3600 * g.jitter(0.1),
    sweepTo: 430,
    q: 2.2,
    attack: 0.012,
    decay: 0.26,
    peak: 0.7,
    pan: -0.4,
  });
  g.hit(t + 0.006, {
    color: 'white',
    filter: 'bandpass',
    freq: 3200 * g.jitter(0.1),
    sweepTo: 480,
    q: 2,
    attack: 0.014,
    decay: 0.24,
    peak: 0.6,
    pan: 0.4,
  });
  g.thump(t, 96 * g.jitter(0.08), 34, 0.2, 0.6, 1.2);
  g.hit(t, { color: 'white', filter: 'highpass', freq: 6000, decay: 0.008, peak: 0.5 });
  g.tone(t, 'triangle', 420, 1300 * g.jitter(0.1), 0.01, 0.12, 0.08);
};

const mantle: Recipe = (g, t) => {
  // Hand grabs the edge (metal clank), body scrapes over, feet thump down.
  g.hit(t, { color: 'white', filter: 'highpass', freq: 2600, decay: 0.018, peak: 0.55 });
  g.ring(t, 610 * g.jitter(0.1), [1, 2.32, 3.89], 0.14, 0.12);
  g.hit(t + 0.05, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1400 * g.jitter(0.1),
    sweepTo: 850,
    q: 1.2,
    attack: 0.03,
    decay: 0.18,
    peak: 0.32,
  });
  const land2 = t + 0.23 * g.jitter(0.1);
  g.thump(land2, 105, 58, 0.08, 0.55);
  g.hit(land2, { color: 'pink', filter: 'lowpass', freq: 1100, decay: 0.05, peak: 0.35 });
};

const uiClick: Recipe = (g, t) => {
  g.tone(t, 'sine', 2100, 1450, 0.001, 0.03, 0.55);
  g.hit(t, { color: 'white', filter: 'highpass', freq: 5000, decay: 0.004, peak: 0.4 });
};

const uiHover: Recipe = (g, t) => {
  g.tone(t, 'triangle', 3200, 3000, 0.001, 0.016, 0.35);
};

const uiBack: Recipe = (g, t) => {
  g.tone(t, 'triangle', 900, 860, 0.002, 0.04, 0.45, 3000);
  g.tone(t + 0.055, 'triangle', 610, 560, 0.002, 0.055, 0.45, 3000);
};

const hurt: Recipe = (g, t) => {
  // Short distorted body hit with a low "grunt" band.
  g.thump(t, 78 * g.jitter(0.1), 38, 0.22, 0.6, 4);
  g.hit(t, { color: 'pink', filter: 'lowpass', freq: 900 * g.jitter(0.15), decay: 0.1, peak: 0.8 });
  g.hit(t + 0.004, {
    color: 'pink',
    filter: 'bandpass',
    freq: 320 * g.jitter(0.12),
    q: 2,
    attack: 0.008,
    decay: 0.12,
    peak: 0.8,
  });
  g.hit(t, { color: 'white', filter: 'highpass', freq: 3500, decay: 0.01, peak: 0.25 });
};

export const SYNTH_DEFS = {
  'footstep.metal': {
    variants: S.footstepVariants,
    duration: 0.34,
    channels: 1,
    level: 1,
    recipe: footstep('metal'),
  },
  'footstep.concrete': {
    variants: S.footstepVariants,
    duration: 0.22,
    channels: 1,
    level: 1,
    recipe: footstep('concrete'),
  },
  'footstep.grate': {
    variants: S.footstepVariants,
    duration: 0.24,
    channels: 1,
    level: 1,
    recipe: footstep('grate'),
  },
  'footstep.rubber': {
    variants: S.footstepVariants,
    duration: 0.2,
    channels: 1,
    level: 0.9,
    recipe: footstep('rubber'),
  },
  'footstep.default': {
    variants: S.footstepVariants,
    duration: 0.22,
    channels: 1,
    level: 1,
    recipe: footstep('default'),
  },
  jump: { variants: 3, duration: 0.3, channels: 1, level: 0.9, recipe: jump },
  'jump.double': { variants: 3, duration: 0.4, channels: 1, level: 1, recipe: jumpDouble },
  land: { variants: 3, duration: 0.28, channels: 1, level: 1, recipe: land },
  'land.heavy': { variants: 2, duration: 0.75, channels: 1, level: 1, recipe: landHeavy },
  slide: {
    variants: 1,
    duration: S.slideLoopSeconds + S.slideLoopCrossfade,
    channels: 2,
    level: 0.8,
    loop: true,
    recipe: slide,
  },
  dash: { variants: 3, duration: 0.42, channels: 2, level: 1, recipe: dash },
  mantle: { variants: 2, duration: 0.4, channels: 1, level: 0.9, recipe: mantle },
  'ui.click': { variants: 1, duration: 0.06, channels: 1, level: 0.8, recipe: uiClick },
  'ui.hover': { variants: 1, duration: 0.04, channels: 1, level: 0.5, recipe: uiHover },
  'ui.back': { variants: 1, duration: 0.14, channels: 1, level: 0.8, recipe: uiBack },
  hurt: { variants: 3, duration: 0.34, channels: 1, level: 1, recipe: hurt },
  // Weapons, impacts, casings, hit feedback (audio/weaponSynth.ts) – rendered after movement.
  ...WEAPON_SYNTH_DEFS,
} as const satisfies Record<string, SynthDef>;

export type SynthId = keyof typeof SYNTH_DEFS;

export const SYNTH_IDS = Object.keys(SYNTH_DEFS) as readonly SynthId[];

/**
 * Synth id for a sound id: exact match, a weapon-sound alias (weaponSynth.ts), or `footstep.default`
 * for unknown surfaces; null otherwise.
 */
export function resolveSynthId(id: string): SynthId | null {
  if (Object.prototype.hasOwnProperty.call(SYNTH_DEFS, id)) return id as SynthId;
  const alias = weaponSynthAlias(id);
  if (alias) return alias;
  if (id.startsWith('footstep.')) return 'footstep.default';
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function createNoiseTables(ctx: BaseAudioContext, sampleRate: number): NoiseTables {
  const length = Math.round(S.noiseSeconds * sampleRate);
  const make = (
    fill: (out: Float32Array<ArrayBuffer>, rng: Rng) => Float32Array<ArrayBuffer>,
    name: string,
  ): AudioBuffer => {
    // Equal RMS for every color (that of uniform white noise), so layer levels mean the same thing.
    const data = normalizeRms(
      fill(new Float32Array(length), new Rng(`${S.seed}:noise:${name}`)),
      WHITE_NOISE_RMS,
    );
    const buf = ctx.createBuffer(1, length, sampleRate);
    buf.copyToChannel(data, 0);
    return buf;
  };
  return { white: make(fillWhite, 'white'), pink: make(fillPink, 'pink'), brown: make(fillBrown, 'brown') };
}

async function renderDef(
  id: SynthId,
  def: SynthDef,
  sampleRate: number,
  noise: () => NoiseTables,
): Promise<AudioBuffer[]> {
  const slot = def.duration + S.variantGap;
  const slotSamples = Math.ceil(slot * sampleRate);
  const ctx = new OfflineAudioContext(def.channels, slotSamples * def.variants, sampleRate);
  const bus = ctx.createGain();
  bus.connect(ctx.destination);
  const tables = noise();
  for (let v = 0; v < def.variants; v++) {
    def.recipe(new SynthGraph(ctx, bus, new Rng(`${S.seed}:${id}:${v}`), tables), v * slot);
  }
  const rendered = await ctx.startRendering();

  const buffers: AudioBuffer[] = [];
  for (let v = 0; v < def.variants; v++) {
    let chans: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < def.channels; c++) {
      chans.push(
        rendered
          .getChannelData(c)
          .slice(v * slotSamples, v * slotSamples + Math.ceil(def.duration * sampleRate)),
      );
    }
    if (def.loop) {
      chans = makeLoopable(chans, Math.round(S.slideLoopCrossfade * sampleRate));
    } else {
      const len = audibleLength(chans, S.trimThreshold);
      chans = chans.map((ch) => ch.slice(0, len));
      fadeOutTail(chans, Math.round(S.endFade * sampleRate));
    }
    normalizeChannels(chans, S.normalizePeak * def.level);
    const first = chans[0] as Float32Array<ArrayBuffer>;
    const buf = ctx.createBuffer(def.channels, first.length, sampleRate);
    chans.forEach((ch, c) => buf.copyToChannel(ch, c));
    buffers.push(buf);
  }
  return buffers;
}

/**
 * Lazily rendered, cached procedural sounds for one sample rate. `get()` never blocks: it returns
 * null (and starts rendering) until the buffers exist; `renderAll()` warms everything up front.
 */
export class SynthBank {
  private readonly buffers = new Map<SynthId, readonly AudioBuffer[]>();
  private readonly pending = new Map<SynthId, Promise<readonly AudioBuffer[] | null>>();
  private noise: NoiseTables | null = null;
  readonly supported = typeof OfflineAudioContext !== 'undefined';

  constructor(readonly sampleRate: number) {
    if (!this.supported) log.warn('OfflineAudioContext unavailable – procedural sounds disabled');
  }

  has(id: string): boolean {
    return resolveSynthId(id) !== null;
  }

  isLoop(id: string): boolean {
    const key = resolveSynthId(id);
    return key !== null && (SYNTH_DEFS[key] as SynthDef).loop === true;
  }

  /** Rendered variants, or null while rendering / when unknown. */
  get(id: string): readonly AudioBuffer[] | null {
    const key = resolveSynthId(id);
    if (!key) return null;
    const ready = this.buffers.get(key);
    if (ready) return ready;
    void this.render(key);
    return null;
  }

  render(id: string): Promise<readonly AudioBuffer[] | null> {
    const key = resolveSynthId(id);
    if (!key || !this.supported) return Promise.resolve(null);
    const ready = this.buffers.get(key);
    if (ready) return Promise.resolve(ready);
    let p = this.pending.get(key);
    if (!p) {
      p = renderDef(key, SYNTH_DEFS[key], this.sampleRate, () => this.getNoise())
        .then((bufs) => {
          this.buffers.set(key, bufs);
          return bufs as readonly AudioBuffer[];
        })
        .catch((err: unknown) => {
          log.error(`Rendering "${key}" failed`, err);
          return null;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /** Render every sound (limited parallelism, in SYNTH_IDS order: movement first). */
  async renderAll(): Promise<void> {
    if (!this.supported) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < SYNTH_IDS.length) await this.render(SYNTH_IDS[next++] as SynthId);
    };
    await Promise.all(Array.from({ length: S.renderConcurrency }, worker));
    if (typeof performance !== 'undefined') {
      log.debug(
        `Rendered ${SYNTH_IDS.length} procedural sounds in ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
  }

  private getNoise(): NoiseTables {
    // AudioBuffers are context independent; one throwaway 1-frame context creates the shared tables.
    this.noise ??= createNoiseTables(new OfflineAudioContext(1, 1, this.sampleRate), this.sampleRate);
    return this.noise;
  }
}
