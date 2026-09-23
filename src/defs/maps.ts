/**
 * Map definitions (atmosphere). Geometry/gameplay content per map is built by the
 * map's builder in src/world/; this file holds the data-driven look & feel.
 */
export type RGB = readonly [number, number, number];

/** Parameters for the procedurally generated 3D color-grading LUT. */
export interface ColorGradingDef {
  /** Exposure multiplier (linear). */
  exposure: number;
  contrast: number;
  saturation: number;
  /** ASC-CDL style lift/gamma/gain per channel (applied in log-ish display space). */
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  /** Split toning: tint for shadows/highlights and balance (-1..1). */
  shadowTint: RGB;
  highlightTint: RGB;
  splitBalance: number;
  /** Color temperature shift (-1 cold .. +1 warm) and tint (-1 green .. +1 magenta). */
  temperature: number;
  tint: number;
}

export interface FogDef {
  color: RGB;
  /** Exponential density at base height. */
  density: number;
  /** Height falloff (1/m) above baseHeight. */
  heightFalloff: number;
  baseHeight: number;
  /** Animated noise to break up uniform fog. */
  noiseScale: number;
  noiseStrength: number;
  noiseSpeed: number;
  /** Anisotropic in-scattering towards the sun (Henyey-Greenstein g). */
  sunScatterG: number;
  sunScatterStrength: number;
}

export interface EnvironmentDef {
  /** Asset id from the manifest (Poly Haven HDRI) – null means procedural environment only. */
  hdri: string | null;
  /** Intensity of image-based lighting on PBR materials. */
  intensity: number;
  /** Rotation of the environment around Y in degrees. */
  rotationDeg: number;
  /** Colors used by the procedural fallback environment (sky, horizon, ground, key panels). */
  fallback: { sky: RGB; horizon: RGB; ground: RGB; panel: RGB; panelIntensity: number };
  /** Visible background: 'environment' shows the HDRI, otherwise a solid color. */
  background: 'environment' | 'color';
  backgroundColor: RGB;
  backgroundBlurriness: number;
  backgroundIntensity: number;
}

export interface SunDef {
  /** Direction the light travels (from sun towards scene), normalized at runtime. */
  direction: readonly [number, number, number];
  color: RGB;
  intensity: number;
  castShadows: boolean;
}

export interface MapAtmosphereDef {
  id: string;
  name: string;
  grading: ColorGradingDef;
  fog: FogDef;
  environment: EnvironmentDef;
  sun: SunDef;
  /** Hemisphere fill light (sky/ground colors, intensity) complementing IBL. */
  hemi: { sky: RGB; ground: RGB; intensity: number };
  /** Reverb zone preset name for the audio engine. */
  reverb: 'small' | 'medium' | 'large' | 'hangar';
  /** Asset ids preloaded when the map is loaded. */
  preload: readonly string[];
}

export const TEST_ROOM: MapAtmosphereDef = {
  id: 'testroom',
  name: 'Calibration Hall',
  grading: {
    exposure: 1.05,
    // Horror mood: deep blacks and strong local contrast so light pools read.
    contrast: 1.2,
    // AgX flattens midtone saturation; compensate for a punchier look.
    saturation: 1.15,
    lift: [-0.006, 0.0, 0.008],
    gamma: [1.0, 1.0, 1.02],
    gain: [1.02, 1.0, 0.98],
    shadowTint: [0.1, 0.35, 0.55],
    highlightTint: [1.0, 0.72, 0.45],
    splitBalance: 0.1,
    temperature: 0.0,
    tint: 0.0,
  },
  fog: {
    color: [0.03, 0.045, 0.065],
    density: 0.014,
    heightFalloff: 0.22,
    baseHeight: 0,
    noiseScale: 0.08,
    noiseStrength: 0.45,
    noiseSpeed: 0.15,
    sunScatterG: 0.78,
    sunScatterStrength: 0.55,
  },
  environment: {
    hdri: 'hdri.industrial',
    // Low IBL: the hall is lit by its fixtures and the skylight shafts, not by a uniform fill.
    intensity: 0.26,
    rotationDeg: 40,
    fallback: {
      sky: [0.22, 0.3, 0.38],
      horizon: [0.12, 0.14, 0.16],
      ground: [0.04, 0.04, 0.05],
      panel: [1.0, 0.92, 0.8],
      panelIntensity: 6,
    },
    background: 'color',
    backgroundColor: [0.012, 0.016, 0.022],
    backgroundBlurriness: 0.3,
    backgroundIntensity: 0.3,
  },
  sun: {
    direction: [-0.45, -0.8, -0.35],
    color: [1.0, 0.82, 0.6],
    intensity: 6.5,
    castShadows: true,
  },
  hemi: { sky: [0.35, 0.45, 0.6], ground: [0.08, 0.06, 0.05], intensity: 0.07 },
  reverb: 'hangar',
  preload: ['hdri.industrial'],
};

export const MAPS: Record<string, MapAtmosphereDef> = {
  [TEST_ROOM.id]: TEST_ROOM,
};
