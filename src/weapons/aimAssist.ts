/**
 * Pure gamepad aim assist (never used for mouse input): look slowdown ("friction") near a target
 * and gentle input-driven magnetism towards its aim point. Magnetism only acts while the player
 * is turning (the pull is proportional to the stick's look delta), so a resting stick never
 * tracks on its own.
 */
import type { Vec3Like } from '../core/events';
import { DEG2RAD, lerp, wrapAngle } from '../core/math';

export interface AimAssistRules {
  readonly slowdownRadiusDeg: number;
  readonly slowdownFactor: number;
  readonly magnetismDeg: number;
  readonly magnetismStrength: number;
  readonly maxRange: number;
}

export interface AimError {
  /** Radians the aim must turn: yaw + = target is to the LEFT (three.js yaw), pitch + = above. */
  yaw: number;
  pitch: number;
  /** Angle between the aim and the target direction (rad). */
  angle: number;
  distance: number;
}

/** Angular error from an eye with the given yaw/pitch to `target`; false if degenerate. */
export function aimError(
  eye: Vec3Like,
  yaw: number,
  pitch: number,
  target: Vec3Like,
  out: AimError,
): boolean {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz);
  const dist = Math.hypot(horiz, dy);
  if (!(dist > 1e-6)) return false;
  const targetYaw = Math.atan2(-dx, -dz);
  const targetPitch = Math.atan2(dy, horiz);
  out.yaw = wrapAngle(targetYaw - yaw);
  out.pitch = targetPitch - pitch;
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  const dot = (fx * dx + fy * dy + fz * dz) / dist;
  out.angle = Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot);
  out.distance = dist;
  return true;
}

/** Is a target with this error inside the assist window at all? */
export function inAssistWindow(err: AimError, rules: AimAssistRules): boolean {
  return (
    err.distance <= rules.maxRange &&
    err.angle < Math.max(rules.slowdownRadiusDeg, rules.magnetismDeg) * DEG2RAD
  );
}

export interface LookDelta {
  /** Radians, + = turn right (InputApi.getLook convention). */
  yaw: number;
  /** Radians, + = look up. */
  pitch: number;
}

/** Apply slowdown + magnetism to this frame's look delta in place. Returns the slowdown scale used. */
export function applyAimAssist(look: LookDelta, err: AimError, rules: AimAssistRules): number {
  if (!inAssistWindow(err, rules)) return 1;
  const inputMag = Math.hypot(look.yaw, look.pitch);
  const radius = rules.slowdownRadiusDeg * DEG2RAD;
  let scale = 1;
  if (radius > 0 && err.angle < radius) scale = lerp(rules.slowdownFactor, 1, err.angle / radius);
  look.yaw *= scale;
  look.pitch *= scale;
  if (inputMag > 0 && err.angle < rules.magnetismDeg * DEG2RAD) {
    // Look-space error: turning towards a target on the left is a negative look yaw.
    const ey = -err.yaw;
    const ep = err.pitch;
    const errMag = Math.hypot(ey, ep);
    if (errMag > 1e-9) {
      const pull = Math.min(rules.magnetismStrength * inputMag, errMag);
      look.yaw += (ey / errMag) * pull;
      look.pitch += (ep / errMag) * pull;
    }
  }
  return scale;
}
