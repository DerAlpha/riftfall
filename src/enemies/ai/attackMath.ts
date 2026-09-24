/**
 * Pure, allocation-free math for enemy attacks and movement: melee reach/facing checks, AoE falloff,
 * attack phase → animation progress, capsule distances, yaw helpers. Yaw convention (three.js,
 * defs/enemyVisuals): the model faces +Z at yaw 0, forward = (sin yaw, 0, cos yaw).
 */
import type { Vec3Like } from '../../core/events';

const TAU = Math.PI * 2;

/** Yaw that faces the direction (dx, dz). */
export function yawTo(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Wrap to (-π, π]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Turn `from` towards `to` by at most `maxStep` radians (shortest way). */
export function turnTowards(from: number, to: number, maxStep: number): number {
  const d = wrapPi(to - from);
  if (Math.abs(d) <= maxStep) return wrapPi(to);
  return wrapPi(from + Math.sign(d) * maxStep);
}

/**
 * Melee hit test at the strike moment: the target's capsule (feet `t`, radius `targetRadius`) is
 * within `reach` of the attacker's feet center (horizontal), inside the frontal cone (full angle
 * `coneRad` around yaw) and the feet heights differ by at most `height`.
 */
export function meleeHits(
  attacker: Vec3Like,
  yaw: number,
  target: Vec3Like,
  targetRadius: number,
  reach: number,
  coneRad: number,
  height: number,
): boolean {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  if (Math.abs(target.y - attacker.y) > height) return false;
  const dist = Math.hypot(dx, dz);
  if (dist - targetRadius > reach) return false;
  // Overlapping: always in front.
  if (dist <= targetRadius) return true;
  const cos = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / dist;
  // The capsule's angular half-width widens the cone slightly at close range.
  const half = coneRad / 2 + Math.asin(Math.min(1, targetRadius / dist));
  return cos >= Math.cos(Math.min(Math.PI, half));
}

/** Damage factor: 1 within `inner`, linear to `minFactor` at `radius`, 0 beyond. */
export function aoeFactor(distance: number, inner: number, radius: number, minFactor: number): number {
  if (!(distance <= radius)) return 0;
  if (distance <= inner || radius <= inner) return 1;
  const t = (distance - inner) / (radius - inner);
  return 1 + (minFactor - 1) * t;
}

/**
 * Pose attack progress (0..1) for an attack in `phase` at `t` seconds into it. The animation (visual
 * def) ends its wind-up at `animWindup` and its strike at `animStrike`; the AI phases have their own
 * durations, so each phase maps linearly onto its animation segment.
 */
export function attackAnimProgress(
  phase: 0 | 1 | 2,
  t: number,
  duration: number,
  animWindup: number,
  animStrike: number,
): number {
  const f = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 1;
  switch (phase) {
    case 0:
      return f * animWindup;
    case 1:
      return animWindup + f * (animStrike - animWindup);
    case 2:
      return animStrike + f * (1 - animStrike);
  }
}

/** Squared distance from point p to segment ab (scalar form). */
export function pointSegmentDistSq(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const len2 = ux * ux + uy * uy + uz * uz;
  let t = len2 > 0 ? ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ux * t);
  const dy = py - (ay + uy * t);
  const dz = pz - (az + uz * t);
  return dx * dx + dy * dy + dz * dz;
}

/** Result of segmentSegment: squared distance and the parameter on the FIRST segment. */
export interface SegmentClosest {
  distSq: number;
  s: number;
}

/**
 * Closest distance between segments p0→p1 and q0→q1 (Ericson, Real-Time Collision Detection 5.1.9).
 * Used for swept projectile vs player capsule tests.
 */
export function segmentSegment(
  p0: Vec3Like,
  p1: Vec3Like,
  q0: Vec3Like,
  q1: Vec3Like,
  out: SegmentClosest,
): SegmentClosest {
  const d1x = p1.x - p0.x;
  const d1y = p1.y - p0.y;
  const d1z = p1.z - p0.z;
  const d2x = q1.x - q0.x;
  const d2y = q1.y - q0.y;
  const d2z = q1.z - q0.z;
  const rx = p0.x - q0.x;
  const ry = p0.y - q0.y;
  const rz = p0.z - q0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const dx = p0.x + d1x * s - (q0.x + d2x * t);
  const dy = p0.y + d1y * s - (q0.y + d2y * t);
  const dz = p0.z + d1z * s - (q0.z + d2z * t);
  out.distSq = dx * dx + dy * dy + dz * dz;
  out.s = s;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Distance from point p to the player capsule's surface: axis from feet + radius to the eye
 * (clamped so a crouched/short capsule still has a valid axis). Negative inside.
 */
export function distanceToCapsule(p: Vec3Like, feet: Vec3Like, eye: Vec3Like, radius: number): number {
  const ay = feet.y + radius;
  const by = Math.max(ay, eye.y);
  const d2 = pointSegmentDistSq(p.x, p.y, p.z, feet.x, ay, feet.z, eye.x, by, eye.z);
  return Math.sqrt(d2) - radius;
}

/** Static-world line of sight (CombatWorldApi.lineOfSight). */
export interface LineOfSightQuery {
  lineOfSight(from: Vec3Like, to: Vec3Like): boolean;
}

const _axis = { x: 0, y: 0, z: 0 };

/**
 * Does a blast at `from` reach the player capsule (feet, eye, radius – the distanceToCapsule axis)?
 * It needs a static line of sight to the axis point nearest the blast or, failing that, to the eye
 * (a head above cover still gets hit): splash never passes through walls or floors.
 */
export function blastReachesCapsule(
  los: LineOfSightQuery,
  from: Vec3Like,
  feet: Vec3Like,
  eye: Vec3Like,
  radius: number,
): boolean {
  const ay = feet.y + radius;
  const by = Math.max(ay, eye.y);
  const ux = eye.x - feet.x;
  const uy = by - ay;
  const uz = eye.z - feet.z;
  const len2 = ux * ux + uy * uy + uz * uz;
  let t = len2 > 0 ? ((from.x - feet.x) * ux + (from.y - ay) * uy + (from.z - feet.z) * uz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  _axis.x = feet.x + ux * t;
  _axis.y = ay + uy * t;
  _axis.z = feet.z + uz * t;
  if (los.lineOfSight(from, _axis)) return true;
  return t < 1 && los.lineOfSight(from, eye);
}

/** Horizontal distance. */
export function distXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Horizontal distance squared. */
export function distXZSq(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Is `p` inside the view cone (full angle `fovRad`) of an observer at `o` facing `yaw`? (XZ) */
export function inFov(o: Vec3Like, yaw: number, p: Vec3Like, fovRad: number): boolean {
  const dx = p.x - o.x;
  const dz = p.z - o.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  return (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / len >= Math.cos(Math.min(Math.PI, fovRad / 2));
}

/** Locomotion blend (EnemyPose.locomotion): 0 idle → 1 at walk speed → 2 at run speed. */
export function locomotionBlend(speed: number, walk: number, run: number): number {
  if (!(speed > 0)) return 0;
  if (speed <= walk) return speed / walk;
  if (run <= walk) return 2;
  return 1 + Math.min(1, (speed - walk) / (run - walk));
}
