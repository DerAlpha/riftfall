/**
 * Procedural weapon, impact, casing and hit-feedback sounds. Registered into the procedural bank
 * through SYNTH_DEFS (synth.ts spreads WEAPON_SYNTH_DEFS in), so they are rendered once per sample
 * rate with OfflineAudioContext, cached, varied (several variants per id) and overridden by real
 * audio assets registered under the same id.
 *
 * Gunshots are layered the way sound designers stack recordings:
 * - transient: a sub-millisecond bright noise crack + a resonant snap (the "supersonic" edge),
 * - body: pitched thumps with FAST pitch envelopes (kick-drum style: the pitch collapses within
 *   20–35 ms while the amplitude rings on) + a mid-range "bark" – the weight (Wucht),
 * - mechanical: slide/bolt/pump action on its own id (`.mech`, panned towards the ejection side),
 * - tails: only short dark low-end blooms (`weapon.tail.*`); the room comes from the engine's
 *   reverb send.
 * Every shot layer runs through a tanh waveshaper bus (4× oversampled) for punchy saturation.
 *
 * Recipes only use `g.ctx` / `g.rng` of the SynthGraph and build their own node graph into the
 * context destination (the bank's bus is a unity gain), so this module needs no runtime import of
 * synth.ts (no cycle). The frequencies/levels inside recipes are sound-design constants.
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
// Kit: small layer toolkit on a (offline) context
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
        fill(new Float32Array(length), new Rng(`${S.seed}:weapon-noise:${name}`)),
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

interface ThumpOpts {
  f0: number;
  f1: number;
  /** Pitch drop time (fast envelope), independent of the amplitude decay. */
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
    if (o.drive && o.drive > 0) {
      const ws = ctx.createWaveShaper();
      ws.curve = tanhCurve(o.drive);
      ws.oversample = '4x';
      last.connect(ws);
      last = ws;
    }
    if (o.highpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = o.highpass;
      last.connect(f);
      last = f;
    }
    if (o.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      last.connect(f);
      last = f;
    }
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    last.connect(g);
    this.route(g, o.pan ?? 0);
    return new Kit(ctx, input, this.rng, this.noiseT);
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

  private env(t: number, attack: number, decay: number, peak: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    // ~-35 dB after `decay`.
    g.gain.setTargetAtTime(0, t + attack, decay / 4);
    return g;
  }

  /** Filtered noise burst. */
  noise(t: number, o: NoiseOpts): void {
    const attack = o.attack ?? 0.001;
    const dur = attack + o.decay * 1.4 + 0.01;
    const buf = this.noiseT[o.color];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(t, this.rng.next() * buf.duration * 0.9);
    src.stop(t + dur);
    const f = this.ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t + dur);
    f.Q.value = o.q ?? 0.707;
    const e = this.env(t, attack, o.decay, o.peak);
    src.connect(f).connect(e);
    this.route(e, o.pan ?? 0);
  }

  /** Pitched body with a fast pitch envelope (f0 → f1 within `pitchTime`). */
  thump(t: number, o: ThumpOpts): void {
    const osc = this.ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + Math.max(1e-3, o.pitchTime));
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.001) + o.decay * 1.4 + 0.01);
    let last: AudioNode = osc;
    if (o.drive && o.drive > 0) {
      const ws = this.ctx.createWaveShaper();
      ws.curve = tanhCurve(o.drive);
      ws.oversample = '2x';
      last.connect(ws);
      last = ws;
    }
    const e = this.env(t, o.attack ?? 0.001, o.decay, o.peak);
    last.connect(e);
    this.route(e, 0);
  }

  /** Oscillator sweep (zaps, pings, whines). */
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

  /** Inharmonic partials – struck metal; higher partials die faster. */
  ring(t: number, base: number, ratios: readonly number[], decay: number, peak: number, pan = 0): void {
    for (let i = 0; i < ratios.length; i++) {
      const d = decay / (1 + i * 0.55);
      this.tone(
        t,
        'sine',
        base * ratios[i]! * this.j(0.012),
        base * ratios[i]! * 0.995,
        0.0008,
        d,
        peak / (1 + i * 0.6),
        pan,
      );
    }
  }

  /** Very short bright click (contact transient). */
  click(t: number, freq: number, decay: number, peak: number, pan = 0): void {
    this.noise(t, { color: 'white', filter: 'highpass', freq, attack: 0.0004, decay, peak, pan });
  }

  /** Scattered small ticks (debris, rattles). */
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
        pan,
      });
    }
  }
}

function kitOf(g: SynthGraph): Kit {
  return new Kit(g.ctx, g.ctx.destination, g.rng, noiseTables(g.ctx));
}

// ---------------------------------------------------------------------------
// Gunshots
// ---------------------------------------------------------------------------

interface FireProfile {
  crack: { freq: number; decay: number; peak: number };
  snap: { freq: number; q: number; decay: number; peak: number };
  body: { f0: number; f1: number; pitchTime: number; decay: number; peak: number; drive: number };
  sub: { f0: number; f1: number; pitchTime: number; decay: number; peak: number };
  bark: { freq: number; q: number; sweepTo: number; decay: number; peak: number };
  blast: { lowpass: number; decay: number; peak: number };
  /** Decorrelated left/right early slaps (stereo width). */
  width: number;
  drive: number;
  lowpass: number;
}

const FIRE: Record<'pistol' | 'rifle' | 'shotgun', FireProfile> = {
  pistol: {
    crack: { freq: 2600, decay: 0.014, peak: 1 },
    snap: { freq: 4300, q: 1.3, decay: 0.03, peak: 0.6 },
    body: { f0: 240, f1: 72, pitchTime: 0.022, decay: 0.1, peak: 0.95, drive: 2.4 },
    sub: { f0: 70, f1: 44, pitchTime: 0.05, decay: 0.15, peak: 0.55 },
    bark: { freq: 1050, q: 0.9, sweepTo: 420, decay: 0.06, peak: 0.75 },
    blast: { lowpass: 7000, decay: 0.035, peak: 0.45 },
    width: 0.22,
    drive: 2,
    lowpass: 13000,
  },
  rifle: {
    crack: { freq: 2100, decay: 0.012, peak: 1 },
    snap: { freq: 3200, q: 1.1, decay: 0.028, peak: 0.7 },
    body: { f0: 190, f1: 58, pitchTime: 0.02, decay: 0.12, peak: 1, drive: 3 },
    sub: { f0: 58, f1: 38, pitchTime: 0.06, decay: 0.18, peak: 0.7 },
    bark: { freq: 760, q: 0.8, sweepTo: 320, decay: 0.07, peak: 0.85 },
    blast: { lowpass: 6000, decay: 0.045, peak: 0.55 },
    width: 0.3,
    drive: 2.6,
    lowpass: 12000,
  },
  shotgun: {
    crack: { freq: 1700, decay: 0.022, peak: 1 },
    snap: { freq: 2500, q: 0.8, decay: 0.045, peak: 0.8 },
    body: { f0: 165, f1: 46, pitchTime: 0.032, decay: 0.2, peak: 1, drive: 4 },
    sub: { f0: 50, f1: 30, pitchTime: 0.08, decay: 0.3, peak: 0.9 },
    bark: { freq: 520, q: 0.7, sweepTo: 200, decay: 0.12, peak: 1 },
    blast: { lowpass: 5200, decay: 0.08, peak: 0.8 },
    width: 0.42,
    drive: 3.2,
    lowpass: 10000,
  },
};

function fire(p: FireProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const b = k.bus({ drive: p.drive, lowpass: p.lowpass });
    const tone = k.j(0.05);
    b.noise(t, {
      color: 'white',
      filter: 'highpass',
      freq: p.crack.freq * tone,
      attack: 0.0003,
      decay: p.crack.decay * k.j(0.15),
      peak: p.crack.peak,
    });
    b.noise(t, {
      color: 'white',
      filter: 'bandpass',
      freq: p.snap.freq * tone,
      q: p.snap.q,
      attack: 0.0005,
      decay: p.snap.decay * k.j(0.12),
      peak: p.snap.peak * k.j(0.1),
    });
    b.thump(t, {
      f0: p.body.f0 * k.j(0.05),
      f1: p.body.f1,
      pitchTime: p.body.pitchTime,
      decay: p.body.decay * k.j(0.1),
      peak: p.body.peak,
      drive: p.body.drive,
    });
    b.thump(t, {
      f0: p.sub.f0 * k.j(0.04),
      f1: p.sub.f1,
      pitchTime: p.sub.pitchTime,
      decay: p.sub.decay,
      peak: p.sub.peak,
    });
    b.noise(t + 0.0008, {
      color: 'pink',
      filter: 'bandpass',
      freq: p.bark.freq * tone,
      q: p.bark.q,
      sweepTo: p.bark.sweepTo,
      attack: 0.0015,
      decay: p.bark.decay * k.j(0.12),
      peak: p.bark.peak,
    });
    b.noise(t, {
      color: 'white',
      filter: 'lowpass',
      freq: p.blast.lowpass,
      sweepTo: p.blast.lowpass * 0.2,
      attack: 0.0008,
      decay: p.blast.decay,
      peak: p.blast.peak,
    });
    // Stereo width: two decorrelated slaps a few ms apart.
    b.noise(t + 0.004 * k.j(0.3), {
      color: 'pink',
      filter: 'bandpass',
      freq: 1800,
      q: 0.9,
      decay: 0.03,
      peak: p.width,
      pan: -0.7,
    });
    b.noise(t + 0.007 * k.j(0.3), {
      color: 'pink',
      filter: 'bandpass',
      freq: 1500,
      q: 0.9,
      decay: 0.035,
      peak: p.width,
      pan: 0.7,
    });
  };
}

/** Slide cycling (pistol): back + forward clacks, panned to the ejection side. */
const pistolMech: Recipe = (g, t) => {
  const k = kitOf(g);
  const pan = 0.3;
  const t1 = t + 0.012 * k.j(0.2);
  k.click(t1, 3600, 0.006, 0.8, pan);
  k.noise(t1, {
    color: 'white',
    filter: 'bandpass',
    freq: 2300 * k.j(0.08),
    q: 3,
    decay: 0.02,
    peak: 0.5,
    pan,
  });
  k.ring(t1, 2200 * k.j(0.06), [1, 2.31, 3.73, 5.9], 0.05, 0.28, pan);
  const t2 = t + 0.055 * k.j(0.12);
  k.click(t2, 3000, 0.007, 0.9, pan);
  k.thump(t2, { f0: 320, f1: 210, pitchTime: 0.01, decay: 0.018, peak: 0.45 });
  k.ring(t2, 1850 * k.j(0.06), [1, 2.4, 4.1], 0.06, 0.3, pan);
};

/** Bolt carrier (rifle): quick clack pair and a short buffer-spring buzz. */
const rifleMech: Recipe = (g, t) => {
  const k = kitOf(g);
  const pan = 0.28;
  const t1 = t + 0.007 * k.j(0.2);
  k.noise(t1, {
    color: 'white',
    filter: 'bandpass',
    freq: 2700 * k.j(0.08),
    q: 2,
    decay: 0.014,
    peak: 0.8,
    pan,
  });
  k.ring(t1, 1500 * k.j(0.06), [1, 2.6, 4.1], 0.04, 0.25, pan);
  k.tone(t1 + 0.004, 'sawtooth', 190 * k.j(0.08), 140, 0.002, 0.03, 0.08, pan);
  const t2 = t + 0.042 * k.j(0.1);
  k.click(t2, 3200, 0.006, 0.75, pan);
  k.thump(t2, { f0: 280, f1: 190, pitchTime: 0.008, decay: 0.02, peak: 0.4 });
  k.ring(t2, 1350 * k.j(0.06), [1, 2.2, 3.6], 0.05, 0.22, pan);
};

/** Extra low boom under the shotgun blast. */
const shotgunBoom: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.6, lowpass: 900 });
  b.thump(t, { f0: 78 * k.j(0.05), f1: 32, pitchTime: 0.06, decay: 0.42, peak: 1, drive: 1.2 });
  b.noise(t, {
    color: 'brown',
    filter: 'lowpass',
    freq: 320,
    sweepTo: 90,
    attack: 0.004,
    decay: 0.38,
    peak: 0.8,
  });
};

/** Dark low-end bloom after a shot (not a reverb – the room comes from the reverb send). */
function tail(decay: number, freq: number): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.noise(t, {
      color: 'brown',
      filter: 'lowpass',
      freq: freq * k.j(0.1),
      sweepTo: freq * 0.3,
      attack: 0.012,
      decay: decay * k.j(0.1),
      peak: 1,
    });
    k.noise(t + 0.014, {
      color: 'pink',
      filter: 'bandpass',
      freq: 650 * k.j(0.15),
      q: 1.2,
      sweepTo: 320,
      attack: 0.006,
      decay: decay * 0.45,
      peak: 0.35,
      pan: -0.4,
    });
    k.noise(t + 0.031, {
      color: 'pink',
      filter: 'bandpass',
      freq: 540 * k.j(0.15),
      q: 1.2,
      sweepTo: 280,
      attack: 0.006,
      decay: decay * 0.4,
      peak: 0.28,
      pan: 0.4,
    });
  };
}

// ---------------------------------------------------------------------------
// Handling: reloads, dry fire, equip, melee
// ---------------------------------------------------------------------------

interface HandlingProfile {
  /** Metal body resonance of the magazine / receiver. */
  ring: number;
  /** Seating thump start frequency (heavier weapons lower). */
  seat: number;
  /** Scrape band. */
  scrape: number;
  /** Dry-fire click band. */
  dry: number;
}

const HANDLING: Record<'pistol' | 'rifle' | 'shotgun', HandlingProfile> = {
  pistol: { ring: 2100, seat: 260, scrape: 2400, dry: 4200 },
  rifle: { ring: 1500, seat: 210, scrape: 1800, dry: 3500 },
  shotgun: { ring: 1100, seat: 180, scrape: 1500, dry: 3000 },
};

function magOut(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.click(t, 4200, 0.005, 0.7, 0.2);
    k.ring(t, h.ring * 1.3 * k.j(0.05), [1, 2.5], 0.03, 0.2, 0.2);
    k.noise(t + 0.018, {
      color: 'white',
      filter: 'bandpass',
      freq: h.scrape * k.j(0.08),
      sweepTo: h.scrape * 0.55,
      q: 2.5,
      attack: 0.012,
      decay: 0.08,
      peak: 0.55,
    });
    k.ring(t + 0.03, h.ring * k.j(0.06), [1, 2.2, 3.9], 0.07, 0.22);
    k.thump(t + 0.1, { f0: h.seat * 0.8, f1: h.seat * 0.55, pitchTime: 0.01, decay: 0.03, peak: 0.25 });
  };
}

function magIn(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.noise(t, {
      color: 'white',
      filter: 'bandpass',
      freq: h.scrape * 0.7,
      sweepTo: h.scrape * 1.2,
      q: 2.2,
      attack: 0.015,
      decay: 0.05,
      peak: 0.4,
    });
    const seat = t + 0.055 * k.j(0.1);
    const b = k.bus({ drive: 1.8 });
    b.click(seat, 3000, 0.008, 1);
    b.thump(seat, {
      f0: h.seat * k.j(0.05),
      f1: h.seat * 0.5,
      pitchTime: 0.012,
      decay: 0.05,
      peak: 0.95,
      drive: 1.5,
    });
    b.ring(seat, h.ring * 0.62 * k.j(0.05), [1, 2.2, 3.4], 0.08, 0.35);
    k.click(seat + 0.018, 5000, 0.004, 0.45, 0.15);
  };
}

const pistolSlideRelease: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2 });
  b.click(t, 3800, 0.006, 1);
  b.thump(t, { f0: 280 * k.j(0.05), f1: 150, pitchTime: 0.01, decay: 0.04, peak: 0.85, drive: 2 });
  b.ring(t, 2100 * k.j(0.05), [1, 2.7, 4.4, 6.1], 0.12, 0.42);
};

const rifleChargingHandle: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'white',
    filter: 'bandpass',
    freq: 2000 * k.j(0.06),
    sweepTo: 1300,
    q: 2,
    attack: 0.008,
    decay: 0.05,
    peak: 0.55,
  });
  k.click(t + 0.03, 3200, 0.006, 0.7);
  k.ring(t + 0.03, 1400 * k.j(0.05), [1, 2.5], 0.05, 0.22);
  const slam = t + 0.11 * k.j(0.08);
  const b = k.bus({ drive: 2.2 });
  b.click(slam, 2800, 0.008, 1);
  b.thump(slam, { f0: 230 * k.j(0.05), f1: 110, pitchTime: 0.012, decay: 0.06, peak: 0.95, drive: 2 });
  b.ring(slam, 1250 * k.j(0.05), [1, 2.35, 3.9, 5.6], 0.13, 0.38);
};

const shellIn: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 250 * k.j(0.06), f1: 160, pitchTime: 0.01, decay: 0.035, peak: 0.85 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1600 * k.j(0.08), q: 2, decay: 0.03, peak: 0.6 });
  k.click(t, 3600, 0.004, 0.55);
  k.ring(t + 0.002, 900 * k.j(0.06), [1, 2.1], 0.05, 0.18);
  // Tube follower spring.
  k.click(t + 0.03 * k.j(0.2), 5200, 0.003, 0.25);
};

/** Pump action rack (back) + slam (forward). `delay` shifts it (post-shot cycle sync). */
function pump(delay: number): Recipe {
  return (g, t0) => {
    const k = kitOf(g);
    const t = t0 + delay;
    k.noise(t, {
      color: 'white',
      filter: 'bandpass',
      freq: 1300 * k.j(0.06),
      sweepTo: 2400,
      q: 1.5,
      attack: 0.01,
      decay: 0.06,
      peak: 0.55,
      pan: -0.1,
    });
    const back = t + 0.055 * k.j(0.08);
    k.click(back, 2600, 0.008, 0.85);
    k.thump(back, { f0: 190, f1: 120, pitchTime: 0.01, decay: 0.04, peak: 0.6 });
    k.ring(back, 1100 * k.j(0.05), [1, 2.4, 3.9], 0.08, 0.3);
    const fwd = t + 0.14 * k.j(0.06);
    const b = k.bus({ drive: 2.2 });
    b.noise(fwd - 0.03, {
      color: 'white',
      filter: 'bandpass',
      freq: 2200,
      sweepTo: 1200,
      q: 1.5,
      attack: 0.01,
      decay: 0.03,
      peak: 0.35,
    });
    b.click(fwd, 2400, 0.009, 1);
    b.thump(fwd, { f0: 160 * k.j(0.05), f1: 90, pitchTime: 0.012, decay: 0.06, peak: 1, drive: 2 });
    b.ring(fwd, 950 * k.j(0.05), [1, 2.3, 3.7], 0.1, 0.35);
  };
}

function dry(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.click(t, h.dry * k.j(0.05), 0.005, 1);
    k.ring(t, h.dry * 0.72 * k.j(0.04), [1, 1.9], 0.025, 0.28);
    k.thump(t, { f0: 420, f1: 300, pitchTime: 0.005, decay: 0.012, peak: 0.3 });
  };
}

function whoosh(k: Kit, t: number, from: number, to: number, decay: number, peak: number): void {
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: from,
    sweepTo: to,
    q: 1.1,
    attack: decay * 0.4,
    decay,
    peak,
  });
}

const equipPistol: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 600, 1500, 0.1, 0.5);
  k.ticks(t + 0.03, 3, 0.06, 3000, 5, 0.25);
  k.click(t + 0.12 * k.j(0.1), 3800, 0.006, 0.8);
  k.ring(t + 0.12, 2100 * k.j(0.05), [1, 2.6, 4.2], 0.06, 0.3);
};

const equipRifle: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 450, 1300, 0.14, 0.55);
  k.ticks(t + 0.04, 5, 0.12, 2600, 5, 0.28);
  const slap = t + 0.2 * k.j(0.08);
  k.thump(slap, { f0: 200, f1: 120, pitchTime: 0.01, decay: 0.05, peak: 0.6 });
  k.click(slap, 2800, 0.008, 0.8);
  k.ring(slap, 1300 * k.j(0.05), [1, 2.3, 3.8], 0.08, 0.3);
};

const equipShotgun: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 380, 1100, 0.15, 0.55);
  k.ticks(t + 0.04, 4, 0.1, 2200, 5, 0.25);
  pump(0.18)(g, t);
};

const holster: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 1500, 500, 0.12, 0.45);
  k.noise(t + 0.08, { color: 'pink', filter: 'lowpass', freq: 700, decay: 0.05, peak: 0.35 });
  k.ticks(t + 0.02, 2, 0.06, 2600, 5, 0.18);
};

const reloadStart: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1100,
    sweepTo: 700,
    q: 0.9,
    attack: 0.02,
    decay: 0.09,
    peak: 0.45,
  });
  k.ticks(t + 0.02, 2, 0.05, 2800, 5, 0.22);
};

const shotgunOpen: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1000,
    sweepTo: 650,
    q: 0.9,
    attack: 0.02,
    decay: 0.1,
    peak: 0.45,
  });
  k.click(t + 0.07, 3400, 0.005, 0.6);
  k.ring(t + 0.07, 1000 * k.j(0.05), [1, 2.2], 0.05, 0.2);
};

const inspect: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 500, 1200, 0.2, 0.35);
  k.ticks(t + 0.05, 6, 0.4, 2600, 6, 0.22);
  k.click(t + 0.45 * k.j(0.1), 3200, 0.006, 0.45);
};

const melee: Recipe = (g, t) => {
  const k = kitOf(g);
  // Arm swing: a fast rising whoosh with body.
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 380,
    sweepTo: 1900 * k.j(0.08),
    q: 1.4,
    attack: 0.07,
    decay: 0.12,
    peak: 0.8,
    pan: 0.2,
  });
  k.noise(t + 0.02, { color: 'brown', filter: 'lowpass', freq: 420, attack: 0.05, decay: 0.12, peak: 0.45 });
  k.ticks(t + 0.01, 2, 0.05, 2400, 5, 0.18);
};

const meleeHit: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 3 });
  b.thump(t, { f0: 120 * k.j(0.06), f1: 52, pitchTime: 0.02, decay: 0.13, peak: 1, drive: 2.5 });
  b.noise(t, { color: 'pink', filter: 'lowpass', freq: 1100, sweepTo: 400, decay: 0.07, peak: 0.8 });
  b.click(t, 2600, 0.008, 0.6);
};

const lowAmmo: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sine', 1950, 1850, 0.0008, 0.045, 0.8);
  k.tone(t, 'triangle', 3900, 3800, 0.0008, 0.02, 0.25);
  k.click(t, 5200, 0.003, 0.35);
};

// ---------------------------------------------------------------------------
// Impacts (mono, positional)
// ---------------------------------------------------------------------------

const impactMetal: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 5000, 0.004, 1);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3200 * k.j(0.12), q: 1.5, decay: 0.025, peak: 0.7 });
  k.ring(t, k.r(1100, 2400), [1, 2.76, 5.4, 8.93], 0.18 * k.j(0.2), 0.36);
  k.thump(t, { f0: 420, f1: 260, pitchTime: 0.006, decay: 0.02, peak: 0.3 });
  // Occasional ricochet whine.
  if (k.rng.next() < 0.4) k.tone(t + 0.01, 'sine', 3400 * k.j(0.12), 1300 * k.j(0.15), 0.004, 0.22, 0.2);
};

const impactConcrete: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 190 * k.j(0.08), f1: 90, pitchTime: 0.01, decay: 0.04, peak: 0.7 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1100 * k.j(0.12), q: 0.9, decay: 0.05, peak: 1 });
  k.noise(t, { color: 'white', filter: 'highpass', freq: 3000, decay: 0.03, peak: 0.5 });
  k.ticks(t + 0.01, 4, 0.12, 3200, 4, 0.22);
};

const impactGrate: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 4600, 0.005, 0.9);
  k.ring(t, 1400 * k.j(0.12), [1, 1.93, 3.31], 0.1, 0.3);
  k.ticks(t + 0.004, 6, 0.09, 3600, 6, 0.4);
  k.thump(t, { f0: 300, f1: 200, pitchTime: 0.008, decay: 0.02, peak: 0.3 });
};

const impactGlass: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 5500, 0.006, 1);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 4200, q: 1, decay: 0.04, peak: 0.6 });
  for (let i = 0; i < 8; i++) {
    const dt = 0.01 + k.rng.next() * 0.28;
    k.tone(t + dt, 'sine', k.r(3000, 7200), k.r(2900, 7000), 0.0006, k.r(0.03, 0.08), 0.35 * (1 - dt * 2));
  }
};

const impactRubber: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 140 * k.j(0.08), f1: 70, pitchTime: 0.012, decay: 0.05, peak: 0.9 });
  k.noise(t, { color: 'pink', filter: 'lowpass', freq: 900, decay: 0.04, peak: 0.7 });
  k.click(t, 3000, 0.003, 0.25);
};

const impactFlesh: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2 });
  b.thump(t, { f0: 130 * k.j(0.08), f1: 60, pitchTime: 0.02, decay: 0.09, peak: 1, drive: 2.5 });
  b.noise(t, { color: 'pink', filter: 'lowpass', freq: 800, decay: 0.07, peak: 0.8 });
  k.noise(t + 0.003, {
    color: 'pink',
    filter: 'bandpass',
    freq: 520 * k.j(0.12),
    sweepTo: 240,
    q: 3,
    attack: 0.004,
    decay: 0.08,
    peak: 0.6,
  });
  k.click(t, 2200, 0.008, 0.3);
};

const impactSlime: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 720 * k.j(0.12),
    sweepTo: 180,
    q: 6,
    attack: 0.003,
    decay: 0.12,
    peak: 0.9,
  });
  k.noise(t, { color: 'pink', filter: 'lowpass', freq: 600, decay: 0.1, peak: 0.6 });
  for (let i = 0; i < 3; i++) {
    const f = k.r(260, 600);
    k.tone(t + 0.01 + k.rng.next() * 0.1, 'sine', f, f * 1.7, 0.002, 0.03, 0.3);
  }
  k.thump(t, { f0: 100, f1: 50, pitchTime: 0.02, decay: 0.07, peak: 0.6 });
};

const impactShield: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sawtooth', 2400 * k.j(0.08), 520, 0.001, 0.14, 0.4);
  k.tone(t, 'sine', 1200 * k.j(0.06), 880, 0.002, 0.18, 0.45);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3500, q: 3, decay: 0.05, peak: 0.6 });
  k.click(t, 6000, 0.004, 0.6);
  for (let i = 0; i < 4; i++) {
    k.noise(t + 0.01 + k.rng.next() * 0.1, {
      color: 'white',
      filter: 'highpass',
      freq: 4500,
      decay: 0.006,
      peak: 0.25,
    });
  }
};

// ---------------------------------------------------------------------------
// Casings, hit feedback
// ---------------------------------------------------------------------------

const casingBrass: Recipe = (g, t) => {
  const k = kitOf(g);
  const base = k.r(3600, 5200);
  const ratios = [1, 2.61, 4.3] as const;
  k.click(t, 6000, 0.003, 0.4);
  k.ring(t, base, ratios, 0.1, 1);
  const b1 = t + k.r(0.05, 0.12);
  k.ring(b1, base * 1.01, ratios, 0.07, 0.45);
  k.ring(b1 + k.r(0.04, 0.09), base * 0.99, ratios, 0.05, 0.2);
};

const casingShell: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 520 * k.j(0.08), f1: 380, pitchTime: 0.005, decay: 0.025, peak: 0.8 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1300 * k.j(0.1), q: 2.5, decay: 0.04, peak: 0.7 });
  k.ring(t, 2300 * k.j(0.08), [1, 2.4], 0.05, 0.25);
  const b1 = t + k.r(0.08, 0.14);
  k.thump(b1, { f0: 480, f1: 360, pitchTime: 0.005, decay: 0.02, peak: 0.35 });
  k.noise(b1, { color: 'pink', filter: 'bandpass', freq: 1400, q: 2.5, decay: 0.03, peak: 0.3 });
};

/** Crisp "tk" – dry, short, never masks the gunfire. */
const uiHitmarker: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 6000, 0.003, 0.8);
  k.tone(t, 'sine', 3100, 2700, 0.0005, 0.028, 1);
  k.tone(t, 'triangle', 1500, 1400, 0.0005, 0.012, 0.3);
};

/** Bright metallic "ding" (head / weakpoint). */
const uiHeadshot: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 6500, 0.003, 0.6);
  k.tone(t, 'sine', 3600, 3580, 0.0005, 0.16, 1);
  k.tone(t, 'sine', 5400, 5380, 0.0005, 0.09, 0.45);
  k.tone(t, 'sine', 2400, 2390, 0.0005, 0.12, 0.35);
};

/** Weighty kill confirm: low punch + two-tone chime. */
const uiKill: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.5 });
  b.thump(t, { f0: 160, f1: 78, pitchTime: 0.015, decay: 0.08, peak: 0.85, drive: 1.5 });
  k.tone(t, 'sine', 1800, 1500, 0.0008, 0.12, 0.7);
  k.tone(t, 'sine', 2700, 2650, 0.0008, 0.1, 0.35);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 4000, q: 2, decay: 0.02, peak: 0.4 });
  k.tone(t + 0.06, 'sine', 2400, 2380, 0.0008, 0.14, 0.45);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const FV = S.weaponFireVariants;
const IV = S.impactVariants;

export const WEAPON_SYNTH_DEFS = {
  // --- gunshots (stereo, 2D for the player) ---
  'weapon.pistol.fire': { variants: FV, duration: 0.32, channels: 2, level: 1, recipe: fire(FIRE.pistol) },
  'weapon.rifle.fire': { variants: FV, duration: 0.38, channels: 2, level: 1, recipe: fire(FIRE.rifle) },
  'weapon.shotgun.fire': {
    variants: FV - 1,
    duration: 0.5,
    channels: 2,
    level: 1,
    recipe: fire(FIRE.shotgun),
  },
  'weapon.pistol.mech': { variants: 3, duration: 0.16, channels: 2, level: 0.7, recipe: pistolMech },
  'weapon.rifle.mech': { variants: 4, duration: 0.12, channels: 2, level: 0.65, recipe: rifleMech },
  'weapon.shotgun.boom': { variants: 2, duration: 0.7, channels: 1, level: 1, recipe: shotgunBoom },
  'weapon.shotgun.pumpCycle': { variants: 3, duration: 0.55, channels: 2, level: 0.85, recipe: pump(0.16) },
  'weapon.tail.small': { variants: 2, duration: 0.5, channels: 2, level: 0.7, recipe: tail(0.3, 420) },
  'weapon.tail.medium': { variants: 3, duration: 0.7, channels: 2, level: 0.75, recipe: tail(0.45, 380) },
  'weapon.tail.large': { variants: 2, duration: 1.1, channels: 2, level: 0.85, recipe: tail(0.75, 320) },
  // --- handling ---
  'weapon.pistol.dry': { variants: 2, duration: 0.08, channels: 1, level: 0.8, recipe: dry(HANDLING.pistol) },
  'weapon.rifle.dry': { variants: 2, duration: 0.08, channels: 1, level: 0.8, recipe: dry(HANDLING.rifle) },
  'weapon.shotgun.dry': {
    variants: 2,
    duration: 0.08,
    channels: 1,
    level: 0.8,
    recipe: dry(HANDLING.shotgun),
  },
  'weapon.pistol.magOut': {
    variants: 2,
    duration: 0.22,
    channels: 1,
    level: 0.8,
    recipe: magOut(HANDLING.pistol),
  },
  'weapon.rifle.magOut': {
    variants: 2,
    duration: 0.24,
    channels: 1,
    level: 0.85,
    recipe: magOut(HANDLING.rifle),
  },
  'weapon.pistol.magIn': {
    variants: 2,
    duration: 0.22,
    channels: 1,
    level: 0.9,
    recipe: magIn(HANDLING.pistol),
  },
  'weapon.rifle.magIn': {
    variants: 2,
    duration: 0.24,
    channels: 1,
    level: 0.95,
    recipe: magIn(HANDLING.rifle),
  },
  'weapon.pistol.boltRelease': {
    variants: 2,
    duration: 0.2,
    channels: 1,
    level: 0.95,
    recipe: pistolSlideRelease,
  },
  'weapon.rifle.boltRelease': {
    variants: 2,
    duration: 0.32,
    channels: 1,
    level: 1,
    recipe: rifleChargingHandle,
  },
  'weapon.shotgun.shellIn': { variants: 3, duration: 0.1, channels: 1, level: 0.85, recipe: shellIn },
  'weapon.shotgun.pump': { variants: 2, duration: 0.36, channels: 2, level: 0.95, recipe: pump(0) },
  'weapon.pistol.equip': { variants: 1, duration: 0.25, channels: 1, level: 0.7, recipe: equipPistol },
  'weapon.rifle.equip': { variants: 1, duration: 0.36, channels: 1, level: 0.75, recipe: equipRifle },
  'weapon.shotgun.equip': { variants: 1, duration: 0.6, channels: 2, level: 0.8, recipe: equipShotgun },
  'weapon.holster': { variants: 1, duration: 0.25, channels: 1, level: 0.6, recipe: holster },
  'weapon.reload.start': { variants: 2, duration: 0.18, channels: 1, level: 0.6, recipe: reloadStart },
  'weapon.shotgun.open': { variants: 1, duration: 0.2, channels: 1, level: 0.65, recipe: shotgunOpen },
  'weapon.inspect': { variants: 1, duration: 0.75, channels: 1, level: 0.6, recipe: inspect },
  'weapon.melee': { variants: 3, duration: 0.3, channels: 2, level: 0.8, recipe: melee },
  'weapon.melee.hit': { variants: 3, duration: 0.25, channels: 1, level: 1, recipe: meleeHit },
  'weapon.lowAmmo': { variants: 1, duration: 0.08, channels: 1, level: 0.7, recipe: lowAmmo },
  // --- impacts (mono → HRTF) ---
  'impact.metal': { variants: IV + 1, duration: 0.45, channels: 1, level: 0.9, recipe: impactMetal },
  'impact.concrete': { variants: IV, duration: 0.2, channels: 1, level: 0.9, recipe: impactConcrete },
  'impact.grate': { variants: IV, duration: 0.2, channels: 1, level: 0.85, recipe: impactGrate },
  'impact.glass': { variants: IV - 1, duration: 0.4, channels: 1, level: 0.85, recipe: impactGlass },
  'impact.rubber': { variants: IV - 1, duration: 0.12, channels: 1, level: 0.8, recipe: impactRubber },
  'impact.flesh': { variants: IV, duration: 0.2, channels: 1, level: 0.95, recipe: impactFlesh },
  'impact.slime': { variants: IV - 1, duration: 0.25, channels: 1, level: 0.9, recipe: impactSlime },
  'impact.shield': { variants: IV - 1, duration: 0.3, channels: 1, level: 0.85, recipe: impactShield },
  // --- casings ---
  'casing.brass': { variants: IV + 1, duration: 0.35, channels: 1, level: 0.6, recipe: casingBrass },
  'casing.shell': { variants: IV - 1, duration: 0.3, channels: 1, level: 0.65, recipe: casingShell },
  // --- hit feedback (ui bus: dry, no reverb) ---
  'ui.hitmarker': { variants: 1, duration: 0.06, channels: 1, level: 0.75, recipe: uiHitmarker },
  'ui.headshot': { variants: 1, duration: 0.2, channels: 1, level: 0.8, recipe: uiHeadshot },
  'ui.kill': { variants: 1, duration: 0.26, channels: 1, level: 0.9, recipe: uiKill },
} as const satisfies Record<string, SynthDef>;

export type WeaponSynthId = keyof typeof WEAPON_SYNTH_DEFS;

/**
 * Other ids the game uses for the same sounds (weapon defs, VFX casing clinks, surface tables).
 * Aliases share the rendered buffers; an asset registered under an alias id still overrides it.
 */
export const WEAPON_SYNTH_ALIASES = {
  'weapon.dry': 'weapon.rifle.dry',
  'weapon.pistol.slide': 'weapon.pistol.boltRelease',
  'weapon.rifle.bolt': 'weapon.rifle.boltRelease',
  'weapon.casing.brass': 'casing.brass',
  'weapon.casing.shell': 'casing.shell',
  'impact.armor': 'impact.metal',
  'impact.default': 'impact.concrete',
  // Reload actions the M2 weapons do not have (every `weapon.<id>.<step>` resolves, so a future
  // def or attachment that adds the step is never silent): closest real mechanism.
  'weapon.pistol.shellIn': 'weapon.shotgun.shellIn',
  'weapon.pistol.pump': 'weapon.shotgun.pump',
  'weapon.rifle.shellIn': 'weapon.shotgun.shellIn',
  'weapon.rifle.pump': 'weapon.shotgun.pump',
  'weapon.shotgun.magOut': 'weapon.rifle.magOut',
  'weapon.shotgun.magIn': 'weapon.rifle.magIn',
  'weapon.shotgun.boltRelease': 'weapon.shotgun.pump',
} as const satisfies Record<string, WeaponSynthId>;

/** Weapon synth id for an alias id, or null. */
export function weaponSynthAlias(id: string): WeaponSynthId | null {
  return Object.prototype.hasOwnProperty.call(WEAPON_SYNTH_ALIASES, id)
    ? (WEAPON_SYNTH_ALIASES as Record<string, WeaponSynthId>)[id]!
    : null;
}
