/**
 * Navmesh + crowd on the real Calibration Hall (built in node with a stub material library, like
 * TestRoom.test.ts): source selection, floor accuracy, stairs / ramp reachability of the
 * mezzanine, and 60 crowd agents chasing a moving target (logs the per-tick cost).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type {
  AssetsApi,
  LevelInstance,
  MaterialLibraryApi,
  NavAgentParams,
  RenderApi,
  SettingsStore,
} from '../core/contracts';
import { NAV } from '../defs/nav';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { TEST_ROOM_LAYOUT as L } from '../defs/level';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createDefaultSettings } from '../save/settingsSchema';
import { buildTestRoom } from '../world/TestRoom';
import { collectNavSources } from './navGeometry';
import { NavSystem } from './NavSystem';

const DT = 1 / 60;
const WORLD_RAY = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);
const SWARMER: NavAgentParams = { radius: 0.35, height: 1.2, maxSpeed: 6.5, maxAcceleration: 30 };
const TANK: NavAgentParams = { radius: 0.9, height: 2.4, maxSpeed: 3, maxAcceleration: 12 };

describe('NavSystem on the Calibration Hall', () => {
  let physics: PhysicsWorld;
  let level: LevelInstance;
  let nav: NavSystem;
  let sources: THREE.Mesh[];

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
    level = await buildTestRoom({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events: new EventBus<GameEvents>(),
      onProgress() {},
    });
    sources = collectNavSources(level.root);
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(level.navSources ?? sources)).toBe(true);
  }, 60000);

  afterAll(() => {
    nav?.dispose();
    level?.dispose();
    physics?.dispose();
  });

  it('builds from the static level meshes only', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const m of sources) expect(/^(level|panel):/.test(m.name)).toBe(true);
    expect(nav.stats.polys).toBeGreaterThan(100);
    expect(nav.stats.tiles).toBeGreaterThan(10);
  });

  it('puts grid-aligned floors exactly on the rendered floor', () => {
    const out = new THREE.Vector3();
    const errors: number[] = [];
    const r = L.arena.rect;
    for (let x = r.minX + 1; x <= r.maxX - 1; x += 1.7) {
      for (let z = r.minZ + 1; z <= r.maxZ - 1; z += 1.7) {
        if (!nav.closestPoint({ x, y: 0.5, z }, out)) continue;
        if (Math.hypot(out.x - x, out.z - z) > 0.01) continue;
        const hit = physics.raycast({ x, y: out.y + 0.3, z }, { x: 0, y: -1, z: 0 }, 1, {
          groups: WORLD_RAY,
        });
        if (hit && hit.normal.y > 0.99) errors.push(Math.abs(out.y - hit.point.y));
      }
    }
    expect(errors.length).toBeGreaterThan(50);
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length / 2)]!).toBeLessThan(0.005);
    expect(errors[Math.floor(errors.length * 0.9)]!).toBeLessThan(NAV.build.cellHeight * 1.5);
  });

  it('reaches the mezzanine deck from the spawn (stairs / ramp)', () => {
    const deck = (L.mezzanine.outer + L.mezzanine.inner) / 2;
    const out: THREE.Vector3[] = [];
    const goals = [
      new THREE.Vector3(3, L.mezzanine.deckY, -deck),
      new THREE.Vector3(-deck, L.mezzanine.deckY, 0),
      new THREE.Vector3(0, L.mezzanine.deckY, deck),
    ];
    for (const goal of goals) {
      const n = nav.findPath(level.spawn.position, goal, out);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(out[n - 1]!.distanceTo(goal)).toBeLessThan(0.3);
    }
    // Not in a straight line: the deck is 4.5 m up.
    expect(nav.walkable(level.spawn.position, goals[2]!)).toBe(false);
  });

  it('moves 60 crowd agents after a moving target within the tick budget', () => {
    const centers = [
      level.spawn.position.clone(),
      new THREE.Vector3(-20, 0, 0),
      new THREE.Vector3(0, 0, -20),
      new THREE.Vector3(18, 0, 0),
    ];
    const p = new THREE.Vector3();
    const ids: number[] = [];
    for (let i = 0; ids.length < 60 && i < 400; i++) {
      if (!nav.randomPointAround(centers[i % centers.length]!, 5, p)) continue;
      const id = nav.addAgent(p, ids.length % 10 === 0 ? TANK : SWARMER);
      if (id >= 0) ids.push(id);
    }
    expect(ids.length).toBe(60);

    const target = new THREE.Vector3();
    const radius = 7;
    const angularSpeed = 0.35;
    let total = 0;
    let worst = 0;
    const ticks = 1200;
    for (let t = 0; t < ticks; t++) {
      const a = t * DT * angularSpeed;
      target.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      for (const id of ids) nav.setAgentTarget(id, target);
      const t0 = performance.now();
      nav.update(DT);
      const ms = performance.now() - t0;
      total += ms;
      if (t > 60) worst = Math.max(worst, ms);
    }
    const avg = total / ticks;
    let close = 0;
    for (const id of ids) {
      nav.getAgentPosition(id, p);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      if (p.distanceTo(target) < 8) close++;
    }
    console.info(
      `[nav] 60 agents: ${avg.toFixed(3)} ms/tick avg, ${worst.toFixed(2)} ms worst, ${close}/60 close`,
    );
    expect(close).toBeGreaterThanOrEqual(45);
    // Generous bound (CI machines vary): the M3 budget for AI + nav is 2.5 ms per tick.
    expect(avg).toBeLessThan(2.5);
    for (const id of ids) nav.removeAgent(id);
    expect(nav.stats.agents).toBe(0);
  });
});
