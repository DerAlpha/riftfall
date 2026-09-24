/**
 * Procedural music instruments (M10): every recipe of defs/music INSTRUMENT_RECIPES, rendered once
 * per theme with OfflineAudioContext into samples the sequencer plays with AudioBufferSourceNodes
 * (a sampler: one source + one gain per note, pitched by playback rate from the nearest rendered
 * root). Sustained recipes render seamless loops – tonal layers on a 1/loopSeconds Hz grid through
 * the kit's loop bus, noise beds crossfaded equal-power (see arsenalKit.ts) – and get their
 * attack / release live; one-shots render their natural envelope and are trimmed.
 *
 * Built on the arsenal Kit (noise bursts, thumps, rings, bells, plucks, FM, ring modulation,
 * choirs, combs) plus raw nodes for oscillator stacks behind swept filters. Frequencies, levels and
 * times inside the recipes are sound-design constants; the knobs come from InstrumentParams.
 */
import { Rng } from '../../core/Rng';
import { INSTRUMENT_RECIPES, MUSIC, type InstrumentParams, type InstrumentRecipe } from '../../defs/music';
import { Kit, VOWEL_AH, VOWEL_OH } from '../arsenalKit';
import {
  audibleLength,
  fadeOutTail,
  fillBrown,
  fillPink,
  fillWhite,
  makeLoopable,
  normalizeChannels,
  normalizeRms,
} from '../dsp';

const R = MUSIC.render;
const WHITE_NOISE_RMS = 1 / Math.sqrt(3);
const NOISE_LOOP_XF = 0.05;

export const DEFAULT_PARAMS: InstrumentParams = {
  bright: 0.5,
  drive: 0,
  detune: 10,
  decay: 0,
  vibrato: 10,
  noise: 0,
  pitch: 0,
};

export type Draw = (k: Kit, t: number, hz: number, len: number, p: InstrumentParams) => void;

type NoiseColor = 'white' | 'pink' | 'brown';
const noiseCache = new Map<number, Record<NoiseColor, AudioBuffer>>();

/** Seeded, seamlessly looping noise tables per render rate. */
function noiseTables(ctx: BaseAudioContext): Record<NoiseColor, AudioBuffer> {
  const rate = ctx.sampleRate;
  let t = noiseCache.get(rate);
  if (!t) {
    const length = Math.round(R.noiseSeconds * rate);
    const xf = Math.round(NOISE_LOOP_XF * rate);
    const make = (
      fill: (out: Float32Array<ArrayBuffer>, rng: Rng) => Float32Array<ArrayBuffer>,
      name: string,
    ): AudioBuffer => {
      const raw = fill(new Float32Array(length + xf), new Rng(`${MUSIC.seed}:noise:${name}`));
      const data = normalizeRms(makeLoopable([raw], xf)[0]!, WHITE_NOISE_RMS);
      const buf = ctx.createBuffer(1, length, rate);
      buf.copyToChannel(data, 0);
      return buf;
    };
    t = { white: make(fillWhite, 'white'), pink: make(fillPink, 'pink'), brown: make(fillBrown, 'brown') };
    noiseCache.set(rate, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** Nearest frequency with whole cycles per `loop` seconds. */
export function gridHz(f: number, loop: number): number {
  const step = 1 / loop;
  return Math.max(step, Math.round(f / step) * step);
}

function cents(f: number, c: number): number {
  return f * Math.pow(2, c / 1200);
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(freq, ctx.sampleRate * 0.45);
  f.Q.value = q;
  return f;
}

function gain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

const shaperCache = new Map<number, Float32Array<ArrayBuffer>>();
function shaper(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const key = Math.round(drive * 100);
  let c = shaperCache.get(key);
  if (!c) {
    c = new Float32Array(2048);
    const norm = Math.tanh(drive);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(drive * x) / norm;
    }
    shaperCache.set(key, c);
  }
  const ws = ctx.createWaveShaper();
  ws.curve = c;
  ws.oversample = '2x';
  return ws;
}

interface OscVoice {
  readonly f: number;
  readonly type: OscillatorType;
  readonly level: number;
  readonly pan?: number;
}

/** Oscillators (optionally panned) summed into `into`, running over [t, t + dur]. */
function oscStack(
  ctx: BaseAudioContext,
  into: AudioNode,
  t: number,
  dur: number,
  voices: readonly OscVoice[],
  vibrato?: { rate: number; depth: number },
): void {
  const limit = ctx.sampleRate * 0.45;
  for (const v of voices) {
    if (!(v.f < limit) || v.f <= 0) continue;
    const o = ctx.createOscillator();
    o.type = v.type;
    o.frequency.value = v.f;
    if (vibrato && vibrato.depth > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vibrato.rate;
      const d = gain(ctx, v.f * vibrato.depth);
      lfo.connect(d).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
    }
    const g = gain(ctx, v.level);
    o.connect(g);
    if (v.pan && ctx.destination.channelCount > 1) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, v.pan));
      g.connect(p).connect(into);
    } else {
      g.connect(into);
    }
    o.start(t);
    o.stop(t + dur);
  }
}

/** LFO on an AudioParam over [t, t + dur]. */
function lfo(
  ctx: BaseAudioContext,
  param: AudioParam,
  t: number,
  dur: number,
  rate: number,
  depth: number,
): void {
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = gain(ctx, depth);
  o.connect(g).connect(param);
  o.start(t);
  o.stop(t + dur);
}

/** A stereo-capable summing input (fixed channel count, see Kit.fixedInput). */
function sumNode(ctx: BaseAudioContext): GainNode {
  const g = ctx.createGain();
  g.channelCountMode = 'explicit';
  g.channelCount = ctx.destination.channelCount;
  return g;
}

/** Detuned pair / triple frequencies on the loop grid. */
function spread(hz: number, detune: number, loop: number, count: 2 | 3): number[] {
  if (count === 2) return [gridHz(cents(hz, -detune / 2), loop), gridHz(cents(hz, detune / 2), loop)];
  return [gridHz(cents(hz, -detune), loop), gridHz(hz, loop), gridHz(cents(hz, detune), loop)];
}

// ---------------------------------------------------------------------------
// Sustained recipes (t = 0, len = loop body + crossfade, hz on the loop grid)
// ---------------------------------------------------------------------------

const loopOf = (recipe: InstrumentRecipe): number =>
  recipe.startsWith('drone.') ? R.droneLoopSeconds : R.loopSeconds;

const SUSTAINED: Partial<Record<InstrumentRecipe, Draw>> = {
  'pad.analog': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const cutoff = Math.max(300, Math.min(6000, hz * (2 + p.bright * 12)));
    const f = filter(ctx, 'lowpass', cutoff, 0.9);
    lfo(ctx, f.frequency, t, len, 1 / L, cutoff * 0.3);
    const [a, b, c] = spread(hz, p.detune, L, 3);
    oscStack(ctx, sum, t, len, [
      { f: a!, type: 'sawtooth', level: 0.3, pan: -0.6 },
      { f: b!, type: 'sawtooth', level: 0.3, pan: 0 },
      { f: c!, type: 'sawtooth', level: 0.3, pan: 0.6 },
      { f: gridHz(hz / 2, L), type: 'square', level: 0.07 },
    ]);
    sum.connect(f);
    lb.add(f);
  },
  'pad.glass': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const trem = gain(ctx, 1);
    lfo(ctx, trem.gain, t, len, 1 / L, 0.18);
    oscStack(ctx, sum, t, len, [
      { f: gridHz(hz, L), type: 'triangle', level: 0.4 },
      { f: gridHz(cents(hz, 4), L), type: 'sine', level: 0.25, pan: -0.5 },
      { f: gridHz(hz * 2, L), type: 'sine', level: 0.2, pan: 0.5 },
      { f: gridHz(cents(hz * 2, -5), L), type: 'sine', level: 0.12, pan: -0.3 },
      { f: gridHz(hz * 3, L), type: 'sine', level: 0.06 * (0.5 + p.bright), pan: 0.4 },
      { f: gridHz(hz * 4, L), type: 'sine', level: 0.04 * p.bright },
    ]);
    sum.connect(trem);
    lb.add(trem);
    k.bed(t, len, 'white', 'highpass', 6000, 0.7, 0.012 * (0.4 + p.bright));
  },
  'pad.breath': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const src = sumNode(ctx);
    const [a, b] = spread(hz, p.detune, L, 2);
    oscStack(ctx, src, t, len, [
      { f: a!, type: 'sawtooth', level: 0.4, pan: -0.4 },
      { f: b!, type: 'sawtooth', level: 0.4, pan: 0.4 },
      { f: gridHz(hz, L), type: 'triangle', level: 0.3 },
    ]);
    const out = sumNode(ctx);
    for (const [fq, g] of VOWEL_OH) {
      const bp = filter(ctx, 'bandpass', fq, 5);
      src
        .connect(bp)
        .connect(gain(ctx, g * 1.6))
        .connect(out);
    }
    const am = gain(ctx, 1);
    lfo(ctx, am.gain, t, len, 1 / L, 0.25);
    out.connect(am);
    lb.add(am);
    // Breath through the same vowel (uncorrelated noise: plain equal-power loop).
    if (p.noise > 0) {
      for (const [fq, g] of VOWEL_OH) k.bed(t, len, 'pink', 'bandpass', fq, 4, 0.05 * p.noise * g);
    }
  },
  'pad.metal': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const lp = filter(ctx, 'lowpass', Math.min(5000, hz * (6 + p.bright * 10)), 1.2);
    lfo(ctx, lp.frequency, t, len, 1 / L, hz * 2);
    oscStack(ctx, sum, t, len, [
      { f: gridHz(hz, L), type: 'sawtooth', level: 0.3, pan: -0.3 },
      { f: gridHz(cents(hz, 7), L), type: 'sawtooth', level: 0.25, pan: 0.3 },
      { f: gridHz(hz * 1.498, L), type: 'square', level: 0.1 },
      { f: gridHz(hz * 2.41, L), type: 'sine', level: 0.12, pan: 0.6 },
      { f: gridHz(hz * 3.13, L), type: 'sine', level: 0.08, pan: -0.6 },
    ]);
    sum.connect(lp);
    lb.add(lp);
    k.bed(t, len, 'white', 'bandpass', hz * 8, 12, 0.02);
  },
  'drone.dark': (k, t, hz, len, p) => {
    const L = R.droneLoopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const cutoff = 180 + p.bright * 900;
    const lp = filter(ctx, 'lowpass', cutoff, 1.4);
    lfo(ctx, lp.frequency, t, len, 1 / L, cutoff * 0.45);
    const [a, b] = spread(hz, 14, L, 2);
    const [c, d] = spread(hz * 1.4983, 10, L, 2);
    oscStack(ctx, sum, t, len, [
      { f: a!, type: 'sawtooth', level: 0.35, pan: -0.5 },
      { f: b!, type: 'sawtooth', level: 0.35, pan: 0.5 },
      { f: c!, type: 'square', level: 0.12, pan: 0.3 },
      { f: d!, type: 'square', level: 0.12, pan: -0.3 },
    ]);
    let last: AudioNode = lp;
    sum.connect(lp);
    if (p.drive > 0) last = lp.connect(shaper(ctx, 1 + p.drive * 3));
    lb.add(last);
    const sub = sumNode(ctx);
    oscStack(ctx, sub, t, len, [{ f: gridHz(hz / 2 >= 30 ? hz / 2 : hz, L), type: 'sine', level: 0.25 }]);
    lb.add(sub);
    k.bed(t, len, 'brown', 'lowpass', 260, 0.7, 0.14);
  },
  'drone.ice': (k, t, hz, len, p) => {
    const L = R.droneLoopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    oscStack(ctx, sum, t, len, [
      { f: gridHz(hz, L), type: 'sine', level: 0.3 },
      { f: gridHz(cents(hz, 6), L), type: 'sine', level: 0.2, pan: 0.5 },
      { f: gridHz(hz * 1.4983, L), type: 'sine', level: 0.18, pan: -0.5 },
      { f: gridHz(hz * 2, L), type: 'triangle', level: 0.14, pan: 0.2 },
      { f: gridHz(hz * 2.2449, L), type: 'sine', level: 0.08 * (0.5 + p.bright), pan: -0.6 },
      { f: gridHz(cents(hz * 3, -4), L), type: 'sine', level: 0.05 * (0.5 + p.bright), pan: 0.6 },
    ]);
    const trem = gain(ctx, 1);
    lfo(ctx, trem.gain, t, len, 1 / L, 0.2);
    sum.connect(trem);
    lb.add(trem);
    // Icy whisper, drifting.
    k.bed(t, len, 'white', 'bandpass', 5500 + p.bright * 2500, 3, 0.02, {
      freqLfo: { rate: 1 / L, depth: 1500 },
      gainLfo: { rate: 1 / L, depth: 0.5 },
    });
  },
  'drone.organic': (k, t, hz, len) => {
    const L = R.droneLoopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const src = sumNode(ctx);
    const [a, b] = spread(hz, 8, L, 2);
    oscStack(ctx, src, t, len, [
      { f: a!, type: 'sawtooth', level: 0.45, pan: -0.3 },
      { f: b!, type: 'sawtooth', level: 0.45, pan: 0.3 },
    ]);
    const out = sumNode(ctx);
    // A slowly morphing vowel ("didgeridoo"): formant centres swept between "oh" and "ah".
    VOWEL_OH.forEach(([fq, g], idx) => {
      const target = VOWEL_AH[idx]![0];
      const bp = filter(ctx, 'bandpass', (fq + target) / 2, 6);
      lfo(ctx, bp.frequency, t, len, 1 / L, Math.abs(target - fq) / 2);
      src
        .connect(bp)
        .connect(gain(ctx, g * 2))
        .connect(out);
    });
    lb.add(out);
    const sub = sumNode(ctx);
    oscStack(ctx, sub, t, len, [{ f: gridHz(hz, L), type: 'sine', level: 0.3 }]);
    lb.add(sub);
    k.bed(t, len, 'brown', 'lowpass', 180, 0.7, 0.18, { gainLfo: { rate: 1 / L, depth: 0.4 } });
  },
  'drone.rift': (k, t, hz, len) => {
    const L = R.droneLoopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const wobble = { rate: 1 / L, depth: 0.012 };
    oscStack(
      ctx,
      sum,
      t,
      len,
      [
        { f: gridHz(hz, L), type: 'sawtooth', level: 0.3, pan: -0.4 },
        { f: gridHz(hz * Math.pow(2, 1 / 12), L), type: 'sawtooth', level: 0.18, pan: 0.5 },
        { f: gridHz(hz * Math.SQRT2, L), type: 'triangle', level: 0.2, pan: -0.6 },
        { f: gridHz(hz * 2.03, L), type: 'sine', level: 0.12, pan: 0.2 },
      ],
      wobble,
    );
    const lp = filter(ctx, 'lowpass', 900, 2);
    lfo(ctx, lp.frequency, t, len, 1 / L, 500);
    sum.connect(lp);
    lb.add(lp);
    // Ring-modulated shimmer (carrier × modulator – both on the grid, so the product is too).
    const car = ctx.createOscillator();
    car.frequency.value = gridHz(hz * 4, L);
    const mod = ctx.createOscillator();
    mod.frequency.value = gridHz(hz * 1.5, L);
    const vca = gain(ctx, 0);
    mod.connect(vca.gain);
    car.connect(vca);
    const lvl = gain(ctx, 0.05);
    vca.connect(lvl);
    car.start(t);
    car.stop(t + len);
    mod.start(t);
    mod.stop(t + len);
    lb.add(lvl, 0.3);
    k.bed(t, len, 'pink', 'bandpass', 700, 2, 0.03, { freqLfo: { rate: 1 / L, depth: 300 } });
  },
  'strings.ensemble': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    const voices: OscVoice[] = [];
    const detunes = [-15, -9, -4, 4, 9, 15];
    detunes.forEach((c, idx) => {
      voices.push({ f: gridHz(cents(hz, c), L), type: 'sawtooth', level: 0.16, pan: (idx / 5) * 1.6 - 0.8 });
    });
    oscStack(ctx, sum, t, len, voices, { rate: 5, depth: 0.0035 });
    const hp = filter(ctx, 'highpass', 140, 0.7);
    const lp = filter(ctx, 'lowpass', 1100 + p.bright * 3600, 0.6);
    sum.connect(hp).connect(lp);
    lb.add(lp);
  },
  'choir.dark': (k, t, hz, len) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const src = sumNode(ctx);
    const [a, b, c] = spread(hz, 9, L, 3);
    oscStack(
      ctx,
      src,
      t,
      len,
      [
        { f: a!, type: 'sawtooth', level: 0.33, pan: -0.6 },
        { f: b!, type: 'sawtooth', level: 0.33, pan: 0 },
        { f: c!, type: 'sawtooth', level: 0.33, pan: 0.6 },
      ],
      { rate: 5, depth: 0.005 },
    );
    const out = sumNode(ctx);
    const formants = hz < 200 ? VOWEL_OH : VOWEL_AH;
    for (const [fq, g] of formants) {
      const bp = filter(ctx, 'bandpass', fq, 6);
      src
        .connect(bp)
        .connect(gain(ctx, g * 2.2))
        .connect(out);
    }
    lb.add(out);
    for (const [fq, g] of formants) k.bed(t, len, 'pink', 'bandpass', fq, 5, 0.012 * g);
  },
  'lead.sine': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    oscStack(
      ctx,
      sum,
      t,
      len,
      [
        { f: gridHz(hz, L), type: 'sine', level: 0.8 },
        { f: gridHz(hz * 2, L), type: 'sine', level: 0.12 },
        { f: gridHz(hz * 3, L), type: 'sine', level: 0.04 },
      ],
      { rate: 5.5, depth: Math.pow(2, p.vibrato / 1200) - 1 },
    );
    lb.add(sum);
    if (p.noise > 0) k.bed(t, len, 'pink', 'bandpass', hz * 2, 3, 0.08 * p.noise);
  },
  'lead.saw': (k, t, hz, len, p) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    oscStack(
      ctx,
      sum,
      t,
      len,
      [
        { f: gridHz(hz, L), type: 'sawtooth', level: 0.45 },
        { f: gridHz(cents(hz, 6), L), type: 'square', level: 0.2 },
      ],
      { rate: 5.5, depth: Math.pow(2, p.vibrato / 1200) - 1 },
    );
    const lp = filter(ctx, 'lowpass', Math.min(8000, hz * (3 + p.bright * 8)), 1.1);
    sum.connect(lp);
    lb.add(lp);
  },
  'sub.sine': (k, t, hz, len) => {
    const L = R.loopSeconds;
    const ctx = k.ctx;
    const lb = k.loopBus(t, len, R.loopCrossfade);
    const sum = sumNode(ctx);
    oscStack(ctx, sum, t, len, [
      { f: gridHz(hz, L), type: 'sine', level: 0.9 },
      { f: gridHz(hz * 2, L), type: 'sine', level: 0.08 },
    ]);
    lb.add(sum);
  },
};

// ---------------------------------------------------------------------------
// Pitched one-shots
// ---------------------------------------------------------------------------

/** Filter-enveloped oscillator stack with a percussive amp envelope. */
function envelopedStack(
  k: Kit,
  t: number,
  voices: readonly OscVoice[],
  o: {
    from: number;
    to: number;
    sweep: number;
    q: number;
    attack: number;
    decay: number;
    peak: number;
    drive?: number;
    hold?: number;
    open?: number;
  },
): void {
  const ctx = k.ctx;
  const dur = o.attack + (o.hold ?? 0) + o.decay * 2.2 + 0.02;
  const sum = sumNode(ctx);
  oscStack(ctx, sum, t, dur, voices);
  const lp = filter(ctx, 'lowpass', o.from, o.q);
  const f = lp.frequency;
  f.setValueAtTime(Math.min(o.from, ctx.sampleRate * 0.45), t);
  if (o.open !== undefined)
    f.exponentialRampToValueAtTime(Math.min(o.open, ctx.sampleRate * 0.45), t + o.attack);
  f.exponentialRampToValueAtTime(Math.max(30, o.to), t + o.attack + o.sweep);
  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(o.peak, t + Math.max(0.001, o.attack));
  if (o.hold) env.gain.setValueAtTime(o.peak, t + o.attack + o.hold);
  env.gain.setTargetAtTime(0, t + o.attack + (o.hold ?? 0), Math.max(0.001, o.decay / 4));
  let last: AudioNode = sum.connect(lp);
  if (o.drive && o.drive > 0) last = last.connect(shaper(ctx, o.drive));
  last.connect(env);
  k.add(env);
}

const PITCHED: Partial<Record<InstrumentRecipe, Draw>> = {
  'bass.pulse': (k, t, hz, _len, p) => {
    envelopedStack(
      k,
      t,
      [
        { f: hz, type: 'sawtooth', level: 0.5 },
        { f: cents(hz, 7), type: 'square', level: 0.3 },
        { f: hz / 2, type: 'sine', level: 0.35 },
      ],
      {
        from: hz * (5 + p.bright * 22),
        to: hz * 1.4,
        sweep: 0.2,
        q: 5,
        attack: 0.003,
        decay: 0.34,
        peak: 0.9,
        drive: 1 + p.drive * 3,
      },
    );
  },
  'bass.fm': (k, t, hz, _len, p) => {
    const b = k.bus({ drive: 1 + p.drive * 3, lowpass: Math.min(6000, hz * (8 + p.bright * 20)) });
    b.fm(t, hz, 1, 2 + p.bright * 4, 0.004, 0.42, 0.7);
    b.fm(t, hz * 2, 0.5, 1.2, 0.003, 0.2, 0.25);
    b.tone(t, 'sine', hz, hz, 0.004, 0.5, 0.5);
  },
  'bass.round': (k, t, hz) => {
    const b = k.bus({ lowpass: Math.min(1400, hz * 10) });
    b.tone(t, 'triangle', hz, hz, 0.008, 0.55, 0.7);
    b.tone(t, 'sine', hz, hz, 0.006, 0.7, 0.55);
    b.tone(t, 'sine', hz * 2, hz * 2, 0.004, 0.12, 0.12);
  },
  'dist.saw': (k, t, hz, _len, p) => {
    envelopedStack(
      k,
      t,
      [
        { f: hz, type: 'sawtooth', level: 0.4 },
        { f: cents(hz, 9), type: 'sawtooth', level: 0.4 },
        { f: hz * 1.4983, type: 'sawtooth', level: 0.3 },
        { f: hz / 2, type: 'square', level: 0.25 },
      ],
      {
        from: 3200,
        to: 1400,
        sweep: 0.25,
        q: 1.2,
        attack: 0.004,
        decay: 0.45,
        peak: 0.8,
        drive: 3 + p.drive * 7,
      },
    );
  },
  'arp.glass': (k, t, hz, _len, p) => {
    k.bell(t, hz, 0.9 + p.bright * 0.5, 0.55);
    k.fm(t, hz, 3.01, 1 + p.bright, 0.001, 0.35, 0.3);
    k.tone(t, 'sine', hz, hz, 0.002, 1.1, 0.25);
  },
  'arp.pluck': (k, t, hz, _len, p) => {
    k.pluck(t, hz, 0.7, 0.8, 0, 0.55 + p.bright * 0.35);
  },
  'arp.square': (k, t, hz, _len, p) => {
    envelopedStack(
      k,
      t,
      [
        { f: hz, type: 'square', level: 0.5 },
        { f: cents(hz, 5), type: 'sawtooth', level: 0.25 },
      ],
      {
        from: hz * (4 + p.bright * 14),
        to: hz * 1.3,
        sweep: 0.18,
        q: 3,
        attack: 0.002,
        decay: 0.28,
        peak: 0.8,
      },
    );
  },
  'arp.marimba': (k, t, hz) => {
    k.tone(t, 'sine', hz, hz, 0.002, 0.55, 0.8);
    k.tone(t, 'sine', hz * 3.93, hz * 3.93, 0.001, 0.07, 0.3);
    k.tone(t, 'sine', hz * 9.2, hz * 9.2, 0.001, 0.02, 0.1);
    k.noise(t, { color: 'pink', filter: 'bandpass', freq: hz * 2, q: 2, decay: 0.012, peak: 0.25 });
  },
  'arp.ring': (k, t, hz) => {
    k.ringMod(t, hz, hz * 1.414, 0.002, 0.6, 0.5);
    k.tone(t, 'sine', hz, hz * 0.995, 0.002, 0.7, 0.45);
    k.tone(t, 'triangle', hz * 2.76, hz * 2.7, 0.001, 0.2, 0.12);
  },
  'stab.brass': (k, t, hz, _len, p) => {
    envelopedStack(
      k,
      t,
      [
        { f: cents(hz, -8), type: 'sawtooth', level: 0.3, pan: -0.5 },
        { f: hz, type: 'sawtooth', level: 0.3 },
        { f: cents(hz, 8), type: 'sawtooth', level: 0.3, pan: 0.5 },
        { f: hz / 2, type: 'sawtooth', level: 0.2 },
      ],
      {
        from: hz * 1.5,
        open: Math.min(9000, hz * (8 + p.bright * 6)),
        to: hz * 2.5,
        sweep: 0.5,
        q: 1.2,
        attack: 0.05,
        hold: 0.2,
        decay: 0.55,
        peak: 0.75,
        drive: 1.5,
      },
    );
  },
  'stab.choir': (k, t, hz) => {
    k.choir(t, [hz, hz * 1.4983], 0.05, 0.35, 0.8, 0.9, { formants: hz < 200 ? VOWEL_OH : VOWEL_AH });
  },
};

// ---------------------------------------------------------------------------
// Percussion and textures (hz unused; `len` = bar length for bar-long recipes)
// ---------------------------------------------------------------------------

/** 808-style metallic hat: six detuned squares through high/band-passes, percussive. */
function metalHat(k: Kit, t: number, decay: number, bright: number, peak: number): void {
  const ctx = k.ctx;
  const sum = sumNode(ctx);
  const scale = 1.4 + bright * 0.6;
  oscStack(
    ctx,
    sum,
    t,
    decay * 3 + 0.02,
    [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => ({
      f: f * scale,
      type: 'square' as const,
      level: 0.16,
    })),
  );
  const hp = filter(ctx, 'highpass', 7000, 0.8);
  const bp = filter(ctx, 'bandpass', 10000, 0.6);
  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.0008);
  env.gain.setTargetAtTime(0, t + 0.0008, decay / 4);
  sum.connect(hp).connect(bp).connect(env);
  k.add(env);
  k.noise(t, { color: 'white', filter: 'highpass', freq: 8000, decay: decay * 0.7, peak: peak * 0.4 });
}

const PERCUSSION: Partial<Record<InstrumentRecipe, Draw>> = {
  'kick.industrial': (k, t, _hz, _len, p) => {
    k.thump(t, {
      f0: 165 * k.j(0.03),
      f1: 44,
      pitchTime: 0.06,
      decay: 0.36,
      peak: 0.95,
      drive: 1 + p.drive * 3,
    });
    k.click(t, 3200, 0.005, 0.5);
    k.noise(t, { color: 'pink', filter: 'lowpass', freq: 1600, decay: 0.03, peak: 0.45 });
  },
  'kick.deep': (k, t) => {
    k.thump(t, { f0: 98 * k.j(0.03), f1: 38, pitchTime: 0.1, decay: 0.6, peak: 1 });
    k.tone(t, 'sine', 72, 66, 0.002, 0.3, 0.25);
    k.click(t, 1800, 0.006, 0.22);
  },
  'kick.soft': (k, t) => {
    k.thump(t, { f0: 72 * k.j(0.03), f1: 42, pitchTime: 0.08, decay: 0.45, peak: 0.95 });
    k.noise(t, { color: 'pink', filter: 'lowpass', freq: 600, decay: 0.02, peak: 0.2 });
  },
  'snare.industrial': (k, t) => {
    k.noise(t, {
      color: 'white',
      filter: 'bandpass',
      freq: 2100 * k.j(0.08),
      q: 0.8,
      decay: 0.18,
      peak: 0.8,
    });
    k.thump(t, { f0: 230, f1: 170, pitchTime: 0.03, decay: 0.1, peak: 0.55 });
    k.ring(t, 560 * k.j(0.05), [1, 1.6, 2.3], 0.28, 0.14);
    k.noise(t + 0.01, {
      color: 'pink',
      filter: 'lowpass',
      freq: 3200,
      attack: 0.01,
      decay: 0.42,
      peak: 0.12,
    });
  },
  'snare.clap': (k, t) => {
    for (const [dt, pan] of [
      [0, -0.3],
      [0.011, 0.3],
      [0.023, -0.1],
    ] as const) {
      k.noise(t + dt * k.j(0.1), {
        color: 'white',
        filter: 'bandpass',
        freq: 1400,
        q: 1.3,
        decay: 0.012,
        peak: 0.7,
        pan,
      });
    }
    k.noise(t + 0.03, { color: 'white', filter: 'bandpass', freq: 1250, q: 0.9, decay: 0.17, peak: 0.55 });
  },
  'snare.rim': (k, t) => {
    k.click(t, 3200, 0.006, 0.6);
    k.tone(t, 'triangle', 830 * k.j(0.03), 800, 0.001, 0.05, 0.5);
    k.tone(t, 'sine', 1650, 1640, 0.001, 0.03, 0.25);
  },
  'hat.closed': (k, t, _hz, _len, p) => metalHat(k, t, 0.045 * k.j(0.15), p.bright, 0.6),
  'hat.open': (k, t, _hz, _len, p) => metalHat(k, t, (p.decay || 0.34) * k.j(0.1), p.bright, 0.55),
  'hat.shaker': (k, t, _hz, _len, p) => {
    const d = p.decay || 0.06;
    k.noise(t, {
      color: 'white',
      filter: 'bandpass',
      freq: 5600 * k.j(0.1),
      q: 1.3,
      attack: 0.012,
      decay: d,
      peak: 0.6,
    });
    k.noise(t + 0.03, {
      color: 'white',
      filter: 'bandpass',
      freq: 6400,
      q: 1.5,
      attack: 0.008,
      decay: d * 0.6,
      peak: 0.3,
    });
  },
  'metal.anvil': (k, t) => {
    k.ring(t, 1100 * k.j(0.04), [1, 1.47, 2.09, 2.56, 3.5], 0.9, 0.5);
    k.click(t, 4000, 0.004, 0.4);
  },
  'metal.pipe': (k, t) => {
    k.ring(t, 420 * k.j(0.04), [1, 2.76, 5.4, 8.93], 1.2, 0.55);
    k.thump(t, { f0: 320, f1: 260, pitchTime: 0.02, decay: 0.06, peak: 0.3 });
  },
  'metal.glass': (k, t) => {
    k.bell(t, 2100 * k.j(0.02), 1.3, 0.5);
    k.bell(t + 0.004, 3150 * k.j(0.02), 0.8, 0.22);
  },
  'metal.wood': (k, t) => {
    k.tone(t, 'sine', 900 * k.j(0.03), 880, 0.001, 0.09, 0.7);
    k.tone(t, 'sine', 3520, 3500, 0.001, 0.02, 0.25);
    k.click(t, 2500, 0.004, 0.3);
  },
  'perc.glitch': (k, t) => {
    const n = 3 + k.rng.int(0, 2);
    for (let q = 0; q < n; q++) {
      const at = t + k.rng.next() * 0.09;
      k.ringMod(at, k.r(1800, 4200), k.r(250, 900), 0.0005, 0.018, 0.4, {
        type: 'square',
        pan: k.r(-0.7, 0.7),
      });
    }
    k.crackle(t, 0.1, 60, 3500, 4, 0.2, 0.6);
  },
  'perc.drip': (k, t, _hz, _len, p) => {
    const f = (p.pitch || 1300) * k.j(0.05);
    k.tone(t, 'sine', f, f * 1.9, 0.001, 0.09, 0.6);
    k.tone(t + 0.07, 'sine', f * 1.3, f * 2.1, 0.001, 0.05, 0.2);
  },
  'perc.ping': (k, t, _hz, _len, p) => {
    const f = p.pitch || 1320;
    k.note(t, 'sine', f, f, 0.004, 0.07, 0.18, 0.6);
    k.note(t, 'sine', f * 2, f * 2, 0.004, 0.04, 0.08, 0.12);
  },
  'tom.floor': (k, t) => {
    k.thump(t, { f0: 135, f1: 86, pitchTime: 0.08, decay: 0.42, peak: 0.9 });
    k.noise(t, { color: 'pink', filter: 'bandpass', freq: 420, q: 1.2, decay: 0.05, peak: 0.35 });
  },
  'tom.tribal': (k, t) => {
    k.thump(t, { f0: 112, f1: 70, pitchTime: 0.09, decay: 0.5, peak: 0.95 });
    k.noise(t, { color: 'white', filter: 'bandpass', freq: 1200, q: 1, decay: 0.02, peak: 0.4 });
    k.tone(t, 'sine', 185, 178, 0.001, 0.25, 0.18);
  },
  'crash.impact': (k, t) => {
    k.thump(t, { f0: 62, f1: 28, pitchTime: 0.4, decay: 1.2, peak: 0.9, drive: 1 });
    k.noise(t, { color: 'brown', filter: 'lowpass', freq: 220, decay: 0.9, peak: 0.6 });
    k.noise(t, {
      color: 'white',
      filter: 'highpass',
      freq: 3200,
      sweepTo: 1800,
      decay: 1.6,
      peak: 0.28,
      pan: -0.5,
    });
    k.noise(t + 0.004, {
      color: 'white',
      filter: 'highpass',
      freq: 3600,
      sweepTo: 2000,
      decay: 1.5,
      peak: 0.28,
      pan: 0.5,
    });
    k.ring(t, 176, [1, 2.02, 2.74, 4.1], 2, 0.14);
  },
  'riser.noise': (k, t, _hz, len) => {
    const top = len * 0.97;
    for (const pan of [-0.4, 0.4]) {
      k.swell(t, {
        color: 'white',
        filter: 'bandpass',
        freq: 380,
        q: 2.5,
        sweepTo: 6500,
        attack: top,
        hold: top,
        release: 0.04,
        peak: 0.45,
        pan,
        expRise: true,
      });
    }
    k.note(t, 'sawtooth', 110, 880, top, top, 0.04, 0.06, { lowpass: 1500, expRise: true });
  },
  'swell.reverse': (k, t, _hz, len) => {
    // Rendered forwards (a crash with a low boom and a metal ring), reversed afterwards.
    k.noise(t, { color: 'white', filter: 'highpass', freq: 2600, decay: len * 0.55, peak: 0.45, pan: -0.3 });
    k.noise(t, { color: 'white', filter: 'highpass', freq: 3000, decay: len * 0.5, peak: 0.45, pan: 0.3 });
    k.noise(t, { color: 'brown', filter: 'lowpass', freq: 380, decay: len * 0.45, peak: 0.6 });
    k.ring(t, 220, [1, 2.01, 2.99, 4.2], len * 0.6, 0.12);
  },
  'scrape.metal': (k, t, _hz, _len, p) => {
    const b = k.bus({
      highpass: 400,
      comb: {
        delay: 1 / (280 + p.bright * 200),
        sweepTo: 1 / (720 + p.bright * 400),
        sweepTime: 1.6,
        feedback: 0.86,
        damp: 5000,
        wet: 0.9,
        start: t,
      },
      pan: k.r(-0.5, 0.5),
    });
    b.swell(t, {
      color: 'white',
      filter: 'bandpass',
      freq: 1600,
      q: 1.5,
      sweepTo: 2600,
      attack: 0.35,
      hold: 0.9,
      release: 0.6,
      peak: 0.4,
    });
    b.crackle(t + 0.1, 1.2, 25, 3000, 3, 0.12, 0.4);
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type RenderMode = 'loop' | 'oneshot' | 'exact' | 'reverse';

/** One-shots with long tails render longer than MUSIC.render.oneShotSeconds (s, before trimming). */
const ONE_SHOT_SECONDS: Partial<Record<InstrumentRecipe, number>> = {
  'crash.impact': 3.4,
  'metal.pipe': 2.4,
  'metal.anvil': 2,
  'metal.glass': 2.2,
  'scrape.metal': 2.8,
  'stab.brass': 1.6,
  'stab.choir': 2.2,
  'arp.glass': 1.3,
  'arp.ring': 1.2,
  'bass.round': 1.4,
};

export interface RenderRequest {
  readonly channels: 1 | 2;
  readonly rate: number;
  /** Rendered seconds (loops: body + crossfade). */
  readonly seconds: number;
  readonly mode: RenderMode;
  readonly seed: string;
  readonly draw: (k: Kit) => void;
  /** Loop crossfade (s) folded into the loop point. */
  readonly loopCrossfade?: number;
}

export const offlineSupported = (): boolean => typeof OfflineAudioContext !== 'undefined';

/** Render one sample offline (null without OfflineAudioContext or on failure). */
export async function renderSample(req: RenderRequest): Promise<AudioBuffer | null> {
  if (!offlineSupported()) return null;
  const rate = req.rate;
  const frames = Math.max(1, Math.ceil(req.seconds * rate));
  const ctx = new OfflineAudioContext(req.channels, frames, rate);
  const out = ctx.createGain();
  out.channelCountMode = 'explicit';
  out.channelCount = req.channels;
  out.connect(ctx.destination);
  const kit = new Kit(ctx, out, new Rng(req.seed), noiseTables(ctx));
  req.draw(kit);
  const rendered = await ctx.startRendering();
  let chans: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < req.channels; c++) chans.push(rendered.getChannelData(c).slice());
  if (req.mode === 'loop') {
    chans = makeLoopable(chans, Math.round((req.loopCrossfade ?? R.loopCrossfade) * rate));
  } else if (req.mode === 'oneshot') {
    const len = audibleLength(chans, R.trimThreshold);
    chans = chans.map((ch) => ch.slice(0, len));
    fadeOutTail(chans, Math.round(R.endFade * rate));
  } else if (req.mode === 'reverse') {
    for (const ch of chans) ch.reverse();
    fadeOutTail(chans, Math.round(R.endFade * rate));
  }
  normalizeChannels(chans, R.normalizePeak);
  const first = chans[0]!;
  const buf = ctx.createBuffer(req.channels, first.length, rate);
  chans.forEach((ch, c) => buf.copyToChannel(ch, c));
  return buf;
}

export interface InstrumentRenderSpec {
  readonly recipe: InstrumentRecipe;
  readonly params: InstrumentParams;
  /** Rendered pitch (pitched recipes; loops are snapped to their grid by `renderInstrumentSample`). */
  readonly hz: number;
  /** Bar-long recipes: the bar length (s). */
  readonly barSeconds: number;
  readonly seed: string;
}

export interface RenderedSample {
  readonly buffer: AudioBuffer;
  /** Fundamental actually rendered (Hz; 0 for unpitched): playback rate = target / hz. */
  readonly hz: number;
  readonly loop: boolean;
}

/** Render one sample of an instrument recipe. */
export async function renderInstrumentSample(spec: InstrumentRenderSpec): Promise<RenderedSample | null> {
  const info = INSTRUMENT_RECIPES[spec.recipe];
  const rate = info.dark ? R.darkRate : R.sampleRate;
  const channels = info.stereo ? 2 : 1;
  const p = spec.params;
  if (info.loop) {
    const L = loopOf(spec.recipe);
    const hz = gridHz(spec.hz, L);
    const draw = SUSTAINED[spec.recipe];
    if (!draw) return null;
    const buffer = await renderSample({
      channels,
      rate,
      seconds: L + R.loopCrossfade,
      mode: 'loop',
      seed: spec.seed,
      draw: (k) => draw(k, 0, hz, L + R.loopCrossfade, p),
    });
    return buffer ? { buffer, hz, loop: true } : null;
  }
  const bar = 'bar' in info && info.bar === true;
  const draw = PITCHED[spec.recipe] ?? PERCUSSION[spec.recipe];
  if (!draw) return null;
  const seconds = bar
    ? spec.barSeconds
    : Math.max(ONE_SHOT_SECONDS[spec.recipe] ?? R.oneShotSeconds, p.decay * 3);
  const buffer = await renderSample({
    channels,
    rate,
    seconds: bar || spec.recipe in ONE_SHOT_SECONDS ? seconds : seconds + 0.6,
    mode: spec.recipe === 'swell.reverse' ? 'reverse' : bar ? 'exact' : 'oneshot',
    seed: spec.seed,
    draw: (k) => draw(k, 0, spec.hz, seconds, p),
  });
  return buffer ? { buffer, hz: info.pitched ? spec.hz : 0, loop: false } : null;
}

/** Recipe tables (tests: every recipe has an implementation). */
export function hasRecipe(recipe: InstrumentRecipe): boolean {
  return recipe in SUSTAINED || recipe in PITCHED || recipe in PERCUSSION;
}
