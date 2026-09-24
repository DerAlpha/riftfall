/**
 * Pure math of the fire-kinds engine (M5): charge and spin-up curves, blast falloff, beam cones,
 * split-shot fans, bounces and homing turns, distances to hitboxes. No three.js objects are
 * created here; callers pass their scratch vectors.
 */
import type { Hitbox } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import type { WeaponChargeDef, WeaponSpinUpDef } from '../../defs/weapons';

// ---------------------------------------------------------------------------
// Charge
// ---------------------------------------------------------------------------

/** Charge after holding for `dt` more seconds (0..1, `time` = seconds to full). */
export function chargeStep(amount: number, dt: number, time: number): number {
  if (!(time > 0)) return 1;
  const next = amount + dt / time;
  return next >= 1 ? 1 : next > 0 ? next : 0;
}

/**
 * Damage factor of a release at `amount`: 0 below `minCharge` (fizzle – no shot), `damageAtMin`
 * at the threshold, linear up to 1 at full charge.
 */
export function chargeDamageFactor(amount: number, def: Pick<WeaponChargeDef, 'minCharge' | 'damageAtMin'>): number {
  if (!(amount >= def.minCharge) || !(amount > 0)) return 0;
  const span = 1 - def.minCharge;
  const t = span > 0 ? Math.min(1, (amount - def.minCharge) / span) : 1;
  return def.damageAtMin + (1 - def.damageAtMin) * t;
}

// ---------------------------------------------------------------------------
// Spin-up
// ---------------------------------------------------------------------------

/** Barrel spin after `dt`: up over `time` while held, down over `spinDown` otherwise (0..1). */
export function spinStep(spin: number, held: boolean, dt: number, def: Pick<WeaponSpinUpDef, 'time' | 'spinDown'>): number {
  if (held) return def.time > 0 ? Math.min(1, spin + dt / def.time) : 1;
  return def.spinDown > 0 ? Math.max(0, spin - dt / def.spinDown) : 0;
}

/** Fire-rate fraction at `spin`: nothing below `startFraction`, then the spin itself (full rpm at 1). */
export function spinRateFactor(spin: number, def: Pick<WeaponSpinUpDef, 'startFraction'>): number {
  if (!(spin > 0) || spin < def.startFraction) return 0;
  return Math.min(1, Math.max(spin, 1e-3));
}

// ---------------------------------------------------------------------------
// Area damage
// ---------------------------------------------------------------------------

/**
 * Explosion falloff: 1 at the center, linear to `minMultiplier` at `radius`, 0 beyond (distance
 * to the target's nearest hitbox surface).
 */
export function blastFalloff(distance: number, radius: number, minMultiplier: number): number {
  if (!(radius > 0) || !(distance <= radius)) return 0;
  const t = Math.max(0, distance) / radius;
  return 1 + (minMultiplier - 1) * t;
}

/** Linear fade 1 → 0 over `reach` (camera shake, prop pushes). */
export function linearFade(distance: number, reach: number): number {
  if (!(reach > 0)) return 0;
  const f = 1 - Math.max(0, distance) / reach;
  return f > 0 ? f : 0;
}

/**
 * Distance from `p` to the surface of the nearest hitbox (0 inside) and that surface point in
 * `out` (`p` itself when inside). +∞ without hitboxes.
 */
export function distanceToHitboxes(p: Vec3Like, boxes: readonly Hitbox[], out: Vec3Like): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < boxes.length; i++) {
    const h = boxes[i]!;
    let cx = h.a.x;
    let cy = h.a.y;
    let cz = h.a.z;
    if (h.shape === 'capsule') {
      const bx = h.b.x - h.a.x;
      const by = h.b.y - h.a.y;
      const bz = h.b.z - h.a.z;
      const len2 = bx * bx + by * by + bz * bz;
      let t = len2 > 0 ? ((p.x - h.a.x) * bx + (p.y - h.a.y) * by + (p.z - h.a.z) * bz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      cx += bx * t;
      cy += by * t;
      cz += bz * t;
    }
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    const centerDist = Math.hypot(dx, dy, dz);
    const d = Math.max(0, centerDist - h.radius);
    if (d >= best) continue;
    best = d;
    if (d <= 0 || !(centerDist > 1e-9)) {
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
    } else {
      const k = h.radius / centerDist;
      out.x = cx + dx * k;
      out.y = cy + dy * k;
      out.z = cz + dz * k;
    }
  }
  return best;
}

/** Distance from `p` to a vertical capsule (feet → eye, radius) – the player's body. */
export function distanceToBody(p: Vec3Like, feet: Vec3Like, eye: Vec3Like, radius: number): number {
  const ax = feet.x;
  const ay = feet.y + radius;
  const az = feet.z;
  const bx = eye.x - ax;
  const by = Math.max(ay, eye.y) - ay;
  const bz = eye.z - az;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 0 ? ((p.x - ax) * bx + (p.y - ay) * by + (p.z - az) * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.max(0, Math.hypot(p.x - (ax + bx * t), p.y - (ay + by * t), p.z - (az + bz * t)) - radius);
}

// ---------------------------------------------------------------------------
// Beams
// ---------------------------------------------------------------------------

/**
 * Is a body (bounds sphere) inside a cone beam from `eye` along unit `fwd`? `tanHalf` = tan of the
 * cone half-angle; the body counts when its center is within the cone widened by
 * `boundsFactor × radius`. Returns the distance along the axis, or -1 outside (or beyond `range`).
 */
export function coneReach(
  eye: Vec3Like,
  fwd: Vec3Like,
  tanHalf: number,
  range: number,
  center: Vec3Like,
  radius: number,
  boundsFactor: number,
): number {
  const vx = center.x - eye.x;
  const vy = center.y - eye.y;
  const vz = center.z - eye.z;
  const along = vx * fwd.x + vy * fwd.y + vz * fwd.z;
  if (!(along > 0) || along > range + radius) return -1;
  const px = vx - fwd.x * along;
  const py = vy - fwd.y * along;
  const pz = vz - fwd.z * along;
  const perp = Math.hypot(px, py, pz);
  return perp <= along * tanHalf + radius * boundsFactor ? along : -1;
}

/**
 * Magazine ammo drained by a beam over `dt` at `perSecond`, carrying the fraction: returns the
 * whole rounds to take now; `acc` (the carried fraction) is read from and written to `state.acc`.
 */
export function beamAmmoStep(state: { acc: number }, perSecond: number, dt: number): number {
  if (!(perSecond > 0) || !(dt > 0)) return 0;
  state.acc += perSecond * dt;
  const take = Math.floor(state.acc);
  state.acc -= take;
  return take;
}

// ---------------------------------------------------------------------------
// Split shots, bounces, homing
// ---------------------------------------------------------------------------

/**
 * Horizontal fan offset (radians) of extra ray `k` (1-based) of a split shot: alternating right /
 * left, one `angle` step further out every second ray (k = 1 → +a, 2 → −a, 3 → +2a …).
 */
export function splitYawOffset(k: number, angleRad: number): number {
  const step = Math.ceil(k / 2);
  return (k % 2 === 1 ? 1 : -1) * step * angleRad;
}

/** Rotate unit `fwd` by `yaw` radians about unit `up` (Rodrigues; for a fan in the view plane). */
export function yawAround<T extends Vec3Like>(fwd: Vec3Like, up: Vec3Like, yaw: number, out: T): T {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // up × fwd
  const cx = up.y * fwd.z - up.z * fwd.y;
  const cy = up.z * fwd.x - up.x * fwd.z;
  const cz = up.x * fwd.y - up.y * fwd.x;
  const d = up.x * fwd.x + up.y * fwd.y + up.z * fwd.z;
  const x = fwd.x * c + cx * s + up.x * d * (1 - c);
  const y = fwd.y * c + cy * s + up.y * d * (1 - c);
  const z = fwd.z * c + cz * s + up.z * d * (1 - c);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * Bounce velocity `v` off a surface with unit normal `n`: the normal part is reflected and scaled
 * by `restitution`, the tangential part by `restitution` blended towards 1 by `tangentKeep` (a
 * grenade skidding along the floor keeps more speed than one hitting a wall head on).
 */
export function bounceVelocity<T extends Vec3Like>(
  v: Vec3Like,
  n: Vec3Like,
  restitution: number,
  tangentKeep: number,
  out: T,
): T {
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  const tx = v.x - n.x * vn;
  const ty = v.y - n.y * vn;
  const tz = v.z - n.z * vn;
  const r = Math.max(0, Math.min(1, restitution));
  const kt = r + (1 - r) * Math.max(0, Math.min(1, tangentKeep));
  const kn = vn < 0 ? -vn * r : vn * r;
  out.x = tx * kt + n.x * kn;
  out.y = ty * kt + n.y * kn;
  out.z = tz * kt + n.z * kn;
  return out;
}

/**
 * Turn velocity `v` towards unit direction `to` by at most `maxAngle` radians, keeping its speed
 * (homing). Writes into `out`; returns the angle turned.
 */
export function turnTowards<T extends Vec3Like>(v: Vec3Like, to: Vec3Like, maxAngle: number, out: T): number {
  const speed = Math.hypot(v.x, v.y, v.z);
  if (!(speed > 1e-9) || !(maxAngle > 0)) {
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return 0;
  }
  const fx = v.x / speed;
  const fy = v.y / speed;
  const fz = v.z / speed;
  const cos = Math.max(-1, Math.min(1, fx * to.x + fy * to.y + fz * to.z));
  const angle = Math.acos(cos);
  if (angle <= maxAngle) {
    out.x = to.x * speed;
    out.y = to.y * speed;
    out.z = to.z * speed;
    return angle;
  }
  // Slerp by maxAngle / angle.
  const t = maxAngle / angle;
  const sin = Math.sin(angle);
  if (!(sin > 1e-6)) {
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return 0;
  }
  const a = Math.sin((1 - t) * angle) / sin;
  const b = Math.sin(t * angle) / sin;
  const x = fx * a + to.x * b;
  const y = fy * a + to.y * b;
  const z = fz * a + to.z * b;
  const len = Math.hypot(x, y, z) || 1;
  out.x = (x / len) * speed;
  out.y = (y / len) * speed;
  out.z = (z / len) * speed;
  return maxAngle;
}

/**
 * Homing score of a target point for a projectile at `p` flying along unit `dir`: the distance of
 * the point from the flight line (lower = better), or -1 when it is behind, out of `range` or
 * outside the cone (`cosCone`).
 */
export function homingScore(p: Vec3Like, dir: Vec3Like, target: Vec3Like, range: number, cosCone: number): number {
  const vx = target.x - p.x;
  const vy = target.y - p.y;
  const vz = target.z - p.z;
  const dist = Math.hypot(vx, vy, vz);
  if (!(dist > 1e-6) || dist > range) return -1;
  const along = vx * dir.x + vy * dir.y + vz * dir.z;
  if (along / dist < cosCone) return -1;
  return Math.hypot(vx - dir.x * along, vy - dir.y * along, vz - dir.z * along);
}

/** Smoothstep ease 0..1 of the drawn projectile's convergence (1 = still at the muzzle offset). */
export function convergeWeight(age: number, convergeTime: number): number {
  if (!(convergeTime > 0) || age >= convergeTime) return 0;
  const t = 1 - Math.max(0, age) / convergeTime;
  return t * t * (3 - 2 * t);
}
