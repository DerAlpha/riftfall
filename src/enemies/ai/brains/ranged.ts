/**
 * Ranged brain (spitter): keeps a distance band, fires only with line of sight (from its mouth
 * socket to the player's eye), repositions when it lost sight or left the band, strafes between
 * shots, swipes when cornered.
 *
 * Spot search (spread over ticks by the host's spot-ray budget): candidates around the target at
 * `bandPreferred`, spread over ±searchArc around the current bearing and jittered with
 * nav.randomPointAround; each costs 3 static rays (LOS to the target eye + two lateral cover probes)
 * and is scored by rangedPositioning.scoreSpot (sight, cover, band, travel, crowding).
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import { DEG2RAD } from '../../../core/math';
import { ENEMY_AI } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { pickAttack } from '../attacks';
import { distXZ } from '../attackMath';
import { candidateBearing, inBand, scoreSpot, type SpotInput } from '../rangedPositioning';
import type { AiHost, EnemyBrain } from '../types';

/** Brain modes (Enemy.mode). */
export const RANGED_HOLD = 0;
export const RANGED_SEARCH = 1;
export const RANGED_MOVE = 2;
export const RANGED_STRAFE = 3;

/** Rays one candidate costs (LOS + 2 cover probes). */
const RAYS_PER_SPOT = 3;

const _c = new Vector3();
const _eye = new Vector3();
const _probe = new Vector3();
const _spot: SpotInput = { los: false, cover: 0, travel: 0, distance: 0, crowd: 0 };

function setMode(e: Enemy, mode: number, host: AiHost): void {
  e.mode = mode;
  e.modeTime = host.time;
}

function startSearch(e: Enemy, host: AiHost): void {
  setMode(e, RANGED_SEARCH, host);
  e.searchIndex = 0;
  e.spotBest = Number.NEGATIVE_INFINITY;
  e.spotValid = false;
}

/** Evaluate candidates while the spot-ray budget lasts. True when the search is complete. */
function stepSearch(e: Enemy, host: AiHost, target: EnemyTargetApi): boolean {
  const R = e.def.ranged!;
  const n = Math.max(1, R.searchCandidates);
  const bearing = Math.atan2(e.position.z - target.position.z, e.position.x - target.position.x);
  const eyeH = e.def.perception.eyeHeight * e.pose.scale;
  while (e.searchIndex < n) {
    if (!host.takeSpotRays(RAYS_PER_SPOT)) return false;
    const b = candidateBearing(bearing, e.searchIndex, n, R.searchArcDeg * DEG2RAD);
    e.searchIndex++;
    _c.set(
      target.position.x + Math.cos(b) * R.bandPreferred,
      target.position.y,
      target.position.z + Math.sin(b) * R.bandPreferred,
    );
    if (!host.nav.randomPointAround(_c, R.searchJitter, e.spotCandidate)) {
      if (!host.nav.closestPoint(_c, e.spotCandidate)) continue;
    }
    const cand = e.spotCandidate;
    _eye.set(cand.x, cand.y + eyeH, cand.z);
    _spot.los = host.combat.lineOfSight(_eye, target.eyePosition);
    // Cover: walls right next to the spot, perpendicular to the line of fire.
    let dx = target.position.x - cand.x;
    let dz = target.position.z - cand.z;
    const len = Math.hypot(dx, dz);
    let cover = 0;
    if (len > 1e-3) {
      dx /= len;
      dz /= len;
      _probe.set(_eye.x - dz * R.coverProbe, _eye.y, _eye.z + dx * R.coverProbe);
      if (!host.combat.lineOfSight(_eye, _probe)) cover += 0.5;
      _probe.set(_eye.x + dz * R.coverProbe, _eye.y, _eye.z - dx * R.coverProbe);
      if (!host.combat.lineOfSight(_eye, _probe)) cover += 0.5;
    }
    _spot.cover = cover;
    _spot.travel = distXZ(e.position, cand);
    _spot.distance = len;
    _spot.crowd = crowdAt(e, host, cand, R.crowdRadius);
    const score = scoreSpot(_spot, R.bandPreferred, R.weights);
    if (score > e.spotBest) {
      e.spotBest = score;
      e.spot.copy(cand);
      e.spotValid = true;
    }
  }
  return true;
}

/** Other ranged enemies whose chosen spot (or position) lies within `radius` of p. */
function crowdAt(e: Enemy, host: AiHost, p: Vector3, radius: number): number {
  const r2 = radius * radius;
  let n = 0;
  const list = host.enemies;
  for (let i = 0; i < list.length; i++) {
    const o = list[i]!;
    if (o === e || !o.alive || o.def.brain !== 'ranged') continue;
    const q = o.spotValid ? o.spot : o.position;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    if (dx * dx + dz * dz < r2) n++;
  }
  return n;
}

export const rangedBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
    const R = e.def.ranged;
    if (!R) return;
    const now = host.time;
    const dist = distXZ(e.position, target.position);

    const idx = pickAttack(e, host, dist, target);
    if (idx >= 0) {
      host.beginAttack(e, idx);
      if (e.def.attacks[idx]!.kind === 'projectile') {
        // Strafe soon after the shot.
        e.nextActionTime = now + e.def.attacks[idx]!.recover;
      }
      return;
    }

    const lostSight = !e.canSee && now - e.lastSeenTime > R.losLostTime;
    const outOfBand = !inBand(dist, R.bandMin, R.bandMax);
    switch (e.mode) {
      case RANGED_SEARCH: {
        if (stepSearch(e, host, target)) {
          if (e.spotValid) setMode(e, RANGED_MOVE, host);
          else {
            // Nothing usable (no navmesh around the target?): close in along the path.
            e.spot.copy(target.position);
            e.spotValid = true;
            setMode(e, RANGED_MOVE, host);
          }
        } else if (lostSight) {
          // Keep moving towards where it last knew the target while the search runs.
          host.moveTo(e, e.lastKnown, e.def.movement.runSpeed);
        }
        return;
      }
      case RANGED_MOVE: {
        const d = distXZ(e.position, e.spot);
        // Already a clear shot from here: no need to walk the rest of the way.
        const good = e.canSee && !outOfBand && now - e.losTime <= ENEMY_AI.perception.losMaxAge;
        if (good || d <= R.arriveDistance || now - e.modeTime > R.repositionTimeout) {
          setMode(e, RANGED_HOLD, host);
          host.stopMoving(e);
          e.nextActionTime = now + host.rng.range(R.strafeInterval[0], R.strafeInterval[1]);
          return;
        }
        host.moveTo(e, e.spot, d > R.runDistance ? e.def.movement.runSpeed : e.def.movement.walkSpeed);
        return;
      }
      case RANGED_STRAFE: {
        e.faceTarget = true;
        const d = distXZ(e.position, e.spot);
        if (d <= R.arriveDistance || now - e.modeTime > R.strafeTimeout) {
          setMode(e, RANGED_HOLD, host);
          host.stopMoving(e);
          return;
        }
        host.moveTo(e, e.spot, e.def.movement.walkSpeed);
        return;
      }
      default: {
        e.faceTarget = true;
        if (lostSight || outOfBand) {
          startSearch(e, host);
          return;
        }
        if (now >= e.nextActionTime) {
          e.nextActionTime = now + host.rng.range(R.strafeInterval[0], R.strafeInterval[1]);
          e.strafeSign = -e.strafeSign;
          let dx = target.position.x - e.position.x;
          let dz = target.position.z - e.position.z;
          const len = Math.hypot(dx, dz);
          if (len > 1e-3) {
            dx /= len;
            dz /= len;
            _c.set(
              e.position.x - dz * R.strafeDistance * e.strafeSign,
              e.position.y,
              e.position.z + dx * R.strafeDistance * e.strafeSign,
            );
            if (host.nav.walkable(e.position, _c) && host.nav.closestPoint(_c, e.spot)) {
              e.spotValid = true;
              setMode(e, RANGED_STRAFE, host);
              host.moveTo(e, e.spot, e.def.movement.walkSpeed);
              return;
            }
          }
        }
        host.stopMoving(e);
      }
    }
  },

  resume(): void {},

  release(e: Enemy): void {
    e.spotValid = false;
  },
};
