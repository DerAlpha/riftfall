/**
 * Procedural gear sounds of M5 (merged into the bank by arsenalSynth.ts): grenades (pin, throw,
 * bounce), abilities (`ability.<abilityId>` for Schockwelle / Phasenbarriere / Überladung /
 * Chronofeld, a generic activation, the ready cue and the power-down), the Rift Forge (upgrade
 * sequence, denial), the Werkbank (menu open/close, attachment fitted) and element modules.
 *
 * The player's own gear is 2D (stereo); a bouncing grenade is positional (mono). The forge upgrade
 * is one ~3 s sequence for the whole machine cycle: furnace roar building, three anvil strikes
 * (0.55 / 1.05 / 1.55 s), then a rift choir chord blooming at ~2 s (peak ~2.2 s) over a sub impact.
 * Frequencies, levels and times inside the recipes are sound-design constants.
 */
import { AUDIO } from '../defs/audio';
import { kitOf, midi, type Kit, type Recipe } from './arsenalKit';
import type { SynthDef } from './synth';

function clunk(k: Kit, t: number, seat: number, ring: number, peak = 1, pan = 0): void {
  k.click(t, 2600 + ring, 0.007, 0.8 * peak, pan);
  k.thump(t, { f0: seat * k.j(0.05), f1: seat * 0.6, pitchTime: 0.012, decay: 0.05, peak: 0.85 * peak });
  k.ring(t, ring * k.j(0.05), [1, 2.3, 3.8], 0.08, 0.3 * peak, pan);
}

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

/** Pin pulled (scrape + tink), the spoon flicks off with a ping. */
const grenadePin: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3500 * k.j(0.05), sweepTo: 5000, q: 3, attack: 0.01, decay: 0.04, peak: 0.4, pan: 0.2 });
  k.ring(t + 0.05, 4200 * k.j(0.04), [1, 2.4, 3.9], 0.12, 0.3, 0.2);
  k.tone(t + 0.05, 'sine', 1800, 1600, 0.001, 0.08, 0.08, 0.2);
  k.click(t + 0.12, 5500, 0.003, 0.5, 0.3);
  k.ring(t + 0.12, 3100 * k.j(0.04), [1, 2.7], 0.1, 0.2, 0.3);
};

/** Arm swing: a rising whoosh, a thinner air layer, the release. */
const grenadeThrow: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 350, sweepTo: 1800 * k.j(0.08), q: 1.2, attack: 0.09, decay: 0.15, peak: 0.8, pan: 0.2 });
  k.noise(t + 0.02, { color: 'white', filter: 'bandpass', freq: 1200, sweepTo: 3000, q: 2, attack: 0.08, decay: 0.12, peak: 0.3, pan: 0.3 });
  k.ticks(t + 0.01, 3, 0.1, 2200, 4, 0.15);
  k.noise(t + 0.12, { color: 'pink', filter: 'bandpass', freq: 2500, q: 1.5, decay: 0.04, peak: 0.3, pan: 0.4 });
};

/** A grenade (or any bouncing round) hits a surface: a heavy clunk, rattle, scrape. */
const grenadeBounce: Recipe = (g, t) => {
  const k = kitOf(g);
  k.thump(t, { f0: 240 * k.j(0.08), f1: 140, pitchTime: 0.01, decay: 0.05, peak: 0.9 });
  k.click(t, 3000, 0.006, 0.6);
  k.ring(t, 950 * k.j(0.08), [1, 2.4, 3.9], 0.12, 0.25);
  k.ticks(t + 0.01, 3, 0.08, 3800, 6, 0.25);
  k.noise(t + 0.005, { color: 'pink', filter: 'bandpass', freq: 1500, q: 1.5, decay: 0.05, peak: 0.3 });
};

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

/** Schockwelle: a short charge-up, then a radial shock blast rolling outwards. */
const abilityShockwave: Recipe = (g, t) => {
  const k = kitOf(g);
  const b0 = k.bus({ lowpass: 3000 });
  b0.note(t, 'sawtooth', 180, 900, 0.12, 0.12, 0.01, 0.25, { expRise: true });
  const t0 = t + 0.12;
  const b = k.bus({ drive: 2.2, lowpass: 14000 });
  b.click(t0, 6000, 0.003, 1);
  b.thump(t0, { f0: 110, f1: 30, pitchTime: 0.08, decay: 0.5, peak: 1, drive: 2.2 });
  b.fm(t0, 2500, 2.3, 7, 0.001, 0.3, 0.4, 0, 150);
  for (const pan of [-0.7, 0.7]) {
    k.noise(t0 + 0.01, { color: 'white', filter: 'bandpass', freq: 3000, sweepTo: 500, q: 1.2, attack: 0.01, decay: 0.6, peak: 0.5, pan });
  }
  k.ticks(t0, 50, 0.8, 4200, 4, 0.4, 0.8);
  k.ringMod(t0, 180, 57, 0.005, 0.4, 0.25, { type: 'sawtooth', carrierTo: 80 });
};

/** Phasenbarriere: a phaser sweep rising into a resonant hum and a glassy "shing". */
const abilityBarrier: Recipe = (g, t) => {
  const k = kitOf(g);
  const ph = k.bus({ comb: { delay: 0.006, sweepTo: 0.0012, sweepTime: 0.35, feedback: 0.7, damp: 8000, wet: 0.8, start: t } });
  ph.swell(t, { color: 'pink', filter: 'bandpass', freq: 800, sweepTo: 3000, q: 0.8, attack: 0.3, hold: 0.3, release: 0.3, peak: 0.5 });
  const hum = k.bus({ lowpass: 900 });
  hum.note(t + 0.1, 'sawtooth', 110, 110, 0.15, 0.6, 0.3, 0.2);
  k.note(t + 0.1, 'sine', 440, 440, 0.15, 0.6, 0.3, 0.08, { pan: -0.4 });
  k.note(t + 0.1, 'sine', 441.5, 441.5, 0.15, 0.6, 0.3, 0.08, { pan: 0.4 });
  k.bell(t + 0.3, 1760, 0.6, 0.25);
  k.noise(t + 0.3, { color: 'white', filter: 'bandpass', freq: 7000, q: 4, decay: 0.2, peak: 0.2 });
};

/** Überladung: two heartbeats, a power surge rising, crackle, a final zap. */
const abilityOverdrive: Recipe = (g, t) => {
  const k = kitOf(g);
  for (const at of [0, 0.28]) k.thump(t + at, { f0: 60, f1: 40, pitchTime: 0.04, decay: 0.12, peak: 0.9, drive: 1.5 });
  const b = k.bus({ lowpass: 2500 });
  b.note(t + 0.05, 'sawtooth', 110, 440, 0.5, 0.6, 0.2, 0.3, { expRise: true });
  k.crackle(t + 0.3, 0.5, 60, 4500, 3, 0.35, 0.7);
  k.swell(t + 0.1, { color: 'white', filter: 'highpass', freq: 2000, attack: 0.4, hold: 0.5, release: 0.2, peak: 0.25 });
  k.fm(t + 0.6, 3000, 2.1, 5, 0.001, 0.1, 0.3, 0, 800);
};

/** Chronofeld: a reversed whoosh into a deep "whoom", the clock ticking slower and slower. */
const abilityChrono: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 400, sweepTo: 3000, q: 1, attack: 0.35, hold: 0.35, release: 0.02, peak: 0.5, expRise: true });
  const t0 = t + 0.36;
  k.thump(t0, { f0: 70, f1: 25, pitchTime: 0.3, decay: 0.8, peak: 1, drive: 1.5 });
  k.note(t0, 'sine', 220, 55, 0.01, 0.7, 0.3, 0.3);
  const ticks = [0.1, 0.4, 0.8, 1.3];
  ticks.forEach((dt, i) => {
    const s = 1 - i * 0.15;
    k.click(t0 + dt, 2600 * s, 0.008, 0.6 * s);
    k.thump(t0 + dt, { f0: 420 * s, f1: 300 * s, pitchTime: 0.01, decay: 0.03, peak: 0.35 * s });
  });
  k.ringMod(t0, 1400, 3, 0.05, 0.8, 0.08, { carrierTo: 700, pan: 0.3 });
};

/** Unknown abilities: a generic activation. */
const abilityGeneric: Recipe = (g, t) => {
  const k = kitOf(g);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 600, sweepTo: 3000, q: 1, attack: 0.12, hold: 0.12, release: 0.02, peak: 0.35, expRise: true });
  k.fm(t + 0.12, 1800, 2.1, 4, 0.001, 0.12, 0.3, 0, 400);
  k.thump(t + 0.12, { f0: 110, f1: 45, pitchTime: 0.04, decay: 0.25, peak: 0.8, drive: 1.5 });
};

/** Cooldown over: a rising two-tone chime over a soft energy swell. */
const abilityReady: Recipe = (g, t) => {
  const k = kitOf(g);
  k.bell(t, 1318, 0.35, 0.3, -0.15);
  k.bell(t + 0.09, 1975, 0.45, 0.35, 0.15);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 3000, q: 2, attack: 0.08, hold: 0.05, release: 0.2, peak: 0.08 });
};

/** A timed ability ends: a falling power-down. */
const abilityEnd: Recipe = (g, t) => {
  const k = kitOf(g);
  const b = k.bus({ lowpass: 1800 });
  b.note(t, 'sawtooth', 440, 110, 0.01, 0.3, 0.2, 0.2);
  k.swell(t, { color: 'white', filter: 'bandpass', freq: 3000, sweepTo: 800, q: 1.5, attack: 0.02, hold: 0.2, release: 0.2, peak: 0.12 });
  k.thump(t + 0.3, { f0: 110, f1: 60, pitchTime: 0.03, decay: 0.1, peak: 0.4 });
};

// ---------------------------------------------------------------------------
// Rift Forge, Werkbank, element modules
// ---------------------------------------------------------------------------

/** Hammer on anvil: a bright strike and a long, singing inharmonic ring. */
function anvil(k: Kit, t: number, pitch: number, peak: number): void {
  const b = k.bus({ drive: 1.8 });
  b.click(t, 4000, 0.004, peak);
  b.thump(t, { f0: 300 * pitch, f1: 160 * pitch, pitchTime: 0.01, decay: 0.08, peak: 0.9 * peak });
  k.ring(t, 1250 * pitch * k.j(0.02), [1, 2.76, 5.4, 8.93], 1.2, 0.4 * peak, -0.1);
  k.ring(t + 0.002, 1880 * pitch * k.j(0.02), [1, 2.41, 3.9], 0.8, 0.18 * peak, 0.15);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 3000, q: 1, decay: 0.05, peak: 0.5 * peak });
}

const forgeUpgrade: Recipe = (g, t) => {
  const k = kitOf(g);
  // Furnace roar building, a rift whine climbing, the fire crackling.
  k.swell(t, { color: 'brown', filter: 'lowpass', freq: 200, sweepTo: 1400, attack: 1.2, hold: 1.2, release: 0.5, peak: 0.7, expRise: true });
  const whine = k.bus({ lowpass: 1500 });
  whine.note(t, 'sawtooth', 55, 220, 1.2, 1.3, 0.3, 0.25, { vibrato: { rate: 5, depth: 1.5 } });
  k.crackle(t + 0.3, 1.5, 35, 2400, 2, 0.3, 0.6, 0.4);
  // Three anvil strikes, each a little higher.
  anvil(k, t + 0.55, 1, 0.9);
  anvil(k, t + 1.05, 1.06, 0.95);
  anvil(k, t + 1.55, 1.12, 1);
  // Rift choir: a major chord blooming over a sub impact and a bright bell.
  const t2 = t + 2;
  k.thump(t2, { f0: 80, f1: 30, pitchTime: 0.12, decay: 0.8, peak: 0.9, drive: 1.5 });
  k.choir(t2, [midi(60), midi(64), midi(67), midi(72)], 0.25, 0.9, 0.6, 0.55);
  k.bell(t2 + 0.15, 2093, 1.2, 0.25, 0.2);
  k.swell(t2, { color: 'white', filter: 'bandpass', freq: 6000, sweepTo: 1500, q: 1.5, attack: 0.02, hold: 0.1, release: 0.6, peak: 0.3 });
};

/** The machine refuses: a detuned buzz, a heavy clunk, a puff of steam. */
const forgeDeny: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'square', 73, 70, 0.005, 0.3, 0.25, -0.2, 900);
  k.tone(t, 'square', 77.8, 74, 0.005, 0.3, 0.25, 0.2, 900);
  k.thump(t, { f0: 120, f1: 70, pitchTime: 0.02, decay: 0.12, peak: 0.9, drive: 1.5 });
  k.click(t, 2600, 0.008, 0.6);
  k.ring(t, 600 * k.j(0.04), [1, 2.3, 3.7], 0.25, 0.3);
  k.swell(t + 0.15, { color: 'white', filter: 'highpass', freq: 2500, attack: 0.01, hold: 0.05, release: 0.25, peak: 0.3 });
};

/** Bench menu opens: a tool drawer slides, stops; a rising UI chirp. */
const benchOpen: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1500, sweepTo: 2200, q: 2, attack: 0.05, decay: 0.15, peak: 0.4, pan: -0.2 });
  k.click(t + 0.18, 3800, 0.005, 0.5);
  k.ring(t + 0.18, 2000, [1, 2.4], 0.05, 0.15);
  k.tone(t + 0.2, 'sine', 1200, 1200, 0.001, 0.05, 0.15, -0.1);
  k.tone(t + 0.26, 'sine', 1800, 1800, 0.001, 0.05, 0.15, 0.1);
};

const benchClose: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sine', 1800, 1800, 0.001, 0.05, 0.14, 0.1);
  k.tone(t + 0.06, 'sine', 1200, 1200, 0.001, 0.05, 0.14, -0.1);
  k.noise(t + 0.08, { color: 'pink', filter: 'bandpass', freq: 2200, sweepTo: 1500, q: 2, attack: 0.04, decay: 0.1, peak: 0.35, pan: -0.2 });
  clunk(k, t + 0.2, 240, 1600, 0.55);
};

/** An attachment slides onto its rail and locks: scrape, "ch-chk", a screw tightened. */
const benchAttach: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'white', filter: 'bandpass', freq: 2800 * k.j(0.05), sweepTo: 3600, q: 3, attack: 0.02, decay: 0.06, peak: 0.45 });
  k.click(t + 0.07, 4200, 0.004, 0.8);
  k.click(t + 0.11, 3000, 0.006, 0.9);
  k.thump(t + 0.11, { f0: 330, f1: 220, pitchTime: 0.01, decay: 0.03, peak: 0.5 });
  k.ring(t + 0.11, 2500 * k.j(0.04), [1, 2.5, 4.1], 0.08, 0.25);
  k.ticks(t + 0.16, 3, 0.1, 5000, 7, 0.25);
};

/** Element module seated: a clunk, then energy infusing – rising shimmer, hum, sparkle, a chime. */
const elementInstall: Recipe = (g, t) => {
  const k = kitOf(g);
  clunk(k.bus({ drive: 1.5 }), t, 180, 1300, 1);
  k.swell(t + 0.05, { color: 'white', filter: 'bandpass', freq: 800, sweepTo: 6000, q: 2, attack: 0.5, hold: 0.5, release: 0.3, peak: 0.35 });
  const hum = k.bus({ lowpass: 1200 });
  hum.note(t + 0.05, 'sawtooth', 110, 220, 0.4, 0.6, 0.4, 0.18);
  k.crackle(t + 0.2, 0.6, 50, 6000, 3, 0.2, 0.7);
  k.bell(t + 0.6, 1568, 0.8, 0.3, -0.15);
  k.bell(t + 0.62, 2349, 0.7, 0.2, 0.15);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function mono(duration: number, recipe: Recipe, variants = 1, level = 0.85): SynthDef {
  return { variants, duration, channels: 1, level, recipe };
}

function stereo(duration: number, recipe: Recipe, variants = 1, level = 0.85): SynthDef {
  return { variants, duration, channels: 2, level, recipe };
}

export const GEAR_SYNTH_DEFS = {
  'grenade.pin': stereo(0.28, grenadePin, 2, 0.7),
  'grenade.throw': stereo(0.4, grenadeThrow, 2, 0.8),
  'grenade.bounce': mono(0.3, grenadeBounce, 3, 0.85),
  'ability.schockwelle': stereo(1.3, abilityShockwave, 1, 1),
  'ability.phasenbarriere': stereo(1.1, abilityBarrier, 1, 0.9),
  'ability.ueberladung': mono(1.3, abilityOverdrive, 1, 0.9),
  'ability.chronofeld': { ...mono(1.8, abilityChrono, 1, 0.95), rate: AUDIO.synth.darkRate },
  // Centered cues are mono (2D playback puts them in both ears; no memory for a copy).
  'ability.generic': mono(0.8, abilityGeneric, 1, 0.9),
  'ability.ready': stereo(0.6, abilityReady, 1, 0.7),
  'ability.end': mono(0.6, abilityEnd, 1, 0.7),
  'forge.upgrade': stereo(3.4, forgeUpgrade, 1, 1),
  'forge.deny': stereo(0.65, forgeDeny, 1, 0.85),
  'bench.open': stereo(0.4, benchOpen, 1, 0.7),
  'bench.close': stereo(0.4, benchClose, 1, 0.7),
  'bench.attach': mono(0.35, benchAttach, 2, 0.8),
  'element.install': stereo(1.5, elementInstall, 1, 0.9),
} as const satisfies Record<string, SynthDef>;

/** English / alternative ability ids E1 might use → the German convention recipes. */
export const GEAR_SYNTH_ALIASES: Readonly<Record<string, keyof typeof GEAR_SYNTH_DEFS>> = {
  'ability.shockwave': 'ability.schockwelle',
  'ability.phasebarrier': 'ability.phasenbarriere',
  'ability.overcharge': 'ability.ueberladung',
  'ability.overdrive': 'ability.ueberladung',
  'ability.chronofield': 'ability.chronofeld',
};
