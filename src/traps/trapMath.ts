/**
 * Pure trap math (tested in traps.test.ts): the activation timer (ready → active → cooldown),
 * segment distances for the fence, turret aiming (yaw / pitch towards a point, rate-limited
 * slewing), the fan's pull cylinder and the flame column test. Allocation-free.
 */
import type { Vec3Like } from '../core/events';
import type { TrapState } from '../defs/traps';

/** ready → start() → active (duration) → cooldown (cooldown) → ready. */
export class TrapTimer {
  private _state: TrapState = 'ready';
  private left = 0;

  constructor(
    public duration: number,
    public cooldown: number,
  ) {}

  get state(): TrapState {
    return this._state;
  }

  /** Seconds left of the active time / cooldown (0 when ready). */
  get remaining(): number {
    return this._state === 'ready' ? 0 : Math.max(0, this.left);
  }

  /** 0..1 progress of the current phase (active: time used; cooldown: recharged). */
  get progress(): number {
    const total = this._state === 'active' ? this.duration : this._state === 'cooldown' ? this.cooldown : 0;
    return total > 0 ? 1 - Math.max(0, this.left) / total : 1;
  }

  start(): boolean {
    if (this._state !== 'ready') return false;
    this._state = 'active';
    this.left = this.duration;
    return true;
  }

  /** Advance; returns the new state when it changed this tick, else null. */
  tick(dt: number): TrapState | null {
    if (this._state === 'ready' || !(dt > 0)) return null;
    this.left -= dt;
    if (this.left > 0) return null;
    if (this._state === 'active') {
      if (this.cooldown > 0) {
        this._state = 'cooldown';
        this.left += this.cooldown;
        if (this.left > 0) return 'cooldown';
      }
    }
    this._state = 'ready';
    this.left = 0;
    return 'ready';
  }

  reset(): void {
    this._state = 'ready';
    this.left = 0;
  }
}

/** Result of segmentDistanceXZ (reused by the caller). */
export interface SegmentHit {
  /** Horizontal distance to the segment. */
  distance: number;
  /** 0..1 position of the closest point along a → b. */
  t: number;
  /** Closest point (x, z). */
  x: number;
  z: number;
}

/** Horizontal distance from (px, pz) to the segment a → b (XZ plane). */
export function segmentDistanceXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  out: SegmentHit,
): SegmentHit {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.t = t;
  out.x = ax + dx * t;
  out.z = az + dz * t;
  out.distance = Math.hypot(px - out.x, pz - out.z);
  return out;
}

/** Aim angles (three.js convention: yaw 0 looks down −Z, positive turns left; pitch + = up). */
export interface Aim {
  yaw: number;
  pitch: number;
}

export function aimAt(from: Vec3Like, to: Vec3Like, out: Aim): Aim {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return out;
}

/** Unit direction of an aim (inverse of aimAt). */
export function aimDirection(yaw: number, pitch: number, out: Vec3Like): Vec3Like {
  const c = Math.cos(pitch);
  out.x = -Math.sin(yaw) * c;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * c;
  return out;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Turn `current` towards `target` by at most `maxStep` (shortest way round). */
export function slewAngle(current: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(current + Math.sign(d) * maxStep);
}

/** Fan pull cylinder test result (reused). */
export interface FanSample {
  /** Distance in front of the rotor plane along the facing (m). */
  axial: number;
  /** Distance from the rotor axis (m). */
  radial: number;
  inside: boolean;
}

/**
 * Is `p` inside the pull cylinder in front of a rotor at `c` facing `n` (unit), `reach` deep and
 * `radius` wide? Points just behind the plane (−0.25 m: bodies pressed against the grille) count.
 */
export function fanSample(
  p: Vec3Like,
  c: Vec3Like,
  n: Vec3Like,
  reach: number,
  radius: number,
  out: FanSample,
): FanSample {
  const rx = p.x - c.x;
  const ry = p.y - c.y;
  const rz = p.z - c.z;
  const axial = rx * n.x + ry * n.y + rz * n.z;
  const qx = rx - n.x * axial;
  const qy = ry - n.y * axial;
  const qz = rz - n.z * axial;
  out.axial = axial;
  out.radial = Math.hypot(qx, qy, qz);
  out.inside = axial >= -0.25 && axial <= reach && out.radial <= radius;
  return out;
}

/** Inside a vertical column (floor center c, radius, height)? */
export function inColumn(p: Vec3Like, c: Vec3Like, radius: number, height: number): boolean {
  if (p.y < c.y - 0.5 || p.y > c.y + height) return false;
  return Math.hypot(p.x - c.x, p.z - c.z) <= radius;
}

/**
 * Flame vent phase `t` s into the active time: every cycle is a pause (its last `warn` s glow as a
 * telegraph), then a burn – the first burst comes after a warning, never at once.
 */
export function flamePhase(t: number, burn: number, pause: number, warn: number): 'warn' | 'burn' | 'pause' {
  const cycle = burn + pause;
  if (!(cycle > 0)) return 'burn';
  const x = t % cycle;
  if (x >= pause) return 'burn';
  return x >= pause - warn ? 'warn' : 'pause';
}
