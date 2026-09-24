/**
 * Procedural sounds of the M5 arsenal weapons (the 22 weapons beyond the M2 pistol/rifle/shotgun),
 * registered into the procedural bank through SYNTH_DEFS (synth.ts spreads ARSENAL_SYNTH_DEFS in):
 * rendered once per sample rate, cached, varied, and overridden by real assets under the same id.
 *
 * This file holds the ballistic weapons (layered gunshots by caliber/family, their mechanical
 * layer, equip rack and reload steps), the shared tails / dry clicks / charge cues, and the id
 * registry of the whole M5 set (energySynth.ts: energy + wonder weapons and their loops;
 * elementSynth.ts: explosions, fields, statuses, combos, impacts, flight loops; gearSynth.ts:
 * grenades, abilities, forge and bench). `m5SynthAlias` resolves every convention id a def may
 * name to the closest real recipe (a weapon's missing reload step, per-weapon dry clicks, field
 * kinds × elements, grenade flight loops, unknown abilities), so data never falls silent.
 *
 * Gunshots stack like the M2 ones (weaponSynth.ts): transient crack + resonant snap, fast-pitch
 * body + sub, mid "bark", low-passed blast, decorrelated stereo slaps – with per-family extras:
 * a supersonic zip (battle rifle, marksman, sniper, PDW), frame / barrel rings (revolver, double
 * barrel), slap-back echoes (marksman, battle rifle, sniper, double barrel), a low boom (shotguns).
 * Rates above ~900 rpm get short bodies (machine pistol, vector, minigun): the chatter comes from
 * the repetition. Frequencies, levels and times inside the recipes are sound-design constants.
 */
import { AUDIO } from '../defs/audio';
import { WEAPON_IDS, getWeaponDef } from '../defs/weapons';
import { kitOf, type Kit, type Recipe } from './arsenalKit';
import { ELEMENT_SYNTH_ALIASES, ELEMENT_SYNTH_DEFS } from './elementSynth';
import { ENERGY_WEAPON_SYNTH_DEFS } from './energySynth';
import { GEAR_SYNTH_ALIASES, GEAR_SYNTH_DEFS } from './gearSynth';
import type { SynthDef } from './synth';

const A = AUDIO.arsenal.synth;
const FV = A.fireVariants;
const SV = A.semiFireVariants;

// ---------------------------------------------------------------------------
// Gunshots
// ---------------------------------------------------------------------------

export interface GunProfile {
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
  /** Supersonic crack: a bright zip riding just after the transient. */
  zip?: { freq: number; decay: number; peak: number };
  /** Frame / barrel resonance. */
  ring?: { base: number; ratios: readonly number[]; decay: number; peak: number };
  /** Slap-back echoes (s after the shot), relative gain, low-pass. */
  echo?: { delays: readonly number[]; gain: number; lowpass: number };
  /** Extra low boom under the blast (shotguns, magnum). */
  boom?: { f0: number; f1: number; decay: number; peak: number };
  /** Cylinder-gap / muzzle hiss. */
  hiss?: { freq: number; decay: number; peak: number };
  /** Long low roll after big rifles (outdoor-like thunder, the room adds its reverb). */
  roll?: { decay: number; peak: number };
}

export function gunshot(p: GunProfile): Recipe {
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
    if (p.zip) {
      // Supersonic crack: a bright, narrow zip sweeping down, a hair after the muzzle.
      for (const pan of [-0.35, 0.35]) {
        k.noise(t + 0.0012 * k.j(0.4), {
          color: 'white',
          filter: 'bandpass',
          freq: p.zip.freq * k.j(0.06),
          sweepTo: p.zip.freq * 0.45,
          q: 1.6,
          attack: 0.0004,
          decay: p.zip.decay,
          peak: p.zip.peak,
          pan,
        });
      }
    }
    if (p.hiss) {
      k.noise(t + 0.001, {
        color: 'white',
        filter: 'bandpass',
        freq: p.hiss.freq * k.j(0.08),
        q: 1.4,
        decay: p.hiss.decay,
        peak: p.hiss.peak,
      });
    }
    if (p.ring) k.ring(t + 0.002, p.ring.base * k.j(0.05), p.ring.ratios, p.ring.decay, p.ring.peak, 0.2);
    if (p.boom) {
      const lb = k.bus({ drive: 1.5, lowpass: 900 });
      lb.thump(t, { f0: p.boom.f0 * k.j(0.05), f1: p.boom.f1, pitchTime: 0.06, decay: p.boom.decay, peak: p.boom.peak });
      lb.noise(t, {
        color: 'brown',
        filter: 'lowpass',
        freq: 320,
        sweepTo: 90,
        attack: 0.004,
        decay: p.boom.decay * 0.9,
        peak: p.boom.peak * 0.8,
      });
    }
    if (p.echo) {
      const eb = k.bus({ lowpass: p.echo.lowpass, highpass: 120 });
      p.echo.delays.forEach((d, i) => {
        const gain = p.echo!.gain * Math.pow(0.62, i);
        eb.noise(t + d * k.j(0.06), {
          color: 'pink',
          filter: 'bandpass',
          freq: p.bark.freq * 0.9,
          q: 0.7,
          attack: 0.004,
          decay: p.bark.decay * 1.8,
          peak: gain,
          pan: i % 2 === 0 ? -0.55 : 0.55,
        });
        eb.thump(t + d, { f0: p.body.f1 * 1.6, f1: p.body.f1, pitchTime: 0.03, decay: 0.12, peak: gain * 0.6 });
      });
    }
    if (p.roll) {
      k.noise(t + 0.03, {
        color: 'brown',
        filter: 'lowpass',
        freq: 220,
        sweepTo: 70,
        attack: 0.06,
        decay: p.roll.decay,
        peak: p.roll.peak,
      });
    }
  };
}

export const GUN: Record<
  | 'revolver'
  | 'machinepistol'
  | 'smg'
  | 'pdw'
  | 'vector'
  | 'burstrifle'
  | 'battlerifle'
  | 'autoshotgun'
  | 'doublebarrel'
  | 'lmg'
  | 'minigun'
  | 'sniper'
  | 'marksman',
  GunProfile
> = {
  // Magnum boom: heavy low body, a long bark, the frame ringing and the cylinder gap hissing.
  revolver: {
    crack: { freq: 2300, decay: 0.016, peak: 1 },
    snap: { freq: 3600, q: 1.2, decay: 0.035, peak: 0.75 },
    body: { f0: 205, f1: 55, pitchTime: 0.026, decay: 0.16, peak: 1, drive: 3.4 },
    sub: { f0: 58, f1: 34, pitchTime: 0.07, decay: 0.26, peak: 0.85 },
    bark: { freq: 820, q: 0.8, sweepTo: 300, decay: 0.1, peak: 0.95 },
    blast: { lowpass: 6500, decay: 0.06, peak: 0.7 },
    width: 0.34,
    drive: 2.8,
    lowpass: 12000,
    ring: { base: 2400, ratios: [1, 2.37, 3.91, 5.7], decay: 0.18, peak: 0.08 },
    hiss: { freq: 6500, decay: 0.035, peak: 0.3 },
    boom: { f0: 72, f1: 34, decay: 0.3, peak: 0.55 },
  },
  // Buzz: short, bright and light – 1100 rpm turns it into a snarl.
  machinepistol: {
    crack: { freq: 3100, decay: 0.01, peak: 1 },
    snap: { freq: 4800, q: 1.5, decay: 0.022, peak: 0.6 },
    body: { f0: 300, f1: 95, pitchTime: 0.016, decay: 0.06, peak: 0.85, drive: 2.2 },
    sub: { f0: 80, f1: 52, pitchTime: 0.04, decay: 0.08, peak: 0.35 },
    bark: { freq: 1350, q: 1, sweepTo: 600, decay: 0.04, peak: 0.6 },
    blast: { lowpass: 8000, decay: 0.025, peak: 0.4 },
    width: 0.18,
    drive: 1.8,
    lowpass: 14000,
  },
  // Chatter: 9 mm between pistol and rifle, tight decay.
  smg: {
    crack: { freq: 2800, decay: 0.012, peak: 1 },
    snap: { freq: 4000, q: 1.2, decay: 0.026, peak: 0.65 },
    body: { f0: 255, f1: 78, pitchTime: 0.018, decay: 0.075, peak: 0.95, drive: 2.6 },
    sub: { f0: 72, f1: 46, pitchTime: 0.045, decay: 0.11, peak: 0.5 },
    bark: { freq: 1150, q: 0.9, sweepTo: 480, decay: 0.05, peak: 0.75 },
    blast: { lowpass: 7200, decay: 0.03, peak: 0.45 },
    width: 0.24,
    drive: 2.1,
    lowpass: 13500,
  },
  // Small, fast round: snappy and high with a little supersonic zip.
  pdw: {
    crack: { freq: 3400, decay: 0.011, peak: 1 },
    snap: { freq: 5200, q: 1.6, decay: 0.02, peak: 0.7 },
    body: { f0: 280, f1: 88, pitchTime: 0.016, decay: 0.065, peak: 0.85, drive: 2.3 },
    sub: { f0: 78, f1: 50, pitchTime: 0.04, decay: 0.09, peak: 0.38 },
    bark: { freq: 1500, q: 1.1, sweepTo: 700, decay: 0.04, peak: 0.6 },
    blast: { lowpass: 8500, decay: 0.025, peak: 0.4 },
    width: 0.2,
    drive: 2,
    lowpass: 15000,
    zip: { freq: 7500, decay: 0.012, peak: 0.28 },
  },
  // .45 thud through a recoil-mitigating action: darker, rounder, less crack.
  vector: {
    crack: { freq: 2000, decay: 0.009, peak: 0.7 },
    snap: { freq: 3000, q: 1, decay: 0.022, peak: 0.55 },
    body: { f0: 220, f1: 70, pitchTime: 0.02, decay: 0.08, peak: 1, drive: 2.8 },
    sub: { f0: 66, f1: 44, pitchTime: 0.05, decay: 0.1, peak: 0.55 },
    bark: { freq: 900, q: 0.9, sweepTo: 380, decay: 0.05, peak: 0.85 },
    blast: { lowpass: 5500, decay: 0.03, peak: 0.4 },
    width: 0.22,
    drive: 2.4,
    lowpass: 10000,
  },
  // Punchy rifle shot with a crisp edge; three of them make the triple.
  burstrifle: {
    crack: { freq: 2250, decay: 0.012, peak: 1 },
    snap: { freq: 3400, q: 1.2, decay: 0.026, peak: 0.7 },
    body: { f0: 200, f1: 60, pitchTime: 0.019, decay: 0.11, peak: 1, drive: 2.9 },
    sub: { f0: 60, f1: 39, pitchTime: 0.055, decay: 0.16, peak: 0.7 },
    bark: { freq: 800, q: 0.85, sweepTo: 330, decay: 0.065, peak: 0.85 },
    blast: { lowpass: 6400, decay: 0.04, peak: 0.5 },
    width: 0.3,
    drive: 2.6,
    lowpass: 12500,
    zip: { freq: 6000, decay: 0.01, peak: 0.22 },
  },
  // 7.62 crack: heavier body, a hard supersonic zip, a short slap-back.
  battlerifle: {
    crack: { freq: 1900, decay: 0.015, peak: 1 },
    snap: { freq: 2900, q: 1, decay: 0.034, peak: 0.85 },
    body: { f0: 178, f1: 50, pitchTime: 0.022, decay: 0.15, peak: 1, drive: 3.4 },
    sub: { f0: 54, f1: 33, pitchTime: 0.07, decay: 0.24, peak: 0.9 },
    bark: { freq: 700, q: 0.8, sweepTo: 270, decay: 0.09, peak: 1 },
    blast: { lowpass: 5800, decay: 0.06, peak: 0.7 },
    width: 0.4,
    drive: 3,
    lowpass: 11500,
    zip: { freq: 5200, decay: 0.018, peak: 0.42 },
    echo: { delays: [0.058], gain: 0.2, lowpass: 2200 },
  },
  // Thump: a tighter shotgun blast with a low boom, built to repeat at 300 rpm.
  autoshotgun: {
    crack: { freq: 1650, decay: 0.02, peak: 1 },
    snap: { freq: 2600, q: 0.85, decay: 0.04, peak: 0.8 },
    body: { f0: 158, f1: 46, pitchTime: 0.03, decay: 0.17, peak: 1, drive: 3.8 },
    sub: { f0: 50, f1: 30, pitchTime: 0.075, decay: 0.26, peak: 0.9 },
    bark: { freq: 540, q: 0.7, sweepTo: 210, decay: 0.1, peak: 1 },
    blast: { lowpass: 5200, decay: 0.07, peak: 0.8 },
    width: 0.4,
    drive: 3.1,
    lowpass: 10000,
    boom: { f0: 76, f1: 32, decay: 0.3, peak: 0.7 },
  },
  // Roar: two barrels' worth of powder – the deepest, widest blast with a rolling echo.
  doublebarrel: {
    crack: { freq: 1500, decay: 0.026, peak: 1 },
    snap: { freq: 2300, q: 0.8, decay: 0.05, peak: 0.85 },
    body: { f0: 140, f1: 40, pitchTime: 0.036, decay: 0.25, peak: 1, drive: 4.5 },
    sub: { f0: 46, f1: 26, pitchTime: 0.09, decay: 0.42, peak: 1 },
    bark: { freq: 470, q: 0.7, sweepTo: 170, decay: 0.16, peak: 1 },
    blast: { lowpass: 4600, decay: 0.11, peak: 0.9 },
    width: 0.52,
    drive: 3.4,
    lowpass: 9500,
    boom: { f0: 70, f1: 28, decay: 0.5, peak: 0.9 },
    echo: { delays: [0.075, 0.16], gain: 0.22, lowpass: 1600 },
  },
  // Chug: a heavy, low shot at a steady 700 rpm.
  lmg: {
    crack: { freq: 1950, decay: 0.014, peak: 1 },
    snap: { freq: 3000, q: 1, decay: 0.03, peak: 0.8 },
    body: { f0: 170, f1: 48, pitchTime: 0.022, decay: 0.13, peak: 1, drive: 3.4 },
    sub: { f0: 54, f1: 33, pitchTime: 0.065, decay: 0.2, peak: 0.85 },
    bark: { freq: 680, q: 0.8, sweepTo: 260, decay: 0.08, peak: 0.95 },
    blast: { lowpass: 5600, decay: 0.05, peak: 0.62 },
    width: 0.36,
    drive: 2.9,
    lowpass: 11500,
  },
  // One grain of the roar: 40 shots a second fuse into a tearing wall of sound.
  minigun: {
    crack: { freq: 2400, decay: 0.008, peak: 1 },
    snap: { freq: 3600, q: 1.2, decay: 0.018, peak: 0.65 },
    body: { f0: 200, f1: 72, pitchTime: 0.014, decay: 0.05, peak: 1, drive: 2.8 },
    sub: { f0: 62, f1: 44, pitchTime: 0.035, decay: 0.07, peak: 0.55 },
    bark: { freq: 780, q: 0.9, sweepTo: 360, decay: 0.035, peak: 0.8 },
    blast: { lowpass: 6200, decay: 0.022, peak: 0.45 },
    width: 0.28,
    drive: 2.6,
    lowpass: 11500,
  },
  // Anti-materiel crack: huge transient and zip, deep body, echoes rolling off into the distance.
  sniper: {
    crack: { freq: 1800, decay: 0.018, peak: 1 },
    snap: { freq: 2700, q: 0.9, decay: 0.04, peak: 0.9 },
    body: { f0: 150, f1: 42, pitchTime: 0.03, decay: 0.22, peak: 1, drive: 4 },
    sub: { f0: 46, f1: 27, pitchTime: 0.09, decay: 0.36, peak: 1 },
    bark: { freq: 600, q: 0.7, sweepTo: 230, decay: 0.12, peak: 1 },
    blast: { lowpass: 5200, decay: 0.09, peak: 0.85 },
    width: 0.5,
    drive: 3.3,
    lowpass: 11000,
    zip: { freq: 6500, decay: 0.025, peak: 0.6 },
    echo: { delays: [0.12, 0.26, 0.43], gain: 0.34, lowpass: 1800 },
    roll: { decay: 0.9, peak: 0.45 },
  },
  // Snap: tight, high-energy precision round with a short slap-back.
  marksman: {
    crack: { freq: 2050, decay: 0.013, peak: 1 },
    snap: { freq: 3500, q: 1.4, decay: 0.026, peak: 0.9 },
    body: { f0: 185, f1: 56, pitchTime: 0.02, decay: 0.12, peak: 1, drive: 3.1 },
    sub: { f0: 56, f1: 36, pitchTime: 0.06, decay: 0.18, peak: 0.75 },
    bark: { freq: 760, q: 0.85, sweepTo: 300, decay: 0.075, peak: 0.9 },
    blast: { lowpass: 6000, decay: 0.05, peak: 0.55 },
    width: 0.34,
    drive: 2.8,
    lowpass: 12500,
    zip: { freq: 6800, decay: 0.016, peak: 0.5 },
    echo: { delays: [0.075], gain: 0.18, lowpass: 2400 },
  },
};

// ---------------------------------------------------------------------------
// Mechanical layers (per shot, panned to the ejection side)
// ---------------------------------------------------------------------------

interface CycleProfile {
  /** First contact (unlock / carrier back) and the return (slam home). */
  t1: number;
  t2: number;
  back: { freq: number; q: number; decay: number; peak: number; ring: number };
  home: { click: number; thump: number; ring: number; peak: number };
  pan: number;
  /** Buffer-spring buzz (rifles). */
  spring?: number;
  /** Belt link / drum rattle ticks. */
  rattle?: { count: number; span: number; freq: number; peak: number };
}

function cycle(p: CycleProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    const t1 = t + p.t1 * k.j(0.2);
    k.noise(t1, {
      color: 'white',
      filter: 'bandpass',
      freq: p.back.freq * k.j(0.08),
      q: p.back.q,
      decay: p.back.decay,
      peak: p.back.peak,
      pan: p.pan,
    });
    k.ring(t1, p.back.ring * k.j(0.06), [1, 2.45, 3.95], p.back.decay * 3, 0.24, p.pan);
    if (p.spring) k.tone(t1 + 0.004, 'sawtooth', p.spring * k.j(0.08), p.spring * 0.72, 0.002, 0.03, 0.07, p.pan);
    const t2 = t + p.t2 * k.j(0.1);
    k.click(t2, p.home.click, 0.006, 0.75 * p.home.peak, p.pan);
    k.thump(t2, { f0: p.home.thump, f1: p.home.thump * 0.65, pitchTime: 0.009, decay: 0.025, peak: 0.45 * p.home.peak });
    k.ring(t2, p.home.ring * k.j(0.06), [1, 2.25, 3.6], 0.055, 0.22 * p.home.peak, p.pan);
    if (p.rattle) k.ticks(t1 + 0.01, p.rattle.count, p.rattle.span, p.rattle.freq, 6, p.rattle.peak, p.pan * 1.3);
  };
}

const CYCLE = {
  machinepistol: {
    t1: 0.008,
    t2: 0.034,
    back: { freq: 2900, q: 3, decay: 0.012, peak: 0.55, ring: 2600 },
    home: { click: 4200, thump: 360, ring: 2300, peak: 0.85 },
    pan: 0.25,
  },
  smg: {
    t1: 0.006,
    t2: 0.05,
    back: { freq: 2200, q: 2, decay: 0.016, peak: 0.7, ring: 1700 },
    home: { click: 3000, thump: 260, ring: 1500, peak: 0.9 },
    pan: 0.28,
  },
  pdw: {
    t1: 0.006,
    t2: 0.036,
    back: { freq: 3200, q: 2.5, decay: 0.01, peak: 0.6, ring: 2900 },
    home: { click: 4400, thump: 340, ring: 1900, peak: 0.7 },
    pan: 0.2,
  },
  // Recoil-mitigating mass: a lower clunk than the other SMGs.
  vector: {
    t1: 0.01,
    t2: 0.048,
    back: { freq: 1500, q: 1.5, decay: 0.03, peak: 0.6, ring: 1200 },
    home: { click: 2800, thump: 240, ring: 1250, peak: 0.9 },
    pan: 0.22,
  },
  burstrifle: {
    t1: 0.006,
    t2: 0.04,
    back: { freq: 3000, q: 2, decay: 0.012, peak: 0.8, ring: 1700 },
    home: { click: 3600, thump: 300, ring: 1500, peak: 0.95 },
    pan: 0.28,
    spring: 200,
  },
  battlerifle: {
    t1: 0.008,
    t2: 0.05,
    back: { freq: 2200, q: 1.8, decay: 0.018, peak: 0.85, ring: 1250 },
    home: { click: 2700, thump: 240, ring: 1100, peak: 1 },
    pan: 0.3,
    spring: 160,
  },
  autoshotgun: {
    t1: 0.01,
    t2: 0.065,
    back: { freq: 1800, q: 1.6, decay: 0.022, peak: 0.85, ring: 1000 },
    home: { click: 2500, thump: 200, ring: 950, peak: 1 },
    pan: 0.3,
    rattle: { count: 4, span: 0.08, freq: 2400, peak: 0.18 },
  },
  lmg: {
    t1: 0.008,
    t2: 0.055,
    back: { freq: 2000, q: 1.6, decay: 0.02, peak: 0.85, ring: 1150 },
    home: { click: 2600, thump: 200, ring: 1000, peak: 0.95 },
    pan: 0.3,
    rattle: { count: 3, span: 0.05, freq: 4200, peak: 0.3 },
  },
  marksman: {
    t1: 0.006,
    t2: 0.038,
    back: { freq: 2600, q: 2, decay: 0.014, peak: 0.8, ring: 1450 },
    home: { click: 3300, thump: 280, ring: 1300, peak: 0.95 },
    pan: 0.26,
    spring: 190,
  },
} satisfies Record<string, CycleProfile>;

/** Revolver: hammer rebound, then the cylinder indexes (ratchet) and the bolt stop locks it. */
const revolverMech: Recipe = (g, t) => {
  const k = kitOf(g);
  const pan = 0.15;
  k.click(t + 0.004, 3000, 0.004, 0.4, pan);
  const idx = t + 0.075 * k.j(0.1);
  k.click(idx, 4200, 0.003, 0.55, pan);
  k.ring(idx, 3100 * k.j(0.05), [1, 2.2], 0.02, 0.15, pan);
  k.click(idx + 0.028, 4600, 0.003, 0.35, pan);
  const lock = t + 0.15 * k.j(0.08);
  k.click(lock, 3600, 0.004, 0.6, pan);
  k.thump(lock, { f0: 420, f1: 300, pitchTime: 0.006, decay: 0.012, peak: 0.25 });
  k.ring(lock, 2500 * k.j(0.05), [1, 2.4, 3.7], 0.04, 0.16, pan);
};

/** Double barrel: the barrels ring after the blast, the hammers settle. */
const doubleBarrelMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.ring(t + 0.004, 820 * k.j(0.04), [1, 2.63, 4.93, 7.2], 0.45, 0.32, -0.1);
  k.ring(t + 0.006, 1130 * k.j(0.04), [1, 2.41, 3.9], 0.3, 0.16, 0.15);
  k.click(t + 0.02, 3200, 0.005, 0.35, 0.2);
};

/** Minigun feed: a tiny tick per round (the motor loop carries the mechanics). */
const minigunMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t + 0.004, 3800 * k.j(0.1), 0.003, 0.5, 0.3);
  k.ring(t + 0.004, 2600 * k.j(0.08), [1, 2.4], 0.02, 0.15, 0.3);
  k.ticks(t + 0.006, 2, 0.02, 4400, 6, 0.2, 0.35);
};

/** Sniper: the receiver and scope ring on after the shot (the bolt cycle is `weapon.sniper.pump`). */
const sniperMech: Recipe = (g, t) => {
  const k = kitOf(g);
  k.ring(t + 0.003, 1600 * k.j(0.04), [1, 2.7, 4.4, 6.3], 0.3, 0.25, 0.15);
  k.ticks(t + 0.02, 2, 0.05, 5200, 7, 0.18, 0.25);
};

/**
 * Bolt-action cycle `delay` s after the shot, matched to the viewmodel (defs/viewmodelData/sniper:
 * BOLT_CYCLE_DELAY 0.3, lift 0.06, stroke 0.08, stop 0.03): handle up, bolt back (the case flies),
 * bolt home, handle down.
 */
function boltAction(delay: number, pan: number): Recipe {
  return (g, t0) => {
    const k = kitOf(g);
    const t = t0 + delay;
    // Handle lift.
    k.click(t, 3000, 0.006, 0.6, pan);
    k.ring(t, 1800 * k.j(0.05), [1, 2.3], 0.04, 0.2, pan);
    // Bolt back: slide + stop clack, the case tinkles out to the right.
    k.noise(t + 0.06, {
      color: 'white',
      filter: 'bandpass',
      freq: 1500 * k.j(0.06),
      sweepTo: 2600,
      q: 1.8,
      attack: 0.02,
      decay: 0.06,
      peak: 0.5,
      pan,
    });
    const stop = t + 0.14;
    k.click(stop, 2600, 0.008, 0.85, pan);
    k.thump(stop, { f0: 220, f1: 140, pitchTime: 0.01, decay: 0.03, peak: 0.5 });
    k.ring(stop, 1200 * k.j(0.05), [1, 2.4, 3.8], 0.07, 0.3, pan);
    k.ring(stop + 0.012, 3800 * k.j(0.08), [1, 2.61, 4.3], 0.08, 0.16, 0.6);
    // Bolt home + chamber.
    k.noise(t + 0.17, {
      color: 'white',
      filter: 'bandpass',
      freq: 2600 * k.j(0.06),
      sweepTo: 1500,
      q: 1.8,
      attack: 0.02,
      decay: 0.06,
      peak: 0.45,
      pan,
    });
    const home = t + 0.25;
    const b = k.bus({ drive: 1.8 });
    b.click(home, 2400, 0.008, 0.9, pan);
    b.thump(home, { f0: 180 * k.j(0.05), f1: 110, pitchTime: 0.012, decay: 0.04, peak: 0.6 });
    b.ring(home, 1100 * k.j(0.05), [1, 2.3], 0.08, 0.25, pan);
    // Handle down (locked).
    const lock = t + 0.31;
    k.click(lock, 3200, 0.006, 0.75, pan);
    k.thump(lock, { f0: 300, f1: 200, pitchTime: 0.008, decay: 0.02, peak: 0.4 });
    k.ring(lock, 1500 * k.j(0.05), [1, 2.5], 0.05, 0.2, pan);
  };
}

// ---------------------------------------------------------------------------
// Handling: equip racks, reload steps
// ---------------------------------------------------------------------------

interface HandlingProfile {
  /** Metal body resonance of the magazine / receiver. */
  ring: number;
  /** Seating thump start frequency (heavier weapons lower). */
  seat: number;
  /** Scrape band. */
  scrape: number;
}

const HANDLING = {
  machinepistol: { ring: 2400, seat: 290, scrape: 2700 },
  smg: { ring: 1900, seat: 240, scrape: 2200 },
  pdw: { ring: 1800, seat: 230, scrape: 1900 },
  vector: { ring: 2000, seat: 250, scrape: 2300 },
  burstrifle: { ring: 1600, seat: 215, scrape: 1900 },
  battlerifle: { ring: 1300, seat: 190, scrape: 1700 },
  autoshotgun: { ring: 950, seat: 165, scrape: 1400 },
  lmg: { ring: 1100, seat: 170, scrape: 1500 },
  minigun: { ring: 1000, seat: 160, scrape: 1400 },
  sniper: { ring: 1400, seat: 200, scrape: 1800 },
  marksman: { ring: 1500, seat: 205, scrape: 1850 },
} satisfies Record<string, HandlingProfile>;

function whoosh(k: Kit, t: number, from: number, to: number, decay: number, peak: number, pan = 0): void {
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: from, sweepTo: to, q: 1.1, attack: decay * 0.4, decay, peak, pan });
}

/** Heavy/light metal contact: click + short thump + ring (the atom of every mechanism). */
function clack(k: Kit, t: number, h: HandlingProfile, peak = 1, pan = 0, drive = 0): void {
  const b = drive > 0 ? k.bus({ drive }) : k;
  b.click(t, 2400 + h.ring, 0.007, 0.85 * peak, pan);
  b.thump(t, { f0: h.seat * k.j(0.05), f1: h.seat * 0.55, pitchTime: 0.011, decay: 0.045, peak: 0.8 * peak, drive: drive > 0 ? 1.5 : 0 });
  b.ring(t, h.ring * 0.7 * k.j(0.05), [1, 2.25, 3.6], 0.08, 0.3 * peak, pan);
}

/** Scrape of sliding metal/polymer. */
function scrape(k: Kit, t: number, from: number, to: number, decay: number, peak: number, pan = 0): void {
  k.noise(t, {
    color: 'white',
    filter: 'bandpass',
    freq: from * k.j(0.06),
    sweepTo: to,
    q: 2.2,
    attack: Math.min(0.02, decay * 0.4),
    decay,
    peak,
    pan,
  });
}

function magOut(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    k.click(t, 4200, 0.005, 0.7);
    k.ring(t, h.ring * 1.3 * k.j(0.05), [1, 2.5], 0.03, 0.2);
    scrape(k, t + 0.018, h.scrape, h.scrape * 0.55, 0.08, 0.55);
    k.ring(t + 0.03, h.ring * k.j(0.06), [1, 2.2, 3.9], 0.07, 0.22);
    k.thump(t + 0.1, { f0: h.seat * 0.8, f1: h.seat * 0.55, pitchTime: 0.01, decay: 0.03, peak: 0.25 });
  };
}

function magIn(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    scrape(k, t, h.scrape * 0.7, h.scrape * 1.2, 0.05, 0.4);
    const seat = t + 0.055 * k.j(0.1);
    clack(k, seat, h, 1.05, 0, 1.8);
    k.click(seat + 0.018, 5000, 0.004, 0.45, 0.15);
  };
}

/** Charging handle / bolt carrier: pull back, then slam home. `slap`: an HK-style hand slap. */
function chargingHandle(h: HandlingProfile, pull: number, slap = false): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    scrape(k, t, h.scrape * 1.05, h.scrape * 0.7, 0.05, 0.55);
    k.click(t + 0.03, 3200, 0.006, 0.7);
    k.ring(t + 0.03, h.ring * 0.9 * k.j(0.05), [1, 2.5], 0.05, 0.22);
    const slam = t + pull * k.j(0.08);
    if (slap) k.noise(slam - 0.004, { color: 'pink', filter: 'lowpass', freq: 900, decay: 0.03, peak: 0.7 });
    clack(k, slam, h, 1.15, 0, 2.2);
    k.ring(slam, h.ring * 0.85, [1, 2.35, 3.9, 5.6], 0.13, 0.3);
  };
}

/** Pistol-style slide release / bolt catch: one hard snap. */
function snap(h: HandlingProfile, lead = 0): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    if (lead > 0) k.click(t, 4400, 0.003, 0.4);
    clack(k, t + lead, h, 1.1, 0, 2);
    k.ring(t + lead, h.ring * 1.1 * k.j(0.05), [1, 2.7, 4.4, 6.1], 0.12, 0.35);
  };
}

/** A few ratchet clicks spaced `from` → `to` s apart (cylinder spins, drum winds, side chargers). */
function ratchet(k: Kit, t: number, count: number, from: number, to: number, freq: number, peak: number, pan = 0): number {
  let at = t;
  for (let i = 0; i < count; i++) {
    const u = count > 1 ? i / (count - 1) : 0;
    k.click(at, freq * k.j(0.05), 0.003, peak * (0.75 + 0.25 * k.rng.next()), pan);
    k.ring(at, freq * 0.72 * k.j(0.04), [1, 2.2], 0.018, peak * 0.25, pan);
    at += from + (to - from) * u;
  }
  return at;
}

function equipBasic(h: HandlingProfile, o: { whoosh: [number, number, number]; rackAt: number; heavy?: boolean }): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    whoosh(k, t, o.whoosh[0], o.whoosh[1], o.whoosh[2], 0.55);
    k.ticks(t + 0.04, o.heavy ? 5 : 3, 0.1, 2600, 5, 0.25);
    const at = t + o.rackAt * k.j(0.06);
    scrape(k, at, h.scrape, h.scrape * 0.7, 0.04, 0.45);
    clack(k, at + 0.07, h, o.heavy ? 1.15 : 1, 0, o.heavy ? 2 : 0);
  };
}

// --- per-weapon handling -----------------------------------------------------

const revolverEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 600, 1500, 0.1, 0.5);
  // Cylinder spun with the thumb, then the hammer cocked.
  const end = ratchet(k, t + 0.07, 7, 0.028, 0.05, 4200, 0.55, 0.1);
  const cock = Math.max(end, t + 0.33);
  k.click(cock, 3000, 0.005, 0.8);
  k.ring(cock, 2200 * k.j(0.05), [1, 2.5], 0.04, 0.25);
  k.click(cock + 0.032, 3600, 0.004, 0.6);
};

/** Crane swings out, the ejector rod throws six cases out (brass rain). */
const revolverMagOut: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = { ring: 2300, seat: 280, scrape: 2600 };
  k.click(t, 3800, 0.004, 0.6);
  scrape(k, t + 0.01, 2000, 1400, 0.05, 0.4);
  clack(k, t + 0.07, h, 0.8);
  // Ejector stroke.
  scrape(k, t + 0.14, 2600, 3600, 0.04, 0.35);
  for (let i = 0; i < 6; i++) {
    const at = t + 0.17 + k.rng.next() * 0.12;
    const base = k.r(3600, 5400);
    k.ring(at, base, [1, 2.61, 4.3], 0.09, 0.5);
    k.ring(at + k.r(0.05, 0.12), base * 1.01, [1, 2.61, 4.3], 0.06, 0.22);
  }
};

/** Speedloader: six rounds slide into the chambers, the knob twists free. */
const revolverMagIn: Recipe = (g, t) => {
  const k = kitOf(g);
  scrape(k, t, 1600, 2600, 0.06, 0.45);
  k.thump(t + 0.05, { f0: 300, f1: 200, pitchTime: 0.01, decay: 0.035, peak: 0.6 });
  k.click(t + 0.05, 3400, 0.005, 0.6);
  k.ring(t + 0.05, 2100 * k.j(0.05), [1, 2.3, 3.8], 0.06, 0.2);
  ratchet(k, t + 0.14, 2, 0.03, 0.03, 5200, 0.4);
  scrape(k, t + 0.2, 2800, 2000, 0.04, 0.2);
};

/** Crane snapped shut with a flick of the wrist; the cylinder spins against the hand. */
const revolverClose: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = { ring: 2300, seat: 280, scrape: 2600 };
  scrape(k, t, 1400, 2100, 0.03, 0.3);
  clack(k, t + 0.035, h, 1.15, 0, 2);
  k.ring(t + 0.035, 2600 * k.j(0.05), [1, 2.7, 4.4], 0.12, 0.3);
  ratchet(k, t + 0.09, 3, 0.03, 0.045, 4400, 0.35);
};

const machinepistolEquip = equipBasic(HANDLING.machinepistol, { whoosh: [700, 1700, 0.08], rackAt: 0.1 });
const smgEquip = equipBasic(HANDLING.smg, { whoosh: [500, 1400, 0.1], rackAt: 0.13 });

/** PDW: polymer tap, the side charging handle, snap. */
const pdwEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.pdw;
  whoosh(k, t, 520, 1500, 0.1, 0.5);
  k.noise(t + 0.11, { color: 'pink', filter: 'bandpass', freq: 1800, q: 1.5, decay: 0.02, peak: 0.5 });
  scrape(k, t + 0.17, 2400, 1600, 0.045, 0.4);
  clack(k, t + 0.25, h, 0.9);
};

/** Vector: side charger ratchets back, releases with a clack. */
const vectorEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 520, 1450, 0.1, 0.5);
  ratchet(k, t + 0.12, 3, 0.022, 0.022, 3800, 0.45, -0.1);
  clack(k, t + 0.22, HANDLING.vector, 1, 0, 1.6);
};

/** Burst rifle: bolt catch clack, then the fire-control chirps its burst mode. */
const burstrifleEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 450, 1300, 0.13, 0.55);
  k.ticks(t + 0.04, 4, 0.1, 2600, 5, 0.25);
  clack(k, t + 0.2, HANDLING.burstrifle, 1, 0, 1.8);
  k.tone(t + 0.3, 'sine', 1800, 1800, 0.002, 0.03, 0.14);
  k.tone(t + 0.345, 'sine', 2400, 2400, 0.002, 0.04, 0.14);
};

const battlerifleEquip = equipBasic(HANDLING.battlerifle, { whoosh: [400, 1200, 0.15], rackAt: 0.2, heavy: true });

/** Auto shotgun: the shells rattle in the drum, then the bolt slams. */
const autoshotgunEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 380, 1100, 0.15, 0.6);
  k.ticks(t + 0.06, 6, 0.15, 2200, 4, 0.28);
  scrape(k, t + 0.24, 1500, 1000, 0.05, 0.5);
  clack(k, t + 0.31, HANDLING.autoshotgun, 1.2, 0, 2.2);
};

/** Double barrel: swung up and snapped shut. */
const doublebarrelEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 380, 1100, 0.15, 0.55);
  k.ticks(t + 0.05, 3, 0.1, 2200, 5, 0.22);
  breakClose(k, t + 0.24, 1);
};

/** The action snaps shut: heavy clack, lever spring ping, barrels ringing briefly. */
function breakClose(k: Kit, t: number, peak: number): void {
  const b = k.bus({ drive: 2.2 });
  b.click(t, 2200, 0.009, peak);
  b.thump(t, { f0: 170 * k.j(0.05), f1: 95, pitchTime: 0.012, decay: 0.06, peak: peak, drive: 1.8 });
  b.ring(t, 900 * k.j(0.04), [1, 2.6, 4.9], 0.15, 0.3 * peak);
  k.ring(t + 0.02, 2600 * k.j(0.05), [1, 1.9], 0.08, 0.12 * peak, 0.2);
}

const doublebarrelOpen: Recipe = (g, t) => {
  const k = kitOf(g);
  // Top lever, the barrels drop on the hinge, the extractor pops both shells out.
  k.click(t, 3400, 0.005, 0.6);
  k.ring(t, 2100 * k.j(0.05), [1, 2.4], 0.04, 0.2);
  scrape(k, t + 0.02, 900, 1500, 0.1, 0.35);
  const stop = t + 0.13;
  k.thump(stop, { f0: 190, f1: 120, pitchTime: 0.012, decay: 0.05, peak: 0.8 });
  k.click(stop, 2600, 0.007, 0.7);
  k.ring(stop, 820 * k.j(0.04), [1, 2.63, 4.93], 0.2, 0.25);
  for (let i = 0; i < 2; i++) {
    const at = stop + 0.03 + i * 0.022;
    k.noise(at, { color: 'pink', filter: 'bandpass', freq: 1300 * k.j(0.1), q: 2.5, decay: 0.03, peak: 0.55, pan: 0.3 });
    k.thump(at, { f0: 520, f1: 380, pitchTime: 0.005, decay: 0.02, peak: 0.4 });
    // Hulls tumbling onto the floor.
    k.thump(at + 0.2 + k.rng.next() * 0.08, { f0: 480, f1: 360, pitchTime: 0.005, decay: 0.02, peak: 0.25 });
  }
};

const doublebarrelLoad: Recipe = (g, t) => {
  const k = kitOf(g);
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.12 * k.j(0.08);
    k.noise(at, { color: 'pink', filter: 'bandpass', freq: 1100 * k.j(0.08), sweepTo: 700, q: 1.8, attack: 0.01, decay: 0.04, peak: 0.45 });
    k.thump(at + 0.03, { f0: 250, f1: 160, pitchTime: 0.01, decay: 0.035, peak: 0.75 });
    k.click(at + 0.03, 3200, 0.004, 0.45);
  }
};

const doublebarrelClose: Recipe = (g, t) => {
  const k = kitOf(g);
  scrape(k, t, 1300, 900, 0.05, 0.3);
  breakClose(k, t + 0.06, 1.15);
};

const lmgEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.lmg;
  whoosh(k, t, 320, 1000, 0.2, 0.65);
  k.ticks(t + 0.06, 6, 0.2, 2400, 5, 0.25);
  clack(k, t + 0.14, h, 0.9);
  k.ticks(t + 0.16, 4, 0.12, 4200, 6, 0.22, 0.3);
  chargingHandle(h, 0.1)(g, t + 0.42);
};

/** LMG: feed cover pops and swings up, the box latch, the box comes off with the belt rattling. */
const lmgMagOut: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.lmg;
  k.click(t, 3600, 0.005, 0.7);
  k.ring(t, 1400 * k.j(0.05), [1, 2.4], 0.05, 0.22);
  scrape(k, t + 0.03, 900, 1400, 0.1, 0.35);
  clack(k, t + 0.14, h, 0.75);
  k.click(t + 0.34, 3000, 0.005, 0.6);
  scrape(k, t + 0.37, 1400, 900, 0.14, 0.45);
  k.ticks(t + 0.4, 9, 0.25, 4000, 6, 0.32, 0.25);
};

/** LMG: the box slides in and latches, the belt is laid over the feed tray. */
const lmgMagIn: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.lmg;
  scrape(k, t, 1200, 1700, 0.08, 0.45);
  clack(k, t + 0.12, h, 1.1, 0, 1.8);
  k.ticks(t + 0.32, 11, 0.26, 3800, 6, 0.35, 0.2);
  k.click(t + 0.62, 3400, 0.005, 0.55);
  k.ring(t + 0.62, 1500, [1, 2.3], 0.04, 0.15);
};

/** LMG: cover slammed shut, then the charging handle racks. */
const lmgClose: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.lmg;
  clack(k, t, h, 1.25, 0, 2.2);
  k.ring(t, 1000 * k.j(0.04), [1, 2.4, 3.9, 5.5], 0.15, 0.3);
  chargingHandle(h, 0.12)(g, t + 0.25);
};

/** Minigun: heavy clank, then the motor gives the barrels a short test spin. */
const minigunEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 300, 900, 0.22, 0.7);
  k.ticks(t + 0.05, 6, 0.2, 2200, 5, 0.25);
  clack(k, t + 0.16, HANDLING.minigun, 1.1, 0, 2);
  const m = k.bus({ lowpass: 2600 });
  m.note(t + 0.35, 'sawtooth', 90, 330, 0.25, 0.3, 0.3, 0.2);
  k.note(t + 0.35, 'sine', 900, 2400, 0.25, 0.3, 0.3, 0.06);
  m.noise(t + 0.4, { color: 'pink', filter: 'bandpass', freq: 1100, q: 1.5, attack: 0.15, decay: 0.35, peak: 0.35 });
};

const minigunMagOut: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.minigun;
  k.click(t, 3200, 0.005, 0.7);
  k.ring(t, 1300, [1, 2.3], 0.05, 0.2);
  scrape(k, t + 0.05, 1300, 850, 0.14, 0.5);
  k.ticks(t + 0.08, 8, 0.25, 3800, 6, 0.32, 0.2);
  k.thump(t + 0.3, { f0: h.seat, f1: h.seat * 0.6, pitchTime: 0.012, decay: 0.05, peak: 0.45 });
};

const minigunMagIn: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.minigun;
  scrape(k, t, 900, 1400, 0.1, 0.45);
  clack(k, t + 0.14, h, 1.15, 0, 2);
  ratchet(k, t + 0.32, 5, 0.035, 0.03, 3600, 0.4, 0.2);
};

/** Minigun "bolt release": relay click, motor chirp, electronics ready. */
const minigunPowerOn: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 3000, 0.006, 0.7);
  k.thump(t, { f0: 400, f1: 280, pitchTime: 0.006, decay: 0.015, peak: 0.35 });
  const m = k.bus({ lowpass: 2200 });
  m.note(t + 0.04, 'sawtooth', 120, 420, 0.18, 0.2, 0.12, 0.25);
  k.note(t + 0.04, 'sine', 1400, 2800, 0.18, 0.2, 0.12, 0.08);
  k.tone(t + 0.3, 'sine', 2200, 2200, 0.002, 0.05, 0.1);
};

const sniperEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 420, 1200, 0.15, 0.55);
  k.ring(t + 0.16, 3200 * k.j(0.05), [1, 2.3, 3.9], 0.08, 0.18);
  k.ticks(t + 0.05, 3, 0.1, 2400, 5, 0.22);
  boltAction(0, 0.1)(g, t + 0.26);
};

const marksmanEquip: Recipe = (g, t) => {
  const k = kitOf(g);
  whoosh(k, t, 440, 1250, 0.14, 0.55);
  k.ring(t + 0.14, 3000 * k.j(0.05), [1, 2.3, 3.9], 0.07, 0.16);
  chargingHandle(HANDLING.marksman, 0.08)(g, t + 0.26);
};

/** PDW top magazine: latch, slides back along the receiver, lifted off. */
const pdwMagOut: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 4000, 0.004, 0.65);
  k.ring(t, 2400, [1, 2.4], 0.03, 0.15);
  scrape(k, t + 0.02, 1600, 2400, 0.18, 0.45);
  k.noise(t + 0.24, { color: 'pink', filter: 'bandpass', freq: 1500, q: 1.5, decay: 0.03, peak: 0.4 });
};

/** PDW top magazine: set down, slid forward, latched. */
const pdwMagIn: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.pdw;
  k.thump(t, { f0: 200, f1: 150, pitchTime: 0.01, decay: 0.03, peak: 0.55 });
  k.noise(t, { color: 'pink', filter: 'bandpass', freq: 1500, q: 1.5, decay: 0.03, peak: 0.45 });
  scrape(k, t + 0.05, 2300, 1500, 0.15, 0.4);
  clack(k, t + 0.24, h, 0.95, 0, 1.5);
  k.click(t + 0.27, 4800, 0.003, 0.4);
};

/** Auto shotgun drum: latch, the heavy drum pulled off with the shells rattling inside. */
const drumOut: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.autoshotgun;
  k.click(t, 3600, 0.005, 0.65);
  k.ring(t, 1300 * k.j(0.05), [1, 2.4], 0.04, 0.2);
  scrape(k, t + 0.03, h.scrape, h.scrape * 0.6, 0.1, 0.5);
  k.ticks(t + 0.06, 7, 0.2, 2000, 3, 0.35);
  k.thump(t + 0.16, { f0: 150, f1: 95, pitchTime: 0.015, decay: 0.05, peak: 0.45 });
};

const drumIn: Recipe = (g, t) => {
  const k = kitOf(g);
  const h = HANDLING.autoshotgun;
  scrape(k, t, h.scrape * 0.7, h.scrape * 1.1, 0.06, 0.45);
  clack(k, t + 0.08, h, 1.3, 0, 2.4);
  k.ticks(t + 0.09, 8, 0.18, 2100, 3, 0.35);
  k.click(t + 0.12, 4600, 0.004, 0.5);
};

/** Side-charger (vector): ratchets back, released. */
function sideCharger(h: HandlingProfile): Recipe {
  return (g, t) => {
    const k = kitOf(g);
    ratchet(k, t, 4, 0.02, 0.02, 3600, 0.45, -0.15);
    clack(k, t + 0.12, h, 1.1, 0, 2);
  };
}

// ---------------------------------------------------------------------------
// Shared: tails, dry clicks, charge cues
// ---------------------------------------------------------------------------

/** Energy weapons: a dark synthetic bloom with a falling "wom" and a faint shimmer. */
const tailEnergy: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'brown', filter: 'lowpass', freq: 420 * k.j(0.1), sweepTo: 120, attack: 0.012, decay: 0.45, peak: 1 });
  for (const pan of [-0.45, 0.45]) {
    k.noise(t + 0.012 + k.rng.next() * 0.02, {
      color: 'pink',
      filter: 'bandpass',
      freq: 900 * k.j(0.15),
      sweepTo: 300,
      q: 1.5,
      attack: 0.008,
      decay: 0.3,
      peak: 0.3,
      pan,
    });
  }
  k.tone(t + 0.005, 'sine', 180 * k.j(0.08), 70, 0.01, 0.35, 0.25);
  k.noise(t + 0.02, { color: 'white', filter: 'bandpass', freq: 6000, q: 3, attack: 0.02, decay: 0.2, peak: 0.06 });
};

/** Launchers: a hollow low bloom and a soft whump. */
const tailExplosive: Recipe = (g, t) => {
  const k = kitOf(g);
  k.noise(t, { color: 'brown', filter: 'lowpass', freq: 280 * k.j(0.1), sweepTo: 80, attack: 0.015, decay: 0.6, peak: 1 });
  for (const pan of [-0.4, 0.4]) {
    k.noise(t + 0.015 + k.rng.next() * 0.02, {
      color: 'pink',
      filter: 'bandpass',
      freq: 400 * k.j(0.15),
      sweepTo: 200,
      q: 2,
      attack: 0.01,
      decay: 0.3,
      peak: 0.35,
      pan,
    });
  }
  k.thump(t + 0.02, { f0: 70, f1: 40, pitchTime: 0.1, decay: 0.3, peak: 0.5 });
};

/** Empty energy cell: trigger click + an error buzz with a fizz. */
const energyDry: Recipe = (g, t) => {
  const k = kitOf(g);
  k.click(t, 4200 * k.j(0.05), 0.004, 0.6);
  k.tone(t + 0.004, 'square', 196, 190, 0.002, 0.06, 0.25, 0, 1800);
  k.noise(t + 0.004, { color: 'white', filter: 'bandpass', freq: 5000, q: 1.5, decay: 0.03, peak: 0.15 });
};

/** Full charge: a bright lock-on double ping with a sparkle. */
const chargeFull: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sine', 2400, 2400, 0.001, 0.08, 0.5, -0.15);
  k.tone(t + 0.07, 'sine', 3200, 3200, 0.001, 0.12, 0.5, 0.15);
  k.tone(t + 0.07, 'sine', 4800, 4800, 0.001, 0.06, 0.12, 0.15);
  k.crackle(t + 0.02, 0.08, 80, 7000, 3, 0.15, 0.6);
};

/** A charge that ends without a shot: power-down whine, fizzle and a puff. */
const chargeFizzle: Recipe = (g, t) => {
  const k = kitOf(g);
  k.tone(t, 'sawtooth', 900, 120, 0.002, 0.25, 0.3, 0, 2400);
  k.fm(t, 500, 1.5, 3, 0.002, 0.2, 0.2, 0, 60);
  k.ticks(t, 8, 0.3, 3500, 4, 0.3, 0.3);
  k.noise(t + 0.02, { color: 'pink', filter: 'bandpass', freq: 800, q: 1, decay: 0.1, peak: 0.3 });
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type Def = SynthDef;

function fireDef(duration: number, recipe: Recipe, variants: number = FV, level = 1): Def {
  return { variants, duration, channels: 2, level, recipe };
}

function mechDef(duration: number, recipe: Recipe, level = 0.68): Def {
  return { variants: 2, duration, channels: 2, level, recipe };
}

function step(duration: number, recipe: Recipe, level = 0.85, variants = 1): Def {
  return { variants, duration, channels: 1, level, recipe };
}

function equip(duration: number, recipe: Recipe, level = 0.72): Def {
  return { variants: 1, duration, channels: 1, level, recipe };
}

const H = HANDLING;

const BALLISTIC_DEFS = {
  // --- RM-44 „Richter“ ---
  'weapon.revolver.fire': fireDef(0.5, gunshot(GUN.revolver), SV),
  'weapon.revolver.mech': mechDef(0.22, revolverMech, 0.6),
  'weapon.revolver.equip': equip(0.5, revolverEquip),
  'weapon.revolver.magOut': step(0.5, revolverMagOut),
  'weapon.revolver.magIn': step(0.3, revolverMagIn),
  'weapon.revolver.boltRelease': step(0.3, revolverClose, 0.95),
  // --- MP-3 „Hornisse“ ---
  'weapon.machinepistol.fire': fireDef(0.18, gunshot(GUN.machinepistol), FV + 1),
  'weapon.machinepistol.mech': mechDef(0.1, cycle(CYCLE.machinepistol), 0.55),
  'weapon.machinepistol.equip': equip(0.3, machinepistolEquip),
  'weapon.machinepistol.magOut': step(0.22, magOut(H.machinepistol), 0.8),
  'weapon.machinepistol.magIn': step(0.22, magIn(H.machinepistol), 0.9),
  'weapon.machinepistol.boltRelease': step(0.2, snap(H.machinepistol), 0.95),
  // --- SK-5 „Viper“ ---
  'weapon.smg.fire': fireDef(0.22, gunshot(GUN.smg), FV),
  'weapon.smg.mech': mechDef(0.12, cycle(CYCLE.smg), 0.62),
  'weapon.smg.equip': equip(0.36, smgEquip),
  'weapon.smg.magOut': step(0.24, magOut(H.smg), 0.82),
  'weapon.smg.magIn': step(0.24, magIn(H.smg), 0.92),
  'weapon.smg.boltRelease': step(0.3, chargingHandle(H.smg, 0.1, true), 1),
  // --- PDW-50 „Sturmwind“ ---
  'weapon.pdw.fire': fireDef(0.2, gunshot(GUN.pdw), FV),
  'weapon.pdw.mech': mechDef(0.1, cycle(CYCLE.pdw), 0.55),
  'weapon.pdw.equip': equip(0.38, pdwEquip),
  'weapon.pdw.magOut': step(0.3, pdwMagOut, 0.8),
  'weapon.pdw.magIn': step(0.36, pdwMagIn, 0.9),
  'weapon.pdw.boltRelease': step(0.3, chargingHandle(H.pdw, 0.09), 0.95),
  // --- KV-9 „Kolibri“ ---
  'weapon.vector.fire': fireDef(0.22, gunshot(GUN.vector), FV + 1),
  'weapon.vector.mech': mechDef(0.13, cycle(CYCLE.vector), 0.66),
  'weapon.vector.equip': equip(0.36, vectorEquip),
  'weapon.vector.magOut': step(0.24, magOut(H.vector), 0.82),
  'weapon.vector.magIn': step(0.24, magIn(H.vector), 0.92),
  'weapon.vector.boltRelease': step(0.3, sideCharger(H.vector), 0.95),
  // --- BR-3 „Triade“ ---
  'weapon.burstrifle.fire': fireDef(0.32, gunshot(GUN.burstrifle), FV + 1),
  'weapon.burstrifle.mech': mechDef(0.11, cycle(CYCLE.burstrifle), 0.62),
  'weapon.burstrifle.equip': equip(0.45, burstrifleEquip),
  'weapon.burstrifle.magOut': step(0.24, magOut(H.burstrifle), 0.85),
  'weapon.burstrifle.magIn': step(0.24, magIn(H.burstrifle), 0.95),
  'weapon.burstrifle.boltRelease': step(0.24, snap(H.burstrifle, 0.03), 1),
  // --- SR-17 „Hammerschlag“ ---
  'weapon.battlerifle.fire': fireDef(0.5, gunshot(GUN.battlerifle), SV),
  'weapon.battlerifle.mech': mechDef(0.15, cycle(CYCLE.battlerifle), 0.7),
  'weapon.battlerifle.equip': equip(0.5, battlerifleEquip),
  'weapon.battlerifle.magOut': step(0.26, magOut(H.battlerifle), 0.88),
  'weapon.battlerifle.magIn': step(0.26, magIn(H.battlerifle), 1),
  'weapon.battlerifle.boltRelease': step(0.34, chargingHandle(H.battlerifle, 0.12), 1),
  // --- AS-20 „Mahlstrom“ ---
  'weapon.autoshotgun.fire': fireDef(0.5, gunshot(GUN.autoshotgun), FV),
  'weapon.autoshotgun.mech': mechDef(0.2, cycle(CYCLE.autoshotgun), 0.72),
  'weapon.autoshotgun.equip': equip(0.5, autoshotgunEquip),
  'weapon.autoshotgun.magOut': step(0.3, drumOut, 0.9),
  'weapon.autoshotgun.magIn': step(0.3, drumIn, 1),
  'weapon.autoshotgun.boltRelease': step(0.36, chargingHandle(H.autoshotgun, 0.13), 1),
  // --- DB-2 „Zwilling“ ---
  'weapon.doublebarrel.fire': fireDef(0.8, gunshot(GUN.doublebarrel), SV),
  'weapon.doublebarrel.mech': mechDef(0.5, doubleBarrelMech, 0.55),
  'weapon.doublebarrel.equip': equip(0.5, doublebarrelEquip),
  'weapon.doublebarrel.magOut': step(0.5, doublebarrelOpen, 0.9),
  'weapon.doublebarrel.magIn': step(0.3, doublebarrelLoad, 0.85),
  'weapon.doublebarrel.boltRelease': step(0.35, doublebarrelClose, 1),
  // --- LM-60 „Bollwerk“ ---
  'weapon.lmg.fire': fireDef(0.42, gunshot(GUN.lmg), FV),
  'weapon.lmg.mech': mechDef(0.15, cycle(CYCLE.lmg), 0.66),
  'weapon.lmg.equip': equip(0.8, lmgEquip),
  'weapon.lmg.magOut': step(0.8, lmgMagOut, 0.9),
  'weapon.lmg.magIn': step(0.8, lmgMagIn, 0.95),
  'weapon.lmg.boltRelease': step(0.6, lmgClose, 1),
  // --- RX-6 „Kreissäge“ ---
  'weapon.minigun.fire': fireDef(0.14, gunshot(GUN.minigun), FV + 1, 0.95),
  'weapon.minigun.mech': mechDef(0.06, minigunMech, 0.45),
  'weapon.minigun.equip': equip(1, minigunEquip, 0.78),
  'weapon.minigun.magOut': step(0.5, minigunMagOut, 0.9),
  'weapon.minigun.magIn': step(0.55, minigunMagIn, 0.95),
  'weapon.minigun.boltRelease': step(0.45, minigunPowerOn, 0.85),
  // --- HX-50 „Richtfeuer“ ---
  'weapon.sniper.fire': fireDef(1.3, gunshot(GUN.sniper), SV),
  'weapon.sniper.mech': mechDef(0.4, sniperMech, 0.5),
  'weapon.sniper.pump': { variants: 2, duration: 0.75, channels: 2, level: 0.85, recipe: boltAction(0.3, 0.2) },
  'weapon.sniper.equip': equip(0.65, sniperEquip),
  'weapon.sniper.magOut': step(0.26, magOut(H.sniper), 0.85),
  'weapon.sniper.magIn': step(0.26, magIn(H.sniper), 0.95),
  'weapon.sniper.boltRelease': step(0.42, boltAction(0, 0.1), 1),
  // --- DM-8 „Falke“ ---
  'weapon.marksman.fire': fireDef(0.55, gunshot(GUN.marksman), SV),
  'weapon.marksman.mech': mechDef(0.11, cycle(CYCLE.marksman), 0.62),
  'weapon.marksman.equip': equip(0.5, marksmanEquip),
  'weapon.marksman.magOut': step(0.26, magOut(H.marksman), 0.85),
  'weapon.marksman.magIn': step(0.26, magIn(H.marksman), 0.95),
  'weapon.marksman.boltRelease': step(0.3, chargingHandle(H.marksman, 0.09), 1),
  // --- shared ---
  'weapon.tail.energy': { variants: 2, duration: 0.9, channels: 2, level: 0.72, recipe: tailEnergy },
  'weapon.tail.explosive': { variants: 2, duration: 1, channels: 2, level: 0.8, recipe: tailExplosive },
  'weapon.energy.dry': { variants: 2, duration: 0.12, channels: 1, level: 0.75, recipe: energyDry },
  'weapon.charge.full': { variants: 1, duration: 0.32, channels: 2, level: 0.7, recipe: chargeFull },
  'weapon.charge.fizzle': { variants: 2, duration: 0.45, channels: 2, level: 0.7, recipe: chargeFizzle },
} as const satisfies Record<string, SynthDef>;

/** Every M5 sound: weapons (ballistic + energy/wonder), elements, gear. */
export const ARSENAL_SYNTH_DEFS = {
  ...BALLISTIC_DEFS,
  ...ENERGY_WEAPON_SYNTH_DEFS,
  ...ELEMENT_SYNTH_DEFS,
  ...GEAR_SYNTH_DEFS,
} as const satisfies Record<string, SynthDef>;

export type ArsenalSynthId = keyof typeof ARSENAL_SYNTH_DEFS;

// ---------------------------------------------------------------------------
// Aliases (convention ids without a recipe of their own → the closest recipe)
// ---------------------------------------------------------------------------

const STEPS = ['magOut', 'magIn', 'boltRelease', 'shellIn', 'pump'] as const;

/** Dry click per weapon family (the per-weapon id `weapon.<id>.dry` is preferred by the bridge). */
function dryFor(id: string): string {
  const def = getWeaponDef(id);
  if (!def) return 'weapon.rifle.dry';
  switch (def.category) {
    case 'energy':
    case 'wonder':
    case 'launcher':
      return 'weapon.energy.dry';
    case 'pistol':
      return 'weapon.pistol.dry';
    case 'shotgun':
      return 'weapon.shotgun.dry';
    default:
      return 'weapon.rifle.dry';
  }
}

/** A reload step a weapon has no recipe for: its closest mechanism (never silent). */
function stepFallback(id: string, step: (typeof STEPS)[number], has: (id: string) => boolean): string {
  const own = (s: string): string | null => (has(`weapon.${id}.${s}`) ? `weapon.${id}.${s}` : null);
  switch (step) {
    case 'shellIn':
      return own('magIn') ?? 'weapon.shotgun.shellIn';
    case 'pump':
      return own('boltRelease') ?? 'weapon.shotgun.pump';
    case 'boltRelease':
      return own('pump') ?? 'weapon.rifle.boltRelease';
    case 'magOut':
      return 'weapon.rifle.magOut';
    case 'magIn':
      return own('shellIn') ?? 'weapon.rifle.magIn';
  }
}

let aliasTable: Map<string, string> | null = null;

/**
 * Alias table of the M5 ids (built once): per-weapon reload steps and dry clicks of every roster
 * weapon, element / gear convention ids (elementSynth / gearSynth). `known` tells whether an id has
 * a recipe (synth.ts passes its SYNTH_DEFS check), so M2 recipes and aliases are never shadowed.
 */
function buildAliases(known: (id: string) => boolean): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of WEAPON_IDS) {
    for (const step of STEPS) {
      const conv = `weapon.${id}.${step}`;
      if (!known(conv)) m.set(conv, stepFallback(id, step, known));
    }
    const dry = `weapon.${id}.dry`;
    if (!known(dry)) m.set(dry, dryFor(id));
  }
  for (const [from, to] of Object.entries(ELEMENT_SYNTH_ALIASES)) if (!known(from)) m.set(from, to);
  for (const [from, to] of Object.entries(GEAR_SYNTH_ALIASES)) if (!known(from)) m.set(from, to);
  return m;
}

/**
 * M5 alias target for `id` (a recipe id), or null. Pattern fallbacks: `explosion.<el>[.small]` of an
 * element without a recipe → the physical blast, `field.<kind>.<el>` → the kind's default field,
 * `projectile.<x>.flight` → the grenade whirr, `ability.<x>` → the generic activation.
 */
export function m5SynthAlias(id: string, known: (id: string) => boolean): string | null {
  aliasTable ??= buildAliases(known);
  const a = aliasTable.get(id);
  if (a !== undefined) return a;
  if (id.startsWith('explosion.')) return id.endsWith('.small') ? 'explosion.physical.small' : 'explosion.physical';
  if (id.startsWith('field.pull.')) return 'field.pull.void';
  if (id.startsWith('field.slow.')) return 'field.slow.ice';
  if (id.startsWith('field.damage.')) return 'field.damage.fire';
  if (id.startsWith('projectile.') && id.endsWith('.flight')) return 'projectile.grenade.flight';
  if (id.startsWith(AUDIO.arsenal.abilities.prefix)) return AUDIO.arsenal.abilities.fallback;
  return null;
}
