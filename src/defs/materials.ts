/**
 * Data-driven PBR material table. Every world material is described here; the MaterialLibrary
 * turns a def into a MeshStandard/PhysicalMaterial, preferring a downloaded texture set
 * (`textureSet`, see `npm run assets`) and falling back to GPU-generated procedural textures
 * (`generator` + `params`, see render/materials/ProceduralTextureGenerator.ts).
 *
 * Colors are LINEAR RGB (0..1). Distances in generator params are millimeters unless noted,
 * `uvScale` is meters per texture repeat (level geometry carries UVs in meters).
 */
import type { SurfaceType } from '../core/events';

export type RGB = readonly [number, number, number];

export type GeneratorId =
  'panel' | 'concrete' | 'grate' | 'hazard' | 'trim' | 'rubber' | 'crate' | 'pipe' | 'grid' | 'screen';

/** Asset ids of downloadable texture sets (manifest). */
export type TextureSetAssetId = 'tex.floor' | 'tex.concrete';

/**
 * Generator parameters. All generators share one uniform layout; `detail` holds four
 * generator-specific knobs (documented in GENERATOR_DETAIL_DOC).
 */
export interface GeneratorParams {
  /** Primary color: paint / base material. */
  colorA: RGB;
  /** Secondary color: stripes, stencils, lines, accents. */
  colorB: RGB;
  /** Tertiary color: exposed bare metal / substrate / dirt. */
  colorC: RGB;
  /** Integer layout counts per texture repeat (panels, bars, strips, studs, widgets…). */
  cells: readonly [number, number];
  /** Physical relief depth (mm) of one height unit – drives the normal map strength. */
  reliefMm: number;
  /** Seam / groove / bar width in mm. */
  seamMm: number;
  /** Bevel width in mm. */
  bevelMm: number;
  /** 0..1 edge wear and chipped paint. */
  wear: number;
  /** 0..1 dirt in crevices + large-scale stains. */
  grime: number;
  /** 0..1 fine scratches. */
  scratches: number;
  /** Base roughness of the painted/base surface and its variation. */
  roughness: number;
  roughnessVariation: number;
  /** Metalness of the base surface and of exposed metal. */
  metalness: number;
  bareMetalness: number;
  /** Per-panel / large-scale albedo variation (0..1). */
  colorVariation: number;
  /** Generator-specific knobs, see GENERATOR_DETAIL_DOC. */
  detail: readonly [number, number, number, number];
  /** Random seed (any number); change it to get a different variant. */
  seed: number;
}

/** What the four `detail` knobs mean for each generator. */
export const GENERATOR_DETAIL_DOC: Record<GeneratorId, string> = {
  panel: '[vent chance 0..1, split chance 0..1, bolt radius mm, inset chance 0..1]',
  concrete: '[aggregate cells per repeat, crack amount 0..1, wet/puddle amount 0..1, pore amount 0..1]',
  grate: '[pattern 0 = bar grating / 1 = diamond mesh, serration 0..1, hole darkness 0..1, unused]',
  hazard: '[stripe count per repeat (integer), chip scale (cells per repeat), rust halo 0..1, unused]',
  trim: '[screw spacing mm (0 = none), brushed strength 0..1, anodize alternate strips 0..1, unused]',
  rubber: '[pattern 0 = coin studs / 1 = ribs, stud radius (fraction of cell), scuffs 0..1, dust 0..1]',
  crate: '[frame width (fraction of face), rib count, stencil amount 0..1, corner bracket size (fraction)]',
  pipe: '[band center (0..1 along repeat), band width (fraction), rust 0..1, weld seam 0..1]',
  grid: '[minor subdivisions per cell, digit size (fraction of cell), target markers 0..1, unused]',
  screen: '[scanline count per repeat, background glow 0..1, widget density 0..1, unused]',
};

/** Default parameters per generator; material defs only override what differs. */
export const GENERATOR_DEFAULTS: Record<GeneratorId, GeneratorParams> = {
  panel: {
    colorA: [0.3, 0.32, 0.34],
    colorB: [0.55, 0.3, 0.05],
    colorC: [0.56, 0.57, 0.58],
    cells: [2, 2],
    reliefMm: 10,
    seamMm: 9,
    bevelMm: 7,
    wear: 0.45,
    grime: 0.5,
    scratches: 0.35,
    roughness: 0.55,
    roughnessVariation: 0.12,
    metalness: 0.05,
    bareMetalness: 1,
    colorVariation: 0.1,
    detail: [0.18, 0.45, 9, 0.3],
    seed: 1,
  },
  concrete: {
    colorA: [0.26, 0.25, 0.235],
    colorB: [0.36, 0.35, 0.33],
    colorC: [0.1, 0.085, 0.07],
    cells: [1, 1],
    reliefMm: 4,
    seamMm: 8,
    bevelMm: 3,
    wear: 0.3,
    grime: 0.55,
    scratches: 0.1,
    roughness: 0.86,
    roughnessVariation: 0.1,
    metalness: 0,
    bareMetalness: 0,
    colorVariation: 0.18,
    detail: [48, 0.55, 0.45, 0.5],
    seed: 3,
  },
  grate: {
    colorA: [0.1, 0.105, 0.11],
    colorB: [0.02, 0.02, 0.022],
    colorC: [0.5, 0.5, 0.52],
    cells: [30, 10],
    reliefMm: 18,
    seamMm: 5,
    bevelMm: 1.5,
    wear: 0.55,
    grime: 0.5,
    scratches: 0.25,
    roughness: 0.6,
    roughnessVariation: 0.1,
    metalness: 0.1,
    bareMetalness: 1,
    colorVariation: 0.05,
    detail: [0, 0.6, 0.65, 0],
    seed: 5,
  },
  hazard: {
    colorA: [0.78, 0.5, 0.015],
    colorB: [0.018, 0.018, 0.02],
    colorC: [0.48, 0.48, 0.5],
    cells: [1, 1],
    reliefMm: 1.2,
    seamMm: 0,
    bevelMm: 0.5,
    wear: 0.55,
    grime: 0.45,
    scratches: 0.4,
    roughness: 0.45,
    roughnessVariation: 0.1,
    metalness: 0,
    bareMetalness: 1,
    colorVariation: 0.08,
    detail: [4, 10, 0.5, 0],
    seed: 7,
  },
  trim: {
    colorA: [0.3, 0.31, 0.33],
    colorB: [0.62, 0.62, 0.64],
    colorC: [0.72, 0.72, 0.74],
    cells: [1, 4],
    reliefMm: 3,
    seamMm: 4,
    bevelMm: 2,
    wear: 0.35,
    grime: 0.35,
    scratches: 0.45,
    roughness: 0.32,
    roughnessVariation: 0.08,
    metalness: 1,
    bareMetalness: 1,
    colorVariation: 0.04,
    detail: [160, 0.7, 0.35, 0],
    seed: 11,
  },
  rubber: {
    colorA: [0.024, 0.024, 0.026],
    colorB: [0.09, 0.088, 0.085],
    colorC: [0.16, 0.15, 0.14],
    cells: [20, 20],
    reliefMm: 2.5,
    seamMm: 0,
    bevelMm: 1,
    wear: 0.2,
    grime: 0.4,
    scratches: 0.1,
    roughness: 0.86,
    roughnessVariation: 0.06,
    metalness: 0,
    bareMetalness: 0,
    colorVariation: 0.08,
    detail: [0, 0.28, 0.3, 0.22],
    seed: 13,
  },
  crate: {
    colorA: [0.48, 0.16, 0.035],
    colorB: [0.78, 0.76, 0.7],
    colorC: [0.52, 0.52, 0.54],
    cells: [1, 1],
    reliefMm: 22,
    seamMm: 6,
    bevelMm: 8,
    wear: 0.55,
    grime: 0.55,
    scratches: 0.45,
    roughness: 0.5,
    roughnessVariation: 0.1,
    metalness: 0.05,
    bareMetalness: 1,
    colorVariation: 0.06,
    detail: [0.085, 7, 0.85, 0.16],
    seed: 17,
  },
  pipe: {
    colorA: [0.19, 0.23, 0.26],
    colorB: [0.72, 0.46, 0.02],
    colorC: [0.28, 0.11, 0.035],
    cells: [1, 1],
    reliefMm: 2.5,
    seamMm: 10,
    bevelMm: 3,
    wear: 0.35,
    grime: 0.5,
    scratches: 0.3,
    roughness: 0.42,
    roughnessVariation: 0.1,
    metalness: 0.05,
    bareMetalness: 1,
    colorVariation: 0.05,
    detail: [0.5, 0.09, 0.45, 0.6],
    seed: 19,
  },
  grid: {
    colorA: [0.5, 0.51, 0.52],
    colorB: [0.018, 0.02, 0.024],
    colorC: [0.85, 0.24, 0.015],
    cells: [4, 4],
    reliefMm: 1,
    seamMm: 14,
    bevelMm: 1,
    wear: 0.15,
    grime: 0.35,
    scratches: 0.2,
    roughness: 0.55,
    roughnessVariation: 0.08,
    metalness: 0,
    bareMetalness: 1,
    colorVariation: 0.05,
    detail: [4, 0.2, 1, 0],
    seed: 23,
  },
  screen: {
    colorA: [0.18, 0.75, 1.0],
    colorB: [1.0, 0.42, 0.08],
    colorC: [0.012, 0.016, 0.02],
    cells: [3, 2],
    reliefMm: 0.5,
    seamMm: 4,
    bevelMm: 1,
    wear: 0,
    grime: 0.15,
    scratches: 0.1,
    roughness: 0.14,
    roughnessVariation: 0.04,
    metalness: 0,
    bareMetalness: 0,
    colorVariation: 0,
    detail: [220, 0.35, 0.85, 0],
    seed: 29,
  },
};

/** Extra physical-material features (the material becomes a MeshPhysicalMaterial). */
export interface PhysicalExtras {
  clearcoat?: number;
  clearcoatRoughness?: number;
  /**
   * Screen-space transmission. Expensive: three renders the opaque scene a second time while a
   * transmissive object is visible, so glass defaults to plain alpha blending (0).
   */
  transmission?: number;
  ior?: number;
  thickness?: number;
  specularIntensity?: number;
}

export interface MaterialDef {
  readonly id: string;
  /** Procedural generator; null = flat material without maps. */
  readonly generator: GeneratorId | null;
  /** Overrides on top of GENERATOR_DEFAULTS[generator]. */
  readonly params?: Partial<GeneratorParams>;
  /** Downloaded PBR texture set tried first; null = always procedural. */
  readonly textureSet: TextureSetAssetId | null;
  /** Procedural resolution relative to QUALITY_LEVELS.textureQuality[..].proceduralSize (power-of-two fraction). */
  readonly resolution: number;
  /** Meters per texture repeat. */
  readonly uvScale: number;
  /** Albedo tint (multiplies the map) or base color without maps. */
  readonly color: RGB;
  /** Multiplier on the roughness map, absolute value without maps. */
  readonly roughness: number;
  /** Multiplier on the metalness map, absolute value without maps. */
  readonly metalness: number;
  readonly normalScale: number;
  readonly aoIntensity: number;
  readonly envMapIntensity: number;
  /** HDR emissive: color * intensity; > 1 blooms. Multiplies the emissive map if the generator has one. */
  readonly emissive: RGB;
  readonly emissiveIntensity: number;
  readonly physical?: PhysicalExtras;
  /** < 1 makes the material alpha blended (no depth write). */
  readonly opacity: number;
  readonly doubleSided: boolean;
  /** Whether level geometry using this material casts shadows (emissive strips, glass: no). */
  readonly castShadow: boolean;
  /** Footstep / impact surface. */
  readonly surface: SurfaceType;
  /** Thin enough for bullets to pass through (glass, grates, hollow crates); default false. */
  readonly penetrable?: boolean;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [1, 1, 1];

/** Common base for opaque textured materials. */
const TEXTURED = {
  resolution: 1,
  color: WHITE,
  roughness: 1,
  metalness: 1,
  normalScale: 1,
  aoIntensity: 1,
  envMapIntensity: 1,
  emissive: BLACK,
  emissiveIntensity: 0,
  opacity: 1,
  doubleSided: false,
  castShadow: true,
} as const;

/** Common base for flat emissive light materials (no maps, never cast shadows). */
const EMISSIVE = {
  generator: null,
  textureSet: null,
  resolution: 1,
  uvScale: 1,
  color: [0.02, 0.02, 0.02],
  roughness: 0.35,
  metalness: 0,
  normalScale: 1,
  aoIntensity: 1,
  envMapIntensity: 0.4,
  opacity: 1,
  doubleSided: false,
  castShadow: false,
  surface: 'glass',
} as const;

/** Shared panel params: wall_panel and wall_panel_dark MUST stay identical to share GPU textures. */
const WALL_PANEL_PARAMS: Partial<GeneratorParams> = {
  cells: [2, 2],
  colorA: [0.3, 0.32, 0.34],
  colorB: [0.42, 0.22, 0.04],
  wear: 0.4,
  grime: 0.55,
  detail: [0.22, 0.55, 9, 0.35],
  seed: 2,
};

export const MATERIALS = {
  floor_concrete: {
    ...TEXTURED,
    id: 'floor_concrete',
    generator: 'concrete',
    // Darker, finer aggregate than the wall concrete: lets light pools and emissive strips read.
    params: {
      cells: [1, 1],
      seamMm: 7,
      colorA: [0.2, 0.195, 0.185],
      colorB: [0.28, 0.272, 0.258],
      detail: [80, 0.55, 0.45, 0.5],
    },
    textureSet: 'tex.concrete',
    uvScale: 4,
    surface: 'concrete',
  },
  concrete_wall: {
    ...TEXTURED,
    id: 'concrete_wall',
    generator: 'concrete',
    params: {
      cells: [2, 1],
      seamMm: 10,
      detail: [40, 0.35, 0.15, 0.45],
      colorA: [0.22, 0.215, 0.205],
      seed: 31,
    },
    textureSet: 'tex.concrete',
    // Upper walls, roof and pit: mostly seen from a distance.
    resolution: 0.5,
    uvScale: 4,
    surface: 'concrete',
  },
  floor_panel: {
    ...TEXTURED,
    id: 'floor_panel',
    generator: 'panel',
    params: {
      cells: [2, 2],
      colorA: [0.085, 0.092, 0.1],
      colorB: [0.5, 0.33, 0.03],
      wear: 0.7,
      grime: 0.6,
      scratches: 0.6,
      roughness: 0.5,
      detail: [0.05, 0.35, 11, 0.15],
      reliefMm: 6,
      seed: 4,
    },
    // Procedural sci-fi deck plates: the scanned diamond plate reads rusty-brown and tiles visibly
    // across a 24 m arena, so it is reserved for stairs, ramps and block tops (diamond_plate).
    textureSet: null,
    // Painted plates: partly dielectric so skylight sun patches read on the arena floor.
    metalness: 0.55,
    uvScale: 4,
    surface: 'metal',
  },
  diamond_plate: {
    ...TEXTURED,
    id: 'diamond_plate',
    generator: 'panel',
    params: {
      cells: [2, 2],
      colorA: [0.12, 0.125, 0.13],
      colorB: [0.5, 0.33, 0.03],
      wear: 0.5,
      grime: 0.5,
      scratches: 0.5,
      roughness: 0.45,
      detail: [0.05, 0.35, 11, 0.15],
      reliefMm: 4,
      seed: 12,
    },
    textureSet: 'tex.floor',
    // Cooler, darker steel instead of the scan's brown rust tone.
    color: [0.62, 0.66, 0.72],
    uvScale: 2,
    surface: 'metal',
  },
  floor_grate: {
    ...TEXTURED,
    id: 'floor_grate',
    generator: 'grate',
    textureSet: null,
    resolution: 0.5,
    uvScale: 1,
    surface: 'grate',
    penetrable: true,
  },
  wall_panel: {
    ...TEXTURED,
    id: 'wall_panel',
    generator: 'panel',
    params: WALL_PANEL_PARAMS,
    textureSet: null,
    uvScale: 4,
    surface: 'metal',
  },
  wall_panel_dark: {
    ...TEXTURED,
    id: 'wall_panel_dark',
    generator: 'panel',
    params: WALL_PANEL_PARAMS,
    textureSet: null,
    uvScale: 4,
    color: [0.34, 0.36, 0.4],
    surface: 'metal',
  },
  trim_metal: {
    ...TEXTURED,
    id: 'trim_metal',
    generator: 'trim',
    textureSet: null,
    resolution: 0.5,
    uvScale: 1,
    surface: 'metal',
  },
  painted_hazard: {
    ...TEXTURED,
    id: 'painted_hazard',
    generator: 'hazard',
    textureSet: null,
    resolution: 0.5,
    uvScale: 1,
    physical: { clearcoat: 0.25, clearcoatRoughness: 0.45 },
    surface: 'metal',
  },
  pillar_metal: {
    ...TEXTURED,
    id: 'pillar_metal',
    generator: 'panel',
    params: {
      cells: [1, 3],
      colorA: [0.06, 0.066, 0.074],
      colorB: [0.035, 0.085, 0.1],
      wear: 0.5,
      grime: 0.45,
      roughness: 0.42,
      detail: [0.12, 0.2, 8, 0.6],
      reliefMm: 8,
      seed: 6,
    },
    textureSet: null,
    resolution: 0.5,
    uvScale: 2,
    surface: 'metal',
  },
  rubber: {
    ...TEXTURED,
    id: 'rubber',
    generator: 'rubber',
    textureSet: null,
    resolution: 0.5,
    uvScale: 1,
    surface: 'rubber',
  },
  crate: {
    ...TEXTURED,
    id: 'crate',
    generator: 'crate',
    textureSet: null,
    resolution: 0.5,
    // Crates use per-face UVs: one repeat per face whatever the crate size.
    uvScale: 1,
    surface: 'metal',
    penetrable: true,
  },
  pipe: {
    ...TEXTURED,
    id: 'pipe',
    generator: 'pipe',
    textureSet: null,
    resolution: 0.25,
    uvScale: 1,
    surface: 'metal',
  },
  glass: {
    ...TEXTURED,
    id: 'glass',
    generator: null,
    textureSet: null,
    uvScale: 1,
    color: [0.55, 0.7, 0.75],
    roughness: 0.04,
    metalness: 0,
    envMapIntensity: 1.6,
    opacity: 0.16,
    physical: { transmission: 0, ior: 1.5, specularIntensity: 1 },
    castShadow: false,
    surface: 'glass',
    penetrable: true,
  },
  emissive_cyan: { ...EMISSIVE, id: 'emissive_cyan', emissive: [0.25, 0.85, 1.0], emissiveIntensity: 6 },
  emissive_orange: { ...EMISSIVE, id: 'emissive_orange', emissive: [1.0, 0.42, 0.08], emissiveIntensity: 6 },
  emissive_red: { ...EMISSIVE, id: 'emissive_red', emissive: [1.0, 0.06, 0.04], emissiveIntensity: 6 },
  emissive_white: { ...EMISSIVE, id: 'emissive_white', emissive: [1.0, 0.94, 0.86], emissiveIntensity: 9 },
  screen: {
    ...TEXTURED,
    id: 'screen',
    generator: 'screen',
    textureSet: null,
    resolution: 0.5,
    // Screens use per-face UVs (one UI layout per screen).
    uvScale: 1,
    color: WHITE,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.2,
    emissive: WHITE,
    emissiveIntensity: 2.6,
    castShadow: false,
    surface: 'glass',
  },
  calibration_grid: {
    ...TEXTURED,
    id: 'calibration_grid',
    generator: 'grid',
    textureSet: null,
    resolution: 0.5,
    // Keep the calibration wall a feature, not a light source: tone the white panels down.
    color: [0.52, 0.55, 0.6],
    uvScale: 4,
    surface: 'metal',
  },
} as const satisfies Record<string, MaterialDef>;

export type MaterialId = keyof typeof MATERIALS;

/** Material ids the M1 spec requires to exist (validated by tests). */
export const REQUIRED_MATERIAL_IDS: readonly MaterialId[] = [
  'floor_concrete',
  'floor_panel',
  'floor_grate',
  'wall_panel',
  'wall_panel_dark',
  'trim_metal',
  'painted_hazard',
  'pillar_metal',
  'rubber',
  'crate',
  'pipe',
  'glass',
  'emissive_cyan',
  'emissive_orange',
  'emissive_red',
  'emissive_white',
  'screen',
  'calibration_grid',
];

export function getMaterialDef(id: string): MaterialDef | undefined {
  return Object.prototype.hasOwnProperty.call(MATERIALS, id)
    ? (MATERIALS as Record<string, MaterialDef>)[id]
    : undefined;
}

export function isMaterialId(id: string): id is MaterialId {
  return getMaterialDef(id) !== undefined;
}

/** Generator params with defaults applied. */
export function resolveGeneratorParams(def: MaterialDef): GeneratorParams | null {
  if (!def.generator) return null;
  return { ...GENERATOR_DEFAULTS[def.generator], ...def.params };
}

/** Placeholder look for unknown material ids (loud on purpose). */
export const PLACEHOLDER_MATERIAL = {
  color: [1, 0, 1] as RGB,
  emissive: [1, 0, 1] as RGB,
  emissiveIntensity: 0.6,
  roughness: 0.5,
  metalness: 0,
} as const;

/**
 * Scalars used when a downloaded texture set lacks a roughness / metalness map (the def values are
 * multipliers meant for maps). Materials with a generator use its base roughness/metalness instead.
 */
export const ASSET_SCALAR_FALLBACK = {
  roughness: 0.7,
  metalness: 0,
} as const;

/** Clamp range of procedural texture sizes (pixels). */
export const PROCEDURAL_TEXTURES = {
  minSize: 128,
  maxSize: 4096,
  /** Samples/radii for the cavity AO baked from the height field (meters). */
  aoRadiusNear: 0.012,
  aoRadiusFar: 0.04,
  /** Artistic exaggeration of the physical relief in the normal maps (real bevels read too soft at game distances). */
  normalBoost: 3.5,
} as const;
