/**
 * Layer toolkit of the M5 arsenal sounds (arsenalSynth.ts, elementSynth.ts, gearSynth.ts): the
 * building blocks of weaponSynth.ts (noise bursts, fast-pitch thumps, inharmonic rings, saturation
 * buses) plus what energy weapons, elements and machines need – sustained swells and reversed
 * suctions, LFO-modulated drones for loops, FM, ring modulation, additive plucks, formant choirs,
 * crackle fields and feedback combs (flanged tearing / metallic resonance).
 *
 * Recipes get a Kit through `kitOf(g)` and build their own node graph into the offline context's
 * destination (the bank's bus is a unity gain), so these modules need no runtime import of
 * synth.ts (no cycle). Noise tables are seeded (deterministic across sessions) and shared per
 * sample rate. Frequencies/levels inside recipes are sound-design constants.
 *
 * Loops: tonal layers of a loop go through `loopBus` (sine/cosine edges over the bank's loop
 * crossfade) and use whole cycles per loop length (frequencies and LFO rates on the
 * `LOOP_HZ` grid), so dsp.makeLoopable sums them seamlessly; noise beds stay constant.
 */
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { fillBrown, fillPink, fillWhite, normalizeRms } from './dsp';
import type { SynthDef, SynthGraph } from './synth';

export type Recipe = SynthDef['recipe'];
export type NoiseColor = 'white' | 'pink' | 'brown';
type NoiseTables = Record<NoiseColor, AudioBuffer>;

const S = AUDIO.synth;
const WHITE_NOISE_RMS = 1 / Math.sqrt(3);

/** Loop body length of the arsenal loops (s) and the bank's crossfade folded onto it. */
export const LOOP_SECONDS = AUDIO.arsenal.synth.loopSeconds;
export const LOOP_XF = S.slideLoopCrossfade;
/** Rendered duration of a loop def. */
export const LOOP_DURATION = LOOP_SECONDS + LOOP_XF;
/** Frequency grid with whole cycles per loop (Hz). */
export const LOOP_HZ = 1 / LOOP_SECONDS;

/** Nearest frequency with whole cycles per loop. */
export function loopHz(f: number): number {
  return Math.max(LOOP_HZ, Math.round(f / LOOP_HZ) * LOOP_HZ);
}

/** Equal-tempered frequency of a MIDI note. */
export function midi(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

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
        fill(new Float32Array(length), new Rng(`${S.seed}:arsenal-noise:${name}`)),
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

export interface NoiseOpts {
  color: NoiseColor;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  /** Exponential filter sweep target over the sound. */
  sweepTo?: number;
  attack?: number;
  decay: number;
  peak: number;
  pan?: number;
  /** Noise playback rate (< 1 darker/grainier). */
  rate?: number;
}

export interface SwellOpts {
  color: NoiseColor;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  /** Filter sweep target, reached at the end of the hold. */
  sweepTo?: number;
  attack: number;
  hold: number;
  release: number;
  peak: number;
  pan?: number;
  /** Exponential rise (reversed-sound suction) instead of a linear attack. */
  expRise?: boolean;
}

export interface ThumpOpts {
  f0: number;
  f1: number;
  /** Pitch drop time (fast envelope), independent of the amplitude decay. */
  pitchTime: number;
  decay: number;
  peak: number;
  drive?: number;
  type?: OscillatorType;
  attack?: number;
  pan?: number;
}

export interface BusOpts {
  drive?: number;
  lowpass?: number;
  highpass?: number;
  gain?: number;
  pan?: number;
  /** Feedback comb after the filters (metallic resonance, flanged tearing). */
  comb?: CombOpts;
}

export interface CombOpts {
  /** Delay (s) – resonance at 1 / delay (≥ 128 samples inside a feedback cycle). */
  delay: number;
  feedback: number;
  /** Low-pass inside the loop (damping). */
  damp?: number;
  /** Wet level (dry passes at 1). */
  wet?: number;
  /** Delay sweep target over `sweepTime` (flanger), and an LFO on the delay time. */
  sweepTo?: number;
  sweepTime?: number;
  lfo?: { rate: number; depth: number };
  start?: number;
}

export interface LfoOpts {
  rate: number;
  depth: number;
  type?: OscillatorType;
}

export interface DroneOpts {
  type?: OscillatorType;
  /** Detuned twin voice (cents); whole-cycle safe when both land on the loop grid. */
  detune?: number;
  lowpass?: number;
  q?: number;
  /** Frequency LFO (Hz depth) and amplitude LFO (fraction of the level). */
  vibrato?: LfoOpts;
  tremolo?: LfoOpts;
  pan?: number;
}

/** Segments of the piecewise-linear sine/cosine loop edges. */
const LOOP_EDGE_STEPS = 12;

export class Kit {
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

  /** Stereo width is only meaningful in a 2-channel render. */
  get stereo(): boolean {
    return this.ctx.destination.channelCount > 1;
  }

  /** Sub-bus: [waveshaper] → [highpass] → [lowpass] → [comb] → gain → [pan] → this kit's output. */
  bus(o: BusOpts): Kit {
    const ctx = this.ctx;
    const input = ctx.createGain();
    let last: AudioNode = input;
    if (o.drive && o.drive > 0) last = chain(last, this.shaper(o.drive, '4x'));
    if (o.highpass) last = chain(last, this.filter('highpass', o.highpass, 0.707));
    if (o.lowpass) last = chain(last, this.filter('lowpass', o.lowpass, 0.707));
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    if (o.comb) this.combInto(last, g, o.comb);
    else last.connect(g);
    this.route(g, o.pan ?? 0);
    return new Kit(ctx, input, this.rng, this.noiseT);
  }

  /**
   * Loop bus for tonal layers: its gain rises along sin(πu/2) over the first `xf` s from `t` and
   * falls along cos over the last `xf` s before `t + dur` (see the file header).
   */
  loopBus(t: number, dur: number = LOOP_DURATION, xf: number = LOOP_XF, gain = 1, pan = 0): Kit {
    const input = this.ctx.createGain();
    const p = input.gain;
    p.value = 0;
    p.setValueAtTime(0, t);
    const n = LOOP_EDGE_STEPS;
    for (let i = 1; i <= n; i++)
      p.linearRampToValueAtTime(gain * Math.sin((i / n) * Math.PI * 0.5), t + (xf * i) / n);
    const fall = t + Math.max(xf, dur - xf);
    p.setValueAtTime(gain, fall);
    for (let i = 1; i <= n; i++)
      p.linearRampToValueAtTime(gain * Math.cos((i / n) * Math.PI * 0.5), fall + (xf * i) / n);
    this.route(input, pan);
    return new Kit(this.ctx, input, this.rng, this.noiseT);
  }

  /** Route an externally built node into this kit's output. */
  add(node: AudioNode, pan = 0): void {
    this.route(node, pan);
  }

  // -------------------------------------------------------------------------
  // Noise
  // -------------------------------------------------------------------------

  /** Filtered noise burst (percussive envelope, ~-35 dB after `decay`). */
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

  /** Sustained filtered noise: attack → hold → release, optional sweep over attack + hold. */
  swell(t: number, o: SwellOpts): void {
    const top = Math.max(o.attack, o.hold);
    const dur = top + o.release * 1.5 + 0.01;
    const src = this.noiseSource(o.color, t, dur, 1);
    const f = this.filter(o.filter, o.freq, o.q ?? 0.707);
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t + top);
    const e = this.sustain(t, o.attack, o.hold, o.release, o.peak, o.expRise ?? false);
    src.connect(f).connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Constant-level noise bed (loops); optional LFOs on the filter frequency and the level. */
  bed(
    t: number,
    dur: number,
    color: NoiseColor,
    filter: BiquadFilterType,
    freq: number,
    q: number,
    level: number,
    o: { freqLfo?: LfoOpts; gainLfo?: LfoOpts; pan?: number } = {},
  ): BiquadFilterNode {
    const src = this.noiseSource(color, t, dur, 1);
    const f = this.filter(filter, freq, q);
    const g = this.ctx.createGain();
    g.gain.value = level;
    if (o.freqLfo) this.lfo(t, dur, o.freqLfo, f.frequency);
    if (o.gainLfo) this.lfo(t, dur, { ...o.gainLfo, depth: o.gainLfo.depth * level }, g.gain);
    src.connect(f).connect(g);
    this.route(g, o.pan ?? 0);
    return f;
  }

  /** Very short bright click (contact transient). */
  click(t: number, freq: number, decay: number, peak: number, pan = 0): void {
    this.noise(t, { color: 'white', filter: 'highpass', freq, attack: 0.0004, decay, peak, pan });
  }

  /** Scattered short band-passed ticks, fading over `span` (debris, rattles). */
  ticks(t: number, count: number, span: number, freq: number, q: number, peak: number, pan = 0): void {
    for (let i = 0; i < count; i++) {
      const dt = 0.004 + this.rng.next() * span;
      const fade = 1 - dt / (span * 1.3);
      this.noise(t + dt, {
        color: 'white',
        filter: 'bandpass',
        freq: freq * this.j(0.3),
        q,
        decay: 0.008 + this.rng.next() * 0.008,
        peak: peak * fade * this.j(0.3),
        pan: pan === 0 ? 0 : pan * this.j(0.5),
      });
    }
  }

  /**
   * Even random crackle over `dur` (`density` events/s, no fade): electricity, fire, frost.
   * `spread` pans each event randomly within ±spread.
   */
  crackle(
    t: number,
    dur: number,
    density: number,
    freq: number,
    q: number,
    peak: number,
    spread = 0,
    body = 0,
  ): void {
    const n = Math.max(1, Math.round(dur * density));
    for (let i = 0; i < n; i++) {
      const at = t + this.rng.next() * Math.max(0.001, dur - 0.02);
      const a = peak * (0.25 + 0.75 * Math.pow(this.rng.next(), 2));
      const pan = spread > 0 ? (this.rng.next() * 2 - 1) * spread : 0;
      this.noise(at, {
        color: 'white',
        filter: 'bandpass',
        freq: freq * this.j(0.45),
        q,
        attack: 0.0003,
        decay: 0.004 + this.rng.next() * 0.01,
        peak: a,
        pan,
      });
      if (body > 0 && this.rng.next() < 0.35) {
        this.thump(at, { f0: this.r(160, 320), f1: 70, pitchTime: 0.01, decay: 0.02, peak: a * body, pan });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tones
  // -------------------------------------------------------------------------

  /** Pitched body with a fast pitch envelope (f0 → f1 within `pitchTime`). */
  thump(t: number, o: ThumpOpts): void {
    const osc = this.ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + Math.max(1e-3, o.pitchTime));
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.001) + o.decay * 1.4 + 0.01);
    let last: AudioNode = osc;
    if (o.drive && o.drive > 0) last = chain(last, this.shaper(o.drive, '2x'));
    const e = this.env(t, o.attack ?? 0.001, o.decay, o.peak);
    last.connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Oscillator sweep with a percussive envelope (zaps, pings, whines). */
  tone(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    attack: number,
    decay: number,
    peak: number,
    pan = 0,
    lowpass = 0,
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    osc.start(t);
    osc.stop(t + attack + decay * 1.4 + 0.01);
    let last: AudioNode = osc;
    if (lowpass > 0) last = chain(last, this.filter('lowpass', lowpass, 0.707));
    const e = this.env(t, attack, decay, peak);
    last.connect(e);
    this.route(e, pan);
  }

  /** Held note: attack → hold → release, optional glide to f1 over the hold, vibrato and filter. */
  note(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    attack: number,
    hold: number,
    release: number,
    peak: number,
    o: { pan?: number; lowpass?: number; q?: number; vibrato?: LfoOpts; expRise?: boolean } = {},
  ): void {
    const top = Math.max(attack, hold);
    const stop = t + top + release * 1.5 + 0.01;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + top);
    if (o.vibrato) this.lfo(t, stop - t, o.vibrato, osc.frequency);
    osc.start(t);
    osc.stop(stop);
    let last: AudioNode = osc;
    if (o.lowpass) last = chain(last, this.filter('lowpass', o.lowpass, o.q ?? 0.707));
    const e = this.sustain(t, attack, hold, release, peak, o.expRise ?? false);
    last.connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Constant oscillator for loops (no envelope – put it on a loopBus). */
  drone(t: number, dur: number, f: number, level: number, o: DroneOpts = {}): void {
    const voices = o.detune ? [-o.detune / 2, o.detune / 2] : [0];
    for (const cents of voices) {
      const osc = this.ctx.createOscillator();
      osc.type = o.type ?? 'sine';
      osc.frequency.value = cents === 0 ? f : loopHz(f * Math.pow(2, cents / 1200));
      if (o.vibrato) this.lfo(t, dur, o.vibrato, osc.frequency);
      osc.start(t);
      osc.stop(t + dur);
      let last: AudioNode = osc;
      if (o.lowpass) last = chain(last, this.filter('lowpass', o.lowpass, o.q ?? 0.707));
      const g = this.ctx.createGain();
      g.gain.value = level / voices.length;
      if (o.tremolo) this.lfo(t, dur, { ...o.tremolo, depth: (o.tremolo.depth * level) / voices.length }, g.gain);
      last.connect(g);
      this.route(g, o.pan ?? 0);
    }
  }

  /** Two-operator FM; the index decays with the note (bright attack, soft tail). */
  fm(
    t: number,
    carrier: number,
    ratio: number,
    index: number,
    attack: number,
    decay: number,
    peak: number,
    pan = 0,
    carrierTo = carrier,
  ): void {
    const ctx = this.ctx;
    const stop = t + attack + decay * 1.4 + 0.01;
    const mod = ctx.createOscillator();
    mod.frequency.setValueAtTime(carrier * ratio, t);
    const depth = ctx.createGain();
    depth.gain.value = 0;
    depth.gain.setValueAtTime(carrier * index, t);
    depth.gain.setTargetAtTime(carrier * index * 0.1, t + attack, Math.max(1e-3, decay / 3));
    const car = ctx.createOscillator();
    car.frequency.setValueAtTime(carrier, t);
    if (carrierTo !== carrier) {
      car.frequency.exponentialRampToValueAtTime(Math.max(1, carrierTo), t + attack + decay);
      mod.frequency.exponentialRampToValueAtTime(Math.max(1, carrierTo * ratio), t + attack + decay);
    }
    mod.connect(depth).connect(car.frequency);
    mod.start(t);
    mod.stop(stop);
    car.start(t);
    car.stop(stop);
    const e = this.env(t, attack, decay, peak);
    car.connect(e);
    this.route(e, pan);
  }

  /** Ring modulation: carrier × modulator (metallic, inharmonic sidebands), percussive. */
  ringMod(
    t: number,
    carrier: number,
    modulator: number,
    attack: number,
    decay: number,
    peak: number,
    o: { type?: OscillatorType; carrierTo?: number; modTo?: number; pan?: number } = {},
  ): void {
    const ctx = this.ctx;
    const stop = t + attack + decay * 1.4 + 0.01;
    const car = ctx.createOscillator();
    car.type = o.type ?? 'sine';
    car.frequency.setValueAtTime(carrier, t);
    if (o.carrierTo) car.frequency.exponentialRampToValueAtTime(Math.max(1, o.carrierTo), stop);
    const mod = ctx.createOscillator();
    mod.frequency.setValueAtTime(modulator, t);
    if (o.modTo) mod.frequency.exponentialRampToValueAtTime(Math.max(1, o.modTo), stop);
    const vca = ctx.createGain();
    vca.gain.value = 0;
    mod.connect(vca.gain);
    car.connect(vca);
    car.start(t);
    car.stop(stop);
    mod.start(t);
    mod.stop(stop);
    const e = this.env(t, attack, decay, peak);
    vca.connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Inharmonic partials – struck metal; higher partials die faster. */
  ring(t: number, base: number, ratios: readonly number[], decay: number, peak: number, pan = 0): void {
    for (let i = 0; i < ratios.length; i++) {
      const f = base * ratios[i]! * this.j(0.012);
      this.tone(t, 'sine', f, f * 0.996, 0.0008, decay / (1 + i * 0.55), peak / (1 + i * 0.6), pan);
    }
  }

  /** Glassy bell: near-harmonic partials, higher ones die faster. */
  bell(t: number, f: number, decay: number, peak: number, pan = 0): void {
    for (let i = 0; i < BELL.length; i++) {
      const [ratio, amp] = BELL[i]!;
      this.tone(t, 'sine', f * ratio, f * ratio * 0.998, 0.001, decay / (1 + i * 0.7), peak * amp, pan);
    }
  }

  /** Plucked string (additive): 1/n harmonics with slight stiffness, higher ones die faster, pick click. */
  pluck(t: number, f: number, decay: number, peak: number, pan = 0, brightness = 1): void {
    const n = Math.max(2, Math.min(10, Math.floor(8000 / f)));
    for (let k = 1; k <= n; k++) {
      const fk = f * k * Math.sqrt(1 + 0.0004 * k * k);
      const amp = (peak / k) * Math.pow(brightness, k - 1);
      this.tone(t, k === 1 ? 'triangle' : 'sine', fk, fk * 0.999, 0.0015, decay / (1 + (k - 1) * 0.45), amp, pan);
    }
    this.noise(t, { color: 'white', filter: 'bandpass', freq: f * 6, q: 1.2, decay: 0.012, peak: peak * 0.25, pan });
  }

  /**
   * Formant choir: detuned saw voices per note through vowel formant band-passes ("aah"), with a
   * slow vibrato. attack → hold → release.
   */
  choir(
    t: number,
    notes: readonly number[],
    attack: number,
    hold: number,
    release: number,
    peak: number,
    o: { formants?: readonly (readonly [number, number])[]; spread?: number; vibrato?: number } = {},
  ): void {
    const ctx = this.ctx;
    const top = Math.max(attack, hold);
    const stop = t + top + release * 1.5 + 0.01;
    const sum = ctx.createGain();
    sum.gain.value = 1;
    const env = this.sustain(t, attack, hold, release, peak, false);
    const formants = o.formants ?? VOWEL_AH;
    for (const [freq, gain] of formants) {
      const f = this.filter('bandpass', freq, 6);
      const g = ctx.createGain();
      g.gain.value = gain;
      sum.connect(f).connect(g).connect(env);
    }
    const spread = o.spread ?? 0.6;
    for (let n = 0; n < notes.length; n++) {
      for (let v = 0; v < 3; v++) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = notes[n]! * Math.pow(2, ((v - 1) * 9 + (this.rng.next() - 0.5) * 4) / 1200);
        this.lfo(t, stop - t, { rate: (o.vibrato ?? 5) * this.j(0.15), depth: notes[n]! * 0.006 }, osc.frequency);
        const g = ctx.createGain();
        g.gain.value = 1 / (notes.length * 3);
        const pan = this.stereo ? (v - 1) * spread * 0.8 + (this.rng.next() - 0.5) * 0.2 : 0;
        osc.connect(g);
        if (pan !== 0) {
          const p = ctx.createStereoPanner();
          p.pan.value = Math.max(-1, Math.min(1, pan));
          g.connect(p).connect(sum);
        } else {
          g.connect(sum);
        }
        osc.start(t);
        osc.stop(stop);
      }
    }
    this.route(env, 0);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Connect an LFO (rate Hz, depth in param units) to an AudioParam for `dur` s from `t`. */
  lfo(t: number, dur: number, o: LfoOpts, param: AudioParam): void {
    const osc = this.ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.value = o.rate;
    const g = this.ctx.createGain();
    g.gain.value = o.depth;
    osc.connect(g).connect(param);
    osc.start(t);
    osc.stop(t + dur);
  }

  private combInto(from: AudioNode, to: AudioNode, c: CombOpts): void {
    const ctx = this.ctx;
    // Inside a feedback cycle the delay cannot be shorter than one render quantum.
    const minDelay = 128 / ctx.sampleRate;
    const delay = ctx.createDelay(1);
    const t = c.start ?? 0;
    delay.delayTime.setValueAtTime(Math.max(minDelay, c.delay), t);
    if (c.sweepTo !== undefined) {
      delay.delayTime.exponentialRampToValueAtTime(Math.max(minDelay, c.sweepTo), t + (c.sweepTime ?? 0.3));
    }
    if (c.lfo) {
      const osc = ctx.createOscillator();
      osc.frequency.value = c.lfo.rate;
      const g = ctx.createGain();
      g.gain.value = Math.min(c.lfo.depth, Math.max(0, c.delay - minDelay));
      osc.connect(g).connect(delay.delayTime);
      osc.start(t);
    }
    const fb = ctx.createGain();
    fb.gain.value = Math.max(-0.98, Math.min(0.98, c.feedback));
    const wet = ctx.createGain();
    wet.gain.value = c.wet ?? 1;
    from.connect(to);
    from.connect(delay);
    if (c.damp) {
      const lp = this.filter('lowpass', c.damp, 0.707);
      delay.connect(lp).connect(fb).connect(delay);
    } else {
      delay.connect(fb).connect(delay);
    }
    delay.connect(wet).connect(to);
  }

  private route(node: AudioNode, pan: number): void {
    if (pan !== 0 && this.stereo) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      p.connect(this.out);
    } else {
      node.connect(this.out);
    }
  }

  private shaper(drive: number, oversample: OverSampleType): WaveShaperNode {
    const ws = this.ctx.createWaveShaper();
    ws.curve = tanhCurve(drive);
    ws.oversample = oversample;
    return ws;
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Percussive envelope: ~-35 dB after `decay`. */
  private env(t: number, attack: number, decay: number, peak: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, Math.max(1e-3, decay / 4));
    return g;
  }

  /** Sustained envelope: attack → hold (until t + hold) → release. */
  private sustain(
    t: number,
    attack: number,
    hold: number,
    release: number,
    peak: number,
    expRise: boolean,
  ): GainNode {
    const g = this.ctx.createGain();
    const end = t + Math.max(attack, hold);
    g.gain.value = 0;
    if (expRise) {
      g.gain.setValueAtTime(Math.max(1e-4, peak * 1e-3), t);
      g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak), t + Math.max(1e-3, attack));
    } else {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + Math.max(1e-4, attack));
    }
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, Math.max(1e-3, release / 4));
    return g;
  }

  private noiseSource(color: NoiseColor, t: number, dur: number, rate: number): AudioBufferSourceNode {
    const buf = this.noiseT[color];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t, this.rng.next() * buf.duration * 0.9);
    src.stop(t + dur);
    return src;
  }
}

/** Glassy bell partials: [ratio, amplitude]. */
const BELL: readonly (readonly [number, number])[] = [
  [1, 1],
  [2.01, 0.5],
  [3.02, 0.26],
  [4.18, 0.16],
  [5.43, 0.08],
];

/** Vowel formants "ah" (Hz, gain). */
export const VOWEL_AH: readonly (readonly [number, number])[] = [
  [730, 1],
  [1090, 0.5],
  [2440, 0.22],
];
/** Vowel formants "oh" (darker). */
export const VOWEL_OH: readonly (readonly [number, number])[] = [
  [570, 1],
  [840, 0.45],
  [2410, 0.12],
];

function chain(from: AudioNode, to: AudioNode): AudioNode {
  from.connect(to);
  return to;
}

export function kitOf(g: SynthGraph): Kit {
  return new Kit(g.ctx, g.ctx.destination, g.rng, noiseTables(g.ctx));
}
