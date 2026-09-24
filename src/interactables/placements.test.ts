/**
 * Placement validation on the real maps (built in node with stub materials, like the nav tests):
 * perk machines and box locations stand free of level geometry, wall buys hang on a wall, every
 * anchor is reachable on the navmesh (with all solid interactables blocking it), placements lie in
 * their zones, and the full set is built (logic + visuals without a renderer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type {
  AssetsApi,
  LevelInstance,
  MaterialLibraryApi,
  RenderApi,
  SettingsStore,
} from '../core/contracts';
import { Rng } from '../core/Rng';
import { MYSTERY_BOX, PERK_MACHINES, WALL_BUYS } from '../defs/interactables';
import { PERK_IDS } from '../defs/perks';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { buildResearchLab } from '../maps/lab/ResearchLab';
import { isMapLevel } from '../maps/types';
import { collectNavSources } from '../nav/navGeometry';
import { NavSystem } from '../nav/NavSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createDefaultSettings } from '../save/settingsSchema';
import { buildTestRoom } from '../world/TestRoom';
import { InteractionSystem } from './InteractionSystem';
import { collectWallBuys, placeInteractables, type InteractablesHandle } from './placeInteractables';
import { facingNormal, facingYaw, propBox } from './shapes';
import { FakeEconomy, FakePerks, FakeWeapons } from './testFakes';

const WORLD_RAY = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);
/** Footprints are shrunk by this before the overlap test (touching a wall is fine). */
const TOUCH = 0.03;
/** The walkable spot nearest to an anchor must lie this far inside its use range (m). */
const REACH_MARGIN = 1.2;

const builders = { lab: buildResearchLab, testroom: buildTestRoom } as const;

for (const mapId of ['lab', 'testroom'] as const) {
  describe(`interactable placements: ${mapId}`, () => {
    let physics: PhysicsWorld;
    let level: LevelInstance;
    let nav: NavSystem;
    let handle: InteractablesHandle;
    let scene: THREE.Scene;
    let interaction: InteractionSystem;
    const events = new EventBus<GameEvents>();

    beforeAll(async () => {
      physics = await PhysicsWorld.create();
      const settings = {
        current: createDefaultSettings(),
        update() {},
        replace() {},
        resetSection() {},
      } as unknown as SettingsStore;
      const materials: MaterialLibraryApi = {
        get: (id: string) => new THREE.MeshStandardMaterial({ name: id }),
        async preload() {},
        dispose() {},
      };
      level = await builders[mapId]({
        render: {} as RenderApi,
        physics,
        assets: {} as AssetsApi,
        materials,
        settings,
        events,
        onProgress() {},
      });
      scene = new THREE.Scene();
      scene.add(level.root);
      nav = new NavSystem({ createWorker: null });
      expect(await nav.build(level.navSources ? [...level.navSources] : collectNavSources(level.root))).toBe(
        true,
      );
      interaction = new InteractionSystem({
        events,
        input: { isDown: () => false, pressed: () => false },
        viewer: { eyePosition: new THREE.Vector3(), yaw: 0, pitch: 0 },
        economy: new FakeEconomy(0),
        lineOfSight: () => true,
      });
    }, 60000);

    afterAll(() => {
      handle?.dispose();
      nav?.dispose();
      level?.dispose();
      physics?.dispose();
    });

    /** Level colliders intersecting a world box (before the interactables add their own). */
    function overlaps(
      center: { x: number; y: number; z: number },
      half: { x: number; y: number; z: number },
    ): string[] {
      physics.ensureQueries();
      const shape = new RAPIER.Cuboid(
        Math.max(0.01, half.x - TOUCH),
        Math.max(0.01, half.y - TOUCH),
        Math.max(0.01, half.z - TOUCH),
      );
      const hits: string[] = [];
      physics.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
        const d = physics.getColliderData(c);
        if (d?.kind !== 'trigger')
          hits.push(`${d?.kind ?? '?'}@${c.translation().x.toFixed(1)},${c.translation().z.toFixed(1)}`);
        return true;
      });
      return hits;
    }

    it('perk machines and box locations stand free of level geometry, in their zones', () => {
      const P = PERK_MACHINES;
      for (const spot of P.placements[mapId] ?? []) {
        const n = facingNormal(spot.facing);
        const off = P.wallGap + P.size.depth / 2;
        const c = { x: spot.position[0] + n.x * off, y: spot.position[1], z: spot.position[2] + n.z * off };
        const box = propBox(c, facingYaw(spot.facing), P.size.width, P.size.height, P.size.depth);
        expect(overlaps(box.center, box.half), spot.id).toEqual([]);
        // The wall is right behind the cabinet.
        const hit = physics.raycast(
          { x: c.x, y: 1, z: c.z },
          { x: -n.x, y: 0, z: -n.z },
          P.size.depth / 2 + P.wallGap + 0.1,
          { groups: WORLD_RAY },
        );
        expect(hit, `${spot.id}: wall behind`).not.toBeNull();
        if (isMapLevel(level)) expect(level.zoneAt(c.x, c.z), spot.id).toBe(spot.zone);
      }
      const S = MYSTERY_BOX.size;
      for (const loc of MYSTERY_BOX.locations[mapId] ?? []) {
        const p = { x: loc.position[0], y: loc.position[1], z: loc.position[2] };
        const box = propBox(p, facingYaw(loc.facing), S.width, S.height + S.lidHeight, S.depth);
        expect(overlaps(box.center, box.half), loc.id).toEqual([]);
        // Standing on a floor.
        const floor = physics.raycast({ x: p.x, y: p.y + 0.5, z: p.z }, { x: 0, y: -1, z: 0 }, 1, {
          groups: WORLD_RAY,
        });
        expect(floor, `${loc.id}: floor`).not.toBeNull();
        expect(floor!.point.y).toBeCloseTo(p.y, 1);
        if (isMapLevel(level)) expect(level.zoneAt(p.x, p.z), loc.id).toBe(loc.zone);
      }
    });

    it('wall buys hang on a wall face', () => {
      const all = collectWallBuys(level, mapId);
      expect(all.length).toBeGreaterThanOrEqual(3);
      const B = WALL_BUYS.board;
      for (const wb of all) {
        const n = facingNormal(wb.facing);
        const [x, y, z] = wb.position;
        // Rays at the board corners hit the wall just behind the board face.
        for (const [dx, dy] of [
          [-0.45, -0.4],
          [0.45, 0.4],
          [0, 0],
        ] as const) {
          const r = { x: n.z !== 0 ? dx * B.width : 0, z: n.x !== 0 ? dx * B.width : 0 };
          const hit = physics.raycast(
            { x: x + r.x + n.x * 0.3, y: y + dy * B.height, z: z + r.z + n.z * 0.3 },
            { x: -n.x, y: 0, z: -n.z },
            0.5,
            { groups: WORLD_RAY },
          );
          expect(hit, `${wb.id} (${dx},${dy})`).not.toBeNull();
          expect(hit!.distance).toBeGreaterThan(0.2);
          expect(hit!.distance).toBeLessThan(0.36);
        }
        if (isMapLevel(level)) expect(level.zoneAt(x + n.x * 0.5, z + n.z * 0.5), wb.id).toBe(wb.zone);
      }
    });

    it('builds every interactable and keeps their anchors reachable on the navmesh', () => {
      handle = placeInteractables({
        level,
        events,
        economy: new FakeEconomy(0),
        weapons: new FakeWeapons(['pistol']),
        perks: new FakePerks(),
        zones: null,
        interaction,
        physics,
        combat: { addStaticMesh: () => {} },
        nav,
        rng: new Rng('placement-test'),
        visuals: {
          scene,
          materials: {
            get: (id) => new THREE.MeshStandardMaterial({ name: id }),
            async preload() {},
            dispose() {},
          },
          render: null,
          reduceFlashing: false,
        },
      });
      nav.flushAreas();
      const doors = isMapLevel(level) ? level.doorSlots.length : 0;
      expect(handle.doors.length).toBe(doors);
      expect(handle.perkMachines.length).toBe(
        Math.min(PERK_IDS.length, PERK_MACHINES.placements[mapId]!.length),
      );
      expect(handle.perkMachines.length).toBe(PERK_IDS.length);
      expect(handle.wallBuys.length).toBe(collectWallBuys(level, mapId).length);
      expect(handle.box).not.toBeNull();
      expect(interaction.all.length).toBe(handle.interactables.length);
      expect(handle.interactables.length).toBe(
        doors * 2 + handle.wallBuys.length + handle.perkMachines.length + 1,
      );
      // Open every door: all anchors must be reachable from the player spawn.
      for (const d of handle.doors) d.open();
      for (let i = 0; i < 120; i++) handle.fixedUpdate(1 / 60);
      const out = new THREE.Vector3();
      // Open doors never open a cabinet beside them (the lab's east reception door and its perk
      // machine have overlapping nav areas): nothing snaps into a cabinet footprint.
      for (const spot of PERK_MACHINES.placements[mapId] ?? []) {
        const { width, depth } = PERK_MACHINES.size;
        const n = facingNormal(spot.facing);
        const off = PERK_MACHINES.wallGap + depth / 2;
        const c = { x: spot.position[0] + n.x * off, y: spot.position[1], z: spot.position[2] + n.z * off };
        const box = propBox(c, facingYaw(spot.facing), width, 1, depth);
        expect(nav.closestPoint(c, out), spot.id).toBe(true);
        const inside = Math.abs(out.x - c.x) < box.half.x && Math.abs(out.z - c.z) < box.half.z;
        expect(inside, `${spot.id}: snapped into the cabinet`).toBe(false);
      }
      const spawn = level.spawn.position;
      for (const it of handle.interactables) {
        const p = it.position;
        // The standing spot: the anchor dropped to its floor.
        const floor = physics.raycast({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }, 3, {
          groups: WORLD_RAY,
        });
        expect(floor, `${it.id}: floor under the anchor`).not.toBeNull();
        const q = { x: p.x, y: floor!.point.y, z: p.z };
        expect(nav.closestPoint(q, out), it.id).toBe(true);
        // Walkable floor within reach of the anchor (wall anchors sit inside the wall erosion).
        expect(Math.hypot(out.x - q.x, out.z - q.z), `${it.id}: standing spot`).toBeLessThan(
          it.range - REACH_MARGIN,
        );
        const path: THREE.Vector3[] = [];
        const n = nav.findPath(spawn, out, path);
        expect(n, `${it.id}: path`).toBeGreaterThan(0);
        const end = path[n - 1]!;
        expect(Math.hypot(end.x - out.x, end.z - out.z), `${it.id}: reachable`).toBeLessThan(0.5);
      }
      // Views and logic tick without a renderer.
      handle.update(1 / 60, 0.5);
      handle.box!.roll();
      for (let i = 0; i < 60; i++) {
        handle.fixedUpdate(1 / 60);
        handle.update(1 / 60, 1);
      }
      expect(handle.hasVolumetricContent).toBe(true);
      handle.reset();
      expect(handle.doors.every((d) => d.state === 'closed')).toBe(true);
      // Builds every view and walks every anchor: seconds on a loaded CI machine.
    }, 30000);
  });
}
