/**
 * Rift Forge / Werkbank placements on the real maps (built in node with stub materials, like the
 * perk machine placement test): the machines stand free of level geometry on a floor, in their
 * zones, and their prompt anchors are reachable on the navmesh from the player spawn with every
 * solid interactable blocking it. Also: the full workshop builds (logic + views without a renderer)
 * and a new run resets it.
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
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { RIFT_FORGE_MACHINE, WORKBENCH, type WorkshopPlacementDef } from '../defs/workshop';
import { buildResearchLab } from '../maps/lab/ResearchLab';
import { isMapLevel } from '../maps/types';
import { collectNavSources } from '../nav/navGeometry';
import { NavSystem } from '../nav/NavSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createDefaultSettings } from '../save/settingsSchema';
import { buildTestRoom } from '../world/TestRoom';
import { InteractionSystem } from './InteractionSystem';
import { placeInteractables, type InteractablesHandle } from './placeInteractables';
import type { WorkshopWeapons } from './RiftForge';
import { facingNormal, facingYaw, propBox } from './shapes';
import { FakeEconomy, FakePerks, FakeWeapons } from './testFakes';

const WORLD_RAY = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);
const TOUCH = 0.03;
const REACH_MARGIN = 1.2;

const builders = { lab: buildResearchLab, testroom: buildTestRoom } as const;

const noWeapons: WorkshopWeapons = {
  currentWeaponId: 'rifle',
  state: 'idle',
  effectiveDef: () => null,
  modsOf: () => null,
  setWeaponMods: () => true,
};

for (const mapId of ['lab', 'testroom'] as const) {
  describe(`workshop placements: ${mapId}`, () => {
    let physics: PhysicsWorld;
    let level: LevelInstance;
    let nav: NavSystem;
    let handle: InteractablesHandle;
    let scene: THREE.Scene;
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
    }, 60000);

    afterAll(() => {
      handle?.dispose();
      nav?.dispose();
      level?.dispose();
      physics?.dispose();
    });

    function overlaps(center: THREE.Vector3Like, half: THREE.Vector3Like): string[] {
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

    const machines: readonly [
      WorkshopPlacementDef | undefined,
      { width: number; height: number; depth: number },
      number,
    ][] = [
      [RIFT_FORGE_MACHINE.placements[mapId]?.[0], RIFT_FORGE_MACHINE.size, RIFT_FORGE_MACHINE.wallGap],
      [WORKBENCH.placements[mapId]?.[0], WORKBENCH.size, WORKBENCH.wallGap],
    ];

    it('the forge and the bench stand free of level geometry on a floor, in their zones', () => {
      for (const [spot, size, gap] of machines) {
        expect(spot, `${mapId}: placement`).toBeDefined();
        const n = facingNormal(spot!.facing);
        const off = gap + size.depth / 2;
        const c = {
          x: spot!.position[0] + n.x * off,
          y: spot!.position[1],
          z: spot!.position[2] + n.z * off,
        };
        const box = propBox(c, facingYaw(spot!.facing), size.width, size.height, size.depth);
        expect(overlaps(box.center, box.half), spot!.id).toEqual([]);
        const floor = physics.raycast({ x: c.x, y: c.y + 0.5, z: c.z }, { x: 0, y: -1, z: 0 }, 1, {
          groups: WORLD_RAY,
        });
        expect(floor, `${spot!.id}: floor`).not.toBeNull();
        if (isMapLevel(level)) expect(level.zoneAt(c.x, c.z), spot!.id).toBe(spot!.zone);
      }
    });

    it('builds both machines; their anchors are reachable from the spawn; a new run resets them', () => {
      const interaction = new InteractionSystem({
        events,
        input: { isDown: () => false, pressed: () => false },
        viewer: { eyePosition: new THREE.Vector3(), yaw: 0, pitch: 0 },
        economy: new FakeEconomy(0),
        lineOfSight: () => true,
      });
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
        rng: new Rng('workshop-test'),
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
        workshop: { weapons: noWeapons },
      });
      nav.flushAreas();
      expect(handle.forge).not.toBeNull();
      expect(handle.workbench).not.toBeNull();
      expect(interaction.all).toContain(handle.forge);
      expect(interaction.all).toContain(handle.workbench);
      for (const d of handle.doors) d.open();
      for (let i = 0; i < 120; i++) handle.fixedUpdate(1 / 60);
      const out = new THREE.Vector3();
      const spawn = level.spawn.position;
      for (const it of [handle.forge!, handle.workbench!]) {
        const p = it.position;
        const floor = physics.raycast({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }, 3, {
          groups: WORLD_RAY,
        });
        expect(floor, `${it.id}: floor under the anchor`).not.toBeNull();
        const q = { x: p.x, y: floor!.point.y, z: p.z };
        expect(nav.closestPoint(q, out), it.id).toBe(true);
        expect(Math.hypot(out.x - q.x, out.z - q.z), `${it.id}: standing spot`).toBeLessThan(
          it.range - REACH_MARGIN,
        );
        const path: THREE.Vector3[] = [];
        const n = nav.findPath(spawn, out, path);
        expect(n, `${it.id}: path`).toBeGreaterThan(0);
        const end = path[n - 1]!;
        expect(Math.hypot(end.x - out.x, end.z - out.z), `${it.id}: reachable`).toBeLessThan(0.5);
      }
      // Views tick without a renderer; a run reset leaves both idle.
      for (let i = 0; i < 30; i++) handle.update(1 / 60, 1);
      handle.reset();
      expect(handle.forge!.busy).toBe(false);
      expect(handle.workbench!.isOpen).toBe(false);
    }, 30000);
  });
}
