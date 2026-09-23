/**
 * Pure math of the screen-space explosion shockwave (ShockwaveEffect): a ring that expands in
 * world space and is projected to the screen every frame, so it stays glued to the epicenter
 * while the camera moves. Units: world meters in, UV (screen-height) units out.
 */

export interface ShockwaveTuning {
  readonly duration: number;
  readonly amplitude: number;
  readonly thicknessRatio: number;
  readonly minThickness: number;
  readonly maxThickness: number;
  readonly minDepth: number;
  readonly fullDistance: number;
}

/** World radius at `age` for a wave growing to `maxRadius` over `duration` (ease-out cubic). */
export function shockwaveRadius(age: number, duration: number, maxRadius: number): number {
  const t = Math.min(1, Math.max(0, age / Math.max(duration, 1e-6)));
  const k = 1 - t;
  return maxRadius * (1 - k * k * k);
}

/** Displacement envelope: full at the start, quadratic fade to 0 at `duration`. */
export function shockwaveEnvelope(age: number, duration: number): number {
  const t = Math.min(1, Math.max(0, age / Math.max(duration, 1e-6)));
  const k = 1 - t;
  return k * k;
}

/**
 * Screen radius (UV-height units) of a world radius at view depth `depth` for a projection whose
 * [1][1] element is `projYY` (= 1 / tan(fovY / 2)). NDC spans 2 units per screen height.
 */
export function screenRadius(worldRadius: number, depth: number, projYY: number): number {
  if (!(depth > 0)) return 0;
  return (worldRadius * projYY * 0.5) / depth;
}

/** Ring half-width in UV units for a screen radius. */
export function ringThickness(radiusUv: number, tuning: ShockwaveTuning): number {
  return Math.min(tuning.maxThickness, Math.max(tuning.minThickness, radiusUv * tuning.thicknessRatio));
}

/** Distance attenuation of the displacement (1 up to fullDistance, then ∝ 1 / d). */
export function distanceFalloff(depth: number, fullDistance: number): number {
  return depth <= fullDistance ? 1 : fullDistance / depth;
}
