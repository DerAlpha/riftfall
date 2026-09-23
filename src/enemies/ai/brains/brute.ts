/**
 * Brute brain (tank): slow, relentless approach; a telegraphed charge down a clear straight lane
 * (checked with nav.walkable every `laneCheckInterval`), slam / swipe when close (melee tokens, the
 * tank costs `slotCost` of them). Runs only when far away.
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import type { EnemyAttackDef } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { pickAttack } from '../attacks';
import { distXZ } from '../attackMath';
import type { AiHost, EnemyBrain } from '../types';

const _p = new Vector3();

/** Charges need a clear lane. */
function laneFilter(e: Enemy, a: EnemyAttackDef): boolean {
  return a.kind !== 'charge' || e.laneClear;
}

/** Largest range of the enemy's token attacks (asks for a token within it). */
function tokenRange(e: Enemy): number {
  const attacks = e.def.attacks;
  let r = 0;
  for (let i = 0; i < attacks.length; i++) {
    const a = attacks[i]!;
    if (a.usesSlot && a.range > r) r = a.range;
  }
  return r;
}

export const bruteBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
    const B = e.def.brute;
    if (!B) return;
    const now = host.time;
    const dist = distXZ(e.position, target.position);
    const coord = host.coordinator(e.targetSlot);

    if (dist <= tokenRange(e) + B.standoff) coord.request(e.id, e.def.slotCost, now);
    else if (coord.holds(e.id)) coord.release(e.id, now);

    if (now >= e.laneCheckAt) {
      e.laneCheckAt = now + B.laneCheckInterval;
      e.laneClear = host.nav.walkable(e.position, target.position);
    }

    const idx = pickAttack(e, host, dist, target, laneFilter);
    if (idx >= 0) {
      host.beginAttack(e, idx);
      return;
    }

    // Approach to the standoff distance from its own side.
    const dx = e.position.x - target.position.x;
    const dz = e.position.z - target.position.z;
    const len = Math.hypot(dx, dz);
    if (len > B.standoff) {
      const k = B.standoff / len;
      _p.set(target.position.x + dx * k, target.position.y, target.position.z + dz * k);
      host.moveTo(e, _p, dist > B.runDistance ? e.def.movement.runSpeed : e.def.movement.walkSpeed);
    } else {
      host.stopMoving(e);
    }
  },

  resume(e: Enemy): void {
    e.laneCheckAt = 0;
  },

  release(): void {},
};
