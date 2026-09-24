/**
 * Builds the full research lab against the real Rapier physics world (no GPU: the material library
 * is a stub), probes the collision layout with raycasts and builds the navmesh from the level to
 * check that every zone, spawn point and the atrium ring are reachable from the player spawn.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import type { AssetsApi, MaterialLibraryApi, RenderApi, SettingsStore } from '../../core/contracts';
import { COLLISION_GROUP, interactionGroups } from '../../defs/physics';
import { LAB_LAYOUT as L, RIFT_PORTAL } from '../../defs/labLayout';
import { isMaterialId } from '../../defs/materials';
import { NAV } from '../../defs/nav';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { NavSystem } from '../../nav/NavSystem';
import { createDefaultSettings, type Settings, type SettingsSection } from '../../save/settingsSchema';
import { baseMaterialId } from '../../world/LevelKit';
import { isMapLevel, type MapLevelInstance } from '../types';
import { buildResearchLab, labMaterialIds, spawnWallPoint } from './ResearchLab';
import { facingNormal, rectCenter } from './labSpaces';

const down = { x: 0, y: -1, z: 0 };
const WORLD_RAY = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);

describe('buildResearchLab', () => {
  let physics: PhysicsWorld;
  let level: MapLevelInstance;
  let nav: NavSystem;
  const events = new EventBus<GameEvents>();
  const settingsObj: Settings = createDefaultSettings();
  const settings: SettingsStore = {
    current: settingsObj,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>) {
      Object.assign(settingsObj[section], patch);
      events.emit('settings:changed', { settings: settingsObj, sections: [section] });
    },
    replace() {},
    resetSection() {},
  };
  const requested = new Set<string>();
  const preloaded: string[] = [];
  const materials: MaterialLibraryApi = {
    get(id: string) {
      requested.add(id);
      return new THREE.MeshStandardMaterial({ name: id });
    },
    async preload(ids, onProgress) {
      preloaded.push(...ids);
      onProgress?.(ids.length, ids.length);
    },
    dispose() {},
  };
  const progress: number[] = [];

  beforeAll(async () => {
    physics = await PhysicsWorld.create();
    const built = await buildResearchLab({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events,
      onProgress: (_label, f) => progress.push(f),
    });
    expect(isMapLevel(built)).toBe(true);
    level = built as MapLevelInstance;
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(level.navSources ?? [])).toBe(true);
  }, 120000);

  afterAll(() => {
    nav?.dispose();
    level?.dispose();
    physics?.dispose();
  });

  it('reports sane stats within the mesh and light budgets', () => {
    const s = level.stats;
    const dynamicCrates = L.dock.crates.filter((c) => c.dynamic).length;
    expect(s.dynamicBodies).toBe(dynamicCrates);
    expect(s.lights).toBe(L.lights.spots.length + L.lights.points.length + 1);
    expect(s.lights).toBeLessThanOrEqual(L.maxLights);
    expect(s.meshes).toBeLessThanOrEqual(L.maxMeshes);
    expect(s.colliders).toBeGreaterThan(200);
    // Every drawable object under the root counts towards the draw calls.
    let drawables = 0;
    level.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) drawables++;
    });
    expect(drawables).toBeLessThanOrEqual(L.maxMeshes);
    let lights = 0;
    level.root.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    expect(lights).toBe(s.lights);
    expect(level.atmosphere.id).toBe('lab');
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  });

  it('preloads and uses only defined materials (variants resolve to defined bases)', () => {
    for (const id of requested) expect(isMaterialId(id), id).toBe(true);
    for (const id of requested) expect(preloaded).toContain(id);
    for (const id of labMaterialIds()) expect(isMaterialId(baseMaterialId(id)), id).toBe(true);
  });

  it('spawns the player on the reception floor', () => {
    const p = level.spawn.position;
    const hit = physics.raycast({ x: p.x, y: p.y + 1, z: p.z }, down, 5, { groups: WORLD_RAY });
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0, 3);
    expect(level.zoneAt(p.x, p.z)).toBe('reception');
  });

  it('puts every spawn point on walkable floor at its height, inside its zone', () => {
    expect(level.spawnPoints?.length).toBe(L.spawnPoints.length);
    for (const sp of level.spawnPoints ?? []) {
      const p = sp.position;
      const hit = physics.raycast({ x: p.x, y: p.y + 1.5, z: p.z }, down, 4, { groups: WORLD_RAY });
      expect(hit, sp.id).not.toBeNull();
      expect(hit!.point.y, sp.id).toBeCloseTo(p.y, 2);
      expect(hit!.normal.y, sp.id).toBeGreaterThan(0.99);
      expect(level.zoneAt(p.x, p.z), sp.id).toBe(sp.zone);
      // Headroom for a tank (2.4 m) above the point.
      const up = physics.raycast({ x: p.x, y: p.y + 0.1, z: p.z }, { x: 0, y: 1, z: 0 }, 2.6, {
        groups: WORLD_RAY,
      });
      expect(up, sp.id).toBeNull();
    }
  });

  it('puts every wall tear / vent on a wall face', () => {
    for (const p of L.spawnPoints) {
      if (!p.wall) continue;
      const n = facingNormal(p.wall);
      const w = spawnWallPoint(p)!;
      const from = { x: p.position[0], y: p.position[1] + 0.5, z: p.position[2] };
      const hit = physics.raycast(from, { x: -n.x, y: 0, z: -n.z }, L.spawnTears.wallDistance + 0.5, {
        groups: WORLD_RAY,
      });
      expect(hit, p.id).not.toBeNull();
      const expected = L.spawnTears.wallDistance - (p.tearOffset ?? 0);
      expect(hit!.distance, p.id).toBeGreaterThan(expected - 0.12);
      expect(hit!.distance, p.id).toBeLessThan(expected + 0.05);
      expect(Math.hypot(hit!.point.x - w.x, hit!.point.z - w.z), p.id).toBeLessThan(0.16);
    }
  });

  it('keeps every doorway open (no collider through the passage) and every wall closed', () => {
    for (const d of L.doorways) {
      const dir = d.axis === 'x' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
      const reach = L.wallThickness * 2 + 1.2;
      for (const y of [0.4, d.height - 0.4]) {
        const from = { x: d.x - dir.x * reach, y, z: d.z - dir.z * reach };
        const hit = physics.raycast(from, dir, reach * 2, { groups: WORLD_RAY });
        expect(hit, `${d.id} @${y}`).toBeNull();
      }
      // Beside the door frame the wall is solid.
      const side = d.width / 2 + L.doorFrame.postWidth + 0.4;
      const from = {
        x: d.x - dir.x * reach + (d.axis === 'z' ? side : 0),
        y: 1,
        z: d.z - dir.z * reach + (d.axis === 'x' ? side : 0),
      };
      expect(physics.raycast(from, dir, reach * 2, { groups: WORLD_RAY }), `${d.id} wall`).not.toBeNull();
    }
  });

  it('has a walkable catwalk ring, a dais and a mantle-able loading platform', () => {
    const R = L.atrium.ring;
    const hit = physics.raycast({ x: 0, y: R.deckY + 2, z: -12.5 }, down, 4, { groups: WORLD_RAY });
    expect(hit!.point.y).toBeCloseTo(R.deckY, 3);
    const dais = physics.raycast({ x: 0, y: 2, z: 2.5 }, down, 4, { groups: WORLD_RAY });
    expect(dais!.point.y).toBeCloseTo(L.atrium.dais.height, 3);
    const P = L.dock.platform;
    const plat = physics.raycast({ x: 0, y: 4, z: -27 }, down, 5, { groups: WORLD_RAY });
    expect(plat!.point.y).toBeCloseTo(P.height, 3);
  });

  it('closes every space with a ceiling (sun probe: no sky outside the atrium lantern)', () => {
    const up = { x: 0, y: 1, z: 0 };
    for (const s of L.spaces) {
      for (const r of s.rects) {
        const c = rectCenter(r);
        const hit = physics.raycast({ x: c.x, y: 1.7, z: c.z }, up, 40, { groups: WORLD_RAY });
        if (s.id === 'atrium') {
          const S = L.atrium.skylight;
          const inHole = c.x > S.minX && c.x < S.maxX && c.z > S.minZ && c.z < S.maxZ;
          // Under the skylight only the ring / nothing is above (the lantern glass has no collider).
          if (inHole) continue;
        }
        expect(hit, s.id).not.toBeNull();
      }
    }
  });

  it('builds a navmesh that connects every zone, spawn point and the ring to the player spawn', () => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < NAV.query.maxStraightPathPoints; i++) out.push(new THREE.Vector3());
    const start = level.spawn.position;
    const goals: [string, THREE.Vector3][] = [];
    for (const s of L.spaces) {
      const c = rectCenter(s.rects[0]!);
      goals.push([`space ${s.id}`, new THREE.Vector3(c.x, 0, c.z)]);
    }
    for (const sp of level.spawnPoints ?? []) goals.push([`spawn ${sp.id}`, sp.position.clone()]);
    goals.push(['ring north', new THREE.Vector3(0, L.atrium.ring.deckY, -12.5)]);
    goals.push(['ring west', new THREE.Vector3(-12.5, L.atrium.ring.deckY, 4)]);
    goals.push(['dock platform', new THREE.Vector3(-6, L.dock.platform.height, -28)]);
    const snapped = new THREE.Vector3();
    for (const [name, goal] of goals) {
      // Some space centers sit on furniture: snap to the navmesh first.
      expect(nav.closestPoint(goal, snapped), name).toBe(true);
      expect(snapped.distanceTo(goal), name).toBeLessThan(2.5);
      const n = nav.findPath(start, snapped, out);
      expect(n, name).toBeGreaterThanOrEqual(2);
      expect(out[n - 1]!.distanceTo(snapped), name).toBeLessThan(0.4);
    }
  });

  it('keeps the dynamic crates off the enemy routes (the navmesh does not know them)', () => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < NAV.query.maxStraightPathPoints; i++) out.push(new THREE.Vector3());
    const crates = L.dock.crates.filter((c) => c.dynamic);
    const goals = [level.spawn.position.clone()];
    for (const s of L.spaces) {
      const c = rectCenter(s.rects[0]!);
      const g = new THREE.Vector3();
      if (nav.closestPoint({ x: c.x, y: 0, z: c.z }, g)) goals.push(g);
    }
    const from = new THREE.Vector3();
    for (const sp of level.spawnPoints ?? []) {
      expect(nav.closestPoint(sp.position, from), sp.id).toBe(true);
      for (const goal of goals) {
        const n = nav.findPath(from, goal, out);
        for (let i = 1; i < n; i++) {
          const a = out[i - 1]!;
          const b = out[i]!;
          for (const c of crates) {
            // Crate footprint (any yaw) + a swarmer's radius.
            const clearance = (c.size * Math.SQRT2) / 2 + 0.35;
            const d = segmentPointDistanceXZ(a, b, c.position[0], c.position[2]);
            // Only segments at the crate's level (floor vs. platform) matter.
            if (Math.abs(Math.min(a.y, b.y) - (c.position[1] - c.size / 2)) > 0.5) continue;
            expect(d, `${sp.id} → crate @${c.position.join(',')}`).toBeGreaterThan(clearance);
          }
        }
      }
    }
  });

  it('pulses the tear nearest to a spawned enemy', () => {
    const sp = level.spawnPoints![0]!;
    events.emit('enemy:spawned', { id: 1, type: 'swarmer', position: sp.position, elite: false });
    level.update(0, 1);
    // Internal: the tear field is the instanced mesh named SpawnRifts.
    const field = level.root.getObjectByName('SpawnRifts') as THREE.InstancedMesh;
    const attr = field.geometry.getAttribute('aTear') as THREE.InstancedBufferAttribute;
    expect(attr.getY(0)).toBeGreaterThan(0.5);
    expect(RIFT_PORTAL.small.spawnPulse).toBeGreaterThan(0);
    level.update(10, 11);
    expect(attr.getY(0)).toBe(0);
  });

  it('exposes M4 door slots between different zones and a wall-buy slot', () => {
    expect(level.doorSlots.length).toBe(L.doorways.filter((d) => d.slot).length);
    for (const d of level.doorSlots) {
      expect(d.zoneA).not.toBe(d.zoneB);
      expect(d.width).toBeGreaterThanOrEqual(2.4);
      expect(d.costHint).toBeGreaterThan(0);
      // Walking `facing` from the slot leads into zoneB.
      const n = facingNormal(d.facing);
      const into = level.zoneAt(d.position.x + n.x * 1.5, d.position.z + n.z * 1.5);
      const back = level.zoneAt(d.position.x - n.x * 1.5, d.position.z - n.z * 1.5);
      expect(into, d.id).toBe(d.zoneB);
      expect(back, d.id).toBe(d.zoneA);
    }
    expect(level.wallBuySlots.length).toBeGreaterThan(0);
    expect(level.hasVolumetricContent).toBe(true);
  });
});

function segmentPointDistanceXZ(a: THREE.Vector3, b: THREE.Vector3, x: number, z: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}
