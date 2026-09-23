/** Camera and first-person feel tuning. Angles in degrees unless noted. */
export const CAMERA = {
  defaultFov: 90,
  minFov: 70,
  maxFov: 120,
  /** Viewmodel is rendered with its own fixed FOV so weapons don't distort with player FOV. */
  viewmodelFov: 62,
  pitchLimitDeg: 89,
  /** FOV kicks (added to base FOV), smoothed with fovLambda. */
  fov: {
    sprintKick: 6,
    slideKick: 9,
    dashKick: 14,
    adsZoom: -20,
    lambda: 9,
  },
  bob: {
    /** Vertical/horizontal amplitude in meters at run speed; scales with speed. */
    verticalAmplitude: 0.035,
    horizontalAmplitude: 0.022,
    sprintMultiplier: 1.45,
    crouchMultiplier: 0.6,
    rollDeg: 0.35,
    /** Smoothing of bob intensity when starting/stopping. */
    lambda: 10,
  },
  strafeRollDeg: 1.1,
  strafeRollLambda: 8,
  landing: {
    /** Camera dip in meters per m/s of impact speed, capped. */
    dipPerSpeed: 0.012,
    maxDip: 0.22,
    stiffness: 180,
    damping: 18,
  },
  shake: {
    /** Trauma-based shake (Squirrel Eiserloh): intensity = trauma^exponent. */
    exponent: 2,
    decayPerSecond: 1.4,
    maxYawDeg: 2.6,
    maxPitchDeg: 2.2,
    maxRollDeg: 3.2,
    maxOffset: 0.06,
    frequency: 22,
    /** Trauma added by movement events. */
    traumaHeavyLanding: 0.35,
    traumaDash: 0.12,
  },
  /** Gamepad look speed in deg/s at full deflection before sensitivity multiplier. */
  gamepadLookSpeedDeg: 260,
  /** Mouse: radians per pixel at sensitivity 1.0 (≈ 0.022°/count × 1, Quake/Source convention). */
  mouseRadiansPerCount: 0.022 * (Math.PI / 180),
} as const;

export const VIEWMODEL = {
  /** Resting offset of the viewmodel relative to the viewmodel camera (m). */
  offset: { x: 0.18, y: -0.17, z: -0.38 },
  sway: {
    /** Positional sway per radian of look delta, clamped. */
    positionPerRad: 0.06,
    rotationPerRad: 0.9,
    maxPosition: 0.03,
    maxRotationDeg: 6,
    stiffness: 120,
    damping: 14,
  },
  bob: {
    verticalAmplitude: 0.012,
    horizontalAmplitude: 0.018,
  },
  /** How much the viewmodel lowers while sprinting / sliding. */
  sprintLower: { y: -0.03, pitchDeg: -12, yawDeg: 18 },
  slideTiltDeg: 12,
  landingKickPerSpeed: 0.004,
} as const;
