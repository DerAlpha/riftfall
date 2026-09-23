/**
 * Player movement tuning. All speeds in m/s, accelerations in m/s², times in seconds,
 * distances in meters, angles in degrees. Model: Source/Quake-style ground friction +
 * acceleration, with DOOM-Eternal-flavoured fast base speed, double jump, dash and
 * slide on top.
 */
export const MOVEMENT = {
  collider: {
    radius: 0.38,
    /** Total capsule height (feet to top of head) standing / crouched. */
    standHeight: 1.8,
    crouchHeight: 1.1,
    /** Eye height above the feet. */
    standEyeHeight: 1.62,
    crouchEyeHeight: 0.95,
    slideEyeHeight: 0.8,
    /** Speed (m/s) at which the eye height interpolates when crouching/standing. */
    eyeHeightLambda: 14,
    /** Kinematic controller skin width. */
    skin: 0.02,
    /** Mass used to push dynamic props. */
    mass: 80,
  },
  ground: {
    runSpeed: 6.6,
    sprintSpeed: 9.4,
    crouchSpeed: 3.2,
    /** Multiplier while aiming down sights (used from M2). */
    adsSpeedMultiplier: 0.62,
    backwardSpeedMultiplier: 0.88,
    acceleration: 70,
    friction: 9,
    /** Below this speed friction acts as if the speed were this value (quick stops). */
    stopSpeed: 2.5,
    maxSlopeDeg: 50,
    stepHeight: 0.38,
    stepMinWidth: 0.2,
    snapToGround: 0.35,
    /** Sprint only applies if the forward input is at least this strong. */
    sprintForwardThreshold: 0.5,
  },
  air: {
    gravity: 23,
    /** Extra gravity multiplier while falling for a snappier arc. */
    fallGravityMultiplier: 1.3,
    /** Gravity multiplier when the jump key is released early while rising (variable jump height). */
    jumpCutGravityMultiplier: 1.8,
    terminalVelocity: 55,
    acceleration: 22,
    /** Air strafing wish-speed cap (Quake style). Small => mild air strafe gains. */
    wishSpeedCap: 1.4,
    /** Additional direct steering of velocity towards input while airborne (0..1 per second-ish). */
    airControl: 3.2,
  },
  jump: {
    height: 1.3,
    doubleJumpHeight: 1.05,
    /** Grace time after walking off a ledge in which a ground jump is still allowed. */
    coyoteTime: 0.12,
    /** Jump presses slightly before landing are buffered for this long. */
    bufferTime: 0.13,
    /** Horizontal boost applied on double jump towards input direction (m/s). */
    doubleJumpDirectionalBoost: 2.2,
    /** Minimum time between ground jumps (prevents double-trigger on slopes). */
    cooldown: 0.12,
  },
  slide: {
    /** Horizontal speed required to start a slide. */
    minStartSpeed: 7.2,
    /** Instant speed boost on slide start (m/s), not applied if slid again within `boostCooldown`. */
    startBoost: 3.2,
    boostCooldown: 1.0,
    friction: 1.6,
    /** Acceleration from gravity on slopes (multiplier of projected gravity). */
    slopeAccelMultiplier: 1.0,
    maxSpeed: 17,
    /** Slide ends below this speed (transitions to crouch). */
    minSpeed: 3.8,
    maxDuration: 1.15,
    /** Steering authority while sliding (turn rate towards input, 1/s). */
    steer: 1.8,
    cameraTiltDeg: 5,
    /** Slide-jump keeps this fraction of slide speed. */
    jumpMomentumKeep: 1.0,
  },
  dash: {
    speed: 24,
    duration: 0.16,
    /** Speed kept after the dash (fraction of dash speed, capped at sprintSpeed * this). */
    exitSpeedFraction: 0.5,
    charges: 2,
    rechargeTime: 1.6,
    /** Gravity is suspended during the dash. */
    suspendGravity: true,
    minInterval: 0.22,
  },
  mantle: {
    /** Ledge top must be between these heights above the feet. */
    minHeight: 0.45,
    maxHeight: 1.75,
    /** How far ahead of the capsule surface we probe for a wall. */
    reach: 0.55,
    /** How far past the wall edge the player ends up. */
    forwardOffset: 0.45,
    duration: 0.32,
    /** Horizontal speed after mantling. */
    exitSpeed: 4.5,
    /** Minimum forward input needed to auto-mantle while airborne. */
    forwardInputThreshold: 0.5,
    cooldown: 0.25,
  },
  landing: {
    /** Impact speed (m/s, downward) above which a heavy landing is signalled. */
    heavyImpactSpeed: 12,
    /** Minimum downward speed to emit a landed event at all. */
    minImpactSpeed: 2,
  },
  footsteps: {
    /** Stride length in meters for running/sprinting/crouching (footstep cadence). */
    strideRun: 2.1,
    strideSprint: 2.6,
    strideCrouch: 1.3,
  },
  noclip: {
    speed: 14,
    fastMultiplier: 3,
  },
} as const;

export type MovementDef = typeof MOVEMENT;
