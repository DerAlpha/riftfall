import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { PhysicsApi, RaycastHit } from '../core/contracts';
import { NAV } from '../defs/nav';
import { COLLISION_GROUP } from '../defs/physics';
import { createPhysicsGroundProbe } from './groundProbe';

describe('createPhysicsGroundProbe', () => {
  it('casts down against the static world and returns the hit height', () => {
    const calls: { y: number; dir: number; max: number; groups: number }[] = [];
    const physics: Pick<PhysicsApi, 'raycast'> = {
      raycast(origin, dir, max, opts) {
        calls.push({ y: origin.y, dir: dir.y, max, groups: opts?.groups ?? 0 });
        return origin.x > 0 ? ({ point: new Vector3(origin.x, 1.5, origin.z) } as RaycastHit) : null;
      },
    };
    const probe = createPhysicsGroundProbe(physics);
    expect(probe(2, 3, 0)).toBe(1.5);
    expect(probe(-2, 3, 0)).toBeNull();
    expect(calls[0]).toMatchObject({ y: 3, dir: -1, max: NAV.direct.probeRange });
    // Filter (lower 16 bits) = static world only.
    expect(calls[0]!.groups & 0xffff).toBe(COLLISION_GROUP.WORLD);
  });
});
