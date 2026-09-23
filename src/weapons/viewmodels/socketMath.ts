/**
 * Pure math for viewmodel sockets.
 *
 * The viewmodel is drawn with its own camera (fixed FOV) at the origin of its own scene, sharing
 * the world camera's orientation. A socket (muzzle, eject port) therefore has no meaningful world
 * position. To spawn world effects (tracers, casings, lights) where the player SEES the socket,
 * the socket's view-space point is projected with the viewmodel projection to NDC and unprojected
 * with the world projection at the same view depth: the resulting world point covers the same
 * pixel in the world camera and sits at the same distance in front of the eye.
 */
import type { Matrix4, Vector3 } from 'three';
import type { Vec3Like } from '../../core/events';

/**
 * Map a view-space point of camera A (`viewPoint`, camera looks down −Z) to the view-space point
 * of camera B that projects to the same NDC position at the same view depth. Works for any
 * perspective projections (different FOV, aspect, view offsets). Writes and returns `out`
 * (`out` may alias `viewPoint`).
 */
export function mapViewPointBetweenProjections(
  viewPoint: Vector3,
  projectionA: Matrix4,
  projectionInverseB: Matrix4,
  out: Vector3,
): Vector3 {
  const depth = viewPoint.z;
  // Points at or behind the eye have no stable projection: keep them as they are.
  if (depth > -1e-6) return out.copy(viewPoint);
  out.copy(viewPoint).applyMatrix4(projectionA);
  // Any NDC depth on the ray works; the point is rescaled to the original depth below.
  out.z = 0;
  out.applyMatrix4(projectionInverseB);
  if (Math.abs(out.z) < 1e-9) return out.copy(viewPoint);
  const s = depth / out.z;
  out.x *= s;
  out.y *= s;
  out.z = depth;
  return out;
}

/**
 * Root offset (viewmodel camera space) that puts a model-space sight socket on the view axis,
 * `eyeDistance` meters in front of the eye, with an unrotated model. `nudge` fine-tunes the
 * result (e.g. a hair lower so the front post covers the dot).
 */
export function adsOffsetFromSight<T extends Vec3Like>(
  sight: Vec3Like,
  eyeDistance: number,
  out: T,
  nudge?: Vec3Like,
): T {
  out.x = -sight.x + (nudge?.x ?? 0);
  out.y = -sight.y + (nudge?.y ?? 0);
  out.z = -eyeDistance - sight.z + (nudge?.z ?? 0);
  return out;
}
