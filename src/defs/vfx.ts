/**
 * Visual effects tuning: particle budgets, effect presets (impacts, muzzle, explosions, landing
 * dust), impact profiles (surface → effect + decal), decal kinds, casings, tracers, flash lights.
 * Everything the VFX systems spawn is data here – systems never branch on a preset id.
 *
 * Units: meters, seconds, m/s; cone half-angles (`spread`) in DEGREES; colors are LINEAR RGB and
 * multiplied by `intensity` (HDR: values above POSTFX.bloom.luminanceThreshold bloom). Light
 * intensities are candela (physically based point lights, decay 2) like the level lights.
 *
 * Extension points: new effects are new entries in VFX_EFFECTS; weapons reference them by id
 * (WeaponVfxDef.muzzle / impact / casing), unknown ids are ignored at runtime. Every element has
 * its own explosion preset (EXPLOSION_PRESET); an element without one tints the frag blast by
 * ELEMENT_TINTS. M5 arsenal presets (muzzle.* / impact.* families, element explosions, trail
 * puffs, beam hits, field ambience, status.* and combo.* bursts) follow the naming conventions of
 * defs/weaponData/common.ts; the arsenal's projectile / trail / beam / field STYLES live in
 * defs/arsenalVfx.ts.
 */
import type { DamageElement, FleshSurface, ImpactKind, SurfaceType } from '../core/events';
import type { QualityLevel } from '../save/settingsSchema';
import { QUALITY_LEVELS } from './graphics';
import { COLLISION_GROUP } from './physics';

export type Rgb = readonly [number, number, number];
/** Inclusive random range [min, max]. */
export type Range = readonly [number, number];

// ---------------------------------------------------------------------------
// Sprite atlas (particles, tracers, muzzle flash) – generated procedurally at boot
// ---------------------------------------------------------------------------

/** Cell order of the procedural sprite atlas (row-major, see vfx/spriteAtlas.ts). */
export const SPRITES = [
  'spark',
  'smoke',
  'smokeB',
  'dust',
  'flash',
  'droplet',
  'ember',
  'ring',
  'flame',
  'chip',
  'glow',
  'petal',
  'mist',
  'shard',
  'streak',
  'star',
] as const;
export type SpriteId = (typeof SPRITES)[number];

export const SPRITE_ATLAS = {
  cols: 4,
  rows: 4,
  /** Pixels per cell (power of two keeps mipmaps clean). */
  cellSize: 128,
  seed: 7331,
} as const;

// ---------------------------------------------------------------------------
// Effect presets
// ---------------------------------------------------------------------------

export type ParticleBlend = 'add' | 'alpha';

/**
 * One burst of particles. Counts are multiplied by the particle quality budget
 * (QUALITY_LEVELS.particles.budgetMultiplier) and clamped by `minCount` while particles are on.
 */
export interface EmitterDef {
  /** 'add': emissive (sparks, fire, glow). 'alpha': lit, sorted (smoke, dust, blood, debris). */
  readonly blend: ParticleBlend;
  readonly sprite: SpriteId;
  readonly count: Range;
  /** Minimum count while particles are enabled (essential feedback survives low budgets). */
  readonly minCount?: number;
  readonly life: Range;
  /** Initial speed (m/s); scaled by the effect scale. */
  readonly speed: Range;
  /**
   * Emission axis: effect normal (surface / aim direction), world up / down, or 'reflect': the shot
   * direction mirrored at the surface (ricochets skim along it at grazing angles; the normal when
   * the shot direction is unknown). Default 'normal'.
   */
  readonly axis?: 'normal' | 'up' | 'down' | 'reflect';
  /** Cone half-angle around the axis (DEGREES, 180 = full sphere). */
  readonly spread: number;
  /** Start size (quad edge, m); scaled by the effect scale. */
  readonly size: Range;
  /** Size multiplier reached at the end of life (ease-out). Default 1. */
  readonly sizeEnd?: number;
  readonly color: Rgb;
  /** Color at the end of life (default: `color`). */
  readonly colorEnd?: Rgb;
  /** HDR multiplier on `color` / `colorEnd` (default 1 / `intensity`). */
  readonly intensity?: number;
  readonly intensityEnd?: number;
  /** Opacity at birth / death (default 1 → 0). */
  readonly alpha?: number;
  readonly alphaEnd?: number;
  /** Fractions of life spent fading in / out (default 0); fadeOut + alphaEnd = alpha makes smoke hold, then dissolve. */
  readonly fadeIn?: number;
  readonly fadeOut?: number;
  /** Multiplier on VFX.particles.gravity (negative = buoyant). Default 0. */
  readonly gravity?: number;
  /** Linear drag (1/s). Default 0. */
  readonly drag?: number;
  /** Velocity stretch (s): the quad trails `speed · stretch` meters behind the particle. */
  readonly stretch?: number;
  /** Spin (rad/s), random in range; start rotation is always random. */
  readonly spin?: Range;
  /** Bounce off the spawn surface plane and the floor below (restitution 0..1). */
  readonly bounce?: number;
  /** Spawn offset along the axis (m) and random spawn sphere radius (m), both scaled. */
  readonly offset?: number;
  readonly jitter?: number;
  /**
   * Spawn on a shell of this radius (m, scaled) along each particle's OWN direction; with a
   * negative `speed` the particles fall back into the center (implosions, converging motes).
   */
  readonly shell?: number;
  /** Tinted by the explosion element (ELEMENT_TINTS). */
  readonly elemental?: boolean;
  /** A bright flash (dimmed by the reduce-flashing accessibility option). */
  readonly flash?: boolean;
}

export interface LightFlashDef {
  readonly color: Rgb;
  /** Peak intensity (candela). */
  readonly intensity: number;
  /** Cutoff distance (m). */
  readonly range: number;
  /** Time until the light is dark again (s). */
  readonly duration: number;
  /** 0..1 random flicker depth. */
  readonly flicker?: number;
  /** Offset along the effect normal (m). */
  readonly offset?: number;
  /**
   * Pool priority: a flash only takes over a light of lower or equal priority. Low-priority
   * flashes (impacts) are also capped per frame (VFX.lights.lowPriorityPerFrame).
   */
  readonly priority: 0 | 1 | 2;
  /**
   * Also lights the weapon in the viewmodel scene (VFX.lights.viewmodel; default true). Muzzle
   * flashes set false: the viewmodel rig has its own muzzle light.
   */
  readonly viewmodel?: boolean;
}

/** First-person flash sprite on the weapon's muzzle socket (viewmodel scene). */
export interface MuzzleFlashDef {
  /** Face-on star size (m, viewmodel space). */
  readonly size: number;
  /** Side flame tongue length along the barrel (m, 0 = none). */
  readonly length: number;
  readonly color: Rgb;
  readonly intensity: number;
  /** Visible time (s); fades out over it. */
  readonly duration: number;
  /** Multiplier while aiming down sights (keeps the sight picture clear). */
  readonly adsScale: number;
}

export interface EffectPreset {
  readonly emitters: readonly EmitterDef[];
  readonly light?: LightFlashDef;
  /** Viewmodel flash (muzzle presets only). */
  readonly flash?: MuzzleFlashDef;
  /** camera:shake trauma at the effect, falling off linearly to 0 at `range` m (× effect scale). */
  readonly shake?: { readonly trauma: number; readonly range: number };
  /** fx:hitPulse (chromatic aberration) strength, falling off like `shake`. */
  readonly hitPulse?: { readonly strength: number; readonly range: number };
  /** Screen-space shockwave: world radius = explosion radius × radiusScale. */
  readonly shockwave?: { readonly strength: number; readonly radiusScale: number };
  /** Decal found by probing down from the effect (scorch marks): size = scale × sizePerScale. */
  readonly groundDecal?: { readonly kind: DecalKind; readonly sizePerScale: number; readonly probe: number };
  /** Explosions: radius at which the preset is authored (scale = radius / referenceRadius). */
  readonly referenceRadius?: number;
  /**
   * Muzzle presets (M5): hitscan shots of weapons with this muzzle draw this arsenal ray style
   * (defs/arsenalVfx BEAM_STYLES, e.g. the railgun slug) instead of a thin tracer.
   */
  readonly tracer?: string;
}

// Shared colors (linear).
const HOT: Rgb = [1, 0.62, 0.28];
const HOT_END: Rgb = [1, 0.28, 0.05];
const SMOKE_GREY: Rgb = [0.34, 0.33, 0.32];
const CONCRETE_DUST: Rgb = [0.46, 0.43, 0.39];
const BLOOD: Rgb = [0.3, 0.012, 0.01];
const SLIME: Rgb = [0.28, 1, 0.34];
const SHIELD: Rgb = [0.3, 0.8, 1];

/** Velocity-stretched sparks use the 'streak' cell: a line along the quad with a hot head. */
const METAL_SPARKS: EmitterDef = {
  blend: 'add',
  sprite: 'streak',
  count: [10, 16],
  minCount: 4,
  life: [0.18, 0.45],
  speed: [4, 11],
  axis: 'reflect',
  spread: 62,
  size: [0.012, 0.022],
  sizeEnd: 0.6,
  color: HOT,
  intensity: 22,
  colorEnd: HOT_END,
  intensityEnd: 4,
  gravity: 1,
  drag: 1.2,
  stretch: 0.018,
  bounce: 0.45,
  offset: 0.01,
};

const IMPACT_STAR: EmitterDef = {
  blend: 'add',
  sprite: 'star',
  count: [1, 1],
  minCount: 1,
  life: [0.05, 0.07],
  speed: [0, 0],
  spread: 0,
  size: [0.14, 0.2],
  sizeEnd: 1.3,
  color: [1, 0.85, 0.6],
  intensity: 16,
  intensityEnd: 0,
  alphaEnd: 0,
  offset: 0.02,
  flash: true,
};

const IMPACT_GLOW: EmitterDef = {
  blend: 'add',
  sprite: 'glow',
  count: [1, 1],
  minCount: 1,
  life: [0.1, 0.14],
  speed: [0, 0],
  spread: 0,
  size: [0.1, 0.14],
  sizeEnd: 0.6,
  color: [1, 0.5, 0.18],
  intensity: 6,
  offset: 0.015,
};

const IMPACT_SMOKE: EmitterDef = {
  blend: 'alpha',
  sprite: 'smoke',
  count: [1, 2],
  life: [0.6, 1.0],
  speed: [0.3, 0.8],
  spread: 30,
  size: [0.08, 0.14],
  sizeEnd: 3.5,
  color: SMOKE_GREY,
  alpha: 0.35,
  alphaEnd: 0.3,
  fadeIn: 0.1,
  fadeOut: 0.5,
  gravity: -0.08,
  drag: 2,
  spin: [-0.8, 0.8],
  offset: 0.04,
};

/** A point light right at the surface makes a tiny white-hot disc: keep it off the wall and soft. */
const IMPACT_LIGHT: LightFlashDef = {
  color: [1, 0.66, 0.36],
  intensity: 2,
  range: 2.5,
  duration: 0.06,
  offset: 0.25,
  priority: 0,
};

/** Base preset for muzzle smoke wisps (the aim direction is the effect normal). */
const MUZZLE_SMOKE: EmitterDef = {
  blend: 'alpha',
  sprite: 'smoke',
  count: [1, 2],
  life: [0.5, 0.9],
  speed: [0.4, 1],
  spread: 14,
  size: [0.03, 0.05],
  sizeEnd: 5,
  color: [0.5, 0.49, 0.47],
  alpha: 0.22,
  alphaEnd: 0.18,
  fadeIn: 0.2,
  fadeOut: 0.5,
  gravity: -0.12,
  drag: 3,
  spin: [-1, 1],
  offset: 0.02,
};

/**
 * Muzzle flash lights sit a little ahead of the barrel (offset along the aim): a point light at
 * the muzzle itself would blow ejected brass next to it up into bloom blobs.
 */
const MUZZLE_LIGHT_OFFSET = 0.3;

const MUZZLE_SPARKS: EmitterDef = {
  blend: 'add',
  sprite: 'streak',
  count: [0, 2],
  life: [0.06, 0.12],
  speed: [6, 12],
  spread: 12,
  size: [0.006, 0.009],
  color: [1, 0.72, 0.36],
  intensity: 12,
  colorEnd: HOT_END,
  intensityEnd: 3,
  gravity: 0.5,
  stretch: 0.01,
};

// --- M5 arsenal: element palette and emitter building blocks ---
const PLASMA_C: Rgb = [0.3, 0.78, 1];
const PLASMA_HOT: Rgb = [0.75, 0.95, 1];
const SHOCK_C: Rgb = [0.5, 0.7, 1];
const SHOCK_HOT: Rgb = [0.85, 0.92, 1];
const VOID_C: Rgb = [0.62, 0.22, 1];
const VOID_DEEP: Rgb = [0.34, 0.06, 0.8];
const VOID_SMOKE: Rgb = [0.05, 0.02, 0.08];
const FROST_C: Rgb = [0.55, 0.85, 1];
const FROST_HOT: Rgb = [0.85, 0.97, 1];
const FROST_MIST: Rgb = [0.72, 0.84, 0.94];
const FIRE_C: Rgb = [1, 0.5, 0.14];
const FIRE_END: Rgb = [0.75, 0.13, 0.02];
const POISON_C: Rgb = [0.35, 1, 0.22];
const POISON_MIST: Rgb = [0.16, 0.32, 0.08];
const SOOT: Rgb = [0.12, 0.11, 0.1];

/** One bright camera-facing flash (explosion / impact / muzzle core). */
function flashGlow(color: Rgb, size: number, life: number, intensity: number, offset = 0): EmitterDef {
  return {
    blend: 'add',
    sprite: 'glow',
    count: [1, 1],
    minCount: 1,
    life: [life * 0.85, life],
    speed: [0, 0],
    spread: 0,
    size: [size, size],
    sizeEnd: 0.5,
    color,
    intensity,
    intensityEnd: 0,
    offset,
    flash: true,
  };
}

/** An expanding shock ring (camera-facing). */
function shockRing(color: Rgb, size: number, sizeEnd: number, life: number, intensity: number, offset = 0): EmitterDef {
  return {
    blend: 'add',
    sprite: 'ring',
    count: [1, 1],
    minCount: 1,
    life: [life * 0.9, life],
    speed: [0, 0],
    spread: 0,
    size: [size, size],
    sizeEnd,
    color,
    intensity,
    intensityEnd: 0,
    alpha: 0.85,
    offset,
  };
}

/** Velocity-stretched spark streaks (no bounce: cheap, no floor probe). */
function streaks(
  color: Rgb,
  count: Range,
  speed: Range,
  life: Range,
  intensity: number,
  spread = 180,
  extra: Partial<EmitterDef> = {},
): EmitterDef {
  return {
    blend: 'add',
    sprite: 'streak',
    count,
    life,
    speed,
    spread,
    size: [0.012, 0.022],
    sizeEnd: 0.5,
    color,
    intensity,
    intensityEnd: intensity * 0.2,
    gravity: 0.5,
    drag: 1.5,
    stretch: 0.02,
    ...extra,
  };
}

/** Drifting glowing motes (embers, void motes, toxic spores). */
function motes(color: Rgb, count: Range, speed: Range, life: Range, intensity: number, extra: Partial<EmitterDef> = {}): EmitterDef {
  return {
    blend: 'add',
    sprite: 'ember',
    count,
    life,
    speed,
    spread: 180,
    size: [0.02, 0.04],
    sizeEnd: 0.3,
    color,
    intensity,
    intensityEnd: intensity * 0.2,
    gravity: -0.15,
    drag: 1.5,
    ...extra,
  };
}

/** Lit, alpha-blended billowing smoke / mist / steam. */
function billow(
  sprite: 'smoke' | 'smokeB' | 'mist' | 'dust',
  color: Rgb,
  count: Range,
  size: Range,
  sizeEnd: number,
  life: Range,
  speed: Range,
  alpha: number,
  extra: Partial<EmitterDef> = {},
): EmitterDef {
  return {
    blend: 'alpha',
    sprite,
    count,
    life,
    speed,
    spread: 60,
    size,
    sizeEnd,
    color,
    alpha,
    alphaEnd: alpha * 0.8,
    fadeIn: 0.12,
    fadeOut: 0.5,
    gravity: -0.08,
    drag: 2,
    spin: [-0.8, 0.8],
    ...extra,
  };
}

/** Rising flame tongues. */
function flames(count: Range, size: Range, life: Range, speed: Range, intensity: number, extra: Partial<EmitterDef> = {}): EmitterDef {
  return {
    blend: 'add',
    sprite: 'flame',
    count,
    life,
    speed,
    axis: 'up',
    spread: 22,
    size,
    sizeEnd: 2.2,
    color: FIRE_C,
    intensity,
    colorEnd: FIRE_END,
    intensityEnd: intensity * 0.2,
    alpha: 0.9,
    drag: 2,
    gravity: -0.45,
    spin: [-2, 2],
    ...extra,
  };
}

/**
 * Licking flame tongues: 'petal' sprites stretched along their rise (the tip leads), narrowing and
 * slowing as they burn out – burning pools, burning enemies, flame hits.
 */
function tongues(count: Range, width: Range, life: Range, speed: Range, intensity: number, extra: Partial<EmitterDef> = {}): EmitterDef {
  return {
    blend: 'add',
    sprite: 'petal',
    count,
    life,
    speed,
    axis: 'up',
    spread: 10,
    size: width,
    sizeEnd: 0.45,
    color: [1, 0.62, 0.22],
    intensity,
    colorEnd: FIRE_END,
    intensityEnd: intensity * 0.25,
    alpha: 1,
    gravity: -0.35,
    drag: 1.8,
    stretch: 0.22,
    ...extra,
  };
}

/** Energy-weapon muzzle light (no viewmodel light: the rig has its own muzzle light). */
function muzzleLight(color: Rgb, intensity: number, range: number, duration = 0.05): LightFlashDef {
  return { color, intensity, range, duration, offset: MUZZLE_LIGHT_OFFSET, priority: 1, viewmodel: false };
}

/** Impact flash light (low priority, capped per frame). */
function impactLight(color: Rgb, intensity = 2.5): LightFlashDef {
  return { ...IMPACT_LIGHT, color, intensity };
}

/** Element explosion light (priority 2 like the frag blast). */
function blastLight(color: Rgb, intensity: number, duration: number, flicker: number): LightFlashDef {
  return { color, intensity, range: 16, duration, flicker, offset: 0.5, priority: 2 };
}

/** Status / combo light on an enemy. */
function bodyLight(color: Rgb, intensity: number, duration: number): LightFlashDef {
  return { color, intensity, range: 6, duration, offset: 0.3, priority: 1, flicker: 0.3 };
}

export const VFX_EFFECTS = {
  // --- impacts: world surfaces ---
  'impact.metal': {
    emitters: [METAL_SPARKS, IMPACT_STAR, IMPACT_GLOW, { ...IMPACT_SMOKE, count: [0, 1] }],
    light: IMPACT_LIGHT,
  },
  'impact.concrete': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'dust',
        count: [3, 5],
        minCount: 1,
        life: [0.5, 1.1],
        speed: [0.6, 2.2],
        spread: 35,
        size: [0.06, 0.12],
        sizeEnd: 4,
        color: CONCRETE_DUST,
        alpha: 0.55,
        drag: 3.5,
        gravity: 0.05,
        spin: [-1.2, 1.2],
        offset: 0.03,
      },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [5, 9],
        minCount: 2,
        life: [0.4, 0.9],
        speed: [2.5, 6],
        spread: 55,
        size: [0.012, 0.025],
        color: [0.36, 0.34, 0.31],
        alpha: 1,
        alphaEnd: 0.2,
        gravity: 1.3,
        drag: 0.4,
        spin: [-20, 20],
        bounce: 0.3,
        offset: 0.01,
      },
      {
        ...IMPACT_SMOKE,
        sprite: 'smokeB',
        life: [1, 1.8],
        size: [0.1, 0.16],
        sizeEnd: 5,
        color: [0.42, 0.4, 0.38],
        alpha: 0.3,
      },
      {
        ...METAL_SPARKS,
        count: [2, 4],
        minCount: 0,
        life: [0.08, 0.2],
        speed: [3, 7],
        size: [0.008, 0.012],
        intensity: 10,
        stretch: 0.012,
      },
      { ...IMPACT_GLOW, size: [0.07, 0.09], intensity: 4, life: [0.05, 0.06] },
    ],
  },
  'impact.grate': {
    emitters: [
      { ...METAL_SPARKS, count: [12, 18], spread: 75, speed: [5, 13] },
      IMPACT_STAR,
      { ...IMPACT_GLOW, intensity: 8 },
    ],
    light: { ...IMPACT_LIGHT, intensity: 2.5 },
  },
  'impact.glass': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [6, 10],
        minCount: 2,
        life: [0.5, 1.1],
        speed: [1.5, 5],
        spread: 50,
        size: [0.015, 0.035],
        color: [0.75, 0.85, 0.9],
        alpha: 0.8,
        alphaEnd: 0.2,
        gravity: 1.2,
        drag: 0.3,
        spin: [-25, 25],
        bounce: 0.25,
        offset: 0.01,
      },
      {
        blend: 'add',
        sprite: 'star',
        count: [2, 4],
        life: [0.1, 0.25],
        speed: [1, 3],
        spread: 60,
        size: [0.025, 0.04],
        color: [0.8, 0.9, 1],
        intensity: 8,
        intensityEnd: 0,
        gravity: 0.6,
        spin: [-6, 6],
      },
      {
        blend: 'alpha',
        sprite: 'dust',
        count: [1, 2],
        life: [0.4, 0.7],
        speed: [0.4, 1.2],
        spread: 30,
        size: [0.05, 0.08],
        sizeEnd: 3,
        color: [0.7, 0.74, 0.76],
        alpha: 0.3,
        drag: 3,
      },
    ],
  },
  'impact.rubber': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [4, 6],
        minCount: 1,
        life: [0.35, 0.7],
        speed: [1.5, 4],
        spread: 45,
        size: [0.01, 0.02],
        color: [0.07, 0.07, 0.07],
        alphaEnd: 0.3,
        gravity: 1.2,
        spin: [-15, 15],
        bounce: 0.5,
      },
      {
        blend: 'alpha',
        sprite: 'dust',
        count: [1, 2],
        life: [0.5, 0.9],
        speed: [0.3, 1],
        spread: 30,
        size: [0.05, 0.09],
        sizeEnd: 3,
        color: [0.16, 0.15, 0.15],
        alpha: 0.4,
        drag: 3,
      },
    ],
  },
  // --- impacts: bodies ---
  'impact.flesh': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [2, 3],
        minCount: 1,
        life: [0.25, 0.5],
        speed: [0.5, 1.6],
        spread: 40,
        size: [0.12, 0.2],
        sizeEnd: 2.5,
        color: [0.36, 0.025, 0.02],
        alpha: 0.8,
        drag: 4,
        gravity: 0.1,
        spin: [-2, 2],
      },
      {
        blend: 'alpha',
        sprite: 'droplet',
        count: [6, 10],
        minCount: 2,
        life: [0.4, 0.8],
        speed: [1.5, 4.5],
        spread: 45,
        size: [0.012, 0.025],
        color: BLOOD,
        alphaEnd: 0.6,
        gravity: 1.2,
        drag: 0.3,
        stretch: 0.01,
        bounce: 0,
      },
    ],
  },
  'impact.slime': {
    emitters: [
      {
        blend: 'add',
        sprite: 'droplet',
        count: [6, 10],
        minCount: 2,
        life: [0.4, 0.9],
        speed: [1.5, 4.5],
        spread: 50,
        size: [0.014, 0.028],
        color: SLIME,
        intensity: 3.5,
        intensityEnd: 1.2,
        gravity: 1.1,
        drag: 0.4,
        stretch: 0.012,
        bounce: 0.1,
      },
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [2, 3],
        minCount: 1,
        life: [0.3, 0.6],
        speed: [0.4, 1.4],
        spread: 40,
        size: [0.12, 0.22],
        sizeEnd: 2.2,
        color: [0.12, 0.4, 0.1],
        alpha: 0.7,
        drag: 4,
        spin: [-2, 2],
      },
      { ...IMPACT_GLOW, color: SLIME, intensity: 3, size: [0.14, 0.2] },
    ],
  },
  /** Enemy acid glob in flight (combat/Projectiles, every ~0.06 s per glob): a fading glow + drip. */
  'acid.trail': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        life: [0.18, 0.26],
        speed: [0, 0.2],
        spread: 180,
        size: [0.16, 0.22],
        sizeEnd: 0.3,
        color: SLIME,
        intensity: 2.5,
        intensityEnd: 0.6,
      },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [0, 1],
        life: [0.3, 0.5],
        speed: [0.2, 0.8],
        axis: 'down',
        spread: 35,
        size: [0.012, 0.02],
        color: SLIME,
        intensity: 3,
        intensityEnd: 1,
        gravity: 1,
        stretch: 0.012,
      },
    ],
  },
  'impact.shield': {
    emitters: [
      {
        blend: 'add',
        sprite: 'ring',
        count: [1, 1],
        minCount: 1,
        life: [0.2, 0.24],
        speed: [0, 0],
        spread: 0,
        size: [0.1, 0.12],
        sizeEnd: 5,
        color: SHIELD,
        intensity: 8,
        intensityEnd: 0,
        offset: 0.02,
      },
      {
        ...METAL_SPARKS,
        color: [0.4, 0.85, 1],
        colorEnd: [0.2, 0.4, 1],
        intensity: 12,
        intensityEnd: 2,
        count: [6, 10],
      },
      { ...IMPACT_GLOW, color: SHIELD, intensity: 5 },
    ],
    light: { ...IMPACT_LIGHT, color: SHIELD, intensity: 2.5 },
  },

  // --- muzzle (world part: light + smoke; `flash` is the viewmodel sprite) ---
  'muzzle.pistol': {
    emitters: [MUZZLE_SMOKE, MUZZLE_SPARKS],
    light: {
      color: [1, 0.72, 0.4],
      intensity: 24,
      range: 6,
      duration: 0.05,
      offset: MUZZLE_LIGHT_OFFSET,
      priority: 1,
      viewmodel: false,
    },
    flash: {
      size: 0.085,
      length: 0.12,
      color: [1, 0.78, 0.5],
      intensity: 14,
      duration: 0.045,
      adsScale: 0.6,
    },
  },
  'muzzle.rifle': {
    emitters: [{ ...MUZZLE_SMOKE, count: [1, 1], size: [0.035, 0.055] }, MUZZLE_SPARKS],
    light: {
      color: [1, 0.69, 0.38],
      intensity: 28,
      range: 7,
      duration: 0.05,
      offset: MUZZLE_LIGHT_OFFSET,
      priority: 1,
      viewmodel: false,
    },
    flash: { size: 0.1, length: 0.2, color: [1, 0.74, 0.44], intensity: 16, duration: 0.04, adsScale: 0.55 },
  },
  'muzzle.shotgun': {
    emitters: [
      {
        ...MUZZLE_SMOKE,
        count: [3, 4],
        size: [0.05, 0.08],
        speed: [0.6, 1.6],
        spread: 20,
        alpha: 0.3,
        life: [0.7, 1.2],
      },
      { ...MUZZLE_SPARKS, count: [4, 8], spread: 16, speed: [7, 15] },
      {
        blend: 'add',
        sprite: 'ember',
        count: [2, 4],
        life: [0.25, 0.5],
        speed: [3, 7],
        spread: 18,
        size: [0.01, 0.016],
        color: [1, 0.55, 0.2],
        intensity: 8,
        intensityEnd: 1,
        gravity: 0.6,
        drag: 1.5,
      },
    ],
    light: {
      color: [1, 0.66, 0.33],
      intensity: 45,
      range: 9,
      duration: 0.07,
      offset: MUZZLE_LIGHT_OFFSET,
      priority: 1,
      viewmodel: false,
    },
    flash: { size: 0.16, length: 0.3, color: [1, 0.7, 0.4], intensity: 20, duration: 0.05, adsScale: 0.7 },
  },

  // --- explosions (authored at referenceRadius; element tints on `elemental` emitters) ---
  'explosion.frag': {
    referenceRadius: 4,
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.08, 0.1],
        speed: [0, 0],
        spread: 0,
        size: [2.6, 2.6],
        sizeEnd: 0.5,
        color: [1, 0.8, 0.55],
        intensity: 4,
        intensityEnd: 0,
        elemental: true,
        flash: true,
      },
      {
        blend: 'add',
        sprite: 'flame',
        count: [16, 22],
        minCount: 6,
        life: [0.35, 0.7],
        speed: [2, 7],
        axis: 'up',
        spread: 180,
        size: [0.9, 1.5],
        sizeEnd: 2.4,
        color: [1, 0.46, 0.13],
        intensity: 2.2,
        colorEnd: [0.7, 0.12, 0.02],
        intensityEnd: 0.5,
        alpha: 0.85,
        drag: 4.5,
        gravity: -0.35,
        spin: [-2, 2],
        jitter: 0.4,
        elemental: true,
      },
      {
        blend: 'alpha',
        sprite: 'smoke',
        count: [16, 22],
        minCount: 4,
        life: [2.4, 4.2],
        speed: [0.6, 2.6],
        axis: 'up',
        spread: 70,
        size: [0.8, 1.3],
        sizeEnd: 3.2,
        color: [0.13, 0.12, 0.11],
        alpha: 0.85,
        alphaEnd: 0.7,
        fadeIn: 0.12,
        fadeOut: 0.5,
        gravity: -0.12,
        drag: 1.1,
        spin: [-0.6, 0.6],
        jitter: 0.6,
      },
      {
        blend: 'alpha',
        sprite: 'smokeB',
        count: [6, 9],
        minCount: 2,
        life: [1.5, 2.5],
        speed: [2, 5],
        axis: 'up',
        spread: 88,
        size: [0.5, 0.8],
        sizeEnd: 2.6,
        color: [0.18, 0.17, 0.15],
        alpha: 0.6,
        alphaEnd: 0.5,
        fadeIn: 0.05,
        fadeOut: 0.5,
        gravity: -0.05,
        drag: 2.5,
        spin: [-0.5, 0.5],
        offset: 0.2,
      },
      {
        blend: 'add',
        sprite: 'streak',
        count: [36, 52],
        minCount: 10,
        life: [0.5, 1.3],
        speed: [9, 24],
        axis: 'up',
        spread: 180,
        size: [0.025, 0.04],
        sizeEnd: 0.5,
        color: [1, 0.7, 0.35],
        intensity: 16,
        colorEnd: HOT_END,
        intensityEnd: 3,
        gravity: 1,
        drag: 0.7,
        stretch: 0.022,
        bounce: 0.35,
        elemental: true,
      },
      {
        blend: 'add',
        sprite: 'ember',
        count: [18, 28],
        minCount: 4,
        life: [1.4, 3.2],
        speed: [2, 8],
        axis: 'up',
        spread: 110,
        size: [0.025, 0.045],
        sizeEnd: 0.3,
        color: [1, 0.55, 0.18],
        intensity: 10,
        colorEnd: [0.8, 0.15, 0.02],
        intensityEnd: 2,
        gravity: 0.3,
        drag: 1.4,
        bounce: 0.2,
        jitter: 0.5,
        elemental: true,
      },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [12, 18],
        minCount: 3,
        life: [1.2, 2.2],
        speed: [5, 13],
        axis: 'up',
        spread: 75,
        size: [0.045, 0.1],
        color: [0.12, 0.11, 0.1],
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.3,
        spin: [-15, 15],
        bounce: 0.3,
      },
      {
        blend: 'add',
        sprite: 'ring',
        count: [1, 1],
        minCount: 1,
        life: [0.28, 0.32],
        speed: [0, 0],
        spread: 0,
        size: [0.8, 0.8],
        sizeEnd: 6,
        color: [1, 0.75, 0.45],
        intensity: 3,
        intensityEnd: 0,
        alpha: 0.8,
        offset: 0.3,
        elemental: true,
      },
    ],
    light: {
      color: [1, 0.58, 0.28],
      intensity: 350,
      range: 16,
      duration: 0.5,
      flicker: 0.35,
      offset: 0.5,
      priority: 2,
    },
    shake: { trauma: 1, range: 20 },
    hitPulse: { strength: 0.6, range: 14 },
    shockwave: { strength: 1, radiusScale: 2.2 },
    groundDecal: { kind: 'scorch', sizePerScale: 2.6, probe: 4.5 },
  },

  // --- enemies (M3): rift emergence and death bursts (ids referenced by defs/enemyVisuals.ts) ---
  'rift.spawn': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.28, 0.34],
        speed: [0, 0],
        spread: 0,
        size: [1.4, 1.6],
        sizeEnd: 0.3,
        color: [0.62, 0.3, 1],
        intensity: 6,
        intensityEnd: 0,
        offset: 0.2,
        flash: true,
      },
      {
        blend: 'add',
        sprite: 'ring',
        count: [1, 1],
        minCount: 1,
        life: [0.45, 0.5],
        speed: [0, 0],
        spread: 0,
        size: [0.4, 0.4],
        sizeEnd: 6,
        color: [0.7, 0.45, 1],
        intensity: 4,
        intensityEnd: 0,
        alpha: 0.8,
        offset: 0.1,
      },
      {
        blend: 'add',
        sprite: 'streak',
        count: [14, 20],
        minCount: 4,
        life: [0.3, 0.7],
        speed: [3, 8],
        axis: 'up',
        spread: 35,
        size: [0.015, 0.03],
        color: [0.8, 0.6, 1],
        intensity: 14,
        colorEnd: [0.4, 0.2, 1],
        intensityEnd: 3,
        gravity: 0.4,
        drag: 1.2,
        stretch: 0.03,
        jitter: 0.25,
      },
      {
        blend: 'add',
        sprite: 'ember',
        count: [16, 26],
        minCount: 4,
        life: [0.8, 1.8],
        speed: [0.5, 2.5],
        axis: 'up',
        spread: 60,
        size: [0.02, 0.045],
        sizeEnd: 0.4,
        color: [0.7, 0.4, 1],
        intensity: 8,
        colorEnd: [0.3, 0.1, 1],
        intensityEnd: 1.5,
        gravity: -0.3,
        drag: 1.5,
        jitter: 0.45,
      },
      {
        blend: 'add',
        sprite: 'spark',
        count: [8, 12],
        minCount: 2,
        life: [0.25, 0.5],
        speed: [2, 5],
        axis: 'up',
        spread: 85,
        size: [0.012, 0.02],
        color: [0.85, 0.7, 1],
        intensity: 12,
        intensityEnd: 2,
        gravity: 1,
        drag: 0.8,
        stretch: 0.015,
        bounce: 0.3,
      },
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [4, 6],
        minCount: 1,
        life: [0.9, 1.6],
        speed: [0.3, 1.2],
        axis: 'up',
        spread: 70,
        size: [0.5, 0.9],
        sizeEnd: 2.5,
        color: [0.05, 0.03, 0.08],
        alpha: 0.6,
        alphaEnd: 0.4,
        fadeIn: 0.1,
        fadeOut: 0.5,
        gravity: -0.1,
        drag: 2,
        spin: [-1, 1],
        jitter: 0.3,
      },
    ],
    light: {
      color: [0.6, 0.35, 1],
      intensity: 60,
      range: 7,
      duration: 0.6,
      flicker: 0.4,
      offset: 0.4,
      priority: 1,
    },
    shake: { trauma: 0.12, range: 10 },
  },
  'enemy.death': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [4, 6],
        minCount: 2,
        life: [0.4, 0.8],
        speed: [1, 3],
        spread: 90,
        size: [0.25, 0.4],
        sizeEnd: 2.5,
        color: [0.3, 0.02, 0.02],
        alpha: 0.85,
        drag: 4,
        gravity: 0.15,
        spin: [-2, 2],
      },
      {
        blend: 'alpha',
        sprite: 'droplet',
        count: [18, 28],
        minCount: 6,
        life: [0.5, 1.1],
        speed: [2.5, 6],
        spread: 80,
        size: [0.02, 0.04],
        color: BLOOD,
        alphaEnd: 0.6,
        gravity: 1.2,
        drag: 0.3,
        stretch: 0.012,
      },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [8, 14],
        minCount: 3,
        life: [0.7, 1.4],
        speed: [2, 5.5],
        axis: 'up',
        spread: 75,
        size: [0.04, 0.09],
        color: [0.18, 0.05, 0.04],
        alphaEnd: 0.4,
        gravity: 1.3,
        drag: 0.4,
        spin: [-14, 14],
        bounce: 0.25,
      },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [6, 10],
        minCount: 2,
        life: [0.4, 0.9],
        speed: [1.5, 4],
        spread: 70,
        size: [0.015, 0.03],
        color: [1, 0.35, 0.08],
        intensity: 4,
        intensityEnd: 1,
        gravity: 1,
        drag: 0.3,
        stretch: 0.012,
      },
    ],
    groundDecal: { kind: 'blood', sizePerScale: 1.2, probe: 2 },
  },
  'enemy.death.acid': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.18, 0.22],
        speed: [0, 0],
        spread: 0,
        size: [1.1, 1.3],
        sizeEnd: 0.4,
        color: SLIME,
        intensity: 3,
        intensityEnd: 0,
        flash: true,
      },
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [5, 7],
        minCount: 2,
        life: [0.5, 1],
        speed: [1, 3],
        spread: 90,
        size: [0.3, 0.45],
        sizeEnd: 2.6,
        color: [0.12, 0.4, 0.1],
        alpha: 0.8,
        drag: 4,
        gravity: 0.1,
        spin: [-2, 2],
      },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [20, 30],
        minCount: 6,
        life: [0.5, 1.1],
        speed: [2.5, 6.5],
        spread: 85,
        size: [0.02, 0.04],
        color: SLIME,
        intensity: 3.5,
        intensityEnd: 1.2,
        gravity: 1.1,
        drag: 0.35,
        stretch: 0.014,
        bounce: 0.1,
      },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [6, 10],
        minCount: 2,
        life: [0.7, 1.3],
        speed: [2, 5],
        axis: 'up',
        spread: 75,
        size: [0.035, 0.08],
        color: [0.06, 0.08, 0.04],
        alphaEnd: 0.4,
        gravity: 1.3,
        drag: 0.4,
        spin: [-14, 14],
        bounce: 0.25,
      },
    ],
    light: {
      color: [0.4, 1, 0.2],
      intensity: 25,
      range: 5,
      duration: 0.35,
      offset: 0.3,
      priority: 1,
    },
    groundDecal: { kind: 'slime', sizePerScale: 1.4, probe: 2.5 },
  },
  'enemy.death.armor': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.22, 0.28],
        speed: [0, 0],
        spread: 0,
        size: [1.8, 2.1],
        sizeEnd: 0.4,
        color: [1, 0.35, 0.55],
        intensity: 4,
        intensityEnd: 0,
        flash: true,
      },
      { ...METAL_SPARKS, count: [16, 24], minCount: 6, axis: 'up', spread: 80, speed: [4, 10] },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [10, 16],
        minCount: 4,
        life: [0.9, 1.7],
        speed: [2.5, 6],
        axis: 'up',
        spread: 70,
        size: [0.06, 0.13],
        color: [0.08, 0.075, 0.08],
        alphaEnd: 0.4,
        gravity: 1.3,
        drag: 0.3,
        spin: [-12, 12],
        bounce: 0.3,
      },
      {
        blend: 'alpha',
        sprite: 'mist',
        count: [5, 8],
        minCount: 2,
        life: [0.5, 1],
        speed: [1, 3.5],
        spread: 90,
        size: [0.4, 0.6],
        sizeEnd: 2.6,
        color: [0.26, 0.02, 0.03],
        alpha: 0.85,
        drag: 3.5,
        gravity: 0.1,
        spin: [-2, 2],
      },
      {
        blend: 'alpha',
        sprite: 'droplet',
        count: [20, 30],
        minCount: 6,
        life: [0.6, 1.2],
        speed: [2.5, 6.5],
        spread: 80,
        size: [0.025, 0.05],
        color: BLOOD,
        alphaEnd: 0.6,
        gravity: 1.2,
        drag: 0.3,
        stretch: 0.012,
      },
    ],
    light: {
      color: [1, 0.35, 0.55],
      intensity: 120,
      range: 9,
      duration: 0.5,
      flicker: 0.3,
      offset: 0.5,
      priority: 1,
    },
    shake: { trauma: 0.35, range: 14 },
    groundDecal: { kind: 'blood', sizePerScale: 1.4, probe: 3 },
  },

  // --- player ---
  'land.heavy': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'dust',
        count: [8, 12],
        minCount: 3,
        life: [0.6, 1.1],
        speed: [2, 4],
        axis: 'up',
        spread: 88,
        size: [0.15, 0.25],
        sizeEnd: 3.2,
        color: [0.4, 0.38, 0.35],
        alpha: 0.4,
        drag: 4.5,
        gravity: 0.02,
        spin: [-1, 1],
        offset: 0.05,
        jitter: 0.15,
      },
    ],
  },

  // --- perk blasts (M4, defs/perks.ts PERK_TUNING.*.fx): a center effect at the player's feet
  // (flash light, shake, sparks hopping along the floor – no smoke, scorch or large billboards: a
  // quad centered straight below the first-person camera veils the whole screen) plus a ring of
  // small bursts around the player, which is what the camera actually sees ---
  'perk.nova': {
    emitters: [
      {
        blend: 'add',
        sprite: 'spark',
        count: [12, 18],
        minCount: 4,
        life: [0.5, 1],
        speed: [5, 9],
        axis: 'down',
        spread: 105,
        size: [0.045, 0.075],
        sizeEnd: 0.25,
        color: [0.7, 0.9, 1],
        intensity: 8,
        intensityEnd: 1,
        gravity: 1,
        drag: 1.2,
        bounce: 0.6,
        offset: 0.05,
      },
    ],
    light: {
      color: [0.4, 0.65, 1],
      intensity: 160,
      range: 10,
      duration: 0.3,
      flicker: 0.5,
      offset: 0.5,
      priority: 1,
    },
    shake: { trauma: 0.25, range: 10 },
  },
  'perk.nova.arc': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.12, 0.16],
        speed: [0, 0],
        spread: 0,
        size: [0.9, 0.9],
        sizeEnd: 0.3,
        color: [0.45, 0.7, 1],
        intensity: 3,
        intensityEnd: 0,
        flash: true,
        offset: 0.3,
      },
      {
        blend: 'add',
        sprite: 'streak',
        count: [4, 6],
        minCount: 2,
        life: [0.15, 0.3],
        speed: [5, 9],
        axis: 'up',
        spread: 35,
        size: [0.025, 0.04],
        sizeEnd: 0.4,
        color: [0.6, 0.85, 1],
        intensity: 14,
        intensityEnd: 2,
        drag: 3,
        stretch: 0.04,
      },
      {
        blend: 'add',
        sprite: 'spark',
        count: [2, 4],
        minCount: 1,
        life: [0.3, 0.6],
        speed: [2, 4],
        axis: 'up',
        spread: 60,
        size: [0.04, 0.06],
        sizeEnd: 0.25,
        color: [0.7, 0.9, 1],
        intensity: 8,
        intensityEnd: 1,
        gravity: 1,
        drag: 1,
        bounce: 0.4,
      },
    ],
  },
  'perk.kinetic': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [12, 18],
        minCount: 3,
        life: [0.9, 1.5],
        speed: [6, 10],
        axis: 'down',
        spread: 110,
        size: [0.04, 0.08],
        color: [0.14, 0.13, 0.12],
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.4,
        spin: [-15, 15],
        bounce: 0.55,
      },
    ],
    light: { color: [1, 0.7, 0.45], intensity: 80, range: 8, duration: 0.22, offset: 0.4, priority: 1 },
    shake: { trauma: 0.45, range: 10 },
  },
  'perk.kinetic.dust': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'dust',
        count: [3, 4],
        minCount: 2,
        life: [0.8, 1.3],
        speed: [3, 5.5],
        axis: 'up',
        spread: 28,
        size: [0.4, 0.6],
        sizeEnd: 2.8,
        color: [0.3, 0.28, 0.26],
        alpha: 0.6,
        alphaEnd: 0,
        drag: 3.5,
        gravity: 0.05,
        spin: [-1, 1],
        jitter: 0.25,
      },
      {
        blend: 'alpha',
        sprite: 'chip',
        count: [3, 5],
        minCount: 1,
        life: [0.8, 1.3],
        speed: [4, 7],
        axis: 'up',
        spread: 35,
        size: [0.05, 0.09],
        color: [0.12, 0.11, 0.1],
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.4,
        spin: [-15, 15],
        bounce: 0.4,
      },
      {
        blend: 'add',
        sprite: 'streak',
        count: [2, 3],
        minCount: 1,
        life: [0.2, 0.4],
        speed: [6, 10],
        axis: 'up',
        spread: 35,
        size: [0.025, 0.04],
        sizeEnd: 0.4,
        color: HOT,
        intensity: 10,
        colorEnd: HOT_END,
        intensityEnd: 1,
        gravity: 1,
        drag: 2,
        stretch: 0.03,
      },
    ],
  },
  'perk.phoenix': {
    emitters: [
      {
        blend: 'add',
        sprite: 'ember',
        count: [16, 24],
        minCount: 4,
        life: [1, 2],
        speed: [5, 9],
        axis: 'down',
        spread: 105,
        size: [0.03, 0.05],
        sizeEnd: 0.3,
        color: [1, 0.55, 0.18],
        intensity: 10,
        colorEnd: [0.8, 0.15, 0.02],
        intensityEnd: 2,
        gravity: -0.3,
        drag: 1.6,
        bounce: 0.5,
      },
    ],
    light: {
      color: [1, 0.55, 0.22],
      intensity: 320,
      range: 14,
      duration: 0.7,
      flicker: 0.3,
      offset: 0.6,
      priority: 2,
    },
    shake: { trauma: 0.45, range: 12 },
    hitPulse: { strength: 0.3, range: 8 },
  },
  'perk.phoenix.flare': {
    emitters: [
      {
        blend: 'add',
        sprite: 'glow',
        count: [1, 1],
        minCount: 1,
        life: [0.15, 0.2],
        speed: [0, 0],
        spread: 0,
        size: [1.1, 1.1],
        sizeEnd: 0.4,
        color: [1, 0.55, 0.2],
        intensity: 3,
        intensityEnd: 0,
        flash: true,
        offset: 0.4,
      },
      // Fire tongues: short-lived and bright to the end (a slow fade reads as smoke puffs).
      {
        blend: 'add',
        sprite: 'flame',
        count: [5, 7],
        minCount: 2,
        life: [0.3, 0.5],
        speed: [3, 5.5],
        axis: 'up',
        spread: 22,
        size: [0.3, 0.45],
        sizeEnd: 1.2,
        color: [1, 0.4, 0.08],
        intensity: 4.5,
        colorEnd: [0.85, 0.12, 0.02],
        intensityEnd: 1.2,
        alpha: 0.9,
        drag: 2.5,
        gravity: -0.3,
        spin: [-2, 2],
        jitter: 0.2,
      },
      {
        blend: 'add',
        sprite: 'streak',
        count: [3, 5],
        minCount: 1,
        life: [0.25, 0.5],
        speed: [6, 10],
        axis: 'up',
        spread: 30,
        size: [0.02, 0.035],
        sizeEnd: 0.4,
        color: HOT,
        intensity: 12,
        colorEnd: HOT_END,
        intensityEnd: 2,
        drag: 2.5,
        stretch: 0.03,
        gravity: 0.3,
      },
      {
        blend: 'add',
        sprite: 'ember',
        count: [5, 8],
        minCount: 1,
        life: [0.8, 1.6],
        speed: [2, 5],
        axis: 'up',
        spread: 40,
        size: [0.03, 0.05],
        sizeEnd: 0.3,
        color: [1, 0.55, 0.18],
        intensity: 10,
        colorEnd: [0.8, 0.15, 0.02],
        intensityEnd: 2,
        gravity: -0.3,
        drag: 1.4,
        jitter: 0.3,
      },
    ],
  },
  // --- M5 muzzles (world part: light + smoke / sparks; `flash`: the viewmodel sprite) ---
  'muzzle.smg': {
    emitters: [{ ...MUZZLE_SMOKE, count: [0, 1], size: [0.025, 0.04] }, { ...MUZZLE_SPARKS, count: [0, 1] }],
    light: muzzleLight([1, 0.7, 0.4], 22, 6, 0.045),
    flash: { size: 0.085, length: 0.14, color: [1, 0.76, 0.46], intensity: 14, duration: 0.035, adsScale: 0.55 },
  },
  'muzzle.lmg': {
    emitters: [
      { ...MUZZLE_SMOKE, count: [1, 2], size: [0.04, 0.06], alpha: 0.26 },
      { ...MUZZLE_SPARKS, count: [1, 3] },
    ],
    light: muzzleLight([1, 0.66, 0.34], 34, 8),
    flash: { size: 0.12, length: 0.24, color: [1, 0.72, 0.42], intensity: 17, duration: 0.04, adsScale: 0.6 },
  },
  /** HX-50: brake blast – a heavy forward flash, side smoke jets and a lingering puff. */
  'muzzle.sniper': {
    emitters: [
      { ...MUZZLE_SMOKE, count: [3, 5], size: [0.06, 0.1], speed: [1, 2.6], spread: 70, alpha: 0.32, life: [0.9, 1.5] },
      { ...MUZZLE_SPARKS, count: [3, 6], speed: [8, 16] },
      { ...MUZZLE_SMOKE, count: [1, 2], size: [0.1, 0.14], sizeEnd: 7, speed: [0.3, 0.8], alpha: 0.2, life: [1.4, 2.2] },
    ],
    light: muzzleLight([1, 0.7, 0.4], 60, 11, 0.06),
    flash: { size: 0.17, length: 0.34, color: [1, 0.76, 0.48], intensity: 20, duration: 0.05, adsScale: 0.45 },
  },
  /** PL-2: a cyan plasma spit – sparks and a glow puff, no smoke. */
  'muzzle.plasma': {
    emitters: [
      streaks(PLASMA_C, [2, 4], [3, 8], [0.08, 0.18], 12, 28, { gravity: 0.3 }),
      { ...flashGlow(PLASMA_C, 0.22, 0.07, 4, 0.05), flash: true },
      motes(PLASMA_HOT, [0, 2], [0.5, 2], [0.2, 0.4], 6, { spread: 40 }),
    ],
    light: muzzleLight([0.35, 0.75, 1], 30, 7),
    flash: { size: 0.1, length: 0.07, color: [0.55, 0.88, 1], intensity: 16, duration: 0.04, adsScale: 0.6 },
  },
  /** RG-9 railgun discharge: a blinding ring, radial sparks, ionised smoke. */
  'muzzle.energy': {
    emitters: [
      shockRing([0.5, 0.85, 1], 0.04, 4, 0.1, 4, 0.08),
      streaks(PLASMA_HOT, [5, 8], [6, 14], [0.06, 0.14], 12, 30, { gravity: 0.2, size: [0.006, 0.01] }),
      billow('mist', [0.62, 0.72, 0.82], [1, 2], [0.04, 0.07], 6, [0.7, 1.2], [0.3, 0.9], 0.24, { spread: 25 }),
    ],
    light: muzzleLight([0.5, 0.8, 1], 55, 10, 0.05),
    flash: { size: 0.11, length: 0.14, color: [0.72, 0.92, 1], intensity: 16, duration: 0.035, adsScale: 0.5 },
    tracer: 'beam.rail',
  },
  /** FW-4 pilot burst (beam weapons fire it when the stream starts). */
  'muzzle.flame': {
    emitters: [
      motes([1, 0.55, 0.18], [1, 2], [1.5, 4], [0.3, 0.6], 8, { spread: 25, gravity: -0.3 }),
      flames([0, 1], [0.08, 0.12], [0.12, 0.2], [1, 2.5], 4, { axis: 'normal', spread: 12 }),
    ],
    light: muzzleLight([1, 0.55, 0.2], 22, 5),
    flash: { size: 0.07, length: 0.1, color: [1, 0.62, 0.3], intensity: 12, duration: 0.05, adsScale: 0.7 },
  },
  /** GL-6: a thump of smoke with a short orange flash. */
  'muzzle.launcher': {
    emitters: [
      { ...MUZZLE_SMOKE, count: [4, 6], size: [0.07, 0.11], speed: [0.8, 2.2], spread: 24, alpha: 0.36, life: [0.9, 1.6] },
      { ...MUZZLE_SPARKS, count: [2, 4] },
      motes([1, 0.55, 0.2], [2, 3], [2, 5], [0.3, 0.6], 8, { spread: 20, gravity: 0.5 }),
    ],
    light: muzzleLight([1, 0.62, 0.3], 42, 8, 0.06),
    flash: { size: 0.16, length: 0.16, color: [1, 0.66, 0.36], intensity: 14, duration: 0.05, adsScale: 0.7 },
  },
  /** SX-0 / Riss-Zerreißer: violet flash, dark wisps and motes torn out of the barrel. */
  'muzzle.void': {
    emitters: [
      motes(VOID_C, [3, 5], [1, 3.5], [0.4, 0.8], 9, { spread: 55 }),
      billow('mist', VOID_SMOKE, [1, 2], [0.06, 0.1], 5, [0.6, 1], [0.3, 1], 0.45, { spread: 30 }),
      shockRing(VOID_C, 0.06, 5, 0.14, 5, 0.05),
    ],
    light: muzzleLight([0.62, 0.3, 1], 36, 7),
    flash: { size: 0.14, length: 0.08, color: [0.72, 0.4, 1], intensity: 16, duration: 0.045, adsScale: 0.6 },
    tracer: 'beam.void',
  },
  /** EX-1 / Äther-Harfe: a spray of blue-white arcs. */
  'muzzle.shock': {
    emitters: [
      streaks(SHOCK_HOT, [5, 8], [4, 10], [0.05, 0.12], 16, 50, { drag: 5, stretch: 0.035 }),
      { ...IMPACT_STAR, color: SHOCK_HOT, intensity: 12, size: [0.08, 0.12] },
    ],
    light: muzzleLight([0.5, 0.65, 1], 30, 7),
    flash: { size: 0.11, length: 0.1, color: [0.62, 0.78, 1], intensity: 18, duration: 0.04, adsScale: 0.6 },
  },
  /** Kryo-Nova: a frost puff and ice glitter. */
  'muzzle.ice': {
    emitters: [
      billow('mist', FROST_MIST, [2, 3], [0.06, 0.1], 5, [0.6, 1.1], [0.4, 1.4], 0.3, { spread: 35, gravity: 0.05 }),
      motes(FROST_HOT, [2, 4], [1, 3], [0.3, 0.7], 8, { sprite: 'star', spread: 45, gravity: 0.4 }),
    ],
    light: muzzleLight([0.6, 0.85, 1], 26, 6),
    flash: { size: 0.12, length: 0.08, color: [0.72, 0.92, 1], intensity: 14, duration: 0.045, adsScale: 0.6 },
  },

  // --- M5 element impacts (played on top of the surface effect by the weapon's impact profile) ---
  'impact.plasma': {
    emitters: [
      flashGlow(PLASMA_C, 0.35, 0.1, 5, 0.03),
      { ...IMPACT_STAR, color: PLASMA_HOT, intensity: 14 },
      streaks(PLASMA_HOT, [6, 10], [3, 8], [0.15, 0.35], 14, 65, { axis: 'reflect', gravity: 0.8 }),
      shockRing(PLASMA_C, 0.08, 4, 0.14, 4, 0.03),
      motes(PLASMA_C, [2, 4], [0.5, 1.5], [0.4, 0.8], 5, { gravity: -0.2 }),
    ],
    light: impactLight([0.4, 0.8, 1], 3),
  },
  'impact.shock': {
    emitters: [
      { ...IMPACT_STAR, color: SHOCK_HOT, intensity: 16, size: [0.18, 0.26] },
      streaks(SHOCK_HOT, [6, 10], [3, 9], [0.05, 0.14], 16, 80, { drag: 6, stretch: 0.04 }),
      { ...METAL_SPARKS, color: SHOCK_HOT, colorEnd: SHOCK_C, count: [3, 6], intensity: 12 },
      flashGlow(SHOCK_C, 0.3, 0.08, 4, 0.03),
    ],
    light: impactLight([0.5, 0.65, 1], 3),
  },
  'impact.fire': {
    emitters: [
      tongues([2, 3], [0.16, 0.26], [0.2, 0.4], [1.2, 2.4], 3.4, { axis: 'normal', spread: 30, stretch: 0.16 }),
      flames([1, 2], [0.14, 0.24], [0.25, 0.45], [0.6, 1.6], 3, { axis: 'normal', spread: 30 }),
      motes([1, 0.55, 0.18], [2, 4], [1, 3.5], [0.4, 0.9], 9, { axis: 'normal', spread: 60, gravity: 0.2 }),
      billow('smoke', SOOT, [0, 1], [0.12, 0.2], 4, [0.8, 1.4], [0.3, 0.8], 0.4),
    ],
    light: impactLight([1, 0.5, 0.2], 2.5),
  },
  'impact.ice': {
    emitters: [
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [5, 8],
        minCount: 2,
        life: [0.5, 1],
        speed: [1.5, 5],
        axis: 'reflect',
        spread: 55,
        size: [0.02, 0.045],
        color: [0.75, 0.9, 1],
        alpha: 0.9,
        alphaEnd: 0.2,
        gravity: 1.2,
        drag: 0.3,
        spin: [-20, 20],
        bounce: 0.3,
      },
      billow('mist', FROST_MIST, [1, 2], [0.1, 0.16], 3.5, [0.5, 0.9], [0.3, 0.9], 0.35, { gravity: 0.05 }),
      motes(FROST_HOT, [2, 3], [0.8, 2.5], [0.3, 0.6], 8, { sprite: 'star', gravity: 0.5 }),
      flashGlow(FROST_C, 0.26, 0.08, 3.5, 0.03),
    ],
    light: impactLight([0.6, 0.85, 1], 2.5),
  },
  'impact.poison': {
    emitters: [
      { ...IMPACT_GLOW, color: POISON_C, intensity: 3, size: [0.16, 0.22] },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [6, 10],
        minCount: 2,
        life: [0.4, 0.8],
        speed: [1.5, 4],
        spread: 50,
        size: [0.014, 0.026],
        color: POISON_C,
        intensity: 3.5,
        intensityEnd: 1.2,
        gravity: 1.1,
        drag: 0.4,
        stretch: 0.012,
      },
      billow('mist', POISON_MIST, [1, 2], [0.12, 0.2], 3, [0.6, 1.1], [0.3, 1], 0.55),
    ],
    light: impactLight([0.35, 1, 0.25], 2),
  },
  'impact.void': {
    emitters: [
      flashGlow(VOID_C, 0.34, 0.12, 5, 0.04),
      motes(VOID_C, [6, 9], [-3, -1.6], [0.14, 0.24], 9, { shell: 0.35, drag: 0, gravity: 0 }),
      shockRing(VOID_C, 0.08, 4.5, 0.18, 4.5, 0.04),
      billow('mist', VOID_SMOKE, [1, 2], [0.1, 0.16], 3, [0.5, 0.9], [0.2, 0.6], 0.5),
      motes(VOID_DEEP, [2, 4], [0.4, 1.4], [0.5, 1], 12),
    ],
    light: impactLight([0.62, 0.3, 1], 3),
  },

  // --- M5 element explosions (EXPLOSION_PRESET; authored at referenceRadius) ---
  /** Fire: a rolling fireball, thrown burning globs, a storm of embers, black smoke. */
  'explosion.fire': {
    referenceRadius: 4,
    emitters: [
      flashGlow([1, 0.7, 0.4], 2.8, 0.1, 4),
      flames([22, 30], [1, 1.7], [0.5, 0.95], [2, 6], 2.6, { spread: 180, drag: 4, gravity: -0.55, jitter: 0.5, sizeEnd: 2.6 }),
      flames([6, 8], [0.8, 1.2], [0.25, 0.4], [1, 3], 4.5, { spread: 180, color: [1, 0.8, 0.45], jitter: 0.3 }),
      billow('smoke', [0.1, 0.09, 0.08], [16, 22], [0.8, 1.3], 3.4, [2.6, 4.6], [0.6, 2.6], 0.85, {
        axis: 'up',
        spread: 70,
        alphaEnd: 0.7,
        gravity: -0.14,
        drag: 1.1,
        jitter: 0.6,
      }),
      flames([8, 12], [0.12, 0.2], [0.6, 1], [6, 12], 3.5, {
        axis: 'up',
        spread: 75,
        sizeEnd: 0.6,
        gravity: 1,
        drag: 0.8,
        bounce: 0.2,
      }),
      motes([1, 0.55, 0.16], [40, 60], [3, 11], [1.5, 3.5], 10, {
        axis: 'up',
        spread: 120,
        gravity: 0.25,
        drag: 1.2,
        bounce: 0.25,
        jitter: 0.6,
      }),
      shockRing([1, 0.62, 0.3], 0.8, 6.5, 0.3, 3, 0.3),
    ],
    light: blastLight([1, 0.5, 0.18], 380, 0.65, 0.4),
    shake: { trauma: 0.9, range: 20 },
    hitPulse: { strength: 0.5, range: 14 },
    shockwave: { strength: 0.9, radiusScale: 2.2 },
    groundDecal: { kind: 'scorch', sizePerScale: 2.8, probe: 4.5 },
  },
  /** Ice: a white flash, a cold mist burst, a hail of shards, glitter and a frost ring. */
  'explosion.ice': {
    referenceRadius: 4,
    emitters: [
      flashGlow([0.8, 0.95, 1], 2.5, 0.09, 4),
      billow('mist', FROST_MIST, [14, 20], [0.7, 1.2], 3, [1.2, 2.2], [2, 6], 0.5, {
        axis: 'up',
        spread: 180,
        alphaEnd: 0.4,
        gravity: 0.05,
        drag: 2.5,
        jitter: 0.5,
      }),
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [26, 40],
        minCount: 6,
        life: [0.9, 1.6],
        speed: [7, 18],
        axis: 'up',
        spread: 180,
        size: [0.04, 0.12],
        color: [0.7, 0.88, 1],
        alpha: 0.95,
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.4,
        spin: [-18, 18],
        bounce: 0.35,
      },
      motes(FROST_HOT, [12, 18], [4, 10], [0.4, 0.9], 8, { sprite: 'star', size: [0.04, 0.08], gravity: 0.6 }),
      streaks(FROST_HOT, [16, 24], [10, 22], [0.2, 0.45], 10, 180, { gravity: 0.6, drag: 1 }),
      billow('dust', [0.85, 0.9, 0.95], [10, 16], [0.04, 0.08], 1.5, [1.5, 3], [1, 4], 0.6, {
        spread: 180,
        gravity: 0.15,
        drag: 2,
      }),
      shockRing([0.6, 0.9, 1], 0.8, 7, 0.35, 3.5, 0.2),
    ],
    light: blastLight([0.5, 0.8, 1], 300, 0.45, 0.2),
    shake: { trauma: 0.8, range: 18 },
    hitPulse: { strength: 0.4, range: 12 },
    shockwave: { strength: 0.8, radiusScale: 2 },
    groundDecal: { kind: 'frost', sizePerScale: 3, probe: 4.5 },
  },
  /** Shock: a strobing blast of crackling arcs, bouncing sparks, a lingering plasma ball. */
  'explosion.shock': {
    referenceRadius: 4,
    emitters: [
      flashGlow([0.75, 0.85, 1], 2.3, 0.07, 5),
      streaks(SHOCK_HOT, [24, 36], [14, 30], [0.1, 0.25], 16, 180, { drag: 6, stretch: 0.045, gravity: 0 }),
      {
        blend: 'add',
        sprite: 'spark',
        count: [20, 30],
        minCount: 6,
        life: [0.4, 1],
        speed: [4, 12],
        axis: 'up',
        spread: 150,
        size: [0.03, 0.05],
        sizeEnd: 0.3,
        color: SHOCK_HOT,
        intensity: 10,
        intensityEnd: 2,
        gravity: 1,
        drag: 0.8,
        bounce: 0.5,
      },
      { ...IMPACT_STAR, count: [4, 6], minCount: 2, color: SHOCK_HOT, intensity: 14, size: [0.5, 0.9], speed: [0, 3], spread: 180, jitter: 0.8 },
      billow('smoke', [0.3, 0.33, 0.38], [6, 8], [0.6, 1], 3, [1.2, 2.2], [0.8, 2.2], 0.45, { axis: 'up', spread: 80 }),
      { ...flashGlow(SHOCK_C, 1.4, 0.35, 2.5), sizeEnd: 0.2, flash: false },
      shockRing(SHOCK_C, 0.6, 6, 0.22, 4.5, 0.2),
      shockRing(SHOCK_HOT, 0.3, 4, 0.12, 5, 0.2),
    ],
    light: blastLight([0.5, 0.65, 1], 420, 0.35, 0.8),
    shake: { trauma: 0.7, range: 18 },
    hitPulse: { strength: 0.7, range: 14 },
    shockwave: { strength: 0.7, radiusScale: 2 },
    groundDecal: { kind: 'scorch', sizePerScale: 2.2, probe: 4.5 },
  },
  /** Poison: a toxic green burst, a slow murky cloud, spattering acid. */
  'explosion.poison': {
    referenceRadius: 4,
    emitters: [
      flashGlow([0.55, 1, 0.35], 2.3, 0.08, 3.5),
      billow('smoke', POISON_MIST, [16, 22], [0.9, 1.4], 3.4, [2.5, 4.5], [0.6, 2.6], 0.7, {
        axis: 'up',
        spread: 90,
        alphaEnd: 0.55,
        gravity: -0.04,
        drag: 1.2,
        jitter: 0.6,
      }),
      { ...flashGlow(POISON_C, 1.2, 0.45, 2), count: [3, 4], sizeEnd: 1.5, flash: false, jitter: 0.6 },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [30, 44],
        minCount: 8,
        life: [0.6, 1.2],
        speed: [4, 11],
        axis: 'up',
        spread: 150,
        size: [0.02, 0.045],
        color: POISON_C,
        intensity: 3.5,
        intensityEnd: 1.2,
        gravity: 1.1,
        drag: 0.4,
        stretch: 0.014,
        bounce: 0.1,
      },
      motes(POISON_C, [14, 20], [1, 4], [1, 2.5], 5, { gravity: -0.2 }),
      shockRing(POISON_C, 0.8, 6, 0.3, 2.5, 0.2),
    ],
    light: blastLight([0.35, 1, 0.25], 260, 0.6, 0.25),
    shake: { trauma: 0.6, range: 16 },
    hitPulse: { strength: 0.35, range: 12 },
    shockwave: { strength: 0.6, radiusScale: 2 },
    groundDecal: { kind: 'slime', sizePerScale: 2.8, probe: 4.5 },
  },
  /** Void: light falls in, a dark core collapses, then a violet shock ring and drifting motes. */
  'explosion.void': {
    referenceRadius: 4,
    emitters: [
      streaks(VOID_C, [30, 40], [-14, -8], [0.2, 0.3], 10, 180, { shell: 3, drag: 0, gravity: 0, stretch: 0.03 }),
      billow('mist', VOID_SMOKE, [4, 6], [0.9, 1.3], 0.15, [0.35, 0.5], [0, 0.2], 0.9, {
        spread: 180,
        fadeIn: 0,
        fadeOut: 0.2,
        alphaEnd: 0.9,
        gravity: 0,
      }),
      flashGlow([0.72, 0.42, 1], 2.5, 0.12, 4),
      shockRing(VOID_C, 0.6, 8.5, 0.42, 4, 0.2),
      shockRing([0.85, 0.6, 1], 0.3, 5, 0.2, 5, 0.2),
      motes(VOID_C, [24, 36], [2, 8], [1, 2.2], 8, { jitter: 0.5 }),
      {
        blend: 'add',
        sprite: 'spark',
        count: [16, 24],
        minCount: 4,
        life: [0.4, 0.9],
        speed: [6, 14],
        axis: 'up',
        spread: 160,
        size: [0.02, 0.035],
        sizeEnd: 0.3,
        color: [0.85, 0.6, 1],
        intensity: 10,
        intensityEnd: 2,
        gravity: 0.8,
        drag: 0.9,
        stretch: 0.015,
        bounce: 0.3,
      },
      billow('smoke', VOID_SMOKE, [8, 12], [0.6, 1], 3, [1.5, 2.5], [0.8, 2.4], 0.6, { axis: 'up', spread: 90 }),
    ],
    light: blastLight([0.6, 0.3, 1], 360, 0.55, 0.3),
    shake: { trauma: 1, range: 20 },
    hitPulse: { strength: 0.7, range: 14 },
    shockwave: { strength: 1.2, radiusScale: 2.6 },
    groundDecal: { kind: 'voidburn', sizePerScale: 2.6, probe: 4.5 },
  },

  // --- M5 trail puffs (defs/arsenalVfx TRAIL_STYLES; normal = back along the flight) ---
  'trail.plasma.sparks': {
    emitters: [streaks(PLASMA_HOT, [1, 2], [0.5, 2], [0.15, 0.3], 8, 180, { gravity: 0.3 })],
  },
  'trail.smoke.puff': {
    emitters: [
      billow('smoke', [0.4, 0.39, 0.37], [1, 1], [0.1, 0.16], 4.5, [0.9, 1.5], [0.1, 0.4], 0.42, {
        minCount: 1,
        gravity: -0.05,
      }),
      motes([1, 0.55, 0.18], [0, 1], [0.2, 0.8], [0.2, 0.4], 8),
    ],
  },
  'trail.void.motes': {
    emitters: [
      motes(VOID_C, [1, 2], [0.2, 0.8], [0.5, 1], 7, { gravity: -0.1, drag: 1 }),
      billow('mist', VOID_SMOKE, [0, 1], [0.1, 0.16], 3, [0.5, 0.9], [0.1, 0.3], 0.4, { spread: 180 }),
    ],
  },
  'trail.frost.mist': {
    emitters: [
      billow('mist', FROST_MIST, [1, 1], [0.12, 0.2], 3, [0.6, 1.1], [0.1, 0.3], 0.3, { gravity: 0.03 }),
      motes(FROST_HOT, [1, 2], [0.1, 0.5], [0.4, 0.8], 7, { sprite: 'star', size: [0.02, 0.035], gravity: 0.4 }),
    ],
  },
  'trail.shock.sparks': {
    emitters: [streaks(SHOCK_HOT, [2, 3], [2, 6], [0.06, 0.14], 14, 180, { drag: 6, stretch: 0.035, gravity: 0 })],
  },
  'trail.fire.embers': {
    emitters: [
      motes([1, 0.55, 0.16], [1, 2], [0.3, 1.2], [0.4, 0.9], 9, { gravity: -0.2 }),
      flames([0, 1], [0.08, 0.14], [0.15, 0.3], [0.3, 0.8], 3.5, { spread: 60 }),
      billow('smoke', SOOT, [0, 1], [0.1, 0.16], 4, [0.8, 1.3], [0.1, 0.4], 0.35),
    ],
  },

  // --- M5 beam hits / ray trails (defs/arsenalVfx BEAM_STYLES) ---
  /** Continuous (ArsenalVfx beam styles): a few tiny arcs jumping off the prongs. */
  'beam.lightning.muzzle': {
    emitters: [
      streaks(SHOCK_HOT, [1, 2], [1.5, 4], [0.04, 0.09], 10, 70, {
        drag: 6,
        stretch: 0.03,
        gravity: 0,
        size: [0.004, 0.007],
      }),
    ],
  },
  'beam.flame.muzzle': {
    emitters: [
      motes([1, 0.55, 0.18], [0, 1], [0.5, 1.5], [0.25, 0.5], 7, { spread: 50, gravity: 0.6, size: [0.008, 0.014] }),
      {
        blend: 'add',
        sprite: 'droplet',
        count: [0, 1],
        life: [0.25, 0.4],
        speed: [0.2, 0.6],
        axis: 'down',
        spread: 20,
        size: [0.006, 0.01],
        color: [1, 0.5, 0.15],
        intensity: 4,
        intensityEnd: 1,
        gravity: 1,
        stretch: 0.01,
      },
    ],
  },
  'beam.lightning.hit': {
    emitters: [
      streaks(SHOCK_HOT, [3, 5], [3, 9], [0.06, 0.16], 16, 90, { drag: 5, stretch: 0.035 }),
      { ...IMPACT_STAR, color: SHOCK_HOT, intensity: 10, size: [0.12, 0.2] },
      { ...METAL_SPARKS, color: SHOCK_HOT, colorEnd: SHOCK_C, count: [1, 2], minCount: 0, intensity: 10 },
    ],
  },
  'beam.flame.hit': {
    emitters: [
      tongues([1, 2], [0.24, 0.38], [0.3, 0.5], [1.2, 2.4], 3.2, { spread: 25, stretch: 0.16 }),
      flames([1, 1], [0.2, 0.34], [0.3, 0.5], [0.8, 1.8], 2.6, { spread: 35 }),
      motes([1, 0.55, 0.18], [1, 2], [1, 3], [0.4, 0.9], 9, { spread: 90 }),
      billow('smoke', SOOT, [0, 1], [0.2, 0.3], 4, [1.2, 2], [0.4, 1], 0.4, { axis: 'up' }),
    ],
  },
  'beam.void.motes': {
    emitters: [motes(VOID_C, [1, 2], [0.2, 0.9], [0.5, 1], 8, { gravity: -0.05 })],
  },
  /** Railgun slug path: ionised vapour that lingers, and sparks spun off the helix. */
  'beam.rail.sparks': {
    emitters: [
      billow('mist', [0.7, 0.8, 0.9], [1, 1], [0.12, 0.2], 3.5, [0.9, 1.6], [0.05, 0.25], 0.22, {
        minCount: 1,
        spread: 180,
        gravity: -0.02,
        drag: 1,
      }),
      streaks(PLASMA_HOT, [1, 2], [1, 4], [0.1, 0.3], 10, 180, { gravity: 0.3 }),
    ],
  },

  // --- M5 field ambience (defs/arsenalVfx FIELD_VISUALS) ---
  'field.void.motes': {
    emitters: [
      motes(VOID_C, [1, 1], [0.1, 0.5], [0.8, 1.6], 8, { minCount: 1, gravity: -0.05, drag: 0.5 }),
      billow('mist', VOID_SMOKE, [0, 1], [0.2, 0.3], 2.5, [1, 1.6], [0.1, 0.3], 0.35, { spread: 180 }),
    ],
  },
  'field.fire.flames': {
    emitters: [
      tongues([1, 1], [0.26, 0.42], [0.3, 0.55], [1.2, 2.4], 3.4, { minCount: 1, stretch: 0.16 }),
      flames([0, 1], [0.2, 0.32], [0.3, 0.5], [0.6, 1.4], 2.4, { spread: 15, sizeEnd: 1.6 }),
      motes([1, 0.55, 0.16], [0, 1], [0.8, 2.5], [0.6, 1.2], 9, { axis: 'up', spread: 40, gravity: -0.3 }),
    ],
  },
  'field.fire.smoke': {
    emitters: [
      billow('smoke', SOOT, [1, 1], [0.4, 0.6], 3, [2, 3], [0.6, 1.2], 0.4, {
        minCount: 1,
        axis: 'up',
        spread: 20,
        gravity: -0.1,
      }),
    ],
  },
  'field.poison.mist': {
    emitters: [
      billow('smoke', POISON_MIST, [1, 1], [0.8, 1.3], 2.2, [2.5, 4], [0.1, 0.4], 0.55, {
        minCount: 1,
        axis: 'up',
        drag: 0.8,
        gravity: -0.02,
        fadeIn: 0.3,
      }),
      // A faint sickly glow inside the cloud (lit smoke alone reads as plain dust).
      {
        blend: 'add',
        sprite: 'mist',
        count: [0, 1],
        life: [2, 3.5],
        speed: [0.05, 0.3],
        axis: 'up',
        spread: 60,
        size: [0.9, 1.4],
        sizeEnd: 2,
        color: POISON_C,
        intensity: 0.14,
        intensityEnd: 0.05,
        fadeIn: 0.3,
        fadeOut: 0.5,
        alpha: 1,
        alphaEnd: 1,
        drag: 0.8,
        spin: [-0.4, 0.4],
      },
    ],
  },
  'field.poison.bubbles': {
    emitters: [
      {
        blend: 'add',
        sprite: 'ring',
        count: [1, 1],
        minCount: 1,
        life: [0.4, 0.7],
        speed: [0.1, 0.3],
        axis: 'up',
        spread: 10,
        size: [0.05, 0.1],
        sizeEnd: 1.6,
        color: POISON_C,
        intensity: 2.5,
        intensityEnd: 0,
      },
      {
        blend: 'add',
        sprite: 'droplet',
        count: [0, 1],
        life: [0.3, 0.5],
        speed: [0.8, 1.6],
        axis: 'up',
        spread: 25,
        size: [0.012, 0.02],
        color: POISON_C,
        intensity: 3,
        intensityEnd: 1,
        gravity: 1,
        stretch: 0.012,
      },
    ],
  },
  'field.frost.mist': {
    emitters: [
      billow('mist', FROST_MIST, [1, 1], [0.6, 1], 2.2, [2, 3.2], [0.1, 0.3], 0.3, {
        minCount: 1,
        axis: 'up',
        spread: 80,
        gravity: 0.02,
        drag: 1,
      }),
    ],
  },
  'field.frost.glitter': {
    emitters: [motes(FROST_HOT, [1, 1], [0.05, 0.3], [0.5, 1], 8, { minCount: 1, sprite: 'star', size: [0.03, 0.06], gravity: 0.1 })],
  },

  // --- M5 status visuals on enemies (package B spawns them at small rates; no bouncing = no probes) ---
  'status.burn': {
    emitters: [
      tongues([1, 2], [0.18, 0.3], [0.25, 0.45], [1.2, 2.2], 3.2, { minCount: 1, spread: 18, stretch: 0.16 }),
      flames([0, 1], [0.14, 0.24], [0.2, 0.35], [0.6, 1.2], 2.6, { spread: 20, sizeEnd: 1.6 }),
      motes([1, 0.55, 0.16], [1, 2], [0.8, 2], [0.4, 0.9], 9, { axis: 'up', spread: 50, gravity: -0.25 }),
      billow('smoke', SOOT, [0, 1], [0.12, 0.2], 4, [0.8, 1.3], [0.4, 0.9], 0.35, { axis: 'up', spread: 25 }),
    ],
  },
  'status.chill': {
    emitters: [
      billow('mist', FROST_MIST, [1, 1], [0.15, 0.25], 2.5, [0.6, 1], [0.1, 0.4], 0.28, { minCount: 1, gravity: 0.05 }),
      motes(FROST_HOT, [1, 1], [0.1, 0.4], [0.5, 0.9], 6, { sprite: 'star', size: [0.02, 0.035], gravity: 0.35 }),
    ],
  },
  'status.frozen': {
    emitters: [
      motes(FROST_HOT, [2, 3], [0.05, 0.3], [0.3, 0.6], 10, { minCount: 1, sprite: 'star', size: [0.04, 0.07], gravity: 0 }),
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [0, 2],
        life: [0.6, 1],
        speed: [0.2, 0.8],
        spread: 180,
        size: [0.015, 0.03],
        color: [0.75, 0.9, 1],
        alpha: 0.9,
        alphaEnd: 0.2,
        gravity: 0.8,
        spin: [-12, 12],
      },
      billow('mist', FROST_MIST, [0, 1], [0.2, 0.3], 2, [0.8, 1.2], [0.05, 0.2], 0.25, { gravity: 0.05 }),
    ],
  },
  'status.shocked': {
    emitters: [
      streaks(SHOCK_HOT, [3, 5], [3, 7], [0.06, 0.14], 14, 180, { minCount: 2, drag: 6, stretch: 0.04, gravity: 0 }),
      { ...IMPACT_STAR, color: SHOCK_HOT, intensity: 9, size: [0.1, 0.16], minCount: 0, count: [0, 1] },
      motes(SHOCK_HOT, [0, 2], [1, 3], [0.2, 0.4], 10, { sprite: 'spark', gravity: 1 }),
    ],
  },
  'status.poisoned': {
    emitters: [
      {
        blend: 'add',
        sprite: 'droplet',
        count: [1, 2],
        minCount: 1,
        life: [0.35, 0.6],
        speed: [0.3, 0.9],
        axis: 'down',
        spread: 30,
        size: [0.014, 0.024],
        color: POISON_C,
        intensity: 3.2,
        intensityEnd: 1,
        gravity: 1,
        stretch: 0.014,
      },
      {
        blend: 'add',
        sprite: 'ring',
        count: [0, 1],
        life: [0.3, 0.5],
        speed: [0.2, 0.5],
        axis: 'up',
        spread: 40,
        size: [0.03, 0.05],
        sizeEnd: 1.8,
        color: POISON_C,
        intensity: 2.5,
        intensityEnd: 0,
      },
      billow('mist', POISON_MIST, [0, 1], [0.15, 0.25], 2.5, [0.7, 1.1], [0.1, 0.4], 0.45),
    ],
  },
  'status.voidMark': {
    emitters: [
      motes(VOID_C, [2, 3], [-0.7, -0.35], [0.5, 0.8], 9, { minCount: 1, shell: 0.35, drag: 0, gravity: 0 }),
      { ...flashGlow(VOID_C, 0.28, 0.3, 3.5), flash: false, sizeEnd: 1.2, count: [0, 1], minCount: 0 },
      billow('mist', VOID_SMOKE, [0, 1], [0.14, 0.22], 2.5, [0.6, 1], [0.1, 0.4], 0.4, { spread: 180 }),
    ],
  },

  // --- M5 element combos (defs/elements.ts ids): a readable burst on the enemy ---
  /** Fire + ice: a scalding steam burst, shattering ice, hot sparks. */
  'combo.thermoshock': {
    emitters: [
      flashGlow([1, 0.95, 0.9], 1.5, 0.08, 4),
      billow('mist', [0.78, 0.8, 0.82], [8, 12], [0.5, 0.8], 3, [1, 1.8], [2, 5], 0.55, {
        axis: 'up',
        spread: 70,
        gravity: -0.12,
        drag: 2.2,
      }),
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [10, 16],
        minCount: 4,
        life: [0.6, 1.2],
        speed: [4, 10],
        spread: 180,
        size: [0.03, 0.07],
        color: [0.75, 0.9, 1],
        alpha: 0.95,
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.4,
        spin: [-18, 18],
      },
      streaks([1, 0.62, 0.28], [10, 14], [5, 12], [0.2, 0.45], 12, 180, { gravity: 0.8, drag: 1 }),
      shockRing([0.9, 0.95, 1], 0.3, 5, 0.22, 4),
    ],
    light: bodyLight([1, 0.85, 0.7], 90, 0.3),
    shake: { trauma: 0.2, range: 10 },
  },
  /** Shock + poison: toxic green lightning bursting out of a sickly cloud. */
  'combo.neurotoxin': {
    emitters: [
      flashGlow([0.7, 1, 0.4], 1.4, 0.08, 4),
      streaks([0.65, 1, 0.35], [14, 20], [6, 16], [0.08, 0.2], 14, 180, { drag: 6, stretch: 0.045, gravity: 0 }),
      billow('smoke', POISON_MIST, [4, 6], [0.4, 0.7], 3, [1.4, 2.4], [0.8, 2], 0.6, { axis: 'up', spread: 90 }),
      motes(POISON_C, [8, 12], [1, 4], [0.6, 1.4], 6),
      shockRing([0.6, 1, 0.4], 0.3, 5, 0.2, 4),
    ],
    light: bodyLight([0.5, 1, 0.35], 80, 0.3),
    shake: { trauma: 0.2, range: 10 },
  },
  /** Fire + poison: a green-cored toxic fireball and oily smoke. */
  'combo.toxicblaze': {
    emitters: [
      flashGlow([0.8, 1, 0.4], 1.5, 0.09, 3.5),
      flames([8, 12], [0.4, 0.7], [0.4, 0.7], [1.5, 4], 3.5, {
        spread: 180,
        color: [0.6, 1, 0.2],
        colorEnd: [1, 0.35, 0.05],
        drag: 3,
        jitter: 0.25,
      }),
      billow('smoke', [0.08, 0.12, 0.05], [5, 7], [0.5, 0.8], 3, [1.6, 2.6], [0.8, 2], 0.7, { axis: 'up', spread: 80 }),
      motes([0.7, 1, 0.25], [10, 14], [1.5, 5], [0.6, 1.4], 8, { gravity: -0.2 }),
    ],
    light: bodyLight([0.8, 1, 0.3], 90, 0.35),
    shake: { trauma: 0.25, range: 10 },
  },
  /** Ice + shock: a white-blue starburst of arcs and splintering ice. */
  'combo.superconductor': {
    emitters: [
      { ...IMPACT_STAR, count: [6, 8], minCount: 3, color: [0.85, 0.95, 1], intensity: 14, size: [0.4, 0.7], speed: [0, 2], spread: 180, jitter: 0.4 },
      streaks([0.75, 0.9, 1], [16, 24], [8, 18], [0.08, 0.2], 16, 180, { drag: 6, stretch: 0.045, gravity: 0 }),
      {
        blend: 'alpha',
        sprite: 'shard',
        count: [8, 12],
        minCount: 3,
        life: [0.6, 1.1],
        speed: [3, 9],
        spread: 180,
        size: [0.03, 0.06],
        color: [0.75, 0.9, 1],
        alpha: 0.95,
        alphaEnd: 0.3,
        gravity: 1.2,
        drag: 0.4,
        spin: [-18, 18],
      },
      shockRing(SHOCK_HOT, 0.3, 6, 0.2, 5),
      shockRing(FROST_C, 0.2, 3.5, 0.14, 5),
    ],
    light: bodyLight([0.6, 0.8, 1], 110, 0.3),
    shake: { trauma: 0.25, range: 10 },
  },
  /** Void amplifies any status: light falls into the mark, then it ruptures. */
  'combo.voidrupture': {
    emitters: [
      streaks(VOID_C, [18, 26], [-8, -5], [0.18, 0.26], 10, 180, { shell: 1.4, drag: 0, gravity: 0, stretch: 0.03 }),
      billow('mist', VOID_SMOKE, [2, 3], [0.5, 0.7], 0.2, [0.3, 0.4], [0, 0.1], 0.9, {
        spread: 180,
        fadeIn: 0,
        fadeOut: 0.2,
        alphaEnd: 0.9,
        gravity: 0,
      }),
      flashGlow([0.75, 0.45, 1], 1.6, 0.1, 4),
      shockRing(VOID_C, 0.3, 6, 0.3, 4.5),
      motes(VOID_C, [12, 18], [1.5, 5], [0.7, 1.5], 8),
    ],
    light: bodyLight([0.6, 0.3, 1], 110, 0.4),
    shake: { trauma: 0.3, range: 10 },
  },
} as const satisfies Record<string, EffectPreset>;

export type VfxEffectId = keyof typeof VFX_EFFECTS;

export function getEffectPreset(id: string): EffectPreset | undefined {
  return Object.hasOwn(VFX_EFFECTS, id) ? (VFX_EFFECTS as Record<string, EffectPreset>)[id] : undefined;
}

// ---------------------------------------------------------------------------
// Impacts: weapon profile × surface → effect preset + decal
// ---------------------------------------------------------------------------

export interface SurfaceImpactDef {
  readonly effect: string;
  /** Decal left on the surface (world hits with `decal: true` only). */
  readonly decal: DecalKind | null;
  /** Splatter decal on the surface BEHIND a body hit (raycast along the shot). */
  readonly splatter?: {
    readonly decal: DecalKind;
    readonly chance: number;
    /** Max distance behind the hit (m). */
    readonly distance: number;
    readonly size: Range;
  };
}

export const SURFACE_IMPACTS: Record<SurfaceType | FleshSurface, SurfaceImpactDef> = {
  metal: { effect: 'impact.metal', decal: 'bullet.metal' },
  concrete: { effect: 'impact.concrete', decal: 'bullet.concrete' },
  grate: { effect: 'impact.grate', decal: 'scuff' },
  rubber: { effect: 'impact.rubber', decal: 'bullet.generic' },
  glass: { effect: 'impact.glass', decal: 'glass.crack' },
  default: { effect: 'impact.concrete', decal: 'bullet.generic' },
  flesh: {
    effect: 'impact.flesh',
    decal: null,
    splatter: { decal: 'blood', chance: 0.55, distance: 2.5, size: [0.35, 0.7] },
  },
  slime: {
    effect: 'impact.slime',
    decal: null,
    splatter: { decal: 'slime', chance: 0.6, distance: 2.5, size: [0.35, 0.65] },
  },
  armor: { effect: 'impact.metal', decal: null },
  shield: { effect: 'impact.shield', decal: null },
};

/** Per-weapon impact flavour (WeaponVfxDef.impact). Scales the surface effect and decal. */
export interface ImpactProfileDef {
  readonly scale: number;
  readonly decalScale: number;
  /** Skip the decal entirely (melee). */
  readonly decals: boolean;
  /** M5 energy / elemental shots: an extra effect preset at the hit (along the normal), × scale. */
  readonly effect?: string;
  /** The surface's own effect (dust, sparks) × this on top of `scale`; 0 = only `effect`. Default 1. */
  readonly surfaceScale?: number;
  /** World decal replacing the surface's own (plasma scorch, acid); null = none. */
  readonly decal?: DecalKind | null;
}

export const IMPACT_PROFILES = {
  'impact.bullet': { scale: 1, decalScale: 1, decals: true },
  'impact.pellet': { scale: 0.6, decalScale: 0.75, decals: true },
  'impact.melee': { scale: 0.5, decalScale: 1, decals: false },
  // M5 energy / element shots: the element's own burst on top of a toned-down surface effect.
  'impact.plasma': {
    scale: 0.8,
    decalScale: 0.26,
    decals: true,
    effect: 'impact.plasma',
    surfaceScale: 0.6,
    decal: 'scorch',
  },
  'impact.shock': {
    scale: 0.7,
    decalScale: 0.2,
    decals: true,
    effect: 'impact.shock',
    surfaceScale: 0.5,
    decal: 'scorch',
  },
  // Flame beams hit many times a second: no decal spam, only the fire licks.
  'impact.fire': { scale: 0.6, decalScale: 0.3, decals: false, effect: 'impact.fire', surfaceScale: 0 },
  'impact.ice': {
    scale: 0.8,
    decalScale: 0.22,
    decals: true,
    effect: 'impact.ice',
    surfaceScale: 0.6,
    decal: 'frost',
  },
  'impact.poison': {
    scale: 0.7,
    decalScale: 0.3,
    decals: true,
    effect: 'impact.poison',
    surfaceScale: 0.5,
    decal: 'slime',
  },
  'impact.void': {
    scale: 0.8,
    decalScale: 0.24,
    decals: true,
    effect: 'impact.void',
    surfaceScale: 0.5,
    decal: 'voidburn',
  },
} as const satisfies Record<string, ImpactProfileDef>;

/** Profile when the weapon has none (or an unknown id), by impact kind. */
export const IMPACT_PROFILE_BY_KIND: Record<ImpactKind, keyof typeof IMPACT_PROFILES | null> = {
  bullet: 'impact.bullet',
  pellet: 'impact.pellet',
  projectile: 'impact.bullet',
  beam: 'impact.pellet',
  melee: 'impact.melee',
  // Explosions spawn their own effect (combat:explosion), not surface impacts.
  explosion: null,
};

/**
 * Impact kinds that use the weapon's own profile (WeaponVfxDef.impact describes its shots). The
 * others – a pistol-whip, a blast – always use their kind's profile from IMPACT_PROFILE_BY_KIND.
 */
export const IMPACT_USES_WEAPON_PROFILE: Record<ImpactKind, boolean> = {
  bullet: true,
  pellet: true,
  projectile: true,
  beam: true,
  melee: false,
  explosion: false,
};

export function getImpactProfile(id: string): ImpactProfileDef | undefined {
  return Object.hasOwn(IMPACT_PROFILES, id)
    ? (IMPACT_PROFILES as Record<string, ImpactProfileDef>)[id]
    : undefined;
}

// ---------------------------------------------------------------------------
// Explosions: element tints
// ---------------------------------------------------------------------------

/** Tint for `elemental` emitters: color → mix(color, luminance(color) · tint, strength). */
export const ELEMENT_TINTS: Record<DamageElement, { readonly tint: Rgb; readonly strength: number } | null> =
  {
    physical: null,
    fire: { tint: [1, 0.45, 0.12], strength: 0.3 },
    ice: { tint: [0.45, 0.8, 1.6], strength: 0.85 },
    shock: { tint: [0.5, 0.6, 1.6], strength: 0.85 },
    poison: { tint: [0.4, 1.4, 0.3], strength: 0.85 },
    void: { tint: [0.9, 0.3, 1.6], strength: 0.85 },
  };

/**
 * Explosion preset per element (M5: each element has its own). A blast whose element preset is
 * missing falls back to the physical one tinted by ELEMENT_TINTS.
 */
export const EXPLOSION_PRESET: Record<DamageElement, string> = {
  physical: 'explosion.frag',
  fire: 'explosion.fire',
  ice: 'explosion.ice',
  shock: 'explosion.shock',
  poison: 'explosion.poison',
  void: 'explosion.void',
};

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

/** Cell order of the procedural decal atlas (row-major, see vfx/decalAtlas.ts). */
export const DECAL_CELLS = [
  'bullet.metal',
  'bullet.concrete',
  'glass.crack',
  'scorch',
  'blood',
  'slime',
  'scuff',
  'bullet.generic',
  // M5 element blasts / impacts
  'frost',
  'voidburn',
] as const;
export type DecalKind = (typeof DECAL_CELLS)[number];

export const DECAL_ATLAS = {
  cols: 4,
  rows: 3,
  /** 128 px per cell: bullet holes cover < 100 px on screen; big splats/scorches are soft anyway. */
  cellSize: 128,
  seed: 4242,
  /** Height → normal gradient strength. */
  normalStrength: 2.4,
  /** Decals are often seen at grazing angles on floors. */
  anisotropy: 4,
} as const;

export interface DecalKindDef {
  /** Base size (m, quad edge) random in range; multiplied by the requested size scale. */
  readonly size: Range;
  /** Emissive afterglow (hot metal, embers, bioluminescent slime); decay 0 = constant. */
  readonly glow?: { readonly color: Rgb; readonly intensity: number; readonly decay: number };
}

export const DECAL_KINDS: Record<DecalKind, DecalKindDef> = {
  // Bullet holes are drawn larger than life: they are hit feedback read from several meters away.
  'bullet.metal': { size: [0.14, 0.18], glow: { color: [1, 0.38, 0.08], intensity: 4, decay: 2.6 } },
  'bullet.concrete': { size: [0.18, 0.23] },
  'glass.crack': { size: [0.2, 0.3] },
  scorch: { size: [0.9, 1.1], glow: { color: [1, 0.3, 0.05], intensity: 3, decay: 0.8 } },
  blood: { size: [0.8, 1.1] },
  slime: { size: [0.8, 1.1], glow: { color: [0.25, 1, 0.3], intensity: 0.9, decay: 0 } },
  scuff: { size: [0.05, 0.07], glow: { color: [1, 0.4, 0.1], intensity: 4, decay: 3 } },
  'bullet.generic': { size: [0.14, 0.18] },
  frost: { size: [0.9, 1.1], glow: { color: [0.45, 0.75, 1], intensity: 0.9, decay: 0.3 } },
  voidburn: { size: [0.9, 1.1], glow: { color: [0.55, 0.2, 1], intensity: 3, decay: 0.5 } },
};

// ---------------------------------------------------------------------------
// Casings
// ---------------------------------------------------------------------------

export type CasingMesh = 'brass' | 'shell';

export interface CasingDef {
  readonly mesh: CasingMesh;
  /** Cylinder length / radius (m). */
  readonly length: number;
  readonly radius: number;
  /** Ejection speed along the eject port direction (m/s), cone spread (DEGREES), extra up speed. */
  readonly speed: Range;
  readonly spread: number;
  readonly upSpeed: Range;
  /** Tumble (rad/s). */
  readonly spin: Range;
  /** Seconds after the shot (pump actions eject on the pump stroke). */
  readonly ejectDelay: number;
  /** Restitution / tangential friction per bounce. */
  readonly bounce: number;
  readonly friction: number;
  /** Sound id handed to the onClink callback; clinks below `clinkMinSpeed` (m/s) are silent. */
  readonly clinkSound: string;
  readonly clinkMinSpeed: number;
}

export const CASINGS = {
  'casing.pistol': {
    mesh: 'brass',
    length: 0.019,
    radius: 0.0048,
    speed: [2.2, 3.2],
    spread: 14,
    upSpeed: [0.4, 1],
    spin: [18, 34],
    // Brass leaves the port when the slide hits its rear stop (VX-9 fire choreography, 26 ms) –
    // also after the frame of the muzzle flash light, which would blow the brass up into a blob.
    ejectDelay: 0.026,
    bounce: 0.42,
    friction: 0.55,
    clinkSound: 'weapon.casing.brass',
    clinkMinSpeed: 0.6,
  },
  'casing.rifle': {
    mesh: 'brass',
    length: 0.045,
    radius: 0.0055,
    speed: [2.8, 3.8],
    spread: 12,
    upSpeed: [0.5, 1.2],
    spin: [16, 30],
    // Bolt at its rear stop (KR-7 fire choreography, 18 ms).
    ejectDelay: 0.018,
    bounce: 0.4,
    friction: 0.55,
    clinkSound: 'weapon.casing.brass',
    clinkMinSpeed: 0.6,
  },
  'casing.shell': {
    mesh: 'shell',
    length: 0.068,
    radius: 0.0105,
    speed: [1.8, 2.6],
    spread: 14,
    upSpeed: [0.6, 1.2],
    spin: [10, 20],
    // The hull leaves the port when the pump hits its back stop: the SG-12 fire choreography
    // (defs/viewmodels) starts the stroke 0.16 s after the shot and reaches the stop 55 ms later.
    ejectDelay: 0.215,
    bounce: 0.3,
    friction: 0.5,
    clinkSound: 'weapon.casing.shell',
    clinkMinSpeed: 0.5,
  },
} as const satisfies Record<string, CasingDef>;

export function getCasingDef(id: string): CasingDef | undefined {
  return Object.hasOwn(CASINGS, id) ? (CASINGS as Record<string, CasingDef>)[id] : undefined;
}

// ---------------------------------------------------------------------------
// System tuning
// ---------------------------------------------------------------------------

/** Highest particle budget multiplier of any quality level (GPU buffers are allocated for it). */
export const MAX_PARTICLE_BUDGET = Math.max(
  ...Object.values(QUALITY_LEVELS.particles).map((p) => p.budgetMultiplier),
);

export const VFX = {
  particles: {
    /** Particle capacity per blend mode at budget multiplier 1. */
    additiveCapacity: 2048,
    alphaCapacity: 1024,
    /** Particle gravity (m/s²); per-emitter `gravity` multiplies it. Softer than PHYSICS.gravity reads better. */
    gravity: 12,
    /**
     * Quads are pulled towards the camera by size × depthPull (same screen size/position) so big
     * sprites at walls are not cut by the depth test; never closer than depthPullMinDistance (m).
     */
    depthPull: 0.5,
    depthPullMinDistance: 0.1,
    /**
     * Minimum on-screen quad size (px) per blend mode: sub-pixel sparks would cover no pixel
     * centers and vanish or shimmer. Particles up to twice that size fade from their (mipmapped,
     * smeared) sprite to a plain soft dot / line. Dimming 1 = enlarged particles lose opacity by
     * the area gain (lit smoke / debris coverage), 0 = they keep their brightness (sparks).
     */
    minPixelSize: { additive: 2, alpha: 1.5 },
    minPixelDimming: { additive: 0, alpha: 1 },
    /** Particles closer to the camera than [start, end] (m) fade out (no screen-filling smoke). */
    nearFade: [0.15, 0.7] as const,
    /**
     * Light on alpha (lit) particles: ambient fill + nearby flash lights (candela · this / (1 + d²)),
     * the sum clamped to maxLight (an explosion next to its own smoke must not white it out).
     */
    ambient: [0.26, 0.26, 0.27] as const,
    flashLightScale: 0.006,
    maxLight: 3,
    /** Floor probes start this far off the surface along the effect normal (m). */
    probeLift: 0.05,
    /** A bouncing particle slower than this (m/s) after the bounce comes to rest. */
    restSpeed: 0.35,
    /** Tangential velocity kept per bounce. */
    bounceFriction: 0.6,
    /** Down probe for the floor under colliding emitters (m). */
    floorProbe: 8,
    /** Effect scale range that multiplies emitter counts (bigger explosions → more particles, capped). */
    countScale: [0.5, 2] as const,
    /** Upper bound of one simulation step (s); longer frames are split. */
    maxStep: 1 / 30,
    /** Back-to-front sort of lit particles (quantized view depth range, m). */
    sortRange: 256,
    /**
     * Nothing on the volumetric layer writes depth, so draw order decides the blend. Lit (alpha)
     * smoke goes first – below the additive light cones / shafts (10) and dust (11) – so smoke
     * behind a light shaft cannot dim it; all additive light (cones, dust, sparks, tracers) adds
     * on top. Trade-off: additive light behind smoke shows undimmed.
     */
    renderOrder: { alpha: 5, additive: 21 },
  },
  lights: {
    /**
     * Pooled world point lights, created up front at intensity 0 (constant light count → no
     * recompiles). Every one costs a BRDF evaluation per lit fragment: muzzle + impact + explosion.
     */
    count: 3,
    decay: 2,
    /** Low-priority (impact) flashes allowed per frame. */
    lowPriorityPerFrame: 1,
    /** Flicker frequency (Hz) of lights with `flicker`. */
    flickerRate: 26,
    /** reduceFlashing accessibility option scales flash peaks by this. */
    reducedFlashingScale: 0.45,
    /**
     * The weapon is drawn in its own scene, which the pooled world lights never reach: one extra
     * point light there (created up front, constant light count) carries the flash with the most
     * irradiance at the eye, × `gain`. Flashes farther than `maxDistance` (m) are pulled in along
     * their direction with the intensity scaled to keep that irradiance; closer than `minDistance`
     * they count as that distance when picking the strongest.
     */
    viewmodel: { gain: 0.5, maxDistance: 1.5, minDistance: 0.25 },
  },
  decals: {
    /** Ring capacity at particle budget 1; never below `minScale` of it (bullet holes are feedback). */
    capacity: 320,
    minScale: 0.3,
    /** Decals this many spawns before being overwritten start fading out. */
    fadeAhead: 24,
    fadeDuration: 0.8,
    fadeIn: 0.04,
    /** Lift off the surface (m) on top of the polygon offset. */
    normalOffset: 0.003,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    normalScale: 1.2,
    /** Dynamic props do not get decals (they would float when the prop moves): short probe (m). */
    propProbe: 0.08,
    /**
     * Big flat quads (scorch marks, blood splats) must not overhang ledges, stairs or wall edges:
     * four probes along −normal from `lift` m above points on the decal rim (`rimFraction` of its
     * half edge) must hit within `lift + tolerance` m; else the size is halved (up to
     * `maxHalvings` times) and the decal skipped when it still does not fit.
     */
    surfaceFit: { lift: 0.1, tolerance: 0.1, rimFraction: 0.8, maxHalvings: 2 },
    renderOrder: 1,
  },
  casings: {
    capacity: 40,
    /** Never below this share of the capacity when particles are low/off. */
    minScale: 0.4,
    gravity: 16,
    /** Lifetime on the ground, then shrink out over `fadeTime`. */
    life: 6,
    fadeTime: 0.35,
    /** Casings still in the air after this long (fell out of the level) are removed. */
    maxFlightTime: 4,
    /**
     * Each flying casing probes every Nth frame (staggered): down for the floor under it (it may
     * have flown past a ledge or down a ramp) and along its velocity for walls.
     */
    probeInterval: 3,
    /** Down probe for the floor (m), at ejection and with every probe above. */
    floorProbe: 4,
    /** Below this speed (m/s) on the floor a casing settles (lies flat, stops tumbling). */
    settleSpeed: 0.25,
    /** Seconds to rotate into the flat resting pose. */
    settleTime: 0.12,
    /** Spin kept per bounce. */
    spinDamping: 0.55,
    /** Maximum clink callbacks per casing. */
    maxClinks: 3,
    /** Casings inherit the camera velocity (m/s, clamped) so they don't fly backwards while running. */
    maxInheritSpeed: 14,
    inheritLambda: 18,
    /** Without viewmodel sockets: eject port offset from the camera (m, right/up/forward) and direction. */
    fallbackPort: [0.14, -0.1, 0.35] as const,
    fallbackDirection: [0.8, 0.55, 0.15] as const,
    brass: { color: [0.78, 0.52, 0.2] as const, roughness: 0.4, metalness: 1 },
    shell: {
      hull: [0.45, 0.03, 0.02] as const,
      head: [0.78, 0.52, 0.2] as const,
      /** Fraction of the length that is the brass head; rim radius relative to the hull (0.5 = flush). */
      headFraction: 0.28,
      rimRadius: 0.54,
      roughness: 0.45,
      metalness: 0.35,
    },
    radialSegments: 8,
  },
  tracers: {
    capacity: 64,
    /** Visual head speed (m/s); travel time is clamped to [minTravel, maxTravel]. */
    speed: 420,
    minTravel: 0.035,
    maxTravel: 0.08,
    /** The tail catches up with the impact over this time after the head arrived (s). */
    fadeTime: 0.03,
    tailLength: 4.5,
    width: 0.016,
    /** Far tracers stay at least this many pixels wide (no sub-pixel shimmer). */
    minPixelWidth: 1.4,
    intensity: 9,
    /** Linear RGB hex when the caller gives no color. */
    defaultColor: 0xffc890,
    renderOrder: 22,
  },
  /** Heavy landing dust (player:land with heavy = true): scale = impact speed / referenceSpeed, clamped. */
  landing: { effect: 'land.heavy', referenceSpeed: 14, minScale: 0.7, maxScale: 1.5 },
  /** Explosion scale (radius / referenceRadius) clamp. */
  explosionScale: [0.25, 4] as const,
  muzzleFlash: {
    /** Random scale / length / roll per shot. */
    scaleJitter: [0.8, 1.2] as const,
    lengthJitter: [0.75, 1.3] as const,
    /** Side tongue width relative to the star size. */
    petalWidth: 0.55,
    renderOrder: 50,
  },
  /** Dev console `vfx` / `explode`: aim ray reach, fallback distance, default radius, lift off the surface. */
  devCommands: { aimRange: 80, missDistance: 6, explosionRadius: 4, liftPerRadius: 0.25, maxLift: 1 },
  /**
   * Muzzle effects and casings start at viewmodel sockets mapped ~0.5 m in front of the eye. A ray
   * from the eye keeps them (plus the muzzle light offset) `backoff` m in front of any surface
   * closer than that + `margin` (hugging a wall: no flash light behind it, no casing inside it).
   */
  socketProbe: { margin: 0.15, backoff: 0.12 },
  /** Muzzle events / delayed casing ejections / player tracers queued per frame (extra ones are dropped). */
  queue: { shots: 16, casings: 16, tracers: 32 },
  /** Physics interaction for VFX probes: only static world + props (never the player/enemies). */
  probe: {
    membership: COLLISION_GROUP.DEBRIS,
    filter: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP,
  },
} as const;

/** Decal ring capacity for a particle quality level. */
export function decalCapacity(level: QualityLevel): number {
  const mult = QUALITY_LEVELS.particles[level]?.budgetMultiplier ?? 1;
  return Math.max(1, Math.round(VFX.decals.capacity * Math.max(VFX.decals.minScale, mult)));
}

/** Casing pool capacity for a particle quality level. */
export function casingCapacity(level: QualityLevel): number {
  const mult = QUALITY_LEVELS.particles[level]?.budgetMultiplier ?? 1;
  return Math.max(1, Math.round(VFX.casings.capacity * Math.max(VFX.casings.minScale, mult)));
}
