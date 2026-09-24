/**
 * Pure throw math of the grenades (tested): strength from the hold time, the launch direction
 * and speed of a throw, the off-hand draw position and the ballistic arc (constant gravity, the
 * same integration ProjectileSystem uses).
 */
import type { Vec3Like } from '../core/events';
import { DEG2RAD, clamp01, lerp } from '../core/math';
import { aimBasis } from '../weapons/spread';

const _right = { x: 0, y: 0, z: 0 };
const _up = { x: 0, y: 0, z: 0 };
const _fwd = { x: 0, y: 0, z: 0 };

export interface ThrowRules {
  readonly lobSpeedScale: number;
  readonly windup: number;
  readonly lobPitchDeg: number;
  readonly throwPitchDeg: number;
  readonly maxPitchDeg: number;
}

/** Throw strength 0 (a tap: lob) .. 1 (held for `windup` s: full throw), eased out. */
export function throwStrength(holdTime: number, windup: number): number {
  if (!(windup > 0)) return 1;
  const t = clamp01(Number.isFinite(holdTime) ? holdTime / windup : 0);
  return 1 - (1 - t) * (1 - t);
}

/**
 * Launch of a throw of `strength` along the view (`yaw`, `pitch` rad; yaw 0 looks down −Z): the
 * unit direction goes into `outDir`, the return value is the speed scale on the grenade's full
 * throw speed. The view is pitched up by lobPitchDeg → throwPitchDeg, capped at maxPitchDeg.
 */
export function throwLaunch(
  yaw: number,
  pitch: number,
  strength: number,
  rules: ThrowRules,
  outDir: Vec3Like,
): number {
  const s = clamp01(Number.isFinite(strength) ? strength : 1);
  const lift = lerp(rules.lobPitchDeg, rules.throwPitchDeg, s) * DEG2RAD;
  const p = Math.min(rules.maxPitchDeg * DEG2RAD, (Number.isFinite(pitch) ? pitch : 0) + lift);
  aimBasis(Number.isFinite(yaw) ? yaw : 0, p, outDir, _right, _up);
  return lerp(rules.lobSpeedScale, 1, s);
}

/** World position of a camera-space offset (right, up, forward m) from `eye` along the view. */
export function handPosition(
  eye: Vec3Like,
  yaw: number,
  pitch: number,
  hand: { readonly right: number; readonly up: number; readonly forward: number },
  out: Vec3Like,
): Vec3Like {
  aimBasis(yaw, pitch, _fwd, _right, _up);
  out.x = eye.x + _right.x * hand.right + _up.x * hand.up + _fwd.x * hand.forward;
  out.y = eye.y + _right.y * hand.right + _up.y * hand.up + _fwd.y * hand.forward;
  out.z = eye.z + _right.z * hand.right + _up.z * hand.up + _fwd.z * hand.forward;
  return out;
}

/** Position on the ballistic arc `t` s after launch from `origin` at `velocity` (gravity m/s² down). */
export function arcPoint(
  origin: Vec3Like,
  velocity: Vec3Like,
  gravity: number,
  t: number,
  out: Vec3Like,
): Vec3Like {
  out.x = origin.x + velocity.x * t;
  out.y = origin.y + velocity.y * t - 0.5 * gravity * t * t;
  out.z = origin.z + velocity.z * t;
  return out;
}

/**
 * Horizontal distance at which the arc from `origin` (velocity, gravity) comes down to height
 * `floorY` (flat ground, no bounces); 0 when it starts below it. Tests / tuning.
 */
export function arcRange(origin: Vec3Like, velocity: Vec3Like, gravity: number, floorY: number): number {
  const h = origin.y - floorY;
  if (h < 0) return 0;
  const vy = velocity.y;
  const horiz = Math.hypot(velocity.x, velocity.z);
  if (!(gravity > 0)) return vy >= 0 ? Number.POSITIVE_INFINITY : (horiz * h) / -vy;
  // y(t) = h + vy t − g t²/2 = 0 → t = (vy + √(vy² + 2 g h)) / g
  const t = (vy + Math.sqrt(vy * vy + 2 * gravity * h)) / gravity;
  return horiz * t;
}
