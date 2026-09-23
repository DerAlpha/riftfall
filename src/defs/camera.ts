/** Camera and first-person feel tuning. Angles in degrees unless noted. */
export const CAMERA = {
  /** Default/min/max of the FOV setting: HORIZONTAL degrees at `fovReferenceAspect` (16:9). */
  defaultFov: 90,
  minFov: 70,
  maxFov: 120,
  /** The FOV setting is defined at this aspect ratio and converted to a vertical FOV (Hor+). */
  fovReferenceAspect: 16 / 9,
  /** Viewmodel is rendered with its own fixed FOV so weapons don't distort with player FOV. */
  viewmodelFov: 62,
  pitchLimitDeg: 89,
  /** FOV kicks (horizontal degrees added to base FOV), smoothed with `lambda` (1/s). */
  fov: {
    sprintKick: 6,
    slideKick: 9,
    dashKick: 14,
    adsZoom: -20,
    lambda: 9,
    /** setFov is only called when the vertical FOV changed by more than this. */
    epsilon: 0.01,
  },
  bob: {
    /** Vertical/horizontal amplitude in meters at run speed; scales with speed. */
    verticalAmplitude: 0.035,
    horizontalAmplitude: 0.022,
    sprintMultiplier: 1.45,
    crouchMultiplier: 0.6,
    rollDeg: 0.35,
    /** Smoothing of bob intensity when starting/stopping (1/s). */
    lambda: 10,
    /** Bob intensity is speed / runSpeed, capped here. */
    maxIntensity: 1.6,
    /** Bob is reduced by this fraction at full ADS. */
    adsReduction: 0.75,
  },
  strafeRollDeg: 1.1,
  strafeRollLambda: 8,
  /** Camera roll while sliding and how fast it blends (1/s). */
  slideTiltDeg: 5,
  slideTiltLambda: 8,
  /** Pull-up feel while mantling: pitch dip + slight roll, blended in/out with `lambda` (1/s). */
  mantle: { pitchDeg: -6, rollDeg: 2.5, lambda: 14 },
  landing: {
    /** Camera dip in meters per m/s of impact speed, capped. */
    dipPerSpeed: 0.012,
    maxDip: 0.22,
    stiffness: 180,
    damping: 18,
    /** Additional downward pitch per meter of dip (degrees/m). */
    pitchDegPerMeter: 14,
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
  /** ADS depth-of-field focus probe (center ray). */
  focus: {
    maxDistance: 150,
    /** Below this ADS amount the focus ray is skipped. */
    minAds: 0.01,
  },
  /** Springs are integrated with sub-steps no longer than this (stability at low FPS). */
  maxSpringStep: 1 / 120,
  /** Gamepad look speed in deg/s at full deflection before sensitivity multiplier. */
  gamepadLookSpeedDeg: 260,
  /** Mouse: radians per pixel at sensitivity 1.0 (≈ 0.022°/count × 1, Quake/Source convention). */
  mouseRadiansPerCount: 0.022 * (Math.PI / 180),
} as const;

export const VIEWMODEL = {
  /** Resting offset of the viewmodel relative to the viewmodel camera (m). */
  offset: { x: 0.18, y: -0.17, z: -0.38 },
  /** Offset while fully aiming down sights: centered, raised and pulled closer (slight zoom). */
  adsOffset: { x: 0, y: -0.105, z: -0.3 },
  sway: {
    /** Positional sway per radian of look delta, clamped. */
    positionPerRad: 0.06,
    rotationPerRad: 0.9,
    maxPosition: 0.03,
    maxRotationDeg: 6,
    stiffness: 120,
    damping: 14,
    /** Sway/bob/breathing scale at full ADS. */
    adsScale: 0.25,
    /** Roll (radians) per radian of yaw sway: the device banks into turns. */
    rollPerYaw: 0.6,
  },
  /**
   * Movement inertia: the device trails the player's real velocity in view space (strafe shift
   * + bank, pulled back when running forward). Values per m/s, clamped, blended with `lambda` (1/s).
   */
  moveSway: {
    lateralPerSpeed: 0.0022,
    maxLateral: 0.02,
    forwardPerSpeed: 0.0016,
    maxForward: 0.02,
    rollDegPerSpeed: 0.45,
    maxRollDeg: 4,
    lambda: 9,
  },
  bob: {
    verticalAmplitude: 0.012,
    horizontalAmplitude: 0.018,
    rollDeg: 1.2,
  },
  /** How much the viewmodel lowers while sprinting / sliding. */
  sprintLower: { y: -0.03, pitchDeg: -12, yawDeg: 18 },
  /** Blend rate (1/s) for sprint/slide/crouch poses. */
  poseLambda: 10,
  slideTiltDeg: 12,
  crouchOffset: { y: -0.012, rollDeg: -3 },
  landingKickPerSpeed: 0.004,
  /** Maximum landing kick (m). */
  maxLandingKick: 0.05,
  /** Jump/dash kicks (m/s impulses into the kick spring) and kick spring tuning. */
  jumpKick: 0.25,
  dashKick: 0.9,
  kickSpring: { stiffness: 160, damping: 15, pitchDegPerMeter: 60 },
  breathing: {
    /** Angular rate (rad/s) and amplitude of the idle breathing motion. */
    rate: 1.7,
    amplitude: 0.0025,
    pitchDeg: 0.35,
  },
  /** Emissive animation of the placeholder device. */
  glow: {
    coreIntensity: 5.5,
    screenIntensity: 2.4,
    stripIntensity: 3,
    pulseRate: 2.6,
    pulseAmount: 0.25,
    /** Extra core intensity right after a dash, decaying with `flareDecay` (1/s). */
    dashFlare: 6,
    flareDecay: 5,
    /** Screen scanline scroll speed (UV/s). */
    screenScroll: 0.35,
  },
  /**
   * Rig-local lights, added on top of the render system's viewmodel sun/hemisphere/environment:
   * a subtle view-fixed fill (keeps the device readable in dark maps; sway moves highlights)
   * and the cyan spill of the glowing core onto the body.
   */
  lights: {
    keyIntensity: 0.6,
    keyColor: 0xdfe8ff,
    /** Key light position relative to the view (up-left, slightly behind); it aims at `offset`. */
    keyPosition: { x: -0.6, y: 0.9, z: 0.5 },
    coreLightIntensity: 0.9,
    coreLightDistance: 0.55,
    coreLightColor: 0x46e6ff,
  },
} as const;
