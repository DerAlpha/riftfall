/**
 * Spawn point scoring and selection (pure; the director supplies visibility and zone checks).
 *
 * In the distance band (SPAWN_POINTS.minDistance..maxDistance from the player's feet, 3D: a rift on
 * the floor below the player is not "next to" them) a point
 * scores −|d − preferred|·distanceWeight − visiblePenalty (if the player can see it) + seeded
 * jitter; the best one wins and the previous point is skipped whenever another one qualifies.
 * Nothing in the band: the active point closest to the band wins (too close weighs more than too
 * far). No active point at all: −1 (the director falls back to a random nav point).
 */
import type { SpawnPointDef } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import type { Rng } from '../core/Rng';
import type { SpawnPointRules } from '../defs/waves';

export interface SpawnSelectContext {
  /** The player's feet. */
  readonly target: Vec3Like;
  /** Index of the point used last (-1 = none). */
  readonly lastIndex: number;
  isZoneActive(zone: string): boolean;
  /** Can the player see the point? Only asked for points inside the distance band. */
  isVisible(point: SpawnPointDef, index: number): boolean;
}

export function spawnDistance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function inSpawnBand(distance: number, rules: SpawnPointRules): boolean {
  return distance >= rules.minDistance && distance <= rules.maxDistance;
}

/** Score of a point in the band (−Infinity outside). `jitter01` is a [0, 1) random number. */
export function spawnPointScore(
  distance: number,
  visible: boolean,
  rules: SpawnPointRules,
  jitter01: number,
): number {
  if (!inSpawnBand(distance, rules)) return Number.NEGATIVE_INFINITY;
  return (
    -Math.abs(distance - rules.preferredDistance) * rules.distanceWeight -
    (visible ? rules.visiblePenalty : 0) +
    jitter01 * rules.jitter
  );
}

/** Distance to the band for the relaxed pass (0 inside; too close weighs `tooCloseWeight`×). */
export function bandMiss(distance: number, rules: SpawnPointRules): number {
  if (distance < rules.minDistance) return (rules.minDistance - distance) * rules.tooCloseWeight;
  if (distance > rules.maxDistance) return distance - rules.maxDistance;
  return 0;
}

/** Index of the best spawn point, or -1 when no point is in an active zone. */
export function selectSpawnPoint(
  points: readonly SpawnPointDef[],
  ctx: SpawnSelectContext,
  rules: SpawnPointRules,
  rng: Rng,
): number {
  let inBand = 0;
  let active = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!ctx.isZoneActive(p.zone)) continue;
    active++;
    if (inSpawnBand(spawnDistance(p.position, ctx.target), rules)) inBand++;
  }
  if (active === 0) return -1;

  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  if (inBand > 0) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (!ctx.isZoneActive(p.zone)) continue;
      const d = spawnDistance(p.position, ctx.target);
      if (!inSpawnBand(d, rules)) continue;
      if (i === ctx.lastIndex && inBand > 1) continue;
      const score = spawnPointScore(d, ctx.isVisible(p, i), rules, rng.next());
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  // Relaxed: nothing in the band – the point closest to it.
  let bestMiss = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!ctx.isZoneActive(p.zone)) continue;
    if (i === ctx.lastIndex && active > 1) continue;
    const miss = bandMiss(spawnDistance(p.position, ctx.target), rules);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = i;
    }
  }
  return best;
}
