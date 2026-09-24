/**
 * Arsenal visuals (M5, vfx/arsenal/ArsenalVfx): projectile styles, trails, beams, charge glows and
 * lingering fields, keyed by the convention ids the weapon data references (projectile.*, trail.*,
 * beam.*, charge.*, field.*). Particle bursts they spawn (trail puffs, beam hits, field ambience)
 * are ordinary effect presets in defs/vfx.ts; the ArsenalVfx system never branches on an id.
 *
 * Units: meters, seconds, rad/s; colors are LINEAR RGB × `intensity` (HDR: above
 * POSTFX.bloom.luminanceThreshold they bloom). Sizes are quad edges (m).
 *
 * Rendering (see vfx/arsenal/*): glows are procedural camera-facing sprites (one instanced draw for
 * all emissive ones, one for the dark "event horizon" discs), trails/beams are camera-facing strips
 * (one instanced draw of segments), fields add flat procedural discs (one draw) – all additive on
 * RENDER.volumetricLayer and preallocated at their capacity here. Grenade bodies are lit instanced
 * meshes in the world pass. Unknown ids fall back to DEFAULT_* styles (drawn, never crash).
 */
import type { Range, Rgb } from './vfx';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Procedural sprite shapes of the glow renderer (index = shader id, see vfx/arsenal/glowShader). */
export const GLOW_SHAPES = [
  'orb',
  'bolt',
  'ring',
  'electric',
  'void',
  'crystal',
  'flare',
  'swirl',
  'disc',
  'flame',
] as const;
export type GlowShape = (typeof GLOW_SHAPES)[number];

/** Profiles of the strip renderer (trails, beams, chain arcs; index = shader id). */
export const STRIP_STYLES = ['glow', 'electric', 'void', 'rail', 'fire', 'frost'] as const;
export type StripStyle = (typeof STRIP_STYLES)[number];

/** Patterns of the flat field discs (index = shader id). */
export const DISC_STYLES = ['accretion', 'fire', 'poison', 'frost'] as const;
export type DiscStyle = (typeof DISC_STYLES)[number];

export interface GlowLayerDef {
  readonly shape: GlowShape;
  /** Quad edge (m). */
  readonly size: number;
  readonly color: Rgb;
  readonly intensity: number;
  /** 'add': emissive glow; 'dark': black, alpha-blended (event horizons, void cores). Default 'add'. */
  readonly blend?: 'add' | 'dark';
  /** 'bolt' / 'flame' only: extra length along the velocity = speed · stretch (s), ≤ maxStretch m. */
  readonly stretch?: number;
  readonly maxStretch?: number;
  /** Intensity × (1 − depth · (0.5 + 0.5 sin 2π·rate·t)); `square`: hard on/off blink (LEDs). */
  readonly pulse?: { readonly rate: number; readonly depth: number; readonly square?: boolean };
  /** Offset along the flight direction (m; negative = behind the center). */
  readonly offset?: number;
  /** Pattern spin (rad/s). */
  readonly spin?: number;
}

/** A light re-flashed on the pooled VFX lights while an effect lasts (fields, beams, charges). */
export interface SustainLightDef {
  readonly color: Rgb;
  /** Peak intensity (candela) of each re-flash. */
  readonly intensity: number;
  readonly range: number;
  /** Seconds between re-flashes; each flash decays over `interval × 1.6` (flicker comes for free). */
  readonly interval: number;
  /** Offset along the effect normal / beam (m). */
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

export const PROJECTILE_MESHES = ['shell', 'ball', 'canister'] as const;
export type ProjectileMesh = (typeof PROJECTILE_MESHES)[number];

/** Solid, lit body (grenades): the mesh is scaled to length × radius, the band is unlit HDR. */
export interface ProjectileBodyDef {
  readonly mesh: ProjectileMesh;
  readonly length: number;
  readonly radius: number;
  readonly color: Rgb;
  readonly roughness: number;
  readonly metalness: number;
  /** Emissive identification band (type colour: amber frag, orange incendiary, cyan cryo, violet void). */
  readonly band: Rgb;
  readonly bandIntensity: number;
  /** Tumble around a side axis (rad/s); 'shell' meshes fly nose first and roll instead. */
  readonly tumble: number;
}

export interface ProjectileVisualDef {
  readonly glows: readonly GlowLayerDef[];
  readonly body: ProjectileBodyDef | null;
  /** Screen-space lens around the projectile (void orbs): displacement strength, radius (m). */
  readonly lens?: { readonly strength: number; readonly radius: number };
}

const PLASMA: Rgb = [0.3, 0.78, 1];
const PLASMA_CORE: Rgb = [0.75, 0.95, 1];
const SHOCK: Rgb = [0.5, 0.7, 1];
const SHOCK_CORE: Rgb = [0.85, 0.92, 1];
const VOID: Rgb = [0.62, 0.22, 1];
const VOID_DEEP: Rgb = [0.34, 0.06, 0.8];
const FROST: Rgb = [0.55, 0.85, 1];
const FROST_CORE: Rgb = [0.85, 0.97, 1];
const FIRE: Rgb = [1, 0.48, 0.12];
const FIRE_CORE: Rgb = [1, 0.8, 0.45];
const POISON: Rgb = [0.35, 1, 0.22];
const LED_AMBER: Rgb = [1, 0.55, 0.12];
const LED_RED: Rgb = [1, 0.12, 0.06];
const GUNMETAL: Rgb = [0.08, 0.085, 0.09];
const OLIVE: Rgb = [0.12, 0.13, 0.08];

/** Grenade LED: a flare glint blinking at `rate` Hz. */
function led(color: Rgb, rate: number, offset: number): GlowLayerDef {
  return { shape: 'flare', size: 0.3, color, intensity: 9, pulse: { rate, depth: 0.92, square: true }, offset };
}

export const PROJECTILE_VISUALS = {
  /** PL-2 plasma bolt: a white-hot stretched core in a cyan sheath. */
  'projectile.plasma': {
    glows: [
      { shape: 'bolt', size: 0.12, color: PLASMA_CORE, intensity: 14, stretch: 0.012, maxStretch: 0.9 },
      { shape: 'bolt', size: 0.34, color: PLASMA, intensity: 3.2, stretch: 0.012, maxStretch: 0.9 },
      { shape: 'orb', size: 0.7, color: PLASMA, intensity: 0.9, offset: 0.05 },
    ],
    body: null,
  },
  /** GL-6 40 mm round: gunmetal shell, amber band, blinking tail LED. */
  'projectile.grenade': {
    glows: [led(LED_AMBER, 6, -0.05)],
    body: {
      mesh: 'shell',
      length: 0.13,
      radius: 0.022,
      color: GUNMETAL,
      roughness: 0.45,
      metalness: 0.85,
      band: LED_AMBER,
      bandIntensity: 5,
      tumble: 14,
    },
  },
  'projectile.frag': {
    glows: [led(LED_RED, 4, 0)],
    body: {
      mesh: 'ball',
      length: 0.1,
      radius: 0.045,
      color: OLIVE,
      roughness: 0.7,
      metalness: 0.3,
      band: LED_RED,
      bandIntensity: 4,
      tumble: 9,
    },
  },
  'projectile.incendiary': {
    glows: [led(FIRE, 5, 0), { shape: 'flame', size: 0.18, color: FIRE, intensity: 3, offset: -0.06 }],
    body: {
      mesh: 'canister',
      length: 0.13,
      radius: 0.032,
      color: [0.22, 0.07, 0.04],
      roughness: 0.55,
      metalness: 0.6,
      band: FIRE,
      bandIntensity: 6,
      tumble: 10,
    },
  },
  'projectile.cryo': {
    glows: [led(FROST, 5, 0), { shape: 'crystal', size: 0.26, color: FROST, intensity: 1.6, spin: 3 }],
    body: {
      mesh: 'canister',
      length: 0.13,
      radius: 0.032,
      color: [0.6, 0.66, 0.7],
      roughness: 0.35,
      metalness: 0.7,
      band: FROST,
      bandIntensity: 6,
      tumble: 10,
    },
  },
  'projectile.singularity': {
    glows: [
      { shape: 'void', size: 0.34, color: VOID, intensity: 3.5, spin: 6 },
      led(VOID, 7, 0),
    ],
    body: {
      mesh: 'ball',
      length: 0.1,
      radius: 0.048,
      color: [0.05, 0.045, 0.06],
      roughness: 0.3,
      metalness: 0.9,
      band: VOID,
      bandIntensity: 7,
      tumble: 8,
    },
  },
  /** SX-0 void orb: a dark core in a violet rim, swirling matter and a faint lens. */
  'projectile.voidorb': {
    glows: [
      { shape: 'disc', size: 0.34, color: [0, 0, 0], intensity: 1, blend: 'dark' },
      { shape: 'void', size: 0.62, color: VOID, intensity: 4.5, spin: 5 },
      { shape: 'swirl', size: 1.25, color: VOID_DEEP, intensity: 2.2, spin: -3.5 },
      { shape: 'orb', size: 1.6, color: VOID_DEEP, intensity: 0.55 },
    ],
    body: null,
    lens: { strength: 0.5, radius: 0.55 },
  },
  /** Äther-Harfe: a white-blue orb wrapped in crackling filaments. */
  'projectile.shockorb': {
    glows: [
      { shape: 'orb', size: 0.26, color: SHOCK_CORE, intensity: 12 },
      { shape: 'electric', size: 0.85, color: SHOCK, intensity: 5, spin: 2 },
      { shape: 'orb', size: 1.2, color: SHOCK, intensity: 0.8 },
    ],
    body: null,
  },
  /** Kryo-Nova: a faceted ice star around a cold white core. */
  'projectile.cryoorb': {
    glows: [
      { shape: 'orb', size: 0.3, color: FROST_CORE, intensity: 9 },
      { shape: 'crystal', size: 0.95, color: FROST, intensity: 3.2, spin: 1.5 },
      { shape: 'orb', size: 1.3, color: FROST, intensity: 0.7 },
    ],
    body: null,
  },
} as const satisfies Record<string, ProjectileVisualDef>;

/** Style for unknown projectile ids: a plain glowing orb. */
export const DEFAULT_PROJECTILE_VISUAL: ProjectileVisualDef = {
  glows: [
    { shape: 'orb', size: 0.22, color: [1, 0.9, 0.7], intensity: 8 },
    { shape: 'orb', size: 0.7, color: [1, 0.6, 0.3], intensity: 0.8 },
  ],
  body: null,
};

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

export interface RibbonDef {
  readonly style: StripStyle;
  /** Width (m) at the head and at the oldest point. */
  readonly width: number;
  readonly widthTail: number;
  readonly color: Rgb;
  readonly colorTail: Rgb;
  readonly intensity: number;
  readonly intensityTail: number;
  /** Seconds a stored point lives (trail length ≈ speed × life). */
  readonly life: number;
  /** Minimum distance between stored points (m). */
  readonly spacing: number;
}

export interface TrailStyleDef {
  readonly ribbon: RibbonDef | null;
  /**
   * Particle preset (defs/vfx) spawned along the path every `spacing` m (at most
   * ARSENAL_VFX.trails.maxPuffsPerFrame per trail and frame); its counts follow the particle budget.
   */
  readonly puffs: { readonly effect: string; readonly spacing: number; readonly scale: number } | null;
}

export const TRAIL_STYLES = {
  'trail.plasma': {
    ribbon: {
      style: 'glow',
      width: 0.09,
      widthTail: 0.02,
      color: PLASMA,
      colorTail: [0.1, 0.35, 1],
      intensity: 5,
      intensityTail: 0.4,
      life: 0.09,
      spacing: 0.4,
    },
    puffs: { effect: 'trail.plasma.sparks', spacing: 2.2, scale: 1 },
  },
  'trail.smoke': {
    ribbon: {
      style: 'fire',
      width: 0.05,
      widthTail: 0.01,
      color: FIRE_CORE,
      colorTail: FIRE,
      intensity: 4,
      intensityTail: 0.5,
      life: 0.08,
      spacing: 0.15,
    },
    puffs: { effect: 'trail.smoke.puff', spacing: 0.32, scale: 1 },
  },
  'trail.void': {
    ribbon: {
      style: 'void',
      width: 0.4,
      widthTail: 0.08,
      color: VOID,
      colorTail: VOID_DEEP,
      intensity: 2.6,
      intensityTail: 0.3,
      life: 0.45,
      spacing: 0.2,
    },
    puffs: { effect: 'trail.void.motes', spacing: 0.45, scale: 1 },
  },
  'trail.frost': {
    ribbon: {
      style: 'frost',
      width: 0.22,
      widthTail: 0.04,
      color: FROST_CORE,
      colorTail: FROST,
      intensity: 2.6,
      intensityTail: 0.25,
      life: 0.3,
      spacing: 0.25,
    },
    puffs: { effect: 'trail.frost.mist', spacing: 0.55, scale: 1 },
  },
  'trail.shock': {
    ribbon: {
      style: 'electric',
      width: 0.12,
      widthTail: 0.03,
      color: SHOCK_CORE,
      colorTail: SHOCK,
      intensity: 5,
      intensityTail: 0.5,
      life: 0.18,
      spacing: 0.3,
    },
    puffs: { effect: 'trail.shock.sparks', spacing: 0.9, scale: 1 },
  },
  'trail.fire': {
    ribbon: {
      style: 'fire',
      width: 0.16,
      widthTail: 0.04,
      color: FIRE_CORE,
      colorTail: FIRE,
      intensity: 4,
      intensityTail: 0.4,
      life: 0.22,
      spacing: 0.2,
    },
    puffs: { effect: 'trail.fire.embers', spacing: 0.4, scale: 1 },
  },
} as const satisfies Record<string, TrailStyleDef>;

// ---------------------------------------------------------------------------
// Beams (continuous: Kettenblitz, flamethrower; one-shot: railgun slug, void ray)
// ---------------------------------------------------------------------------

/** One jagged electric bolt (main beam, branch, chain arc). */
export interface BoltDef {
  /** Target segment length (m); the count is clamped to [minSegments, ARSENAL_VFX.beams.maxSegments]. */
  readonly segmentLength: number;
  readonly minSegments: number;
  /** Sideways displacement amplitude as a fraction of the bolt length (+ absolute floor, m). */
  readonly jitter: number;
  readonly jitterMin: number;
  /** Core width (m), colour × intensity; halo strip: width factor and intensity. */
  readonly width: number;
  readonly color: Rgb;
  readonly intensity: number;
  readonly haloWidth: number;
  readonly haloIntensity: number;
}

export interface LightningBeamDef {
  readonly kind: 'lightning';
  readonly bolt: BoltDef;
  readonly arc: BoltDef;
  readonly haloColor: Rgb;
  /** New bolt shapes per second (the flicker). */
  readonly rerollRate: number;
  /** Forks off the main bolt: count, length (fraction of the bolt), segments. */
  readonly branches: { readonly count: number; readonly length: Range; readonly segments: number };
  readonly muzzleGlow: GlowLayerDef;
  readonly hitGlow: GlowLayerDef;
  /** Particle preset at the beam end / arc ends, spawns per second. */
  readonly hitEffect: string;
  readonly hitRate: number;
  readonly arcRate: number;
  readonly light: SustainLightDef;
}

export interface FlameBeamDef {
  readonly kind: 'flame';
  /** Flame particles per second (× particle budget), their life and cone half-angle (deg). */
  readonly rate: number;
  readonly life: Range;
  readonly spreadDeg: number;
  /** Linear drag (1/s): the launch speed is solved so a particle reaches the beam end at its death. */
  readonly drag: number;
  readonly size: Range;
  readonly sizeEnd: number;
  readonly color: Rgb;
  readonly colorEnd: Rgb;
  readonly intensity: number;
  readonly intensityEnd: number;
  /** Buoyancy (× VFX.particles.gravity, negative = rises). */
  readonly gravity: number;
  /** Hot core strip from the nozzle (always drawn, also with particles off). */
  readonly core: {
    readonly length: number;
    readonly width: number;
    readonly widthEnd: number;
    readonly color: Rgb;
    readonly intensity: number;
  };
  readonly nozzleGlow: GlowLayerDef;
  /** Preset spawned where the flame ends (surface licks, smoke), spawns per second. */
  readonly hitEffect: string;
  readonly hitRate: number;
  readonly light: SustainLightDef;
  /** The light sits this fraction along the flame. */
  readonly lightAlong: number;
}

export interface RayBeamDef {
  readonly kind: 'ray';
  readonly style: StripStyle;
  readonly width: number;
  readonly color: Rgb;
  readonly intensity: number;
  readonly haloWidth: number;
  readonly haloColor: Rgb;
  readonly haloIntensity: number;
  readonly startGlow: GlowLayerDef;
  readonly endGlow: GlowLayerDef;
  /** One-shot shots (railgun slug, void ray): seconds to fade out and width growth while fading. */
  readonly fade: number;
  readonly fadeWidth: number;
  /** Preset spawned along the ray: every `spacing` m once per shot / `rate` per s while firing. */
  readonly along: { readonly effect: string; readonly spacing: number; readonly rate: number } | null;
  readonly light: SustainLightDef | null;
}

export type BeamStyleDef = LightningBeamDef | FlameBeamDef | RayBeamDef;

export const BEAM_STYLES = {
  /** EX-1 Kettenblitz: a white-hot forked bolt that jumps on to the next targets. */
  'beam.lightning': {
    kind: 'lightning',
    bolt: {
      segmentLength: 0.55,
      minSegments: 6,
      jitter: 0.045,
      jitterMin: 0.05,
      width: 0.045,
      color: SHOCK_CORE,
      intensity: 16,
      haloWidth: 7,
      haloIntensity: 1.1,
    },
    arc: {
      segmentLength: 0.45,
      minSegments: 5,
      jitter: 0.08,
      jitterMin: 0.06,
      width: 0.035,
      color: SHOCK_CORE,
      intensity: 13,
      haloWidth: 6,
      haloIntensity: 0.9,
    },
    haloColor: [0.3, 0.5, 1],
    rerollRate: 22,
    branches: { count: 3, length: [0.12, 0.3], segments: 5 },
    muzzleGlow: { shape: 'electric', size: 0.55, color: SHOCK, intensity: 5, spin: 4 },
    hitGlow: { shape: 'electric', size: 0.9, color: SHOCK, intensity: 4.5, spin: -3 },
    hitEffect: 'beam.lightning.hit',
    hitRate: 18,
    arcRate: 8,
    light: { color: [0.45, 0.62, 1], intensity: 55, range: 7, interval: 0.07, offset: 0.3 },
  },
  /** FW-4 Inferno: a roaring particle cone, white-yellow at the nozzle, dark red at the tips. */
  'beam.flame': {
    kind: 'flame',
    rate: 110,
    life: [0.32, 0.46],
    spreadDeg: 7,
    drag: 3.2,
    size: [0.1, 0.16],
    sizeEnd: 9,
    color: [1, 0.72, 0.36],
    colorEnd: [0.75, 0.12, 0.02],
    intensity: 5,
    intensityEnd: 0.35,
    gravity: -0.35,
    core: { length: 1.4, width: 0.12, widthEnd: 0.34, color: FIRE_CORE, intensity: 5 },
    nozzleGlow: { shape: 'flame', size: 0.3, color: [1, 0.62, 0.25], intensity: 5, stretch: 0.02, maxStretch: 0.2 },
    hitEffect: 'beam.flame.hit',
    hitRate: 14,
    light: { color: [1, 0.5, 0.18], intensity: 70, range: 8, interval: 0.06 },
    lightAlong: 0.45,
  },
  /** Void ray (SX-0 family, Riss-Zerreißer shots): a violet band with a dark spiralling heart. */
  'beam.void': {
    kind: 'ray',
    style: 'void',
    width: 0.16,
    color: VOID,
    intensity: 5,
    haloWidth: 0.7,
    haloColor: VOID_DEEP,
    haloIntensity: 0.9,
    startGlow: { shape: 'void', size: 0.5, color: VOID, intensity: 4, spin: 6 },
    endGlow: { shape: 'void', size: 1, color: VOID, intensity: 4, spin: -5 },
    fade: 0.35,
    fadeWidth: 1.8,
    along: { effect: 'beam.void.motes', spacing: 1.4, rate: 12 },
    light: { color: [0.6, 0.3, 1], intensity: 40, range: 6, interval: 0.08 },
  },
  /** RG-9 Lanze slug: a blinding core wound by a cyan helix that lingers and widens. */
  'beam.rail': {
    kind: 'ray',
    style: 'rail',
    width: 0.1,
    color: [0.8, 0.95, 1],
    intensity: 14,
    haloWidth: 0.5,
    haloColor: [0.2, 0.6, 1],
    haloIntensity: 1.2,
    startGlow: { shape: 'orb', size: 0.6, color: PLASMA_CORE, intensity: 6 },
    endGlow: { shape: 'ring', size: 1.4, color: PLASMA, intensity: 5 },
    fade: 0.55,
    fadeWidth: 2.4,
    along: { effect: 'beam.rail.sparks', spacing: 1.1, rate: 0 },
    light: null,
  },
} as const satisfies Record<string, BeamStyleDef>;

export const DEFAULT_BEAM_STYLE: BeamStyleDef = BEAM_STYLES['beam.void'];

// ---------------------------------------------------------------------------
// Charge glow (viewmodel muzzle)
// ---------------------------------------------------------------------------

export interface ChargeStyleDef {
  readonly color: Rgb;
  readonly coreColor: Rgb;
  readonly intensity: number;
  /** Viewmodel-space quad edge (m) at charge 0 / 1. */
  readonly size: Range;
  /** Converging sparks / arcs: pattern speed factors. */
  readonly swirl: number;
  /** Pulse rate (Hz) once fully charged. */
  readonly readyPulse: number;
  readonly light: SustainLightDef;
}

export const CHARGE_STYLES = {
  'charge.rail': {
    color: [0.3, 0.72, 1],
    coreColor: [0.85, 0.96, 1],
    intensity: 7,
    size: [0.05, 0.2],
    swirl: 1,
    readyPulse: 9,
    light: { color: [0.35, 0.7, 1], intensity: 16, range: 4, interval: 0.06, offset: 0.3 },
  },
} as const satisfies Record<string, ChargeStyleDef>;

export const DEFAULT_CHARGE_STYLE: ChargeStyleDef = CHARGE_STYLES['charge.rail'];

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface FieldAmbientDef {
  /** Particle preset (defs/vfx) spawned at random points of the field. */
  readonly effect: string;
  /** Spawns per second for a field of ARSENAL_VFX.fields.referenceRadius (∝ area), × particle budget. */
  readonly rate: number;
  /** Where: over the disc, around the core, or on the rim. */
  readonly area: 'disc' | 'core' | 'rim';
  /** Height above the floor / core (m). */
  readonly height: Range;
  readonly scale: number;
}

export interface FieldVisualDef {
  /** Flat disc: on the floor under the field (`ground`) or horizontal through the core. */
  readonly disc: {
    readonly style: DiscStyle;
    readonly color: Rgb;
    readonly intensity: number;
    /** Disc radius = field radius × radiusScale, ≤ maxRadius. */
    readonly radiusScale: number;
    readonly maxRadius: number;
    readonly ground: boolean;
  } | null;
  /** Glows at the core (field center, lifted to ≥ coreHeight above the floor). */
  readonly glows: readonly GlowLayerDef[];
  readonly coreHeight: number;
  readonly ambient: readonly FieldAmbientDef[];
  /** Streaks spiralling into the core (pull fields): spawns per second, speed, swirl share, look. */
  readonly infall: {
    readonly rate: number;
    readonly speed: Range;
    readonly swirl: number;
    readonly size: number;
    readonly color: Rgb;
    readonly colorEnd: Rgb;
    readonly intensity: number;
  } | null;
  /** Screen-space lens (pull fields): strength and radius (× field radius, ≤ maxRadius m). */
  readonly lens: { readonly strength: number; readonly radiusScale: number; readonly maxRadius: number } | null;
  readonly light: SustainLightDef | null;
  /** Grow in / fade out (s). */
  readonly fadeIn: number;
  readonly fadeOut: number;
}

export const FIELD_VISUALS = {
  /** Singularity: event horizon, photon ring, accretion disc, infalling matter, bent light. */
  'field.pull.void': {
    disc: { style: 'accretion', color: VOID, intensity: 3.2, radiusScale: 0.55, maxRadius: 2.6, ground: false },
    glows: [
      { shape: 'disc', size: 1.05, color: [0, 0, 0], intensity: 1, blend: 'dark' },
      { shape: 'ring', size: 1.5, color: [0.85, 0.6, 1], intensity: 4 },
      { shape: 'void', size: 2.1, color: VOID, intensity: 3, spin: 2.5 },
      { shape: 'swirl', size: 3.6, color: VOID_DEEP, intensity: 1.2, spin: -1.6 },
    ],
    coreHeight: 1.2,
    ambient: [{ effect: 'field.void.motes', rate: 14, area: 'disc', height: [0, 1.6], scale: 1 }],
    infall: {
      rate: 70,
      speed: [5, 9],
      swirl: 0.55,
      size: 0.035,
      color: [0.8, 0.55, 1],
      colorEnd: [1, 0.9, 1],
      intensity: 7,
    },
    lens: { strength: 1, radiusScale: 0.4, maxRadius: 2.2 },
    light: { color: [0.55, 0.25, 1], intensity: 90, range: 9, interval: 0.09 },
    fadeIn: 0.25,
    fadeOut: 0.35,
  },
  /** Burning pool: licking flames over glowing embers, rising smoke. */
  'field.damage.fire': {
    disc: { style: 'fire', color: FIRE, intensity: 2.6, radiusScale: 1, maxRadius: 6, ground: true },
    glows: [],
    coreHeight: 0,
    ambient: [
      { effect: 'field.fire.flames', rate: 26, area: 'disc', height: [0, 0.1], scale: 1 },
      { effect: 'field.fire.smoke', rate: 4, area: 'disc', height: [0.4, 0.9], scale: 1 },
    ],
    infall: null,
    lens: null,
    light: { color: [1, 0.45, 0.14], intensity: 60, range: 7, interval: 0.07, offset: 0.6 },
    fadeIn: 0.2,
    fadeOut: 0.8,
  },
  /** Toxic cloud: a bubbling puddle under a slow, murky green fog. */
  'field.damage.poison': {
    disc: { style: 'poison', color: POISON, intensity: 1.4, radiusScale: 1, maxRadius: 6, ground: true },
    glows: [],
    coreHeight: 0,
    ambient: [
      { effect: 'field.poison.mist', rate: 9, area: 'disc', height: [0.1, 0.8], scale: 1 },
      { effect: 'field.poison.bubbles', rate: 10, area: 'disc', height: [0, 0.05], scale: 1 },
    ],
    infall: null,
    lens: null,
    light: { color: [0.35, 1, 0.25], intensity: 16, range: 6, interval: 0.12, offset: 0.5 },
    fadeIn: 0.4,
    fadeOut: 1,
  },
  /** Frost field: rime crystals racing out over the floor, cold mist, glittering ice dust. */
  'field.slow.ice': {
    disc: { style: 'frost', color: FROST, intensity: 2.2, radiusScale: 1, maxRadius: 7, ground: true },
    glows: [],
    coreHeight: 0,
    ambient: [
      { effect: 'field.frost.mist', rate: 7, area: 'disc', height: [0, 0.3], scale: 1 },
      { effect: 'field.frost.glitter', rate: 16, area: 'disc', height: [0.05, 1.2], scale: 1 },
    ],
    infall: null,
    lens: null,
    light: { color: [0.45, 0.75, 1], intensity: 20, range: 7, interval: 0.12, offset: 0.4 },
    fadeIn: 0.35,
    fadeOut: 0.9,
  },
} as const satisfies Record<string, FieldVisualDef>;

export const DEFAULT_FIELD_VISUAL: FieldVisualDef = FIELD_VISUALS['field.damage.fire'];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function lookup<T>(table: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

export function getProjectileVisual(id: string): ProjectileVisualDef | undefined {
  return lookup<ProjectileVisualDef>(PROJECTILE_VISUALS, id);
}
export function getTrailStyle(id: string): TrailStyleDef | undefined {
  return lookup<TrailStyleDef>(TRAIL_STYLES, id);
}
export function getBeamStyle(id: string): BeamStyleDef | undefined {
  return lookup<BeamStyleDef>(BEAM_STYLES, id);
}
export function getChargeStyle(id: string): ChargeStyleDef | undefined {
  return lookup<ChargeStyleDef>(CHARGE_STYLES, id);
}
export function getFieldVisual(id: string): FieldVisualDef | undefined {
  return lookup<FieldVisualDef>(FIELD_VISUALS, id);
}

// ---------------------------------------------------------------------------
// System tuning
// ---------------------------------------------------------------------------

export const ARSENAL_VFX = {
  /** Simultaneous projectiles drawn (dozens of plasma bolts + grenades + orbs). */
  projectiles: { capacity: 96 },
  /** Solid grenade bodies drawn at once (per mesh). */
  bodies: { capacity: 48 },
  trails: {
    /** Live ribbons (a trail outlives its projectile until its points expire). */
    capacity: 128,
    /** Stored points per ribbon (older ones are dropped early). */
    maxPoints: 20,
    /** Particle puffs one trail may spawn per frame (fast projectiles at low frame rates). */
    maxPuffsPerFrame: 3,
  },
  glows: {
    /** Emissive / dark sprites per frame. */
    capacity: 640,
    darkCapacity: 96,
    /** Sprites never shrink below this on screen (px) – far bolts stay visible. */
    minPixelSize: 3,
    /** Pulled towards the camera by size × depthPull (not cut by the wall behind them). */
    depthPull: 0.5,
    depthPullMinDistance: 0.1,
    /** Dark discs composite over lit smoke (5) and below the level's light cones (10). */
    darkRenderOrder: 8,
    renderOrder: 24,
  },
  strips: {
    /** Segments per frame (trails + beams + arcs + shots). */
    capacity: 3072,
    minPixelWidth: 1.5,
    renderOrder: 23,
  },
  discs: {
    capacity: 32,
    /** Lift off the floor (m) on top of the polygon offset. */
    lift: 0.025,
    renderOrder: 12,
  },
  beams: {
    /** Beams drawn at once (the player's beam weapon + previews). */
    channels: 4,
    /** Chain arcs per beam. */
    maxArcs: 8,
    /** Vertices of one bolt (main beam). */
    maxSegments: 40,
    /** One-shot rays (railgun slugs, void rays) fading at once. */
    shots: 12,
  },
  fields: {
    capacity: 24,
    /** Ambient spawn rates are authored for this radius (∝ area). */
    referenceRadius: 3,
    /** Floor probe below a field (m) and lift of pull cores near the floor. */
    floorProbe: 4,
    /** Most ambient spawns per field and frame (long frames). */
    maxSpawnsPerFrame: 6,
  },
  charge: { renderOrder: 51 },
  /** Screen-space lenses at once (singularity fields + void orbs). */
  lenses: 4,
  /** Dev preview (`fx` console command). */
  preview: {
    /** Seconds a previewed beam fires, a field lasts (0 = its own duration), a charge takes. */
    beamSeconds: 3,
    fieldSeconds: 6,
    fieldRadius: 4,
    chargeSeconds: 1.6,
    projectileSpeed: 24,
    projectileSeconds: 2.5,
    /** Spawn ahead of the camera (m) and fake chain-arc spread for previewed lightning. */
    ahead: 0.6,
    arcSpread: 3,
  },
} as const;
