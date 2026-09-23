/**
 * Training targets (calibration hall dummies) + the dissolve look used when they die.
 *
 * A dummy is a humanoid silhouette built from primitives (see world/TrainingTargets.ts): rocking
 * dome base, legs, pelvis, torso, arms, head with a visor and a glowing weakpoint core on the
 * chest. All positions are in the dummy's LOCAL frame: feet at the origin, Y up, the front faces
 * +Z (a placement with yaw 0 faces the spawn side of the hall). Meters, seconds, radians unless
 * noted; colors are LINEAR RGB (HDR multipliers where named `intensity`).
 *
 * Extension points: new target kinds are new entries in TARGET_TYPES; placements live in the level
 * defs (TEST_ROOM_LAYOUT.targets). Enemies (M3) reuse `DissolveDef` for their death effect.
 */
import type { FleshSurface, HitZone } from '../core/events';

export type Vec3Def = readonly [number, number, number];
export type RgbDef = readonly [number, number, number];

/** Sphere (b unused) or capsule (segment a → b) in the dummy's local frame. */
export interface TargetHitboxDef {
  readonly shape: 'sphere' | 'capsule';
  readonly zone: HitZone;
  readonly a: Vec3Def;
  readonly b?: Vec3Def;
  readonly radius: number;
}

/** Noise-threshold dissolve (render/materials/dissolve.ts). */
export interface DissolveDef {
  /** Seconds to dissolve out (death) and to materialize again (respawn). */
  readonly outTime: number;
  readonly inTime: number;
  /** Width of the glowing edge band in noise units (0..1). */
  readonly edgeWidth: number;
  /** HDR edge color (linear RGB × intensity; above the bloom threshold). */
  readonly edgeColor: RgbDef;
  readonly edgeIntensity: number;
  /** Materialize edge (respawn) – a different color reads as "building", not "burning". */
  readonly spawnEdgeColor: RgbDef;
  readonly spawnEdgeIntensity: number;
  /** Noise frequency (1/m, object space). */
  readonly noiseScale: number;
  /** 0..1: how much a top-to-bottom sweep replaces pure noise (0 = noise only). */
  readonly sweep: number;
}

/** Energy barrier in front of armored dummies (zone 'shield'). */
export interface TargetShieldDef {
  readonly health: number;
  /** Regeneration starts this long after the last shield hit / after it broke. */
  readonly regenDelay: number;
  /** Shield points per second while regenerating (a broken shield comes back at full). */
  readonly regenPerSecond: number;
  /** Arc in front of the dummy: radius from the body axis, half-angle (DEGREES), vertical span. */
  readonly arcRadius: number;
  readonly arcHalfAngleDeg: number;
  readonly bottom: number;
  readonly top: number;
  /** Vertical capsules approximating the arc (hitboxes) and their radius. */
  readonly capsules: number;
  readonly capsuleRadius: number;
  /** Visual panel sits this fraction of the capsule radius in front of the capsule axes. */
  readonly visualInset: number;
  /** Visual angular margin beyond the outermost capsule (DEGREES). */
  readonly visualMarginDeg: number;
  readonly color: RgbDef;
  /** HDR intensities: even fill of the panel, fresnel rim + frame, hex grid, flash on hit. */
  readonly fillIntensity: number;
  readonly rimIntensity: number;
  readonly gridIntensity: number;
  readonly hitIntensity: number;
  /** Hit flash decay (1/s), collapse / raise animation times (s). */
  readonly hitDecay: number;
  readonly collapseTime: number;
  readonly raiseTime: number;
  /** Hex grid density (cells across the panel). */
  readonly gridScale: number;
}

export interface TargetTypeDef {
  /** Player-facing name (German; debug overlay / console). */
  readonly name: string;
  readonly health: number;
  /** Surface reported for body hits (impact VFX/SFX, penetration); the barrier reports 'shield'. */
  readonly surface: FleshSurface;
  /** Damage multipliers per zone on top of the weapon's zone multipliers (missing = 1). */
  readonly zoneMultipliers: Readonly<Partial<Record<HitZone, number>>>;
  /** Full health again after this long without damage (training convenience); 0 = never. */
  readonly healthRegenDelay: number;
  readonly shield: TargetShieldDef | null;
  /** Body tint (linear RGB) and accent (chest stripe / shoulder pads). */
  readonly bodyColor: RgbDef;
  readonly accentColor: RgbDef;
  /** Weakpoint core / visor glow color. */
  readonly glowColor: RgbDef;
}

export interface TargetRailDef {
  /** Height of the rail track top above the floor: rail dummies ride on it. */
  readonly height: number;
  /** Track gauge (distance between the two bars), bar width. */
  readonly gauge: number;
  readonly barWidth: number;
  /** End stops: size (m) along/across the rail, height. */
  readonly stopLength: number;
  readonly stopHeight: number;
}

/** Shared by all dummies. */
export const TARGETS = {
  /** Visual + hitbox proportions (local frame, see header). */
  body: {
    base: { radius: 0.3, height: 0.14, segments: 20 },
    leg: { x: 0.11, bottom: 0.2, top: 0.86, radius: 0.085 },
    pelvis: { y: 0.93, halfWidth: 0.12, radius: 0.1 },
    torso: { bottom: 1.02, top: 1.34, radius: 0.2, depthScale: 0.8 },
    shoulders: { y: 1.42, halfWidth: 0.25, radius: 0.08 },
    arm: { shoulder: [0.3, 1.4, 0] as Vec3Def, hand: [0.36, 0.98, 0.04] as Vec3Def, radius: 0.066 },
    neck: { bottom: 1.44, top: 1.56, radius: 0.05 },
    head: { center: [0, 1.66, 0] as Vec3Def, radius: 0.12 },
    visor: { y: 1.675, height: 0.035, halfAngleDeg: 55 },
    /** Chest stripe (accent color) across the torso front. */
    stripe: { y: 1.12, height: 0.05 },
    core: { center: [0, 1.24, 0.15] as Vec3Def, radius: 0.062, bezelRadius: 0.084, bezelTube: 0.018 },
    /** Dark trim (base, neck, core bezel; linear RGB before the per-part tint scale). */
    trimColor: [0.05, 0.05, 0.055] as RgbDef,
    /** Tessellation of the capsule/sphere primitives. */
    capSegments: 6,
    radialSegments: 14,
  },
  hitboxes: [
    { shape: 'sphere', zone: 'head', a: [0, 1.66, 0], radius: 0.14 },
    { shape: 'sphere', zone: 'weakpoint', a: [0, 1.24, 0.16], radius: 0.08 },
    { shape: 'capsule', zone: 'body', a: [0, 1.0, 0], b: [0, 1.38, 0], radius: 0.2 },
    { shape: 'capsule', zone: 'limb', a: [0.11, 0.16, 0], b: [0.1, 0.9, 0], radius: 0.1 },
    { shape: 'capsule', zone: 'limb', a: [-0.11, 0.16, 0], b: [-0.1, 0.9, 0], radius: 0.1 },
    { shape: 'capsule', zone: 'limb', a: [0.3, 1.42, 0], b: [0.36, 0.96, 0.04], radius: 0.08 },
    { shape: 'capsule', zone: 'limb', a: [-0.3, 1.42, 0], b: [-0.36, 0.96, 0.04], radius: 0.08 },
  ] as readonly TargetHitboxDef[],
  /** Broadphase spheres (local center): `radius` encloses the body hitboxes, `shieldRadius` the barrier's. */
  bounds: { center: [0, 0.95, 0] as Vec3Def, radius: 1.05, shieldRadius: 1.25 },
  /** Aim assist / melee pull point (upper chest). */
  aimPoint: [0, 1.3, 0] as Vec3Def,
  /** Kinematic capsule that blocks the player (Rapier, ENEMY group). */
  collider: { radius: 0.3, height: 1.8 },
  /** Rocking reaction around the base: underdamped spring on the tilt angles. */
  wobble: {
    stiffness: 70,
    damping: 6.5,
    /** Angular velocity (rad/s) per point of damage, per m/s of DamageInfo.impulse, and caps. */
    perDamage: 0.035,
    perImpulse: 0.25,
    maxKick: 3.2,
    maxTilt: 0.42,
    /** Extra kick when the hit kills. */
    killKick: 4,
  },
  /** Emissive hit flash on the body (intensity at flash 1, decay 1/s) and its color. */
  hitFlash: { intensity: 1.6, decay: 9, color: [1, 0.55, 0.3] as RgbDef, weakpointBoost: 2 },
  /** Weakpoint core + visor (one glow material): base glow (HDR), breathing pulse, flash on hit. */
  core: { intensity: 6, pulseAmount: 0.25, pulseRate: 2.4, hitIntensity: 18, hitDecay: 7 },
  /** Accessibility "reduce flashing": hit-flash intensities are scaled by this (the pulse stops). */
  reducedFlashScale: 0.4,
  /**
   * Barrier panel (all shield types): arc tessellation, and the flicker while it collapses
   * (rad/s, depth 0..1 of the visibility; off with reduce flashing).
   */
  shieldPanel: { segments: 28, collapseFlickerRate: 70, collapseFlickerDepth: 0.8 },
  /**
   * Seconds a dead dummy stays gone before it materializes again. A respawn waits (re-checked every
   * tick) while the player stands inside the dummy's capsule.
   */
  respawnDelay: 2.4,
  material: { roughness: 0.52, metalness: 0.55, glowRoughness: 0.35 },
  dissolve: {
    outTime: 0.95,
    inTime: 0.6,
    edgeWidth: 0.08,
    edgeColor: [1, 0.36, 0.08],
    edgeIntensity: 14,
    spawnEdgeColor: [0.2, 0.85, 1],
    spawnEdgeIntensity: 9,
    noiseScale: 5.5,
    sweep: 0.45,
  } satisfies DissolveDef,
  rail: {
    height: 0.06,
    gauge: 0.34,
    barWidth: 0.05,
    stopLength: 0.22,
    stopHeight: 0.16,
  } satisfies TargetRailDef,
} as const;

export const TARGET_TYPES = {
  dummy: {
    name: 'Trainingspuppe',
    health: 150,
    surface: 'armor',
    zoneMultipliers: {},
    healthRegenDelay: 4,
    shield: null,
    bodyColor: [0.16, 0.17, 0.19],
    accentColor: [0.85, 0.36, 0.06],
    glowColor: [1, 0.3, 0.06],
  },
  armored: {
    name: 'Gepanzerte Puppe',
    health: 240,
    surface: 'armor',
    // Armor plates halve body/limb hits: the weakpoint core and the head are the way through.
    zoneMultipliers: { body: 0.5, limb: 0.5 },
    healthRegenDelay: 5,
    shield: {
      health: 220,
      regenDelay: 4,
      regenPerSecond: 110,
      arcRadius: 0.62,
      arcHalfAngleDeg: 40,
      bottom: 0.22,
      top: 1.86,
      capsules: 5,
      capsuleRadius: 0.13,
      visualInset: 0.5,
      visualMarginDeg: 9,
      color: [0.3, 0.8, 1],
      fillIntensity: 0.05,
      rimIntensity: 1.6,
      gridIntensity: 0.3,
      hitIntensity: 2.2,
      hitDecay: 6,
      collapseTime: 0.35,
      raiseTime: 0.5,
      gridScale: 9,
    },
    bodyColor: [0.2, 0.22, 0.25],
    accentColor: [0.12, 0.55, 0.85],
    glowColor: [0.25, 0.75, 1],
  },
  // Organic stand-ins for the M3 enemies: flesh/slime hits play their splatter (blood / slime
  // particles, splatter decals on the surface behind the dummy) – place them near a wall.
  flesh: {
    name: 'Bio-Puppe',
    health: 150,
    surface: 'flesh',
    zoneMultipliers: {},
    healthRegenDelay: 4,
    shield: null,
    bodyColor: [0.3, 0.07, 0.06],
    accentColor: [0.55, 0.12, 0.08],
    glowColor: [1, 0.18, 0.1],
  },
  slime: {
    name: 'Schleim-Puppe',
    health: 150,
    surface: 'slime',
    zoneMultipliers: {},
    healthRegenDelay: 4,
    shield: null,
    bodyColor: [0.08, 0.16, 0.06],
    accentColor: [0.25, 0.7, 0.1],
    glowColor: [0.35, 1, 0.25],
  },
} as const satisfies Record<string, TargetTypeDef>;

export type TargetTypeId = keyof typeof TARGET_TYPES;

export function getTargetType(id: string): TargetTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(TARGET_TYPES, id)
    ? (TARGET_TYPES as Record<string, TargetTypeDef>)[id]
    : undefined;
}

/** Where a dummy stands (level defs). Rail dummies travel `position` ↔ `rail.to`. */
export interface TargetPlacementDef {
  readonly type: TargetTypeId;
  /** Feet position on the floor (rail dummies: on the floor under the rail; they ride `TARGETS.rail.height` higher). */
  readonly position: Vec3Def;
  /** DEGREES; 0 faces +Z, positive turns left (three.js rotation.y). */
  readonly yawDeg: number;
  readonly rail?: {
    readonly to: Vec3Def;
    /** Average travel speed (m/s) and the pause at each end (s). */
    readonly speed: number;
    readonly pause: number;
  };
}
