/**
 * Pure movement math (no scene objects, no allocations). Vectors are plain `{x, z}` /
 * `{x, y, z}` objects mutated in place; horizontal helpers only touch x and z.
 *
 * Conventions: Y is up, gravity is a positive magnitude pulling towards -Y, dt in seconds.
 */

export interface HorizontalVec {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const EPS = 1e-6;

export function horizontalSpeed(v: HorizontalVec): number {
  return Math.hypot(v.x, v.z);
}

/**
 * Source/Quake ground friction on the horizontal velocity. Below `stopSpeed` the drop is
 * computed as if moving at `stopSpeed`, so slow drift stops quickly. Never reverses direction.
 */
export function applyFriction(vel: HorizontalVec, friction: number, stopSpeed: number, dt: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < EPS) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = speed < stopSpeed ? stopSpeed : speed;
  const newSpeed = speed - control * friction * dt;
  if (newSpeed <= 0) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/**
 * Constant (linear) deceleration of the horizontal speed, e.g. for slides: unlike exponential
 * friction it lets steep enough slopes out-accelerate it. Never reverses direction.
 */
export function applyLinearFriction(vel: HorizontalVec, decel: number, dt: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  const newSpeed = speed - decel * dt;
  if (newSpeed <= 0 || speed < EPS) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/**
 * Quake-style acceleration: adds velocity along the unit `wishDir` until the projected speed
 * reaches `wishSpeed`. `accel` is a factor (1/s): per second at most accel × wishSpeed is added.
 * Returns the speed added.
 */
export function accelerate(
  vel: HorizontalVec,
  wishDir: HorizontalVec,
  wishSpeed: number,
  accel: number,
  dt: number,
): number {
  if (wishSpeed <= 0) return 0;
  const current = vel.x * wishDir.x + vel.z * wishDir.z;
  const add = wishSpeed - current;
  if (add <= 0) return 0;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wishDir.x * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
  return accelSpeed;
}

/**
 * Quake air acceleration with a capped wish speed (air strafing), plus a hard ceiling:
 * air acceleration never raises the horizontal speed above `maxSpeed` (momentum already above
 * it, e.g. from a dash, is preserved but not increased).
 */
export function airAccelerate(
  vel: HorizontalVec,
  wishDir: HorizontalVec,
  wishSpeed: number,
  wishSpeedCap: number,
  accel: number,
  dt: number,
  maxSpeed: number,
): void {
  if (wishSpeed <= 0) return;
  const before = Math.hypot(vel.x, vel.z);
  const capped = Math.min(wishSpeed, wishSpeedCap);
  const current = vel.x * wishDir.x + vel.z * wishDir.z;
  const add = capped - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wishDir.x * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
  const after = Math.hypot(vel.x, vel.z);
  const limit = Math.max(before, maxSpeed);
  if (after > limit && after > EPS) {
    const s = limit / after;
    vel.x *= s;
    vel.z *= s;
  }
}

/**
 * Rotate the horizontal velocity towards `wishDir` without changing its magnitude
 * (air control / slide steering). Only acts when the input is not pointing backwards.
 */
export function steerTowards(vel: HorizontalVec, wishDir: HorizontalVec, rate: number, dt: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < EPS || rate <= 0) return;
  const dx = vel.x / speed;
  const dz = vel.z / speed;
  const dot = dx * wishDir.x + dz * wishDir.z;
  if (dot < 0) return;
  const t = Math.min(1, rate * dt);
  let nx = dx + (wishDir.x - dx) * t;
  let nz = dz + (wishDir.z - dz) * t;
  const len = Math.hypot(nx, nz);
  if (len < EPS) return;
  nx /= len;
  nz /= len;
  vel.x = nx * speed;
  vel.z = nz * speed;
}

/** Clamp the horizontal speed to `max`. */
export function clampHorizontalSpeed(vel: HorizontalVec, max: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed > max && speed > EPS) {
    const s = max / speed;
    vel.x *= s;
    vel.z *= s;
  }
}

/** Launch speed that reaches `height` under constant `gravity`: v = sqrt(2 g h). */
export function jumpVelocity(height: number, gravity: number): number {
  return Math.sqrt(2 * gravity * Math.max(0, height));
}

export interface GravityDef {
  gravity: number;
  fallGravityMultiplier: number;
  jumpCutGravityMultiplier: number;
  terminalVelocity: number;
}

/**
 * Effective gravity for this tick: stronger while falling (snappier arc), and stronger while
 * still rising from a jump whose button was released early (variable jump height).
 */
export function effectiveGravity(
  vy: number,
  jumpActive: boolean,
  jumpHeld: boolean,
  def: GravityDef,
): number {
  if (vy < 0) return def.gravity * def.fallGravityMultiplier;
  if (jumpActive && !jumpHeld && vy > 0) return def.gravity * def.jumpCutGravityMultiplier;
  return def.gravity;
}

export interface VerticalStep {
  /** Vertical displacement over the tick. */
  dy: number;
  /** Vertical velocity at the end of the tick. */
  vy: number;
}

/**
 * Integrate vertical motion under constant gravity for one tick. Uses the average of start
 * and end velocity (exact for constant acceleration), then clamps to terminal velocity.
 */
export function integrateVertical(
  vy: number,
  gravity: number,
  terminalVelocity: number,
  dt: number,
  out: VerticalStep,
): VerticalStep {
  let v1 = vy - gravity * dt;
  if (v1 < -terminalVelocity) v1 = -terminalVelocity;
  out.dy = (vy + v1) * 0.5 * dt;
  out.vy = v1;
  return out;
}

/** Count a timer down to zero. */
export function tickDown(t: number, dt: number): number {
  return t > dt ? t - dt : 0;
}

/**
 * Ground jump allowed? Grounded, or within the coyote window after leaving the ground
 * without having jumped, and not in the post-jump cooldown.
 */
export function canGroundJump(
  grounded: boolean,
  timeSinceGrounded: number,
  coyoteTime: number,
  jumpedSinceGrounded: boolean,
  cooldownLeft: number,
): boolean {
  if (cooldownLeft > 0 || jumpedSinceGrounded) return false;
  return grounded || timeSinceGrounded <= coyoteTime;
}

/**
 * Double jump horizontal redirect: add `boost` towards the input direction, but never exceed
 * max(current speed, speedCap) – it redirects momentum rather than adding free speed.
 */
export function doubleJumpRedirect(
  vel: HorizontalVec,
  wishDir: HorizontalVec,
  hasInput: boolean,
  boost: number,
  speedCap: number,
): void {
  if (!hasInput) return;
  const before = Math.hypot(vel.x, vel.z);
  vel.x += wishDir.x * boost;
  vel.z += wishDir.z * boost;
  clampHorizontalSpeed(vel, Math.max(before, speedCap));
}

/**
 * Horizontal component of gravity projected on a ground plane with unit normal `n`
 * (points downhill). Magnitude = g · sinθ · cosθ for slope angle θ. Returns `out`.
 */
export function slopeAcceleration(n: Vec3, gravity: number, out: HorizontalVec): HorizontalVec {
  // g_t = g - (g·n) n with g = (0, -G, 0) → horizontal part = G · n.y · (n.x, n.z)
  const k = gravity * n.y;
  out.x = k * n.x;
  out.z = k * n.z;
  return out;
}

/** Slope angle in radians of a unit ground normal. */
export function slopeAngle(n: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, n.y)));
}

export interface DashChargeState {
  charges: number;
  /** 0..1 progress of the charge currently refilling. */
  progress: number;
}

/** Refill dash charges one after another (sequential recharge). */
export function rechargeDash(s: DashChargeState, maxCharges: number, rechargeTime: number, dt: number): void {
  if (s.charges >= maxCharges) {
    s.charges = maxCharges;
    s.progress = 0;
    return;
  }
  s.progress += rechargeTime > 0 ? dt / rechargeTime : 1;
  while (s.progress >= 1 && s.charges < maxCharges) {
    s.charges++;
    s.progress -= 1;
  }
  if (s.charges >= maxCharges) s.progress = 0;
}

/** Spend a dash charge if available. The refill in progress is kept. */
export function consumeDashCharge(s: DashChargeState): boolean {
  if (s.charges < 1) return false;
  s.charges--;
  return true;
}

export interface MantleHeightDef {
  minHeight: number;
  airMinHeight: number;
  maxHeight: number;
}

/** Is a ledge at `ledgeHeight` above the feet mantleable (grounded vs airborne thresholds)? */
export function ledgeHeightOk(ledgeHeight: number, grounded: boolean, def: MantleHeightDef): boolean {
  const min = grounded ? def.minHeight : def.airMinHeight;
  return ledgeHeight >= min && ledgeHeight <= def.maxHeight;
}

/** Mantle duration scaled by height: low ledges are quicker. */
export function mantleDuration(
  ledgeHeight: number,
  maxHeight: number,
  duration: number,
  minFraction: number,
): number {
  const f = maxHeight > 0 ? Math.min(1, Math.max(0, ledgeHeight / maxHeight)) : 1;
  return duration * (minFraction + (1 - minFraction) * f);
}

export interface MantleCurve {
  /** 0..1 progress of the vertical motion. */
  vertical: number;
  /** 0..1 progress of the horizontal motion. */
  horizontal: number;
}

/**
 * Up-then-forward mantle curve. Vertical motion eases out over [0, upPortion], horizontal
 * motion eases in-out over [forwardStart, 1]; the overlap rounds the corner.
 */
export function mantleCurve(
  t: number,
  upPortion: number,
  forwardStart: number,
  out: MantleCurve,
): MantleCurve {
  const tc = Math.min(1, Math.max(0, t));
  const u = upPortion > 0 ? Math.min(1, tc / upPortion) : 1;
  out.vertical = 1 - (1 - u) * (1 - u);
  const h = forwardStart < 1 ? Math.min(1, Math.max(0, (tc - forwardStart) / (1 - forwardStart))) : 1;
  out.horizontal = h * h * (3 - 2 * h);
  return out;
}

export interface GaitState {
  /** Radians; a footstep happens every time the phase crosses a multiple of PI. */
  phase: number;
}

/**
 * Advance the gait by `distance` meters with the given stride length. Returns how many
 * footsteps happened (phase crossed k·PI). One stride = one footstep = PI of phase.
 */
export function advanceGait(g: GaitState, distance: number, stride: number): number {
  if (distance <= 0 || stride <= 0) return 0;
  const before = Math.floor(g.phase / Math.PI);
  g.phase += (distance / stride) * Math.PI;
  const after = Math.floor(g.phase / Math.PI);
  // Keep the phase bounded without losing the parity used by the bob (2π periodic).
  if (g.phase > 1e6) g.phase -= Math.floor(g.phase / (2 * Math.PI)) * 2 * Math.PI;
  return after - before;
}

export interface LandingInfo {
  emit: boolean;
  heavy: boolean;
}

export function classifyLanding(
  impactSpeed: number,
  minImpactSpeed: number,
  heavyImpactSpeed: number,
  out: LandingInfo,
): LandingInfo {
  out.emit = impactSpeed >= minImpactSpeed;
  out.heavy = impactSpeed >= heavyImpactSpeed;
  return out;
}

/** Remove the component of `v` pointing into the surface with unit normal `n` (Quake ClipVelocity). */
export function clipVelocity(v: Vec3, n: Vec3): void {
  const d = v.x * n.x + v.y * n.y + v.z * n.z;
  if (d >= 0) return;
  v.x -= n.x * d;
  v.y -= n.y * d;
  v.z -= n.z * d;
}
