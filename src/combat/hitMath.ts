/**
 * Pure hit-test math (allocation free). Directions must be normalized. Every ray test returns the
 * distance along the ray to the first surface point, 0 when the origin is inside the volume, and
 * -1 on a miss (including volumes entirely behind the origin).
 */
import type { Vec3Like } from '../core/events';

/** Ray vs sphere. */
export function raySphere(o: Vec3Like, d: Vec3Like, c: Vec3Like, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc <= 0) return 0;
  const b = ox * d.x + oy * d.y + oz * d.z;
  // Outside and pointing away.
  if (b > 0) return -1;
  const h = b * b - cc;
  if (h < 0) return -1;
  return -b - Math.sqrt(h);
}

/** Squared distance from point p to segment ab. */
export function pointSegmentDistanceSq(p: Vec3Like, a: Vec3Like, b: Vec3Like): number {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const bz = b.z - a.z;
  const px = p.x - a.x;
  const py = p.y - a.y;
  const pz = p.z - a.z;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 0 ? (px * bx + py * by + pz * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - bx * t;
  const dy = py - by * t;
  const dz = pz - bz * t;
  return dx * dx + dy * dy + dz * dz;
}

/** Ray vs sphere given by scalar center (internal helper for capsule caps). */
function raySphereXYZ(o: Vec3Like, d: Vec3Like, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : -1;
}

/** Relative threshold below which a ray counts as parallel to the capsule axis. */
const PARALLEL_EPS = 1e-9;

/**
 * Ray vs capsule (segment ab, radius r). Analytic: infinite cylinder around the axis, clipped to
 * the segment, else the nearer cap sphere (after Inigo Quilez' capIntersect).
 */
export function rayCapsule(o: Vec3Like, d: Vec3Like, a: Vec3Like, b: Vec3Like, r: number): number {
  if (pointSegmentDistanceSq(o, a, b) <= r * r) return 0;
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const oax = o.x - a.x;
  const oay = o.y - a.y;
  const oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba <= 0) return raySphere(o, d, a, r);
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const qa = baba - bard * bard;
  if (qa <= PARALLEL_EPS * baba) {
    // Parallel to the axis: only the caps can be hit.
    const ta = raySphereXYZ(o, d, a.x, a.y, a.z, r);
    const tb = raySphereXYZ(o, d, b.x, b.y, b.z, r);
    if (ta < 0) return tb;
    if (tb < 0) return ta;
    return ta < tb ? ta : tb;
  }
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - r * r * baba;
  const h = qb * qb - qa * qc;
  if (h < 0) return -1;
  const t = (-qb - Math.sqrt(h)) / qa;
  const y = baoa + t * bard;
  if (y > 0 && y < baba) return t >= 0 ? t : -1;
  // Beyond the segment: the cap sphere on that side.
  return y <= 0 ? raySphereXYZ(o, d, a.x, a.y, a.z, r) : raySphereXYZ(o, d, b.x, b.y, b.z, r);
}

/** Outward surface normal of a capsule at surface point p (written into out, normalized). */
export function capsuleNormal<T extends Vec3Like>(p: Vec3Like, a: Vec3Like, b: Vec3Like, out: T): T {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const bz = b.z - a.z;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 0 ? ((p.x - a.x) * bx + (p.y - a.y) * by + (p.z - a.z) * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return normalizeInto(p.x - (a.x + bx * t), p.y - (a.y + by * t), p.z - (a.z + bz * t), out);
}

/** Outward surface normal of a sphere at surface point p. */
export function sphereNormal<T extends Vec3Like>(p: Vec3Like, c: Vec3Like, out: T): T {
  return normalizeInto(p.x - c.x, p.y - c.y, p.z - c.z, out);
}

function normalizeInto<T extends Vec3Like>(x: number, y: number, z: number, out: T): T {
  const len = Math.hypot(x, y, z);
  if (len > 1e-12) {
    out.x = x / len;
    out.y = y / len;
    out.z = z / len;
  } else {
    out.x = 0;
    out.y = 1;
    out.z = 0;
  }
  return out;
}

/** Do two spheres overlap (touching counts)? */
export function spheresOverlap(a: Vec3Like, ra: number, b: Vec3Like, rb: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const r = ra + rb;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * Damage falloff multiplier: 1 up to `start`, linear to `min` at `end`, `min` beyond.
 * Degenerate ranges (end <= start) switch hard at `start`.
 */
export function falloffMultiplier(distance: number, start: number, end: number, min: number): number {
  if (!(distance > start)) return 1;
  if (end <= start || distance >= end) return min;
  const t = (distance - start) / (end - start);
  return 1 + (min - 1) * t;
}
