/**
 * Death camera curve (pure): the eye sinks and the view rolls / tilts over as the body collapses
 * – accelerating like a fall, then a small bounce on impact. RunFlow hands the duration to its
 * onDeathCamera callback and exposes `deathTime`; the composition root applies the offset to the
 * rendered camera after PlayerCamera.update (see the M3 integration notes).
 */
import { RUN } from '../defs/waves';
import type { DeathCameraDef } from './RunFlow';

export interface DeathCameraOffset {
  /** Meters to lower the eye. */
  drop: number;
  /** Radians: roll (rotate around the view axis) and extra pitch (look up). */
  roll: number;
  pitch: number;
}

const DEG2RAD = Math.PI / 180;

/** 0..1 collapse progress at `t` of `duration` seconds (fall, impact, bounce, rest at 1). */
export function deathCollapse(t: number, duration: number, def: DeathCameraDef = RUN.death.camera): number {
  if (!(duration > 0) || !(t > 0)) return 0;
  const p = Math.min(1, t / duration);
  const f = Math.min(1, Math.max(1e-3, def.fallFraction));
  if (p < f) {
    const q = p / f;
    return q * q;
  }
  const b = f < 1 ? (p - f) / (1 - f) : 1;
  return 1 - def.bounce * Math.sin(Math.PI * Math.min(1, b));
}

/** Camera offset at `t` seconds into a `duration` second collapse (written into `out`). */
export function deathCameraOffset(
  t: number,
  duration: number,
  out: DeathCameraOffset,
  def: DeathCameraDef = RUN.death.camera,
): DeathCameraOffset {
  const e = deathCollapse(t, duration, def);
  out.drop = def.drop * e;
  out.roll = def.rollDeg * DEG2RAD * e;
  out.pitch = def.pitchDeg * DEG2RAD * e;
  return out;
}
