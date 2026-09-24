/**
 * Swarm brain (swarmer): fast melee pack that surrounds the player.
 *
 * - Surround slots: every swarmer owns a bearing around its target; the cheapest slot (sides/back of
 *   the player's view, uncrowded, short walk, verified by nav path length when the path budget
 *   allows) is re-chosen every `slotInterval` seconds, staggered. Far swarmers path to their slot
 *   point, so packs arrive from the flanks instead of in a conga line.
 * - Attack tokens (AttackSlotCoordinator): within `engageDistance` a swarmer asks for a token. Holders
 *   close in to `standoff` from their slot side and bite / leap; the others wait on the ring at
 *   `ringRadius`, pacing around their slot, and rotate in when tokens free up.
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import { DEG2RAD } from '../../../core/math';
import { ENEMY_AI } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { pickAttack } from '../attacks';
import { distXZ } from '../attackMath';
import type { AiHost, EnemyBrain } from '../types';

const _p = new Vector3();
const TAU = Math.PI * 2;

/** Nav path length of the corners in host.pathScratch (0 corners → +∞). */
export function pathLength(corners: readonly Vector3[], count: number, from: Vector3): number {
  if (count <= 0) return Number.POSITIVE_INFINITY;
  let len = 0;
  let px = from.x;
  let pz = from.z;
  for (let i = 0; i < count; i++) {
    const c = corners[i]!;
    len += Math.hypot(c.x - px, c.z - pz);
    px = c.x;
    pz = c.z;
  }
  return len;
}

function chooseSlot(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
  const S = e.def.swarm!;
  const A = ENEMY_AI.surround;
  const slots = host.surround(e.targetSlot);
  const tx = target.position.x;
  const tz = target.position.z;
  let best = slots.rank(
    e.position.x,
    e.position.z,
    e.slot,
    tx,
    tz,
    host.targetFacing(e.targetSlot),
    S.ringRadius,
  );
  // Refine the cheapest candidates with the real path length (walls, doors) if budget allows.
  const k = Math.min(A.pathCandidates, slots.count);
  if (k > 1 && host.takePaths(k)) {
    let bestCost = Number.POSITIVE_INFINITY;
    for (let r = 0; r < k; r++) {
      const i = slots.ranked[r]!;
      const a = slots.angle(i);
      _p.set(tx + Math.cos(a) * S.ringRadius, target.position.y, tz + Math.sin(a) * S.ringRadius);
      const straight = distXZ(e.position, _p);
      const n = host.nav.findPath(e.position, _p, host.pathScratch);
      const len = pathLength(host.pathScratch, n, e.position);
      // A partial path that ends far from the slot point means the slot is unreachable.
      const end = n > 0 ? host.pathScratch[n - 1]! : null;
      const reach = end ? distXZ(end, _p) : Number.POSITIVE_INFINITY;
      const cost =
        slots.rankedCost[r]! +
        A.pathWeight * (Number.isFinite(len) ? len - straight : A.unreachableCost) +
        A.pathWeight * (Number.isFinite(reach) ? reach : A.unreachableCost);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
  }
  if (best !== e.slot) {
    slots.release(e.slot);
    slots.claim(best);
    e.slot = best;
  }
  e.slotEvalAt = host.time + S.slotInterval * (1 + A.intervalJitter * (2 * host.rng.next() - 1));
}

export const swarmBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi): void {
    const S = e.def.swarm;
    if (!S) return;
    const now = host.time;
    const dist = distXZ(e.position, target.position);
    const coord = host.coordinator(e);

    // Ask within engageDistance; a holder keeps (and refreshes) its token up to releaseDistance.
    let holds = false;
    const holding = coord.holds(e.id);
    const level = Math.abs(target.position.y - e.position.y) <= ENEMY_AI.slots.engageHeight;
    if (level && (dist <= S.engageDistance || (holding && dist <= ENEMY_AI.slots.releaseDistance))) {
      holds = coord.request(e.id, e.def.slotCost, now);
    } else if (holding) {
      coord.release(e.id, now);
    }

    if (holds) {
      const idx = pickAttack(e, host, dist, target);
      if (idx >= 0) {
        host.beginAttack(e, idx);
        return;
      }
    }

    if (e.slot < 0 || now >= e.slotEvalAt) chooseSlot(e, host, target);
    const slots = host.surround(e.targetSlot);
    let angle = slots.angle(e.slot);
    let radius = S.standoff;
    if (!holds) {
      // Pace around the slot while waiting (per-enemy phase).
      angle += Math.sin(now * S.orbitHz * TAU + e.orbitPhase) * S.orbitAmplitudeDeg * DEG2RAD;
      radius = S.ringRadius;
    }
    _p.set(
      target.position.x + Math.cos(angle) * radius,
      target.position.y,
      target.position.z + Math.sin(angle) * radius,
    );
    // Token holders run in; waiting swarmers trot on the ring once they are close.
    const nearRing = !holds && dist < S.ringRadius + ENEMY_AI.surround.ringWalkMargin;
    host.moveTo(e, _p, nearRing ? e.def.movement.walkSpeed : e.def.movement.runSpeed);
  },

  resume(e: Enemy): void {
    // Fresh from the rift / a new target: pick a slot now. After attacks the slot is kept.
    if (e.slot < 0) e.slotEvalAt = 0;
  },

  release(e: Enemy, host: AiHost): void {
    if (e.slot >= 0) host.surround(e.targetSlot).release(e.slot);
    e.slot = -1;
  },
};
