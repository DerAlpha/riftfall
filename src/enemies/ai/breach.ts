/**
 * M4 rift seals, enemy side: an enemy spawned at a sealed spawn point waits at the seal and tears
 * it down before it enters ('breach' state, EnemyManager):
 *
 *   spawn     the spawn position is pulled into the pen behind the seal (EnemyBreachApi.confine)
 *   emerge    as usual; at its end the manager enters 'breach' while segments are left
 *   breach    the enemy holds its spot (MoveOverride 'hold': the nav agent stays parked), turns to
 *             the seal and swings at it with one of its attack animations; every finished tear
 *             (EnemyBreachDef.segmentTime) breaks `segmentsPerTear` segments, the other swings only
 *             flash the seal. Staggers interrupt it (the enemy returns to the seal afterwards).
 *   reach     a target hugging the open side of the seal within the breach attack's range is
 *             swiped through the lattice when that attack is a melee attack (normal 'attack' state;
 *             afterwards the enemy returns to the seal) – repairing under pressure, like CoD windows.
 *   open      no segment left (torn by anyone, or never sealed) → 'active', the brain takes over.
 *             A target standing on the enemy's side of the seal close by frees it as well.
 *
 * The seal owner (src/seals/SealSystem) implements EnemyBreachApi; without one nothing is sealed.
 * Swing timing is fitted to segmentTime: `swingsPerSegment` whole swings per segment, so a segment
 * falls exactly every segmentTime seconds once the enemy is tearing.
 */
import type { Vector3 } from 'three';
import type { Vec3Like } from '../../core/events';
import { DEG2RAD } from '../../core/math';
import { ENEMY_AI, type EnemyBreachDef, type EnemyTypeDef } from '../../defs/enemies';
import type { Enemy } from '../Enemy';
import { attackAnimProgress, turnTowards } from './attackMath';

/** What the enemies need from the seals (SealSystem implements it; fakes in tests). */
export interface EnemyBreachApi {
  /** Segments still standing at the seal of spawn point `spawnPointId` (0: open / no seal). */
  segmentsLeft(spawnPointId: string): number;
  /**
   * Pull a spawn position (feet, before the nav snap) into the pen behind the seal, for a body of
   * `radius` m. False (position unchanged) when the spawn point has no seal.
   */
  confine(spawnPointId: string, position: Vector3, radius: number): boolean;
  /** Signed distance (m) of `p` in front of the seal plane: > 0 on the open (player) side. */
  frontDistance(spawnPointId: string, p: Vec3Like): number;
  /**
   * A tearing swing landed (attacker feet at `from`): `segments` > 0 breaks that many segments,
   * 0 only flashes the seal. Returns the segments left.
   */
  strike(spawnPointId: string, segments: number, from: Vec3Like): number;
}

/** Per-type breach timing (TypeRuntime, built once). */
export interface BreachPlan {
  /** Attack id whose animation the swings play ('' = none) and its EnemyPose.attackId (-1 = none). */
  readonly attackId: string;
  readonly animId: number;
  /** Animation markers (0..1) of that attack: wind-up end, strike end. */
  readonly animWindup: number;
  readonly animStrike: number;
  /** Fitted swing phases (s): the strike lands at the end of the wind-up. */
  readonly windup: number;
  readonly strike: number;
  readonly recover: number;
  readonly swingsPerSegment: number;
  readonly segmentsPerTear: number;
  /** Turn rate towards the seal (rad/s). */
  readonly turnRate: number;
}

/** stepBreach results. */
export const BREACH_TEARING = 0;
/** A new swing starts this tick (telegraph: the manager emits enemy:attack for its sound). */
export const BREACH_SWING = 1;
/** Nothing left to tear: the enemy enters. */
export const BREACH_OPEN = 2;

/** The type's breach def (ENEMY_AI.breach.fallback when it has none). */
export function breachDefOf(def: Pick<EnemyTypeDef, 'breach'>): EnemyBreachDef {
  return def.breach ?? ENEMY_AI.breach.fallback;
}

/**
 * Fit the tearing swings to the segment time. `attackIndex` < 0 (no usable attack): one strike at
 * the end of every segment time, no animation.
 */
export function createBreachPlan(
  def: Pick<EnemyTypeDef, 'breach' | 'attacks'>,
  animIndex: ArrayLike<number>,
  animWindup: ArrayLike<number>,
  animStrike: ArrayLike<number>,
): BreachPlan {
  const b = breachDefOf(def);
  const segmentTime = b.segmentTime > 0 && Number.isFinite(b.segmentTime) ? b.segmentTime : 1;
  const segmentsPerTear = Math.max(1, Math.floor(b.segmentsPerTear || 1));
  const turnRate = ENEMY_AI.breach.turnRateDeg * DEG2RAD;
  let index = -1;
  for (let i = 0; i < def.attacks.length; i++) if (def.attacks[i]!.id === b.attack) index = i;
  const a = index >= 0 ? def.attacks[index]! : null;
  const base = a ? a.windup + a.strike + a.recover : 0;
  if (!a || !(base > 0)) {
    return {
      attackId: '',
      animId: -1,
      animWindup: 1,
      animStrike: 1,
      windup: segmentTime,
      strike: 0,
      recover: 0,
      swingsPerSegment: 1,
      segmentsPerTear,
      turnRate,
    };
  }
  const swings = Math.max(1, Math.round(segmentTime / base));
  const k = segmentTime / (swings * base);
  return {
    attackId: a.id,
    animId: animIndex[index] ?? -1,
    animWindup: animWindup[index] ?? 0,
    animStrike: animStrike[index] ?? 1,
    windup: a.windup * k,
    strike: a.strike * k,
    recover: a.recover * k,
    swingsPerSegment: swings,
    segmentsPerTear,
    turnRate,
  };
}

/** Swing duration of a plan (s). */
export function swingDuration(plan: BreachPlan): number {
  return plan.windup + plan.strike + plan.recover;
}

/** Animation progress (EnemyPose.attack) at `t` seconds into a swing. */
export function breachAnimProgress(plan: BreachPlan, t: number): number {
  if (t < plan.windup) return attackAnimProgress(0, t, plan.windup, plan.animWindup, plan.animStrike);
  const s = t - plan.windup;
  if (s < plan.strike) return attackAnimProgress(1, s, plan.strike, plan.animWindup, plan.animStrike);
  return attackAnimProgress(2, s - plan.strike, plan.recover, plan.animWindup, plan.animStrike);
}

/** Reset the per-enemy breach bookkeeping for a fresh tear (entering the state). */
export function resetBreach(e: Enemy): void {
  e.breachSwing = 0;
  e.breachStruck = false;
  e.breachHits = 0;
}

/**
 * One tick of tearing (enemy time `dt`): turn to the seal, advance the swing, strike at the end of
 * its wind-up (every `swingsPerSegment`-th strike breaks segments). Returns BREACH_*.
 */
export function stepBreach(e: Enemy, plan: BreachPlan, api: EnemyBreachApi, dt: number): number {
  const id = e.breachPoint;
  if (id === null || api.segmentsLeft(id) <= 0) return BREACH_OPEN;
  e.yaw = turnTowards(e.yaw, e.breachYaw, plan.turnRate * dt);
  e.breachSwing += dt;
  if (!e.breachStruck && e.breachSwing >= plan.windup) {
    e.breachStruck = true;
    e.breachHits++;
    let segments = 0;
    if (e.breachHits >= plan.swingsPerSegment) {
      e.breachHits = 0;
      segments = plan.segmentsPerTear;
    }
    if (api.strike(id, segments, e.position) <= 0) return BREACH_OPEN;
  }
  let result = BREACH_TEARING;
  const total = swingDuration(plan);
  if (e.breachSwing >= total) {
    // Never more than one wrap per tick (a huge dt must not skip strikes).
    e.breachSwing = Math.min(e.breachSwing - total, plan.windup);
    e.breachStruck = false;
    result = BREACH_SWING;
  }
  e.pose.attack = plan.animId >= 0 ? breachAnimProgress(plan, e.breachSwing) : 0;
  return result;
}

/**
 * Enemies tearing at the same seal hold their spots (their nav agents are parked, the crowd no
 * longer separates them): ease overlapping bodies apart, then back into the pen. O(enemies).
 */
export function separateAtSeal(e: Enemy, list: readonly Enemy[], api: EnemyBreachApi, dt: number): void {
  const point = e.breachPoint;
  if (point === null) return;
  const r = e.def.nav.radius * e.pose.scale;
  const maxStep = ENEMY_AI.breach.separationSpeed * dt;
  let moved = false;
  for (let i = 0; i < list.length; i++) {
    const o = list[i]!;
    if (o === e || o.state !== 'breach' || o.breachPoint !== point) continue;
    let dx = e.position.x - o.position.x;
    let dz = e.position.z - o.position.z;
    const minD = r + o.def.nav.radius * o.pose.scale;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) continue;
    let d = Math.sqrt(d2);
    if (d < 1e-4) {
      // Exactly on top of each other: split along the seal (deterministic side by spawn order).
      const side = e.serial > o.serial ? 1 : -1;
      dx = Math.cos(e.breachYaw) * side;
      dz = -Math.sin(e.breachYaw) * side;
      d = 1;
    }
    const step = Math.min((minD - Math.sqrt(d2)) * 0.5, maxStep);
    e.position.x += (dx / d) * step;
    e.position.z += (dz / d) * step;
    moved = true;
  }
  if (moved) api.confine(point, e.position, r);
}
