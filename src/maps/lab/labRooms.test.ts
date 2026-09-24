/**
 * Room furniture of the research lab against the shell: no furniture box may put a visible face
 * on a wall face (coplanar faces z-fight; the shell draws the wall face itself).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { MaterialLibraryApi, PhysicsApi } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import { LAB_LAYOUT as L } from '../../defs/labLayout';
import { LevelKit, type BoxOptions } from '../../world/LevelKit';
import { buildAtrium, buildCryo, buildDock, buildLabs, buildReception, buildServer } from './labRooms';
import { spaceWallEdges } from './labSpaces';

const EPS = 1e-4;

function stubPhysics(): PhysicsApi {
  const collider = (): RAPIER.Collider => ({}) as RAPIER.Collider;
  return {
    addStaticBox: collider,
    addStaticTrimesh: collider,
    addDynamicBox: () => ({}) as RAPIER.RigidBody,
    removeBody() {},
    removeCollider() {},
  } as unknown as PhysicsApi;
}

const materials: MaterialLibraryApi = {
  get: (id: string) => new THREE.MeshStandardMaterial({ name: id }),
  async preload() {},
  dispose() {},
};

interface Box {
  material: string;
  min: Vec3Like;
  max: Vec3Like;
}

/** Axis-aligned boxes every room builder pushes through LevelKit.box (rotated ones skipped). */
function furnitureBoxes(): Box[] {
  const boxes: Box[] = [];
  const kit = new LevelKit({ physics: stubPhysics(), materials });
  const original = LevelKit.prototype.box;
  const spy = vi.spyOn(LevelKit.prototype, 'box').mockImplementation(function (
    this: LevelKit,
    m: string,
    c: Vec3Like,
    s: Vec3Like,
    o?: BoxOptions,
  ) {
    if (!o?.rotation) {
      boxes.push({
        material: m,
        min: { x: c.x - s.x / 2, y: c.y - s.y / 2, z: c.z - s.z / 2 },
        max: { x: c.x + s.x / 2, y: c.y + s.y / 2, z: c.z + s.z / 2 },
      });
    }
    original.call(this, m, c, s, o);
  });
  try {
    buildReception(kit);
    buildAtrium(kit);
    buildLabs(kit);
    buildServer(kit);
    buildCryo(kit);
    buildDock(kit);
  } finally {
    spy.mockRestore();
    kit.dispose();
  }
  return boxes;
}

describe('lab room builders', () => {
  it('never put a furniture face on a wall face (z-fighting)', () => {
    const boxes = furnitureBoxes();
    expect(boxes.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const space of L.spaces) {
      for (const e of spaceWallEdges(space, L.wallThickness)) {
        for (const b of boxes) {
          if (b.max.y <= EPS || b.min.y >= space.ceiling - EPS) continue;
          // The box face that looks into the room from the wall plane.
          const [face, lo, hi] =
            e.along === 'x'
              ? [e.facing === 'nz' ? b.min.z : b.max.z, b.min.x, b.max.x]
              : [e.facing === 'nx' ? b.min.x : b.max.x, b.min.z, b.max.z];
          if (Math.abs(face - e.coord) > EPS) continue;
          if (Math.min(hi, e.to) - Math.max(lo, e.from) <= EPS) continue;
          offenders.push(`${b.material} on ${space.id} ${e.facing}@${e.coord}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
