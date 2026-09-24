/**
 * Ring / stand-off points around a target sit at the target's height. On a deck (the lab's atrium
 * ring, platforms) many of them lie in the air beside it: the navmesh snaps them to the hall below
 * or to nothing at all, and an enemy sent there waits on the wrong floor – or keeps an old goal and
 * freezes – instead of taking the stairs. Brains check their goal here and follow the target
 * itself when it is not on the target's floor.
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../core/contracts';
import { ENEMY_AI } from '../../defs/enemies';
import type { Enemy } from '../Enemy';
import type { AiHost } from './types';

const _snap = new Vector3();

/**
 * Does `goal` snap to the navmesh on the target's floor (within ENEMY_AI.slots.engageHeight of its
 * feet)? One navmesh query, cached per enemy until the goal moves more than
 * ENEMY_AI.movement.goalRecheckDistance.
 */
export function goalOnTargetFloor(e: Enemy, host: AiHost, target: EnemyTargetApi, goal: Vector3): boolean {
  const r = ENEMY_AI.movement.goalRecheckDistance;
  if (e.goalChecked && e.goalCheck.distanceToSquared(goal) <= r * r) return e.goalOk;
  e.goalCheck.copy(goal);
  e.goalChecked = true;
  e.goalOk =
    host.nav.closestPoint(goal, _snap) &&
    Math.abs(_snap.y - target.position.y) <= ENEMY_AI.slots.engageHeight;
  return e.goalOk;
}
