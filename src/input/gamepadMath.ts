/** Pure stick/trigger shaping helpers (allocation-free, unit-tested). */
import type { Vec2Out } from '../core/contracts';

/**
 * Radial deadzone with rescaling: magnitudes below `inner` read 0, above `1 - outer` read 1 and
 * the range in between is remapped linearly so there is no jump at the deadzone edge.
 * `exponent` shapes the response (1 = linear, >1 = finer control near the center).
 */
export function shapeStick(
  x: number,
  y: number,
  inner: number,
  outer: number,
  exponent: number,
  out: Vec2Out,
): Vec2Out {
  const mag = Math.hypot(x, y);
  const lo = clampDz(inner);
  const hi = Math.max(lo + 1e-3, 1 - clampDz(outer));
  if (!(mag > lo)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  let t = (mag - lo) / (hi - lo);
  t = t >= 1 ? 1 : t;
  if (exponent !== 1) t = Math.pow(t, exponent);
  const s = t / mag;
  out.x = x * s;
  out.y = y * s;
  return out;
}

/** Single-axis deadzone for padAxis bindings: returns 0..1 deflection in `direction`. */
export function axisDeflection(value: number, direction: 1 | -1, inner: number, outer: number): number {
  const v = value * direction;
  const lo = clampDz(inner);
  const hi = Math.max(lo + 1e-3, 1 - clampDz(outer));
  if (!(v > lo)) return 0;
  const t = (v - lo) / (hi - lo);
  return t >= 1 ? 1 : t;
}

/** Clamp a vector to length <= 1 (keyboard diagonals + stick combined). */
export function clampLength1(out: Vec2Out): Vec2Out {
  const len = Math.hypot(out.x, out.y);
  if (len > 1) {
    out.x /= len;
    out.y /= len;
  }
  return out;
}

function clampDz(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 0.95 ? 0.95 : v) : 0;
}
