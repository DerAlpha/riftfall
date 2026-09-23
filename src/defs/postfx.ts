/** Post-processing tuning (values independent of quality level). */
export const POSTFX = {
  /** HDR luminance threshold for bloom – only emissive surfaces / bright highlights exceed it. */
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
    /** Hit pulse decay per second. */
    pulseDecay: 3.2,
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
  },
  filmGrain: {
    /** Noise blend opacity. */
    opacity: 0.075,
  },
  depthOfField: {
    /** Focus distance is taken from a center ray; this is the fallback in meters. */
    defaultFocusDistance: 12,
    focalLength: 0.045,
    bokehScale: 2.2,
    /** How quickly ADS blends DoF in/out (1/s). */
    blendLambda: 10,
    focusLambda: 8,
  },
  motionBlur: {
    /** Fraction of the camera motion between frames that is blurred (shutter angle / 360). */
    intensity: 0.55,
    samples: 8,
    /** Maximum blur length in UV units. */
    maxVelocity: 0.045,
  },
  toneMapping: {
    /** Base exposure; multiplied with the user brightness setting and the map grading exposure. */
    exposure: 1.0,
  },
  smaaPreset: 'HIGH',
} as const;
