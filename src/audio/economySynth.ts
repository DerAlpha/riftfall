/**
 * Procedural economy sounds (M4). Same scheme as weaponSynth.ts / enemySynth.ts: SynthDefs that
 * the procedural bank renders once per sample rate with OfflineAudioContext (seeded variants),
 * cached, and overridden by real audio assets registered under the same id. synth.ts merges
 * ECONOMY_SYNTH_DEFS into SYNTH_DEFS; recipes only use `g.ctx` / `g.rng` (no runtime import of
 * synth.ts, no cycle).
 *
 * Palette: purchases are a register clack + coin + glassy bell ("ka-ching") with an FM chirp; the
 * denial is a detuned square buzzer; doors are pneumatic hiss + a hydraulic motor whine + latch
 * and end-stop clanks; the Rift-Kiste plays a music-box lullaby (comb-tine partials) that slows
 * with its roll, resolving to a bright bell chord or collapsing into a distorted diminished
 * cluster (anomaly); perk machines hum (mains + neon buzz) and every perk has its own short
 * jingle composed from its id (mode, root, tempo, rhythm, timbre – composeJingle); power-ups
 * shimmer while floating and each type has its own stinger; seals crackle when a bar breaks and
 * zap back when repaired.
 *
 * Loops (perk hum, pickup shimmer): tonal layers run on a bus with a sine/cosine edge envelope
 * over the loop crossfade and use whole cycles per loop, so the bank's equal-power crossfade
 * (dsp.makeLoopable) sums them to exactly unity (no swell at the loop point); noise layers stay at
 * a constant level (uncorrelated – equal power is right for them).
 *
 * Positional sounds are mono (HRTF panner input); 2D stingers are stereo. Frequencies, levels and
 * times inside the recipes are sound-design constants; triggering and mixing live in
 * AUDIO.economy.
 */
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { DOORS, MYSTERY_BOX } from '../defs/interactables';
import { PERK_IDS, type PerkId } from '../defs/perks';
import { fillBrown, fillPink, fillWhite, normalizeRms } from './dsp';
import type { SynthDef, SynthGraph } from './synth';

type Recipe = SynthDef['recipe'];
type NoiseColor = 'white' | 'pink' | 'brown';
type NoiseTables = Record<NoiseColor, AudioBuffer>;

const S = AUDIO.synth;
const EA = AUDIO.economy;
const WHITE_NOISE_RMS = 1 / Math.sqrt(3);
/** Loop crossfade of the bank (dsp.makeLoopable). */
const XF = S.slideLoopCrossfade;

/** Equal-tempered frequency of a MIDI note. */
export function midiHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

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
        fill(new Float32Array(length), new Rng(`${S.seed}:econ-noise:${name}`)),
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
}

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

interface BusOpts {
  drive?: number;
  lowpass?: number;
  highpass?: number;
  gain?: number;
  pan?: number;
}

/** Segments of the piecewise-linear sine/cosine loop edges. */
const LOOP_EDGE_STEPS = 12;

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
    const input = this.ctx.createGain();
    let last: AudioNode = input;
    if (o.drive && o.drive > 0) last = this.chain(last, this.shaper(o.drive));
    if (o.highpass) last = this.chain(last, this.filter('highpass', o.highpass, 0.707));
    if (o.lowpass) last = this.chain(last, this.filter('lowpass', o.lowpass, 0.707));
    const g = this.ctx.createGain();
    g.gain.value = o.gain ?? 1;
    last.connect(g);
    this.route(g, o.pan ?? 0);
    return new Kit(this.ctx, input, this.rng, this.noiseT);
  }

  /** Route an externally built node into this kit's output. */
  add(node: AudioNode, pan = 0): void {
    this.route(node, pan);
  }

  /**
   * Loop bus for tonal layers: its gain rises along sin(πu/2) over the first `xf` s from `t` and
   * falls along cos over the last `xf` s before `t + dur` (see the file header).
   */
  loopBus(t: number, dur: number, xf: number, gain = 1): Kit {
    const input = this.ctx.createGain();
    const p = input.gain;
    p.value = 0;
    p.setValueAtTime(0, t);
    const n = LOOP_EDGE_STEPS;
    for (let i = 1; i <= n; i++) p.linearRampToValueAtTime(gain * Math.sin((i / n) * Math.PI * 0.5), t + (xf * i) / n);
    const fall = t + Math.max(xf, dur - xf);
    p.setValueAtTime(gain, fall);
    for (let i = 1; i <= n; i++) {
      p.linearRampToValueAtTime(gain * Math.cos((i / n) * Math.PI * 0.5), fall + (xf * i) / n);
    }
    this.route(input, 0);
    return new Kit(this.ctx, input, this.rng, this.noiseT);
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
    g.gain.setTargetAtTime(0, t + attack, Math.max(1e-3, decay / 4));
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

  private noiseSource(color: NoiseColor, t: number, dur: number): AudioBufferSourceNode {
    const buf = this.noiseT[color];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(t, this.rng.next() * buf.duration * 0.9);
    src.stop(t + dur);
    return src;
  }

  /** Filtered noise burst. */
  noise(t: number, o: NoiseOpts): void {
    const attack = o.attack ?? 0.001;
    const dur = attack + o.decay * 1.4 + 0.01;
    const src = this.noiseSource(o.color, t, dur);
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

  /** Constant-level noise bed for loops (no envelope). */
  bed(t: number, dur: number, color: NoiseColor, filter: BiquadFilterType, freq: number, q: number, level: number): void {
    const src = this.noiseSource(color, t, dur);
    const f = this.filter(filter, freq, q);
    const g = this.ctx.createGain();
    g.gain.value = level;
    src.connect(f).connect(g);
    this.route(g, 0);
  }

  /** Pitched body with a fast pitch drop (f0 → f1 within `pitchTime`). */
  thump(t: number, f0: number, f1: number, pitchTime: number, decay: number, peak: number, drive = 0): void {
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(1e-3, pitchTime));
    osc.start(t);
    osc.stop(t + decay * 1.4 + 0.02);
    let last: AudioNode = osc;
    if (drive > 0) last = this.chain(last, this.shaper(drive));
    const e = this.env(t, 0.001, decay, peak);
    last.connect(e);
    this.route(e, 0);
  }

  /** Oscillator sweep with a percussive envelope. */
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

  /** Held oscillator note: attack → hold → release, optional glide to f1 over the hold. */
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

  /** Two-operator FM tone; the modulation index decays with the note (bright attack, soft tail). */
  fm(t: number, carrier: number, ratio: number, index: number, attack: number, decay: number, peak: number, pan = 0): void {
    const ctx = this.ctx;
    const stop = t + attack + decay * 1.4 + 0.01;
    const mod = ctx.createOscillator();
    mod.frequency.value = carrier * ratio;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    depth.gain.setValueAtTime(carrier * index, t);
    depth.gain.setTargetAtTime(carrier * index * 0.15, t + attack, Math.max(1e-3, decay / 3));
    const car = ctx.createOscillator();
    car.frequency.value = carrier;
    mod.connect(depth).connect(car.frequency);
    mod.start(t);
    mod.stop(stop);
    car.start(t);
    car.stop(stop);
    const e = this.env(t, attack, decay, peak);
    car.connect(e);
    this.route(e, pan);
  }

  /** Glassy bell: near-harmonic sine partials, higher ones die faster. */
  bell(t: number, f: number, decay: number, peak: number, pan = 0): void {
    const partials: readonly (readonly [number, number])[] = [
      [1, 1],
      [2.01, 0.5],
      [3.02, 0.26],
      [4.18, 0.16],
      [5.43, 0.08],
    ];
    for (let i = 0; i < partials.length; i++) {
      const [ratio, amp] = partials[i]!;
      this.tone(t, 'sine', f * ratio, f * ratio * 0.998, 0.001, decay / (1 + i * 0.7), peak * amp, pan);
    }
  }

  /** Music-box comb tine: fundamental + weak inharmonic partials + a tiny pluck click. */
  tine(t: number, f: number, decay: number, peak: number): void {
    this.tone(t, 'sine', f, f, 0.001, decay, peak);
    this.tone(t, 'sine', f * 3.97, f * 3.97, 0.001, decay * 0.3, peak * 0.22);
    this.tone(t, 'sine', f * 6.27, f * 6.27, 0.001, decay * 0.14, peak * 0.1);
    this.noise(t, { color: 'white', filter: 'highpass', freq: 6000, decay: 0.006, peak: peak * 0.3 });
  }

  /** Inharmonic partials (struck metal); higher partials die faster. */
  ring(t: number, base: number, ratios: readonly number[], decay: number, peak: number, pan = 0): void {
    for (let i = 0; i < ratios.length; i++) {
      const f = base * ratios[i]! * this.j(0.012);
      this.tone(t, 'sine', f, f * 0.996, 0.0008, decay / (1 + i * 0.55), peak / (1 + i * 0.6), pan);
    }
  }

  /** Scattered short band-passed ticks (crackle, debris). */
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
}

function kitOf(g: SynthGraph): Kit {
  return new Kit(g.ctx, g.ctx.destination, g.rng, noiseTables(g.ctx));
}

// ---------------------------------------------------------------------------
// Purchases, denial, points
// ---------------------------------------------------------------------------

/** "Ka-ching" with a sci-fi confirm: register clack, coin, two glass bells, FM chirp, sparkle. */
const purchase: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'highpass', freq: 2800, decay: 0.018, peak: 0.55 });
  k.thump(t, 190, 95, 0.03, 0.05, 0.4);
  k.noise(t + 0.035, { color: 'white', filter: 'bandpass', freq: 5200 * k.j(0.05), q: 4, decay: 0.035, peak: 0.5 });
  const b = midiHz(91) * k.j(0.006); // G6
  k.bell(t + 0.07, b, 0.75, 0.3);
  k.bell(t + 0.07, b * 1.3348, 0.65, 0.22); // C7
  k.fm(t + 0.05, 880, 2, 1.6, 0.004, 0.14, 0.12);
  const sparkle = [1, 1.26, 1.5];
  for (let i = 0; i < sparkle.length; i++) {
    const f = midiHz(96) * sparkle[i]!;
    k.tone(t + 0.1 + i * 0.035, 'triangle', f, f, 0.002, 0.12, 0.1);
  }
};

/** Detuned square buzzer, twice, through a saturated low-pass. */
const denied: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.2, lowpass: 1500, gain: 0.8 });
  for (let i = 0; i < 2; i++) {
    const s = t + i * 0.15;
    b.note(s, 'square', 116, 110, 0.004, 0.1, 0.03, 0.34);
    b.note(s, 'square', 123.5, 117, 0.004, 0.1, 0.03, 0.24);
  }
  k.thump(t, 90, 60, 0.05, 0.08, 0.3);
};

/** Tiny bright blip (per earning, very quiet in the mix). */
const pointsTick: Recipe = (g, t) => {
  const k = kitOf(g);
  const f = 2400 * k.j(0.02);
  k.tone(t, 'sine', f, f * 1.12, 0.001, 0.035, 0.5);
  k.tone(t, 'triangle', f * 2, f * 2, 0.001, 0.015, 0.14);
};

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/** Latch clank, pneumatic hiss, hydraulic motor whine for the opening time, end-stop thud. */
function doorOpen(blast: boolean): Recipe {
  const len = blast ? DOORS.blastOpenDuration : DOORS.openDuration;
  const low = blast ? 0.72 : 1;
  return (g, t) => {
    const k = kitOf(g);
    k.thump(t, 150 * low, 65 * low, 0.04, 0.09, 0.55, 1.5);
    k.noise(t, { color: 'white', filter: 'highpass', freq: 2600, decay: 0.02, peak: 0.5 });
    k.ring(t, 340 * low * k.j(0.04), [1, 2.43, 3.87], 0.3, 0.12);
    if (blast) {
      // Locking bolts retract before the leaf moves.
      for (let i = 0; i < 3; i++) {
        const s = t + 0.1 + i * 0.075;
        k.noise(s, { color: 'white', filter: 'bandpass', freq: 1900 * k.j(0.1), q: 2, decay: 0.03, peak: 0.4 });
        k.ring(s, 410 * k.j(0.05), [1, 2.6], 0.14, 0.07);
      }
    }
    const start = t + (blast ? 0.32 : 0.05);
    k.swell(start, {
      color: 'white',
      filter: 'bandpass',
      freq: 3800,
      sweepTo: 2000,
      q: 0.8,
      attack: 0.015,
      hold: 0.12 + len * 0.3,
      release: 0.35,
      peak: 0.42,
    });
    const motor = k.bus({ lowpass: 900 * low, drive: 1.2, gain: 0.7 });
    motor.note(start + 0.02, 'sawtooth', 70 * low, 118 * low, 0.08, len, 0.18, 0.28);
    motor.note(start + 0.02, 'sawtooth', 70.8 * low, 119.4 * low, 0.08, len, 0.18, 0.22);
    k.swell(start, {
      color: 'brown',
      filter: 'lowpass',
      freq: 220 * low,
      attack: 0.1,
      hold: len,
      release: 0.25,
      peak: 0.55,
    });
    const end = start + 0.02 + len;
    k.thump(end, 110 * low, 48 * low, 0.05, 0.16, 0.6, 2);
    k.noise(end, { color: 'pink', filter: 'lowpass', freq: 1400, decay: 0.08, peak: 0.45 });
    k.ring(end, 260 * low * k.j(0.04), [1, 2.7, 4.1], 0.35, 0.1);
  };
}

// ---------------------------------------------------------------------------
// Rift-Kiste (mystery box)
// ---------------------------------------------------------------------------

const boxOpen: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, 160, 70, 0.03, 0.08, 0.5, 1.2);
  k.noise(t, { color: 'white', filter: 'highpass', freq: 3000, decay: 0.015, peak: 0.45 });
  k.ring(t, 520, [1, 2.2, 3.6], 0.25, 0.1);
  k.swell(t + 0.04, {
    color: 'pink',
    filter: 'bandpass',
    freq: 380,
    sweepTo: 3200,
    q: 1.4,
    attack: 0.25,
    hold: 0.3,
    release: 0.35,
    peak: 0.55,
  });
  k.note(t + 0.05, 'sine', 180, 720, 0.12, 0.35, 0.3, 0.2);
  k.fm(t + 0.3, 1320, 1.5, 2, 0.01, 0.5, 0.1);
};

/** Lullaby pattern (semitones over the root) of the music box. */
const BOX_TUNE: readonly number[] = [0, 3, 7, 12, 10, 7, 3, 5, 8, 12, 15, 12, 8, 5, 2, 7];

/** Seconds between music-box notes at `u` (0..1 through the roll): quick, then winding down. */
export function boxNoteInterval(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return 0.075 + 0.26 * x * x * x + 0.05 * Math.max(0, 1 - x * 4);
}

/** Music box over the roll: the tines speed up, then slow down and sag flat like a spent spring. */
const boxRoll: Recipe = (g, t) => {
  const k = kitOf(g);
  const total = MYSTERY_BOX.rollDuration;
  const root = 79; // G5
  let time = 0;
  let i = 0;
  while (time < total - 0.05) {
    const u = time / total;
    const f = midiHz(root + BOX_TUNE[i % BOX_TUNE.length]!) * (1 - 0.035 * u * u);
    k.tine(t + time, f, 0.55, 0.42 * (0.8 + 0.2 * k.rng.next()));
    time += boxNoteInterval(u);
    i++;
  }
};

const boxResolve: Recipe = (g, t) => {
  const k = kitOf(g);
  const chord = [72, 76, 79, 84];
  for (let i = 0; i < chord.length; i++) k.bell(t + i * 0.025, midiHz(chord[i]! + 12), 1.1, 0.2);
  k.swell(t, { color: 'white', filter: 'highpass', freq: 5000, attack: 0.02, hold: 0.2, release: 0.8, peak: 0.16 });
  k.thump(t, 90, 45, 0.1, 0.4, 0.35);
  k.note(t, 'triangle', midiHz(60), midiHz(60), 0.01, 0.4, 0.6, 0.2);
};

/** Reverse swell into a saturated diminished cluster that sags, sub boom, glitch crackle. */
const boxAnomaly: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 500,
    sweepTo: 2600,
    q: 1.2,
    attack: 0.35,
    hold: 0.36,
    release: 0.05,
    peak: 0.6,
  });
  const s = t + 0.36;
  const b = k.bus({ drive: 3.5, lowpass: 2400, gain: 0.55 });
  for (const m of [45, 48, 51, 54, 57]) {
    const f = midiHz(m) * k.j(0.01);
    b.note(s, 'sawtooth', f, f * 0.7, 0.01, 1.4, 0.7, 0.2);
  }
  k.thump(s, 70, 28, 0.25, 0.9, 0.8, 2.5);
  k.clicks(s, 18, 1.2, 3000, 3, 0.25);
  k.note(s + 0.1, 'sine', 1900, 700, 0.05, 1.2, 0.5, 0.1);
};

/** The box bursts in at its new location. */
const boxArrive: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'white',
    filter: 'bandpass',
    freq: 3000,
    sweepTo: 600,
    q: 1,
    attack: 0.3,
    hold: 0.3,
    release: 0.1,
    peak: 0.45,
  });
  k.thump(t + 0.3, 110, 40, 0.12, 0.5, 0.7, 1.5);
  k.noise(t + 0.3, { color: 'pink', filter: 'lowpass', freq: 1200, decay: 0.2, peak: 0.5 });
  k.fm(t + 0.32, 660, 1.41, 3, 0.005, 0.7, 0.14);
};

// ---------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------

/** Machine hum loop: 50 Hz mains + harmonics, a flickering neon buzz, faint compressor hiss. */
const perkHum: Recipe = (g, t) => {
  const k = kitOf(g);
  const dur = EA.synth.humLoopSeconds + XF;
  // Whole cycles per loop (50 / 100 / 150 Hz and the 5 Hz flicker over 2.4 s).
  const tonal = k.loopBus(t, dur, XF);
  tonal.note(t, 'sine', 50, 50, 0.001, dur, 0.01, 0.5);
  tonal.note(t, 'sine', 100, 100, 0.001, dur, 0.01, 0.26);
  tonal.note(t, 'sine', 150, 150, 0.001, dur, 0.01, 0.08);
  const ctx = g.ctx;
  const flicker = ctx.createGain();
  flicker.gain.value = 0.07;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.03;
  lfo.connect(lfoDepth).connect(flicker.gain);
  lfo.start(t);
  lfo.stop(t + dur);
  const buzz = ctx.createOscillator();
  buzz.type = 'square';
  buzz.frequency.value = 100;
  buzz.start(t);
  buzz.stop(t + dur);
  buzz.connect(flicker);
  tonal.bus({ highpass: 300, lowpass: 2600 }).add(flicker);
  k.bed(t, dur, 'pink', 'bandpass', 1100, 0.6, 0.05);
  k.bed(t, dur, 'brown', 'lowpass', 90, 0.7, 0.12);
};

// --- perk jingles -----------------------------------------------------------

const JINGLE_MODES = {
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
} as const satisfies Record<string, readonly number[]>;

export type JingleMode = keyof typeof JINGLE_MODES;
const MODE_IDS = Object.keys(JINGLE_MODES) as JingleMode[];

/** Note lengths in eighths; the last one is the held resolution. */
const JINGLE_RHYTHMS: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 2, 1, 3],
  [2, 1, 1, 2, 1, 1, 4],
  [1, 1, 2, 1, 1, 2, 3],
  [1, 2, 1, 2, 1, 1, 3],
  [3, 1, 2, 1, 1, 1, 4],
  [1, 1, 1, 1, 1, 1, 2, 3],
];

export type JingleTimbre = 'chip' | 'glass' | 'brass' | 'organ';
const TIMBRES: readonly JingleTimbre[] = ['chip', 'glass', 'brass', 'organ'];

export interface JingleNote {
  /** Semitones over the root. */
  semis: number;
  /** Start and length (s). */
  start: number;
  length: number;
}

export interface Jingle {
  mode: JingleMode;
  /** MIDI root note. */
  root: number;
  /** Seconds per eighth. */
  eighth: number;
  timbre: JingleTimbre;
  notes: JingleNote[];
  /** Seconds until the last note ends. */
  length: number;
}

/**
 * A perk's jingle, composed from its id (deterministic, independent of render variants): mode,
 * root, tempo, rhythm and timbre are picked by an Rng seeded with the id; the melody walks the
 * mode's degrees and resolves on the root an octave up.
 */
export function composeJingle(perkId: string): Jingle {
  const rng = new Rng(`${S.seed}:jingle:${perkId}`);
  const mode = rng.pick(MODE_IDS);
  const scale = JINGLE_MODES[mode];
  const root = 57 + rng.int(0, 9);
  const eighth = 0.11 + rng.next() * 0.07;
  const rhythm = rng.pick(JINGLE_RHYTHMS);
  const timbre = rng.pick(TIMBRES);
  const n = scale.length;
  const semisOf = (degree: number): number => {
    const octave = Math.floor(degree / n);
    return scale[((degree % n) + n) % n]! + 12 * octave;
  };
  const notes: JingleNote[] = [];
  let degree = rng.pick([0, 2, n]);
  let time = 0;
  for (let i = 0; i < rhythm.length; i++) {
    const last = i === rhythm.length - 1;
    if (last) degree = n; // resolve on the root an octave up
    else if (i > 0) {
      const step = rng.pick([-2, -1, 1, 1, 2, 2, 3]);
      degree = Math.max(0, Math.min(2 * n - 1, degree + step));
    }
    const length = rhythm[i]! * eighth;
    notes.push({ semis: semisOf(degree), start: time, length });
    time += length;
  }
  return { mode, root, eighth, timbre, notes, length: time };
}

function jingleVoice(k: Kit, timbre: JingleTimbre, t: number, f: number, hold: number, peak: number): void {
  switch (timbre) {
    case 'chip':
      k.note(t, 'square', f, f, 0.004, hold * 0.8, 0.08, peak * 0.55);
      k.note(t, 'square', f * 2.003, f * 2.003, 0.004, hold * 0.4, 0.05, peak * 0.12);
      break;
    case 'glass':
      k.fm(t, f, 3.5, 2.2, 0.003, 0.25 + hold, peak);
      k.tone(t, 'sine', f * 2, f * 2, 0.002, 0.2 + hold * 0.5, peak * 0.25);
      break;
    case 'brass':
      k.note(t, 'sawtooth', f, f, 0.02, hold * 0.85, 0.1, peak * 0.45);
      k.note(t, 'sawtooth', f * 1.004, f * 1.004, 0.02, hold * 0.85, 0.1, peak * 0.3);
      break;
    case 'organ':
      k.note(t, 'sine', f, f, 0.01, hold * 0.9, 0.1, peak * 0.7);
      k.note(t, 'sine', f * 2, f * 2, 0.01, hold * 0.9, 0.1, peak * 0.3);
      k.note(t, 'sine', f * 3, f * 3, 0.01, hold * 0.6, 0.08, peak * 0.14);
      break;
  }
}

/** Jingle recipe of one perk: melody + echo, bass on the long notes, a final chord. */
function perkJingle(perkId: string): Recipe {
  return (g, t) => {
    const j = composeJingle(perkId);
    const k = kitOf(g);
    const lead = j.timbre === 'brass' || j.timbre === 'chip' ? k.bus({ lowpass: 3200, gain: 1 }) : k;
    const echo = k.bus({ lowpass: 2200, gain: 0.28 });
    for (let i = 0; i < j.notes.length; i++) {
      const nt = j.notes[i]!;
      const f = midiHz(j.root + 12 + nt.semis) * k.j(0.002);
      const last = i === j.notes.length - 1;
      jingleVoice(lead, j.timbre, t + nt.start, f, last ? nt.length + 0.2 : nt.length, 0.5);
      if (!last) jingleVoice(echo, j.timbre, t + nt.start + j.eighth * 1.5, f, nt.length, 0.5);
      if (nt.length >= j.eighth * 2 || i === 0) {
        const bass = midiHz(j.root - 12 + (nt.semis % 12 === 0 ? 0 : 7));
        k.note(t + nt.start, 'triangle', bass, bass, 0.006, nt.length * 0.9, 0.08, 0.32);
      }
    }
    const end = t + j.notes[j.notes.length - 1]!.start;
    const scale = JINGLE_MODES[j.mode];
    const third = scale[Math.min(2, scale.length - 1)]!;
    for (const semis of [0, third, 7]) {
      const f = midiHz(j.root + semis);
      k.note(end, 'triangle', f, f, 0.02, j.eighth * 3, 0.35, 0.14);
    }
    k.noise(end, { color: 'white', filter: 'highpass', freq: 7000, attack: 0.01, decay: 0.4, peak: 0.08 });
  };
}

/** Longest jingle (s): rhythms up to 13 eighths at the slowest tempo, plus the final release. */
const JINGLE_SECONDS = 13 * 0.18 + 0.8;

type PerkJingleId = `perk.jingle.${PerkId}`;

const JINGLE_DEFS = Object.fromEntries(
  PERK_IDS.map((id) => [
    `${EA.perks.jinglePrefix}${id}`,
    { variants: 1, duration: JINGLE_SECONDS, channels: 1, level: 0.85, recipe: perkJingle(id) } satisfies SynthDef,
  ]),
) as Record<PerkJingleId, SynthDef>;

/** Biotech "injection": rising swell into a sub hit, an add9 FM chord stab, a double heartbeat. */
const perkAcquire: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 300,
    sweepTo: 4200,
    q: 2,
    attack: 0.28,
    hold: 0.28,
    release: 0.05,
    peak: 0.5,
  });
  const s = t + 0.28;
  k.thump(s, 120, 42, 0.08, 0.5, 0.7, 1.4);
  const chord = [60, 67, 71, 74, 79];
  for (let i = 0; i < chord.length; i++) k.fm(s, midiHz(chord[i]!), 1, 1.2, 0.005, 0.9, 0.11, i % 2 ? 0.35 : -0.35);
  k.noise(s, { color: 'white', filter: 'highpass', freq: 6000, attack: 0.005, decay: 0.5, peak: 0.12 });
  k.thump(s + 0.36, 70, 45, 0.06, 0.15, 0.35);
  k.thump(s + 0.53, 65, 42, 0.06, 0.15, 0.25);
};

/** Glitchy descending square run, crackle, a falling sine. */
const perkLost: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2, lowpass: 3000, gain: 0.6 });
  const run = [79, 74, 70, 67, 62];
  for (let i = 0; i < run.length; i++) {
    const f = midiHz(run[i]!);
    b.note(t + i * 0.06, 'square', f, f * 0.97, 0.003, 0.05, 0.05, 0.25);
  }
  k.clicks(t, 10, 0.35, 2500, 2, 0.25);
  k.note(t + 0.3, 'sine', 300, 70, 0.01, 0.35, 0.2, 0.3);
};

/** Phoenix revive: boom, fire whoosh (stereo), crackle, a rising chord. */
const perkRevive: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, 90, 30, 0.3, 1, 0.8, 2);
  for (const pan of [-0.35, 0.35]) {
    k.swell(t + (pan > 0 ? 0.03 : 0), {
      color: 'pink',
      filter: 'bandpass',
      freq: 500,
      sweepTo: 2600,
      q: 0.9,
      attack: 0.08,
      hold: 0.5,
      release: 0.8,
      peak: 0.5,
      pan,
    });
  }
  k.clicks(t + 0.05, 30, 1, 1800, 1.5, 0.2);
  const pad = k.bus({ lowpass: 2600, gain: 0.8 });
  const chord = [55, 59, 62, 67];
  for (let i = 0; i < chord.length; i++) {
    const f = midiHz(chord[i]!);
    pad.note(t + 0.1 + i * 0.04, 'sawtooth', f, f * 2, 0.3, 0.7, 0.6, 0.1, i % 2 ? 0.3 : -0.3);
  }
};

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

const powerUpSpawn: Recipe = (g, t) => {
  const k = kitOf(g);
  const run = [84, 88, 91, 96, 100];
  for (let i = 0; i < run.length; i++) k.bell(t + i * 0.05, midiHz(run[i]!) * k.j(0.005), 0.5, 0.16);
  k.swell(t, { color: 'white', filter: 'highpass', freq: 4500, attack: 0.15, hold: 0.2, release: 0.6, peak: 0.24 });
  k.note(t, 'sine', 220, 440, 0.1, 0.25, 0.4, 0.16);
};

/** Floating pickup: beating high sines (whole cycles per loop), airy hiss, sparse twinkles. */
const powerUpLoop: Recipe = (g, t) => {
  const k = kitOf(g);
  const loop = EA.synth.shimmerLoopSeconds;
  const dur = loop + XF;
  const tonal = k.loopBus(t, dur, XF);
  tonal.note(t, 'sine', 880, 880, 0.001, dur, 0.01, 0.2);
  tonal.note(t, 'sine', 882.5, 882.5, 0.001, dur, 0.01, 0.2);
  tonal.note(t, 'sine', 1320, 1320, 0.001, dur, 0.01, 0.06);
  k.bed(t, dur, 'white', 'highpass', 6500, 0.7, 0.04);
  // Twinkles only where the crossfade leaves them untouched (their tails wrap around).
  const count = 7;
  for (let i = 0; i < count; i++) {
    const at = XF + ((i + k.rng.next() * 0.8) / count) * (loop - XF);
    const f = midiHz(pick(k.rng, [96, 98, 100, 103, 105, 108]));
    k.tone(t + at, 'sine', f, f, 0.002, 0.25, 0.12);
  }
};

function pick<T>(rng: Rng, items: readonly T[]): T {
  return rng.pick(items);
}

const stingNuke: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 400, sweepTo: 5000, q: 1, attack: 0.35, hold: 0.35, release: 0.03, peak: 0.55 });
  const s = t + 0.35;
  k.thump(s, 70, 22, 0.9, 1.6, 1, 3);
  k.noise(s, { color: 'white', filter: 'highpass', freq: 1800, decay: 0.12, peak: 0.6 });
  for (const pan of [-0.5, 0.5]) {
    k.swell(s, { color: 'brown', filter: 'lowpass', freq: 380, attack: 0.02, hold: 0.9, release: 1.2, peak: 0.7, pan });
  }
  k.clicks(s + 0.05, 24, 1.4, 1200, 1.2, 0.25);
  const drone = k.bus({ drive: 2, lowpass: 900, gain: 0.5 });
  for (const m of [33, 40, 45]) drone.note(s, 'sawtooth', midiHz(m), midiHz(m) * 0.94, 0.05, 1.2, 1, 0.22);
};

const stingDoublePoints: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bell(t, midiHz(88), 0.8, 0.3, -0.2);
  k.bell(t + 0.13, midiHz(95), 1, 0.3, 0.2);
  for (let i = 0; i < 6; i++) {
    const f = midiHz(100 + (i % 3) * 4);
    k.tone(t + 0.2 + i * 0.04, 'triangle', f, f, 0.002, 0.1, 0.08, i % 2 ? 0.4 : -0.4);
  }
  k.fm(t, midiHz(52), 1, 2, 0.005, 0.35, 0.25);
  k.noise(t + 0.13, { color: 'white', filter: 'bandpass', freq: 5600, q: 3, decay: 0.05, peak: 0.3 });
};

const stingInstakill: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 3, lowpass: 1800, gain: 0.55 });
  for (const m of [40, 41, 46]) b.note(t, 'sawtooth', midiHz(m), midiHz(m) * 0.96, 0.005, 0.5, 0.6, 0.24);
  k.thump(t, 95, 35, 0.15, 0.6, 0.8, 2);
  k.note(t + 0.05, 'sine', 2400, 600, 0.02, 0.9, 0.4, 0.12);
  k.swell(t + 0.1, { color: 'pink', filter: 'bandpass', freq: 900, q: 3, attack: 0.2, hold: 0.4, release: 0.5, peak: 0.25 });
};

const stingMaxAmmo: Recipe = (g, t) => {
  const k = kitOf(g);
  for (const s of [t, t + 0.12]) {
    k.noise(s, { color: 'white', filter: 'bandpass', freq: 2400 * k.j(0.05), q: 2.5, decay: 0.03, peak: 0.55 });
    k.ring(s, 780 * k.j(0.03), [1, 2.4, 3.9], 0.2, 0.1);
    k.thump(s, 160, 90, 0.03, 0.05, 0.3);
  }
  const fan = k.bus({ lowpass: 3400, gain: 0.8 });
  const run = [72, 76, 79, 84];
  for (let i = 0; i < run.length; i++) {
    const f = midiHz(run[i]!);
    const last = i === run.length - 1;
    fan.note(t + 0.22 + i * 0.07, 'square', f, f, 0.004, last ? 0.4 : 0.06, last ? 0.35 : 0.04, 0.2);
  }
};

const stingCarpenter: Recipe = (g, t) => {
  const k = kitOf(g);
  const zap = k.bus({ highpass: 250, lowpass: 5000, gain: 0.6 });
  for (let i = 0; i < 3; i++) {
    zap.tone(t + i * 0.09, 'sawtooth', 300 * (1 + i * 0.25), 1600 * (1 + i * 0.25), 0.004, 0.12, 0.3, i - 1);
  }
  const s = t + 0.32;
  for (const m of [79, 86, 91]) k.bell(s, midiHz(m), 1, 0.2);
  k.thump(s, 140, 60, 0.05, 0.2, 0.45, 1.2);
  k.swell(s, { color: 'white', filter: 'bandpass', freq: 3600, q: 1.5, attack: 0.01, hold: 0.05, release: 0.5, peak: 0.2 });
};

const stingSlowmo: Recipe = (g, t) => {
  const k = kitOf(g);
  k.note(t, 'sine', 900, 110, 0.01, 1.2, 0.3, 0.3);
  const tape = k.bus({ lowpass: 1600, gain: 0.5 });
  tape.note(t, 'sawtooth', 450, 55, 0.01, 1.2, 0.3, 0.2);
  k.swell(t, { color: 'pink', filter: 'bandpass', freq: 2400, sweepTo: 300, q: 1.2, attack: 0.05, hold: 1, release: 0.4, peak: 0.4 });
  k.thump(t + 1.05, 60, 28, 0.3, 0.7, 0.6, 1.5);
};

const stingAmmoScrap: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3200, q: 3, decay: 0.02, peak: 0.5 });
  k.tone(t + 0.02, 'triangle', midiHz(84), midiHz(91), 0.002, 0.08, 0.3);
};

const stingCollect: Recipe = (g, t) => {
  const k = kitOf(g);
  const run = [79, 84, 88];
  for (let i = 0; i < run.length; i++) k.bell(t + i * 0.05, midiHz(run[i]!), 0.5, 0.2, i - 1);
  k.thump(t, 120, 60, 0.05, 0.15, 0.3);
};

const powerUpTick: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3000, q: 4, decay: 0.01, peak: 0.6 });
  k.tone(t, 'sine', 1800, 1750, 0.001, 0.025, 0.35);
};

const powerUpExpire: Recipe = (g, t) => {
  const k = kitOf(g);
  k.note(t, 'sine', 900, 200, 0.005, 0.45, 0.2, 0.35);
  const b = k.bus({ lowpass: 1800, gain: 0.5 });
  b.note(t, 'square', 450, 100, 0.005, 0.45, 0.2, 0.15);
  k.swell(t, { color: 'pink', filter: 'lowpass', freq: 3000, sweepTo: 200, attack: 0.02, hold: 0.4, release: 0.2, peak: 0.25 });
};

// ---------------------------------------------------------------------------
// Seals, zones
// ---------------------------------------------------------------------------

/** A seal bar shatters: electric crackle, a falling zap, a glassy ring. */
const sealBreak: Recipe = (g, t) => {
  const k = kitOf(g);
  k.clicks(t, 16, 0.3, 3600, 2.5, 0.45);
  const zap = k.bus({ drive: 2.5, lowpass: 5000, gain: 0.5 });
  zap.tone(t, 'sawtooth', 1300 * k.j(0.1), 180, 0.002, 0.22, 0.35);
  k.ring(t, 1500 * k.j(0.08), [1, 1.73, 2.61], 0.35, 0.12);
  k.noise(t, { color: 'white', filter: 'highpass', freq: 4000, decay: 0.08, peak: 0.35 });
};

/** A bar is restored: rising zap, a lock click, a short bell. */
const sealRepair: Recipe = (g, t) => {
  const k = kitOf(g);
  const zap = k.bus({ highpass: 200, lowpass: 6000, gain: 0.55 });
  zap.tone(t, 'sawtooth', 300 * k.j(0.08), 1500, 0.004, 0.14, 0.3);
  const s = t + 0.13;
  k.noise(s, { color: 'white', filter: 'bandpass', freq: 2600, q: 2, decay: 0.02, peak: 0.45 });
  k.bell(s, midiHz(pick(k.rng, [86, 88, 91])), 0.3, 0.14);
};

/** A new area opens: distant low swell, a dark pad, a far metallic clank. */
const zoneUnlock: Recipe = (g, t) => {
  const k = kitOf(g);
  for (const pan of [-0.4, 0.4]) {
    k.swell(t, { color: 'brown', filter: 'lowpass', freq: 260, attack: 0.6, hold: 0.9, release: 1, peak: 0.55, pan });
  }
  const pad = k.bus({ lowpass: 1200, gain: 0.7 });
  const chord = [45, 48, 52, 57];
  for (let i = 0; i < chord.length; i++) {
    const f = midiHz(chord[i]!);
    pad.note(t + 0.1, 'sawtooth', f, f, 0.7, 1, 0.9, 0.08, i % 2 ? 0.3 : -0.3);
  }
  k.ring(t + 0.9, 230, [1, 2.43, 3.9, 5.2], 1.2, 0.08, 0.3);
};

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------

export const ECONOMY_SYNTH_DEFS = {
  // --- purchases / HUD feedback (2D, ui bus) ---
  'econ.purchase': { variants: 2, duration: 0.95, channels: 1, level: 0.85, recipe: purchase },
  'econ.denied': { variants: 1, duration: 0.45, channels: 1, level: 0.75, recipe: denied },
  'econ.points': { variants: 3, duration: 0.08, channels: 1, level: 0.6, recipe: pointsTick },
  // --- world objects (positional, mono) ---
  'door.open': {
    variants: 2,
    duration: DOORS.openDuration + 0.6,
    channels: 1,
    level: 0.95,
    recipe: doorOpen(false),
  },
  'door.open.blast': {
    variants: 1,
    duration: DOORS.blastOpenDuration + 0.95,
    channels: 1,
    level: 1,
    recipe: doorOpen(true),
  },
  'box.open': { variants: 1, duration: 1.1, channels: 1, level: 0.85, recipe: boxOpen },
  'box.roll': {
    variants: 1,
    duration: MYSTERY_BOX.rollDuration + 0.7,
    channels: 1,
    level: 0.8,
    recipe: boxRoll,
  },
  'box.resolve': { variants: 1, duration: 1.8, channels: 1, level: 0.9, recipe: boxResolve },
  'box.anomaly': { variants: 1, duration: 2.8, channels: 1, level: 0.95, recipe: boxAnomaly },
  'box.arrive': { variants: 1, duration: 1.5, channels: 1, level: 0.85, recipe: boxArrive },
  'perk.hum': {
    variants: 1,
    duration: EA.synth.humLoopSeconds + XF,
    channels: 1,
    level: 0.7,
    loop: true,
    recipe: perkHum,
  },
  ...JINGLE_DEFS,
  'powerup.spawn': { variants: 2, duration: 1.3, channels: 1, level: 0.8, recipe: powerUpSpawn },
  'powerup.loop': {
    variants: 1,
    duration: EA.synth.shimmerLoopSeconds + XF,
    channels: 1,
    level: 0.6,
    loop: true,
    recipe: powerUpLoop,
  },
  'seal.break': { variants: 3, duration: 0.7, channels: 1, level: 0.85, recipe: sealBreak },
  'seal.repair': { variants: 3, duration: 0.55, channels: 1, level: 0.8, recipe: sealRepair },
  // --- 2D stings (stereo) ---
  'perk.acquire': { variants: 1, duration: 1.6, channels: 2, level: 0.9, recipe: perkAcquire },
  'perk.revive': { variants: 1, duration: 2.2, channels: 2, level: 1, recipe: perkRevive },
  'powerup.nuke': { variants: 1, duration: 3.2, channels: 2, level: 1, recipe: stingNuke },
  'powerup.doublePoints': { variants: 1, duration: 1.5, channels: 2, level: 0.9, recipe: stingDoublePoints },
  'powerup.instakill': { variants: 1, duration: 1.7, channels: 2, level: 0.95, recipe: stingInstakill },
  'powerup.maxAmmo': { variants: 1, duration: 1.3, channels: 2, level: 0.9, recipe: stingMaxAmmo },
  'powerup.carpenter': { variants: 1, duration: 1.6, channels: 2, level: 0.9, recipe: stingCarpenter },
  'powerup.slowmo': { variants: 1, duration: 2.1, channels: 2, level: 0.95, recipe: stingSlowmo },
  'powerup.ammoScrap': { variants: 2, duration: 0.3, channels: 2, level: 0.6, recipe: stingAmmoScrap },
  'powerup.collect': { variants: 1, duration: 0.8, channels: 2, level: 0.8, recipe: stingCollect },
  'zone.unlock': { variants: 1, duration: 2.8, channels: 2, level: 0.75, recipe: zoneUnlock },
  // --- 2D (mono) ---
  'perk.lost': { variants: 1, duration: 1, channels: 1, level: 0.8, recipe: perkLost },
  'powerup.tick': { variants: 2, duration: 0.1, channels: 1, level: 0.6, recipe: powerUpTick },
  'powerup.expire': { variants: 1, duration: 0.9, channels: 1, level: 0.8, recipe: powerUpExpire },
} as const satisfies Record<string, SynthDef>;

export type EconomySynthId = keyof typeof ECONOMY_SYNTH_DEFS;

/** Economy synth id for a sound id (exact match), or null. */
export function resolveEconomySynthId(id: string): EconomySynthId | null {
  return Object.prototype.hasOwnProperty.call(ECONOMY_SYNTH_DEFS, id) ? (id as EconomySynthId) : null;
}
