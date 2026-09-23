/** Audio engine tuning. Volumes are linear gain 0..1. */
export const AUDIO = {
  buses: ['music', 'sfx', 'voice', 'ui'] as const,
  /** Music is ducked by this amount (linear gain multiplier) while voice lines play. */
  voiceDuckGain: 0.35,
  duckAttack: 0.08,
  duckRelease: 0.6,
  /** Maximum simultaneous one-shot voices; the quietest/oldest is stolen beyond that. */
  maxVoices: 48,
  /** Positional audio (PannerNode) defaults. */
  panner: {
    model: 'HRTF' as PanningModelType,
    distanceModel: 'inverse' as DistanceModelType,
    refDistance: 2,
    maxDistance: 80,
    rolloffFactor: 1.2,
  },
  /** Algorithmic reverb impulse per zone: seconds of decay and wet level. */
  reverbZones: {
    small: { decay: 0.6, wet: 0.12, preDelay: 0.005 },
    medium: { decay: 1.2, wet: 0.18, preDelay: 0.01 },
    large: { decay: 2.2, wet: 0.24, preDelay: 0.02 },
    hangar: { decay: 3.2, wet: 0.28, preDelay: 0.03 },
  },
  /** Master limiter to avoid clipping when many sounds overlap. */
  limiter: { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.12 },
  /** Movement sound levels (procedural synthesis fallback). */
  movement: {
    footstepGain: 0.32,
    footstepSprintGain: 0.42,
    footstepCrouchGain: 0.14,
    jumpGain: 0.28,
    landGain: 0.45,
    slideGain: 0.35,
    dashGain: 0.5,
    mantleGain: 0.3,
  },
} as const;
