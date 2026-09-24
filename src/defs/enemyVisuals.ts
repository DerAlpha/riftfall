/**
 * Enemy visuals: procedural creatures built from modular parts, animated in the vertex shader.
 *
 * Every enemy type is data here: material zones (palette), a small bone rig with additive motion
 * channels, the parts (capsules, ellipsoids/plates, spikes, lathes, tubes) glued to the bones,
 * attack animation timings, hitboxes, sockets and effects. `enemies/render/poseMath.ts` compiles a
 * def into ONE packed float table that the vertex shader (GPU) and the CPU pose mirror (hitboxes,
 * sockets) both interpret with the same math – so bullets hit what the player sees.
 *
 * Frame: feet at the origin, Y up, the creature faces +Z; +X is its LEFT side (`_L` names). The
 * instance yaw rotates the model about Y (three.js rotation.y: yaw 0 faces +Z, positive turns
 * left; face a point with `yaw = atan2(dx, dz)`). Meters, seconds; rotations and angles in
 * DEGREES (converted when compiled); colors are LINEAR RGB, `emissive × intensity` is HDR
 * (POSTFX.bloom: luminance above ~1.1 blooms).
 *
 * Motions (RigMotionDef) are summed per bone and channel:
 *   rotation = Ry(Σry) · Rx(Σrx) · Rz(Σrz)   (about the bone pivot, parent frame)
 *   scale    = 1 + Σs* (per axis, about the pivot), translation = Σt*
 * Signs: +rx pitches the front (+Z) DOWN, +ry turns towards +X (left), +rz rolls +X up.
 * Drivers: see RIG_DRIVERS. gait/idle/loco/attack/stagger/look fade out with `death`.
 * Mirroring (`mirror: true`, bone names end with `_L`) creates the `_R` twin at -X: ry, rz and tx
 * flip sign (look motions excepted: both twins aim the same way); the twin's gait/oscillator
 * offsets get `mirrorPhase` added (π = legs in antiphase).
 *
 * Extension points (M6: 13+ types, elites, bosses): add an entry to ENEMY_VISUALS – no code
 * changes. Attack animation ids must match the AI's attack ids (defs/enemies) so
 * `attackAnimIndex(type, id)` maps them onto EnemyPose.attackId.
 */
import type { HitZone } from '../core/events';

export type Vec3 = readonly [number, number, number];
export type Rgb = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Motion channels (order = shader codes). r*: DEGREES, t*: meters, s*: scale fraction (0.2 = +20 %). */
export const RIG_CHANNELS = ['rx', 'ry', 'rz', 'tx', 'ty', 'tz', 'sx', 'sy', 'sz', 's'] as const;
export type RigChannel = (typeof RIG_CHANNELS)[number];

/**
 * What drives a motion (order = shader codes):
 * - rest: constant offset (amp).
 * - idle: always-on oscillator (breathing, twitching): amp · sin(2π·freq·t + offset + seed).
 * - gait: wave(phase · freq + offset) · amplitude(locomotion): 0 idle → amp at walk → amp2 at run.
 * - loco: amp · window(locomotion / 2) (lean into a run / charge).
 * - attack: only while EnemyPose.attackId is this motion's attack: amp2 at the end of the wind-up,
 *   amp at the end of the strike, back to 0 at the end of the recovery (see AttackAnimDef).
 * - stagger / death / emerge: amp · window(value) (emerge uses 1 - emerge: 1 = still in the rift).
 * - lookYaw / lookPitch: the (clamped) look angle × amp (a weight, not degrees); + pitch looks up.
 * Non-gait motions with `freq` > 0 are multiplied by the oscillator (shudders, twitches).
 */
export const RIG_DRIVERS = [
  'rest',
  'idle',
  'gait',
  'loco',
  'attack',
  'stagger',
  'death',
  'emerge',
  'lookYaw',
  'lookPitch',
] as const;
export type RigDriver = (typeof RIG_DRIVERS)[number];

/** Gait waveforms: full sine, positive half-wave (leg lift), rectified (bounce twice per cycle). */
export const GAIT_WAVES = ['sin', 'pos', 'abs'] as const;
export type GaitWave = (typeof GAIT_WAVES)[number];

export interface RigMotionDef {
  readonly ch: RigChannel;
  readonly drive: RigDriver;
  /** DEGREES (r*), meters (t*), fraction (s*); look drivers: weight. gait: at walk; attack: at the strike. */
  readonly amp: number;
  /** gait: amplitude at run/charge (default amp). attack: amplitude at the end of the wind-up (default 0). */
  readonly amp2?: number;
  /** gait: whole cycles per stride (integer, default 1). Others: oscillator Hz (default 0 = none). */
  readonly freq?: number;
  /** Phase offset (radians) of the gait wave / oscillator. */
  readonly offset?: number;
  readonly wave?: GaitWave;
  /** attack driver: the AttackAnimDef id. */
  readonly attack?: string;
  /** loco / stagger / death / emerge: smoothstep window on the driver value (default [0, 1]). */
  readonly window?: readonly [number, number];
  /** false: not copied to the mirrored twin (one-armed swipes). Default true. */
  readonly mirror?: boolean;
}

export interface RigBoneDef {
  readonly name: string;
  readonly parent: string | null;
  /** Rotation/scale pivot in the rest pose (model space). */
  readonly pivot: Vec3;
  readonly motions?: readonly RigMotionDef[];
  readonly mirror?: boolean;
  /** Added to the twin's gait/oscillator offsets (radians). */
  readonly mirrorPhase?: number;
}

/** Surface look of a material zone (per-part palette entry). */
export interface EnemyZoneDef {
  /** Albedo; mixed with `color2` by a blotchy noise. */
  readonly color: Rgb;
  readonly color2: Rgb;
  /** Albedo towards the far end of a part (spike tips, claws, limb ends) and how strongly. */
  readonly tip: Rgb;
  readonly tipAmount: number;
  readonly roughness: number;
  readonly metalness: number;
  /** Wet film (clearcoat) strength 0..1, modulated by the noise. */
  readonly clearcoat: number;
  /** Emissive color × intensity (HDR). */
  readonly emissive: Rgb;
  readonly emissiveIntensity: number;
  /** 0..1 self-illumination of the whole zone (eyes, sacs, cores). */
  readonly glow: number;
  /** 0..1 depth of the glow pulse. */
  readonly pulse: number;
  /** 0..1 emissive vein network strength (travelling pulses). */
  readonly veins: number;
  /** Normal perturbation (bump) strength. */
  readonly bump: number;
  /** 0..1 dark seams between plates/scales (cellular pattern). */
  readonly cells: number;
  /** Pattern frequency (1/m). */
  readonly scale: number;
}

interface PartBaseDef {
  readonly bone: string;
  readonly zone: string;
  /** Also build the X-mirrored twin on the `_R` bone. */
  readonly mirror?: boolean;
  /** Organic lumpiness: noise displacement along the normal (m). */
  readonly lumpy?: number;
}

/** Ellipsoid; with `bend` a curved plate (thin in local Y, edges bent by bend·(x/rx)²). */
export interface EllipsoidPartDef extends PartBaseDef {
  readonly shape: 'ellipsoid';
  readonly center: Vec3;
  readonly radii: Vec3;
  /** Euler YXZ, DEGREES. */
  readonly rot?: Vec3;
  readonly bend?: number;
}

/** Tapered capsule a → b (hemispherical ends). */
export interface CapsulePartDef extends PartBaseDef {
  readonly shape: 'capsule';
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
  readonly radiusB?: number;
}

/** Cone from a (base, radius) to a sharp tip at b; `curve` offsets the midpoint (hooked claws). */
export interface SpikePartDef extends PartBaseDef {
  readonly shape: 'spike';
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
  readonly curve?: Vec3;
}

/** Lathe a → b: profile of [t 0..1 along the axis, radius]; `ellipse` scales the X / other axis. */
export interface LathePartDef extends PartBaseDef {
  readonly shape: 'lathe';
  readonly a: Vec3;
  readonly b: Vec3;
  readonly profile: readonly (readonly [number, number])[];
  readonly ellipse?: readonly [number, number];
}

/** Smooth tube through points (CatmullRom), radius tapering to radiusB; rounded ends. */
export interface TubePartDef extends PartBaseDef {
  readonly shape: 'tube';
  readonly points: readonly Vec3[];
  readonly radius: number;
  readonly radiusB?: number;
}

export type EnemyPartDef = EllipsoidPartDef | CapsulePartDef | SpikePartDef | LathePartDef | TubePartDef;

export interface AttackAnimDef {
  /** Must equal the AI attack id (defs/enemies) – the pose uses its index in this list. */
  readonly id: string;
  /** Attack progress (0..1) at which the wind-up ends and the strike ends; recovery until 1. */
  readonly windup: number;
  readonly strike: number;
  /** Extra glow on the emissive zones during the attack (telegraph), 0 = none. */
  readonly glow: number;
}

export interface EnemyHitboxDef {
  readonly bone: string;
  readonly shape: 'sphere' | 'capsule';
  readonly zone: HitZone;
  /** Rest-pose model space; `b` only for capsules. */
  readonly a: Vec3;
  readonly b?: Vec3;
  readonly radius: number;
  readonly mirror?: boolean;
}

export interface SocketAnchorDef {
  readonly bone: string;
  readonly point: Vec3;
}

export interface EnemyVisualDef {
  /** Instance slots (InstancedMesh capacity). */
  readonly capacity: number;
  readonly zones: Readonly<Record<string, EnemyZoneDef>>;
  readonly bones: readonly RigBoneDef[];
  readonly parts: readonly EnemyPartDef[];
  readonly attacks: readonly AttackAnimDef[];
  readonly hitboxes: readonly EnemyHitboxDef[];
  /** Named sockets; several anchors are averaged ('fists'). */
  readonly sockets: Readonly<Record<string, readonly SocketAnchorDef[]>>;
  /** Socket used by computeAimPoint (upper chest). */
  readonly aimSocket: string;
  /** Head/torso look limits (DEGREES). */
  readonly look: { readonly yawMaxDeg: number; readonly pitchMaxDeg: number };
  /** Culling reach beyond the rest geometry (m at scale 1): leaps, raised arms, death sprawl. */
  readonly cullMargin: number;
  readonly dissolve: {
    readonly edgeColor: Rgb;
    readonly edgeIntensity: number;
    readonly edgeWidth: number;
    readonly noiseScale: number;
  };
  /**
   * Emergence from a rift: glowing seam where the body crosses the floor (HDR color × intensity)
   * and the ground tear under the emerging enemy (radius in m at scale 1).
   */
  readonly rift: { readonly color: Rgb; readonly intensity: number; readonly tearRadius: number };
  /**
   * VFX preset ids (defs/vfx.ts) for whoever spawns them (EnemyManager / VfxBridge): the rift burst
   * at the spawn point (× spawnScale) and the gore burst at `deathSocket` when the enemy dies.
   */
  readonly effects: {
    readonly spawn: string;
    readonly spawnScale: number;
    readonly death: string;
    readonly deathScale: number;
    readonly deathSocket: string;
  };
}

// ---------------------------------------------------------------------------
// Global rendering tuning
// ---------------------------------------------------------------------------

export const ENEMY_RENDER = {
  /** Shader interpreter limits (compile-time loop bounds; the defs test enforces them). */
  maxDepth: 6,
  maxMotionsPerBone: 24,
  maxZones: 8,
  maxBones: 24,
  /** Rig table texture width (texels); rows wrap. */
  rigTextureWidth: 256,
  /** Sweep tessellation: segments around, rings per meter along a part (clamped). */
  geometry: {
    radial: 10,
    radialSmall: 7,
    /** Parts thinner than this use `radialSmall`. */
    smallRadius: 0.035,
    ringsPerMeter: 16,
    minRings: 3,
    maxRings: 16,
    /** Rings per hemispherical cap / ellipsoid half. */
    capRings: 3,
    ellipsoidRings: 8,
    /** Lumpiness noise frequency (1/m). */
    lumpScale: 9,
    seed: 1337,
  },
  /** Procedural surface texture (tileable RGBA8: blotches, cells, veins, pores). */
  texture: { size: 128, seed: 9127, cells: 7, veinCells: [4, 9] as const, veinWidth: 0.11, veinWarp: 0.16 },
  /** Animation clock wraps here (keeps float precision on the GPU). */
  timeWrap: 3600,
  /** Surface relief: bump height (m) at zone bump 1, wet film roughness. */
  bumpDepth: 0.006,
  clearcoatRoughness: 0.14,
  /**
   * Hit flash: white-hot emissive at flash 1 (HDR). Weighted mix(faceOn, 1, fresnel^power): the
   * silhouette flares while the body stays readable under sustained fire (the AI resets the flash
   * on every hit).
   */
  hitFlash: {
    color: [1, 0.86, 0.72] as Rgb,
    intensity: 2.4,
    faceOn: 0.06,
    power: 2,
    reducedFlashingScale: 0.4,
  },
  /** Elite rim light exponent (fresnel power) and HDR boost. */
  rim: { power: 3.2, intensity: 4.5 },
  /** Emissive glow left on a dying enemy (fraction at death = 1). */
  deadGlow: 0.12,
  /** Vein pulse: speed (rad/s) and travel along the body (rad/m). */
  veinPulse: { speed: 3.1, travel: 5.5, sharpness: 0.55 },
  /** Glow pulse rate (rad/s). */
  glowPulse: { speed: 2.4 },
  /** Emergence: seam band height (m) and the rift charge glow on the body while emerging. */
  emerge: { seamWidth: 0.12, charge: 0.25 },
  /**
   * Ground tears under emerging enemies (additive, volumetric layer): open while emerge < closeFrom,
   * `lift` above the floor, slit `aspect` (width / length), HDR rim and core intensities.
   */
  tears: {
    capacity: 32,
    lift: 0.012,
    aspect: 0.42,
    openUntil: 0.1,
    closeFrom: 0.72,
    rimIntensity: 9,
    coreIntensity: 1.6,
    haloIntensity: 0.18,
    coreColor: [0.35, 0.12, 1] as Rgb,
    scroll: 0.06,
  },
  /** Snap instead of interpolating when an instance jumps farther than this in one tick (m). */
  snapDistance: 3,
  /** Smallest instance scale accepted from a pose (degenerate scales break normals/culling). */
  minInstanceScale: 0.01,
  /** Warm-up instance distance in front of the camera (m). */
  warmupDistance: 3,
  /** Default rim color when a pose has none (linear). */
  defaultRimColor: [1, 0.45, 0.12] as Rgb,
} as const;

// ---------------------------------------------------------------------------
// Shared palette pieces
// ---------------------------------------------------------------------------

const PI = Math.PI;
const HALF_PI = Math.PI / 2;

/** Rift energy (linear): emergence seams, ground tears, spawn bursts. */
const RIFT_VIOLET: Rgb = [0.62, 0.3, 1];

/** Ivory bone darkening to black-red tips (spikes, claws, mandibles). */
const BONE: EnemyZoneDef = {
  color: [0.42, 0.37, 0.29],
  color2: [0.3, 0.25, 0.19],
  tip: [0.035, 0.02, 0.02],
  tipAmount: 0.85,
  roughness: 0.42,
  metalness: 0,
  clearcoat: 0.55,
  emissive: [0, 0, 0],
  emissiveIntensity: 0,
  glow: 0,
  pulse: 0,
  veins: 0,
  bump: 0.35,
  cells: 0.15,
  scale: 3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Schwärmer: fast, low insectoid quadruped. Black wet chitin plates over dark crimson flesh, a pale
 * veined abdomen with ember-glowing veins, a cluster of glowing eyes and hooked mandibles (head =
 * the headshot zone). Diagonal scuttle gait; bite (rear up, snap) and leap (crouch, pounce).
 */
const SWARMER: EnemyVisualDef = {
  capacity: 60,
  zones: {
    chitin: {
      color: [0.025, 0.024, 0.03],
      color2: [0.06, 0.045, 0.05],
      tip: [0.18, 0.14, 0.11],
      tipAmount: 0.3,
      roughness: 0.28,
      metalness: 0.12,
      clearcoat: 1,
      emissive: [1, 0.28, 0.06],
      emissiveIntensity: 1.6,
      glow: 0,
      pulse: 0,
      veins: 0.12,
      bump: 1,
      cells: 0.7,
      scale: 3.2,
    },
    flesh: {
      color: [0.12, 0.025, 0.03],
      color2: [0.24, 0.06, 0.05],
      tip: [0.07, 0.02, 0.02],
      tipAmount: 0.4,
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.85,
      emissive: [1, 0.3, 0.06],
      emissiveIntensity: 2.6,
      glow: 0,
      pulse: 0,
      veins: 0.7,
      bump: 0.7,
      cells: 0.15,
      scale: 2.8,
    },
    belly: {
      color: [0.3, 0.2, 0.17],
      color2: [0.16, 0.06, 0.055],
      tip: [0.1, 0.035, 0.03],
      tipAmount: 0.3,
      roughness: 0.26,
      metalness: 0,
      clearcoat: 1,
      emissive: [1, 0.36, 0.08],
      emissiveIntensity: 3.6,
      glow: 0.1,
      pulse: 0.5,
      veins: 1,
      bump: 0.5,
      cells: 0.1,
      scale: 2.4,
    },
    bone: BONE,
    eyes: {
      color: [0.05, 0.01, 0.005],
      color2: [0.05, 0.01, 0.005],
      tip: [0.05, 0.01, 0.005],
      tipAmount: 0,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      emissive: [1, 0.22, 0.04],
      emissiveIntensity: 7,
      glow: 1,
      pulse: 0.25,
      veins: 0,
      bump: 0,
      cells: 0,
      scale: 12,
    },
    maw: {
      color: [0.2, 0.02, 0.02],
      color2: [0.3, 0.05, 0.03],
      tip: [0.2, 0.02, 0.02],
      tipAmount: 0,
      roughness: 0.2,
      metalness: 0,
      clearcoat: 1,
      emissive: [1, 0.18, 0.05],
      emissiveIntensity: 5.5,
      glow: 0.6,
      pulse: 0.5,
      veins: 0,
      bump: 0.3,
      cells: 0,
      scale: 6,
    },
  },
  bones: [
    {
      name: 'body',
      parent: null,
      pivot: [0, 0.46, 0],
      motions: [
        { ch: 'ty', drive: 'emerge', amp: -1.1 },
        { ch: 'rx', drive: 'emerge', amp: -32, window: [0.08, 1] },
        { ch: 'ty', drive: 'gait', amp: 0.018, amp2: 0.035, freq: 2 },
        { ch: 'rz', drive: 'gait', amp: 3, amp2: 5 },
        { ch: 'ry', drive: 'gait', amp: 3, amp2: 5, offset: HALF_PI },
        { ch: 'rx', drive: 'loco', amp: 7, window: [0.5, 1] },
        { ch: 'ty', drive: 'loco', amp: -0.06, window: [0.5, 1] },
        { ch: 'ty', drive: 'idle', amp: 0.006, freq: 0.7 },
        { ch: 'rx', drive: 'idle', amp: 1.2, freq: 0.4, offset: 1 },
        { ch: 'rx', drive: 'attack', attack: 'bite', amp: 12, amp2: -9 },
        { ch: 'tz', drive: 'attack', attack: 'bite', amp: 0.16, amp2: -0.05 },
        { ch: 'ty', drive: 'attack', attack: 'leap', amp: 0.26, amp2: -0.12 },
        { ch: 'rx', drive: 'attack', attack: 'leap', amp: -16, amp2: 6 },
        { ch: 'tz', drive: 'attack', attack: 'leap', amp: 0.3, amp2: -0.06 },
        { ch: 'rx', drive: 'stagger', amp: -11 },
        { ch: 'tz', drive: 'stagger', amp: -0.06 },
        { ch: 'rz', drive: 'stagger', amp: 5, freq: 7 },
        { ch: 'ty', drive: 'death', amp: -0.27, window: [0, 0.55] },
        { ch: 'rz', drive: 'death', amp: 165, window: [0.12, 0.7] },
        { ch: 'rx', drive: 'death', amp: 10, window: [0, 0.5] },
      ],
    },
    {
      name: 'abdomen',
      parent: 'body',
      pivot: [0, 0.48, -0.2],
      motions: [
        { ch: 'ry', drive: 'gait', amp: 5, amp2: 8, offset: HALF_PI + PI },
        { ch: 's', drive: 'idle', amp: 0.035, freq: 0.9 },
        { ch: 'rx', drive: 'idle', amp: 2.5, freq: 0.5, offset: 2 },
        { ch: 'rx', drive: 'attack', attack: 'leap', amp: -12, amp2: 8 },
        { ch: 'rx', drive: 'stagger', amp: 8 },
        { ch: 'rx', drive: 'death', amp: -14, window: [0.2, 0.8] },
      ],
    },
    {
      name: 'head',
      parent: 'body',
      pivot: [0, 0.48, 0.28],
      motions: [
        { ch: 'ry', drive: 'lookYaw', amp: 0.85 },
        { ch: 'rx', drive: 'lookPitch', amp: 0.8 },
        { ch: 'rx', drive: 'gait', amp: 2, amp2: 3, freq: 2, offset: 1 },
        { ch: 'ry', drive: 'idle', amp: 3, freq: 0.23 },
        { ch: 'rx', drive: 'attack', attack: 'bite', amp: 26, amp2: -24 },
        { ch: 'rx', drive: 'attack', attack: 'leap', amp: -12, amp2: 8 },
        { ch: 'rx', drive: 'stagger', amp: -18 },
        { ch: 'ry', drive: 'stagger', amp: 8, freq: 5 },
        { ch: 'rx', drive: 'death', amp: 28, window: [0.1, 0.6] },
      ],
    },
    {
      name: 'jaw_L',
      parent: 'head',
      pivot: [0.05, 0.43, 0.5],
      mirror: true,
      motions: [
        { ch: 'ry', drive: 'idle', amp: 5, freq: 1.7 },
        { ch: 'ry', drive: 'attack', attack: 'bite', amp: -6, amp2: 38 },
        { ch: 'ry', drive: 'attack', attack: 'leap', amp: 34, amp2: 18 },
        { ch: 'ry', drive: 'stagger', amp: 18 },
        { ch: 'ry', drive: 'death', amp: 28, window: [0.2, 0.6] },
      ],
    },
    {
      name: 'legF_L',
      parent: 'body',
      pivot: [0.13, 0.46, 0.18],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'ry', drive: 'gait', amp: 16, amp2: 24 },
        { ch: 'rz', drive: 'gait', amp: 12, amp2: 18, wave: 'pos', offset: -HALF_PI },
        { ch: 'rz', drive: 'attack', attack: 'leap', amp: 22, amp2: 12 },
        { ch: 'ry', drive: 'attack', attack: 'leap', amp: -28, amp2: 0 },
        { ch: 'ry', drive: 'attack', attack: 'bite', amp: -10, amp2: 4 },
        { ch: 'rz', drive: 'stagger', amp: -6 },
        { ch: 'rz', drive: 'death', amp: -40, window: [0.2, 0.9] },
      ],
    },
    {
      name: 'shinF_L',
      parent: 'legF_L',
      pivot: [0.38, 0.7, 0.36],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rz', drive: 'gait', amp: -14, amp2: -20, wave: 'pos', offset: -HALF_PI },
        { ch: 'rz', drive: 'attack', attack: 'leap', amp: -18, amp2: 6 },
        { ch: 'rz', drive: 'death', amp: -60, window: [0.25, 0.95] },
        { ch: 'rz', drive: 'death', amp: 7, freq: 9, window: [0.7, 1] },
      ],
    },
    {
      name: 'legB_L',
      parent: 'body',
      pivot: [0.12, 0.45, -0.12],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'ry', drive: 'gait', amp: 16, amp2: 24, offset: PI },
        { ch: 'rz', drive: 'gait', amp: 12, amp2: 18, wave: 'pos', offset: HALF_PI },
        { ch: 'rz', drive: 'attack', attack: 'leap', amp: 8, amp2: 12 },
        { ch: 'ry', drive: 'attack', attack: 'leap', amp: 30, amp2: 0 },
        { ch: 'rz', drive: 'stagger', amp: -6 },
        { ch: 'rz', drive: 'death', amp: -40, window: [0.2, 0.9] },
      ],
    },
    {
      name: 'shinB_L',
      parent: 'legB_L',
      pivot: [0.4, 0.68, -0.3],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rz', drive: 'gait', amp: -14, amp2: -20, wave: 'pos', offset: HALF_PI },
        { ch: 'rz', drive: 'attack', attack: 'leap', amp: 10, amp2: 6 },
        { ch: 'rz', drive: 'death', amp: -60, window: [0.25, 0.95] },
        { ch: 'rz', drive: 'death', amp: 7, freq: 8, offset: 1.3, window: [0.7, 1] },
      ],
    },
  ],
  parts: [
    // Thorax + carapace.
    {
      shape: 'ellipsoid',
      bone: 'body',
      zone: 'flesh',
      center: [0, 0.47, 0.06],
      radii: [0.16, 0.13, 0.27],
      lumpy: 0.012,
    },
    {
      shape: 'ellipsoid',
      bone: 'body',
      zone: 'chitin',
      center: [0, 0.57, 0.22],
      radii: [0.17, 0.045, 0.14],
      rot: [-12, 0, 0],
      bend: -0.035,
    },
    {
      shape: 'ellipsoid',
      bone: 'body',
      zone: 'chitin',
      center: [0, 0.6, 0.04],
      radii: [0.19, 0.05, 0.15],
      rot: [-3, 0, 0],
      bend: -0.045,
    },
    {
      shape: 'ellipsoid',
      bone: 'body',
      zone: 'chitin',
      center: [0, 0.58, -0.14],
      radii: [0.18, 0.05, 0.14],
      rot: [8, 0, 0],
      bend: -0.045,
    },
    {
      shape: 'spike',
      bone: 'body',
      zone: 'bone',
      a: [0, 0.6, 0.19],
      b: [0, 0.73, 0.08],
      radius: 0.026,
      curve: [0, 0.02, -0.02],
    },
    {
      shape: 'spike',
      bone: 'body',
      zone: 'bone',
      a: [0, 0.63, 0.02],
      b: [0, 0.81, -0.1],
      radius: 0.032,
      curve: [0, 0.03, -0.02],
    },
    {
      shape: 'spike',
      bone: 'body',
      zone: 'bone',
      a: [0, 0.61, -0.16],
      b: [0, 0.76, -0.29],
      radius: 0.028,
      curve: [0, 0.03, -0.02],
    },
    {
      shape: 'spike',
      bone: 'body',
      zone: 'bone',
      a: [0.14, 0.55, 0.12],
      b: [0.27, 0.63, 0.02],
      radius: 0.02,
      mirror: true,
    },
    // Abdomen: pale, veined, glowing.
    {
      shape: 'ellipsoid',
      bone: 'abdomen',
      zone: 'belly',
      center: [0, 0.5, -0.42],
      radii: [0.19, 0.17, 0.26],
      lumpy: 0.014,
    },
    {
      shape: 'ellipsoid',
      bone: 'abdomen',
      zone: 'chitin',
      center: [0, 0.64, -0.34],
      radii: [0.16, 0.04, 0.12],
      rot: [10, 0, 0],
      bend: -0.05,
    },
    {
      shape: 'ellipsoid',
      bone: 'abdomen',
      zone: 'chitin',
      center: [0, 0.61, -0.53],
      radii: [0.14, 0.04, 0.11],
      rot: [24, 0, 0],
      bend: -0.05,
    },
    {
      shape: 'spike',
      bone: 'abdomen',
      zone: 'bone',
      a: [0, 0.5, -0.64],
      b: [0, 0.64, -0.9],
      radius: 0.04,
      curve: [0, 0.07, 0],
    },
    // Head: chitin skull, crest, horns, eye cluster, maw, palps.
    { shape: 'ellipsoid', bone: 'head', zone: 'chitin', center: [0, 0.47, 0.4], radii: [0.11, 0.09, 0.15] },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'chitin',
      center: [0, 0.54, 0.37],
      radii: [0.12, 0.035, 0.14],
      rot: [-8, 0, 0],
      bend: -0.03,
    },
    {
      shape: 'spike',
      bone: 'head',
      zone: 'bone',
      a: [0.06, 0.55, 0.34],
      b: [0.11, 0.67, 0.2],
      radius: 0.02,
      curve: [0.01, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.065, 0.505, 0.5],
      radii: [0.022, 0.022, 0.022],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.092, 0.475, 0.46],
      radii: [0.016, 0.016, 0.016],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.038, 0.535, 0.485],
      radii: [0.014, 0.014, 0.014],
      mirror: true,
    },
    { shape: 'ellipsoid', bone: 'head', zone: 'maw', center: [0, 0.43, 0.5], radii: [0.06, 0.04, 0.07] },
    {
      shape: 'capsule',
      bone: 'head',
      zone: 'bone',
      a: [0.07, 0.42, 0.47],
      b: [0.12, 0.33, 0.58],
      radius: 0.014,
      radiusB: 0.008,
      mirror: true,
    },
    // Mandibles.
    {
      shape: 'spike',
      bone: 'jaw_L',
      zone: 'bone',
      a: [0.05, 0.43, 0.5],
      b: [0.012, 0.42, 0.7],
      radius: 0.03,
      curve: [0.05, 0, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'jaw_L',
      zone: 'bone',
      a: [0.035, 0.41, 0.52],
      b: [0.008, 0.4, 0.63],
      radius: 0.017,
      curve: [0.02, 0, 0],
      mirror: true,
    },
    // Legs: thigh up to a high knee, spear-like shin down to the foot.
    {
      shape: 'capsule',
      bone: 'legF_L',
      zone: 'chitin',
      a: [0.13, 0.46, 0.18],
      b: [0.38, 0.7, 0.36],
      radius: 0.036,
      radiusB: 0.024,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'shinF_L',
      zone: 'chitin',
      center: [0.38, 0.7, 0.36],
      radii: [0.032, 0.028, 0.032],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shinF_L',
      zone: 'bone',
      a: [0.38, 0.7, 0.36],
      b: [0.44, 0.85, 0.4],
      radius: 0.016,
      curve: [0.01, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shinF_L',
      zone: 'chitin',
      a: [0.38, 0.7, 0.36],
      b: [0.5, 0.0, 0.56],
      radius: 0.03,
      curve: [0.05, 0.04, 0.02],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shinF_L',
      zone: 'bone',
      a: [0.43, 0.46, 0.44],
      b: [0.51, 0.54, 0.44],
      radius: 0.012,
      mirror: true,
    },
    {
      shape: 'capsule',
      bone: 'legB_L',
      zone: 'chitin',
      a: [0.12, 0.45, -0.12],
      b: [0.4, 0.68, -0.3],
      radius: 0.036,
      radiusB: 0.024,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'shinB_L',
      zone: 'chitin',
      center: [0.4, 0.68, -0.3],
      radii: [0.032, 0.028, 0.032],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shinB_L',
      zone: 'bone',
      a: [0.4, 0.68, -0.3],
      b: [0.47, 0.83, -0.36],
      radius: 0.016,
      curve: [0.01, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shinB_L',
      zone: 'chitin',
      a: [0.4, 0.68, -0.3],
      b: [0.54, 0.0, -0.52],
      radius: 0.03,
      curve: [0.05, 0.04, -0.02],
      mirror: true,
    },
  ],
  attacks: [
    { id: 'bite', windup: 0.4, strike: 0.58, glow: 1.2 },
    { id: 'leap', windup: 0.32, strike: 0.72, glow: 1.5 },
  ],
  hitboxes: [
    { bone: 'head', shape: 'sphere', zone: 'head', a: [0, 0.48, 0.44], radius: 0.14 },
    { bone: 'body', shape: 'capsule', zone: 'body', a: [0, 0.5, 0.24], b: [0, 0.52, -0.12], radius: 0.18 },
    {
      bone: 'abdomen',
      shape: 'capsule',
      zone: 'body',
      a: [0, 0.52, -0.3],
      b: [0, 0.52, -0.56],
      radius: 0.19,
    },
    {
      bone: 'legF_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.15, 0.48, 0.2],
      b: [0.38, 0.7, 0.36],
      radius: 0.06,
      mirror: true,
    },
    {
      bone: 'shinF_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.4, 0.62, 0.39],
      b: [0.5, 0.05, 0.55],
      radius: 0.055,
      mirror: true,
    },
    {
      bone: 'legB_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.14, 0.47, -0.14],
      b: [0.4, 0.68, -0.3],
      radius: 0.06,
      mirror: true,
    },
    {
      bone: 'shinB_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.42, 0.6, -0.33],
      b: [0.54, 0.05, -0.51],
      radius: 0.055,
      mirror: true,
    },
  ],
  sockets: {
    jaws: [{ bone: 'head', point: [0, 0.44, 0.66] }],
    chest: [{ bone: 'body', point: [0, 0.54, 0.14] }],
    core: [{ bone: 'body', point: [0, 0.48, 0] }],
    head: [{ bone: 'head', point: [0, 0.48, 0.44] }],
  },
  aimSocket: 'chest',
  look: { yawMaxDeg: 50, pitchMaxDeg: 35 },
  cullMargin: 0.9,
  dissolve: { edgeColor: [1, 0.36, 0.08], edgeIntensity: 12, edgeWidth: 0.08, noiseScale: 9 },
  rift: { color: RIFT_VIOLET, intensity: 14, tearRadius: 0.75 },
  effects: {
    spawn: 'rift.spawn',
    spawnScale: 0.7,
    death: 'enemy.death',
    deathScale: 0.8,
    deathSocket: 'core',
  },
};

/**
 * Spucker: hunched digitigrade biped with a swollen, glowing acid sac under its throat (the
 * weakpoint, visible from the front). Sickly olive flesh, dark chitin back plates, acid blisters.
 * Lurching gait; spit (rear up, sac inflates, snaps forward, gaping jaw) and a one-armed swipe.
 */
const SPITTER: EnemyVisualDef = {
  capacity: 16,
  zones: {
    flesh: {
      color: [0.1, 0.1, 0.055],
      color2: [0.2, 0.17, 0.085],
      tip: [0.05, 0.045, 0.03],
      tipAmount: 0.5,
      roughness: 0.4,
      metalness: 0,
      clearcoat: 0.8,
      emissive: [0.45, 1, 0.12],
      emissiveIntensity: 2.4,
      glow: 0,
      pulse: 0,
      veins: 0.6,
      bump: 0.7,
      cells: 0.18,
      scale: 2.6,
    },
    chitin: {
      color: [0.03, 0.034, 0.026],
      color2: [0.07, 0.075, 0.045],
      tip: [0.2, 0.18, 0.11],
      tipAmount: 0.3,
      roughness: 0.28,
      metalness: 0.1,
      clearcoat: 1,
      emissive: [0.45, 1, 0.12],
      emissiveIntensity: 1.5,
      glow: 0,
      pulse: 0,
      veins: 0.12,
      bump: 1,
      cells: 0.7,
      scale: 3,
    },
    sac: {
      color: [0.05, 0.16, 0.025],
      color2: [0.1, 0.26, 0.035],
      tip: [0.05, 0.16, 0.025],
      tipAmount: 0,
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      emissive: [0.42, 1, 0.1],
      emissiveIntensity: 2,
      glow: 0.85,
      pulse: 0.45,
      veins: 0.5,
      bump: 0.5,
      cells: 0.55,
      scale: 3.4,
    },
    bone: BONE,
    eyes: {
      color: [0.04, 0.05, 0.01],
      color2: [0.04, 0.05, 0.01],
      tip: [0.04, 0.05, 0.01],
      tipAmount: 0,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      emissive: [0.85, 1, 0.2],
      emissiveIntensity: 7,
      glow: 1,
      pulse: 0.2,
      veins: 0,
      bump: 0,
      cells: 0,
      scale: 12,
    },
  },
  bones: [
    {
      name: 'pelvis',
      parent: null,
      pivot: [0, 0.92, -0.1],
      motions: [
        { ch: 'ty', drive: 'emerge', amp: -2.2 },
        { ch: 'rx', drive: 'emerge', amp: -24, window: [0.1, 1] },
        { ch: 'ty', drive: 'gait', amp: 0.03, amp2: 0.06, freq: 2, offset: HALF_PI },
        { ch: 'rz', drive: 'gait', amp: 6, amp2: 9 },
        { ch: 'ry', drive: 'gait', amp: 5, amp2: 7, offset: HALF_PI },
        { ch: 'rz', drive: 'gait', amp: 1.5, amp2: 2.5, freq: 2, offset: 0.8 },
        { ch: 'rx', drive: 'loco', amp: 8, window: [0.5, 1] },
        { ch: 'ty', drive: 'idle', amp: 0.008, freq: 0.5 },
        { ch: 'rx', drive: 'stagger', amp: -8 },
        { ch: 'tz', drive: 'stagger', amp: -0.06 },
        { ch: 'ty', drive: 'death', amp: -0.5, window: [0.05, 0.5] },
        { ch: 'rx', drive: 'death', amp: 62, window: [0.35, 0.95] },
        { ch: 'ty', drive: 'death', amp: -0.16, window: [0.5, 0.95] },
        { ch: 'rz', drive: 'death', amp: 12, window: [0.3, 0.9] },
      ],
    },
    {
      name: 'spine',
      parent: 'pelvis',
      pivot: [0, 1.0, -0.1],
      motions: [
        { ch: 'rx', drive: 'gait', amp: 3, amp2: 5, freq: 2, offset: 1 },
        { ch: 'ry', drive: 'gait', amp: -5, amp2: -7, offset: HALF_PI },
        { ch: 'rx', drive: 'idle', amp: 2, freq: 0.4 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: 24, amp2: -28 },
        { ch: 'ry', drive: 'attack', attack: 'swipe', amp: -30, amp2: 24 },
        { ch: 'rz', drive: 'attack', attack: 'swipe', amp: 8, amp2: -6 },
        { ch: 'rx', drive: 'stagger', amp: -15 },
        { ch: 'rz', drive: 'stagger', amp: 4, freq: 6 },
        { ch: 'rx', drive: 'death', amp: 22, window: [0.3, 0.9] },
      ],
    },
    {
      name: 'neck',
      parent: 'spine',
      pivot: [0, 1.38, 0.3],
      motions: [
        { ch: 'ry', drive: 'lookYaw', amp: 0.35 },
        { ch: 'rx', drive: 'lookPitch', amp: 0.4 },
        { ch: 'rx', drive: 'idle', amp: 3, freq: 0.33, offset: 2 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: 18, amp2: -22 },
        { ch: 'rx', drive: 'death', amp: 20, window: [0.4, 1] },
      ],
    },
    {
      name: 'head',
      parent: 'neck',
      pivot: [0, 1.47, 0.5],
      motions: [
        { ch: 'ry', drive: 'lookYaw', amp: 0.65 },
        { ch: 'rx', drive: 'lookPitch', amp: 0.6 },
        { ch: 'ry', drive: 'idle', amp: 4, freq: 0.27 },
        { ch: 'rz', drive: 'idle', amp: 3, freq: 0.19, offset: 1 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: -14, amp2: -6 },
        { ch: 'rx', drive: 'stagger', amp: -20 },
        { ch: 'rx', drive: 'death', amp: 30, window: [0.3, 0.8] },
        { ch: 'ry', drive: 'death', amp: 25, window: [0.5, 1] },
      ],
    },
    {
      name: 'jaw',
      parent: 'head',
      pivot: [0, 1.45, 0.56],
      motions: [
        { ch: 'rx', drive: 'idle', amp: 3, freq: 0.6 },
        { ch: 'rx', drive: 'rest', amp: 4 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: 44, amp2: 14 },
        { ch: 'rx', drive: 'attack', attack: 'swipe', amp: 22, amp2: 8 },
        { ch: 'rx', drive: 'stagger', amp: 24 },
        { ch: 'rx', drive: 'death', amp: 34, window: [0.2, 0.7] },
      ],
    },
    {
      name: 'sac',
      parent: 'neck',
      pivot: [0, 1.36, 0.4],
      motions: [
        { ch: 's', drive: 'idle', amp: 0.06, freq: 0.8 },
        { ch: 's', drive: 'attack', attack: 'spit', amp: -0.2, amp2: 0.38 },
        { ch: 'ty', drive: 'gait', amp: -0.012, amp2: -0.022, freq: 2 },
        { ch: 'rx', drive: 'gait', amp: 4, amp2: 6, offset: HALF_PI },
        { ch: 's', drive: 'stagger', amp: 0.08, freq: 8 },
        { ch: 's', drive: 'death', amp: -0.35, window: [0.2, 0.9] },
      ],
    },
    {
      name: 'arm_L',
      parent: 'spine',
      pivot: [0.24, 1.36, 0.2],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: -14, amp2: -20 },
        { ch: 'rz', drive: 'rest', amp: 6 },
        { ch: 'rx', drive: 'idle', amp: 4, freq: 0.3 },
        { ch: 'rz', drive: 'attack', attack: 'spit', amp: 10, amp2: 30 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: 5, amp2: -25 },
        { ch: 'rx', drive: 'attack', attack: 'swipe', amp: 45, amp2: -95, mirror: false },
        { ch: 'ry', drive: 'attack', attack: 'swipe', amp: -35, amp2: 25, mirror: false },
        { ch: 'rz', drive: 'stagger', amp: 15 },
        { ch: 'rz', drive: 'death', amp: 25, window: [0.3, 0.9] },
        { ch: 'rx', drive: 'death', amp: -40, window: [0.4, 1] },
      ],
    },
    {
      name: 'forearm_L',
      parent: 'arm_L',
      pivot: [0.33, 1.02, 0.28],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: -10, amp2: -16, wave: 'pos', offset: HALF_PI },
        { ch: 'rx', drive: 'idle', amp: 5, freq: 0.35, offset: 1 },
        { ch: 'rx', drive: 'attack', attack: 'spit', amp: -10, amp2: -40 },
        { ch: 'rx', drive: 'attack', attack: 'swipe', amp: 25, amp2: -70, mirror: false },
        { ch: 'rx', drive: 'death', amp: -30, window: [0.4, 1] },
      ],
    },
    {
      name: 'thigh_L',
      parent: 'pelvis',
      pivot: [0.14, 0.92, -0.1],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: 22, amp2: 30 },
        { ch: 'rx', drive: 'stagger', amp: -6 },
        { ch: 'rx', drive: 'death', amp: -70, window: [0.05, 0.5] },
      ],
    },
    {
      name: 'shin_L',
      parent: 'thigh_L',
      pivot: [0.19, 0.55, 0.14],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: 26, amp2: 36, wave: 'pos', offset: -HALF_PI },
        { ch: 'rx', drive: 'death', amp: 95, window: [0.05, 0.5] },
      ],
    },
    {
      name: 'foot_L',
      parent: 'shin_L',
      pivot: [0.18, 0.16, -0.12],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: 16, amp2: 22, wave: 'pos', offset: -HALF_PI },
        { ch: 'rx', drive: 'death', amp: -30, window: [0.1, 0.6] },
      ],
    },
  ],
  parts: [
    // Pelvis + hunched torso.
    {
      shape: 'ellipsoid',
      bone: 'pelvis',
      zone: 'flesh',
      center: [0, 0.95, -0.1],
      radii: [0.16, 0.13, 0.15],
      lumpy: 0.01,
    },
    {
      shape: 'lathe',
      bone: 'spine',
      zone: 'flesh',
      a: [0, 0.96, -0.15],
      b: [0, 1.44, 0.3],
      profile: [
        [0, 0],
        [0.06, 0.12],
        [0.22, 0.19],
        [0.5, 0.24],
        [0.78, 0.2],
        [0.94, 0.12],
        [1, 0],
      ],
      ellipse: [1, 0.82],
      lumpy: 0.014,
    },
    // Dorsal plates along the hunched back.
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'chitin',
      center: [0, 1.16, -0.25],
      radii: [0.17, 0.045, 0.12],
      rot: [-40, 0, 0],
      bend: -0.06,
    },
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'chitin',
      center: [0, 1.28, -0.12],
      radii: [0.19, 0.05, 0.13],
      rot: [-42, 0, 0],
      bend: -0.07,
    },
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'chitin',
      center: [0, 1.4, 0.02],
      radii: [0.18, 0.05, 0.12],
      rot: [-45, 0, 0],
      bend: -0.06,
    },
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'chitin',
      center: [0, 1.5, 0.15],
      radii: [0.14, 0.04, 0.1],
      rot: [-50, 0, 0],
      bend: -0.05,
    },
    // Acid blisters on the back + spine spikes.
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'sac',
      center: [0.13, 1.3, -0.14],
      radii: [0.045, 0.04, 0.045],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'sac',
      center: [0.15, 1.18, -0.2],
      radii: [0.035, 0.03, 0.035],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'spine',
      zone: 'sac',
      center: [0.1, 1.44, 0.0],
      radii: [0.03, 0.028, 0.03],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'spine',
      zone: 'bone',
      a: [0, 1.32, -0.14],
      b: [0, 1.46, -0.3],
      radius: 0.028,
      curve: [0, 0.03, 0],
    },
    {
      shape: 'spike',
      bone: 'spine',
      zone: 'bone',
      a: [0, 1.2, -0.26],
      b: [0, 1.3, -0.42],
      radius: 0.026,
      curve: [0, 0.03, 0],
    },
    // Biomechanical ribs wrapping the flanks.
    {
      shape: 'tube',
      bone: 'spine',
      zone: 'bone',
      points: [
        [0.05, 1.3, -0.2],
        [0.2, 1.24, -0.06],
        [0.2, 1.12, 0.1],
        [0.08, 1.06, 0.16],
      ],
      radius: 0.018,
      radiusB: 0.012,
      mirror: true,
    },
    {
      shape: 'tube',
      bone: 'spine',
      zone: 'bone',
      points: [
        [0.05, 1.18, -0.28],
        [0.2, 1.12, -0.16],
        [0.21, 1.0, 0.0],
        [0.1, 0.96, 0.08],
      ],
      radius: 0.016,
      radiusB: 0.01,
      mirror: true,
    },
    // Neck + head + jaw + eyes + maw.
    {
      shape: 'capsule',
      bone: 'neck',
      zone: 'flesh',
      a: [0, 1.38, 0.28],
      b: [0, 1.47, 0.5],
      radius: 0.075,
      radiusB: 0.065,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'chitin',
      center: [0, 1.5, 0.6],
      radii: [0.11, 0.08, 0.15],
      rot: [8, 0, 0],
    },
    {
      shape: 'spike',
      bone: 'head',
      zone: 'bone',
      a: [0.06, 1.55, 0.54],
      b: [0.1, 1.64, 0.38],
      radius: 0.022,
      curve: [0.01, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'head',
      zone: 'bone',
      a: [0, 1.57, 0.52],
      b: [0, 1.66, 0.36],
      radius: 0.02,
      curve: [0, 0.02, 0],
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.07, 1.525, 0.69],
      radii: [0.02, 0.018, 0.02],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.09, 1.51, 0.64],
      radii: [0.013, 0.013, 0.013],
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'sac',
      center: [0, 1.46, 0.66],
      radii: [0.06, 0.03, 0.09],
      rot: [8, 0, 0],
    },
    {
      shape: 'ellipsoid',
      bone: 'jaw',
      zone: 'chitin',
      center: [0, 1.43, 0.64],
      radii: [0.09, 0.035, 0.13],
      rot: [8, 0, 0],
    },
    {
      shape: 'spike',
      bone: 'jaw',
      zone: 'bone',
      a: [0.05, 1.44, 0.72],
      b: [0.045, 1.5, 0.74],
      radius: 0.01,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'head',
      zone: 'bone',
      a: [0.05, 1.47, 0.72],
      b: [0.045, 1.42, 0.74],
      radius: 0.01,
      mirror: true,
    },
    // Acid sac under the throat (weakpoint).
    {
      shape: 'ellipsoid',
      bone: 'sac',
      zone: 'sac',
      center: [0, 1.27, 0.46],
      radii: [0.16, 0.17, 0.15],
      lumpy: 0.01,
    },
    {
      shape: 'tube',
      bone: 'sac',
      zone: 'flesh',
      points: [
        [0.06, 1.4, 0.4],
        [0.12, 1.3, 0.5],
        [0.08, 1.16, 0.52],
      ],
      radius: 0.012,
      mirror: true,
    },
    // Arms: thin, long, clawed.
    {
      shape: 'ellipsoid',
      bone: 'arm_L',
      zone: 'chitin',
      center: [0.26, 1.41, 0.2],
      radii: [0.1, 0.035, 0.09],
      rot: [0, 0, -35],
      bend: -0.04,
      mirror: true,
    },
    {
      shape: 'capsule',
      bone: 'arm_L',
      zone: 'flesh',
      a: [0.24, 1.36, 0.2],
      b: [0.33, 1.02, 0.28],
      radius: 0.046,
      radiusB: 0.03,
      mirror: true,
      lumpy: 0.006,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.33, 1.03, 0.27],
      b: [0.37, 1.13, 0.1],
      radius: 0.022,
      curve: [0, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'capsule',
      bone: 'forearm_L',
      zone: 'chitin',
      a: [0.33, 1.02, 0.28],
      b: [0.31, 0.68, 0.42],
      radius: 0.034,
      radiusB: 0.024,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.31, 0.68, 0.42],
      b: [0.34, 0.5, 0.5],
      radius: 0.016,
      curve: [0, 0, 0.03],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.3, 0.68, 0.42],
      b: [0.27, 0.51, 0.5],
      radius: 0.015,
      curve: [0, 0, 0.03],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.32, 0.69, 0.41],
      b: [0.36, 0.54, 0.43],
      radius: 0.013,
      curve: [0.01, 0, 0.02],
      mirror: true,
    },
    // Digitigrade legs.
    {
      shape: 'capsule',
      bone: 'thigh_L',
      zone: 'flesh',
      a: [0.14, 0.92, -0.1],
      b: [0.19, 0.55, 0.14],
      radius: 0.085,
      radiusB: 0.06,
      mirror: true,
      lumpy: 0.008,
    },
    {
      shape: 'ellipsoid',
      bone: 'shin_L',
      zone: 'chitin',
      center: [0.19, 0.56, 0.16],
      radii: [0.045, 0.04, 0.05],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'shin_L',
      zone: 'bone',
      a: [0.19, 0.57, 0.18],
      b: [0.21, 0.63, 0.3],
      radius: 0.02,
      curve: [0, 0.02, 0],
      mirror: true,
    },
    {
      shape: 'capsule',
      bone: 'shin_L',
      zone: 'chitin',
      a: [0.19, 0.55, 0.14],
      b: [0.18, 0.16, -0.12],
      radius: 0.05,
      radiusB: 0.04,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'foot_L',
      zone: 'bone',
      a: [0.18, 0.16, -0.12],
      b: [0.22, 0.01, 0.14],
      radius: 0.032,
      curve: [0, 0, 0.03],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'foot_L',
      zone: 'bone',
      a: [0.17, 0.16, -0.12],
      b: [0.12, 0.01, 0.11],
      radius: 0.028,
      curve: [0, 0, 0.03],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'foot_L',
      zone: 'bone',
      a: [0.18, 0.15, -0.13],
      b: [0.18, 0.03, -0.25],
      radius: 0.022,
      mirror: true,
    },
  ],
  attacks: [
    { id: 'spit', windup: 0.45, strike: 0.62, glow: 2.2 },
    { id: 'swipe', windup: 0.35, strike: 0.55, glow: 0.6 },
  ],
  hitboxes: [
    { bone: 'sac', shape: 'sphere', zone: 'weakpoint', a: [0, 1.27, 0.46], radius: 0.17 },
    { bone: 'head', shape: 'sphere', zone: 'head', a: [0, 1.49, 0.6], radius: 0.14 },
    { bone: 'spine', shape: 'capsule', zone: 'body', a: [0, 1.02, -0.12], b: [0, 1.38, 0.22], radius: 0.23 },
    {
      bone: 'arm_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.24, 1.36, 0.2],
      b: [0.33, 1.02, 0.28],
      radius: 0.07,
      mirror: true,
    },
    {
      bone: 'forearm_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.33, 1.02, 0.28],
      b: [0.32, 0.6, 0.45],
      radius: 0.06,
      mirror: true,
    },
    {
      bone: 'thigh_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.14, 0.9, -0.1],
      b: [0.19, 0.55, 0.14],
      radius: 0.09,
      mirror: true,
    },
    {
      bone: 'shin_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.19, 0.55, 0.14],
      b: [0.18, 0.08, -0.1],
      radius: 0.065,
      mirror: true,
    },
  ],
  sockets: {
    mouth: [{ bone: 'jaw', point: [0, 1.46, 0.76] }],
    chest: [{ bone: 'spine', point: [0, 1.3, 0.14] }],
    core: [{ bone: 'spine', point: [0, 1.18, 0.02] }],
    sac: [{ bone: 'sac', point: [0, 1.27, 0.46] }],
    head: [{ bone: 'head', point: [0, 1.5, 0.6] }],
  },
  aimSocket: 'chest',
  look: { yawMaxDeg: 60, pitchMaxDeg: 40 },
  cullMargin: 0.8,
  dissolve: { edgeColor: [0.45, 1, 0.15], edgeIntensity: 11, edgeWidth: 0.08, noiseScale: 7 },
  rift: { color: RIFT_VIOLET, intensity: 14, tearRadius: 0.9 },
  effects: {
    spawn: 'rift.spawn',
    spawnScale: 0.9,
    death: 'enemy.death.acid',
    deathScale: 1,
    deathSocket: 'sac',
  },
};

/**
 * Tank: hulking knuckle-walking brute, ~2.4 m. Gunmetal biomech armor plates cover the chest,
 * belly, forearms and shoulders (front hits land on 'shield' hitboxes: the AI applies its armor
 * damage reduction to zone 'shield'); a pulsing core sits exposed in the spine (zone 'weakpoint',
 * only reachable from behind). Heavy stomp gait; charge (brace, head-down ram) and ground slam
 * (both fists overhead, crash down – the 'fists' socket is the impact point).
 */
const TANK: EnemyVisualDef = {
  capacity: 8,
  zones: {
    flesh: {
      color: [0.05, 0.026, 0.026],
      color2: [0.1, 0.045, 0.04],
      tip: [0.035, 0.02, 0.02],
      tipAmount: 0.35,
      roughness: 0.46,
      metalness: 0,
      clearcoat: 0.55,
      emissive: [1, 0.25, 0.45],
      emissiveIntensity: 2.8,
      glow: 0,
      pulse: 0,
      veins: 0.5,
      bump: 0.9,
      cells: 0.25,
      scale: 1.8,
    },
    // Metal: albedo is the specular color (F0) – gunmetal needs ~0.2-0.3 to catch the lights.
    armor: {
      color: [0.17, 0.165, 0.17],
      color2: [0.27, 0.24, 0.22],
      tip: [0.34, 0.3, 0.26],
      tipAmount: 0.25,
      roughness: 0.32,
      metalness: 0.85,
      clearcoat: 0.3,
      emissive: [1, 0.3, 0.5],
      emissiveIntensity: 1.2,
      glow: 0,
      pulse: 0,
      veins: 0.06,
      bump: 1.2,
      cells: 0.55,
      scale: 1.5,
    },
    chitin: {
      color: [0.03, 0.026, 0.03],
      color2: [0.07, 0.05, 0.05],
      tip: [0.18, 0.14, 0.11],
      tipAmount: 0.3,
      roughness: 0.3,
      metalness: 0.15,
      clearcoat: 0.9,
      emissive: [1, 0.25, 0.45],
      emissiveIntensity: 1.2,
      glow: 0,
      pulse: 0,
      veins: 0.1,
      bump: 1,
      cells: 0.7,
      scale: 2.6,
    },
    bone: BONE,
    tubes: {
      color: [0.05, 0.042, 0.046],
      color2: [0.1, 0.07, 0.07],
      tip: [0.05, 0.042, 0.046],
      tipAmount: 0,
      roughness: 0.25,
      metalness: 0.55,
      clearcoat: 0.8,
      emissive: [1, 0.35, 0.55],
      emissiveIntensity: 3,
      glow: 0.15,
      pulse: 0.5,
      veins: 0.8,
      bump: 0.5,
      cells: 0.3,
      scale: 4,
    },
    core: {
      color: [0.2, 0.05, 0.08],
      color2: [0.35, 0.1, 0.12],
      tip: [0.2, 0.05, 0.08],
      tipAmount: 0,
      roughness: 0.1,
      metalness: 0,
      clearcoat: 1,
      emissive: [1, 0.32, 0.5],
      emissiveIntensity: 7.5,
      glow: 1,
      pulse: 0.35,
      veins: 0.3,
      bump: 0.5,
      cells: 0.55,
      scale: 3.5,
    },
    eyes: {
      color: [0.05, 0.01, 0.01],
      color2: [0.05, 0.01, 0.01],
      tip: [0.05, 0.01, 0.01],
      tipAmount: 0,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      emissive: [1, 0.2, 0.3],
      emissiveIntensity: 7,
      glow: 1,
      pulse: 0.2,
      veins: 0,
      bump: 0,
      cells: 0,
      scale: 12,
    },
  },
  bones: [
    {
      name: 'pelvis',
      parent: null,
      pivot: [0, 1.0, -0.25],
      motions: [
        { ch: 'ty', drive: 'emerge', amp: -2.9 },
        { ch: 'rx', drive: 'emerge', amp: -20, window: [0.1, 1] },
        { ch: 'ty', drive: 'gait', amp: 0.05, amp2: 0.09, wave: 'abs', offset: HALF_PI },
        { ch: 'rz', drive: 'gait', amp: 5, amp2: 7 },
        { ch: 'ry', drive: 'gait', amp: 4, amp2: 6, offset: HALF_PI },
        { ch: 'rx', drive: 'loco', amp: 12, window: [0.5, 1] },
        { ch: 'ty', drive: 'idle', amp: 0.012, freq: 0.3 },
        { ch: 'rx', drive: 'idle', amp: 1, freq: 0.3, offset: 1.5 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: 12, amp2: 12 },
        { ch: 'ty', drive: 'attack', attack: 'charge', amp: -0.08, amp2: -0.12 },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: 18, amp2: -10 },
        { ch: 'ty', drive: 'attack', attack: 'slam', amp: -0.2, amp2: 0.06 },
        { ch: 'ry', drive: 'attack', attack: 'swipe', amp: -22, amp2: 18 },
        { ch: 'rx', drive: 'stagger', amp: -6 },
        { ch: 'tz', drive: 'stagger', amp: -0.08 },
        { ch: 'rz', drive: 'stagger', amp: 2, freq: 5 },
        { ch: 'ty', drive: 'death', amp: -0.55, window: [0.1, 0.6] },
        { ch: 'rx', drive: 'death', amp: 58, window: [0.3, 0.95] },
        { ch: 'rz', drive: 'death', amp: 10, window: [0.3, 0.9] },
      ],
    },
    {
      name: 'chest',
      parent: 'pelvis',
      pivot: [0, 1.25, -0.2],
      motions: [
        { ch: 'ry', drive: 'gait', amp: -5, amp2: -8, offset: HALF_PI },
        { ch: 'rx', drive: 'gait', amp: 2, amp2: 4, freq: 2, offset: 1 },
        { ch: 's', drive: 'idle', amp: 0.018, freq: 0.3 },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: 28, amp2: -30 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: 14, amp2: 10 },
        { ch: 'ry', drive: 'attack', attack: 'swipe', amp: -30, amp2: 30 },
        { ch: 'rx', drive: 'stagger', amp: -12 },
        { ch: 'rx', drive: 'death', amp: 20, window: [0.3, 1] },
      ],
    },
    {
      name: 'head',
      parent: 'chest',
      pivot: [0, 1.9, 0.3],
      motions: [
        { ch: 'ry', drive: 'lookYaw', amp: 0.8 },
        { ch: 'rx', drive: 'lookPitch', amp: 0.7 },
        { ch: 'ry', drive: 'idle', amp: 4, freq: 0.2 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: 20, amp2: 12 },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: 15, amp2: -15 },
        { ch: 'rx', drive: 'stagger', amp: -18 },
        { ch: 'ry', drive: 'stagger', amp: 6, freq: 4 },
        { ch: 'rx', drive: 'death', amp: 30, window: [0.2, 0.8] },
        { ch: 'ry', drive: 'death', amp: 25, window: [0.4, 1] },
      ],
    },
    {
      name: 'arm_L',
      parent: 'chest',
      pivot: [0.58, 1.9, 0.05],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: -20, amp2: -30 },
        { ch: 'rz', drive: 'idle', amp: 2, freq: 0.3 },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: -30, amp2: -150 },
        { ch: 'rz', drive: 'attack', attack: 'slam', amp: -12, amp2: -8 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: 22, amp2: 22 },
        { ch: 'rz', drive: 'attack', attack: 'charge', amp: 8, amp2: 6 },
        { ch: 'ry', drive: 'attack', attack: 'swipe', amp: -50, amp2: 35, mirror: false },
        { ch: 'rx', drive: 'attack', attack: 'swipe', amp: -60, amp2: -80, mirror: false },
        { ch: 'rz', drive: 'attack', attack: 'swipe', amp: -20, amp2: 30, mirror: false },
        { ch: 'rz', drive: 'stagger', amp: 10 },
        { ch: 'rx', drive: 'stagger', amp: 10 },
        { ch: 'rz', drive: 'death', amp: 25, window: [0.3, 0.9] },
        { ch: 'rx', drive: 'death', amp: -30, window: [0.3, 0.9] },
      ],
    },
    {
      name: 'forearm_L',
      parent: 'arm_L',
      pivot: [0.78, 1.22, 0.22],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: -25, amp2: -35, wave: 'pos', offset: HALF_PI },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: 0, amp2: -60 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: -20, amp2: -20 },
        { ch: 'rx', drive: 'attack', attack: 'swipe', amp: -20, amp2: -70, mirror: false },
        { ch: 'rx', drive: 'death', amp: -40, window: [0.3, 0.9] },
      ],
    },
    {
      name: 'thigh_L',
      parent: 'pelvis',
      pivot: [0.28, 0.98, -0.3],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: 16, amp2: 24 },
        { ch: 'rx', drive: 'attack', attack: 'charge', amp: -8, amp2: -12 },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: -25, amp2: -12 },
        { ch: 'rx', drive: 'death', amp: -60, window: [0.1, 0.6] },
      ],
    },
    {
      name: 'shin_L',
      parent: 'thigh_L',
      pivot: [0.36, 0.55, -0.12],
      mirror: true,
      mirrorPhase: PI,
      motions: [
        { ch: 'rx', drive: 'gait', amp: 22, amp2: 30, wave: 'pos', offset: -HALF_PI },
        { ch: 'rx', drive: 'attack', attack: 'slam', amp: 40, amp2: 20 },
        { ch: 'rx', drive: 'death', amp: 80, window: [0.1, 0.6] },
      ],
    },
  ],
  parts: [
    // Torso masses.
    {
      shape: 'ellipsoid',
      bone: 'pelvis',
      zone: 'flesh',
      center: [0, 1.0, -0.28],
      radii: [0.38, 0.28, 0.3],
      lumpy: 0.02,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'flesh',
      center: [0, 1.28, -0.06],
      radii: [0.42, 0.32, 0.36],
      lumpy: 0.02,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'flesh',
      center: [0, 1.66, 0.02],
      radii: [0.6, 0.42, 0.44],
      lumpy: 0.025,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'flesh',
      center: [0, 1.86, -0.2],
      radii: [0.5, 0.3, 0.34],
      lumpy: 0.02,
    },
    // Front armor: layered chest plates, belly bands, collar.
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0.25, 1.74, 0.43],
      radii: [0.3, 0.034, 0.2],
      rot: [72, 22, -6],
      bend: -0.09,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0.24, 1.53, 0.45],
      radii: [0.28, 0.032, 0.17],
      rot: [84, 20, -4],
      bend: -0.09,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0, 1.36, 0.33],
      radii: [0.34, 0.028, 0.09],
      rot: [80, 0, 0],
      bend: -0.13,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0, 1.2, 0.29],
      radii: [0.3, 0.026, 0.085],
      rot: [76, 0, 0],
      bend: -0.12,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0, 1.05, 0.2],
      radii: [0.25, 0.024, 0.08],
      rot: [70, 0, 0],
      bend: -0.1,
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0, 1.93, 0.25],
      radii: [0.36, 0.03, 0.16],
      rot: [30, 0, 0],
      bend: -0.1,
    },
    // Shoulder pauldrons (two layers) with spikes.
    {
      shape: 'ellipsoid',
      bone: 'arm_L',
      zone: 'armor',
      center: [0.62, 2.02, 0.05],
      radii: [0.3, 0.04, 0.33],
      rot: [0, 0, -28],
      bend: -0.14,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'arm_L',
      zone: 'armor',
      center: [0.75, 1.84, 0.07],
      radii: [0.2, 0.035, 0.28],
      rot: [0, 0, -58],
      bend: -0.08,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'arm_L',
      zone: 'bone',
      a: [0.62, 2.06, 0.08],
      b: [0.72, 2.34, -0.04],
      radius: 0.05,
      curve: [0.02, 0.03, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'arm_L',
      zone: 'bone',
      a: [0.75, 2.0, -0.08],
      b: [0.88, 2.22, -0.2],
      radius: 0.04,
      curve: [0.02, 0.02, 0],
      mirror: true,
    },
    // Head: sunk between the shoulders, face plate, glowing slits, tusks.
    { shape: 'ellipsoid', bone: 'head', zone: 'chitin', center: [0, 1.92, 0.38], radii: [0.15, 0.14, 0.16] },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'armor',
      center: [0, 1.95, 0.51],
      radii: [0.14, 0.03, 0.11],
      rot: [85, 0, 0],
      bend: -0.05,
    },
    {
      shape: 'ellipsoid',
      bone: 'head',
      zone: 'eyes',
      center: [0.065, 1.975, 0.545],
      radii: [0.036, 0.011, 0.018],
      mirror: true,
    },
    { shape: 'ellipsoid', bone: 'head', zone: 'chitin', center: [0, 1.82, 0.45], radii: [0.12, 0.05, 0.1] },
    {
      shape: 'spike',
      bone: 'head',
      zone: 'bone',
      a: [0.08, 1.82, 0.5],
      b: [0.15, 1.95, 0.64],
      radius: 0.03,
      curve: [0.02, -0.02, 0],
      mirror: true,
    },
    // Exposed back: glowing core cradled by cables and spikes.
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'core',
      center: [0, 1.7, -0.46],
      radii: [0.15, 0.16, 0.14],
      lumpy: 0.008,
    },
    {
      shape: 'tube',
      bone: 'chest',
      zone: 'tubes',
      points: [
        [0.12, 1.46, -0.36],
        [0.22, 1.66, -0.52],
        [0.2, 1.86, -0.46],
        [0.08, 1.96, -0.34],
      ],
      radius: 0.04,
      radiusB: 0.03,
      mirror: true,
    },
    {
      shape: 'tube',
      bone: 'chest',
      zone: 'tubes',
      points: [
        [0.05, 1.5, -0.42],
        [0.1, 1.56, -0.56],
        [0.12, 1.74, -0.6],
        [0.04, 1.9, -0.52],
      ],
      radius: 0.022,
      mirror: true,
    },
    {
      shape: 'tube',
      bone: 'chest',
      zone: 'tubes',
      points: [
        [0.3, 1.9, -0.28],
        [0.26, 1.75, -0.44],
        [0.12, 1.66, -0.48],
      ],
      radius: 0.028,
      radiusB: 0.02,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'chest',
      zone: 'bone',
      a: [0.2, 1.98, -0.3],
      b: [0.3, 2.34, -0.56],
      radius: 0.07,
      curve: [0.02, 0.04, 0],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'chest',
      zone: 'bone',
      a: [0, 2.02, -0.28],
      b: [0, 2.4, -0.5],
      radius: 0.07,
      curve: [0, 0.05, 0],
    },
    {
      shape: 'ellipsoid',
      bone: 'chest',
      zone: 'armor',
      center: [0, 1.3, -0.46],
      radii: [0.3, 0.06, 0.16],
      rot: [-70, 0, 0],
      bend: -0.1,
    },
    // Arms: massive, knuckle-walking fists with armored forearms.
    {
      shape: 'capsule',
      bone: 'arm_L',
      zone: 'flesh',
      a: [0.58, 1.9, 0.05],
      b: [0.78, 1.22, 0.22],
      radius: 0.2,
      radiusB: 0.16,
      mirror: true,
      lumpy: 0.015,
    },
    {
      shape: 'capsule',
      bone: 'forearm_L',
      zone: 'flesh',
      a: [0.78, 1.22, 0.22],
      b: [0.76, 0.42, 0.42],
      radius: 0.16,
      radiusB: 0.2,
      mirror: true,
      lumpy: 0.015,
    },
    {
      shape: 'ellipsoid',
      bone: 'forearm_L',
      zone: 'armor',
      center: [0.78, 0.98, 0.47],
      radii: [0.2, 0.032, 0.22],
      rot: [74, 0, 0],
      bend: -0.11,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'forearm_L',
      zone: 'armor',
      center: [0.78, 0.7, 0.53],
      radii: [0.21, 0.032, 0.2],
      rot: [78, 0, 0],
      bend: -0.12,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'forearm_L',
      zone: 'armor',
      center: [0.76, 0.3, 0.46],
      radii: [0.22, 0.2, 0.22],
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.7, 0.3, 0.62],
      b: [0.7, 0.32, 0.8],
      radius: 0.04,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.84, 0.3, 0.6],
      b: [0.86, 0.32, 0.78],
      radius: 0.04,
      mirror: true,
    },
    {
      shape: 'spike',
      bone: 'forearm_L',
      zone: 'bone',
      a: [0.9, 0.9, 0.3],
      b: [1.08, 1.0, 0.18],
      radius: 0.035,
      mirror: true,
    },
    // Biomechanical cables along the arms (one bone each: they bend with the limb).
    {
      shape: 'tube',
      bone: 'arm_L',
      zone: 'tubes',
      points: [
        [0.5, 1.92, -0.12],
        [0.7, 1.62, -0.04],
        [0.8, 1.32, 0.08],
      ],
      radius: 0.032,
      radiusB: 0.026,
      mirror: true,
    },
    {
      shape: 'tube',
      bone: 'forearm_L',
      zone: 'tubes',
      points: [
        [0.9, 1.16, 0.16],
        [0.95, 0.82, 0.28],
        [0.9, 0.5, 0.36],
      ],
      radius: 0.028,
      radiusB: 0.022,
      mirror: true,
    },
    // Legs: short and thick, hoof-like feet.
    {
      shape: 'capsule',
      bone: 'thigh_L',
      zone: 'flesh',
      a: [0.28, 0.98, -0.3],
      b: [0.36, 0.55, -0.12],
      radius: 0.2,
      radiusB: 0.17,
      mirror: true,
      lumpy: 0.012,
    },
    {
      shape: 'capsule',
      bone: 'shin_L',
      zone: 'chitin',
      a: [0.36, 0.55, -0.12],
      b: [0.38, 0.14, -0.3],
      radius: 0.15,
      radiusB: 0.13,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'shin_L',
      zone: 'armor',
      center: [0.38, 0.58, 0.0],
      radii: [0.15, 0.03, 0.15],
      rot: [70, 0, 0],
      bend: -0.07,
      mirror: true,
    },
    {
      shape: 'ellipsoid',
      bone: 'shin_L',
      zone: 'armor',
      center: [0.38, 0.1, -0.2],
      radii: [0.17, 0.1, 0.26],
      mirror: true,
    },
  ],
  attacks: [
    { id: 'slam', windup: 0.55, strike: 0.66, glow: 2 },
    { id: 'charge', windup: 0.2, strike: 0.88, glow: 1.6 },
    { id: 'swipe', windup: 0.4, strike: 0.55, glow: 0.8 },
  ],
  hitboxes: [
    { bone: 'chest', shape: 'sphere', zone: 'weakpoint', a: [0, 1.7, -0.5], radius: 0.2 },
    { bone: 'head', shape: 'sphere', zone: 'head', a: [0, 1.92, 0.4], radius: 0.18 },
    {
      bone: 'chest',
      shape: 'capsule',
      zone: 'shield',
      a: [-0.36, 1.64, 0.42],
      b: [0.36, 1.64, 0.42],
      radius: 0.25,
    },
    {
      bone: 'chest',
      shape: 'capsule',
      zone: 'shield',
      a: [-0.24, 1.26, 0.3],
      b: [0.24, 1.26, 0.3],
      radius: 0.18,
    },
    {
      bone: 'forearm_L',
      shape: 'capsule',
      zone: 'shield',
      a: [0.78, 1.08, 0.46],
      b: [0.77, 0.62, 0.55],
      radius: 0.13,
      mirror: true,
    },
    { bone: 'chest', shape: 'capsule', zone: 'body', a: [0, 1.22, -0.18], b: [0, 1.8, -0.12], radius: 0.44 },
    {
      bone: 'pelvis',
      shape: 'capsule',
      zone: 'body',
      a: [-0.2, 1.0, -0.28],
      b: [0.2, 1.0, -0.28],
      radius: 0.28,
    },
    {
      bone: 'arm_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.58, 1.9, 0.05],
      b: [0.78, 1.22, 0.22],
      radius: 0.19,
      mirror: true,
    },
    {
      bone: 'forearm_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.78, 1.22, 0.22],
      b: [0.76, 0.32, 0.44],
      radius: 0.2,
      mirror: true,
    },
    {
      bone: 'thigh_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.28, 0.98, -0.3],
      b: [0.36, 0.55, -0.12],
      radius: 0.2,
      mirror: true,
    },
    {
      bone: 'shin_L',
      shape: 'capsule',
      zone: 'limb',
      a: [0.36, 0.55, -0.12],
      b: [0.38, 0.12, -0.28],
      radius: 0.16,
      mirror: true,
    },
  ],
  sockets: {
    fists: [
      { bone: 'forearm_L', point: [0.76, 0.22, 0.46] },
      { bone: 'forearm_R', point: [-0.76, 0.22, 0.46] },
    ],
    fistL: [{ bone: 'forearm_L', point: [0.76, 0.22, 0.46] }],
    fistR: [{ bone: 'forearm_R', point: [-0.76, 0.22, 0.46] }],
    chest: [{ bone: 'chest', point: [0, 1.66, 0.2] }],
    core: [{ bone: 'chest', point: [0, 1.7, -0.46] }],
    head: [{ bone: 'head', point: [0, 1.92, 0.4] }],
  },
  aimSocket: 'chest',
  look: { yawMaxDeg: 45, pitchMaxDeg: 30 },
  // The charge lunge while running flat out reaches ~1.2 m past the rest bounds.
  cullMargin: 1.5,
  dissolve: { edgeColor: [1, 0.32, 0.55], edgeIntensity: 12, edgeWidth: 0.07, noiseScale: 5 },
  rift: { color: RIFT_VIOLET, intensity: 14, tearRadius: 1.4 },
  effects: {
    spawn: 'rift.spawn',
    spawnScale: 1.4,
    death: 'enemy.death.armor',
    deathScale: 1.5,
    deathSocket: 'core',
  },
};

export const ENEMY_VISUALS = {
  swarmer: SWARMER,
  spitter: SPITTER,
  tank: TANK,
} as const satisfies Record<string, EnemyVisualDef>;

export type EnemyVisualTypeId = keyof typeof ENEMY_VISUALS;

export function getEnemyVisualDef(type: string): EnemyVisualDef | undefined {
  return Object.prototype.hasOwnProperty.call(ENEMY_VISUALS, type)
    ? (ENEMY_VISUALS as Record<string, EnemyVisualDef>)[type]
    : undefined;
}

/** EnemyPose.attackId for an AI attack id (-1 if the type has no such animation). */
export function attackAnimIndex(type: string, attackId: string): number {
  const def = getEnemyVisualDef(type);
  if (!def) return -1;
  for (let i = 0; i < def.attacks.length; i++) if (def.attacks[i]!.id === attackId) return i;
  return -1;
}
