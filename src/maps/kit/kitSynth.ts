/**
 * Procedural sounds of the map kit (M7): traps (`trap.<kind>.activate / loop / hit`, the turret's
 * shot), map events (power down / up, the generator alarm, crank and engine, the invasion klaxon,
 * the gravity anomaly) and quest cues (tag hum and chime, step swell, core hum, pickup, socket,
 * defend drone, completion). Same scheme as audio/economySynth.ts: SynthDefs rendered once per
 * sample rate by the procedural bank (synth.ts merges MAPKIT_SYNTH_DEFS into SYNTH_DEFS), overridden
 * by real assets registered under the same ids. Recipes only use `g.ctx` / `g.rng` / the SynthGraph
 * helpers (no runtime import of synth.ts, no cycle).
 *
 * Loops: tonal layers use whole cycles per loop (LOOP seconds → frequencies on a 1/LOOP Hz grid) so
 * the bank's crossfade sums to unity; noise layers stay at a constant level. Frequencies, levels
 * and times inside the recipes are sound-design constants.
 */
import { AUDIO } from '../../defs/audio';
import type { SynthDef, SynthGraph } from '../../audio/synth';

type Recipe = SynthDef['recipe'];

/** Loop body length (s): 2.4 s → a 1/2.4 Hz grid (50, 60, 100, 110, 120, 165 Hz are whole). */
const LOOP = 2.4;
const XF = AUDIO.synth.slideLoopCrossfade;

function out(g: SynthGraph): AudioNode {
  return g.ctx.destination;
}

/** Oscillator with a flat level for `dur` (loops) through an optional filter. */
function drone(
  g: SynthGraph,
  t: number,
  dur: number,
  type: OscillatorType,
  freq: number,
  level: number,
  filter?: { type: BiquadFilterType; freq: number; q?: number },
  am?: { rate: number; depth: number },
): void {
  const ctx = g.ctx;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t);
  o.stop(t + dur);
  let last: AudioNode = o;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.value = filter.freq;
    f.Q.value = filter.q ?? 0.707;
    last.connect(f);
    last = f;
  }
  const gain = ctx.createGain();
  gain.gain.value = level * (am ? 1 - am.depth / 2 : 1);
  if (am) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = am.rate;
    const d = ctx.createGain();
    d.gain.value = (level * am.depth) / 2;
    lfo.connect(d).connect(gain.gain);
    lfo.start(t);
    lfo.stop(t + dur);
  }
  last.connect(gain).connect(out(g));
}

/** Short random crackles over `dur` (electric arcs). */
function crackles(g: SynthGraph, t: number, dur: number, count: number, peak: number): void {
  for (let i = 0; i < count; i++) {
    const at = t + g.rng.next() * Math.max(0, dur - 0.06);
    g.hit(at, {
      color: 'white',
      filter: 'bandpass',
      freq: 2500 + g.rng.next() * 4000,
      q: 1.2,
      decay: 0.01 + g.rng.next() * 0.03,
      peak: peak * (0.4 + g.rng.next() * 0.6),
    });
  }
}

// ---------------------------------------------------------------------------
// Traps
// ---------------------------------------------------------------------------

const fenceActivate: Recipe = (g, t) => {
  g.thump(t, 140, 45, 0.18, 0.7, 1.2);
  g.hit(t, { color: 'white', filter: 'highpass', freq: 2600, decay: 0.28, peak: 0.55 });
  g.tone(t + 0.05, 'sawtooth', 180, 1500, 0.4, 0.5, 0.22, 3200);
  crackles(g, t + 0.1, 0.9, 14, 0.6);
  g.ring(t, 520, [1, 2.2, 3.7], 0.5, 0.12);
};

const fenceLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  drone(g, t, dur, 'sine', 60, 0.28);
  drone(g, t, dur, 'sine', 120, 0.16);
  drone(g, t, dur, 'square', 120, 0.05, { type: 'bandpass', freq: 1400, q: 1.5 }, { rate: 5, depth: 0.5 });
  g.bed(t, dur, 'white', 'highpass', 3000, 0.7, 0.03);
  crackles(g, t, dur, 22, 0.45);
};

const fenceHit: Recipe = (g, t) => {
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 3600 * g.jitter(0.1), q: 0.9, decay: 0.12, peak: 0.9 });
  g.tone(t, 'square', 1100 * g.jitter(0.1), 180, 0.002, 0.14, 0.18, 4000);
  g.thump(t, 200, 70, 0.06, 0.35, 0.8);
  crackles(g, t + 0.02, 0.3, 6, 0.6);
};

const turretActivate: Recipe = (g, t) => {
  g.tone(t, 'sawtooth', 110, 520, 0.05, 0.7, 0.2, 1800);
  for (const at of [0.15, 0.42, 0.7]) {
    g.hit(t + at, { color: 'white', filter: 'bandpass', freq: 2300, q: 2, decay: 0.03, peak: 0.6 });
    g.thump(t + at, 300, 140, 0.04, 0.25);
  }
  g.tone(t + 0.95, 'sine', 1320, 1320, 0.004, 0.08, 0.3);
  g.tone(t + 1.1, 'sine', 1760, 1760, 0.004, 0.1, 0.3);
};

const turretLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  drone(g, t, dur, 'sawtooth', 100, 0.06, { type: 'lowpass', freq: 700 });
  drone(g, t, dur, 'sine', 50, 0.12);
  g.bed(t, dur, 'pink', 'bandpass', 900, 1.1, 0.05);
};

/** Target acquired: a short double chirp. */
const turretHit: Recipe = (g, t) => {
  g.tone(t, 'square', 1500, 1900, 0.003, 0.05, 0.16, 5000);
  g.tone(t + 0.08, 'square', 1900, 2300, 0.003, 0.06, 0.16, 5000);
};

const turretFire: Recipe = (g, t) => {
  g.thump(t, 190 * g.jitter(0.06), 55, 0.07, 0.8, 2);
  g.hit(t, { color: 'white', filter: 'lowpass', freq: 5200, sweepTo: 900, decay: 0.09, peak: 0.85 });
  g.hit(t, { color: 'pink', filter: 'bandpass', freq: 1300, q: 0.8, decay: 0.16, peak: 0.4 });
  g.ring(t, 1900 * g.jitter(0.04), [1, 1.6], 0.06, 0.06);
};

const fanActivate: Recipe = (g, t) => {
  g.thump(t, 90, 40, 0.3, 0.5, 0.6);
  g.tone(t, 'sine', 35, 160, 0.2, 1.6, 0.35);
  g.tone(t, 'sawtooth', 60, 280, 0.2, 1.5, 0.08, 900);
  g.hit(t + 0.1, { color: 'pink', filter: 'bandpass', freq: 300, sweepTo: 900, q: 0.8, attack: 0.5, decay: 1.4, peak: 0.45 });
};

const fanLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  // Blade pass (7 rev/s × 6 blades ≈ 41.7 Hz: 100 cycles per loop) under a whoosh.
  drone(g, t, dur, 'sine', 100, 0.1);
  drone(g, t, dur, 'sine', 41.666666, 0.14);
  g.bed(t, dur, 'pink', 'bandpass', 420, 0.8, 0.32);
  g.bed(t, dur, 'brown', 'lowpass', 160, 0.7, 0.3);
  g.bed(t, dur, 'white', 'highpass', 2500, 0.7, 0.025);
};

const fanHit: Recipe = (g, t) => {
  g.thump(t, 110, 40, 0.12, 0.7, 2.5);
  g.hit(t, { color: 'brown', filter: 'lowpass', freq: 380, decay: 0.3, peak: 0.8 });
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 1600 * g.jitter(0.15), q: 1.2, decay: 0.18, peak: 0.55 });
  g.hit(t + 0.05, { color: 'pink', filter: 'bandpass', freq: 700, q: 1, decay: 0.25, peak: 0.4 });
  g.ring(t, 360 * g.jitter(0.1), [1, 2.7, 4.1], 0.25, 0.1);
};

const flameActivate: Recipe = (g, t) => {
  g.thump(t, 70, 30, 0.35, 0.6, 1);
  g.hit(t, { color: 'white', filter: 'lowpass', freq: 400, sweepTo: 3200, attack: 0.08, decay: 0.7, peak: 0.9 });
  g.hit(t + 0.05, { color: 'brown', filter: 'lowpass', freq: 250, decay: 0.8, peak: 0.6 });
};

const flameLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  g.bed(t, dur, 'brown', 'lowpass', 520, 0.7, 0.55);
  g.bed(t, dur, 'pink', 'bandpass', 950, 0.8, 0.22);
  g.bed(t, dur, 'white', 'highpass', 3500, 0.7, 0.03);
  crackles(g, t, dur, 16, 0.25);
};

const flameHit: Recipe = (g, t) => {
  g.hit(t, { color: 'white', filter: 'highpass', freq: 3800, attack: 0.02, decay: 0.35, peak: 0.5 });
  crackles(g, t, 0.35, 5, 0.35);
};

// ---------------------------------------------------------------------------
// Map events
// ---------------------------------------------------------------------------

const powerDown: Recipe = (g, t) => {
  g.thump(t, 90, 28, 0.6, 1, 2);
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 1800, q: 1, decay: 0.08, peak: 0.8 });
  g.tone(t + 0.05, 'sawtooth', 240, 30, 0.02, 2.1, 0.3, 1400);
  g.tone(t + 0.05, 'sine', 120, 25, 0.02, 2.2, 0.35);
  crackles(g, t + 0.1, 0.8, 10, 0.5);
  g.ring(t, 180, [1, 2.4, 3.9], 1.2, 0.12);
};

const powerUp: Recipe = (g, t) => {
  g.tone(t, 'sawtooth', 30, 240, 0.9, 0.9, 0.22, 1500);
  g.tone(t, 'sine', 25, 120, 0.9, 1.0, 0.3);
  g.thump(t + 0.9, 150, 50, 0.3, 0.8, 1.4);
  g.hit(t + 0.9, { color: 'white', filter: 'bandpass', freq: 2200, q: 1, decay: 0.1, peak: 0.6 });
  g.tone(t + 1.0, 'sine', 60, 60, 0.05, 1.0, 0.25);
};

const powerAlarm: Recipe = (g, t) => {
  const dur = LOOP + XF;
  const ctx = g.ctx;
  // Slow two-tone siren: 1.2 s period (two sweeps per loop).
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 620;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1 / 1.2;
  const depth = ctx.createGain();
  depth.gain.value = 170;
  lfo.connect(depth).connect(o.frequency);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 2400;
  const gain = ctx.createGain();
  gain.gain.value = 0.22;
  o.connect(f).connect(gain).connect(out(g));
  o.start(t);
  lfo.start(t);
  o.stop(t + dur);
  lfo.stop(t + dur);
};

const generatorCrank: Recipe = (g, t) => {
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 2000 * g.jitter(0.1), q: 3, decay: 0.03, peak: 0.7 });
  g.thump(t, 240, 110, 0.05, 0.3, 0.6);
  g.hit(t + 0.06, { color: 'white', filter: 'bandpass', freq: 2600, q: 3, decay: 0.025, peak: 0.45 });
  g.ring(t, 640 * g.jitter(0.05), [1, 2.76], 0.2, 0.08);
};

/** Generator engine catching (played at the generator on a restart). */
const generatorHum: Recipe = (g, t) => {
  for (let i = 0; i < 6; i++) g.thump(t + i * (0.2 - i * 0.02), 80 + i * 6, 40, 0.12, 0.5, 1.5);
  g.tone(t + 0.6, 'sawtooth', 40, 100, 0.4, 1.2, 0.18, 600);
  g.hit(t + 0.6, { color: 'brown', filter: 'lowpass', freq: 300, attack: 0.3, decay: 1.2, peak: 0.4 });
};

const invasionAlarm: Recipe = (g, t) => {
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.42;
    g.tone(at, 'square', i === 0 ? 440 : 587, i === 0 ? 440 : 587, 0.01, 0.38, 0.25, 2600);
    g.tone(at, 'sawtooth', i === 0 ? 220 : 293, i === 0 ? 220 : 293, 0.01, 0.38, 0.12, 1800);
  }
  g.thump(t, 70, 40, 0.3, 0.5, 1);
};

const gravityStart: Recipe = (g, t) => {
  g.thump(t, 60, 20, 1.0, 1, 1.5);
  g.hit(t, { color: 'brown', filter: 'lowpass', freq: 200, attack: 0.05, decay: 1.4, peak: 0.8 });
  g.tone(t, 'sine', 900, 180, 0.3, 1.4, 0.12);
  g.hit(t + 0.1, { color: 'pink', filter: 'highpass', freq: 3000, sweepTo: 800, attack: 0.6, decay: 1.2, peak: 0.25 });
  g.ring(t + 0.2, 330, [1, 1.5, 2.25], 1.5, 0.06);
};

const gravityLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  drone(g, t, dur, 'sine', 55, 0.3, undefined, { rate: 1 / LOOP, depth: 0.6 });
  drone(g, t, dur, 'sine', 82.5, 0.12, undefined, { rate: 2 / LOOP, depth: 0.8 });
  drone(g, t, dur, 'triangle', 220, 0.03, { type: 'lowpass', freq: 900 });
  g.bed(t, dur, 'pink', 'highpass', 2200, 0.7, 0.04);
};

const gravityEnd: Recipe = (g, t) => {
  g.tone(t, 'sine', 160, 900, 0.3, 0.6, 0.1);
  g.hit(t, { color: 'pink', filter: 'lowpass', freq: 3000, sweepTo: 200, attack: 0.02, decay: 0.8, peak: 0.45 });
  g.thump(t + 0.25, 70, 25, 0.5, 0.6, 1);
};

// ---------------------------------------------------------------------------
// Quest cues (subtle)
// ---------------------------------------------------------------------------

const tagHum: Recipe = (g, t) => {
  const dur = LOOP + XF;
  drone(g, t, dur, 'square', 100, 0.04, { type: 'bandpass', freq: 2200, q: 2 }, { rate: 7.5, depth: 0.9 });
  drone(g, t, dur, 'sine', 50, 0.05);
  crackles(g, t, dur, 7, 0.2);
};

const tagHit: Recipe = (g, t) => {
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 3200, q: 1, decay: 0.08, peak: 0.6 });
  g.ring(t + 0.02, 880, [1, 2.41, 3.93, 5.4], 1.4, 0.3);
  g.ring(t + 0.02, 1318.5, [1, 2.2], 1.0, 0.12);
};

const questStep: Recipe = (g, t) => {
  for (const [f, lv] of [
    [110, 0.18],
    [164.8, 0.12],
    [261.6, 0.08],
    [311.1, 0.06],
  ] as const) {
    g.tone(t, 'sine', f, f * 0.995, 0.8, 1.6, lv);
  }
  g.hit(t, { color: 'pink', filter: 'bandpass', freq: 1200, q: 0.6, attack: 0.6, decay: 1.4, peak: 0.08 });
};

const coreHum: Recipe = (g, t) => {
  const dur = LOOP + XF;
  drone(g, t, dur, 'sine', 110, 0.16, undefined, { rate: 1 / LOOP, depth: 0.4 });
  drone(g, t, dur, 'sine', 165, 0.09, undefined, { rate: 2 / LOOP, depth: 0.5 });
  drone(g, t, dur, 'sine', 220, 0.05);
  drone(g, t, dur, 'triangle', 440, 0.015, { type: 'lowpass', freq: 1200 });
  g.bed(t, dur, 'pink', 'bandpass', 1600, 1.2, 0.02);
};

const corePickup: Recipe = (g, t) => {
  g.tone(t, 'sine', 300, 1200, 0.05, 0.9, 0.25);
  g.tone(t + 0.1, 'sine', 450, 1800, 0.05, 0.8, 0.12);
  g.ring(t + 0.4, 660, [1, 1.5, 2.0], 0.8, 0.15);
};

const socketFeed: Recipe = (g, t) => {
  g.thump(t, 120, 40, 0.25, 0.8, 1.6);
  g.hit(t, { color: 'white', filter: 'bandpass', freq: 1800, q: 1.5, decay: 0.06, peak: 0.6 });
  g.tone(t + 0.1, 'sawtooth', 60, 480, 0.6, 0.8, 0.14, 1500);
  g.ring(t + 0.05, 220, [1, 2.4, 3.6], 1.2, 0.14);
};

const defendLoop: Recipe = (g, t) => {
  const dur = LOOP + XF;
  // 5 pulses per loop (≈ 2.08 Hz).
  drone(g, t, dur, 'sine', 80, 0.22, undefined, { rate: 5 / LOOP, depth: 0.7 });
  drone(g, t, dur, 'sawtooth', 120, 0.05, { type: 'lowpass', freq: 800 }, { rate: 5 / LOOP, depth: 0.5 });
  g.bed(t, dur, 'pink', 'bandpass', 700, 1, 0.05);
};

const questComplete: Recipe = (g, t) => {
  g.thump(t, 80, 25, 1.2, 1, 1.5);
  g.hit(t, { color: 'pink', filter: 'lowpass', freq: 2500, sweepTo: 300, decay: 1.4, peak: 0.5 });
  for (const [f, lv, at] of [
    [220, 0.2, 0.1],
    [277.2, 0.14, 0.25],
    [329.6, 0.14, 0.4],
    [440, 0.12, 0.55],
    [554.4, 0.08, 0.7],
  ] as const) {
    g.tone(t + at, 'sine', f, f, 0.15, 2.2, lv);
  }
  g.ring(t + 0.6, 880, [1, 2.4, 3.9], 1.8, 0.14);
};

export const MAPKIT_SYNTH_DEFS = {
  'trap.fence.activate': { variants: 1, duration: 1.3, channels: 1, level: 0.9, recipe: fenceActivate },
  'trap.fence.loop': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.6, loop: true, recipe: fenceLoop },
  'trap.fence.hit': { variants: 3, duration: 0.45, channels: 1, level: 0.85, recipe: fenceHit },
  'trap.turret.activate': { variants: 1, duration: 1.4, channels: 1, level: 0.8, recipe: turretActivate },
  'trap.turret.loop': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.45, loop: true, recipe: turretLoop },
  'trap.turret.hit': { variants: 1, duration: 0.25, channels: 1, level: 0.6, recipe: turretHit },
  'trap.turret.fire': { variants: 3, duration: 0.3, channels: 1, level: 0.9, recipe: turretFire },
  'trap.fan.activate': { variants: 1, duration: 2, channels: 1, level: 0.85, recipe: fanActivate },
  'trap.fan.loop': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.75, loop: true, recipe: fanLoop },
  'trap.fan.hit': { variants: 3, duration: 0.6, channels: 1, level: 0.9, recipe: fanHit },
  'trap.flame.activate': { variants: 1, duration: 1.2, channels: 1, level: 0.9, recipe: flameActivate },
  'trap.flame.loop': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.75, loop: true, recipe: flameLoop },
  'trap.flame.hit': { variants: 2, duration: 0.5, channels: 1, level: 0.6, recipe: flameHit },
  'event.power.down': { variants: 1, duration: 2.6, channels: 1, level: 1, recipe: powerDown },
  'event.power.up': { variants: 1, duration: 2.3, channels: 1, level: 0.95, recipe: powerUp },
  'event.power.alarm': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.5, loop: true, recipe: powerAlarm },
  'event.generator.crank': { variants: 3, duration: 0.35, channels: 1, level: 0.7, recipe: generatorCrank },
  'event.generator.hum': { variants: 1, duration: 2.2, channels: 1, level: 0.8, recipe: generatorHum },
  'event.invasion.alarm': { variants: 1, duration: 1, channels: 1, level: 0.85, recipe: invasionAlarm },
  'event.gravity.start': { variants: 1, duration: 2, channels: 1, level: 0.95, recipe: gravityStart },
  'event.gravity.loop': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.6, loop: true, recipe: gravityLoop },
  'event.gravity.end': { variants: 1, duration: 1.2, channels: 1, level: 0.8, recipe: gravityEnd },
  'quest.tag.hum': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.35, loop: true, recipe: tagHum },
  'quest.tag.hit': { variants: 1, duration: 1.5, channels: 1, level: 0.75, recipe: tagHit },
  'quest.step': { variants: 1, duration: 2.6, channels: 1, level: 0.6, recipe: questStep },
  'quest.core.hum': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.5, loop: true, recipe: coreHum },
  'quest.core.pickup': { variants: 1, duration: 1.3, channels: 1, level: 0.7, recipe: corePickup },
  'quest.socket': { variants: 1, duration: 1.5, channels: 1, level: 0.8, recipe: socketFeed },
  'quest.defend': { variants: 1, duration: LOOP + XF, channels: 1, level: 0.55, loop: true, recipe: defendLoop },
  'quest.complete': { variants: 1, duration: 3.4, channels: 1, level: 0.95, recipe: questComplete },
} as const satisfies Record<string, SynthDef>;

export type MapKitSynthId = keyof typeof MAPKIT_SYNTH_DEFS;
