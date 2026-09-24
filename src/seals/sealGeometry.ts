/**
 * Pure placement math of a rift seal (unit-tested, allocation-free after construction).
 *
 * A seal is a vertical plane `offset` m in front of its spawn point, across the emerge direction:
 * forward `f` = the spawn yaw's direction (enemy convention: local +Z = (sin yaw, cos yaw)) points to
 * the open side the player comes from, `s` = (f.z, −f.x) runs along the plane. The pylons stand at
 * u = −left and u = +right (u along s). The pen – where breaching enemies wait – lies behind the
 * plane (negative forward distance), `standOff` + their radius away from it.
 *
 * With a static-world probe the gate is fitted into the room once at build time: narrowed by side
 * walls, lowered under a ceiling, pulled back from a wall in front of the spawn point, the pen
 * limited by the wall behind.
 */
import type { SpawnPointDef } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { SEALS, type SealGateDef } from '../defs/seals';

/** Distance (m) along a unit ray to the first static-world hit, `maxDistance` when none. */
export type SealProbe = (origin: Vec3Like, direction: Vec3Like, maxDistance: number) => number;

export interface SealFrame {
  /** Plane center on the floor (the spawn point's height). */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Forward (open side) and plane axis, unit XZ. */
  readonly fx: number;
  readonly fz: number;
  readonly sx: number;
  readonly sz: number;
  /** Pylon positions along the axis: −left … +right (m). */
  readonly left: number;
  readonly right: number;
  /** Lowest bar band and lattice top above the floor (m). */
  readonly bottom: number;
  readonly height: number;
  /** Pen depth behind the plane (m). */
  readonly penDepth: number;
}

const _o = { x: 0, y: 0, z: 0 };
const _d = { x: 0, y: 0, z: 0 };

function cast(
  probe: SealProbe,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  max: number,
): number {
  _o.x = ox;
  _o.y = oy;
  _o.z = oz;
  _d.x = dx;
  _d.y = dy;
  _d.z = dz;
  const d = probe(_o, _d, max);
  return Number.isFinite(d) && d >= 0 ? Math.min(d, max) : max;
}

/** Gate of a spawn point (fitted into the room when `probe` is given). */
export function buildSealFrame(
  sp: Pick<SpawnPointDef, 'position' | 'yaw'>,
  gate: SealGateDef,
  probe: SealProbe | null = null,
  fit = SEALS.fit,
  pen = SEALS.pen,
): SealFrame {
  const fx = Math.sin(sp.yaw);
  const fz = Math.cos(sp.yaw);
  const sx = fz;
  const sz = -fx;
  const p = sp.position;
  const h = fit.probeHeight;
  let offset = gate.offset;
  let half = gate.width / 2;
  let left = half;
  let right = half;
  let height = gate.height;
  let penDepth: number = pen.depth;
  if (probe) {
    const front = cast(probe, p.x, p.y + h, p.z, fx, 0, fz, offset + fit.frontMargin);
    if (front < offset + fit.frontMargin) offset = Math.max(fit.minOffset, front - fit.frontMargin);
  }
  const cx = p.x + fx * offset;
  const cy = p.y;
  const cz = p.z + fz * offset;
  if (probe) {
    half = Math.max(fit.minHalfWidth, half);
    const r = cast(probe, cx, cy + h, cz, sx, 0, sz, half + fit.wallMargin);
    const l = cast(probe, cx, cy + h, cz, -sx, 0, -sz, half + fit.wallMargin);
    right = Math.min(gate.width / 2, Math.max(fit.minHalfWidth, r - fit.wallMargin));
    left = Math.min(gate.width / 2, Math.max(fit.minHalfWidth, l - fit.wallMargin));
    const up = cast(probe, cx, cy + gate.bottom, cz, 0, 1, 0, height - gate.bottom + fit.ceilingMargin);
    height = Math.min(height, Math.max(fit.minHeight, gate.bottom + up - fit.ceilingMargin));
    penDepth = cast(probe, cx, cy + h, cz, -fx, 0, -fz, pen.depth);
  }
  return {
    cx,
    cy,
    cz,
    fx,
    fz,
    sx,
    sz,
    left,
    right,
    bottom: gate.bottom,
    height: Math.max(gate.bottom, height),
    penDepth,
  };
}

/** Signed distance of `p` in front of the plane (> 0: the open side). */
export function frontDistance(f: SealFrame, p: Vec3Like): number {
  return (p.x - f.cx) * f.fx + (p.z - f.cz) * f.fz;
}

/** Position along the plane axis (u) of `p`. */
export function alongPlane(f: SealFrame, p: Vec3Like): number {
  return (p.x - f.cx) * f.sx + (p.z - f.cz) * f.sz;
}

/**
 * Pull `pos` (feet; Y untouched) into the pen behind the plane for a body of `radius`: between the
 * pylons (`sideMargin` inside) and `standOff`..penDepth behind the plane.
 */
export function confineToPen(f: SealFrame, pos: Vec3Like, radius: number, pen = SEALS.pen): void {
  const r = Math.max(0, Number.isFinite(radius) ? radius : 0);
  let u = alongPlane(f, pos);
  let w = frontDistance(f, pos);
  const uMin = -f.left + r + pen.sideMargin;
  const uMax = f.right - r - pen.sideMargin;
  u = uMin <= uMax ? Math.min(uMax, Math.max(uMin, u)) : (uMin + uMax) / 2;
  const wMax = -(pen.standOff + r);
  const wMin = -(f.penDepth - r);
  w = wMin <= wMax ? Math.min(wMax, Math.max(wMin, w)) : wMax;
  pos.x = f.cx + f.sx * u + f.fx * w;
  pos.z = f.cz + f.sz * u + f.fz * w;
}

/** Height (above the floor) of bar `i` of `n`: the center of its band. */
export function barHeight(f: SealFrame, i: number, n: number): number {
  const band = (f.height - f.bottom) / Math.max(1, n);
  return f.bottom + (i + 0.5) * band;
}

/** Height of one bar band (m). */
export function bandHeight(f: SealFrame, n: number): number {
  return (f.height - f.bottom) / Math.max(1, n);
}

/** World point on the plane at axis position `u` and height `y` above the floor. */
export function planePoint(f: SealFrame, u: number, y: number, out: Vec3Like): Vec3Like {
  out.x = f.cx + f.sx * u;
  out.y = f.cy + y;
  out.z = f.cz + f.sz * u;
  return out;
}
