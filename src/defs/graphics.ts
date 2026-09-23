/**
 * Graphics quality presets. A preset is a full GraphicsSettings minus user-only fields;
 * changing any individual option switches the preset to 'custom'.
 * Per-level details (shadow map sizes, AO sample counts, ...) live in QUALITY_LEVELS.
 */
import type { GraphicsSettings, QualityLevel, QualityPreset } from '../save/settingsSchema';

export type PresetValues = Omit<
  GraphicsSettings,
  'preset' | 'fpsLimit' | 'showFps' | 'toneMapping' | 'exposure'
>;

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
    medium: {
      cascades: 2,
      mapSize: 1024,
      maxFar: 55,
      radius: 3,
      localShadowMapSize: 512,
      maxLocalShadows: 2,
    },
    high: { cascades: 3, mapSize: 2048, maxFar: 80, radius: 4, localShadowMapSize: 512, maxLocalShadows: 4 },
    ultra: {
      cascades: 4,
      mapSize: 2048,
      maxFar: 120,
      radius: 5,
      localShadowMapSize: 1024,
      maxLocalShadows: 6,
    },
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
  /**
   * Without GPU timer queries a vsync-capped frame time cannot reveal headroom. If the frame
   * time sits inside the hysteresis band for this long below max scale, probe one step up.
   */
  probeSeconds: 6,
  /** Each failed probe (immediately followed by a downscale) doubles the probe wait, up to this factor. */
  probeBackoffMax: 8,
  /**
   * Frame/GPU time samples are capped at budget * this before smoothing; longer frames are hitches
   * (tab switch, streaming, GC). Up to `spikeToleranceFrames` consecutive hitches are ignored, so a
   * single spike cannot drag the scale down while sustained overload still does.
   */
  maxSampleBudgetRatio: 3,
  spikeToleranceFrames: 3,
} as const;

export const AUTO_DETECT = {
  /** Substrings of the unmasked GPU renderer string (lowercase) mapped to presets. First match wins. */
  gpuRules: [
    { match: ['swiftshader', 'llvmpipe', 'software', 'microsoft basic'], preset: 'low' },
    { match: ['mali', 'adreno', 'powervr'], preset: 'low' },
    { match: ['intel(r) uhd', 'intel(r) hd', 'intel hd', 'intel uhd'], preset: 'low' },
    { match: ['intel(r) iris', 'iris xe', 'radeon(tm) graphics', 'radeon vega'], preset: 'medium' },
    { match: ['gtx 9', 'gtx 10', 'gtx 16', 'rx 5', 'rx 4', 'geforce mx'], preset: 'medium' },
    // Safari masks every Apple Silicon GPU as "Apple GPU"; phones/tablets are capped by the mobile rule.
    { match: ['apple gpu'], preset: 'medium' },
    {
      match: ['rtx 20', 'rtx 30', 'rx 6', 'apple m1', 'apple m2', 'intel(r) arc', 'intel arc', 'arc(tm)'],
      preset: 'high',
    },
    { match: ['rtx 40', 'rtx 50', 'rx 7', 'rx 9', 'apple m3', 'apple m4', 'apple m5'], preset: 'ultra' },
  ],
  fallbackPreset: 'medium',
  /** Hardware caps applied after the GPU rule (0 / unknown values skip a rule). */
  mobileMaxPreset: 'low',
  lowEnd: { maxCores: 2, maxMemoryGb: 2, maxPreset: 'low' },
  midRange: { maxCores: 4, maxMemoryGb: 4, maxPreset: 'medium' },
  /** Physical screen pixels above which the preset is lowered one step (fill-rate bound, e.g. 4K). */
  largeScreenPixels: 7_000_000,
  /** Runtime benchmark: after warmup, measure this long; downgrade one preset if avg FPS < target * ratio. */
  benchmarkSeconds: 4,
  benchmarkWarmupSeconds: 2,
  /** Frames longer than this (tab switches, hitches while loading) are ignored by the benchmark. */
  benchmarkMaxFrameSeconds: 0.2,
  benchmarkDowngradeRatio: 0.8,
} as const satisfies {
  gpuRules: readonly { match: readonly string[]; preset: QualityPreset }[];
  fallbackPreset: QualityPreset;
  mobileMaxPreset: QualityPreset;
  lowEnd: { maxCores: number; maxMemoryGb: number; maxPreset: QualityPreset };
  midRange: { maxCores: number; maxMemoryGb: number; maxPreset: QualityPreset };
  largeScreenPixels: number;
  benchmarkSeconds: number;
  benchmarkWarmupSeconds: number;
  benchmarkMaxFrameSeconds: number;
  benchmarkDowngradeRatio: number;
};

/**
 * Cascaded sun shadows (three CSM addon). Per-level cascade count / map size / distance live in
 * QUALITY_LEVELS.shadows; these values are level-independent.
 */
export const SHADOWS = {
  splitMode: 'practical',
  /** Blend between cascades (hides the resolution seam). */
  fade: true,
  /** Depth bias in normalized shadow depth (negative pushes the compare towards the light). */
  bias: -0.00006,
  /** Normal offset per cascade in shadow texels; grows with the PCF radius because wider kernels reach further. */
  normalBiasTexels: 1.1,
  normalBiasPerRadius: 0.22,
  /** Light-space margin behind the view frustum so off-screen casters still cast (m). */
  lightMargin: 40,
  lightNear: 1,
  /** Shadow camera far plane = lightMargin + maxFar * this (keeps depth precision tight). */
  lightFarPerMaxFar: 2.4,
  /** Re-split cascades only when the FOV changed by more than this (sprint/ADS FOV kicks animate every frame). */
  fovUpdateThresholdDeg: 0.5,
  /** Safety net: scan the world for lit materials that were not passed to setupMaterial (seconds, 0 = off). */
  autoSetupIntervalSeconds: 1,
  /** Distance of the plain (shadowless) sun light from the origin, only affects its matrix. */
  plainLightDistance: 50,
} as const;

/** Environment lighting (PMREM) and the procedural fallback environment used when no HDRI is available. */
export const ENVIRONMENT = {
  /** Blur (radians) applied when PMREM-ing the procedural scene; softens the panel reflections. */
  fallbackSigma: 0.035,
  fallbackNear: 0.1,
  fallbackFar: 100,
  dome: { radius: 40, widthSegments: 48, heightSegments: 24, skyExponent: 0.55, groundExponent: 0.4 },
  /** Emissive boxes around the origin (meters); intensity multiplies fallback.panel * panelIntensity. */
  panels: [
    { position: [0, 16, 0], scale: [14, 0.2, 6], intensity: 1.0 },
    { position: [-15, 7, -4], scale: [0.2, 3, 16], intensity: 0.55 },
    { position: [15, 9, 3], scale: [0.2, 2, 12], intensity: 0.4 },
    { position: [2, 6, -16], scale: [9, 2.5, 0.2], intensity: 0.3 },
    { position: [-4, 3, 16], scale: [6, 1, 0.2], intensity: 0.18 },
  ],
} as const;

/** Renderer-level tuning that is not part of a quality preset. */
export const RENDER = {
  /** Viewmodel lighting relative to the map sun / hemisphere light (weapons are lit, not shadowed). */
  viewmodelSunScale: 0.55,
  /** Sun on the viewmodel while the eye is occluded from the sun (indoors / in shade). */
  viewmodelSunShadowedScale: 0.06,
  /** Fade speed (1/s) of the viewmodel sun when stepping in/out of sun shafts. */
  viewmodelSunLambda: 6,
  /** Max distance of the eye→sun occlusion ray (m). */
  viewmodelSunProbeDistance: 80,
  viewmodelHemiScale: 1.0,
  /** Ring size for GPU timer queries (results arrive a few frames late). */
  gpuTimerQueries: 4,
  /** EMA factor for the reported GPU time. */
  gpuTimeEmaAlpha: 0.1,
  /** Minimum time between two canvas resizes while the window is being dragged (ms). */
  resizeThrottleMs: 120,
  /** Smoothing (1/s) of the low-health factor so the screen effect fades in/out. */
  lowHealthLambda: 5,
} as const;
