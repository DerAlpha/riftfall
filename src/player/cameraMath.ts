/** Pure first-person camera helpers (FOV conversion, trauma, spring integration). */
import { DEG2RAD, RAD2DEG, springStep, type SpringState } from '../core/math';

/** Convert a horizontal FOV (degrees) defined at `aspect` into a vertical FOV (degrees). */
export function horizontalToVerticalFov(hDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((hDeg * DEG2RAD) / 2) / aspect) * RAD2DEG;
}

/** Convert a vertical FOV (degrees) into the horizontal FOV at `aspect`. */
export function verticalToHorizontalFov(vDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((vDeg * DEG2RAD) / 2) * aspect) * RAD2DEG;
}

/** Linear trauma decay, clamped to [0, 1]. */
export function decayTrauma(trauma: number, decayPerSecond: number, dt: number): number {
  const t = trauma - decayPerSecond * dt;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Add trauma, clamped to [0, 1]. */
export function addTrauma(trauma: number, amount: number): number {
  const t = trauma + amount;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Initial spring velocity (unit mass, starting at rest at the target) whose first peak
 * displacement is `dip`. Underdamped (ζ < 1): x(t) = v0/ωd · e^(−ζωt) · sin(ωd·t) peaks at
 * t* = atan2(ωd, ζω)/ωd. (Over)critically damped: the critical peak v0/(ω·e) is used, which
 * over-damping only lowers, so the dip is never exceeded.
 */
export function springImpulseForPeak(dip: number, stiffness: number, damping: number): number {
  const w = Math.sqrt(Math.max(0, stiffness));
  if (w <= 0) return 0;
  const zeta = damping / (2 * w);
  if (zeta >= 1) return dip * w * Math.E;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  const t = Math.atan2(wd, zeta * w) / wd;
  return (dip * wd) / (Math.exp(-zeta * w * t) * Math.sin(wd * t));
}

/**
 * Integrate a damped spring with sub-steps of at most `maxStep` seconds so stiff springs
 * stay stable at low frame rates.
 */
export function stepSpringSubstepped(
  s: SpringState,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
  maxStep: number,
): void {
  if (dt <= 0) return;
  const n = Math.max(1, Math.ceil(dt / maxStep));
  const h = dt / n;
  for (let i = 0; i < n; i++) springStep(s, target, stiffness, damping, h);
}
