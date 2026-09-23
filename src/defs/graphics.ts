/**
 * Graphics quality presets. A preset is a full GraphicsSettings minus user-only fields;
 * changing any individual option switches the preset to 'custom'.
 * Per-level details (shadow map sizes, AO sample counts, ...) live in QUALITY_LEVELS.
 */
import type { GraphicsSettings, QualityLevel, QualityPreset } from '../save/settingsSchema';

export type PresetValues = Omit<GraphicsSettings, 'preset' | 'fpsLimit' | 'showFps' | 'toneMapping' | 'exposure'>;

export const GRAPHICS_PRESETS: Record<QualityPreset, PresetValues> = {
  low: {
    renderScale: 0.75,
    maxPixelRatio: 1,
    dynamicResolution: true,
    targetFps: 60,
    shadows: 'low',
    ambientOcclusion: 'off',
    bloom: 'low',
    volumetrics: 'off',
    antialiasing: 'fxaa',
    motionBlur: false,
    depthOfField: false,
    filmGrain: true,
    chromaticAberration: true,
    vignette: true,
    particles: 'low',
    textureQuality: 'low',
    anisotropy: 2,
  },
  medium: {
    renderScale: 1,
    maxPixelRatio: 1,
    dynamicResolution: true,
    targetFps: 60,
    shadows: 'medium',
    ambientOcclusion: 'low',
    bloom: 'medium',
    volumetrics: 'low',
    antialiasing: 'smaa',
    motionBlur: false,
    depthOfField: true,
    filmGrain: true,
    chromaticAberration: true,
    vignette: true,
    particles: 'medium',
    textureQuality: 'medium',
    anisotropy: 4,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 1.5,
    dynamicResolution: true,
    targetFps: 60,
    shadows: 'high',
    ambientOcclusion: 'medium',
    bloom: 'high',
    volumetrics: 'medium',
    antialiasing: 'smaa',
    motionBlur: false,
    depthOfField: true,
    filmGrain: true,
    chromaticAberration: true,
    vignette: true,
    particles: 'high',
    textureQuality: 'high',
    anisotropy: 8,
  },
  ultra: {
    renderScale: 1,
    maxPixelRatio: 2,
    dynamicResolution: true,
    targetFps: 60,
    shadows: 'ultra',
    ambientOcclusion: 'high',
    bloom: 'ultra',
    volumetrics: 'high',
    antialiasing: 'smaa',
    motionBlur: true,
    depthOfField: true,
    filmGrain: true,
    chromaticAberration: true,
    vignette: true,
    particles: 'ultra',
    textureQuality: 'high',
    anisotropy: 16,
  },
};

/** Concrete parameters per quality level for each feature. 'off' disables the feature. */
export const QUALITY_LEVELS = {
  shadows: {
    off: null,
    low: { cascades: 1, mapSize: 1024, maxFar: 35, radius: 2, localShadowMapSize: 256, maxLocalShadows: 0 },
    medium: { cascades: 2, mapSize: 1024, maxFar: 55, radius: 3, localShadowMapSize: 512, maxLocalShadows: 2 },
    high: { cascades: 3, mapSize: 2048, maxFar: 80, radius: 4, localShadowMapSize: 512, maxLocalShadows: 4 },
    ultra: { cascades: 4, mapSize: 2048, maxFar: 120, radius: 5, localShadowMapSize: 1024, maxLocalShadows: 6 },
  },
  ambientOcclusion: {
    off: null,
    low: { mode: 'Low', halfRes: true, radius: 1.6, intensity: 2.2, distanceFalloff: 1.0 },
    medium: { mode: 'Medium', halfRes: true, radius: 1.8, intensity: 2.5, distanceFalloff: 1.0 },
    high: { mode: 'High', halfRes: false, radius: 2.0, intensity: 2.6, distanceFalloff: 1.0 },
    ultra: { mode: 'Ultra', halfRes: false, radius: 2.0, intensity: 2.6, distanceFalloff: 1.0 },
  },
  bloom: {
    off: null,
    low: { levels: 4, resolutionScale: 0.5 },
    medium: { levels: 5, resolutionScale: 0.5 },
    high: { levels: 6, resolutionScale: 0.75 },
    ultra: { levels: 7, resolutionScale: 1.0 },
  },
  volumetrics: {
    off: null,
    /** cones: fake volumetric light shafts; fogSteps: raymarch steps of height fog (0 = analytic only); dust: particle count multiplier. */
    low: { cones: true, fogSteps: 0, dust: 0.4 },
    medium: { cones: true, fogSteps: 0, dust: 0.7 },
    high: { cones: true, fogSteps: 12, dust: 1.0 },
    ultra: { cones: true, fogSteps: 24, dust: 1.4 },
  },
  particles: {
    off: { budgetMultiplier: 0.25 },
    low: { budgetMultiplier: 0.4 },
    medium: { budgetMultiplier: 0.7 },
    high: { budgetMultiplier: 1.0 },
    ultra: { budgetMultiplier: 1.3 },
  },
  textureQuality: {
    /** Resolution of runtime-generated procedural textures. */
    low: { proceduralSize: 512 },
    medium: { proceduralSize: 1024 },
    high: { proceduralSize: 2048 },
  },
} as const satisfies {
  shadows: Record<QualityLevel, unknown>;
  ambientOcclusion: Record<QualityLevel, unknown>;
  bloom: Record<QualityLevel, unknown>;
  volumetrics: Record<QualityLevel, unknown>;
  particles: Record<QualityLevel, unknown>;
  textureQuality: Record<GraphicsSettings['textureQuality'], unknown>;
};

export const DYNAMIC_RESOLUTION = {
  minScale: 0.5,
  /** Step applied per adjustment. */
  step: 0.05,
  /** Seconds between adjustments (resizing render targets is not free). */
  adjustInterval: 0.75,
  /** Scale down if smoothed frame time exceeds budget * this. */
  downThreshold: 1.08,
  /** Scale up if smoothed frame time is below budget * this. */
  upThreshold: 0.82,
  /** EMA smoothing factor for frame time. */
  emaAlpha: 0.08,
  /** Ignore the first seconds after start/resize (shader compilation spikes). */
  warmupSeconds: 2.5,
} as const;

export const AUTO_DETECT = {
  /** Substrings of the unmasked GPU renderer string (lowercase) mapped to presets. First match wins. */
  gpuRules: [
    { match: ['swiftshader', 'llvmpipe', 'software', 'microsoft basic'], preset: 'low' },
    { match: ['mali', 'adreno', 'powervr', 'apple gpu'], preset: 'low' },
    { match: ['intel(r) uhd', 'intel(r) hd', 'intel hd', 'intel uhd'], preset: 'low' },
    { match: ['intel(r) iris', 'iris xe', 'radeon(tm) graphics', 'radeon vega'], preset: 'medium' },
    { match: ['gtx 9', 'gtx 10', 'gtx 16', 'rx 5', 'rx 4', 'mx'], preset: 'medium' },
    { match: ['rtx 20', 'rtx 30', 'rx 6', 'apple m1', 'apple m2', 'arc'], preset: 'high' },
    { match: ['rtx 40', 'rtx 50', 'rx 7', 'rx 9', 'apple m3', 'apple m4', 'apple m5'], preset: 'ultra' },
  ],
  fallbackPreset: 'medium',
  /** Runtime benchmark: after warmup, measure this long; downgrade one preset if avg FPS < target * ratio. */
  benchmarkSeconds: 4,
  benchmarkDowngradeRatio: 0.8,
} as const satisfies {
  gpuRules: readonly { match: readonly string[]; preset: QualityPreset }[];
  fallbackPreset: QualityPreset;
  benchmarkSeconds: number;
  benchmarkDowngradeRatio: number;
};
