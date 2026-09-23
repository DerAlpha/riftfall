/**
 * Player movement tuning. All speeds in m/s, times in seconds, distances in meters,
 * angles in degrees. Model: Source/Quake-style ground friction + acceleration, with
 * DOOM-Eternal-flavoured fast base speed, double jump, dash, slide and mantling on top.
 *
 * Acceleration values are Quake-style factors (1/s): per second, the velocity along the
 * wish direction may change by `acceleration × wishSpeed`. This keeps the time to reach
 * top speed identical for crouch, run and sprint. Friction is exponential (1/s) above
 * `stopSpeed` and linear below it.
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
    /** Exponential smoothing rate (1/s) of the eye height when crouching/standing/sliding. */
    eyeHeightLambda: 14,
    /** Kinematic controller skin width (gap kept to obstacles). */
    skin: 0.02,
    /** Mass used by the character controller to push dynamic props. */
    mass: 80,
    /** Spawn/teleport lift so the capsule never starts inside the floor. */
    spawnLift: 0.05,
    /** Headroom test capsule: lifted by this and thinner by `skin` to ignore floor/wall contact. */
    headroomTestLift: 0.06,
    /**
     * Stair smoothing: sudden vertical feet jumps from auto-stepping are absorbed by an eye
     * offset that decays with this rate (1/s), clamped to `stepSmoothMax`.
     */
    stepSmoothLambda: 16,
    stepSmoothMax: 0.45,
    /** Minimum unexpected vertical change (m per tick) treated as a step. */
    stepSmoothMinDelta: 0.03,
  },
  ground: {
    runSpeed: 6.6,
    sprintSpeed: 9.4,
    crouchSpeed: 3.2,
    /** Multiplier while aiming down sights. */
    adsSpeedMultiplier: 0.62,
    backwardSpeedMultiplier: 0.88,
    /** Quake-style acceleration factor (1/s): ~0.1 s to 90% of top speed. */
    acceleration: 14,
    /** Exponential friction (1/s): ~0.25 s from run speed to standstill. */
    friction: 8,
    /** Below this speed friction acts as if the speed were this value (quick stops). */
    stopSpeed: 2.5,
    maxSlopeDeg: 50,
    stepHeight: 0.38,
    stepMinWidth: 0.2,
    snapToGround: 0.35,
    /** Sprint only applies if the forward input is at least this strong. */
    sprintForwardThreshold: 0.5,
    /** ADS amount (0..1) above which sprint is cancelled. */
    sprintAdsCancel: 0.3,
    /**
     * Ground normal/surface probe reach below the feet (along the capsule axis). Long enough to
     * see slopes up to ~70° under a capsule resting on its rounded bottom (steep → not grounded).
     */
    groundProbeDistance: 0.8,
  },
  air: {
    gravity: 23,
    /** Extra gravity multiplier while falling for a snappier arc. */
    fallGravityMultiplier: 1.3,
    /** Gravity multiplier when the jump key is released early while rising (variable jump height). */
    jumpCutGravityMultiplier: 1.8,
    terminalVelocity: 55,
    /** Quake-style air acceleration factor (1/s), limited by `wishSpeedCap`. */
    acceleration: 22,
    /** Air strafing wish-speed cap (Quake style). Small => mild air strafe gains. */
    wishSpeedCap: 0.9,
    /** Air acceleration never pushes the horizontal speed above this (existing momentum is kept). */
    maxAirStrafeSpeed: 15,
    /** Direct steering of the horizontal velocity towards the input direction (blend rate, 1/s). */
    airControl: 3.2,
  },
  jump: {
    height: 1.3,
    doubleJumpHeight: 1.05,
    /** Grace time after walking off a ledge in which a ground jump is still allowed. */
    coyoteTime: 0.12,
    /** Jump presses slightly before landing are buffered for this long. */
    bufferTime: 0.13,
    /**
     * A press while falling keeps waiting for the ground jump (instead of spending the double
     * jump) when walkable ground is less than this many seconds of fall away. ≤ bufferTime.
     */
    landPredictTime: 0.05,
    /**
     * Releasing jump only cuts the jump (air.jumpCutGravityMultiplier) after this long since
     * take-off: short taps give the same minimum hop whether pressed on the ground or buffered.
     */
    minCutTime: 0.1,
    /** Horizontal boost applied on double jump towards input direction (m/s). */
    doubleJumpDirectionalBoost: 2.2,
    /** Minimum time between ground jumps (prevents double-trigger on slopes). */
    cooldown: 0.12,
  },
  slide: {
    /** Horizontal speed required to start a slide (reachable by sprinting or dashing). */
    minStartSpeed: 7.2,
    /**
     * Instant speed boost on slide start (m/s). It never lifts the speed above
     * ground.sprintSpeed + startBoost (chained slide-hops can't stack boosts), and is not applied
     * within `boostCooldown` after the previous slide ended.
     */
    startBoost: 3.2,
    boostCooldown: 1.0,
    /**
     * Constant slide deceleration (m/s²). Projected gravity on slopes steeper than ~11° beats it
     * (see slopeAccelMultiplier), so sliding down ramps speeds up (up to maxSpeed).
     */
    deceleration: 6,
    /**
     * Acceleration from gravity on slopes (multiplier of projected gravity). Exaggerated for feel:
     * on the 18° corridor ramp the horizontal gain is g·sinθ·cosθ·k − deceleration ≈ +3.1 m/s²,
     * break-even with the deceleration is at ~11°.
     */
    slopeAccelMultiplier: 1.35,
    /** On slopes at least this steep (downhill along the slide) the duration limit is paused. */
    slopeExtendMinDeg: 8,
    maxSpeed: 17,
    /** Slide ends below this speed (transitions to crouch). */
    minSpeed: 3.8,
    maxDuration: 1.15,
    /** Steering authority while sliding (turn rate towards input, 1/s). */
    steer: 1.8,
    /** Slide-jump keeps this fraction of slide speed. */
    jumpMomentumKeep: 1.0,
  },
  dash: {
    speed: 24,
    duration: 0.16,
    /** Horizontal speed after the dash as a fraction of dash speed. */
    exitSpeedFraction: 0.5,
    charges: 2,
    /** Seconds per charge; charges refill one after another. */
    rechargeTime: 1.6,
    /** Gravity is suspended during the dash. */
    suspendGravity: true,
    minInterval: 0.22,
  },
  mantle: {
    /** Ledge top must be between these heights above the feet (grounded). */
    minHeight: 0.45,
    /**
     * Minimum ledge height while airborne (catching a ledge at the top of a jump). Airborne ledges
     * lower than `ground.stepHeight` are ignored when ground is that close below the feet (stairs).
     */
    airMinHeight: 0.1,
    maxHeight: 1.75,
    /** How far ahead of the capsule surface we probe for a wall. */
    reach: 0.55,
    /**
     * Face-first probe: a forward ray this high above the feet (capped at half the minimum ledge
     * height) finds the obstacle face; the ledge top is then probed `ledgeInset` behind the face.
     * This catches thin walls and railings (vaulting) that a fixed-distance top probe overshoots.
     */
    faceProbeLow: 0.2,
    /**
     * Face probe height as a fraction of the ledge height: the face-first probe is capped at this
     * fraction of the minimum ledge height, the fallback probe (after a top hit) never runs lower.
     */
    faceProbeHeightFraction: 0.5,
    ledgeInset: 0.06,
    /**
     * Auto-mantle (airborne, no jump press) only while rising slower than this (m/s): a jump
     * that clears the obstacle anyway keeps its momentum; ledges just above the apex are caught.
     */
    autoMaxRiseSpeed: 2.5,
    /** How far past the wall edge the player ends up (capsule axis). */
    forwardOffset: 0.45,
    /** The ledge face must be steep: |normal.y| below this. */
    maxWallNormalY: 0.5,
    /** The face probe ray runs this far below the detected ledge top. */
    faceProbeBelow: 0.12,
    /** Extra height above maxHeight where the downward ledge probe starts. */
    probeUpMargin: 0.1,
    /** The standing capsule is placed this far above the ledge surface. */
    clearanceLift: 0.04,
    /** Full duration for a maxHeight ledge; low ledges are faster (down to minDurationFraction). */
    duration: 0.32,
    minDurationFraction: 0.6,
    /** Curve shaping: vertical motion runs over [0, upPortion], horizontal over [forwardStart, 1]. */
    upPortion: 0.65,
    forwardStart: 0.3,
    /** Minimum horizontal speed after mantling. */
    exitSpeed: 4.5,
    /** Fraction of the incoming forward speed kept through a mantle (sprint-vaults keep momentum). */
    exitMomentumKeep: 0.85,
    /** Minimum forward input needed to auto-mantle while airborne. */
    forwardInputThreshold: 0.5,
    /** Jump-initiated mantles need at least this much forward input (a jump in place stays a jump). */
    jumpForwardInputMin: 0.1,
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
    /** Below this horizontal speed the gait does not advance. */
    minSpeed: 0.8,
  },
  noclip: {
    speed: 14,
    fastMultiplier: 3,
  },
} as const;

export type MovementDef = typeof MOVEMENT;
