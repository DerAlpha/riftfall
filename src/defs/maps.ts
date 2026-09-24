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
  /** Movement sandbox: every movement ability is unlocked regardless of the profile's unlocks. */
  movementSandbox?: boolean;
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
  movementSandbox: true,
};

/**
 * "Forschungslabor" (research lab, M3 wave map): clinical cold white/blue base, red emergency
 * accents in the corridors, violet rift glow in the atrium. Cold moonlight falls through the
 * atrium's glass lantern (the only sun opening); everything else is lit by fixtures, emissive
 * panels and the anomaly. Low IBL: glossy lab floors pick up the fixtures, not a uniform sky.
 */
export const LAB: MapAtmosphereDef = {
  id: 'lab',
  name: 'Forschungslabor',
  grading: {
    exposure: 0.95,
    contrast: 1.2,
    saturation: 1.12,
    lift: [-0.004, 0.0, 0.01],
    gamma: [1.0, 1.0, 1.02],
    gain: [0.98, 1.0, 1.03],
    // Teal-blue shadows, cool highlights: clinical, cold, a little sick.
    shadowTint: [0.14, 0.3, 0.6],
    highlightTint: [0.86, 0.93, 1.0],
    splitBalance: 0.05,
    temperature: -0.22,
    tint: 0.06,
  },
  fog: {
    color: [0.03, 0.036, 0.055],
    density: 0.012,
    heightFalloff: 0.16,
    baseHeight: 0,
    noiseScale: 0.07,
    noiseStrength: 0.5,
    noiseSpeed: 0.12,
    sunScatterG: 0.8,
    // Unshadowed in-scattering: kept low so the enclosed rooms do not glow.
    sunScatterStrength: 0.22,
  },
  environment: {
    hdri: 'hdri.industrial',
    // Very low IBL: light pools come from the fixtures; the glossy floors keep their reflections
    // through a higher per-material envMapIntensity.
    intensity: 0.11,
    rotationDeg: 120,
    fallback: {
      sky: [0.18, 0.26, 0.4],
      horizon: [0.1, 0.12, 0.16],
      ground: [0.03, 0.03, 0.045],
      panel: [0.8, 0.9, 1.0],
      panelIntensity: 6,
    },
    background: 'color',
    backgroundColor: [0.008, 0.011, 0.02],
    backgroundBlurriness: 0.3,
    backgroundIntensity: 0.3,
  },
  sun: {
    // Steep cold moonlight through the atrium lantern.
    direction: [-0.3, -0.9, 0.32],
    color: [0.7, 0.83, 1.0],
    intensity: 5.5,
    castShadows: true,
  },
  hemi: { sky: [0.3, 0.4, 0.62], ground: [0.05, 0.04, 0.06], intensity: 0.04 },
  reverb: 'large',
  preload: ['hdri.industrial'],
};

export const MAPS: Record<string, MapAtmosphereDef> = {
  [TEST_ROOM.id]: TEST_ROOM,
  [LAB.id]: LAB,
};
