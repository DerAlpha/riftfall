/**
 * CombatWorld against the real Calibration Hall (LevelKit mesh naming, BVH, dynamic crates).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { AssetsApi, LevelInstance, MaterialLibraryApi, RenderApi } from '../core/contracts';
import { TEST_ROOM_LAYOUT as L } from '../defs/level';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { fakeSettings } from '../player/testHelpers';
import { buildTestRoom } from '../world/TestRoom';
import { CombatWorld } from './CombatWorld';

describe('CombatWorld in the Calibration Hall', () => {
  let physics: PhysicsWorld;
  let level: LevelInstance;
  let combat: CombatWorld;
  const events = new EventBus<GameEvents>();

  beforeAll(async () => {
    physics = await PhysicsWorld.create();
    const materials: MaterialLibraryApi = {
      get: (id: string) => new THREE.MeshStandardMaterial({ name: id }),
      preload: async () => {},
      dispose() {},
    };
    level = await buildTestRoom({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings: fakeSettings(),
      events,
      onProgress: () => {},
    });
    combat = new CombatWorld({ events, physics });
    combat.setLevel(level.root);
  });

  afterAll(() => physics.dispose());

  it('collects the merged level meshes', () => {
    expect(combat.stats.staticMeshes).toBeGreaterThan(8);
  });

  it('the hall is closed: rays from the spawn hit a surface in every direction', () => {
    const [sx, , sz] = L.spawn.position;
    const eye = { x: sx, y: 1.6, z: sz };
    const n = 64;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      for (const y of [-0.6, 0, 0.5]) {
        const dir = { x: Math.cos(a), y, z: Math.sin(a) };
        const hit = combat.raycast(eye, dir, 500);
        expect(hit, `dir ${a.toFixed(2)} ${y}`).not.toBeNull();
        expect(hit!.distance).toBeLessThan(120);
        // Normals face the shooter.
        const len = Math.hypot(dir.x, dir.y, dir.z);
        expect(hit!.normal.x * dir.x + hit!.normal.y * dir.y + hit!.normal.z * dir.z).toBeLessThanOrEqual(
          1e-6 * len,
        );
      }
    }
    const floor = combat.raycast(eye, { x: 0, y: -1, z: 0 }, 10);
    expect(floor!.distance).toBeCloseTo(1.6, 1);
    expect(['concrete', 'metal', 'grate', 'rubber']).toContain(floor!.surface);
  });

  it('dynamic crates stop bullets through Rapier and get pushed', () => {
    const crate = L.crates.find((c) => c.dynamic)!;
    const [cx, cy, cz] = crate.position;
    const from = { x: cx, y: cy, z: cz + 6 };
    const hit = combat.raycast(from, { x: 0, y: 0, z: -1 }, 20);
    expect(hit).not.toBeNull();
    expect(hit!.target).toBeNull();
    expect(hit!.distance).toBeLessThan(6);
    expect(combat.pushProp(hit!, { x: 0, y: 0, z: -1 }, 200)).toBe(true);
  });

  it('is fast enough for shotgun volleys with a full level', () => {
    const eye = { x: 0, y: 1.6, z: 20 };
    const t0 = performance.now();
    const rays = 900;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      combat.raycast(eye, { x: Math.cos(a), y: -0.1, z: Math.sin(a) }, 200);
    }
    const perRay = (performance.now() - t0) / rays;
    // Generous bound for CI machines; warmed up it is ~10 µs per ray (BVH + Rapier props).
    expect(perRay).toBeLessThan(0.5);
  });
});
