/**
 * Procedural enemy, rift and run-flow sounds (M3). Same scheme as weaponSynth.ts: SynthDefs that
 * the procedural bank renders once per sample rate with OfflineAudioContext (several seeded
 * variants per id), cached, and overridden by real audio assets registered under the same id.
 * synth.ts merges ENEMY_SYNTH_DEFS into SYNTH_DEFS and resolves ENEMY_SYNTH_ALIASES (see the
 * integration note in the M3 report); recipes only use `g.ctx` / `g.rng`, so this module needs no
 * runtime import of synth.ts (no cycle).
 *
 * Biomechanical creature voices are built like a vocal tract: a buzzy source (detuned saws with a
 * pitch contour, FM vibrato, AM "growl" flutter) through parallel formant band-passes and a soft
 * saturator, plus breath noise. Around that: chitin clicks (swarmer), wet bubbles and slime
 * (spitter), sub thumps and debris (tank), and rift tears (reverse noise swells, crackle, a low
 * boom). Positional sounds are mono (HRTF panner input); the musical stings are stereo.
 *
 * Frequencies, levels and times inside the recipes are sound-design constants (like shader
 * constants); how sounds are triggered, budgeted and mixed lives in AUDIO.enemies / AUDIO.stings.
 */
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { fillBrown, fillPink, fillWhite, normalizeRms } from './dsp';
import type { SynthDef, SynthGraph } from './synth';

type Recipe = SynthDef['recipe'];
type NoiseColor = 'white' | 'pink' | 'brown';
type NoiseTables = Record<NoiseColor, AudioBuffer>;

const S = AUDIO.synth;
/** RMS of uniform white noise in [-1, 1] – every noise table is normalized to it. */
const WHITE_NOISE_RMS = 1 / Math.sqrt(3);

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

const noiseCache = new Map<number, NoiseTables>();

function noiseTables(ctx: BaseAudioContext): NoiseTables {
  const rate = ctx.sampleRate;
  let t = noiseCache.get(rate);
  if (!t) {
    const length = Math.round(S.noiseSeconds * rate);
    const make = (
      fill: (out: Float32Array<ArrayBuffer>, rng: Rng) => Float32Array<ArrayBuffer>,
      name: string,
    ): AudioBuffer => {
      const data = normalizeRms(
        fill(new Float32Array(length), new Rng(`${S.seed}:enemy-noise:${name}`)),
        WHITE_NOISE_RMS,
      );
      const buf = ctx.createBuffer(1, length, rate);
      buf.copyToChannel(data, 0);
      return buf;
    };
    t = { white: make(fillWhite, 'white'), pink: make(fillPink, 'pink'), brown: make(fillBrown, 'brown') };
    noiseCache.set(rate, t);
  }
  return t;
}

const shaperCurves = new Map<number, Float32Array<ArrayBuffer>>();

function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const key = Math.round(drive * 100);
  let c = shaperCurves.get(key);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(drive * x) / norm;
    }
    shaperCurves.set(key, c);
  }
  return c;
}

interface NoiseOpts {
  color: NoiseColor;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  sweepTo?: number;
  attack?: number;
  decay: number;
  peak: number;
  pan?: number;
  rate?: number;
}

/** Sustained noise: attack → hold → release (swells, breath, sizzle). */
interface SwellOpts {
  color: NoiseColor;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  sweepTo?: number;
  attack: number;
  hold: number;
  release: number;
  peak: number;
  pan?: number;
}

interface ThumpOpts {
  f0: number;
  f1: number;
  pitchTime: number;
  decay: number;
  peak: number;
  drive?: number;
  type?: OscillatorType;
  attack?: number;
}

interface BusOpts {
  drive?: number;
  lowpass?: number;
  highpass?: number;
  gain?: number;
  pan?: number;
}

/** [time fraction 0..1 of the voice, Hz]. */
type PitchPoint = readonly [number, number];
/** [Hz, Q, gain]. */
type Formant = readonly [number, number, number];

interface VoiceOpts {
  type?: OscillatorType;
  /** Pitch contour, exponential glides between the points. */
  pitch: readonly PitchPoint[];
  dur: number;
  attack: number;
  release: number;
  peak: number;
  formants: readonly Formant[];
  /** FM vibrato: rate (Hz) and depth (fraction of the first pitch). */
  vibrato?: { hz: number; depth: number };
  /** AM flutter ("growl", insect buzz): rate (Hz) and depth 0..0.5. */
  growl?: { hz: number; depth: number };
  /** Second source detuned by this ratio (thickness, beating). */
  detune?: number;
  drive?: number;
  /** Breath noise level relative to `peak` (band-passed at the first formant). */
  breath?: number;
  pan?: number;
}

class Kit {
  constructor(
    readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    readonly rng: Rng,
    private readonly noiseT: NoiseTables,
  ) {}

  /** 1 ± amount (per-variant humanization). */
  j(amount: number): number {
    return 1 + (this.rng.next() * 2 - 1) * amount;
  }

  r(min: number, max: number): number {
    return min + (max - min) * this.rng.next();
  }

  /** Sub-bus: [waveshaper] → [highpass] → [lowpass] → gain → [pan] → this kit's output. */
  bus(o: BusOpts): Kit {
    const ctx = this.ctx;
    const input = ctx.createGain();
    let last: AudioNode = input;
    if (o.drive && o.drive > 0) last = this.chain(last, this.shaper(o.drive));
    if (o.highpass) last = this.chain(last, this.filter('highpass', o.highpass, 0.707));
    if (o.lowpass) last = this.chain(last, this.filter('lowpass', o.lowpass, 0.707));
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    last.connect(g);
    this.route(g, o.pan ?? 0);
    return new Kit(ctx, input, this.rng, this.noiseT);
  }

  private chain(from: AudioNode, to: AudioNode): AudioNode {
    from.connect(to);
    return to;
  }

  private shaper(drive: number): WaveShaperNode {
    const ws = this.ctx.createWaveShaper();
    ws.curve = tanhCurve(drive);
    ws.oversample = '2x';
    return ws;
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private route(node: AudioNode, pan: number): void {
    if (pan !== 0 && this.ctx.destination.channelCount > 1) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      p.connect(this.out);
    } else {
      node.connect(this.out);
    }
  }

  /** Percussive envelope: ~-35 dB after `decay`. */
  private env(t: number, attack: number, decay: number, peak: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 4);
    return g;
  }

  /** Sustained envelope: attack → hold (until t + hold) → release. */
  private sustain(t: number, attack: number, hold: number, release: number, peak: number): GainNode {
    const g = this.ctx.createGain();
    const end = t + Math.max(attack, hold);
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, Math.max(1e-3, release / 4));
    return g;
  }

  private noiseSource(color: NoiseColor, t: number, dur: number, rate = 1): AudioBufferSourceNode {
    const buf = this.noiseT[color];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t, this.rng.next() * buf.duration * 0.9);
    src.stop(t + dur);
    return src;
  }

  /** Filtered noise burst. */
  noise(t: number, o: NoiseOpts): void {
    const attack = o.attack ?? 0.001;
    const dur = attack + o.decay * 1.4 + 0.01;
    const src = this.noiseSource(o.color, t, dur, o.rate ?? 1);
    const f = this.filter(o.filter, o.freq, o.q ?? 0.707);
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t + dur);
    const e = this.env(t, attack, o.decay, o.peak);
    src.connect(f).connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Sustained filtered noise with an optional filter sweep over attack + hold. */
  swell(t: number, o: SwellOpts): void {
    const dur = Math.max(o.attack, o.hold) + o.release * 1.5 + 0.01;
    const src = this.noiseSource(o.color, t, dur);
    const f = this.filter(o.filter, o.freq, o.q ?? 0.707);
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo !== undefined) {
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t + Math.max(o.attack, o.hold));
    }
    const e = this.sustain(t, o.attack, o.hold, o.release, o.peak);
    src.connect(f).connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Pitched body with a fast pitch drop (f0 → f1 within `pitchTime`). */
  thump(t: number, o: ThumpOpts): void {
    const osc = this.ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + Math.max(1e-3, o.pitchTime));
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.001) + o.decay * 1.4 + 0.01);
    let last: AudioNode = osc;
    if (o.drive && o.drive > 0) last = this.chain(last, this.shaper(o.drive));
    const e = this.env(t, o.attack ?? 0.001, o.decay, o.peak);
    last.connect(e);
    this.route(e, 0);
  }

  /** Oscillator sweep. */
  tone(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    attack: number,
    decay: number,
    peak: number,
    pan = 0,
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    osc.start(t);
    osc.stop(t + attack + decay * 1.4 + 0.01);
    const e = this.env(t, attack, decay, peak);
    osc.connect(e);
    this.route(e, pan);
  }

  /** Held oscillator note (stings): attack → hold → release, optional glide to f1 over the hold. */
  note(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    attack: number,
    hold: number,
    release: number,
    peak: number,
    pan = 0,
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(attack, hold));
    osc.start(t);
    osc.stop(t + Math.max(attack, hold) + release * 1.5 + 0.01);
    const e = this.sustain(t, attack, hold, release, peak);
    osc.connect(e);
    this.route(e, pan);
  }

  /** Inharmonic partials (struck metal, bells); higher partials die faster. */
  ring(t: number, base: number, ratios: readonly number[], decay: number, peak: number, pan = 0): void {
    for (let i = 0; i < ratios.length; i++) {
      const f = base * ratios[i]! * this.j(0.012);
      this.tone(t, 'sine', f, f * 0.995, 0.0008, decay / (1 + i * 0.55), peak / (1 + i * 0.6), pan);
    }
  }

  /** Scattered short band-passed ticks (chitin, debris, crackle). */
  clicks(t: number, count: number, span: number, freq: number, q: number, peak: number, pan = 0): void {
    for (let i = 0; i < count; i++) {
      const dt = 0.002 + this.rng.next() * span;
      const fade = 1 - dt / (span * 1.3);
      this.noise(t + dt, {
        color: 'white',
        filter: 'bandpass',
        freq: freq * this.j(0.3),
        q,
        attack: 0.0004,
        decay: 0.006 + this.rng.next() * 0.01,
        peak: peak * fade * this.j(0.3),
        pan,
      });
    }
  }

  /** Evenly spaced chitter pulses (insect mandibles): `rate` per second over `dur`. */
  chitter(t: number, dur: number, rate: number, freq: number, q: number, peak: number): void {
    const n = Math.max(1, Math.round(dur * rate));
    for (let i = 0; i < n; i++) {
      const dt = (i / rate) * this.j(0.18);
      const shape = Math.sin(Math.PI * Math.min(1, (i + 0.5) / n));
      this.noise(t + dt, {
        color: 'white',
        filter: 'bandpass',
        freq: freq * this.j(0.15),
        q,
        attack: 0.0006,
        decay: 0.009 * this.j(0.3),
        peak: peak * (0.45 + 0.55 * shape) * this.j(0.25),
      });
    }
  }

  /** Liquid bubbles: short sines with a fast upward chirp. */
  bubbles(t: number, count: number, span: number, fLo: number, fHi: number, peak: number): void {
    for (let i = 0; i < count; i++) {
      const dt = this.rng.next() * span;
      const f = fLo * Math.pow(fHi / fLo, this.rng.next());
      const osc = this.ctx.createOscillator();
      const len = this.r(0.018, 0.045);
      osc.frequency.setValueAtTime(f, t + dt);
      osc.frequency.exponentialRampToValueAtTime(f * this.r(1.6, 2.6), t + dt + len);
      osc.start(t + dt);
      osc.stop(t + dt + len * 2.2 + 0.01);
      const e = this.env(t + dt, 0.002, len, peak * this.j(0.4));
      osc.connect(e);
      this.route(e, 0);
    }
  }

  /**
   * Creature vocal: detuned buzzy sources with a pitch contour, FM vibrato and AM flutter →
   * saturation → parallel formant band-passes → sustained envelope, plus breath noise.
   */
  voice(t: number, o: VoiceOpts): void {
    const ctx = this.ctx;
    const pts = o.pitch;
    const first = pts[0]?.[1] ?? 110;
    const stopAt = t + o.dur + o.release * 1.6 + 0.02;
    const mix = ctx.createGain();
    const sources = o.detune ? [1, o.detune] : [1];
    for (const ratio of sources) {
      const osc = ctx.createOscillator();
      osc.type = o.type ?? 'sawtooth';
      osc.frequency.setValueAtTime(first * ratio, t);
      for (let i = 1; i < pts.length; i++) {
        const [at, hz] = pts[i]!;
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, hz * ratio), t + Math.max(1e-3, at * o.dur));
      }
      if (o.vibrato) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = o.vibrato.hz * this.j(0.1);
        const depth = ctx.createGain();
        depth.gain.value = first * ratio * o.vibrato.depth;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(stopAt);
      }
      osc.start(t);
      osc.stop(stopAt);
      const g = ctx.createGain();
      g.gain.value = 1 / sources.length;
      osc.connect(g).connect(mix);
    }
    let last: AudioNode = mix;
    if (o.growl) {
      const am = ctx.createGain();
      const d = Math.min(0.5, Math.max(0, o.growl.depth));
      am.gain.value = 1 - d;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.growl.hz * this.j(0.08);
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = d;
      lfo.connect(lfoGain).connect(am.gain);
      lfo.start(t);
      lfo.stop(stopAt);
      last = this.chain(last, am);
    }
    if (o.drive && o.drive > 0) last = this.chain(last, this.shaper(o.drive));
    const env = this.sustain(t, o.attack, o.dur, o.release, o.peak);
    if (o.formants.length > 0) {
      for (const [hz, q, gain] of o.formants) {
        const f = this.filter('bandpass', hz * this.j(0.04), q);
        const g = ctx.createGain();
        g.gain.value = gain;
        last.connect(f).connect(g).connect(env);
      }
    } else {
      last.connect(env);
    }
    this.route(env, o.pan ?? 0);
    if (o.breath && o.breath > 0) {
      this.swell(t, {
        color: 'pink',
        filter: 'bandpass',
        freq: o.formants[0]?.[0] ?? 800,
        q: 0.8,
        attack: o.attack,
        hold: o.dur,
        release: o.release,
        peak: o.peak * o.breath,
        pan: o.pan,
      });
    }
  }
}

function kitOf(g: SynthGraph): Kit {
  return new Kit(g.ctx, g.ctx.destination, g.rng, noiseTables(g.ctx));
}

// ---------------------------------------------------------------------------
// Swarmer (Schwärmer): chitin, insect buzz, shrill screech
// ---------------------------------------------------------------------------

/** Idle chitter: mandible click trains with a faint buzzing trill. */
const swarmerIdle: Recipe = (g, t) => {
  const k = kitOf(g);
  const bursts = 1 + Math.floor(k.rng.next() * 2);
  let at = t;
  for (let b = 0; b < bursts; b++) {
    const dur = k.r(0.16, 0.3);
    k.chitter(at, dur, k.r(34, 52), 3400 * k.j(0.12), 5, 0.55);
    k.voice(at, {
      type: 'square',
      pitch: [
        [0, 980 * k.j(0.1)],
        [1, 1250 * k.j(0.1)],
      ],
      dur,
      attack: 0.01,
      release: 0.05,
      peak: 0.09,
      formants: [
        [2600, 3, 1],
        [4200, 4, 0.6],
      ],
      growl: { hz: 38, depth: 0.45 },
    });
    at += dur + k.r(0.05, 0.12);
  }
};

/** Skitter: a few chitinous leg taps. */
const swarmerStep: Recipe = (g, t) => {
  const k = kitOf(g);
  const taps = 2 + Math.floor(k.rng.next() * 2);
  for (let i = 0; i < taps; i++) {
    const at = t + i * k.r(0.018, 0.034);
    k.noise(at, {
      color: 'white',
      filter: 'bandpass',
      freq: 4200 * k.j(0.2),
      q: 3,
      attack: 0.0004,
      decay: 0.012,
      peak: 0.7 * k.j(0.2),
    });
    k.thump(at, { f0: 900 * k.j(0.1), f1: 420, pitchTime: 0.01, decay: 0.018, peak: 0.25 });
  }
};

/** Alert screech: shrill buzzing shriek with a vibrato wobble and hiss. */
const swarmerScreech =
  (dur: number, hi: number): Recipe =>
  (g, t) => {
    const k = kitOf(g);
    const b = k.bus({ drive: 2.2, highpass: 500 });
    const base = 1250 * k.j(0.08);
    b.voice(t, {
      pitch: [
        [0, base],
        [0.18, base * hi],
        [0.7, base * hi * 0.92],
        [1, base * 0.7],
      ],
      dur,
      attack: 0.015,
      release: 0.08,
      peak: 0.8,
      formants: [
        [2700, 4, 1],
        [4300, 5, 0.7],
        [1500, 3, 0.35],
      ],
      vibrato: { hz: 24, depth: 0.035 },
      growl: { hz: 57, depth: 0.3 },
      detune: 1.013,
      breath: 0.35,
    });
    b.chitter(t, dur * 0.4, 46, 3800, 4, 0.3);
  };

/** Leap: screech + air rush. */
const swarmerLeap: Recipe = (g, t) => {
  swarmerScreech(0.3, 1.5)(g, t);
  const k = kitOf(g);
  k.swell(t + 0.06, {
    color: 'pink',
    filter: 'bandpass',
    freq: 900,
    q: 0.9,
    sweepTo: 3200,
    attack: 0.16,
    hold: 0.2,
    release: 0.18,
    peak: 0.35,
  });
};

/** Bite wind-up: a rattling hiss (the snap comes at the strike). */
const swarmerBite: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'white',
    filter: 'highpass',
    freq: 3000,
    attack: 0.04,
    hold: 0.2,
    release: 0.08,
    peak: 0.3,
  });
  k.chitter(t, 0.26, 60, 3000, 5, 0.6);
};

/** Mandible snap + wet crunch (strike). */
const swarmerSnap: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.8 });
  b.noise(t, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.0003, decay: 0.008, peak: 1 });
  b.noise(t + 0.012, { color: 'white', filter: 'bandpass', freq: 2600, q: 4, decay: 0.01, peak: 0.8 });
  b.noise(t + 0.01, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1100 * k.j(0.15),
    q: 1.2,
    sweepTo: 500,
    decay: 0.07,
    peak: 0.7,
  });
  b.thump(t, { f0: 220, f1: 90, pitchTime: 0.02, decay: 0.06, peak: 0.5 });
  b.bubbles(t + 0.015, 3, 0.05, 700, 1600, 0.2);
};

/** Pain squeal. */
const swarmerHurt: Recipe = (g, t) => {
  const k = kitOf(g);
  const base = 1700 * k.j(0.1);
  k.voice(t, {
    pitch: [
      [0, base],
      [0.3, base * 1.15],
      [1, base * 0.72],
    ],
    dur: 0.14,
    attack: 0.006,
    release: 0.05,
    peak: 0.8,
    formants: [
      [3000, 4, 1],
      [4600, 5, 0.5],
    ],
    growl: { hz: 50, depth: 0.35 },
    drive: 1.6,
    breath: 0.25,
  });
};

// ---------------------------------------------------------------------------
// Spitter (Spucker): wet, gurgling, bubbling acid sac
// ---------------------------------------------------------------------------

/** Throat gurgle with bubbles over a wet bed. */
const spitterIdle: Recipe = (g, t) => {
  const k = kitOf(g);
  const dur = k.r(0.6, 0.85);
  k.voice(t, {
    pitch: [
      [0, 92 * k.j(0.1)],
      [0.5, 118 * k.j(0.1)],
      [1, 84],
    ],
    dur,
    attack: 0.06,
    release: 0.12,
    peak: 0.45,
    formants: [
      [480, 3, 1],
      [950, 4, 0.6],
    ],
    growl: { hz: 11, depth: 0.45 },
    detune: 1.02,
    drive: 1.4,
    breath: 0.4,
  });
  k.bubbles(t + 0.03, 12, dur, 260, 900, 0.45);
  k.swell(t, {
    color: 'brown',
    filter: 'bandpass',
    freq: 320,
    q: 1.2,
    attack: 0.08,
    hold: dur,
    release: 0.12,
    peak: 0.25,
  });
};

/** Wet slap footstep. */
const spitterStep: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 900 * k.j(0.15),
    sweepTo: 300,
    attack: 0.001,
    decay: 0.06,
    peak: 0.9,
  });
  k.thump(t, { f0: 150, f1: 70, pitchTime: 0.03, decay: 0.05, peak: 0.45 });
  k.bubbles(t + 0.02, 2, 0.05, 400, 900, 0.3);
};

/** Gurgling shriek (alert). */
const spitterAlert: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2 });
  const base = 360 * k.j(0.08);
  b.voice(t, {
    pitch: [
      [0, base],
      [0.25, base * 2],
      [0.75, base * 1.8],
      [1, base * 1.1],
    ],
    dur: 0.75,
    attack: 0.03,
    release: 0.12,
    peak: 0.75,
    formants: [
      [900, 5, 1],
      [2300, 6, 0.6],
      [3400, 6, 0.25],
    ],
    growl: { hz: 17, depth: 0.4 },
    vibrato: { hz: 6, depth: 0.04 },
    detune: 1.015,
    breath: 0.3,
  });
  b.bubbles(t, 14, 0.7, 300, 1200, 0.3);
};

/** Spit wind-up: the sac gurgles and the throat pumps up. */
const spitterSpit: Recipe = (g, t) => {
  const k = kitOf(g);
  k.voice(t, {
    pitch: [
      [0, 80],
      [1, 170 * k.j(0.1)],
    ],
    dur: 0.5,
    attack: 0.08,
    release: 0.06,
    peak: 0.55,
    formants: [
      [420, 3, 1],
      [1100, 4, 0.5],
    ],
    growl: { hz: 14, depth: 0.45 },
    drive: 1.8,
    breath: 0.5,
  });
  k.bubbles(t + 0.05, 16, 0.45, 300, 1400, 0.4);
};

/** Launch: a wet hock and pop. */
const spitterLaunch: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.4 });
  b.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1800 * k.j(0.1),
    q: 1.1,
    sweepTo: 600,
    attack: 0.002,
    decay: 0.12,
    peak: 0.9,
  });
  b.thump(t, { f0: 260, f1: 70, pitchTime: 0.035, decay: 0.09, peak: 0.8 });
  b.noise(t, { color: 'white', filter: 'highpass', freq: 2800, attack: 0.001, decay: 0.03, peak: 0.4 });
  b.bubbles(t + 0.02, 6, 0.1, 500, 1600, 0.4);
};

/** Acid splash: splat, bubbling, a sizzling tail. */
const acidSplash: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 3200,
    sweepTo: 500,
    attack: 0.002,
    decay: 0.18,
    peak: 1,
  });
  k.thump(t, { f0: 180, f1: 55, pitchTime: 0.04, decay: 0.12, peak: 0.6 });
  k.bubbles(t + 0.02, 18, 0.45, 350, 1800, 0.35);
  k.swell(t + 0.05, {
    color: 'white',
    filter: 'highpass',
    freq: 4200,
    attack: 0.04,
    hold: 0.25,
    release: 0.35,
    peak: 0.22,
  });
};

/** Claw swipe: whoosh with a short fleshy snarl. */
function clawSwipe(heavy: boolean): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const lo = heavy ? 350 : 800;
    k.swell(t, {
      color: 'pink',
      filter: 'bandpass',
      freq: lo * k.j(0.1),
      q: heavy ? 0.8 : 1.2,
      sweepTo: lo * (heavy ? 3 : 4),
      attack: heavy ? 0.12 : 0.07,
      hold: heavy ? 0.14 : 0.08,
      release: heavy ? 0.16 : 0.1,
      peak: 0.8,
    });
    if (heavy) k.thump(t + 0.18, { f0: 110, f1: 50, pitchTime: 0.05, decay: 0.12, peak: 0.4 });
  };
}

/** Spitter swipe wind-up: wet snarl. */
const spitterSwipe: Recipe = (g, t) => {
  const k = kitOf(g);
  k.voice(t, {
    pitch: [
      [0, 210 * k.j(0.08)],
      [1, 290],
    ],
    dur: 0.3,
    attack: 0.02,
    release: 0.08,
    peak: 0.6,
    formants: [
      [700, 4, 1],
      [1900, 5, 0.5],
    ],
    growl: { hz: 21, depth: 0.4 },
    drive: 2,
    breath: 0.4,
  });
};

/** Wet croak (hurt). */
const spitterHurt: Recipe = (g, t) => {
  const k = kitOf(g);
  const base = 260 * k.j(0.1);
  k.voice(t, {
    pitch: [
      [0, base],
      [1, base * 0.68],
    ],
    dur: 0.2,
    attack: 0.008,
    release: 0.06,
    peak: 0.7,
    formants: [
      [700, 4, 1],
      [1800, 5, 0.5],
    ],
    growl: { hz: 19, depth: 0.4 },
    drive: 1.8,
    breath: 0.35,
  });
  k.bubbles(t + 0.04, 4, 0.15, 400, 1100, 0.3);
};

// ---------------------------------------------------------------------------
// Tank (Koloss): sub weight, armor, huge roar
// ---------------------------------------------------------------------------

/** Heavy footstep: sub thud, dirt, a faint armor clank. */
const tankStep: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.5, lowpass: 5000 });
  b.thump(t, { f0: 78 * k.j(0.06), f1: 36, pitchTime: 0.07, decay: 0.32, peak: 1 });
  b.noise(t, { color: 'brown', filter: 'lowpass', freq: 260, attack: 0.002, decay: 0.22, peak: 0.8 });
  b.noise(t, { color: 'pink', filter: 'bandpass', freq: 700, q: 1, attack: 0.001, decay: 0.05, peak: 0.45 });
  b.clicks(t + 0.01, 5, 0.12, 2400, 2.5, 0.18);
  b.ring(t + 0.005, 190 * k.j(0.05), [1, 2.63, 4.1], 0.18, 0.07);
};

/** Roar: low buzzing vocal with a sub layer and heavy growl. */
function tankRoar(dur: number, pitch: readonly PitchPoint[], peak: number): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const b = k.bus({ drive: 2.8, lowpass: 7000 });
    const s = k.j(0.06);
    b.voice(t, {
      pitch: pitch.map(([at, hz]) => [at, hz * s] as const),
      dur,
      attack: 0.08,
      release: 0.3,
      peak,
      formants: [
        [340, 3, 1],
        [820, 4, 0.8],
        [2200, 5, 0.35],
      ],
      growl: { hz: 23, depth: 0.45 },
      vibrato: { hz: 5, depth: 0.03 },
      detune: 1.012,
      breath: 0.5,
    });
    b.note(t, 'sine', 50 * s, 42 * s, 0.1, dur, 0.3, peak * 0.6);
  };
}

const tankAlert = tankRoar(
  1.25,
  [
    [0, 88],
    [0.25, 132],
    [0.8, 118],
    [1, 76],
  ],
  0.9,
);
/** Charge bellow: rising and relentless. */
const tankCharge = tankRoar(
  1,
  [
    [0, 96],
    [0.5, 160],
    [1, 176],
  ],
  1,
);

/** Idle: low growl and breath. */
const tankIdle: Recipe = (g, t) => {
  const k = kitOf(g);
  const dur = k.r(0.55, 0.8);
  k.voice(t, {
    pitch: [
      [0, 68 * k.j(0.08)],
      [0.5, 80 * k.j(0.08)],
      [1, 62],
    ],
    dur,
    attack: 0.12,
    release: 0.25,
    peak: 0.45,
    formants: [
      [300, 3, 1],
      [700, 4, 0.6],
    ],
    growl: { hz: 19, depth: 0.45 },
    detune: 1.01,
    drive: 1.6,
    breath: 0.7,
  });
};

/** Slam wind-up: a straining grunt that swells up. */
const tankSlam: Recipe = (g, t) => {
  const k = kitOf(g);
  k.voice(t, {
    pitch: [
      [0, 74],
      [1, 128 * k.j(0.06)],
    ],
    dur: 0.75,
    attack: 0.2,
    release: 0.1,
    peak: 0.75,
    formants: [
      [360, 3, 1],
      [860, 4, 0.7],
    ],
    growl: { hz: 26, depth: 0.45 },
    detune: 1.015,
    drive: 2.4,
    breath: 0.55,
  });
};

/** Slam impact: floor-shaking boom, cracking concrete, debris. */
const tankSlamImpact: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.2, lowpass: 9000 });
  b.thump(t, { f0: 70, f1: 26, pitchTime: 0.14, decay: 0.75, peak: 1 });
  b.thump(t, { f0: 160, f1: 55, pitchTime: 0.04, decay: 0.18, peak: 0.7, drive: 2 });
  b.noise(t, {
    color: 'brown',
    filter: 'lowpass',
    freq: 420,
    sweepTo: 120,
    attack: 0.002,
    decay: 0.7,
    peak: 0.9,
  });
  b.noise(t, { color: 'white', filter: 'highpass', freq: 2200, attack: 0.0005, decay: 0.05, peak: 0.6 });
  b.clicks(t + 0.02, 16, 0.5, 2600, 2, 0.35);
  b.clicks(t + 0.05, 8, 0.7, 900, 1.5, 0.3);
};

/** Tank swipe wind-up: effortful grunt. */
const tankSwipe: Recipe = (g, t) => {
  const k = kitOf(g);
  k.voice(t, {
    pitch: [
      [0, 105 * k.j(0.06)],
      [1, 82],
    ],
    dur: 0.35,
    attack: 0.03,
    release: 0.12,
    peak: 0.7,
    formants: [
      [380, 3, 1],
      [900, 4, 0.6],
    ],
    growl: { hz: 22, depth: 0.4 },
    drive: 2.2,
    breath: 0.5,
  });
};

/** Hurt: short grunt with an armor clank. */
const tankHurt: Recipe = (g, t) => {
  const k = kitOf(g);
  k.voice(t, {
    pitch: [
      [0, 120 * k.j(0.08)],
      [1, 88],
    ],
    dur: 0.22,
    attack: 0.01,
    release: 0.1,
    peak: 0.75,
    formants: [
      [400, 3, 1],
      [950, 4, 0.6],
    ],
    growl: { hz: 24, depth: 0.4 },
    drive: 2,
    breath: 0.4,
  });
  k.ring(t, 240 * k.j(0.05), [1, 2.76, 5.4], 0.25, 0.12);
};

/** Death: a dying roar that sinks, then the collapse. */
const tankDeath: Recipe = (g, t) => {
  tankRoar(
    1.1,
    [
      [0, 120],
      [0.3, 104],
      [1, 46],
    ],
    0.85,
  )(g, t);
  const k = kitOf(g);
  const at = t + 1.05;
  k.thump(at, { f0: 62, f1: 28, pitchTime: 0.12, decay: 0.6, peak: 1 });
  k.noise(at, { color: 'brown', filter: 'lowpass', freq: 380, attack: 0.003, decay: 0.55, peak: 0.8 });
  k.clicks(at + 0.02, 10, 0.35, 1800, 2, 0.25);
  k.bubbles(at + 0.05, 8, 0.4, 200, 700, 0.3);
};

// ---------------------------------------------------------------------------
// Shared: deaths, rift tears
// ---------------------------------------------------------------------------

/** Generic death squelch: a collapsing, bubbling wet body. */
const deathSquelch: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.6 });
  b.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1100 * k.j(0.15),
    q: 1.4,
    sweepTo: 260,
    attack: 0.004,
    decay: 0.22,
    peak: 1,
  });
  b.thump(t, { f0: 180, f1: 60, pitchTime: 0.05, decay: 0.14, peak: 0.7 });
  b.bubbles(t + 0.03, 10, 0.3, 250, 1100, 0.4);
  b.noise(t + 0.12 * k.j(0.3), {
    color: 'pink',
    filter: 'bandpass',
    freq: 600,
    q: 1.2,
    sweepTo: 220,
    decay: 0.14,
    peak: 0.5,
  });
};

/** Sac rupture: pop, acid splash, sizzle. */
const deathBurst: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.4 });
  b.noise(t, { color: 'white', filter: 'highpass', freq: 1800, attack: 0.0004, decay: 0.03, peak: 1 });
  b.thump(t, { f0: 240, f1: 48, pitchTime: 0.05, decay: 0.2, peak: 0.9, drive: 1.5 });
  acidSplash(g, t + 0.015);
  deathSquelch(g, t + 0.05);
};

/**
 * Rift tear: a reverse swell of torn air rising into a crack, crackling energy, a low boom as the
 * portal opens, a faint glassy shimmer.
 */
function riftTear(size: number): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const rise = 0.32 * size;
    k.swell(t, {
      color: 'pink',
      filter: 'bandpass',
      freq: 260 / size,
      q: 2.2,
      sweepTo: 2600 / size,
      attack: rise,
      hold: rise,
      release: 0.35 * size,
      peak: 0.7,
    });
    k.voice(t, {
      type: 'sawtooth',
      pitch: [
        [0, 55 / size],
        [0.6, 140 / size],
        [1, 90 / size],
      ],
      dur: rise * 1.2,
      attack: rise * 0.8,
      release: 0.3 * size,
      peak: 0.35,
      formants: [
        [600 / size, 2, 1],
        [1700 / size, 3, 0.5],
      ],
      growl: { hz: 31, depth: 0.45 },
      drive: 2.4,
    });
    k.clicks(t + rise * 0.4, Math.round(10 * size), rise * 1.6, 3200, 3, 0.35);
    const at = t + rise;
    k.noise(at, { color: 'white', filter: 'highpass', freq: 2500, attack: 0.0006, decay: 0.05, peak: 0.6 });
    k.thump(at, { f0: 95 / size, f1: 30, pitchTime: 0.1 * size, decay: 0.5 * size, peak: 0.95, drive: 1.5 });
    k.ring(at, 830 / size, [1, 1.47, 2.09, 2.73], 0.9 * size, 0.08);
  };
}

// ---------------------------------------------------------------------------
// Stings (stereo)
// ---------------------------------------------------------------------------

/** Wave start: sub boom, a dissonant brass cluster swelling open, a distant toll, metal scrape. */
const stingWaveStart: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.4, lowpass: 6000 });
  b.thump(t, { f0: 58, f1: 30, pitchTime: 0.25, decay: 1.3, peak: 1 });
  b.noise(t, { color: 'brown', filter: 'lowpass', freq: 200, attack: 0.004, decay: 1, peak: 0.6 });
  // A minor second over a fifth: unresolved dread.
  const notes: readonly (readonly [number, number])[] = [
    [55, -0.35],
    [58.27, 0.35],
    [82.41, -0.15],
    [110, 0.2],
  ];
  for (const [hz, pan] of notes) {
    b.voice(t + 0.05, {
      pitch: [
        [0, hz],
        [1, hz * 0.985],
      ],
      dur: 1.7,
      attack: 0.45,
      release: 1.1,
      peak: 0.3,
      formants: [
        [hz * 4, 1.2, 1],
        [hz * 9, 2, 0.4],
      ],
      vibrato: { hz: 4.5, depth: 0.004 },
      detune: 1.004,
      drive: 1.2,
      pan,
    });
  }
  b.ring(t + 0.02, 110, [1, 2.01, 2.76, 4.07, 5.4], 2.6, 0.22, 0.25);
  b.swell(t + 0.1, {
    color: 'white',
    filter: 'bandpass',
    freq: 5200,
    q: 9,
    sweepTo: 2100,
    attack: 0.5,
    hold: 0.9,
    release: 0.8,
    peak: 0.25,
    pan: -0.4,
  });
};

/** Wave complete: a rising open fifth, shimmer, a breath of relief (still uneasy). */
const stingWaveComplete: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ lowpass: 7000 });
  b.note(t, 'triangle', 220, 220, 0.12, 0.7, 0.9, 0.45, -0.3);
  b.note(t + 0.22, 'triangle', 329.63, 329.63, 0.12, 0.6, 1, 0.42, 0.3);
  b.note(t + 0.44, 'sine', 440, 440, 0.2, 0.5, 1.1, 0.35, 0);
  b.ring(t + 0.44, 880, [1, 2.0, 3.01], 1.4, 0.12, 0.2);
  b.swell(t, {
    color: 'pink',
    filter: 'highpass',
    freq: 3000,
    sweepTo: 9000,
    attack: 0.45,
    hold: 0.45,
    release: 0.6,
    peak: 0.18,
  });
  b.thump(t, { f0: 90, f1: 45, pitchTime: 0.1, decay: 0.5, peak: 0.45 });
};

/** Game over: a huge downward boom, a falling dissonant cluster, a last heartbeat. */
const stingGameOver: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.6, lowpass: 5000 });
  b.thump(t, { f0: 64, f1: 24, pitchTime: 0.6, decay: 2.2, peak: 1 });
  b.noise(t, {
    color: 'brown',
    filter: 'lowpass',
    freq: 300,
    sweepTo: 80,
    attack: 0.005,
    decay: 1.8,
    peak: 0.7,
  });
  const notes: readonly (readonly [number, number])[] = [
    [110, -0.3],
    [116.54, 0.3],
    [146.83, 0],
    [220, 0.15],
  ];
  for (const [hz, pan] of notes) {
    b.voice(t + 0.08, {
      pitch: [
        [0, hz],
        [0.35, hz * 0.97],
        [1, hz * 0.84],
      ],
      dur: 2.4,
      attack: 0.3,
      release: 1.2,
      peak: 0.26,
      formants: [
        [hz * 3.5, 1.3, 1],
        [hz * 8, 2.2, 0.35],
      ],
      vibrato: { hz: 3.2, depth: 0.006 },
      detune: 1.006,
      drive: 1.4,
      pan,
    });
  }
  b.ring(t, 73.4, [1, 2.02, 2.74, 4.1], 3, 0.25);
  // Two last heartbeats.
  for (const at of [2.1, 2.55]) b.thump(t + at, { f0: 70, f1: 38, pitchTime: 0.05, decay: 0.2, peak: 0.55 });
};

// ---------------------------------------------------------------------------
// Defs
// ---------------------------------------------------------------------------

export const ENEMY_SYNTH_DEFS = {
  // --- swarmer ---
  'enemy.swarmer.idle': { variants: 4, duration: 0.9, channels: 1, level: 0.7, recipe: swarmerIdle },
  'enemy.swarmer.step': { variants: 4, duration: 0.14, channels: 1, level: 0.55, recipe: swarmerStep },
  'enemy.swarmer.alert': {
    variants: 3,
    duration: 0.75,
    channels: 1,
    level: 0.95,
    recipe: swarmerScreech(0.5, 1.7),
  },
  'enemy.swarmer.leap': { variants: 3, duration: 0.7, channels: 1, level: 0.9, recipe: swarmerLeap },
  'enemy.swarmer.bite': { variants: 3, duration: 0.42, channels: 1, level: 0.7, recipe: swarmerBite },
  'enemy.swarmer.snap': { variants: 3, duration: 0.25, channels: 1, level: 0.9, recipe: swarmerSnap },
  'enemy.swarmer.hurt': { variants: 3, duration: 0.3, channels: 1, level: 0.75, recipe: swarmerHurt },
  // --- spitter ---
  'enemy.spitter.idle': { variants: 3, duration: 1.2, channels: 1, level: 0.75, recipe: spitterIdle },
  'enemy.spitter.step': { variants: 3, duration: 0.2, channels: 1, level: 0.6, recipe: spitterStep },
  'enemy.spitter.alert': { variants: 2, duration: 1, channels: 1, level: 0.95, recipe: spitterAlert },
  'enemy.spitter.spit': { variants: 3, duration: 0.7, channels: 1, level: 0.8, recipe: spitterSpit },
  'enemy.spitter.spit.launch': {
    variants: 3,
    duration: 0.3,
    channels: 1,
    level: 0.9,
    recipe: spitterLaunch,
  },
  'enemy.spitter.swipe': { variants: 2, duration: 0.5, channels: 1, level: 0.75, recipe: spitterSwipe },
  'enemy.spitter.hurt': { variants: 3, duration: 0.36, channels: 1, level: 0.75, recipe: spitterHurt },
  'enemy.acid.splash': { variants: 3, duration: 0.9, channels: 1, level: 0.9, recipe: acidSplash },
  // --- tank ---
  'enemy.tank.step': { variants: 4, duration: 0.6, channels: 1, level: 1, recipe: tankStep },
  'enemy.tank.idle': { variants: 3, duration: 1.2, channels: 1, level: 0.7, recipe: tankIdle },
  'enemy.tank.alert': { variants: 2, duration: 1.8, channels: 1, level: 1, recipe: tankAlert },
  'enemy.tank.charge': { variants: 2, duration: 1.5, channels: 1, level: 1, recipe: tankCharge },
  'enemy.tank.slam': { variants: 2, duration: 0.95, channels: 1, level: 0.9, recipe: tankSlam },
  'enemy.tank.slam.impact': { variants: 2, duration: 1.4, channels: 1, level: 1, recipe: tankSlamImpact },
  'enemy.tank.swipe': { variants: 2, duration: 0.55, channels: 1, level: 0.85, recipe: tankSwipe },
  'enemy.tank.hurt': { variants: 3, duration: 0.45, channels: 1, level: 0.8, recipe: tankHurt },
  'enemy.tank.death': { variants: 1, duration: 2.5, channels: 1, level: 1, recipe: tankDeath },
  // --- shared ---
  'enemy.claw.swipe': { variants: 3, duration: 0.35, channels: 1, level: 0.7, recipe: clawSwipe(false) },
  'enemy.claw.swipe.heavy': {
    variants: 2,
    duration: 0.6,
    channels: 1,
    level: 0.85,
    recipe: clawSwipe(true),
  },
  'enemy.death.squelch': { variants: 4, duration: 0.6, channels: 1, level: 0.85, recipe: deathSquelch },
  'enemy.death.burst': { variants: 3, duration: 1, channels: 1, level: 0.95, recipe: deathBurst },
  'rift.tear': { variants: 3, duration: 1.7, channels: 1, level: 0.8, recipe: riftTear(1) },
  'rift.tear.large': { variants: 2, duration: 2.6, channels: 1, level: 0.95, recipe: riftTear(1.5) },
  // --- stings (music / ui bus, stereo) ---
  'sting.wave.start': { variants: 1, duration: 3.6, channels: 2, level: 0.9, recipe: stingWaveStart },
  'sting.wave.complete': { variants: 1, duration: 2.4, channels: 2, level: 0.75, recipe: stingWaveComplete },
  'sting.gameover': { variants: 1, duration: 4.6, channels: 2, level: 0.95, recipe: stingGameOver },
} as const satisfies Record<string, SynthDef>;

export type EnemySynthId = keyof typeof ENEMY_SYNTH_DEFS;

/**
 * Ids the enemy defs use for shared sounds (defs/enemies `audio.*`). Aliases share the rendered
 * buffers; an asset registered under an alias id still overrides it.
 */
export const ENEMY_SYNTH_ALIASES = {
  'enemy.swarmer.spawn': 'rift.tear',
  'enemy.swarmer.death': 'enemy.death.squelch',
  'enemy.spitter.spawn': 'rift.tear',
  'enemy.spitter.death': 'enemy.death.burst',
  'enemy.tank.spawn': 'rift.tear.large',
} as const satisfies Record<string, EnemySynthId>;

/** Enemy synth id for an alias id, or null. */
export function enemySynthAlias(id: string): EnemySynthId | null {
  return Object.prototype.hasOwnProperty.call(ENEMY_SYNTH_ALIASES, id)
    ? (ENEMY_SYNTH_ALIASES as Record<string, EnemySynthId>)[id]!
    : null;
}

/** Enemy synth id for a sound id (exact or alias), or null. */
export function resolveEnemySynthId(id: string): EnemySynthId | null {
  if (Object.prototype.hasOwnProperty.call(ENEMY_SYNTH_DEFS, id)) return id as EnemySynthId;
  return enemySynthAlias(id);
}
