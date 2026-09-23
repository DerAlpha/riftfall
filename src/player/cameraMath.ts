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
 * Initial spring velocity that produces a peak displacement of about `dip` for a
 * (near-)critically damped spring of the given stiffness: x(t) = v0·t·e^(−ωt) peaks at
 * v0 / (ω·e).
 */
export function springImpulseForPeak(dip: number, stiffness: number): number {
  return dip * Math.sqrt(stiffness) * Math.E;
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
