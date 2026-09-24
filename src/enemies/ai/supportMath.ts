/**
 * Positioning math of the M6 support brain (pure, allocation-free): the pack an enemy hangs back
 * behind, the spot behind it inside a distance band to the target, flee directions, rift choice.
 */
import type { Vec3Like } from '../../core/events';

/** Minimal views of enemies / targets (tests pass plain objects). */
export interface PackMember {
  readonly position: Vec3Like;
  readonly alive: boolean;
  readonly state: string;
  readonly def: { readonly brain: string };
}

export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/**
 * Centroid of the pack into `out`: living, active allies (not `self`, not other support types)
 * within `radius` (XZ) of the target. Returns the member count (0: `out` untouched).
 */
export function packCentroid(
  self: PackMember,
  enemies: readonly PackMember[],
  target: Vec3Like,
  radius: number,
  supportBrain: string,
  out: Vec3Out,
): number {
  const r2 = radius * radius;
  let n = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < enemies.length; i++) {
    const o = enemies[i]!;
    if (o === self || !o.alive || o.def.brain === supportBrain) continue;
    if (o.state !== 'active' && o.state !== 'attack' && o.state !== 'stagger') continue;
    const dx = o.position.x - target.x;
    const dz = o.position.z - target.z;
    if (dx * dx + dz * dz > r2) continue;
    x += o.position.x;
    y += o.position.y;
    z += o.position.z;
    n++;
  }
  if (n > 0) {
    out.x = x / n;
    out.y = y / n;
    out.z = z / n;
  }
  return n;
}

/**
 * The spot behind `anchor` (the pack centroid, or the enemy itself without a pack) as seen from
 * the target: on the ray target → anchor, `behind` m past the anchor, its distance to the target
 * clamped to [bandMin, bandMax]. `fallback` gives the direction when the anchor sits on the target.
 */
export function spotBehind(
  anchor: Vec3Like,
  target: Vec3Like,
  behind: number,
  bandMin: number,
  bandMax: number,
  fallback: Vec3Like,
  out: Vec3Out,
): Vec3Out {
  let dx = anchor.x - target.x;
  let dz = anchor.z - target.z;
  let d = Math.hypot(dx, dz);
  if (d < 1e-3) {
    dx = fallback.x - target.x;
    dz = fallback.z - target.z;
    const f = Math.hypot(dx, dz);
    if (f < 1e-3) {
      dx = 1;
      dz = 0;
    } else {
      dx /= f;
      dz /= f;
    }
    d = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  const r = Math.min(bandMax, Math.max(bandMin, d + behind));
  out.x = target.x + dx * r;
  out.y = anchor.y;
  out.z = target.z + dz * r;
  return out;
}

/**
 * Flee direction k (0 = straight away from the target, then ±arc, ±2·arc, … alternating) as a
 * unit XZ vector into `out` (y = 0). `awayX/awayZ`: unit vector from the target to the enemy.
 */
export function fleeDirection(
  awayX: number,
  awayZ: number,
  k: number,
  arcRad: number,
  out: Vec3Out,
): Vec3Out {
  const step = Math.ceil(k / 2);
  const side = k % 2 === 1 ? 1 : -1;
  const a = k === 0 ? 0 : side * step * arcRad;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = awayX * c - awayZ * s;
  out.y = 0;
  out.z = awayX * s + awayZ * c;
  return out;
}

/**
 * Index of the rift (spawn point) a summoner walks to: the nearest to `self` within `search` m
 * whose distance to the target is at least `minFromTarget` m; -1 when none qualifies.
 */
export function nearestRift(
  self: Vec3Like,
  target: Vec3Like,
  rifts: readonly { readonly position: Vec3Like }[],
  search: number,
  minFromTarget: number,
): number {
  let best = -1;
  let bestD = search;
  for (let i = 0; i < rifts.length; i++) {
    const p = rifts[i]!.position;
    const d = Math.hypot(p.x - self.x, p.z - self.z);
    if (d > bestD) continue;
    if (Math.hypot(p.x - target.x, p.z - target.z) < minFromTarget) continue;
    best = i;
    bestD = d;
  }
  return best;
}
