/**
 * Procedural sounds of the M5 energy, experimental and wonder weapons (merged into the bank by
 * arsenalSynth.ts): fire layers, mechanical layers, equip, reload steps and the weapon loops
 * (beam `weapon.<id>.loop`, charge `weapon.<id>.charge`, spin-up `weapon.<id>.spin`) plus the
 * minigun's spin loop, which shares the loop machinery.
 *
 * Palette: plasma = zap-thump (falling saw/FM sweep over a sub kick, a puff of ionized air); chain
 * lightning = arc strike, a crackling mains-hum loop, a capacitor wind-down; railgun = a beating
 * capacitor whine loop the bridge pitches up with the charge, then a supersonic crack with singing
 * rails; flamethrower = igniter + "fwoomph", a turbulent roar loop, a valve cut; grenade launcher =
 * hollow tube "bloop" and a ratcheting drum; black hole = inhale, then a sub drop with a warped
 * "wom"; rift-ripper = flanged tearing with a glitch stutter; aether harp = a plucked chord per shot
 * (variants walk a D-minor progression – full auto plays a harp line); cryo nova = crystalline
 * burst of glassy partials over a frosty whump.
 *
 * Loops follow arsenalKit's rules (loopBus for tonal layers, whole cycles on the LOOP_HZ grid).
 * The beam/charge/spin loops are stereo (2D, the player's weapon). Frequencies, levels and times
 * inside the recipes are sound-design constants.
 */
import { AUDIO } from '../defs/audio';
import { LOOP_DURATION, kitOf, midi, type Kit, type Recipe } from './arsenalKit';
import type { SynthDef } from './synth';

const A = AUDIO.arsenal.synth;
const FV = A.fireVariants;
const SV = A.semiFireVariants;
const LD = LOOP_DURATION;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Handling contact: click + short thump + ring. */
function clunk(k: Kit, t: number, seat: number, ring: number, peak = 1, pan = 0): void {
  k.click(t, 2600 + ring, 0.007, 0.8 * peak, pan);
  k.thump(t, { f0: seat * k.j(0.05), f1: seat * 0.6, pitchTime: 0.012, decay: 0.05, peak: 0.85 * peak });
  k.ring(t, ring * k.j(0.05), [1, 2.3, 3.8], 0.08, 0.3 * peak, pan);
}

/** Pneumatic hiss (cells, canisters, vents). */
function hiss(k: Kit, t: number, from: number, to: number, decay: number, peak: number, pan = 0): void {
  k.noise(t, { color: 'white', filter: 'bandpass', freq: from, sweepTo: to, q: 0.8, attack: 0.005, decay, peak, pan });
}

function whoosh(k: Kit, t: number, from: number, to: number, decay: number, peak: number): void {
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: from, sweepTo: to, q: 1.1, attack: decay * 0.4, decay, peak });
}

/** Energy cell out: latch, hiss, the cell slides free, power-down blip. */
function cellOut(o: { seat: number; ring: number; hissFrom: number; hissTo: number; blip?: number }): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.click(t, 3800, 0.004, 0.6);
    hiss(k, t + 0.01, o.hissFrom, o.hissTo, 0.2, 0.55);
    k.noise(t + 0.06, { color: 'pink', filter: 'bandpass', freq: 1400, sweepTo: 900, q: 1.8, attack: 0.01, decay: 0.06, peak: 0.35 });
    clunk(k, t + 0.14, o.seat, o.ring, 0.55);
    if (o.blip) k.tone(t, 'sine', o.blip, o.blip * 0.25, 0.003, 0.15, 0.15);
  };
}

/** Energy cell in: slide, seat, power-up chirp. */
function cellIn(o: { seat: number; ring: number; chirp: number; hum?: number }): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.noise(t, { color: 'pink', filter: 'bandpass', freq: 900, sweepTo: 1500, q: 1.8, attack: 0.01, decay: 0.05, peak: 0.4 });
    const b = k.bus({ drive: 1.6 });
    clunk(b, t + 0.08, o.seat, o.ring, 1.05);
    k.tone(t + 0.16, 'sine', o.chirp, o.chirp * 2, 0.004, 0.05, 0.22);
    k.tone(t + 0.22, 'sine', o.chirp * 2, o.chirp * 3, 0.004, 0.06, 0.2);
    if (o.hum) k.note(t + 0.1, 'sawtooth', o.hum, o.hum * 1.5, 0.12, 0.18, 0.15, 0.12, { lowpass: 900 });
  };
}

// ---------------------------------------------------------------------------
// PL-2 „Sonnenwind“ – plasma
// ---------------------------------------------------------------------------

const plasmaFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2, lowpass: 14000 });
  b.click(t, 5000, 0.003, 0.6);
  b.tone(t, 'sawtooth', 2400 * k.j(0.06), 220, 0.001, 0.07, 0.35, 0, 5000);
  b.tone(t, 'square', 1200 * k.j(0.06), 110, 0.001, 0.06, 0.18, 0, 3000);
  b.fm(t, 900 * k.j(0.05), 1.41, 5, 0.001, 0.09, 0.35, 0, 180);
  b.thump(t, { f0: 120 * k.j(0.05), f1: 48, pitchTime: 0.03, decay: 0.14, peak: 1, drive: 2.5 });
  b.thump(t, { f0: 60, f1: 38, pitchTime: 0.05, decay: 0.18, peak: 0.6 });
  b.noise(t + 0.002, { color: 'pink', filter: 'bandpass', freq: 1800, sweepTo: 500, q: 1, decay: 0.08, peak: 0.6 });
  k.crackle(t + 0.004, 0.06, 150, 5000, 3, 0.2, 0.5);
  b.noise(t + 0.005, { color: 'pink', filter: 'bandpass', freq: 2200, q: 1, decay: 0.03, peak: 0.25, pan: -0.6 });
  b.noise(t + 0.009, { color: 'pink', filter: 'bandpass', freq: 1700, q: 1, decay: 0.035, peak: 0.25, pan: 0.6 });
};

/** Coils recharge between bolts: a quiet rising chirp, a vent tick. */
const plasmaMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t + 0.04, 'sine', 500 * k.j(0.05), 1500, 0.02, 0.1, 0.25, 0.2);
  k.tone(t + 0.04, 'triangle', 1000, 3000, 0.02, 0.08, 0.08, 0.2);
  k.click(t + 0.12, 4200, 0.003, 0.3, 0.25);
  k.noise(t + 0.12, { color: 'white', filter: 'bandpass', freq: 6000, q: 2, decay: 0.05, peak: 0.1, pan: 0.25 });
};

const plasmaEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 500, 1300, 0.12, 0.45);
  k.note(t + 0.02, 'sawtooth', 110, 440, 0.3, 0.33, 0.1, 0.2, { lowpass: 1200 });
  k.tone(t + 0.02, 'sine', 400, 2400, 0.3, 0.1, 0.22);
  k.tone(t + 0.36, 'sine', 1800, 2600, 0.002, 0.06, 0.2);
  clunk(k, t + 0.44, 220, 1500, 0.8);
};

const plasmaVent: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 3600, 0.004, 0.5);
  k.swell(t + 0.01, { color: 'white', filter: 'highpass', freq: 2500, sweepTo: 3800, attack: 0.01, hold: 0.12, release: 0.3, peak: 0.55, pan: 0.2 });
  k.bell(t + 0.32, 2600, 0.25, 0.16);
};

// ---------------------------------------------------------------------------
// EX-1 „Kettenblitz“ – chain lightning (beam)
// ---------------------------------------------------------------------------

/** Beam ignition: the first arc strikes. */
const lightningStrike: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.4, lowpass: 15000 });
  b.click(t, 6000, 0.002, 1);
  b.noise(t, { color: 'white', filter: 'highpass', freq: 3000, attack: 0.0005, decay: 0.06, peak: 0.8 });
  b.fm(t, 1600 * k.j(0.08), 2.7, 8, 0.001, 0.12, 0.45, 0, 140);
  b.ringMod(t, 240, 97, 0.002, 0.25, 0.3, { type: 'sawtooth' });
  b.thump(t, { f0: 150, f1: 50, pitchTime: 0.03, decay: 0.12, peak: 0.9, drive: 3 });
  k.crackle(t, 0.25, 220, 4500, 4, 0.5, 0.7, 0.3);
};

/** The beam: mains hum with a flicker, dense crackle, sizzle and bigger arc snaps. */
const lightningLoop: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 100, 0.22, { type: 'sawtooth', lowpass: 900, detune: 10, tremolo: { rate: 13, depth: 0.3 } });
  tonal.drone(t, LD, 50, 0.14, { type: 'square', lowpass: 300 });
  tonal.drone(t, LD, 300, 0.04, { type: 'sawtooth', lowpass: 2400, tremolo: { rate: 23, depth: 0.8 } });
  k.bed(t, LD, 'white', 'highpass', 4500, 0.7, 0.08, { gainLfo: { rate: 23, depth: 0.6 } });
  k.crackle(t, LD, 90, 3800, 3, 0.55, 0.8, 0.25);
  const snaps = Math.round(LD * 6);
  for (let i = 0; i < snaps; i++) {
    const at = t + k.rng.next() * (LD - 0.05);
    const pan = k.rng.next() * 1.2 - 0.6;
    k.click(at, 5000, 0.003, 0.8, pan);
    k.fm(at, k.r(800, 2000), 2.3, 6, 0.001, 0.04, 0.3, pan, 200);
    k.thump(at, { f0: 180, f1: 80, pitchTime: 0.01, decay: 0.02, peak: 0.3, pan });
  }
};

/** Beam released: the capacitors wind down, a last fizzle and pop. */
const lightningRelease: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sawtooth', 1400, 180, 0.002, 0.25, 0.25, 0, 3000);
  k.fm(t, 600, 1.5, 3, 0.002, 0.3, 0.2, 0, 90);
  k.ticks(t, 12, 0.35, 4000, 4, 0.35, 0.4);
  k.click(t + 0.3, 3000, 0.006, 0.4);
  k.thump(t + 0.3, { f0: 200, f1: 90, pitchTime: 0.012, decay: 0.04, peak: 0.35 });
};

const lightningEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 500, 1300, 0.12, 0.45);
  k.note(t + 0.02, 'sawtooth', 60, 120, 0.3, 0.35, 0.15, 0.3, { lowpass: 800 });
  k.crackle(t + 0.1, 0.4, 40, 4200, 3, 0.35, 0.5);
  k.fm(t + 0.45, 2000, 2.3, 5, 0.001, 0.06, 0.3, 0, 400);
  clunk(k, t + 0.5, 210, 1400, 0.7);
};

const lightningProngs: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sine', 900, 1300, 0.02, 0.1, 0.12);
  for (const at of [0.08, 0.2]) {
    k.click(t + at, 6000, 0.002, 0.7);
    k.ringMod(t + at, 180, 67, 0.002, 0.07, 0.35, { type: 'sawtooth' });
    k.crackle(t + at, 0.06, 250, 4500, 3, 0.4, 0.5);
  }
};

// ---------------------------------------------------------------------------
// RG-9 „Lanze“ – railgun (charge)
// ---------------------------------------------------------------------------

const railFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2.2, lowpass: 15000 });
  b.click(t, 7000, 0.002, 1);
  b.noise(t, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.0003, decay: 0.02, peak: 1 });
  for (const pan of [-0.4, 0.4]) {
    k.noise(t + 0.001, { color: 'white', filter: 'bandpass', freq: 9000 * k.j(0.05), sweepTo: 1200, q: 2, attack: 0.001, decay: 0.16, peak: 0.8, pan });
  }
  k.ring(t, 3100 * k.j(0.03), [1, 1.47, 2.09, 2.76, 3.52], 0.45, 0.22, 0.1);
  b.fm(t, 420, 3.3, 6, 0.001, 0.25, 0.5, 0, 90);
  b.thump(t, { f0: 90, f1: 26, pitchTime: 0.08, decay: 0.55, peak: 1, drive: 2.2 });
  b.thump(t, { f0: 170, f1: 55, pitchTime: 0.025, decay: 0.16, peak: 0.9, drive: 3 });
  b.noise(t, { color: 'white', filter: 'lowpass', freq: 6000, sweepTo: 1200, attack: 0.0008, decay: 0.05, peak: 0.6 });
  const e = k.bus({ lowpass: 2000, highpass: 120 });
  for (const [d, gain, pan] of [
    [0.09, 0.22, -0.5],
    [0.2, 0.13, 0.5],
  ] as const) {
    e.noise(t + d, { color: 'pink', filter: 'bandpass', freq: 700, q: 0.7, attack: 0.004, decay: 0.2, peak: gain, pan });
  }
};

/** The charge: a beating capacitor whine over a hum, fizz and sparse sparks (the bridge pitches it up). */
const railCharge: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 330, 0.18, { detune: 5, tremolo: { rate: 8, depth: 0.2 } });
  tonal.drone(t, LD, 660, 0.12, { detune: 3, tremolo: { rate: 8, depth: 0.25 } });
  tonal.drone(t, LD, 990, 0.05);
  tonal.drone(t, LD, 1980, 0.03, { vibrato: { rate: 6, depth: 12 } });
  tonal.drone(t, LD, 110, 0.15, { type: 'sawtooth', lowpass: 700 });
  k.bed(t, LD, 'white', 'bandpass', 5000, 2, 0.05, { gainLfo: { rate: 16, depth: 0.7 } });
  k.crackle(t, LD, 12, 5000, 3, 0.25, 0.5);
};

/** After the shot: coolant vents, the rails tick as they cool, a discharge whine falls. */
const railMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t + 0.05, { color: 'white', filter: 'highpass', freq: 3000, attack: 0.01, hold: 0.1, release: 0.35, peak: 0.5, pan: 0.3 });
  k.tone(t + 0.01, 'sine', 2600, 700, 0.002, 0.3, 0.12);
  k.ticks(t + 0.15, 6, 0.5, 5200, 8, 0.18, 0.3);
  clunk(k, t + 0.12, 200, 1200, 0.6, 0.2);
};

const railEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 420, 1200, 0.15, 0.5);
  k.note(t + 0.02, 'sawtooth', 55, 110, 0.4, 0.45, 0.2, 0.4, { lowpass: 600 });
  k.click(t + 0.05, 3000, 0.005, 0.6);
  k.click(t + 0.12, 3400, 0.005, 0.5);
  clunk(k, t + 0.15, 180, 1100, 0.8);
  k.tone(t + 0.1, 'sine', 300, 1200, 0.45, 0.1, 0.25);
  k.bell(t + 0.6, 2200, 0.3, 0.22);
};

const railLock: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2 });
  b.thump(t, { f0: 150, f1: 80, pitchTime: 0.015, decay: 0.08, peak: 1, drive: 2 });
  b.click(t, 2600, 0.008, 0.9);
  b.ring(t, 900 * k.j(0.04), [1, 2.4, 3.9], 0.15, 0.3);
  k.note(t + 0.04, 'sawtooth', 55, 82.5, 0.12, 0.2, 0.15, 0.2, { lowpass: 700 });
  k.crackle(t + 0.05, 0.2, 40, 5000, 3, 0.25, 0.4);
};

// ---------------------------------------------------------------------------
// FW-4 „Inferno“ – flamethrower (beam)
// ---------------------------------------------------------------------------

/** Ignition: the igniter sparks, then the gas catches – "fwoomph". */
const flameIgnite: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 5000, 0.003, 0.7);
  k.crackle(t, 0.04, 200, 5000, 3, 0.35, 0.3);
  const b = k.bus({ drive: 1.6, lowpass: 9000 });
  b.swell(t + 0.02, { color: 'pink', filter: 'lowpass', freq: 250, sweepTo: 3000, attack: 0.07, hold: 0.08, release: 0.3, peak: 1 });
  b.thump(t + 0.03, { f0: 90, f1: 40, pitchTime: 0.06, decay: 0.3, peak: 0.9, drive: 2 });
  b.noise(t + 0.03, { color: 'brown', filter: 'lowpass', freq: 400, attack: 0.02, decay: 0.35, peak: 0.8 });
};

/** The roar: turbulent combustion (fluttering low-mid noise, decorrelated L/R), gas hiss, pops, rumble. */
const flameLoop: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bed(t, LD, 'brown', 'lowpass', 700, 0.5, 0.9, {
    freqLfo: { rate: 3.5, depth: 250 },
    gainLfo: { rate: 11, depth: 0.25 },
  });
  k.bed(t, LD, 'pink', 'bandpass', 900, 0.7, 0.45, { freqLfo: { rate: 1.5, depth: 400 }, gainLfo: { rate: 9, depth: 0.3 }, pan: -0.55 });
  k.bed(t, LD, 'pink', 'bandpass', 1300, 0.7, 0.35, { freqLfo: { rate: 2.5, depth: 500 }, gainLfo: { rate: 13, depth: 0.3 }, pan: 0.55 });
  k.bed(t, LD, 'white', 'highpass', 4000, 0.7, 0.06);
  k.bed(t, LD, 'brown', 'lowpass', 120, 0.7, 0.5);
  k.crackle(t, LD, 25, 2500, 2, 0.35, 0.6, 0.5);
};

/** Valve cut: a click, a burst of gas, the flame puffs out. */
const flameStop: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 2600, 0.006, 0.5);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3000, q: 0.8, decay: 0.12, peak: 0.35 });
  k.noise(t + 0.01, { color: 'pink', filter: 'lowpass', freq: 600, decay: 0.15, peak: 0.7 });
  k.noise(t + 0.03, { color: 'pink', filter: 'bandpass', freq: 700, q: 1, attack: 0.02, decay: 0.25, peak: 0.3 });
  k.ticks(t + 0.02, 5, 0.3, 2400, 2, 0.2, 0.4);
};

const flameEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 420, 1100, 0.14, 0.5);
  k.click(t + 0.1, 4500, 0.003, 0.6);
  k.click(t + 0.22, 4500, 0.003, 0.6);
  k.swell(t + 0.25, { color: 'pink', filter: 'lowpass', freq: 300, sweepTo: 1500, attack: 0.04, hold: 0.05, release: 0.2, peak: 0.5 });
  k.noise(t + 0.25, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.02, decay: 0.3, peak: 0.1 });
  clunk(k, t + 0.45, 190, 900, 0.7);
};

const flameTankOff: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sawtooth', 900, 1200, 0.02, 0.06, 0.06, 0, 3000);
  hiss(k, t + 0.04, 2500, 1500, 0.25, 0.5);
  clunk(k, t + 0.22, 180, 800, 0.7);
};

const flameTankOn: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.6 });
  clunk(b, t, 190, 800, 1.05);
  k.ticks(t + 0.06, 4, 0.12, 3500, 6, 0.3);
  k.swell(t + 0.2, { color: 'white', filter: 'bandpass', freq: 2000, sweepTo: 3500, attack: 0.05, hold: 0.1, release: 0.15, peak: 0.35 });
};

const flamePilot: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 4500, 0.003, 0.6);
  k.click(t + 0.1, 4500, 0.003, 0.6);
  k.swell(t + 0.14, { color: 'pink', filter: 'lowpass', freq: 300, sweepTo: 1600, attack: 0.04, hold: 0.05, release: 0.22, peak: 0.6 });
  k.noise(t + 0.14, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.02, decay: 0.25, peak: 0.1 });
};

// ---------------------------------------------------------------------------
// GL-6 „Donnerkeil“ – grenade launcher
// ---------------------------------------------------------------------------

/** "Thoomp": a hollow tube resonance around a round body, a puff of gas. */
const launcherFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.6, lowpass: 7000 });
  b.thump(t, { f0: 190 * k.j(0.05), f1: 75, pitchTime: 0.05, decay: 0.2, peak: 1, drive: 1.8 });
  b.noise(t, { color: 'pink', filter: 'bandpass', freq: 260 * k.j(0.05), q: 6, attack: 0.002, decay: 0.12, peak: 0.9 });
  b.noise(t, { color: 'pink', filter: 'bandpass', freq: 520 * k.j(0.05), q: 5, attack: 0.002, decay: 0.08, peak: 0.4 });
  b.thump(t, { f0: 60, f1: 35, pitchTime: 0.08, decay: 0.3, peak: 0.8 });
  b.noise(t + 0.004, { color: 'pink', filter: 'lowpass', freq: 1200, sweepTo: 300, decay: 0.1, peak: 0.5 });
  b.click(t, 2000, 0.006, 0.5);
  b.noise(t + 0.006, { color: 'pink', filter: 'bandpass', freq: 900, q: 1, decay: 0.05, peak: 0.25, pan: -0.6 });
  b.noise(t + 0.01, { color: 'pink', filter: 'bandpass', freq: 750, q: 1, decay: 0.05, peak: 0.25, pan: 0.6 });
};

/** The drum indexes (viewmodel: 0.1 s after the shot). */
const launcherMech: Recipe = (g, t) => {
  const k = kitOf(g);
  const at = t + 0.1;
  k.click(at, 3200, 0.005, 0.7, 0.2);
  k.ring(at, 1300 * k.j(0.05), [1, 2.4], 0.05, 0.2, 0.2);
  k.click(at + 0.06, 3800, 0.004, 0.5, 0.2);
  k.tone(at + 0.06, 'sine', 1800, 1500, 0.001, 0.03, 0.06, 0.2);
};

const launcherEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 380, 1100, 0.16, 0.55);
  let at = t + 0.1;
  for (let i = 0; i < 6; i++) {
    k.click(at, 3400 * k.j(0.05), 0.004, 0.5);
    k.ring(at, 1300, [1, 2.3], 0.03, 0.12);
    at += 0.035 + i * 0.008;
  }
  clunk(k, t + 0.45, 180, 900, 0.9);
};

/** A 40 mm round pushed into the drum: slide, hollow thunk, detent. */
const launcherShellIn: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 900 * k.j(0.08), q: 1.5, attack: 0.01, decay: 0.04, peak: 0.6 });
  k.thump(t + 0.03, { f0: 210 * k.j(0.05), f1: 140, pitchTime: 0.01, decay: 0.05, peak: 0.85 });
  k.click(t + 0.03, 2600, 0.006, 0.6);
  k.ring(t + 0.03, 1000 * k.j(0.05), [1, 2.2], 0.06, 0.2);
  k.click(t + 0.11, 4000, 0.003, 0.35);
};

/** Drum wound and latched. */
const launcherWind: Recipe = (g, t) => {
  const k = kitOf(g);
  let at = t;
  for (let i = 0; i < 5; i++) {
    k.click(at, 3600 * k.j(0.05), 0.003, 0.5);
    at += 0.07 - i * 0.01;
  }
  const b = k.bus({ drive: 1.8 });
  clunk(b, t + 0.3, 180, 900, 1.1);
};

// ---------------------------------------------------------------------------
// SX-0 „Ereignishorizont“ – black hole projector
// ---------------------------------------------------------------------------

/** Inhale, then a sub drop with a warped "wom", an FM growl and a thin eerie shimmer. */
const blackholeFire: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 400, sweepTo: 3000, q: 1, attack: 0.12, hold: 0.12, release: 0.02, peak: 0.5, expRise: true });
  const t0 = t + 0.12;
  const b = k.bus({ drive: 1.8, lowpass: 9000 });
  b.click(t0, 5000, 0.003, 0.5);
  b.thump(t0, { f0: 80, f1: 18, pitchTime: 0.25, decay: 0.8, peak: 1, drive: 2 });
  b.note(t0, 'sine', 110, 40, 0.005, 0.4, 0.3, 0.5, { vibrato: { rate: 7, depth: 6 } });
  b.fm(t0, 70, 1.5, 4, 0.004, 0.6, 0.35, 0, 30);
  b.noise(t0, { color: 'brown', filter: 'lowpass', freq: 400, sweepTo: 60, attack: 0.004, decay: 0.7, peak: 0.8 });
  k.ringMod(t0 + 0.02, 1200, 330, 0.01, 0.5, 0.12, { carrierTo: 400, modTo: 90, pan: -0.3 });
  k.ringMod(t0 + 0.05, 900, 250, 0.01, 0.45, 0.09, { carrierTo: 300, modTo: 70, pan: 0.3 });
};

/** Containment ring spins back up, the hum settles, a clamp. */
const blackholeMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.note(t + 0.1, 'triangle', 180, 540, 0.35, 0.4, 0.2, 0.18, { vibrato: { rate: 9, depth: 8 } });
  k.note(t + 0.05, 'sawtooth', 55, 55, 0.05, 0.4, 0.2, 0.15, { lowpass: 300 });
  k.click(t + 0.52, 3400, 0.005, 0.4, 0.2);
};

const blackholeEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'brown', filter: 'lowpass', freq: 150, sweepTo: 500, attack: 0.5, hold: 0.5, release: 0.2, peak: 0.6, expRise: true });
  k.tone(t + 0.02, 'sine', 300, 1600, 0.5, 0.15, 0.2);
  k.swell(t + 0.1, { color: 'white', filter: 'bandpass', freq: 800, sweepTo: 4000, q: 2, attack: 0.4, hold: 0.4, release: 0.05, peak: 0.15, expRise: true });
  clunk(k, t + 0.6, 170, 1000, 0.9);
};

const blackholeCellOut: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 3600, 0.004, 0.5);
  hiss(k, t + 0.01, 1200, 400, 0.3, 0.5);
  k.noise(t + 0.03, { color: 'brown', filter: 'lowpass', freq: 300, decay: 0.2, peak: 0.5 });
  clunk(k, t + 0.16, 170, 1000, 0.55);
};

const blackholeCellIn: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 800, sweepTo: 1300, q: 1.8, attack: 0.01, decay: 0.05, peak: 0.4 });
  clunk(k, t + 0.08, 160, 900, 1.05);
  k.note(t + 0.1, 'sine', 55, 110, 0.2, 0.25, 0.15, 0.35);
};

const blackholeSpinUp: Recipe = (g, t) => {
  const k = kitOf(g);
  k.note(t, 'triangle', 200, 900, 0.3, 0.3, 0.1, 0.25, { vibrato: { rate: 11, depth: 10 } });
  clunk(k, t + 0.32, 170, 1000, 0.9);
};

// ---------------------------------------------------------------------------
// „Riss-Zerreißer“ – rift ripper (wonder)
// ---------------------------------------------------------------------------

/** Reality tearing: flanged ripping noise, a glitch stutter, a falling ring-mod scream, a void impact. */
const riftFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 2, lowpass: 15000 });
  b.click(t, 6500, 0.002, 1);
  b.noise(t, { color: 'white', filter: 'highpass', freq: 3000, attack: 0.0004, decay: 0.015, peak: 0.8 });
  const tear = k.bus({ comb: { delay: 0.004, sweepTo: 0.0008, sweepTime: 0.3, feedback: 0.72, damp: 7000, wet: 0.9, start: t } });
  tear.noise(t, { color: 'white', filter: 'bandpass', freq: 2500, q: 0.8, attack: 0.005, decay: 0.35, peak: 0.55, pan: -0.2 });
  tear.noise(t + 0.01, { color: 'pink', filter: 'bandpass', freq: 1600, q: 0.8, attack: 0.005, decay: 0.3, peak: 0.45, pan: 0.2 });
  let at = t + 0.02;
  let gap = 0.06;
  for (let i = 0; i < 6; i++) {
    k.noise(at, { color: 'white', filter: 'bandpass', freq: 1800 * k.j(0.2), q: 2, attack: 0.001, decay: 0.012, peak: 0.45 * (1 - i * 0.12), pan: i % 2 ? 0.5 : -0.5 });
    at += gap;
    gap *= 0.76;
  }
  b.ringMod(t, 900, 173, 0.002, 0.4, 0.3, { type: 'sawtooth', carrierTo: 120, modTo: 40 });
  b.thump(t, { f0: 110, f1: 30, pitchTime: 0.06, decay: 0.45, peak: 1, drive: 2.5 });
  b.noise(t, { color: 'brown', filter: 'lowpass', freq: 500, sweepTo: 80, attack: 0.004, decay: 0.5, peak: 0.6 });
};

/** Rift energy settles: a reversed shimmer, a ringing tone, a soft thud. */
const riftMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t + 0.05, { color: 'white', filter: 'bandpass', freq: 5000, q: 3, attack: 0.15, hold: 0.15, release: 0.05, peak: 0.2, expRise: true, pan: 0.2 });
  k.note(t + 0.2, 'sine', 500, 450, 0.01, 0.1, 0.3, 0.12, { vibrato: { rate: 6, depth: 8 } });
  k.thump(t + 0.2, { f0: 120, f1: 60, pitchTime: 0.02, decay: 0.08, peak: 0.4 });
};

const riftEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 600, sweepTo: 4000, q: 1.2, attack: 0.3, hold: 0.3, release: 0.1, peak: 0.45, expRise: true });
  k.ringMod(t + 0.1, 400, 90, 0.2, 0.3, 0.12, { carrierTo: 1200 });
  k.thump(t + 0.32, { f0: 110, f1: 40, pitchTime: 0.04, decay: 0.25, peak: 0.8, drive: 2 });
  clunk(k, t + 0.45, 190, 1100, 0.7);
};

const riftProngs: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ lowpass: 1500 });
  b.note(t, 'sawtooth', 80, 240, 0.15, 0.2, 0.15, 0.35, { vibrato: { rate: 11, depth: 6 } });
  k.fm(t + 0.18, 1800, 2.1, 4, 0.001, 0.08, 0.25, 0, 400);
  k.click(t + 0.18, 5000, 0.003, 0.5);
};

// ---------------------------------------------------------------------------
// „Äther-Harfe“ – aether harp (wonder)
// ---------------------------------------------------------------------------

/** One chord per variant, walking D minor: i add9, VI maj7, III add9, v sus – full auto plays a line. */
const HARP_CHORDS: readonly (readonly number[])[] = [
  [62, 65, 69, 76],
  [58, 62, 65, 69],
  [53, 60, 67, 69],
  [57, 60, 64, 71],
];

function harpFire(chord: readonly number[]): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const n = chord.length;
    for (let i = 0; i < n; i++) {
      const f = midi(chord[i]!);
      const at = t + i * 0.014 * k.j(0.2);
      const pan = n > 1 ? -0.5 + i / (n - 1) : 0;
      k.pluck(at, f, 0.9, 0.28, pan, 0.75);
      k.pluck(at + 0.003, f * 2, 0.4, 0.06, -pan, 0.6);
    }
    k.click(t, 6000, 0.002, 0.6);
    k.fm(t, 2400, 2, 3, 0.001, 0.05, 0.2, 0, 600);
    k.crackle(t, 0.08, 120, 7000, 3, 0.1, 0.6);
    k.thump(t, { f0: 90, f1: 55, pitchTime: 0.03, decay: 0.12, peak: 0.5 });
  };
}

const HARP_FIRE_SECONDS = 1;

/**
 * The bank renders variant v at t = v × (duration + AUDIO.synth.variantGap) of one offline pass,
 * so the variant index picks its chord: every variant is a different chord of the progression.
 */
const harpProgression: Recipe = (g, t) => {
  const v = Math.round(t / (HARP_FIRE_SECONDS + AUDIO.synth.variantGap));
  harpFire(HARP_CHORDS[v % HARP_CHORDS.length]!)(g, t);
};

/** Strings hum sympathetically after a shot. */
const harpMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.note(t + 0.02, 'sine', midi(62), midi(62), 0.02, 0.05, 0.3, 0.06, { pan: -0.3 });
  k.note(t + 0.02, 'sine', midi(69), midi(69), 0.02, 0.05, 0.3, 0.05, { pan: 0.3 });
  k.click(t + 0.01, 7000, 0.002, 0.2);
};

/** Glissando up a D dorian scale over a resonator hum. */
const harpEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  const scale = [62, 64, 65, 67, 69, 71, 72, 74];
  scale.forEach((note, i) => k.pluck(t + 0.05 + i * 0.045, midi(note), 0.6, 0.18, -0.6 + (1.2 * i) / (scale.length - 1), 0.7));
  k.note(t, 'triangle', midi(50), midi(50), 0.2, 0.3, 0.3, 0.1);
  k.click(t + 0.5, 4000, 0.004, 0.4);
};

const harpCellOut: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bell(t, 1760, 0.4, 0.2);
  hiss(k, t + 0.02, 5000, 2500, 0.15, 0.3);
  clunk(k, t + 0.12, 220, 1300, 0.55);
};

const harpCellIn: Recipe = (g, t) => {
  const k = kitOf(g);
  clunk(k, t + 0.04, 230, 1400, 0.95);
  k.note(t + 0.08, 'sine', 220, 440, 0.15, 0.2, 0.2, 0.15);
  k.bell(t + 0.25, 1760, 0.35, 0.14);
};

/** Strings tuned: a fast downward strum across all of them. */
const harpStrum: Recipe = (g, t) => {
  const k = kitOf(g);
  const notes = [74, 69, 65, 62, 57, 50];
  notes.forEach((note, i) => k.pluck(t + i * 0.02, midi(note), 0.8, 0.2, 0.5 - (i / (notes.length - 1)) * 1, 0.8));
};

// ---------------------------------------------------------------------------
// „Kryo-Nova“ – cryo nova (wonder)
// ---------------------------------------------------------------------------

/** Glassy ping: a short sine with a faint inharmonic partial. */
export function icePing(k: Kit, t: number, f: number, decay: number, peak: number, pan = 0): void {
  k.tone(t, 'sine', f, f * 0.998, 0.0008, decay, peak, pan);
  k.tone(t, 'sine', f * 2.76, f * 2.75, 0.0008, decay * 0.4, peak * 0.25, pan);
}

/** A cascade of glassy pings over `span` s (frequencies log-random in [lo, hi]). */
export function iceCascade(k: Kit, t: number, count: number, span: number, lo: number, hi: number, peak: number): void {
  for (let i = 0; i < count; i++) {
    const at = t + Math.pow(k.rng.next(), 1.6) * span;
    const f = lo * Math.pow(hi / lo, k.rng.next());
    const fade = 1 - (at - t) / (span * 1.4);
    icePing(k, at, f, k.r(0.06, 0.22), peak * fade * k.r(0.4, 1), k.rng.next() * 1.4 - 0.7);
  }
}

const cryoFire: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ drive: 1.5, lowpass: 16000 });
  b.click(t, 7000, 0.002, 0.7);
  b.thump(t, { f0: 130, f1: 50, pitchTime: 0.04, decay: 0.2, peak: 0.9, drive: 1.5 });
  b.noise(t, { color: 'pink', filter: 'lowpass', freq: 1500, sweepTo: 400, decay: 0.12, peak: 0.6 });
  k.noise(t + 0.003, { color: 'white', filter: 'bandpass', freq: 7000, sweepTo: 3500, q: 1.2, attack: 0.002, decay: 0.3, peak: 0.5 });
  iceCascade(k, t + 0.005, 14, 0.35, 2500, 9000, 0.3);
  k.bell(t + 0.01, 1318, 0.6, 0.22, -0.2);
  k.bell(t + 0.03, 1975, 0.5, 0.14, 0.2);
  k.ticks(t + 0.01, 8, 0.25, 4500, 6, 0.35, 0.4);
};

const cryoMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t + 0.04, { color: 'white', filter: 'highpass', freq: 4000, attack: 0.01, hold: 0.08, release: 0.25, peak: 0.45, pan: 0.25 });
  k.ticks(t + 0.06, 5, 0.3, 6000, 7, 0.22, 0.3);
  k.bell(t + 0.1, 2637, 0.2, 0.06);
};

const cryoEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 500, 1400, 0.12, 0.45);
  k.swell(t + 0.08, { color: 'white', filter: 'highpass', freq: 3500, attack: 0.05, hold: 0.15, release: 0.2, peak: 0.35 });
  k.bell(t + 0.2, 1568, 0.5, 0.2, -0.2);
  k.bell(t + 0.26, 2349, 0.45, 0.14, 0.2);
  clunk(k, t + 0.45, 210, 1400, 0.8);
};

const cryoCanisterOut: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 3800, 0.004, 0.5);
  hiss(k, t + 0.01, 6000, 3000, 0.3, 0.55);
  clunk(k, t + 0.15, 200, 1300, 0.6);
  k.ticks(t + 0.05, 4, 0.2, 6500, 7, 0.18);
};

const cryoCanisterIn: Recipe = (g, t) => {
  const k = kitOf(g);
  clunk(k.bus({ drive: 1.5 }), t + 0.04, 210, 1300, 1.05);
  k.swell(t + 0.08, { color: 'white', filter: 'highpass', freq: 4500, attack: 0.02, hold: 0.06, release: 0.15, peak: 0.3 });
  k.bell(t + 0.2, 2093, 0.35, 0.14);
};

/** Fins deploy: a metallic "shing" and an icy chime. */
const cryoFins: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 6000, sweepTo: 9000, q: 5, attack: 0.005, decay: 0.15, peak: 0.45 });
  k.ring(t, 3400 * k.j(0.03), [1, 1.5, 2.2], 0.25, 0.25);
  k.bell(t + 0.08, 2637, 0.35, 0.14);
};

// ---------------------------------------------------------------------------
// RX-6 „Kreissäge“ – minigun spin loop
// ---------------------------------------------------------------------------

/** Motor whine with gear harmonics, barrels whooshing past (flutter), rumble, gear rattle. */
const minigunSpin: Recipe = (g, t) => {
  const k = kitOf(g);
  const tonal = k.loopBus(t);
  tonal.drone(t, LD, 240, 0.18, { type: 'sawtooth', lowpass: 1800, detune: 12 });
  tonal.drone(t, LD, 960, 0.06);
  tonal.drone(t, LD, 1440, 0.03);
  k.bed(t, LD, 'pink', 'bandpass', 1100, 1.5, 0.6, { gainLfo: { rate: 36, depth: 0.8 } });
  k.bed(t, LD, 'brown', 'lowpass', 150, 0.7, 0.4, { gainLfo: { rate: 18, depth: 0.3 } });
  k.crackle(t, LD, 60, 3500, 4, 0.12, 0.5);
  k.bed(t, LD, 'white', 'highpass', 5000, 0.7, 0.03);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function fire(duration: number, recipe: Recipe, variants: number = FV, level = 1): SynthDef {
  return { variants, duration, channels: 2, level, recipe };
}

function mech(duration: number, recipe: Recipe, level = 0.6): SynthDef {
  return { variants: 2, duration, channels: 2, level, recipe };
}

function step(duration: number, recipe: Recipe, level = 0.85): SynthDef {
  return { variants: 1, duration, channels: 1, level, recipe };
}

function loop(recipe: Recipe, level = 0.85): SynthDef {
  return { variants: 1, duration: LD, channels: 2, level, loop: true, recipe };
}

export const ENERGY_WEAPON_SYNTH_DEFS = {
  // --- PL-2 „Sonnenwind“ ---
  'weapon.plasma.fire': fire(0.4, plasmaFire),
  'weapon.plasma.mech': mech(0.25, plasmaMech, 0.45),
  'weapon.plasma.equip': step(0.6, plasmaEquip, 0.72),
  'weapon.plasma.magOut': step(0.4, cellOut({ seat: 200, ring: 1200, hissFrom: 3500, hissTo: 1500, blip: 900 })),
  'weapon.plasma.magIn': step(0.4, cellIn({ seat: 210, ring: 1300, chirp: 700 }), 0.9),
  'weapon.plasma.boltRelease': step(0.6, plasmaVent, 0.8),
  // --- EX-1 „Kettenblitz“ ---
  'weapon.chainlightning.fire': fire(0.55, lightningStrike, SV),
  'weapon.chainlightning.mech': mech(0.5, lightningRelease, 0.6),
  'weapon.chainlightning.loop': loop(lightningLoop, 0.8),
  'weapon.chainlightning.equip': step(0.65, lightningEquip, 0.72),
  'weapon.chainlightning.magOut': step(0.42, cellOut({ seat: 190, ring: 1100, hissFrom: 3000, hissTo: 1400, blip: 700 })),
  'weapon.chainlightning.magIn': step(0.45, cellIn({ seat: 200, ring: 1200, chirp: 600, hum: 100 }), 0.9),
  'weapon.chainlightning.boltRelease': step(0.35, lightningProngs, 0.85),
  // --- RG-9 „Lanze“ ---
  'weapon.railgun.fire': fire(1.1, railFire, SV),
  'weapon.railgun.mech': mech(0.7, railMech, 0.55),
  'weapon.railgun.charge': loop(railCharge, 0.8),
  'weapon.railgun.equip': step(0.85, railEquip, 0.75),
  'weapon.railgun.magOut': step(0.42, cellOut({ seat: 180, ring: 1000, hissFrom: 3000, hissTo: 1200, blip: 700 })),
  'weapon.railgun.magIn': step(0.45, cellIn({ seat: 190, ring: 1100, chirp: 1000, hum: 55 }), 0.9),
  'weapon.railgun.boltRelease': step(0.45, railLock, 0.95),
  // --- FW-4 „Inferno“ ---
  'weapon.flamethrower.fire': fire(0.6, flameIgnite, 2),
  'weapon.flamethrower.mech': mech(0.45, flameStop, 0.55),
  'weapon.flamethrower.loop': loop(flameLoop, 0.85),
  'weapon.flamethrower.equip': step(0.7, flameEquip, 0.72),
  'weapon.flamethrower.magOut': step(0.45, flameTankOff),
  'weapon.flamethrower.magIn': step(0.45, flameTankOn, 0.9),
  'weapon.flamethrower.boltRelease': step(0.45, flamePilot, 0.8),
  // --- GL-6 „Donnerkeil“ ---
  'weapon.grenadelauncher.fire': fire(0.5, launcherFire, SV),
  'weapon.grenadelauncher.mech': mech(0.25, launcherMech, 0.55),
  'weapon.grenadelauncher.equip': step(0.65, launcherEquip, 0.75),
  'weapon.grenadelauncher.shellIn': { variants: 3, duration: 0.2, channels: 1, level: 0.85, recipe: launcherShellIn },
  'weapon.grenadelauncher.pump': step(0.5, launcherWind, 0.95),
  // --- SX-0 „Ereignishorizont“ ---
  'weapon.blackhole.fire': fire(1.3, blackholeFire, SV),
  'weapon.blackhole.mech': mech(0.65, blackholeMech, 0.5),
  'weapon.blackhole.equip': step(0.85, blackholeEquip, 0.75),
  'weapon.blackhole.magOut': step(0.45, blackholeCellOut),
  'weapon.blackhole.magIn': step(0.5, blackholeCellIn, 0.9),
  'weapon.blackhole.boltRelease': step(0.5, blackholeSpinUp, 0.85),
  // --- „Riss-Zerreißer“ ---
  'weapon.riftripper.fire': fire(0.8, riftFire, SV),
  'weapon.riftripper.mech': mech(0.5, riftMech, 0.5),
  'weapon.riftripper.equip': step(0.7, riftEquip, 0.75),
  'weapon.riftripper.magOut': step(0.42, blackholeCellOut),
  'weapon.riftripper.magIn': step(0.45, cellIn({ seat: 170, ring: 900, chirp: 450, hum: 55 }), 0.9),
  'weapon.riftripper.boltRelease': step(0.45, riftProngs, 0.85),
  // --- „Äther-Harfe“: one variant per chord ---
  'weapon.aetherharp.fire': fire(HARP_FIRE_SECONDS, harpProgression, HARP_CHORDS.length, 0.9),
  'weapon.aetherharp.mech': mech(0.4, harpMech, 0.35),
  'weapon.aetherharp.equip': step(0.9, harpEquip, 0.7),
  'weapon.aetherharp.magOut': step(0.45, harpCellOut, 0.8),
  'weapon.aetherharp.magIn': step(0.5, harpCellIn, 0.85),
  'weapon.aetherharp.boltRelease': step(0.9, harpStrum, 0.8),
  // --- „Kryo-Nova“ ---
  'weapon.cryonova.fire': fire(0.9, cryoFire, SV),
  'weapon.cryonova.mech': mech(0.45, cryoMech, 0.45),
  'weapon.cryonova.equip': step(0.8, cryoEquip, 0.72),
  'weapon.cryonova.magOut': step(0.45, cryoCanisterOut),
  'weapon.cryonova.magIn': step(0.4, cryoCanisterIn, 0.9),
  'weapon.cryonova.boltRelease': step(0.45, cryoFins, 0.85),
  // --- RX-6 „Kreissäge“ spin loop ---
  'weapon.minigun.spin': loop(minigunSpin, 0.8),
} as const satisfies Record<string, SynthDef>;

