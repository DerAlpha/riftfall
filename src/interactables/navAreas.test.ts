/**
 * Door gating on the navmesh (NavSystem.setAreaBlocked): blocked areas are split off exactly at
 * their box and excluded from paths, snapping, random points, walkability and crowd agents – on
 * the small nav test level and on every door slot of the research lab.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import type { AssetsApi, MaterialLibraryApi, RenderApi, SettingsStore } from '../core/contracts';
import { buildResearchLab } from '../maps/lab/ResearchLab';
import { isMapLevel, type DoorSlotDef, type MapLevelInstance } from '../maps/types';
import { NavSystem } from '../nav/NavSystem';
import { buildTestLevelMeshes, disposeMeshes } from '../nav/testLevel';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createDefaultSettings } from '../save/settingsSchema';
import { doorNavBox } from './shapes';

const DT = 1 / 60;
const AGENT = { radius: 0.35, height: 0.8, maxSpeed: 6, maxAcceleration: 30 };

function pathEnd(
  nav: NavSystem,
  from: Vec3Like,
  to: Vec3Like,
): { n: number; end: THREE.Vector3; corners: THREE.Vector3[] } {
  const out: THREE.Vector3[] = [];
  const n = nav.findPath(from, to, out);
  return {
    n,
    end: n > 0 ? out[n - 1]!.clone() : new THREE.Vector3(Infinity, 0, Infinity),
    corners: out.slice(0, n),
  };
}

function reaches(nav: NavSystem, from: Vec3Like, to: Vec3Like, tolerance = 0.5): boolean {
  const { end } = pathEnd(nav, from, to);
  return Math.hypot(end.x - to.x, end.z - to.z) < tolerance;
}

describe('blocked nav areas on the test level', () => {
  let meshes: THREE.Mesh[];
  let nav: NavSystem;
  // The gap between the wall's west end (x −6) and the floor edge (x −10): the only way from the
  // south half to the north half (the east side is taken by the ramp to platform A).
  const gap = { c: { x: -8, y: 0.5, z: 0 }, h: { x: 2.3, y: 1, z: 0.9 } };
  // A block on the open floor south of the wall.
  const pillar = { c: { x: 0, y: 0.5, z: -3.5 }, h: { x: 0.8, y: 1, z: 2.9 } };
  const A = { x: 0, y: 0, z: -4 };
  const B = { x: 0, y: 0, z: 4 };

  beforeAll(async () => {
    meshes = buildTestLevelMeshes();
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(meshes)).toBe(true);
  }, 30000);

  afterAll(() => {
    nav?.dispose();
    if (meshes) disposeMeshes(meshes);
  });

  it('seals a gap while blocked and reopens it instantly', () => {
    expect(reaches(nav, A, B)).toBe(true);
    nav.setAreaBlocked(gap.c, gap.h, true);
    nav.flushAreas();
    expect(nav.blockedAreaCount).toBe(1);
    expect(reaches(nav, A, B)).toBe(false);
    expect(nav.walkable({ x: -8, y: 0, z: -3 }, { x: -8, y: 0, z: 3 })).toBe(false);
    nav.setAreaBlocked(gap.c, gap.h, false);
    expect(reaches(nav, A, B)).toBe(true);
    expect(nav.walkable({ x: -8, y: 0, z: -3 }, { x: -8, y: 0, z: 3 })).toBe(true);
  });

  it('paths go around a blocked box on open floor', () => {
    const from = { x: -3, y: 0, z: -3 };
    const to = { x: 3, y: 0, z: -3 };
    expect(pathEnd(nav, from, to).n).toBe(2);
    nav.setAreaBlocked(pillar.c, pillar.h, true);
    nav.flushAreas();
    const p = pathEnd(nav, from, to);
    expect(reaches(nav, from, to)).toBe(true);
    expect(p.n).toBeGreaterThan(2);
    // No corner inside the box.
    for (const c of p.corners) {
      const inside =
        Math.abs(c.x - pillar.c.x) < pillar.h.x - 0.05 && Math.abs(c.z - pillar.c.z) < pillar.h.z - 0.05;
      expect(inside).toBe(false);
    }
    nav.setAreaBlocked(pillar.c, pillar.h, false);
    expect(pathEnd(nav, from, to).n).toBe(2);
  });

  it('only blocks inside the box (polygons are split at the area)', () => {
    nav.setAreaBlocked(pillar.c, pillar.h, true);
    const out = new THREE.Vector3();
    // Just outside the box the floor stays walkable and snaps to itself.
    expect(nav.closestPoint({ x: 1.4, y: 0, z: -3.5 }, out)).toBe(true);
    expect(Math.hypot(out.x - 1.4, out.z + 3.5)).toBeLessThan(0.05);
    // Inside the box snapping lands outside it.
    expect(nav.closestPoint({ x: 0.2, y: 0, z: -3.5 }, out)).toBe(true);
    expect(Math.abs(out.x)).toBeGreaterThanOrEqual(pillar.h.x - 0.05);
    for (let i = 0; i < 200; i++) {
      nav.randomPointAround({ x: 0, y: 0, z: -3.5 }, 3, out);
      const inside =
        Math.abs(out.x - pillar.c.x) < pillar.h.x - 0.05 && Math.abs(out.z - pillar.c.z) < pillar.h.z - 0.05;
      expect(inside).toBe(false);
    }
    nav.setAreaBlocked(pillar.c, pillar.h, false);
  });

  it('keeps crowd agents out of blocked areas', () => {
    nav.setAreaBlocked(gap.c, gap.h, true);
    const id = nav.addAgent(A, AGENT);
    expect(id).toBeGreaterThanOrEqual(0);
    nav.setAgentTarget(id, B);
    const p = new THREE.Vector3();
    for (let i = 0; i < 60 * 6; i++) nav.update(DT);
    nav.getAgentPosition(id, p);
    expect(p.z).toBeLessThan(0);
    // Opening the gap lets it through (the goal is re-sent like the AI does every tick).
    nav.setAreaBlocked(gap.c, gap.h, false);
    for (let i = 0; i < 60 * 8; i++) {
      nav.setAgentTarget(id, B);
      nav.update(DT);
    }
    nav.getAgentPosition(id, p);
    expect(p.z).toBeGreaterThan(2);
    nav.removeAgent(id);
  });

  it('overlapping areas keep their own state (a door opening beside a machine)', () => {
    // A doorway box and a machine footprint (always blocked, grown by the agent radius) overlapping
    // it by 0.2 m (the lab's reception door beside a perk machine). Recast used to merge both into
    // shared polygons: opening the door opened the machine footprint too. The strip where the boxes
    // overlap may go either way (a voxel or so), the machine itself must stay closed.
    const door = { c: { x: 5, y: 0.5, z: -1.9 }, h: { x: 1.2, y: 1, z: 0.9 } };
    const machine = { c: { x: 5, y: 0.5, z: -3.5 }, h: { x: 0.8, y: 1, z: 0.9 } };
    const strip = 0.3;
    const insideMachine = (p: Vec3Like): boolean =>
      Math.abs(p.x - machine.c.x) < machine.h.x - strip && Math.abs(p.z - machine.c.z) < machine.h.z - strip;
    nav.setAreaBlocked(door.c, door.h, true);
    nav.setAreaBlocked(machine.c, machine.h, true);
    nav.flushAreas();
    nav.setAreaBlocked(door.c, door.h, false);
    const out = new THREE.Vector3();
    // The opened doorway is walkable again…
    expect(nav.closestPoint({ x: 5, y: 0, z: -1.4 }, out)).toBe(true);
    expect(Math.hypot(out.x - 5, out.z + 1.4)).toBeLessThan(0.05);
    // …the machine footprint is not: nothing snaps, samples or paths into it.
    for (const probe of [
      { x: 5, y: 0, z: -3.5 },
      { x: 4.6, y: 0, z: -3.2 },
      { x: 5.4, y: 0, z: -3.1 },
      { x: 5, y: 0, z: -2.95 },
    ]) {
      expect(nav.closestPoint(probe, out)).toBe(true);
      expect(insideMachine(out)).toBe(false);
    }
    for (let i = 0; i < 200; i++) {
      nav.randomPointAround({ x: 5, y: 0, z: -3 }, 2, out);
      expect(insideMachine(out)).toBe(false);
    }
    expect(nav.walkable({ x: 5, y: 0, z: -1.4 }, { x: 5, y: 0, z: -3.5 })).toBe(false);
    // Closing the door again blocks it without touching the machine.
    nav.setAreaBlocked(door.c, door.h, true);
    expect(nav.closestPoint({ x: 5, y: 0, z: -1.9 }, out)).toBe(true);
    expect(Math.abs(out.z + 1.9) > door.h.z - strip || Math.abs(out.x - 5) > door.h.x - strip).toBe(true);
    nav.setAreaBlocked(door.c, door.h, false);
  });

  it('re-applies areas after a rebuild', async () => {
    nav.setAreaBlocked(gap.c, gap.h, true);
    expect(await nav.build(meshes)).toBe(true);
    expect(reaches(nav, A, B)).toBe(false);
    nav.setAreaBlocked(gap.c, gap.h, false);
    expect(reaches(nav, A, B)).toBe(true);
  }, 30000);
});

describe('door slots of the research lab', () => {
  let physics: PhysicsWorld;
  let level: MapLevelInstance;
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
    const built = await buildResearchLab({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events: new EventBus<GameEvents>(),
      onProgress() {},
    });
    if (!isMapLevel(built)) throw new Error('lab is a map level');
    level = built;
    nav = new NavSystem({ createWorker: null });
    for (const d of level.doorSlots) {
      const b = doorNavBox(d);
      nav.setAreaBlocked(b.center, b.half, true);
    }
    expect(await nav.build(level.navSources ? [...level.navSources] : [])).toBe(true);
  }, 60000);

  afterAll(() => {
    nav?.dispose();
    level?.dispose();
    physics?.dispose();
  });

  const spawn = { x: 0, y: 0, z: 24 };
  const atrium = { x: -9, y: 0, z: -2 };
  const labs = { x: -27, y: 0, z: -12 };
  const dock = { x: -3, y: 0, z: -24 };

  function slot(id: string): DoorSlotDef {
    return level.doorSlots.find((d) => d.id === id)!;
  }

  function setOpen(id: string, open: boolean): void {
    const b = doorNavBox(slot(id));
    nav.setAreaBlocked(b.center, b.half, !open);
  }

  it('closed doors seal the reception', () => {
    expect(reaches(nav, spawn, atrium)).toBe(false);
    expect(reaches(nav, spawn, labs)).toBe(false);
    // The reception itself stays connected.
    expect(reaches(nav, spawn, { x: -7, y: 0, z: 21 })).toBe(true);
  });

  it('each purchase opens exactly the paths through its door', () => {
    setOpen('door_reception_atrium', true);
    expect(reaches(nav, spawn, atrium)).toBe(true);
    expect(reaches(nav, spawn, labs)).toBe(false);
    expect(reaches(nav, spawn, dock)).toBe(false);
    setOpen('door_atrium_labs', true);
    expect(reaches(nav, spawn, labs)).toBe(true);
    setOpen('door_atrium_dock', true);
    expect(reaches(nav, spawn, dock)).toBe(true);
    // Closing again (new run) seals everything.
    for (const d of level.doorSlots) setOpen(d.id, false);
    expect(reaches(nav, spawn, atrium)).toBe(false);
    expect(reaches(nav, spawn, labs)).toBe(false);
  });

  it('blocks only the doorway, not the rooms beside it', () => {
    // The atrium-side floor right in front of the west door stays walkable (polygons were split).
    const out = new THREE.Vector3();
    const d = slot('door_atrium_labs');
    const b = doorNavBox(d);
    const probe = { x: d.position.x + b.half.x + 0.6, y: 0, z: d.position.z };
    expect(nav.closestPoint(probe, out)).toBe(true);
    expect(Math.hypot(out.x - probe.x, out.z - probe.z)).toBeLessThan(0.05);
    expect(reaches(nav, { x: 0, y: 0, z: 8 }, atrium)).toBe(true);
  });
});
