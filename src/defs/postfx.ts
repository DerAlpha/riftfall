/** Post-processing tuning (values independent of quality level). */
export const POSTFX = {
  /**
   * Threshold bloom on the pre-exposure linear HDR buffer (design decision, see CLAUDE.md): emissive
   * materials (luminance · intensity ≥ threshold + smoothing, enforced by a test) and the dense cores
   * of the volumetric beams bloom; diffuse-lit surfaces stay below it, hot specular glints on metal
   * may bloom too. A mask-based selective bloom would cost an extra scene render per frame.
   */
  bloom: {
    intensity: 1.15,
    luminanceThreshold: 0.92,
    luminanceSmoothing: 0.18,
    radius: 0.72,
  },
  chromaticAberration: {
    /** Always-on subtle lens CA (in UV units). */
    baseOffset: 0.00035,
    /** Additional offset at full hit pulse. */
    hitOffset: 0.0065,
    /** Hit pulse decay rate (1/s, exponential). */
    pulseDecay: 3.2,
    /** Damage (health + armor removed) that produces a full hit pulse; less scales linearly. */
    damageForFullPulse: 40,
    radialModulation: true,
    modulationOffset: 0.18,
  },
  vignette: {
    offset: 0.32,
    darkness: 0.52,
    /** Extra darkness at low health (0..1 low-health factor). */
    lowHealthDarkness: 0.35,
  },
  lowHealth: {
    /** Health fraction below which the low-health effect starts. */
    threshold: 0.35,
    desaturation: 0.55,
    pulseFrequency: 1.4,
    tint: [0.55, 0.02, 0.02] as const,
    /** Max blend towards the tint at the screen edges. */
    tintStrength: 0.42,
    /** Heartbeat pulse never drops below this fraction (keeps the tint readable between beats). */
    pulseMin: 0.35,
    /** "Lub-dub" beat shape, in fractions of one pulse period: beat width, delay and strength of the second beat. */
    beatWidth: 0.07,
    secondBeatDelay: 0.2,
    secondBeatStrength: 0.65,
    /** Radial edge mask (distance from center, aspect corrected). */
    edgeInner: 0.28,
    edgeOuter: 0.95,
  },
  /** Red edge flash on hits (on top of the CA pulse). */
  hitFlash: {
    strength: 0.3,
  },
  filmGrain: {
    /** Noise blend opacity (overlay blend: mean-neutral, strongest in midtones). */
    opacity: 0.075,
  },
  depthOfField: {
    /** Focus distance is taken from a center ray; this is the fallback in meters. */
    defaultFocusDistance: 12,
    /** Distance around the focus plane (m) over which blur ramps up to full. */
    focusRange: 7,
    /** Bokeh radius in pixels at referenceHeight; scaled with the drawing-buffer height so the blur covers the same screen fraction at any resolution / DPR / dynamic-resolution scale. */
    bokehScale: 2.2,
    referenceHeight: 1080,
    resolutionScale: 0.5,
    /** How quickly ADS blends DoF in/out (1/s). */
    blendLambda: 10,
    focusLambda: 8,
    /** Below this ADS amount the DoF pass is skipped entirely. */
    minAmount: 0.002,
  },
  motionBlur: {
    /** Fraction of the camera motion between frames that is blurred (shutter angle / 360). */
    intensity: 0.55,
    samples: 8,
    /** Maximum blur length in UV units. */
    maxVelocity: 0.045,
    /** Blur length is normalized to this frame rate so it looks the same at 60 and 144 FPS. */
    referenceFps: 60,
  },
  heightFog: {
    /** Fog distance assigned to sky pixels (depth = 1). */
    maxSkyDistance: 160,
    /** Sun radiance entering the fog = sun color * intensity * this (keeps HG glow subtle). */
    sunIntensityScale: 0.12,
    /** Distance along the view ray where the analytic noise modulation is sampled (m, capped by the hit). */
    noiseSampleDistance: 16,
    /** Wind drift direction of the fog noise (normalized in the shader). */
    windDirection: [1, 0.12, 0.35] as const,
    /** Raymarched detail term (only with QUALITY_LEVELS.volumetrics.fogSteps > 0). */
    marchDistance: 36,
    marchDensity: 1.6,
    /** Noise frequency multiplier of the raymarched term relative to FogDef.noiseScale. */
    marchNoiseScale: 2.6,
    /** Noise values below this produce no extra density (carves wisps instead of a uniform haze). */
    marchNoiseThreshold: 0.42,
  },
  toneMapping: {
    /** Base exposure; multiplied with the user brightness setting and the map grading exposure. */
    exposure: 1.0,
  },
  /** Color grading LUT generation (see postfx/lut.ts). */
  grading: {
    lutSize: 32,
    /** Channel gain per unit of temperature / tint (luminance is renormalized afterwards). */
    temperatureStrength: 0.12,
    tintStrength: 0.1,
    /** Max blend of split-toning hues. */
    splitToneStrength: 0.4,
  },
  accessibility: {
    /** Multiplier on hit flashes and CA pulses when reduceFlashing is on. */
    reduceFlashingScale: 0.2,
    /** With reduceFlashing the low-health tint does not pulse; it holds this heartbeat value (0..1). */
    steadyHeartbeat: 0.5,
    /** 0..1 strength of the daltonization correction. */
    colorblindStrength: 1,
  },
  /**
   * Screen-space explosion shockwave (vfx/ShockwaveEffect.ts): own EffectPass right after the
   * world effects, enabled only while a wave runs. Radii/thickness in UV (screen-height) units.
   */
  shockwave: {
    maxWaves: 4,
    duration: 0.55,
    /** Peak UV displacement at strength 1. */
    amplitude: 0.018,
    /** Ring half-width relative to its screen radius, clamped. */
    thicknessRatio: 0.35,
    minThickness: 0.015,
    maxThickness: 0.14,
    /** Epicenters behind the camera or closer than this in front of it are not drawn (m). */
    minDepth: 0.25,
    /** Full displacement up to this camera distance, then ∝ 1 / distance (m). */
    fullDistance: 6,
    /**
     * M5 gravitational lenses (singularities, ShockwaveEffect.setLens): slots, and the Einstein
     * radius as a fraction of the lens radius at strength 1.
     */
    maxLenses: 4,
    lensEinstein: 0.34,
  },
  smaaPreset: 'HIGH',
} as const;
