import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderData, MaterialLibraryApi, PhysicsApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { LevelKit, applyFaceUV, buildPrismGeometry, facingBasis, WallFrame } from './LevelKit';

interface Call {
  kind: 'box' | 'trimesh' | 'dynamic';
  center?: Vec3Like;
  half?: Vec3Like;
  data?: ColliderData;
  vertices?: Float32Array;
  indices?: Uint32Array;
}

/** Records physics calls; never touches Rapier. */
function fakePhysics(): { physics: PhysicsApi; calls: Call[]; removed: number[] } {
  const calls: Call[] = [];
  const removed: number[] = [];
  let handle = 0;
  const physics = {
    addStaticBox(center: Vec3Like, halfExtents: Vec3Like, _rot?: THREE.Quaternion, data?: ColliderData) {
      calls.push({ kind: 'box', center: { ...center }, half: { ...halfExtents }, data });
      return { handle: handle++ } as unknown as RAPIER.Collider;
    },
    addStaticTrimesh(vertices: Float32Array, indices: Uint32Array, data?: ColliderData) {
      calls.push({ kind: 'trimesh', vertices, indices, data });
      return { handle: handle++ } as unknown as RAPIER.Collider;
    },
    addDynamicBox(
      center: Vec3Like,
      halfExtents: Vec3Like,
      _obj: THREE.Object3D | null,
      opts?: { data?: ColliderData },
    ) {
      calls.push({ kind: 'dynamic', center: { ...center }, half: { ...halfExtents }, data: opts?.data });
      return { handle: handle++ } as unknown as RAPIER.RigidBody;
    },
    removeCollider(c: RAPIER.Collider) {
      removed.push(c.handle);
    },
    removeBody(b: RAPIER.RigidBody) {
      removed.push(b.handle);
    },
    raycast() {
      return null;
    },
  } as unknown as PhysicsApi;
  return { physics, calls, removed };
}

function fakeMaterials(): MaterialLibraryApi {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  return {
    get(id: string) {
      let m = cache.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ name: id });
        cache.set(id, m);
      }
      return m;
    },
    async preload() {},
    dispose() {},
  };
}

/** Signed volume of a closed triangle mesh (> 0 when all faces wind outwards). */
function signedVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const ax = pos[a]!;
    const ay = pos[a + 1]!;
    const az = pos[a + 2]!;
    const bx = pos[b]!;
    const by = pos[b + 1]!;
    const bz = pos[b + 2]!;
    const cx = pos[c]!;
    const cy = pos[c + 1]!;
    const cz = pos[c + 2]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('LevelKit', () => {
  it('merges geometry per material into one mesh with a BVH and creates colliders with surfaces', () => {
    const { physics, calls } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    kit.box('floor_concrete', { x: 0, y: -0.25, z: 0 }, { x: 4, y: 0.5, z: 4 });
    kit.box('floor_concrete', { x: 4, y: -0.25, z: 0 }, { x: 4, y: 0.5, z: 4 });
    kit.box('wall_panel', { x: 0, y: 2, z: -2 }, { x: 4, y: 4, z: 0.5 });
    kit.marking('painted_hazard', 0, 0, 1, 1, 0);
    kit.build();
    expect(kit.meshes.length).toBe(3);
    for (const m of kit.meshes) {
      expect(m.geometry.boundsTree).toBeDefined();
      expect(m.geometry.attributes.uv).toBeDefined();
    }
    const floor = kit.meshes.find((m) => m.name.startsWith('level:floor_concrete'))!;
    expect(floor.geometry.attributes.position!.count).toBe(48);
    // Markings have no collider; the three boxes do.
    const boxes = calls.filter((c) => c.kind === 'box');
    expect(boxes.length).toBe(3);
    expect(boxes[0]!.data).toEqual({ kind: 'world', surface: 'concrete' });
    expect(boxes[2]!.data?.surface).toBe('metal');
    expect(kit.stats.colliders).toBe(3);
    expect(kit.stats.triangles).toBe(48);

    // BVH-accelerated raycast against the merged level mesh.
    kit.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(1, 5, 1), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(kit.root, true);
    expect(hits[0]?.point.y).toBeCloseTo(0.012, 5);
  });

  it('writes world-space UVs in meters (continuous across boxes)', () => {
    const { physics } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    kit.box('floor_concrete', { x: 3, y: -0.25, z: 0 }, { x: 2, y: 0.5, z: 6 }, { collider: false });
    kit.build();
    const geo = kit.meshes[0]!.geometry;
    const pos = geo.attributes.position!;
    const nor = geo.attributes.normal!;
    const uv = geo.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      if (nor.getY(i) > 0.5) {
        expect(uv.getX(i)).toBeCloseTo(pos.getX(i), 6);
        expect(uv.getY(i)).toBeCloseTo(-pos.getZ(i), 6);
      }
    }
  });

  it('builds outward-facing prisms (visual and trimesh collider)', () => {
    const profile: [number, number][] = [
      [2, 0],
      [-2, 1.5],
      [-2, 0],
    ];
    const geo = buildPrismGeometry(profile, 1, { x: 0, y: 0, z: 0 }, new THREE.Quaternion());
    expect(signedVolume(geo.attributes.position!.array, geo.index!.array)).toBeCloseTo(0.5 * 4 * 1.5 * 2, 5);
    // Every face normal points away from the centroid.
    const pos = geo.attributes.position!;
    const nor = geo.attributes.normal!;
    const centroid = new THREE.Vector3(0, 0.5, -0.67);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).sub(centroid);
      n.fromBufferAttribute(nor, i);
      expect(p.dot(n)).toBeGreaterThan(0);
    }

    const { physics, calls } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    kit.ramp({
      material: 'floor_panel',
      center: { x: 5, y: 0, z: 5 },
      width: 3,
      run: 8,
      rise: 2,
      yaw: Math.PI / 2,
    });
    const tri = calls.find((c) => c.kind === 'trimesh')!;
    expect(tri.data?.surface).toBe('metal');
    expect(signedVolume(tri.vertices!, tri.indices!)).toBeCloseTo(0.5 * 8 * 2 * 3, 4);
  });

  it('keeps stair colliders on the nosing line', () => {
    const { physics, calls } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    kit.stairs({
      material: 'floor_panel',
      stringer: 'trim_metal',
      bottomCenter: { x: 0, y: 0, z: 0 },
      width: 2,
      steps: 5,
      stepRise: 0.2,
      stepRun: 0.3,
      yaw: 0,
    });
    const tri = calls.filter((c) => c.kind === 'trimesh');
    expect(tri.length).toBe(1);
    const v = tri[0]!.vertices!;
    let maxY = 0;
    for (let i = 1; i < v.length; i += 3) maxY = Math.max(maxY, v[i]!);
    expect(maxY).toBeCloseTo(1, 6);
    expect(signedVolume(v, tri[0]!.indices!)).toBeGreaterThan(0);
  });

  it('creates dynamic crates as props and removes everything on dispose', () => {
    const { physics, calls, removed } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    kit.crate({ material: 'crate', center: { x: 0, y: 0.5, z: 0 }, size: 1, yaw: 0.3, dynamic: true });
    kit.crate({ material: 'crate', center: { x: 2, y: 0.5, z: 0 }, size: 1, yaw: 0, dynamic: true });
    kit.crate({ material: 'crate', center: { x: 4, y: 0.5, z: 0 }, size: 1, yaw: 0, dynamic: false });
    kit.build();
    const dyn = calls.filter((c) => c.kind === 'dynamic');
    expect(dyn.length).toBe(2);
    expect(dyn[0]!.data).toMatchObject({ kind: 'prop', surface: 'metal' });
    // Dynamic crates share one geometry per size.
    const crates = kit.meshes.filter((m) => m.name.startsWith('crate:'));
    expect(crates.length).toBe(2);
    expect(crates[0]!.geometry).toBe(crates[1]!.geometry);
    expect(kit.stats.dynamicBodies).toBe(2);
    kit.dispose();
    expect(removed.length).toBe(3);
    expect(kit.root.children.length).toBe(0);
  });

  it('respects the local shadow budget per quality level', () => {
    const { physics } = fakePhysics();
    const kit = new LevelKit({ physics, materials: fakeMaterials() });
    const spot = (priority: number | null) =>
      kit.spotFixture({
        position: { x: 0, y: 5, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        color: new THREE.Color(1, 1, 1),
        intensity: 100,
        distance: 20,
        angle: 0.5,
        penumbra: 0.5,
        shadowPriority: priority,
        housing: 'trim_metal',
        panel: 'emissive_white',
        rodTop: 8,
        flicker: priority === 2,
      });
    const lights = [spot(3), spot(1), spot(2), spot(null)].map((h) => h.light as THREE.SpotLight);
    kit.build();
    kit.applyShadowQuality('medium'); // maxLocalShadows 2
    expect(lights.map((l) => l.castShadow)).toEqual([false, true, true, false]);
    expect(lights[1]!.shadow.mapSize.x).toBe(512);
    kit.applyShadowQuality('low'); // 0
    expect(lights.some((l) => l.castShadow)).toBe(false);
    kit.applyShadowQuality('ultra');
    expect(lights.filter((l) => l.castShadow).length).toBe(3);
    expect(lights[0]!.shadow.mapSize.x).toBe(1024);
    // Flickering fixture got its own panel material.
    expect(kit.lights[2]!.panel).not.toBeNull();
    expect(kit.lights[0]!.panel).toBeNull();
    // Staggered refresh only flags shadow-casting lights.
    for (const l of lights) l.shadow.needsUpdate = false;
    kit.updateShadows();
    kit.updateShadows();
    expect(lights[3]!.shadow.needsUpdate).toBe(false);
    expect(lights.filter((l) => l.shadow.needsUpdate).length).toBe(3);
    kit.dispose();
  });

  it('maps wall-face frames to world space', () => {
    const f = new WallFrame({ x: 10, y: 0, z: -5 }, 'px');
    expect(f.point(1, 2, 0.5).toArray()).toEqual([10.5, 2, -6]);
    expect(f.size(4, 3, 0.2).toArray()).toEqual([0.2, 3, 4]);
    const b = facingBasis('nz');
    expect(b.normal).toEqual({ x: 0, y: 0, z: -1 });
    const g = new THREE.BoxGeometry(2, 2, 2);
    applyFaceUV(g, 1.5);
    let maxU = 0;
    const uv = g.attributes.uv!;
    for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
    expect(maxU).toBeCloseTo(1.5, 6);
  });
});
