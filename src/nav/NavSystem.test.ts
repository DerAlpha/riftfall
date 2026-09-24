/**
 * NavSystem in node: recast's wasm-compat build runs here, there is no Worker, so build() takes
 * the main-thread path (a fake worker covers the worker protocol). Level: nav/testLevel.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { exportNavMesh } from 'recast-navigation';
import type { NavAgentParams } from '../core/contracts';
import { NAV } from '../defs/nav';
import {
  createGeneratorConfig,
  generateNavMesh,
  type NavBuildRequest,
  type NavBuildResponse,
} from './navBuild';
import { NavSystem } from './NavSystem';
import { buildTestLevelMeshes, disposeMeshes, TEST_LEVEL } from './testLevel';
import { ensureRecast } from './recast';

const DT = 1 / 60;
const AGENT: NavAgentParams = { radius: 0.4, height: 1.8, maxSpeed: 5, maxAcceleration: 20 };
/** Navmesh heights are quantized to the voxel height; points come out within this of the floor. */
const HEIGHT_TOL = NAV.build.cellHeight * 1.5;

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function pathLength(points: THREE.Vector3[], count: number): number {
  let len = 0;
  for (let i = 1; i < count; i++) len += points[i]!.distanceTo(points[i - 1]!);
  return len;
}

function run(nav: NavSystem, ticks: number, each?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    nav.update(DT);
    each?.();
  }
}

describe('NavSystem (main-thread build)', () => {
  const meshes = buildTestLevelMeshes();
  let nav: NavSystem;

  beforeAll(async () => {
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(meshes)).toBe(true);
  });

  afterAll(() => {
    nav.dispose();
    disposeMeshes(meshes);
  });

  it('builds a navmesh on the main thread', () => {
    expect(nav.ready).toBe(true);
    expect(nav.stats.mode).toBe('navmesh');
    expect(nav.stats.builtIn).toBe('main');
    expect(nav.stats.polys).toBeGreaterThan(4);
    expect(nav.stats.tiles).toBeGreaterThan(1);
    expect(nav.stats.buildMs).toBeGreaterThan(0);
  });

  it('snaps points to the floor and rejects points out of reach', () => {
    const out = new THREE.Vector3();
    expect(nav.closestPoint(v(3, 0.8, -3), out)).toBe(true);
    expect(out.x).toBeCloseTo(3, 1);
    expect(out.z).toBeCloseTo(-3, 1);
    expect(Math.abs(out.y)).toBeLessThan(HEIGHT_TOL);
    expect(nav.closestPoint(v(50, 0, 50), out)).toBe(false);
    // Inside the wall: snapped out to the eroded edge (agent radius from the wall face).
    expect(nav.closestPoint(v(0, 0, 0), out)).toBe(true);
    expect(Math.abs(out.z)).toBeGreaterThanOrEqual(0.2 + NAV.build.agentRadius - 0.05);
  });

  it('skips navIgnore meshes (no island on the floating slab)', () => {
    const out = new THREE.Vector3();
    const p = TEST_LEVEL.ignored;
    expect(nav.closestPoint(v(p.x, p.y + 0.1, p.z), out)).toBe(false);
  });

  it('finds a path around the wall', () => {
    const out: THREE.Vector3[] = [];
    const n = nav.findPath(v(0, 0, -4), v(0, 0, 4), out);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(out[0]!.distanceTo(v(0, 0, -4))).toBeLessThan(0.1);
    expect(out[n - 1]!.distanceTo(v(0, 0, 4))).toBeLessThan(0.1);
    // A corner beyond the wall end, and longer than the blocked straight line.
    expect(out.slice(0, n).some((p) => Math.abs(p.x) > TEST_LEVEL.wallHalfLength)).toBe(true);
    expect(pathLength(out, n)).toBeGreaterThan(12);
    for (let i = 0; i < n; i++) expect(Math.abs(out[i]!.y)).toBeLessThan(HEIGHT_TOL);
    // Reuses the output vectors.
    const first = out[0];
    nav.findPath(v(1, 0, -4), v(0, 0, 4), out);
    expect(out[0]).toBe(first);
  });

  it('paths up the ramp and the stairs onto the platforms', () => {
    const out: THREE.Vector3[] = [];
    const a = TEST_LEVEL.platformA;
    let n = nav.findPath(v(7, 0, -3), v(a.x, a.top, a.z), out);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(out[n - 1]!.distanceTo(v(a.x, a.top, a.z))).toBeLessThan(0.15);
    const b = TEST_LEVEL.platformB;
    n = nav.findPath(v(-7, 0, -3), v(b.x, b.top, b.z), out);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(out[n - 1]!.distanceTo(v(b.x, b.top, b.z))).toBeLessThan(0.15);
  });

  it('returns the partial path towards an unreachable target', () => {
    const out: THREE.Vector3[] = [];
    const c = TEST_LEVEL.blockC;
    const n = nav.findPath(v(0, 0, -4), v(c.x, c.top, c.z), out);
    expect(n).toBeGreaterThanOrEqual(2);
    const end = out[n - 1]!;
    expect(Math.abs(end.y)).toBeLessThan(HEIGHT_TOL);
    expect(Math.hypot(end.x - c.x, end.z - c.z)).toBeLessThan(2.5);
    expect(nav.walkable(v(0, 0, -4), v(c.x, c.top, c.z))).toBe(false);
    // Nothing within the search box at all: no path.
    expect(nav.findPath(v(0, 0, -4), v(50, 0, -4), out)).toBe(0);
  });

  it('checks straight walkability (walls, ledges, ramps)', () => {
    expect(nav.walkable(v(-8, 0, -4), v(8, 0, -4))).toBe(true);
    expect(nav.walkable(v(0, 0, -4), v(0, 0, 4))).toBe(false);
    // Straight up the ramp onto platform A.
    expect(nav.walkable(v(7, 0, -3), v(7, 2, 7))).toBe(true);
    // From the floor beside platform A onto its top: the platform's side is in the way.
    expect(nav.walkable(v(2, 0, 7), v(7, 2, 7))).toBe(false);
    expect(nav.walkable(v(7, 2, 7), v(2, 0, 7))).toBe(false);
  });

  it('rejects walkable lines that end inside walls or past ledges', () => {
    const tol = NAV.query.walkableSnapTolerance;
    // Wall face at z = -0.2, walkable edge at z = -0.6 (agent radius).
    expect(nav.walkable(v(-2, 0, -4), v(-2, 0, -0.1))).toBe(false);
    // Knockback / charge probe steps: beyond the tolerance past the edge → blocked.
    expect(nav.walkable(v(-2, 0, -0.7), v(-2, 0, -0.6 + tol + 0.05))).toBe(false);
    // A player hugging the wall (just inside the eroded band) is still reachable.
    expect(nav.walkable(v(-2, 0, -4), v(-2, 0, -0.6 + tol - 0.05))).toBe(true);
    // Off the edge of platform A (the snap pulls the end back onto the platform).
    const a = TEST_LEVEL.platformA;
    expect(nav.walkable(v(a.x, a.top, a.z), v(a.x - 3, a.top, a.z))).toBe(false);
  });

  it('tells navmesh layers apart (floor under a deck vs. the deck)', () => {
    expect((nav as unknown as { query: { recordsRayPath: boolean } }).query.recordsRayPath).toBe(true);
    const d = TEST_LEVEL.deckD;
    const floor = v(d.x - 2, 0, d.z);
    const deck = v(d.x + 2, d.top, d.z);
    // 4 m apart, 2.6 m up: a plausible ramp by slope, but the lines run on different layers.
    expect(nav.walkable(floor, deck)).toBe(false);
    expect(nav.walkable(deck, floor)).toBe(false);
    expect(nav.walkable(floor, v(d.x + 2, 0, d.z))).toBe(true);
    expect(nav.walkable(v(d.x - 2, d.top, d.z), deck)).toBe(true);
  });

  it('finds random points around a center on the navmesh', () => {
    const out = new THREE.Vector3();
    const snapped = new THREE.Vector3();
    const c = v(-5, 0, -5);
    for (let i = 0; i < 20; i++) {
      expect(nav.randomPointAround(c, 2, out)).toBe(true);
      expect(Math.hypot(out.x - c.x, out.z - c.z)).toBeLessThanOrEqual(2 + 1e-3);
      expect(Math.abs(out.y)).toBeLessThan(HEIGHT_TOL);
      expect(nav.closestPoint(out, snapped)).toBe(true);
      expect(snapped.distanceTo(out)).toBeLessThan(0.05);
    }
  });

  it('keeps random points inside small circles (big polygons), clipped at walls', () => {
    const out = new THREE.Vector3();
    const snapped = new THREE.Vector3();
    // Open floor: detour's polygons there are far bigger than the circle.
    for (const r of [0, 0.5, 1]) {
      for (let i = 0; i < 40; i++) {
        expect(nav.randomPointAround(v(-5, 0, -3), r, out)).toBe(true);
        expect(Math.hypot(out.x + 5, out.z + 3)).toBeLessThanOrEqual(r + 1e-3);
        expect(Math.abs(out.y)).toBeLessThan(HEIGHT_TOL);
      }
    }
    // Next to the wall: never beyond its walkable edge, never on the other side.
    for (let i = 0; i < 60; i++) {
      expect(nav.randomPointAround(v(-2, 0, -1), 1.5, out)).toBe(true);
      expect(out.z).toBeLessThan(-0.55);
      expect(nav.closestPoint(out, snapped)).toBe(true);
      expect(Math.hypot(snapped.x - out.x, snapped.z - out.z)).toBeLessThan(0.02);
    }
  });

  it('draws the same random points for the same seed', () => {
    const sample = (seed: string | number): number[] => {
      nav.setRandomSeed(seed);
      const out = new THREE.Vector3();
      const xs: number[] = [];
      for (let i = 0; i < 5; i++) {
        nav.randomPointAround(v(-5, 0, -3), 0.5, out);
        xs.push(out.x, out.z);
        nav.randomPointAround(v(0, 0, -4), 4, out);
        xs.push(out.x, out.z);
      }
      return xs;
    };
    expect(sample(1234)).toEqual(sample(1234));
    expect(sample('daily:2026-09-23')).toEqual(sample('daily:2026-09-23'));
    expect(sample('daily:2026-09-23')).not.toEqual(sample(1234));
  });

  it('moves a crowd agent around the wall to its target', () => {
    const id = nav.addAgent(v(0, 0, -4), AGENT);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(nav.stats.agents).toBe(1);
    const target = v(0, 0, 4);
    nav.setAgentTarget(id, target);
    const p = new THREE.Vector3();
    const vel = new THREE.Vector3();
    let maxSpeed = 0;
    let crossedWall = false;
    run(nav, 600, () => {
      nav.getAgentPosition(id, p);
      nav.getAgentVelocity(id, vel);
      maxSpeed = Math.max(maxSpeed, Math.hypot(vel.x, vel.z));
      if (Math.abs(p.z) < 0.2 && Math.abs(p.x) < TEST_LEVEL.wallHalfLength) crossedWall = true;
    });
    nav.getAgentPosition(id, p);
    expect(p.distanceTo(target)).toBeLessThan(0.6);
    expect(crossedWall).toBe(false);
    expect(maxSpeed).toBeLessThanOrEqual(AGENT.maxSpeed + 0.01);
    expect(maxSpeed).toBeGreaterThan(AGENT.maxSpeed * 0.8);
    nav.removeAgent(id);
    expect(nav.stats.agents).toBe(0);
  });

  it('climbs the stairs with a crowd agent', () => {
    const b = TEST_LEVEL.platformB;
    const id = nav.addAgent(v(-7, 0, -3), AGENT);
    nav.setAgentTarget(id, v(b.x, b.top, b.z));
    run(nav, 600);
    const p = nav.getAgentPosition(id, new THREE.Vector3());
    expect(p.distanceTo(v(b.x, b.top, b.z))).toBeLessThan(0.6);
    nav.removeAgent(id);
  });

  it('stops, re-speeds and teleports agents', () => {
    const id = nav.addAgent(v(-8, 0, -8), AGENT);
    nav.setAgentTarget(id, v(8, 0, -3));
    run(nav, 30);
    nav.stopAgent(id);
    run(nav, 60);
    const vel = nav.getAgentVelocity(id, new THREE.Vector3());
    expect(Math.hypot(vel.x, vel.z)).toBeLessThan(0.05);

    nav.setAgentMaxSpeed(id, 2);
    nav.setAgentTarget(id, v(8, 0, -3));
    let top = 0;
    run(nav, 120, () => {
      nav.getAgentVelocity(id, vel);
      top = Math.max(top, Math.hypot(vel.x, vel.z));
    });
    expect(top).toBeLessThanOrEqual(2.01);
    expect(top).toBeGreaterThan(1.5);

    nav.teleportAgent(id, v(-2, 0, 8));
    const p = nav.getAgentPosition(id, new THREE.Vector3());
    expect(Math.hypot(p.x + 2, p.z - 8)).toBeLessThan(0.1);
    // Into the wall: lands on the walkable edge instead (agent radius off the wall face).
    nav.teleportAgent(id, v(-2, 0, 0.1));
    nav.getAgentPosition(id, p);
    expect(p.x).toBeCloseTo(-2, 2);
    expect(p.z).toBeGreaterThanOrEqual(0.2 + NAV.build.agentRadius - 0.05);
    nav.teleportAgent(id, v(-2, 0, 8));
    // The goal survives the teleport: the agent heads back to it (around the wall).
    nav.setAgentMaxSpeed(id, AGENT.maxSpeed);
    run(nav, 600);
    nav.getAgentPosition(id, p);
    expect(p.distanceTo(v(8, 0, -3))).toBeLessThan(0.6);
    nav.removeAgent(id);
  });

  it('throttles move requests for a goal that barely moves', () => {
    const id = nav.addAgent(v(-8, 0, -3), AGENT);
    const crowd = (nav as unknown as { backend: { requestsSent: number } }).backend;
    const before = crowd.requestsSent;
    const goal = v(8, 0, -3);
    run(nav, 60, () => {
      goal.x += 0.001;
      nav.setAgentTarget(id, goal);
    });
    expect(crowd.requestsSent - before).toBe(1);
    goal.z += 3;
    nav.setAgentTarget(id, goal);
    run(nav, 1);
    expect(crowd.requestsSent - before).toBe(2);
    nav.removeAgent(id);
  });

  it('staggers a burst of move requests over several ticks', () => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++)
      ids.push(nav.addAgent(v(-9 + (i % 10) * 1.3, 0, -9 + Math.floor(i / 10) * 1.5), AGENT));
    expect(ids.every((id) => id >= 0)).toBe(true);
    for (const id of ids) nav.setAgentTarget(id, v(0, 0, 8));
    nav.update(DT);
    expect(nav.stats.pendingTargets).toBe(30 - NAV.crowd.maxTargetRequestsPerTick);
    run(nav, 2);
    expect(nav.stats.pendingTargets).toBe(0);
    run(nav, 900);
    const p = new THREE.Vector3();
    let near = 0;
    for (const id of ids) if (nav.getAgentPosition(id, p).distanceTo(v(0, 0, 8)) < 4) near++;
    expect(near).toBeGreaterThanOrEqual(26);
    for (const id of ids) nav.removeAgent(id);
    expect(nav.stats.agents).toBe(0);
  });

  it('rejects off-mesh spawns and ignores unknown ids / non-finite input', () => {
    expect(nav.addAgent(v(60, 0, 60), AGENT)).toBe(-1);
    expect(nav.addAgent(v(Number.NaN, 0, 0), AGENT)).toBe(-1);
    expect(nav.addAgent(v(-8, 0, -3), { ...AGENT, maxSpeed: Number.NaN })).toBe(-1);
    expect(nav.addAgent(v(-8, 0, -3), { ...AGENT, separationWeight: Number.POSITIVE_INFINITY })).toBe(-1);
    expect(nav.stats.agents).toBe(0);
    const id = nav.addAgent(v(-8, 0, -3), AGENT);
    nav.setAgentTarget(id, v(Number.POSITIVE_INFINITY, 0, 0));
    nav.setAgentMaxSpeed(id, Number.NaN);
    nav.teleportAgent(id, v(0, Number.NaN, 0));
    run(nav, 5);
    const p = nav.getAgentPosition(id, new THREE.Vector3());
    expect(p.distanceTo(v(-8, 0, -3))).toBeLessThan(0.05);
    // The NaN speed was ignored: the agent still walks (finite) at its speed.
    nav.setAgentTarget(id, v(-8, 0, -7));
    run(nav, 60);
    nav.getAgentPosition(id, p);
    expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
    expect(p.distanceTo(v(-8, 0, -3))).toBeGreaterThan(1);
    nav.removeAgent(id);
    expect(() => {
      nav.setAgentTarget(99, v(0, 0, 0));
      nav.stopAgent(-1);
      nav.removeAgent(1.5);
      nav.teleportAgent(1000, v(0, 0, 0));
    }).not.toThrow();
    const out = v(1, 2, 3);
    expect(nav.getAgentPosition(42, out)).toBe(out);
    expect(out.toArray()).toEqual([1, 2, 3]);
  });

  it('shows and hides the debug navmesh', async () => {
    const scene = new THREE.Scene();
    nav.setDebugVisible(true, scene);
    await vi.waitFor(() => expect(scene.getObjectByName('nav:debug')).toBeDefined());
    const helper = scene.getObjectByName('nav:debug')!;
    const mesh = helper.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(3);
    nav.setDebugVisible(false, scene);
    expect(scene.getObjectByName('nav:debug')).toBeUndefined();
  });
});

describe('NavSystem lifecycle', () => {
  it('keeps agents (ids, goals) across the navmesh build', async () => {
    const meshes = buildTestLevelMeshes();
    const nav = new NavSystem({ createWorker: null });
    const id = nav.addAgent(v(0, 0, -4), AGENT);
    expect(nav.stats.mode).toBe('direct');
    nav.setAgentTarget(id, v(0, 0, 4));
    expect(await nav.build(meshes)).toBe(true);
    expect(nav.stats.agents).toBe(1);
    const p = new THREE.Vector3();
    let crossedWall = false;
    run(nav, 600, () => {
      nav.getAgentPosition(id, p);
      if (Math.abs(p.z) < 0.2 && Math.abs(p.x) < TEST_LEVEL.wallHalfLength) crossedWall = true;
    });
    expect(p.distanceTo(v(0, 0, 4))).toBeLessThan(0.6);
    expect(crossedWall).toBe(false);
    nav.dispose();
    disposeMeshes(meshes);
  });

  it('falls back to direct steering when there is nothing to build', async () => {
    const nav = new NavSystem({ createWorker: null });
    expect(await nav.build([])).toBe(false);
    expect(nav.ready).toBe(false);
    const id = nav.addAgent(v(0, 0, 0), AGENT);
    nav.setAgentTarget(id, v(5, 0, 0));
    run(nav, 180);
    expect(nav.getAgentPosition(id, new THREE.Vector3()).distanceTo(v(5, 0, 0))).toBeLessThan(0.5);
    // Fallback queries are optimistic.
    const out: THREE.Vector3[] = [];
    expect(nav.findPath(v(0, 0, 0), v(3, 0, 3), out)).toBe(2);
    expect(nav.walkable(v(0, 0, 0), v(3, 0, 3))).toBe(true);
    const pt = new THREE.Vector3();
    expect(nav.closestPoint(v(1, 2, 3), pt)).toBe(true);
    expect(pt.toArray()).toEqual([1, 2, 3]);
    expect(nav.randomPointAround(v(0, 0, 0), 2, pt)).toBe(true);
    expect(Math.hypot(pt.x, pt.z)).toBeLessThanOrEqual(2);
    nav.dispose();
  });

  it('drops fallback points onto the ground probe', () => {
    const nav = new NavSystem({ createWorker: null, groundProbe: () => 1.25 });
    const pt = new THREE.Vector3();
    nav.closestPoint(v(1, 3, 1), pt);
    expect(pt.y).toBe(1.25);
    nav.dispose();
  });

  it('imports a navmesh built by the worker', async () => {
    await ensureRecast();
    const meshes = buildTestLevelMeshes();
    /** In-process stand-in for navWorker.ts (same protocol). */
    class FakeWorker {
      onmessage: ((e: MessageEvent<NavBuildResponse>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      postMessage(req: NavBuildRequest): void {
        setTimeout(() => {
          const res = generateNavMesh(req.positions, req.indices, req.config);
          if (!res.navMesh) throw new Error(res.error);
          const data = exportNavMesh(res.navMesh);
          res.navMesh.destroy();
          this.onmessage?.({ data: { id: req.id, ok: true, data, ms: 1 } } as MessageEvent<NavBuildResponse>);
        }, 0);
      }
      terminate(): void {
        this.terminated = true;
      }
    }
    const worker = new FakeWorker();
    const nav = new NavSystem({ createWorker: () => worker as unknown as Worker });
    expect(await nav.build(meshes)).toBe(true);
    expect(nav.stats.builtIn).toBe('worker');
    expect(worker.terminated).toBe(true);
    const out: THREE.Vector3[] = [];
    expect(nav.findPath(v(0, 0, -4), v(0, 0, 4), out)).toBeGreaterThanOrEqual(3);
    nav.dispose();
    disposeMeshes(meshes);
  });

  it('builds on the main thread when the worker fails', async () => {
    const meshes = buildTestLevelMeshes();
    const failing = {
      onmessage: null as ((e: MessageEvent<NavBuildResponse>) => void) | null,
      onerror: null as ((e: ErrorEvent) => void) | null,
      onmessageerror: null,
      postMessage(): void {
        setTimeout(() => this.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent), 0);
      },
      terminate(): void {},
    };
    const nav = new NavSystem({ createWorker: () => failing as unknown as Worker });
    expect(await nav.build(meshes)).toBe(true);
    expect(nav.stats.builtIn).toBe('main');
    nav.dispose();

    const throwing = new NavSystem({
      createWorker: () => {
        throw new Error('no workers here');
      },
    });
    expect(await throwing.build(meshes)).toBe(true);
    throwing.dispose();
    disposeMeshes(meshes);
  });

  it('is inert after dispose', async () => {
    const nav = new NavSystem({ createWorker: null });
    nav.dispose();
    expect(nav.addAgent(v(0, 0, 0), AGENT)).toBe(-1);
    expect(await nav.build(buildTestLevelMeshes())).toBe(false);
    expect(() => nav.update(DT)).not.toThrow();
  });

  it('uses the configured generator settings', () => {
    const cfg = createGeneratorConfig();
    expect(cfg.mode).toBe(NAV.build.mode);
  });
});
