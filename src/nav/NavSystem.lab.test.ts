/**
 * Navmesh + crowd on the M3 wave map (Forschungslabor), built in node with a stub material library
 * (like NavSystem.testroom.test): every spawn point must reach the player, the atrium ring deck
 * must be reachable by stairs / ramp and stay a separate layer from the floor below, and a full
 * wave (60 agents emerging from the spawn points) must converge on the player within the budget.
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
import { LAB_LAYOUT as L } from '../defs/labLayout';
import { NAV } from '../defs/nav';
import { buildResearchLab } from '../maps/lab/ResearchLab';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createDefaultSettings } from '../save/settingsSchema';
import { collectNavSources } from './navGeometry';
import { NavSystem } from './NavSystem';

const DT = 1 / 60;
const SWARMER: NavAgentParams = { radius: 0.35, height: 0.8, maxSpeed: 6.5, maxAcceleration: 30 };
const SPITTER: NavAgentParams = { radius: 0.4, height: 1.6, maxSpeed: 4, maxAcceleration: 16 };
const TANK: NavAgentParams = { radius: 0.9, height: 2.4, maxSpeed: 3, maxAcceleration: 12 };

describe('NavSystem on the research lab', () => {
  let physics: PhysicsWorld;
  let level: LevelInstance;
  let nav: NavSystem;

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
    level = await buildResearchLab({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events: new EventBus<GameEvents>(),
      onProgress() {},
    });
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(level.navSources ?? collectNavSources(level.root))).toBe(true);
  }, 60000);

  afterAll(() => {
    nav?.dispose();
    level?.dispose();
    physics?.dispose();
  });

  it('builds from the map nav sources (ceilings and roofs ignored)', () => {
    const sources = level.navSources ?? [];
    expect(sources.length).toBeGreaterThan(10);
    for (const m of sources) expect(m.userData[NAV.sources.ignoreFlag]).not.toBe(true);
    expect(nav.stats.polys).toBeGreaterThan(100);
    // Nothing walkable on the roof over the atrium.
    const out = new THREE.Vector3();
    const roof = L.spaces.find((s) => s.id === 'atrium')!.ceiling;
    expect(nav.closestPoint({ x: 0, y: roof + 0.5, z: -1 }, out)).toBe(false);
  });

  it('connects every spawn point to the player spawn', () => {
    const p = new THREE.Vector3();
    const out: THREE.Vector3[] = [];
    const spawn = new THREE.Vector3();
    expect(nav.closestPoint(level.spawn.position, spawn)).toBe(true);
    const points = level.spawnPoints ?? [];
    expect(points.length).toBeGreaterThan(5);
    for (const sp of points) {
      expect(nav.closestPoint(sp.position, p), sp.id).toBe(true);
      expect(Math.hypot(p.x - sp.position.x, p.z - sp.position.z), sp.id).toBeLessThan(0.5);
      const n = nav.findPath(p, spawn, out);
      expect(n, sp.id).toBeGreaterThanOrEqual(2);
      expect(out[n - 1]!.distanceTo(spawn), sp.id).toBeLessThan(0.3);
    }
  });

  it('reaches the atrium ring deck and keeps it apart from the floor below', () => {
    const ring = L.atrium.ring;
    const atrium = L.spaces.find((s) => s.id === 'atrium')!.rects[0]!;
    const northZ = atrium.minZ + ring.width / 2;
    const out: THREE.Vector3[] = [];
    const goals = [
      new THREE.Vector3(0, ring.deckY, northZ),
      new THREE.Vector3(atrium.minX + ring.width / 2, ring.deckY, -1),
      new THREE.Vector3(atrium.maxX - ring.width / 2, ring.deckY, 0),
    ];
    for (const goal of goals) {
      const n = nav.findPath(level.spawn.position, goal, out);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(out[n - 1]!.distanceTo(goal)).toBeLessThan(0.3);
    }
    // Floor under the north ring vs. the deck 6 m along it: slope-wise a ramp, but two layers.
    const floor = new THREE.Vector3(0, 0, northZ);
    const deck = new THREE.Vector3(6, ring.deckY, northZ);
    expect(nav.walkable(floor, deck)).toBe(false);
    expect(nav.walkable(deck, floor)).toBe(false);
    expect(nav.walkable(floor, new THREE.Vector3(6, 0, northZ))).toBe(true);
    expect(nav.walkable(new THREE.Vector3(0, ring.deckY, northZ), deck)).toBe(true);
  });

  it('brings a 60-enemy wave from the spawn points to the player within the tick budget', () => {
    const points = level.spawnPoints ?? [];
    const p = new THREE.Vector3();
    const ids: number[] = [];
    for (let i = 0; ids.length < 60 && i < 600; i++) {
      const sp = points[i % points.length]!;
      if (!nav.randomPointAround(sp.position, 2, p)) continue;
      const k = ids.length % 10;
      const id = nav.addAgent(p, k === 0 ? TANK : k < 4 ? SPITTER : SWARMER);
      if (id >= 0) ids.push(id);
    }
    expect(ids.length).toBe(60);

    // The player holds the atrium, strafing around the dais.
    const target = new THREE.Vector3();
    const center = L.atrium.center;
    const orbit = 7;
    let total = 0;
    let worst = 0;
    const ticks = 60 * 30;
    for (let t = 0; t < ticks; t++) {
      const a = t * DT * 0.3;
      target.set(center[0] + Math.cos(a) * orbit, 0, center[1] + Math.sin(a) * orbit);
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
      if (p.distanceTo(target) < 10) close++;
    }
    console.info(
      `[nav] lab wave, 60 agents: ${avg.toFixed(3)} ms/tick avg, ${worst.toFixed(2)} ms worst, ${close}/60 close`,
    );
    expect(close).toBeGreaterThanOrEqual(50);
    // Generous bound (CI machines vary): the M3 budget for AI + nav is 2.5 ms per tick.
    expect(avg).toBeLessThan(2.5);
    for (const id of ids) nav.removeAgent(id);
    expect(nav.stats.agents).toBe(0);
  });
});
