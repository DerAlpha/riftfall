/**
 * Procedural element sounds of the M5 arsenal (merged into the bank by arsenalSynth.ts):
 * explosions per element (`explosion.<element>` and `.small`), lingering field loops
 * (`field.<kind>.<element>`), projectile flight loops (`projectile.<visual>.flight`), status
 * cues (`status.<StatusId>`), combo stingers (`combo.<comboId>`) and the impact profiles of
 * energy weapons (`impact.<plasma|shock|fire|ice|poison|void>`, the ids of their VFX presets).
 *
 * Every sound here plays positionally (HRTF), so all of them are mono. Explosions are layered
 * like the M2 blast (crack, sub thump, rolling low-passed body, debris) with an element signature:
 * fire = a fireball swell and crackling embers, shock = FM zaps + ring-mod buzz + a crackle burst,
 * poison = a wet splat, bubbles and a hiss of gas, ice = a whump under a shower of glassy partials,
 * void = an inhale that cuts into a dark boom with warped inharmonic ringing.
 * Loops follow arsenalKit's rules (loopBus + LOOP_HZ grid for tonal layers).
 */
import type { StatusId } from '../core/events';
import { AUDIO } from '../defs/audio';
import type { ComboId } from '../defs/elements';
import {
  LOOP_DURATION,
  LOOP_SECONDS,
  LOOP_XF,
  kitOf,
  loopHz,
  midi,
  type Kit,
  type Recipe,
} from './arsenalKit';
import { iceCascade } from './energySynth';
import type { SynthDef } from './synth';

const LD = LOOP_DURATION;
const DARK = AUDIO.synth.darkRate;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Rising blips of gas bubbles (poison). */
function bubbles(k: Kit, t: number, count: number, span: number, lo: number, hi: number, peak: number): void {
  for (let i = 0; i < count; i++) {
    const at = t + k.rng.next() * span;
    const f = k.r(lo, hi);
    k.tone(at, 'sine', f, f * 1.8, 0.002, k.r(0.03, 0.06), peak * k.r(0.5, 1));
  }
}

/** Accelerating repeats of one short noise grain (digital glitch stutter). */
function stutter(k: Kit, t: number, count: number, gap: number, freq: number, peak: number): void {
  let at = t;
  let dt = gap;
  for (let i = 0; i < count; i++) {
    k.noise(at, {
      color: 'white',
      filter: 'bandpass',
      freq: freq * k.j(0.15),
      q: 2,
      attack: 0.001,
      decay: 0.012,
      peak: peak * (1 - i * 0.1),
    });
    at += dt;
    dt *= 0.76;
  }
}

/** Reverse suction: noise rising exponentially with a climbing band, cut at `t + dur`. */
function inhale(k: Kit, t: number, dur: number, from: number, to: number, peak: number): void {
  k.swell(t, {
    color: 'white',
    filter: 'bandpass',
    freq: from,
    sweepTo: to,
    q: 1,
    attack: dur,
    hold: dur,
    release: 0.015,
    peak,
    expRise: true,
  });
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

/** Frag / physical blast: crack, deep thump, rolling body, crunch, debris and a long rumble. */
const explosionPhysical: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.4, lowpass: 8000 });
  b.click(t, 1800 * k.j(0.1), 0.03, 1);
  b.thump(t, { f0: 120 * k.j(0.08), f1: 24, pitchTime: 0.1, decay: 0.85, peak: 1, drive: 1.8 });
  b.noise(t, {
    color: 'brown',
    filter: 'lowpass',
    freq: 1800 * k.j(0.1),
    sweepTo: 100,
    attack: 0.003,
    decay: 1.1,
    peak: 1,
  });
  b.noise(t + 0.006, {
    color: 'pink',
    filter: 'bandpass',
    freq: 750 * k.j(0.12),
    sweepTo: 180,
    q: 0.8,
    attack: 0.004,
    decay: 0.45,
    peak: 0.65,
  });
  b.noise(t, {
    color: 'white',
    filter: 'lowpass',
    freq: 3500,
    sweepTo: 500,
    attack: 0.001,
    decay: 0.12,
    peak: 0.6,
  });
  k.ticks(t + 0.08, 16, 0.8, 3000, 3, 0.18);
  for (let i = 0; i < 4; i++) {
    k.thump(t + 0.15 + k.rng.next() * 0.45, {
      f0: 200 * k.j(0.2),
      f1: 90,
      pitchTime: 0.01,
      decay: 0.03,
      peak: 0.2,
    });
  }
  k.noise(t + 0.1, { color: 'brown', filter: 'lowpass', freq: 150, attack: 0.1, decay: 1.2, peak: 0.5 });
};

const explosionPhysicalSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2, lowpass: 9000 });
  b.click(t, 2200 * k.j(0.1), 0.015, 0.9);
  b.thump(t, { f0: 150 * k.j(0.08), f1: 45, pitchTime: 0.04, decay: 0.22, peak: 1, drive: 1.5 });
  b.noise(t, {
    color: 'brown',
    filter: 'lowpass',
    freq: 2500,
    sweepTo: 200,
    attack: 0.002,
    decay: 0.25,
    peak: 0.8,
  });
  b.noise(t + 0.003, {
    color: 'pink',
    filter: 'bandpass',
    freq: 1000,
    sweepTo: 300,
    q: 0.8,
    decay: 0.1,
    peak: 0.5,
  });
  k.ticks(t + 0.03, 6, 0.25, 3500, 3, 0.15);
};

/** Fireball: ignition crack, a blooming "whoomph", roar, sub, embers crackling and a hiss. */
const explosionFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.8, lowpass: 9000 });
  b.click(t, 1500, 0.02, 0.7);
  b.swell(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 300,
    sweepTo: 2600,
    attack: 0.06,
    hold: 0.12,
    release: 0.6,
    peak: 1,
  });
  b.noise(t + 0.02, {
    color: 'brown',
    filter: 'lowpass',
    freq: 900,
    sweepTo: 200,
    attack: 0.03,
    decay: 1,
    peak: 0.8,
  });
  b.thump(t, { f0: 90 * k.j(0.08), f1: 30, pitchTime: 0.08, decay: 0.6, peak: 0.9, drive: 1.5 });
  k.ticks(t + 0.15, 40, 1.2, 2200, 2, 0.35);
  k.noise(t + 0.05, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.05, decay: 0.7, peak: 0.15 });
};

const explosionFireSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 1800, 0.012, 0.5);
  k.swell(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 400,
    sweepTo: 2000,
    attack: 0.03,
    hold: 0.04,
    release: 0.25,
    peak: 0.9,
  });
  k.thump(t, { f0: 120, f1: 45, pitchTime: 0.04, decay: 0.15, peak: 0.8 });
  k.ticks(t + 0.05, 10, 0.5, 2400, 2, 0.3);
};

/** Electric discharge: bright crack, a falling FM zap, ring-mod buzz, crackle burst, sub. */
const explosionShock: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.2, lowpass: 15000 });
  b.click(t, 7000, 0.003, 1);
  b.noise(t, { color: 'white', filter: 'highpass', freq: 4000, attack: 0.0005, decay: 0.03, peak: 0.9 });
  b.fm(t, 3000 * k.j(0.08), 2.3, 9, 0.001, 0.25, 0.5, 0, 120);
  b.ringMod(t, 200, 61, 0.003, 0.6, 0.35, { type: 'sawtooth', carrierTo: 80, modTo: 30 });
  b.thump(t, { f0: 140, f1: 40, pitchTime: 0.05, decay: 0.35, peak: 0.9, drive: 2.5 });
  k.ticks(t, 60, 0.7, 4200, 4, 0.45);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 6000, q: 1, attack: 0.002, decay: 0.5, peak: 0.25 });
};

const explosionShockSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 7000, 0.002, 0.9);
  k.fm(t, 2400 * k.j(0.1), 2.3, 7, 0.001, 0.12, 0.45, 0, 200);
  k.thump(t, { f0: 160, f1: 60, pitchTime: 0.03, decay: 0.15, peak: 0.8, drive: 2 });
  k.ticks(t, 20, 0.35, 4500, 4, 0.4);
};

/** Toxic burst: a wet splat, droplets, bubbling, a long hiss of gas over a sickly hum. */
const explosionPoison: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.4, lowpass: 8000 });
  b.thump(t, { f0: 110 * k.j(0.08), f1: 45, pitchTime: 0.04, decay: 0.25, peak: 0.9, drive: 1.2 });
  b.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 450 * k.j(0.1),
    sweepTo: 180,
    q: 3,
    attack: 0.002,
    decay: 0.2,
    peak: 0.8,
  });
  k.ticks(t + 0.01, 12, 0.3, 1200, 5, 0.4);
  bubbles(k, t + 0.1, 12, 0.8, 200, 600, 0.25);
  k.swell(t + 0.02, {
    color: 'pink',
    filter: 'highpass',
    freq: 1500,
    attack: 0.02,
    hold: 0.1,
    release: 0.7,
    peak: 0.4,
  });
  k.note(t, 'sine', 55, 50, 0.02, 0.3, 0.5, 0.2);
};

const explosionPoisonSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 120, f1: 55, pitchTime: 0.03, decay: 0.12, peak: 0.8 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 500, sweepTo: 200, q: 3, decay: 0.1, peak: 0.7 });
  bubbles(k, t + 0.05, 5, 0.35, 250, 650, 0.25);
  k.swell(t + 0.02, {
    color: 'pink',
    filter: 'highpass',
    freq: 1800,
    attack: 0.02,
    hold: 0.05,
    release: 0.3,
    peak: 0.3,
  });
};

/** Freezing burst: a whump, a gust of cold air, a shower of glass, ice cracking. */
const explosionIce: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 6500, 0.003, 1);
  const b = k.bus({ drive: 1.5, lowpass: 14000 });
  b.thump(t, { f0: 110 * k.j(0.08), f1: 40, pitchTime: 0.05, decay: 0.3, peak: 0.9, drive: 1.5 });
  b.noise(t, { color: 'pink', filter: 'lowpass', freq: 1800, sweepTo: 300, decay: 0.15, peak: 0.6 });
  k.noise(t + 0.004, {
    color: 'white',
    filter: 'bandpass',
    freq: 5000,
    sweepTo: 1500,
    q: 0.9,
    attack: 0.005,
    decay: 0.45,
    peak: 0.55,
  });
  iceCascade(k, t + 0.005, 30, 0.6, 2000, 10000, 0.35);
  k.ticks(t, 20, 0.5, 5000, 5, 0.45);
  k.bell(t + 0.01, 1760, 0.5, 0.15);
  k.bell(t + 0.02, 2637, 0.4, 0.1);
};

/** Frozen target shatters (also the status shatter burst). */
const explosionIceSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 7000, 0.002, 1);
  k.thump(t, { f0: 180, f1: 80, pitchTime: 0.02, decay: 0.08, peak: 0.7 });
  iceCascade(k, t + 0.003, 14, 0.25, 2500, 10000, 0.4);
  k.ticks(t, 8, 0.2, 5500, 5, 0.45);
  k.noise(t + 0.002, { color: 'white', filter: 'bandpass', freq: 6000, q: 1, decay: 0.12, peak: 0.35 });
};

/** Implosion: an inhale that cuts into a dark boom with warped, inharmonic ringing and a shimmer. */
const explosionVoid: Recipe = (g, t) => {
  const k = kitOf(g);
  const pre = 0.28;
  inhale(k, t, pre, 300, 3500, 0.6);
  k.note(t, 'sine', 60, 220, pre, pre, 0.01, 0.3, { expRise: true });
  const t0 = t + pre + 0.01;
  const b = k.bus({ drive: 2.2, lowpass: 9000 });
  b.click(t0, 3000, 0.01, 0.8);
  b.thump(t0, { f0: 100, f1: 20, pitchTime: 0.15, decay: 0.9, peak: 1, drive: 2.2 });
  b.noise(t0, {
    color: 'brown',
    filter: 'lowpass',
    freq: 700,
    sweepTo: 60,
    attack: 0.003,
    decay: 1,
    peak: 0.9,
  });
  k.ring(t0, 180 * k.j(0.05), [1, 1.73, 2.61, 3.9], 1, 0.25);
  k.note(t0, 'sine', 440, 110, 0.01, 0.5, 0.3, 0.12, { vibrato: { rate: 6, depth: 15 } });
  k.ringMod(t0 + 0.05, 2400, 190, 0.02, 0.8, 0.08, { carrierTo: 900 });
};

const explosionVoidSmall: Recipe = (g, t) => {
  const k = kitOf(g);
  const pre = 0.1;
  inhale(k, t, pre, 500, 3000, 0.45);
  const t0 = t + pre + 0.005;
  k.thump(t0, { f0: 130, f1: 30, pitchTime: 0.08, decay: 0.35, peak: 1, drive: 2 });
  k.noise(t0, { color: 'brown', filter: 'lowpass', freq: 600, sweepTo: 80, decay: 0.3, peak: 0.7 });
  k.note(t0, 'sine', 300, 100, 0.01, 0.15, 0.2, 0.15, { vibrato: { rate: 7, depth: 10 } });
  k.ringMod(t0 + 0.02, 1800, 170, 0.01, 0.4, 0.07, { carrierTo: 700 });
};

// ---------------------------------------------------------------------------
// Fields (loops)
// ---------------------------------------------------------------------------

/** Singularity: vortex roar, sweeping whistles, a sub throb and an eerie tone. */
const fieldPullVoid: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'brown', 'lowpass', 220, 0.7, 0.7, {
    freqLfo: { rate: 1, depth: 90 },
    gainLfo: { rate: 2, depth: 0.35 },
  });
  k.bed(t, LD, 'pink', 'bandpass', 700, 5, 0.6, { freqLfo: { rate: 0.5, depth: 450 } });
  k.bed(t, LD, 'pink', 'bandpass', 1400, 6, 0.4, { freqLfo: { rate: 1.5, depth: 600 } });
  k.bed(t, LD, 'white', 'bandpass', 3200, 2, 0.08, { gainLfo: { rate: 2, depth: 0.8 } });
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 38, 0.4, { tremolo: { rate: 2, depth: 0.7 } });
  tonal.drone(t, LD, 57, 0.2, { tremolo: { rate: 2, depth: 0.5 } });
  tonal.drone(t, LD, 220, 0.03, { type: 'triangle', vibrato: { rate: 4, depth: 12 } });
};

/** Fire pool: fluttering flames, a low roar, crackling pops and a faint hiss. */
const fieldDamageFire: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'pink', 'bandpass', 600, 0.8, 0.5, {
    gainLfo: { rate: 7, depth: 0.4 },
    freqLfo: { rate: 1.5, depth: 200 },
  });
  k.bed(t, LD, 'brown', 'lowpass', 350, 0.7, 0.6, { gainLfo: { rate: 3, depth: 0.25 } });
  k.crackle(t, LD, 30, 2200, 2, 0.4, 0, 0.5);
  k.bed(t, LD, 'white', 'highpass', 5000, 0.7, 0.03);
};

/** Poison cloud: a hiss of gas, bubbling, a wet churn and a sickly low drone. */
const fieldDamagePoison: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'pink', 'highpass', 1500, 0.7, 0.25, { gainLfo: { rate: 0.5, depth: 0.3 } });
  k.bed(t, LD, 'pink', 'bandpass', 350, 2, 0.25, { gainLfo: { rate: 3.5, depth: 0.5 } });
  bubbles(k, t, Math.round(LD * 14), LD - 0.06, 150, 500, 0.3);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 55, 0.15, { tremolo: { rate: 1.5, depth: 0.5 } });
  tonal.drone(t, LD, 82.5, 0.06, { detune: 8 });
};

/** Electric field: crackle over a mains hum and a sizzle. */
const fieldDamageShock: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 100, 0.15, { type: 'sawtooth', lowpass: 600, tremolo: { rate: 13, depth: 0.4 } });
  k.bed(t, LD, 'white', 'highpass', 4500, 0.7, 0.06, { gainLfo: { rate: 23, depth: 0.6 } });
  k.crackle(t, LD, 50, 4000, 3, 0.45, 0, 0.3);
};

/** Frost field: cold wind, creaking ice, crystal chimes. */
const fieldSlowIce: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'white', 'bandpass', 2800, 1.2, 0.25, { freqLfo: { rate: 0.5, depth: 900 } });
  k.bed(t, LD, 'pink', 'bandpass', 500, 1, 0.2, { freqLfo: { rate: 1, depth: 150 } });
  const creaks = Math.max(2, Math.round(LD * 2));
  for (let i = 0; i < creaks; i++) {
    const at = t + k.rng.next() * (LD - 0.2);
    const f = k.r(180, 320);
    k.tone(at, 'sawtooth', f, f * 0.9, 0.02, 0.12, 0.12, 0, 900);
  }
  const pings = Math.round(LD * 5);
  for (let i = 0; i < pings; i++) {
    const at = t + k.rng.next() * (LD - 0.2);
    const f = k.r(3000, 8000);
    k.note(at, 'sine', f, f, 0.004, 0.004, k.r(0.15, 0.3), k.r(0.08, 0.15));
  }
};

/** Time field (Chronofeld): a deep drone, a slowed clock ticking, reversed whooshes, a shimmer. */
const fieldSlowVoid: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 55, 0.2, {
    type: 'sawtooth',
    lowpass: 300,
    detune: 10,
    tremolo: { rate: 0.5, depth: 0.3 },
  });
  tonal.drone(t, LD, 880, 0.03, { vibrato: { rate: 0.5, depth: 30 } });
  // Periodic ticks start after the crossfade region, so the loop point keeps their rhythm.
  const ticks = 4;
  for (let i = 0; i < ticks; i++) {
    const at = t + LOOP_XF + (i * LOOP_SECONDS) / ticks;
    k.click(at, 2500, 0.01, 0.5);
    k.thump(at, { f0: 400, f1: 300, pitchTime: 0.01, decay: 0.02, peak: 0.3 });
    k.swell(at + 0.05, {
      color: 'pink',
      filter: 'bandpass',
      freq: 800,
      attack: 0.3,
      hold: 0.3,
      release: 0.02,
      peak: 0.12,
      expRise: true,
    });
  }
};

// ---------------------------------------------------------------------------
// Projectile flight loops
// ---------------------------------------------------------------------------

/** Plasma bolt: a buzzing mid tone with a fast tremolo, and a hiss. */
const flightPlasma: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 220, 0.3, { type: 'sawtooth', lowpass: 1600, q: 3, tremolo: { rate: 40, depth: 0.5 } });
  tonal.drone(t, LD, 440, 0.08, { vibrato: { rate: 9, depth: 12 } });
  k.bed(t, LD, 'white', 'bandpass', 4000, 1.5, 0.15, { gainLfo: { rate: 20, depth: 0.5 } });
};

/** Spinning grenade: a whirring band of air and a faint whistle. */
const flightGrenade: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'pink', 'bandpass', 750, 3, 0.5, { gainLfo: { rate: 14, depth: 0.6 } });
  k.bed(t, LD, 'pink', 'bandpass', 1500, 4, 0.2, { gainLfo: { rate: 14, depth: 0.6 } });
  k.bed(t, LD, 'brown', 'lowpass', 200, 0.7, 0.2);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 1400, 0.04, { vibrato: { rate: 14, depth: 30 } });
};

/** Void orb: a deep throb with beating sines, hollow wind, a phasing whoosh and a thin eerie tone. */
const flightVoid: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 45, 0.4, { tremolo: { rate: 3, depth: 0.8 } });
  tonal.drone(t, LD, 67.5, 0.2, { detune: 12 });
  tonal.drone(t, LD, 880, 0.05, { vibrato: { rate: 5, depth: 20 } });
  k.bed(t, LD, 'pink', 'bandpass', 320, 2, 0.6, { freqLfo: { rate: 0.5, depth: 150 } });
  k.bed(t, LD, 'pink', 'bandpass', 700, 3, 0.4, {
    freqLfo: { rate: 1, depth: 300 },
    gainLfo: { rate: 3, depth: 0.5 },
  });
  k.bed(t, LD, 'pink', 'bandpass', 1500, 3, 0.25, { gainLfo: { rate: 1.5, depth: 0.7 } });
};

/** Shock orb (aether harp): the chord's tones shimmering, crackle and a low hum. */
const flightShock: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  for (const note of [62, 65, 69])
    tonal.drone(t, LD, loopHz(midi(note)), 0.12, { tremolo: { rate: 6, depth: 0.5 } });
  tonal.drone(t, LD, 73.5, 0.08, { type: 'sawtooth', lowpass: 400 });
  k.crackle(t, LD, 30, 5000, 3, 0.25, 0, 0);
};

/** Cryo orb: an icy whistle with vibrato, cold wind, crystal tinkles, a low hum. */
const flightCryo: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 1800, 0.1, { vibrato: { rate: 7, depth: 25 } });
  tonal.drone(t, LD, 2700, 0.04, { vibrato: { rate: 5, depth: 20 } });
  tonal.drone(t, LD, 110, 0.05);
  k.bed(t, LD, 'white', 'bandpass', 3200, 1.5, 0.25, { freqLfo: { rate: 0.5, depth: 800 } });
  const pings = Math.round(LD * 8);
  for (let i = 0; i < pings; i++) {
    const f = k.r(3000, 8000);
    k.note(t + k.rng.next() * (LD - 0.1), 'sine', f, f, 0.004, 0.004, k.r(0.05, 0.15), k.r(0.05, 0.12));
  }
};

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

const statusBurn: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 400,
    sweepTo: 2200,
    attack: 0.03,
    hold: 0.03,
    release: 0.2,
    peak: 0.7,
  });
  k.ticks(t + 0.02, 10, 0.45, 2600, 2, 0.35);
  k.thump(t, { f0: 120, f1: 60, pitchTime: 0.02, decay: 0.1, peak: 0.4 });
};

const statusChill: Recipe = (g, t) => {
  const k = kitOf(g);
  k.ticks(t, 10, 0.3, 6000, 6, 0.35);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 6000, sweepTo: 4000, q: 1, decay: 0.2, peak: 0.3 });
  k.bell(t + 0.02, 3136, 0.25, 0.12);
};

/** Freezing solid: crystallization crackle speeding up, a solid clunk of ice, a creak, glass. */
const statusFrozen: Recipe = (g, t) => {
  const k = kitOf(g);
  let at = t;
  for (let i = 0; i < 16; i++) {
    const u = i / 15;
    k.noise(at, {
      color: 'white',
      filter: 'bandpass',
      freq: 3000 + 4000 * u,
      q: 6,
      attack: 0.0005,
      decay: 0.008,
      peak: 0.25 + 0.2 * u,
    });
    at += 0.03 * (1 - u * 0.7);
  }
  const lock = t + 0.3;
  k.thump(lock, { f0: 240, f1: 160, pitchTime: 0.01, decay: 0.06, peak: 0.8 });
  k.click(lock, 5000, 0.004, 0.7);
  k.ring(lock, 2100 * k.j(0.04), [1, 2.3, 3.7], 0.2, 0.3);
  k.tone(lock + 0.05, 'sawtooth', 240, 180, 0.03, 0.2, 0.1, 0, 1200);
  k.bell(lock + 0.02, 2093, 0.5, 0.15);
};

/** Bzzzt: ring-mod buzz, dense crackle, a snap. */
const statusShocked: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 6000, 0.002, 0.8);
  k.ringMod(t, 220, 83, 0.002, 0.2, 0.45, { type: 'sawtooth' });
  k.crackle(t, 0.25, 150, 4500, 3, 0.45);
  k.thump(t, { f0: 150, f1: 70, pitchTime: 0.02, decay: 0.06, peak: 0.4 });
};

const statusPoisoned: Recipe = (g, t) => {
  const k = kitOf(g);
  bubbles(k, t + 0.02, 6, 0.3, 180, 420, 0.3);
  k.noise(t, {
    color: 'pink',
    filter: 'bandpass',
    freq: 380,
    sweepTo: 250,
    q: 4,
    attack: 0.01,
    decay: 0.2,
    peak: 0.5,
  });
  k.noise(t + 0.03, { color: 'pink', filter: 'highpass', freq: 2000, attack: 0.02, decay: 0.25, peak: 0.25 });
  k.fm(t, 150, 0.5, 2, 0.02, 0.3, 0.15);
};

/** The void mark: a reversed swell into a low "dum" with an eerie ring. */
const statusVoidMark: Recipe = (g, t) => {
  const k = kitOf(g);
  inhale(k, t, 0.2, 1200, 300, 0.4);
  const t0 = t + 0.2;
  k.thump(t0, { f0: 70, f1: 35, pitchTime: 0.05, decay: 0.3, peak: 0.8, drive: 1.5 });
  k.tone(t0, 'sine', 1318, 1300, 0.01, 0.4, 0.12);
  k.tone(t0, 'sine', 1975, 1960, 0.01, 0.25, 0.06);
  k.ringMod(t0, 600, 47, 0.01, 0.35, 0.1);
};

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

/** Fire + ice: a steam explosion – violent hiss, ice shattering, sizzle, a boom. */
const comboThermoshock: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 5000, 0.005, 1);
  k.swell(t, {
    color: 'white',
    filter: 'bandpass',
    freq: 3500,
    sweepTo: 1800,
    q: 0.7,
    attack: 0.005,
    hold: 0.1,
    release: 0.5,
    peak: 0.9,
  });
  const b = k.bus({ drive: 2, lowpass: 9000 });
  b.thump(t, { f0: 120, f1: 35, pitchTime: 0.06, decay: 0.35, peak: 1, drive: 2 });
  b.noise(t, { color: 'brown', filter: 'lowpass', freq: 1200, sweepTo: 120, decay: 0.5, peak: 0.7 });
  iceCascade(k, t + 0.005, 16, 0.3, 2500, 9000, 0.35);
  k.ticks(t + 0.05, 20, 0.6, 3000, 3, 0.3);
};

/** Shock + poison: a sickly FM wobble, buzzing arcs, bubbling, a nerve "twang", a thump. */
const comboNeurotoxin: Recipe = (g, t) => {
  const k = kitOf(g);
  k.fm(t, 180, 0.51, 6, 0.005, 0.5, 0.45);
  k.ringMod(t, 330, 71, 0.003, 0.4, 0.35, { type: 'sawtooth', carrierTo: 110 });
  k.crackle(t, 0.5, 120, 4200, 3, 0.35);
  bubbles(k, t + 0.1, 8, 0.5, 180, 500, 0.25);
  k.pluck(t + 0.02, 98, 0.6, 0.4, 0, 0.9);
  k.thump(t, { f0: 110, f1: 45, pitchTime: 0.04, decay: 0.3, peak: 0.8, drive: 1.5 });
};

/** Fire + poison: gas pops, catches – a flare-up whoosh over a low boom, bubbles bursting into embers. */
const comboToxicblaze: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 500, q: 3, decay: 0.08, peak: 0.6 });
  const b = k.bus({ drive: 1.8, lowpass: 9000 });
  b.swell(t + 0.04, {
    color: 'pink',
    filter: 'lowpass',
    freq: 300,
    sweepTo: 3000,
    attack: 0.05,
    hold: 0.06,
    release: 0.4,
    peak: 1,
  });
  b.thump(t + 0.04, { f0: 90, f1: 30, pitchTime: 0.07, decay: 0.45, peak: 1, drive: 2 });
  bubbles(k, t + 0.08, 8, 0.4, 250, 700, 0.25);
  k.ticks(t + 0.1, 25, 0.8, 2400, 2, 0.35);
};

/** Ice + shock: singing arcs, crystalline ring-mod shimmer, an ice-ping shower, a zap. */
const comboSuperconductor: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 7000, 0.002, 0.9);
  for (const [f0, f1] of [
    [1200, 2400],
    [1800, 3600],
    [2400, 4800],
  ] as const) {
    k.tone(t, 'sine', f0, f1, 0.01, 0.35, 0.2);
  }
  k.ringMod(t, 2000, 1500, 0.005, 0.4, 0.2);
  iceCascade(k, t + 0.01, 12, 0.35, 3000, 9000, 0.3);
  k.fm(t, 3000, 2.3, 6, 0.001, 0.1, 0.4, 0, 400);
  k.thump(t, { f0: 140, f1: 60, pitchTime: 0.03, decay: 0.2, peak: 0.7, drive: 2 });
};

/** Void + any: reality ruptures – an inhale, a dark boom, a warped shimmer, a glitch stutter. */
const comboVoidrupture: Recipe = (g, t) => {
  const k = kitOf(g);
  const pre = 0.18;
  inhale(k, t, pre, 400, 4000, 0.55);
  const t0 = t + pre + 0.005;
  const b = k.bus({ drive: 2.5, lowpass: 9000 });
  b.click(t0, 4000, 0.006, 0.8);
  b.thump(t0, { f0: 90, f1: 20, pitchTime: 0.12, decay: 0.7, peak: 1, drive: 2.5 });
  b.noise(t0, { color: 'brown', filter: 'lowpass', freq: 900, sweepTo: 60, decay: 0.7, peak: 0.9 });
  k.ringMod(t0 + 0.01, 1800, 237, 0.01, 0.6, 0.15, { carrierTo: 600 });
  stutter(k, t0 + 0.03, 6, 0.06, 2000, 0.4);
};

// ---------------------------------------------------------------------------
// Energy impacts (the VFX impact profiles of energy weapons)
// ---------------------------------------------------------------------------

const impactPlasma: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 5000, 0.003, 0.7);
  k.fm(t, 1400 * k.j(0.1), 1.4, 4, 0.001, 0.06, 0.35, 0, 200);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 4500, q: 1, decay: 0.12, peak: 0.45 });
  k.thump(t, { f0: 150, f1: 60, pitchTime: 0.02, decay: 0.06, peak: 0.7 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1200, sweepTo: 400, q: 1, decay: 0.06, peak: 0.5 });
};

const impactShock: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 6500, 0.002, 0.9);
  k.crackle(t, 0.1, 180, 5000, 3, 0.5);
  k.ringMod(t, 240, 77, 0.002, 0.08, 0.3, { type: 'sawtooth' });
  k.thump(t, { f0: 140, f1: 70, pitchTime: 0.015, decay: 0.04, peak: 0.4 });
};

const impactFire: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, {
    color: 'pink',
    filter: 'lowpass',
    freq: 600,
    sweepTo: 2200,
    attack: 0.01,
    hold: 0.02,
    release: 0.12,
    peak: 0.7,
  });
  k.ticks(t + 0.01, 6, 0.2, 2400, 2, 0.3);
  k.thump(t, { f0: 110, f1: 60, pitchTime: 0.02, decay: 0.05, peak: 0.4 });
};

const impactIce: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 7000, 0.002, 0.8);
  iceCascade(k, t, 6, 0.12, 3000, 9000, 0.35);
  k.ticks(t, 5, 0.1, 5500, 5, 0.35);
  k.thump(t, { f0: 170, f1: 90, pitchTime: 0.012, decay: 0.03, peak: 0.4 });
};

const impactPoison: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 500, sweepTo: 200, q: 3, decay: 0.1, peak: 0.8 });
  k.thump(t, { f0: 120, f1: 60, pitchTime: 0.02, decay: 0.05, peak: 0.6 });
  k.noise(t + 0.01, { color: 'pink', filter: 'highpass', freq: 2000, decay: 0.15, peak: 0.25 });
  bubbles(k, t + 0.02, 3, 0.15, 250, 600, 0.25);
};

const impactVoid: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 4000, 0.004, 0.5);
  k.thump(t, { f0: 90, f1: 35, pitchTime: 0.03, decay: 0.15, peak: 1, drive: 1.8 });
  k.note(t, 'sine', 330, 120, 0.005, 0.05, 0.15, 0.2);
  k.ringMod(t + 0.01, 1500, 150, 0.005, 0.1, 0.08, { carrierTo: 700 });
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Blasts are dark (bus low-passes ≤ 9 kHz) except ice / shock: those keep the full rate. */
function blast(duration: number, recipe: Recipe, variants = 1, level = 1, rate: number = DARK): SynthDef {
  return { variants, duration, channels: 1, level, rate, recipe };
}

/** Positional loops (fields, flights): textures below ~10 kHz, rendered at half rate. */
function monoLoop(recipe: Recipe, level = 0.85, rate: number = DARK): SynthDef {
  return { variants: 1, duration: LD, channels: 1, level, loop: true, rate, recipe };
}

function cue(duration: number, recipe: Recipe, variants = 2, level = 0.85): SynthDef {
  return { variants, duration, channels: 1, level, recipe };
}

const STATUS_DEFS = {
  'status.burn': cue(0.55, statusBurn),
  'status.chill': cue(0.45, statusChill),
  'status.frozen': cue(0.85, statusFrozen, 2, 0.9),
  'status.shocked': cue(0.4, statusShocked),
  'status.poisoned': cue(0.55, statusPoisoned),
  'status.voidMark': cue(0.7, statusVoidMark),
} as const satisfies Record<`status.${StatusId}`, SynthDef>;

const COMBO_DEFS = {
  'combo.thermoshock': cue(1.1, comboThermoshock, 1, 1),
  'combo.neurotoxin': cue(1, comboNeurotoxin, 1, 1),
  'combo.toxicblaze': { ...cue(1.1, comboToxicblaze, 1, 1), rate: DARK },
  'combo.superconductor': cue(0.9, comboSuperconductor, 1, 1),
  'combo.voidrupture': { ...cue(1.1, comboVoidrupture, 1, 1), rate: DARK },
} as const satisfies Record<`combo.${ComboId}`, SynthDef>;

export const ELEMENT_SYNTH_DEFS = {
  // --- explosions (mono → HRTF) ---
  'explosion.physical': blast(2, explosionPhysical, 2),
  'explosion.physical.small': blast(0.7, explosionPhysicalSmall, 3, 0.95),
  'explosion.fire': blast(1.8, explosionFire, 2),
  'explosion.fire.small': blast(0.8, explosionFireSmall, 2, 0.95),
  'explosion.shock': blast(1.5, explosionShock, 1, 1, 1),
  'explosion.shock.small': blast(0.6, explosionShockSmall, 2, 0.95, 1),
  'explosion.poison': blast(1.5, explosionPoison),
  'explosion.poison.small': blast(0.7, explosionPoisonSmall, 2, 0.95),
  'explosion.ice': blast(1.6, explosionIce, 1, 1, 1),
  'explosion.ice.small': blast(0.7, explosionIceSmall, 2, 0.95, 1),
  'explosion.void': blast(2, explosionVoid),
  'explosion.void.small': blast(0.9, explosionVoidSmall, 2, 0.95),
  // --- fields (mono loops) ---
  'field.pull.void': monoLoop(fieldPullVoid, 0.9, DARK),
  'field.damage.fire': monoLoop(fieldDamageFire, 0.85, DARK),
  'field.damage.poison': monoLoop(fieldDamagePoison),
  'field.damage.shock': monoLoop(fieldDamageShock),
  'field.slow.ice': monoLoop(fieldSlowIce),
  'field.slow.void': monoLoop(fieldSlowVoid),
  // --- projectile flight (mono loops) ---
  'projectile.plasma.flight': monoLoop(flightPlasma, 0.7),
  'projectile.grenade.flight': monoLoop(flightGrenade, 0.6, DARK),
  'projectile.voidorb.flight': monoLoop(flightVoid, 0.85, DARK),
  'projectile.shockorb.flight': monoLoop(flightShock, 0.7),
  'projectile.cryoorb.flight': monoLoop(flightCryo, 0.7),
  // --- statuses, combos ---
  ...STATUS_DEFS,
  ...COMBO_DEFS,
  // --- energy impacts (mono → HRTF) ---
  'impact.plasma': cue(0.3, impactPlasma, 3, 0.85),
  'impact.shock': cue(0.25, impactShock, 3, 0.85),
  'impact.fire': cue(0.3, impactFire, 3, 0.8),
  'impact.ice': cue(0.3, impactIce, 3, 0.8),
  'impact.poison': cue(0.3, impactPoison, 3, 0.8),
  'impact.void': cue(0.35, impactVoid, 3, 0.85),
} as const satisfies Record<string, SynthDef>;

/** Convention ids that share a recipe (grenade visuals, fields of other elements, the frag id). */
export const ELEMENT_SYNTH_ALIASES: Readonly<Record<string, keyof typeof ELEMENT_SYNTH_DEFS>> = {
  'projectile.frag.flight': 'projectile.grenade.flight',
  'projectile.incendiary.flight': 'projectile.grenade.flight',
  'projectile.cryo.flight': 'projectile.grenade.flight',
  'projectile.singularity.flight': 'projectile.voidorb.flight',
  'explosion.frag': 'explosion.physical',
  'explosion.frag.small': 'explosion.physical.small',
  'field.pull.physical': 'field.pull.void',
  'field.pull.fire': 'field.pull.void',
  'field.pull.ice': 'field.pull.void',
  'field.pull.shock': 'field.pull.void',
  'field.pull.poison': 'field.pull.void',
  'field.damage.void': 'field.pull.void',
  'field.damage.ice': 'field.slow.ice',
  'field.damage.physical': 'field.damage.fire',
  'field.slow.physical': 'field.slow.void',
  'field.slow.chrono': 'field.slow.void',
  'field.slow.fire': 'field.damage.fire',
  'field.slow.shock': 'field.damage.shock',
  'field.slow.poison': 'field.damage.poison',
  'impact.energy': 'impact.plasma',
};
