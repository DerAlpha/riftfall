/**
 * Support brain (M6: Heiler, Beschwörer). Never fights at the front:
 *
 *   1. cornered   a contact attack (melee) when the target stands right at it,
 *   2. flee       the target within fleeDistance: nav steps of fleeStep m away from it (straight
 *                 away first, then fanning out ±fleeArcDeg – the first walkable one),
 *   3. support    heal beams (a tethered ally, attackKinds/beam healTargetReady) and summons
 *                 (attackKinds/summon summonReady, near a rift) start when ready – highest priority
 *                 first, no attack spacing (they do not hurt the target),
 *   4. position   hang back behind the pack: the spot `packBehind` m behind the centroid of the
 *                 allies near the target, inside the distance band; without a pack at the band's
 *                 preferred distance along the current bearing. Summoners walk to a rift
 *                 (spawn point) `riftLead` s before a summon is ready and channel there.
 *
 * Re-planned every `replanInterval` s (staggered), so a healer drifts with its pack instead of
 * jittering; the positioning is O(enemies) per re-plan, the flee a few nav rays per step.
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import { DEG2RAD } from '../../../core/math';
import type { EnemyAttackDef, SupportBehaviourDef } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { pickAttack, type AttackFilter } from '../attacks';
import { distXZ } from '../attackMath';
import { healTargetReady } from '../attackKinds/beam';
import { summonReady } from '../attackKinds/summon';
import { fleeDirection, nearestRift, packCentroid, spotBehind } from '../supportMath';
import type { AiHost, EnemyBrain } from '../types';

/** Brain modes (Enemy.mode). */
export const SUPPORT_FOLLOW = 0;
export const SUPPORT_FLEE = 1;
export const SUPPORT_RIFT = 2;

const SUPPORT_BRAIN = 'support';
/** Re-plan jitter: ± this fraction of the interval (staggers a group of healers). */
const REPLAN_JITTER = 0.25;

const _c = new Vector3();
const _anchor = new Vector3();
const _dir = { x: 0, y: 0, z: 0 };

/** Cornered: only contact blows (the support attacks start below, on their own conditions). */
const contactOnly: AttackFilter = (_e, a) => a.kind === 'melee';

function setMode(e: Enemy, mode: number, host: AiHost): void {
  e.mode = mode;
  e.modeTime = host.time;
}

/** A support attack (heal beam / summon) whose own conditions hold now, or -1. */
function pickSupport(e: Enemy, host: AiHost, dist: number, S: SupportBehaviourDef): number {
  const attacks = e.def.attacks;
  let best = -1;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < attacks.length; i++) {
    const a = attacks[i]!;
    if (a.priority <= bestPriority || host.time < e.attackReady[i]!) continue;
    if (dist < a.minRange || dist > a.range) continue;
    if (!supportUsable(e, host, a, S)) continue;
    best = i;
    bestPriority = a.priority;
  }
  return best;
}

function supportUsable(e: Enemy, host: AiHost, a: EnemyAttackDef, S: SupportBehaviourDef): boolean {
  if (a.kind === 'beam' && a.beam?.heal) return healTargetReady(e, host, a);
  if (a.kind === 'summon' && a.summon) {
    if (!summonReady(e, host, a)) return false;
    // Rift seekers channel once they reached their rift (or gave up on it).
    return e.mode !== SUPPORT_RIFT || riftArrived(e, host, S);
  }
  return false;
}

function riftArrived(e: Enemy, host: AiHost, S: SupportBehaviourDef): boolean {
  return (
    !e.spotValid || distXZ(e.position, e.spot) <= S.arriveDistance || host.time - e.modeTime > S.riftTimeout
  );
}

/** Soonest ready time of the enemy's summon attacks (+∞ without one). */
function summonReadyAt(e: Enemy): number {
  let t = Number.POSITIVE_INFINITY;
  const attacks = e.def.attacks;
  for (let i = 0; i < attacks.length; i++) {
    if (attacks[i]!.kind === 'summon') t = Math.min(t, e.attackReady[i]!);
  }
  return t;
}

/** One flee step: the first walkable direction away from the target (else stand – cornered). */
function planFlee(e: Enemy, host: AiHost, target: EnemyTargetApi, S: SupportBehaviourDef): void {
  setMode(e, SUPPORT_FLEE, host);
  e.nextActionTime = host.time + S.fleeReplan;
  let ax = e.position.x - target.position.x;
  let az = e.position.z - target.position.z;
  const len = Math.hypot(ax, az);
  if (len > 1e-3) {
    ax /= len;
    az /= len;
  } else {
    ax = -Math.sin(e.yaw);
    az = -Math.cos(e.yaw);
  }
  const arc = S.fleeArcDeg * DEG2RAD;
  for (let k = 0; k < S.fleeTries; k++) {
    fleeDirection(ax, az, k, arc, _dir);
    _c.set(e.position.x + _dir.x * S.fleeStep, e.position.y, e.position.z + _dir.z * S.fleeStep);
    if (host.nav.walkable(e.position, _c) && host.nav.closestPoint(_c, e.spot)) {
      e.spotValid = true;
      return;
    }
  }
  e.spot.copy(e.position);
  e.spotValid = false;
}

/** The hang-back spot (or the rift spot of a summoner about to channel). */
function planSpot(e: Enemy, host: AiHost, target: EnemyTargetApi, S: SupportBehaviourDef): void {
  const now = host.time;
  e.nextActionTime = now + S.replanInterval * (1 + (host.rng.next() * 2 - 1) * REPLAN_JITTER);
  const rifts = host.riftPoints;
  if (S.riftLead > 0 && rifts && rifts.length > 0 && now >= summonReadyAt(e) - S.riftLead) {
    if (e.mode === SUPPORT_RIFT) return;
    const i = nearestRift(e.position, target.position, rifts, S.riftSearch, S.bandMin);
    if (i >= 0) {
      const p = rifts[i]!.position;
      // A few meters in front of the rift, towards the target (never into a sealed pen).
      let dx = target.position.x - p.x;
      let dz = target.position.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-3) {
        dx /= len;
        dz /= len;
      }
      _c.set(p.x + dx * S.riftStandoff, p.y, p.z + dz * S.riftStandoff);
      if (host.nav.closestPoint(_c, e.spot)) {
        e.spotValid = true;
        setMode(e, SUPPORT_RIFT, host);
        return;
      }
    }
  } else if (e.mode === SUPPORT_RIFT && now < summonReadyAt(e) - S.riftLead) {
    setMode(e, SUPPORT_FOLLOW, host);
  }
  if (e.mode === SUPPORT_RIFT) return;
  setMode(e, SUPPORT_FOLLOW, host);
  const n = packCentroid(e, host.enemies, target.position, S.packRadius, SUPPORT_BRAIN, _anchor);
  if (n > 0) {
    spotBehind(_anchor, target.position, S.packBehind, S.bandMin, S.bandMax, e.position, _c);
  } else {
    spotBehind(e.position, target.position, S.bandPreferred - distXZ(e.position, target.position), S.bandMin, S.bandMax, e.position, _c);
  }
  _c.y = e.position.y;
  e.spotValid = host.nav.closestPoint(_c, e.spot);
}

export const supportBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
    const S = e.def.support;
    if (!S) return;
    const now = host.time;
    const dist = distXZ(e.position, target.position);

    // 1. Cornered: a contact blow.
    const melee = pickAttack(e, host, dist, target, contactOnly);
    if (melee >= 0) {
      host.beginAttack(e, melee);
      return;
    }

    // 2. Flee.
    if (dist < S.fleeDistance) {
      if (e.mode !== SUPPORT_FLEE || now >= e.nextActionTime || distXZ(e.position, e.spot) <= S.arriveDistance) {
        planFlee(e, host, target, S);
      }
      if (e.spotValid) host.moveTo(e, e.spot, e.def.movement.runSpeed);
      else host.stopMoving(e);
      return;
    }
    if (e.mode === SUPPORT_FLEE) {
      setMode(e, SUPPORT_FOLLOW, host);
      e.nextActionTime = now;
    }

    // 3. Support attacks.
    const idx = pickSupport(e, host, dist, S);
    if (idx >= 0) {
      host.beginAttack(e, idx);
      return;
    }

    // 4. Hang back behind the pack / walk to the rift.
    if (now >= e.nextActionTime || !e.spotValid) planSpot(e, host, target, S);
    if (!e.spotValid) {
      host.stopMoving(e);
      return;
    }
    const d = distXZ(e.position, e.spot);
    if (d > S.arriveDistance) {
      host.moveTo(e, e.spot, d > S.runDistance ? e.def.movement.runSpeed : e.def.movement.walkSpeed);
      // Adjusting nearby: keep an eye on the target (backing off instead of turning away).
      e.faceTarget = d <= S.runDistance;
    } else {
      host.stopMoving(e);
      e.faceTarget = true;
    }
  },

  resume(e: Enemy, host: AiHost): void {
    // After an attack / stagger: re-plan at once (the pack moved on meanwhile).
    e.nextActionTime = host.time;
    if (e.mode === SUPPORT_FLEE) setMode(e, SUPPORT_FOLLOW, host);
  },

  release(e: Enemy): void {
    e.spotValid = false;
    e.mode = SUPPORT_FOLLOW;
  },
};
