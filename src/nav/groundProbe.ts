/**
 * GroundProbe backed by a downward physics ray against the static world – what the navigation
 * fallback (DirectSteering, fallback queries) uses for heights when there is no navmesh.
 * Allocation-free: the ray origin and options are reused.
 */
import type { PhysicsApi } from '../core/contracts';
import { NAV } from '../defs/nav';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import type { GroundProbe } from './types';

const DOWN = { x: 0, y: -1, z: 0 } as const;

export function createPhysicsGroundProbe(physics: Pick<PhysicsApi, 'raycast'>): GroundProbe {
  const from = { x: 0, y: 0, z: 0 };
  const opts = { groups: interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD) };
  return (x, y, z) => {
    from.x = x;
    from.y = y;
    from.z = z;
    const hit = physics.raycast(from, DOWN, NAV.direct.probeRange, opts);
    return hit ? hit.point.y : null;
  };
}
