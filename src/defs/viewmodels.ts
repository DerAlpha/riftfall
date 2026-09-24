/**
 * First-person weapon viewmodels: per-weapon poses, part choreography and art palette.
 * Positions in meters (viewmodel camera space: +X right, +Y up, −Z forward), angles in DEGREES,
 * times in seconds. Rotations are XYZ Euler: +X pitches the muzzle up, +Y turns it left,
 * +Z rolls the top to the left.
 *
 * Gameplay timing (reload markers, equip/inspect/melee durations, the per-shot visual kick
 * peaks, muzzle light color) comes from defs/weapons.ts; this file only shapes the motion.
 * Model ids equal weapon ids. A weapon without an entry here shows the placeholder device.
 */
import type { ReloadStep } from './weapons';
import { LONG_GUN_LOWERED, PUMP_CYCLE, PUMP_FIRE_DELAY, TRIGGER_PULL, V } from './viewmodelParts';
import { M5_VIEWMODELS } from './viewmodelData';

export { LONG_GUN_LOWERED, PUMP_CYCLE, PUMP_FIRE_DELAY, TRIGGER_PULL, V } from './viewmodelParts';

export type EaseName = 'linear' | 'in' | 'out' | 'inOut' | 'outBack' | 'snap';

export interface Vec3Def {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Position (m) + rotation (DEGREES); missing halves are zero. */
export interface PoseDef {
  readonly pos?: Vec3Def;
  readonly rot?: Vec3Def;
}

/** A pose on a normalized 0..1 timeline (rest is implied before the first / after the last key). */
export interface PoseKeyDef extends PoseDef {
  readonly t: number;
}

/**
 * Motion of one named part, offsets in the part's local frame (see partMotion.ts).
 * 'pulse' = rest → pose → rest on top; 'tween' = move the persistent base offset.
 */
export interface PartMotionDef {
  readonly part: string;
  readonly type: 'pulse' | 'tween';
  readonly pose: PoseDef;
  /** Tween only: jump here first (default: continue from the current offset). */
  readonly from?: PoseDef;
  readonly delay?: number;
  /** Tween duration / pulse attack. */
  readonly duration: number;
  readonly hold?: number;
  readonly release?: number;
  readonly ease?: EaseName;
  readonly releaseEase?: EaseName;
  readonly show?: boolean;
  readonly hideAtEnd?: boolean;
  /**
   * Reload-step motions only: start this long BEFORE the marker (s). The animator schedules it
   * from the weapon's known marker times, so e.g. a magazine arrives exactly on its seating click
   * instead of starting to move when the sound already played. Motions without a lead start on
   * the weapon:reloadStep event.
   */
  readonly lead?: number;
}

/** Whole-weapon impulse: the kick springs first peak at `pose`, `delay` seconds after the trigger. */
export interface DelayedImpulseDef {
  readonly delay: number;
  readonly pose: PoseDef;
}

export interface PoseSpringDef {
  readonly posStiffness: number;
  readonly posDamping: number;
  readonly rotStiffness: number;
  readonly rotDamping: number;
}

/**
 * Pose keys over the normalized reload duration. `markers` are the normalized marker times the
 * keys were authored against: at runtime the track is time-warped (piecewise linear) so each of
 * them lands on the weapon's ACTUAL marker (WEAPONS reload steps), so retiming a reload in
 * defs/weapons keeps the choreography in sync without touching these keys.
 */
export interface ReloadTrackDef {
  readonly markers: Readonly<Partial<Record<ReloadStep, number>>>;
  readonly keys: readonly PoseKeyDef[];
}

/** Magazine reloads: one pose track per reload kind. */
export interface ReloadTimelineDef {
  readonly style: 'timeline';
  readonly tactical: ReloadTrackDef;
  readonly empty: ReloadTrackDef;
}

/**
 * Shell-by-shell reloads: blend into `hold` over `introTime`, stay while shells go in, blend out
 * over `outroTime` once the tube is full (last shell + the rest of its cycle) or the chambering
 * pump starts. A reload that ends without either (fire interrupt, sprint, switch) blends out
 * over VIEWMODEL_ANIM.cancelOutroTime – the weapon is ready at that point.
 */
export interface ReloadLoopDef {
  readonly style: 'loop';
  readonly hold: PoseDef;
  readonly introTime: number;
  readonly outroTime: number;
}

/**
 * Continuous part motion driven by weapon state (M5): minigun barrels spinning with `weapon:spin`,
 * railgun coils sliding/glowing with `weapon:charge`, a beam emitter while `weapon:beam` is active,
 * vents opening with barrel heat. The source value (0..1, eased) scales `pose` (added to the part's
 * offset), spins the part at `spin.degPerSec × value` and boosts the accent glow.
 */
export interface ViewmodelDriverDef {
  readonly part: string;
  readonly source: 'spin' | 'charge' | 'beam' | 'heat';
  readonly pose?: PoseDef;
  readonly spin?: { readonly axis: 'x' | 'y' | 'z'; readonly degPerSec: number };
  /** Extra accent emissive intensity at source 1. */
  readonly accentBoost?: number;
  /** Easing of the source value (1/s towards the target), default instant. */
  readonly response?: number;
}

export interface WeaponViewmodelDef {
  /** Uniform model scale (default 1 = real-world meters); sockets, pivot and ADS follow it. */
  readonly scale?: number;
  /** Resting hip pose of the model origin (grip pivot) relative to the viewmodel camera. */
  readonly hip: PoseDef & { readonly pos: Vec3Def };
  /** Full ADS: the sight socket sits on the view axis this far in front of the eye (m). */
  readonly adsEyeDistance: number;
  /** Fine-tune of the derived ADS offset (m). */
  readonly adsNudge?: Vec3Def;
  /** Added at full sprint/slide (replaces VIEWMODEL.sprintLower for weapons). */
  readonly sprint: PoseDef;
  /**
   * Fully holstered pose (added to the hip pose; default VIEWMODEL_ANIM.equip.lowered). Long guns
   * need their own: pitching the muzzle far down swings the stock up through the view.
   */
  readonly lowered?: PoseDef;
  /** Model-space pivot the animation layer rotates around (≈ balance point of the weapon). */
  readonly pivot: Vec3Def;
  /** Springs for the per-shot kick and every other impulse (reload thumps, melee hits). */
  readonly kickSpring: PoseSpringDef;
  /** Visual kick scale at full ADS (the sight must stay usable). */
  readonly adsKickScale: number;
  /** Sustained-fire drift (0..1 accumulator → `pose`), rises `perShot`, decays `decay`/s. */
  readonly sustained: { readonly perShot: number; readonly decay: number; readonly pose: PoseDef };
  /** Barrel heat glow (0..1): added per shot, cools at `decay`/s. */
  readonly heat: { readonly perShot: number; readonly decay: number };
  readonly fire: readonly PartMotionDef[];
  /** Replaces `fire` for the shot that empties the magazine (slide/bolt lock back). */
  readonly fireLast: readonly PartMotionDef[];
  readonly dryFire: readonly PartMotionDef[];
  /** Whole-weapon impulses after each shot on top of the visual kick (pump rack, ...). */
  readonly fireImpulses: readonly DelayedImpulseDef[];
  /** Parts `fireLast` latches: they stay put while the magazine is empty. */
  readonly lockParts: readonly string[];
  readonly reload: ReloadTimelineDef | ReloadLoopDef;
  /** Part motions per reload marker (weapon:reloadStep). */
  readonly reloadSteps: Readonly<Partial<Record<ReloadStep, readonly PartMotionDef[]>>>;
  readonly reloadImpulses: Readonly<Partial<Record<ReloadStep, readonly DelayedImpulseDef[]>>>;
  /** Overrides VIEWMODEL_ANIM.inspect. */
  readonly inspect?: readonly PoseKeyDef[];
  /** The rig's accent point light (model space) – spill of the weapon's glowing accents. */
  readonly accentLight: {
    readonly pos: Vec3Def;
    readonly color: number;
    readonly intensity: number;
    readonly distance: number;
  };
  /** Emissive intensities (> 1 so they pass the bloom threshold). */
  readonly glow: {
    readonly accent: number;
    readonly readout: number;
    readonly sight: number;
    /** Heat vents at heat 1 (0 when cold). */
    readonly heat: number;
  };
  /** Continuous state-driven motions (M5). */
  readonly drivers?: readonly ViewmodelDriverDef[];
}

export const VIEWMODELS = {
  pistol: {
    hip: { pos: V(0.125, -0.125, -0.31), rot: V(0, 3, 0) },
    adsEyeDistance: 0.21,
    sprint: { pos: V(-0.01, -0.035, 0.03), rot: V(-32, 12, -10) },
    pivot: V(0, 0.012, -0.03),
    kickSpring: { posStiffness: 380, posDamping: 24, rotStiffness: 300, rotDamping: 21 },
    adsKickScale: 0.45,
    sustained: { perShot: 0.18, decay: 2.2, pose: { pos: V(0, 0.003, 0.006), rot: V(1.5, 0, 0) } },
    heat: { perShot: 0.1, decay: 0.3 },
    fire: [
      {
        part: 'slide',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.034) },
        duration: 0.026,
        hold: 0.006,
        release: 0.07,
        ease: 'snap',
        releaseEase: 'in',
      },
      {
        part: 'hammer',
        type: 'pulse',
        pose: { rot: V(38, 0, 0) },
        duration: 0.026,
        hold: 0.01,
        release: 0.06,
        ease: 'snap',
      },
      TRIGGER_PULL,
    ],
    fireLast: [
      { part: 'slide', type: 'tween', pose: { pos: V(0, 0, 0.034) }, duration: 0.026, ease: 'snap' },
      { part: 'hammer', type: 'tween', pose: { rot: V(38, 0, 0) }, duration: 0.026, ease: 'snap' },
      TRIGGER_PULL,
    ],
    dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, release: 0.05 }],
    fireImpulses: [],
    lockParts: ['slide', 'hammer'],
    reload: {
      style: 'timeline',
      // The pistol rides low: it is lifted towards the center and rolled so the magwell (and the
      // magazine sliding in from below) stays on screen.
      tactical: {
        markers: { magOut: 0.215, magIn: 0.63 },
        keys: [
          { t: 0.12, pos: V(-0.035, 0.06, -0.02), rot: V(4, 12, -30) },
          { t: 0.215, pos: V(-0.04, 0.07, -0.025), rot: V(8, 14, -36) },
          { t: 0.45, pos: V(-0.045, 0.065, -0.03), rot: V(2, 16, -40) },
          { t: 0.63, pos: V(-0.045, 0.07, -0.03), rot: V(5, 14, -38) },
          { t: 0.84, pos: V(-0.012, 0.012, -0.006), rot: V(2, 4, -10) },
        ],
      },
      empty: {
        markers: { magOut: 0.16, magIn: 0.5, boltRelease: 0.76 },
        keys: [
          { t: 0.1, pos: V(-0.035, 0.06, -0.02), rot: V(4, 12, -30) },
          { t: 0.16, pos: V(-0.04, 0.07, -0.025), rot: V(8, 14, -36) },
          { t: 0.36, pos: V(-0.045, 0.065, -0.03), rot: V(2, 16, -40) },
          { t: 0.5, pos: V(-0.045, 0.07, -0.03), rot: V(5, 14, -38) },
          // Roll over to the left flank: the locked slide slams home in view.
          { t: 0.65, pos: V(-0.045, 0.045, -0.012), rot: V(4, 26, 16) },
          { t: 0.76, pos: V(-0.04, 0.05, -0.012), rot: V(7, 22, 13) },
          { t: 0.9, pos: V(-0.01, 0.006, 0.0), rot: V(2, 6, 3) },
        ],
      },
    },
    // Synced to the reload sounds (audio/weaponSynth): the magazine seats on the magIn click
    // 55 ms after the marker, the slide slams home ON the slide-release marker.
    reloadSteps: {
      magOut: [
        {
          part: 'magazine',
          type: 'tween',
          pose: { pos: V(0, -0.17, 0.01), rot: V(-10, 0, 6) },
          duration: 0.2,
          ease: 'in',
          hideAtEnd: true,
        },
      ],
      magIn: [
        {
          part: 'magazine',
          type: 'tween',
          from: { pos: V(0, -0.11, 0.004), rot: V(-6, 0, 0) },
          pose: {},
          lead: 0.11,
          duration: 0.165,
          ease: 'inOut',
          show: true,
        },
      ],
      boltRelease: [
        { part: 'slide', type: 'tween', pose: {}, lead: 0.035, duration: 0.035, ease: 'in' },
        { part: 'hammer', type: 'tween', pose: {}, lead: 0.035, duration: 0.04, ease: 'inOut' },
      ],
    },
    reloadImpulses: {
      magOut: [{ delay: 0, pose: { pos: V(0, 0.006, 0), rot: V(3, 0, -2) } }],
      magIn: [{ delay: 0.05, pose: { pos: V(0, 0.01, 0), rot: V(-4, 0, 2) } }],
      boltRelease: [{ delay: 0, pose: { pos: V(0, 0, -0.008), rot: V(3, 0, -2) } }],
    },
    accentLight: { pos: V(0, 0.03, 0.06), color: 0x46e6ff, intensity: 0.012, distance: 0.2 },
    glow: { accent: 2.2, readout: 2.4, sight: 3.5, heat: 5 },
  },
  rifle: {
    hip: { pos: V(0.135, -0.155, -0.35), rot: V(0, 2, 0) },
    adsEyeDistance: 0.2,
    sprint: { pos: V(-0.035, -0.035, 0.03), rot: V(-12, 34, -24) },
    lowered: LONG_GUN_LOWERED,
    pivot: V(0, 0.03, -0.1),
    kickSpring: { posStiffness: 540, posDamping: 34, rotStiffness: 430, rotDamping: 30 },
    adsKickScale: 0.4,
    sustained: { perShot: 0.08, decay: 1.8, pose: { pos: V(0, 0.004, 0.014), rot: V(2.6, 0, 0) } },
    heat: { perShot: 0.05, decay: 0.18 },
    fire: [
      {
        part: 'bolt',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.038) },
        duration: 0.018,
        hold: 0.004,
        release: 0.045,
        ease: 'snap',
        releaseEase: 'in',
      },
      {
        part: 'chargingHandle',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.038) },
        duration: 0.018,
        hold: 0.004,
        release: 0.045,
        ease: 'snap',
        releaseEase: 'in',
      },
      { part: 'dustCover', type: 'tween', pose: { rot: V(0, 0, -115) }, duration: 0.07, ease: 'outBack' },
      { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) }, hold: 0.015, release: 0.04 },
    ],
    fireLast: [
      { part: 'bolt', type: 'tween', pose: { pos: V(0, 0, 0.038) }, duration: 0.018, ease: 'snap' },
      { part: 'chargingHandle', type: 'tween', pose: { pos: V(0, 0, 0.038) }, duration: 0.018, ease: 'snap' },
      { part: 'dustCover', type: 'tween', pose: { rot: V(0, 0, -115) }, duration: 0.07, ease: 'outBack' },
      { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) } },
    ],
    dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
    fireImpulses: [],
    lockParts: ['bolt', 'chargingHandle'],
    reload: {
      style: 'timeline',
      tactical: {
        markers: { magOut: 0.23, magIn: 0.66 },
        keys: [
          { t: 0.13, pos: V(-0.03, 0.02, 0.03), rot: V(10, 14, -28) },
          { t: 0.23, pos: V(-0.032, 0.026, 0.036), rot: V(13, 16, -33) },
          { t: 0.46, pos: V(-0.04, 0.008, 0.03), rot: V(6, 18, -34) },
          { t: 0.66, pos: V(-0.04, 0.016, 0.03), rot: V(9, 16, -30) },
          { t: 0.84, pos: V(-0.014, 0.005, 0.01), rot: V(3, 6, -10) },
        ],
      },
      empty: {
        markers: { magOut: 0.17, magIn: 0.5, boltRelease: 0.79 },
        keys: [
          { t: 0.1, pos: V(-0.03, 0.02, 0.03), rot: V(10, 14, -28) },
          { t: 0.17, pos: V(-0.032, 0.026, 0.036), rot: V(13, 16, -33) },
          { t: 0.36, pos: V(-0.04, 0.008, 0.03), rot: V(6, 18, -34) },
          { t: 0.5, pos: V(-0.04, 0.016, 0.03), rot: V(9, 16, -30) },
          { t: 0.66, pos: V(-0.05, 0.02, 0.012), rot: V(4, 30, 16) },
          { t: 0.79, pos: V(-0.05, 0.024, 0.014), rot: V(6, 30, 19) },
          { t: 0.92, pos: V(-0.014, 0.006, 0.004), rot: V(2, 8, 5) },
        ],
      },
    },
    // Synced to the sounds: the magazine seats on the magIn click (55 ms after the marker); the
    // charging handle hits its rear stop at +30 ms and the bolt slams home at +110 ms.
    reloadSteps: {
      magOut: [
        {
          part: 'magazine',
          type: 'tween',
          pose: { pos: V(0, -0.2, -0.03), rot: V(14, 0, -8) },
          duration: 0.22,
          ease: 'in',
          hideAtEnd: true,
        },
      ],
      magIn: [
        {
          part: 'magazine',
          type: 'tween',
          from: { pos: V(0, -0.13, -0.02), rot: V(10, 0, 0) },
          pose: {},
          lead: 0.12,
          duration: 0.175,
          ease: 'inOut',
          show: true,
        },
      ],
      boltRelease: [
        {
          part: 'chargingHandle',
          type: 'pulse',
          pose: { pos: V(0, 0, 0.014) },
          duration: 0.03,
          hold: 0.045,
          release: 0.035,
          ease: 'out',
          releaseEase: 'in',
        },
        { part: 'chargingHandle', type: 'tween', pose: {}, delay: 0.075, duration: 0.035, ease: 'in' },
        { part: 'bolt', type: 'tween', pose: {}, delay: 0.075, duration: 0.035, ease: 'in' },
      ],
    },
    reloadImpulses: {
      magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
      magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
      boltRelease: [
        { delay: 0, pose: { pos: V(0, 0, 0.006), rot: V(0, 0, 2) } },
        { delay: 0.105, pose: { pos: V(0, 0, -0.01), rot: V(3, 0, -3) } },
      ],
    },
    accentLight: { pos: V(-0.05, 0.075, -0.2), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
    glow: { accent: 2.2, readout: 2.4, sight: 9, heat: 5 },
  },
  shotgun: {
    hip: { pos: V(0.14, -0.165, -0.35), rot: V(0, 2, 0) },
    adsEyeDistance: 0.17,
    sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 34, -26) },
    lowered: LONG_GUN_LOWERED,
    pivot: V(0, 0.03, -0.12),
    kickSpring: { posStiffness: 280, posDamping: 23, rotStiffness: 210, rotDamping: 19 },
    adsKickScale: 0.5,
    sustained: { perShot: 0.5, decay: 1.6, pose: { pos: V(0, 0.004, 0.01), rot: V(2, 0, 0) } },
    heat: { perShot: 0.28, decay: 0.3 },
    fire: [TRIGGER_PULL, PUMP_CYCLE],
    fireLast: [TRIGGER_PULL, PUMP_CYCLE],
    dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, release: 0.05 }],
    // Racking the pump rocks the whole gun back, the forward stroke slams it home (on the sounds).
    fireImpulses: [
      { delay: PUMP_FIRE_DELAY + 0.04, pose: { pos: V(-0.004, -0.004, 0.012), rot: V(-3, 1, 3) } },
      { delay: PUMP_FIRE_DELAY + 0.13, pose: { pos: V(0, 0.002, -0.01), rot: V(2, 0, -2) } },
    ],
    lockParts: [],
    reload: {
      style: 'loop',
      // Lifted and rolled so the loading port (and the shells rising into it) is on screen.
      hold: { pos: V(-0.05, 0.05, 0.02), rot: V(6, 14, -38) },
      introTime: 0.28,
      outroTime: 0.26,
    },
    reloadSteps: {
      // The shell rises to the loading port and clicks past the gate ON the shellIn marker.
      shellIn: [
        {
          part: 'shell',
          type: 'tween',
          from: { pos: V(0.012, -0.07, 0.04), rot: V(35, 0, -20) },
          pose: { pos: V(0, 0, -0.05) },
          lead: 0.2,
          duration: 0.24,
          ease: 'inOut',
          show: true,
          hideAtEnd: true,
        },
      ],
      pump: [{ ...PUMP_CYCLE, delay: 0 }],
    },
    reloadImpulses: {
      shellIn: [{ delay: 0, pose: { pos: V(0, 0.006, -0.004), rot: V(-2, 0, 1.5) } }],
      pump: [
        { delay: 0.04, pose: { pos: V(-0.004, -0.004, 0.012), rot: V(-3, 1, 3) } },
        { delay: 0.13, pose: { pos: V(0, 0.002, -0.01), rot: V(2, 0, -2) } },
      ],
    },
    accentLight: { pos: V(-0.05, 0.075, -0.05), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
    glow: { accent: 2.2, readout: 2.4, sight: 5, heat: 5 },
  },
} as const satisfies Record<string, WeaponViewmodelDef>;

export function getViewmodelDef(id: string): WeaponViewmodelDef | undefined {
  if (Object.prototype.hasOwnProperty.call(VIEWMODELS, id))
    return (VIEWMODELS as Record<string, WeaponViewmodelDef>)[id];
  // M5 weapons: one def file each (defs/viewmodelData); null = not built yet (placeholder device).
  return Object.prototype.hasOwnProperty.call(M5_VIEWMODELS, id)
    ? (M5_VIEWMODELS[id] ?? undefined)
    : undefined;
}

/** Animation tuning shared by every weapon. */
export const VIEWMODEL_ANIM = {
  /** Spring that follows the choreography tracks (reload, inspect, melee, equip) – adds weight. */
  poseFollow: { posStiffness: 300, posDamping: 32, rotStiffness: 260, rotDamping: 28 },
  equip: {
    /** Fully lowered (holstered) pose, added to the hip pose (handguns; see WeaponViewmodelDef.lowered). */
    lowered: { pos: V(0.02, -0.21, 0.07), rot: V(-55, -10, 22) },
    raiseEase: 'out',
    holsterEase: 'in',
    /**
     * weapon:equipStart without a weapon:holsterStart: the part of the duration beyond the new
     * weapon's equip time lowers the shown weapon first, if it is at least this long (s).
     */
    holsterTolerance: 0.02,
    /** Upward settle when the raise completes. */
    settleImpulse: { pos: V(0, -0.006, 0.004), rot: V(-2.5, 0, 1.5) },
  },
  /** Left flank towards the player, then muzzle up with the top rolled into view, then back. */
  inspect: [
    { t: 0.14, pos: V(-0.055, 0.03, 0.03), rot: V(6, 36, -18) },
    { t: 0.42, pos: V(-0.06, 0.036, 0.032), rot: V(9, 44, -24) },
    { t: 0.58, pos: V(-0.05, 0.035, -0.05), rot: V(12, 6, 58) },
    { t: 0.82, pos: V(-0.048, 0.038, -0.055), rot: V(14, 4, 64) },
  ],
  /**
   * Weapon bash, normalized to the weapon:melee duration. `meleeStrike` is the key time of the
   * blow: the track is time-warped so it lands exactly on WEAPONS melee.hitTime.
   */
  melee: [
    { t: 0.1, pos: V(0.02, -0.004, 0.035), rot: V(6, -12, -8) },
    { t: 0.22, pos: V(-0.075, 0.024, -0.13), rot: V(-6, 18, 24) },
    { t: 0.36, pos: V(-0.07, 0.02, -0.115), rot: V(-5, 16, 21) },
    { t: 0.72, pos: V(-0.018, 0.004, -0.016), rot: V(-1, 5, 5) },
  ],
  meleeStrike: 0.22,
  meleeHitImpulse: { pos: V(0.012, 0.004, 0.022), rot: V(4, -6, -6) },
  dryFireImpulse: { pos: V(0, 0, 0.002), rot: V(0.8, 0, 0.4) },
  adsInImpulse: { pos: V(0, -0.002, 0.005), rot: V(-0.8, 0, 0) },
  adsOutImpulse: { pos: V(0, -0.004, 0), rot: V(0.6, 0, -0.8) },
  /** Tracks blend out at this rate (1/s) when cancelled (reload end, fire during inspect). */
  cancelLambda: 14,
  /** Shell-by-shell pose blend-out when the reload ends without closing first (interrupt, sprint). */
  cancelOutroTime: 0.12,
  /** A reload whose duration passed without weapon:reloadEnd ends by itself after this (s). */
  reloadEndGrace: 0.5,
  /** Slow Lissajous hand drift on top of the rig's breathing (rad/s, m, deg), scaled in ADS. */
  idle: {
    rateX: 0.73,
    rateY: 1.17,
    /** Phase offset of the vertical drift (rad) so the two axes never line up. */
    phaseY: 1.3,
    position: 0.0014,
    rotationDeg: 0.4,
    /** Pitch drift relative to the roll drift. */
    pitchRatio: 0.5,
    adsScale: 0.15,
  },
  /**
   * Muzzle flash light inside the viewmodel scene (lights the weapon itself). It sits `offset`
   * from the muzzle socket (up/back) so the barrel, handguard and sight catch the flash.
   */
  muzzleLight: { intensity: 0.5, distance: 0.9, decay: 34, offset: V(0, 0.05, 0.02) },
  /** Settle time for parts returning to rest after a reload ends (s). */
  partSettleTime: 0.08,
  /** Heat glow shimmer (rad/s) and depth (0..1). */
  heatFlicker: { rate: 23, depth: 0.12 },
  /** Accent emissive breathing (rad/s, 0..1) and the flash on each shot (added intensity). */
  accentPulse: { rate: 2.2, depth: 0.18, fireFlash: 2.5, flashDecay: 14 },
  /**
   * accessibility.reduceFlashing: per-shot accent flash and viewmodel muzzle light × this (like
   * VFX.lights.reducedFlashingScale); the heat shimmer stops.
   */
  reducedFlashScale: 0.45,
  /** Readouts blink at this rate (rad/s) down to `emptyBlinkLow` × intensity when the magazine is empty. */
  emptyBlinkRate: 9,
  emptyBlinkLow: 0.25,
  /** Magazine fraction below which readouts turn amber. */
  lowAmmoFraction: 0.3,
} as const;

/** Procedural materials/textures of the weapon models (art content, linear-light hex colors). */
export const VIEWMODEL_ART = {
  /** Wear map repeats per meter (box-projected UVs) and knurl repeats per meter. */
  uvDensity: 7,
  knurlDensity: 34,
  textures: { wearSize: 128, knurlSize: 64, knurlCells: 8, knurlStrength: 2.4, anisotropy: 4 },
  /**
   * `color` is the bare/raw color on worn edges; flat faces are darkened to `paint`.
   * Colors are sRGB hex like everywhere in three.js material setup.
   */
  materials: {
    gunmetal: { color: 0xb4bac2, paint: 0.2, metalness: 0.72, roughness: 0.5 },
    darkMetal: { color: 0x7c828a, paint: 0.3, metalness: 0.88, roughness: 0.38 },
    polymer: { color: 0x5f6468, paint: 0.5, roughness: 0.6, clearcoat: 0.35, clearcoatRoughness: 0.45 },
    accentPaint: { color: 0xc8812a, paint: 0.62, metalness: 0.2, roughness: 0.55 },
    grip: { color: 0x2a2c2f, roughness: 0.82, normalScale: 0.9 },
    brass: { color: 0xd8a650, metalness: 1, roughness: 0.32 },
    shellHull: { color: 0x9a2418, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3 },
    bore: { color: 0x060607, roughness: 0.9 },
    lens: { color: 0x6fb8ff, opacity: 0.07, roughness: 0.05 },
  },
  /** Emissive colors (sRGB hex). */
  emissive: {
    accent: 0x36e4ff,
    heat: 0xff4a0e,
    tritium: 0x74ff5c,
    redDot: 0xff2414,
    readoutOn: [60, 230, 255],
    readoutLow: [255, 160, 30],
    readoutEmpty: [255, 40, 24],
    readoutOff: [6, 14, 18],
    readoutBg: [1, 3, 4],
  },
} as const;
