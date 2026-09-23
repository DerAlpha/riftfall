/**
 * Pure spread math: stance/movement modifiers, per-shot bloom + recovery, and cone sampling.
 * Angles in degrees unless the name says Rad.
 */
import type { Vec3Like } from '../core/events';
import { clamp, clamp01, lerp } from '../core/math';
import { WEAPON_RULES, type WeaponSpreadDef } from '../defs/weapons';

export interface SpreadContext {
  /** 0..1 ADS blend. */
  ads: number;
  /** Horizontal speed / run speed (clamped internally). */
  speedFactor: number;
  airborne: boolean;
  crouched: boolean;
}

export interface SpreadRules {
  readonly adsBloomMultiplier: number;
  readonly adsStateSpreadMultiplier: number;
  readonly maxMoveSpreadFactor: number;
}

/**
 * Current cone half-angle (deg) including bloom. Aiming scales the accumulated bloom when it is
 * read (not when it is added), so a long aimed burst stays steadier than a hip spray and
 * snapping to ADS after a spray tightens the cone at once.
 */
export function spreadDeg(
  def: WeaponSpreadDef,
  ctx: SpreadContext,
  bloom: number,
  rules: SpreadRules = WEAPON_RULES,
): number {
  const ads = clamp01(ctx.ads);
  let base = lerp(def.hip, def.ads, ads);
  if (ctx.crouched) base *= def.crouchMultiplier;
  const stateScale = lerp(1, rules.adsStateSpreadMultiplier, ads);
  const speed = Number.isFinite(ctx.speedFactor) ? clamp(ctx.speedFactor, 0, rules.maxMoveSpreadFactor) : 0;
  const move = def.moveAdd * speed * stateScale;
  const air = ctx.airborne ? def.airAdd * stateScale : 0;
  const bloomed = Math.max(0, bloom) * lerp(1, rules.adsBloomMultiplier, ads);
  return Math.max(0, base + move + air + bloomed);
}

/** Bloom after one shot, capped at bloomMax. */
export function addBloom(bloom: number, def: WeaponSpreadDef): number {
  return Math.min(def.bloomMax, Math.max(0, bloom) + def.perShotBloom);
}

/**
 * Linear bloom recovery for a step of `dt` seconds that ends `sinceShot` seconds after the last
 * shot: only the part of the step past `def.recoveryDelay` recovers (Infinity = no delay).
 */
export function recoverBloom(bloom: number, def: WeaponSpreadDef, dt: number, sinceShot = Infinity): number {
  const active = Math.min(dt, sinceShot - def.recoveryDelay);
  if (!(active > 0)) return Math.max(0, bloom);
  return Math.max(0, bloom - def.recoveryPerSec * active);
}

/** Crosshair spread 0..1 for a cone half-angle. */
export function crosshairSpread(spreadDegrees: number, maxDeg: number): number {
  return maxDeg > 0 ? clamp01(spreadDegrees / maxDeg) : 0;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Uniform point in the unit disk from two uniforms in [0, 1). */
export function diskSample(u1: number, u2: number, out: Vec2): Vec2 {
  const r = Math.sqrt(clamp01(u1));
  const a = 2 * Math.PI * u2;
  out.x = r * Math.cos(a);
  out.y = r * Math.sin(a);
  return out;
}

export interface PelletPatternRules {
  readonly ringRadius: number;
  readonly innerRingRadius: number;
  readonly outerRingMax: number;
  readonly jitter: number;
}

/**
 * Pellet position in the unit disk: pellet 0 in the center, then an evenly spaced outer ring
 * (at most `outerRingMax`), the rest on an inner ring. `rotation` (rad) turns the whole pattern,
 * `jx/jy` in [-1, 1] jitter each pellet by `rules.jitter`. A readable, consistent pattern beats
 * pure noise for a shotgun (a clean hit at close range is never unlucky).
 */
export function pelletOffset(
  index: number,
  count: number,
  rotation: number,
  jx: number,
  jy: number,
  rules: PelletPatternRules,
  out: Vec2,
): Vec2 {
  let x = 0;
  let y = 0;
  if (index > 0 && count > 1) {
    const ring = Math.min(count - 1, rules.outerRingMax);
    let radius = rules.ringRadius;
    let slot = index - 1;
    let slots = ring;
    // The inner ring sits half a slot rotated so its pellets fill the outer ring's gaps.
    let phase = 0;
    if (slot >= ring) {
      slot -= ring;
      slots = Math.max(1, count - 1 - ring);
      radius = rules.innerRingRadius;
      phase = Math.PI / slots;
    }
    const a = rotation + phase + (2 * Math.PI * slot) / slots;
    x = Math.cos(a) * radius;
    y = Math.sin(a) * radius;
  }
  x += jx * rules.jitter;
  y += jy * rules.jitter;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  out.x = x;
  out.y = y;
  return out;
}

/**
 * Direction inside a cone around `forward` (unit): offset (unit-disk coordinates along `right`
 * and `up`) scaled by tan(spread). Writes a normalized direction into `out`.
 */
export function coneDirection<T extends Vec3Like>(
  forward: Vec3Like,
  right: Vec3Like,
  up: Vec3Like,
  ox: number,
  oy: number,
  spreadRad: number,
  out: T,
): T {
  const t = Math.tan(clamp(spreadRad, 0, Math.PI / 2 - 1e-3));
  const x = forward.x + (right.x * ox + up.x * oy) * t;
  const y = forward.y + (right.y * ox + up.y * oy) * t;
  const z = forward.z + (right.z * ox + up.z * oy) * t;
  const len = Math.hypot(x, y, z);
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

/**
 * Aim basis from yaw/pitch (three.js convention: yaw 0 looks down -Z, positive yaw turns left,
 * positive pitch looks up). Writes unit forward/right/up.
 */
export function aimBasis(yaw: number, pitch: number, forward: Vec3Like, right: Vec3Like, up: Vec3Like): void {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  forward.x = -sy * cp;
  forward.y = sp;
  forward.z = -cy * cp;
  right.x = cy;
  right.y = 0;
  right.z = -sy;
  // up = right × forward
  up.x = sy * sp;
  up.y = cp;
  up.z = cy * sp;
}
