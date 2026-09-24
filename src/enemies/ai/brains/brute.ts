/**
 * Brute brain (tank): slow, relentless approach; a telegraphed charge down a clear straight lane
 * (checked with nav.walkable every `laneCheckInterval`), slam / swipe when close. Melee needs a
 * token of the type's pool (heavy: one tank at a time): holders close in to `standoff`, the others
 * keep to `waitRadius` – inside the charge range, so waiting tanks keep charging instead of walling
 * the player in. Runs only when far away.
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import { ENEMY_AI, type EnemyAttackDef } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { pickAttack } from '../attacks';
import { distXZ } from '../attackMath';
import type { AiHost, EnemyBrain } from '../types';

const _p = new Vector3();

/** Charges need a clear lane. */
function laneFilter(e: Enemy, a: EnemyAttackDef): boolean {
  return a.kind !== 'charge' || e.laneClear;
}

export const bruteBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
    const B = e.def.brute;
    if (!B) return;
    const now = host.time;
    const dist = distXZ(e.position, target.position);
    const coord = host.coordinator(e);

    let holds = false;
    const holding = coord.holds(e.id);
    const level = Math.abs(target.position.y - e.position.y) <= ENEMY_AI.slots.engageHeight;
    if (level && (dist <= B.engageDistance || (holding && dist <= ENEMY_AI.slots.releaseDistance))) {
      holds = coord.request(e.id, e.def.slotCost, now);
    } else if (holding) {
      coord.release(e.id, now);
    }

    if (now >= e.laneCheckAt) {
      e.laneCheckAt = now + B.laneCheckInterval;
      e.laneClear = host.nav.walkable(e.position, target.position);
    }

    const idx = pickAttack(e, host, dist, target, laneFilter);
    if (idx >= 0) {
      host.beginAttack(e, idx);
      return;
    }

    // Token holders close in to the standoff; the others keep to the wait ring (backing off, eyes
    // on the target, after a charge carried them close) – from there they charge again.
    const dx = e.position.x - target.position.x;
    const dz = e.position.z - target.position.z;
    const len = Math.hypot(dx, dz);
    if (holds ? len <= B.standoff : Math.abs(len - B.waitRadius) <= B.waitSlack) {
      host.stopMoving(e);
      return;
    }
    const radius = holds ? B.standoff : B.waitRadius;
    if (!holds) e.faceTarget = true;
    const k = len > 1e-3 ? radius / len : 0;
    _p.set(target.position.x + dx * k, target.position.y, target.position.z + dz * k);
    const run = holds || dist > B.runDistance;
    host.moveTo(e, _p, run ? e.def.movement.runSpeed : e.def.movement.walkSpeed);
  },

  resume(e: Enemy): void {
    e.laneCheckAt = 0;
  },

  release(): void {},
};
