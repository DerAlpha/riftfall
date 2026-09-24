/**
 * NavApi implementation: recast navmesh + detour crowd, with a direct-steering fallback.
 *
 * build(): level meshes → world-space triangles (navGeometry) → Web Worker (navWorker.ts)
 * generates a tiled navmesh and transfers the serialized bytes → importNavMesh here → NavQuery
 * (allocation-free queries) + NavCrowd (agents). Without a Worker (node/tests), or when it fails
 * or times out, the navmesh is generated on the main thread. build() never rejects: on failure it
 * logs, returns false and the agents keep running on DirectSteering.
 *
 * Agent ids are NavSystem slots, stable across backend swaps: agents added before the navmesh is
 * ready (or while a rebuild runs) are migrated with their position, params and goal.
 *
 * Fallback queries (no navmesh): closestPoint / randomPointAround return the point itself
 * (dropped onto the ground probe when one is given), findPath returns [from, to], walkable true.
 *
 * Tick: call update(dt) once per fixed tick (targets set during the previous tick are sent and
 * the crowd steps); positions read afterwards are this tick's.
 */
import { Mesh, MeshBasicMaterial, Vector3, type BufferGeometry, type Object3D } from 'three';
import { importNavMesh, setRandomSeed, type NavMesh } from 'recast-navigation';
import type { NavAgentParams, NavApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import { NAV } from '../defs/nav';
import { DirectSteering } from './DirectSteering';
import {
  countNavMeshPolys,
  createGeneratorConfig,
  generateNavMesh,
  type NavBuildRequest,
  type NavBuildResponse,
  type NavGeneratorConfig,
} from './navBuild';
import { NavCrowd } from './NavCrowd';
import { gatherNavGeometry, type NavGeometry } from './navGeometry';
import { NavQuery } from './NavQuery';
import { ensureRecast } from './recast';
import type { GroundProbe, SteeringBackend } from './types';

const log = createLogger('nav');

export interface NavStats {
  agents: number;
  polys: number;
  buildMs: number;
  tiles: number;
  /** 'navmesh' = detour crowd, 'direct' = fallback steering. */
  mode: 'navmesh' | 'direct';
  /** Where the current navmesh was generated. */
  builtIn: 'worker' | 'main' | 'none';
  /** Last update(dt) cost (ms). */
  updateMs: number;
  /** Crowd move requests waiting for their round-robin slot. */
  pendingTargets: number;
}

export interface NavSystemOptions {
  /** Ground height lookup for the fallback (e.g. a downward physics ray). */
  groundProbe?: GroundProbe | null;
  /** Worker factory; null = always build on the main thread. Default: the Vite module worker. */
  createWorker?: (() => Worker | null) | null;
  /** Agent slots (default NAV.crowd.maxAgents). */
  capacity?: number;
}

function defaultWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./navWorker.ts', import.meta.url), { type: 'module' });
}

const TWO_PI = Math.PI * 2;

/** NaN / Infinity from a broken AI state must not reach detour or the fallback integrator. */
function finite(p: Vec3Like): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function validParams(p: NavAgentParams): boolean {
  return (
    Number.isFinite(p.radius) &&
    Number.isFinite(p.height) &&
    Number.isFinite(p.maxSpeed) &&
    Number.isFinite(p.maxAcceleration) &&
    (p.separationWeight === undefined || Number.isFinite(p.separationWeight))
  );
}

// Per-slot agent params layout (slotParams).
const P_RADIUS = 0;
const P_HEIGHT = 1;
const P_MAX_SPEED = 2;
const P_MAX_ACCEL = 3;
const P_SEPARATION = 4;
const PARAM_COUNT = 5;

export class NavSystem implements NavApi {
  readonly stats: NavStats = {
    agents: 0,
    polys: 0,
    buildMs: 0,
    tiles: 0,
    mode: 'direct',
    builtIn: 'none',
    updateMs: 0,
    pendingTargets: 0,
  };
  readonly capacity: number;

  private navMesh: NavMesh | null = null;
  private query: NavQuery | null = null;
  private backend: SteeringBackend;
  private readonly groundProbe: GroundProbe | null;
  private readonly createWorker: (() => Worker | null) | null;
  private buildId = 0;
  /** Ends the running worker build (a newer build or dispose supersedes it). */
  private cancelWorker: (() => void) | null = null;
  private disposed = false;
  private rng = new Rng('nav');
  private seed: number | null = null;
  /** Fallback / disk-sample randomness (follows setRandomSeed). */
  private readonly random = (): number => this.rng.next();

  // Slots: stable agent ids → backend indices + what a backend swap needs.
  private readonly slotActive: Uint8Array;
  private readonly slotIndex: Int32Array;
  private readonly slotHasTarget: Uint8Array;
  private readonly slotTarget: Float32Array;
  private readonly slotParams: Float32Array;

  // Debug view.
  private debugWanted = false;
  private debugLoading = false;
  private debugParent: Object3D | null = null;
  private debugHelper: Object3D | null = null;
  private debugDisposables: { dispose(): void }[] = [];

  private readonly _v = new Vector3();
  private readonly _params: NavAgentParams = {
    radius: 0,
    height: 0,
    maxSpeed: 0,
    maxAcceleration: 0,
    separationWeight: 0,
  };

  constructor(opts: NavSystemOptions = {}) {
    this.capacity = opts.capacity ?? NAV.crowd.maxAgents;
    this.groundProbe = opts.groundProbe ?? null;
    this.createWorker = opts.createWorker === undefined ? defaultWorker : opts.createWorker;
    this.backend = new DirectSteering(this.capacity, this.groundProbe);
    this.slotActive = new Uint8Array(this.capacity);
    this.slotIndex = new Int32Array(this.capacity).fill(-1);
    this.slotHasTarget = new Uint8Array(this.capacity);
    this.slotTarget = new Float32Array(this.capacity * 3);
    this.slotParams = new Float32Array(this.capacity * PARAM_COUNT);
  }

  get ready(): boolean {
    return this.navMesh !== null;
  }

  get mode(): 'navmesh' | 'direct' {
    return this.stats.mode;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  async build(sources: readonly Mesh[]): Promise<boolean> {
    if (this.disposed) return false;
    const id = ++this.buildId;
    const t0 = performance.now();
    this.cancelWorker?.();
    try {
      this.releaseNavMesh();
      const geo = gatherNavGeometry(sources);
      if (geo.triangles === 0) {
        log.warn('Navmesh: no source triangles – enemies use direct steering');
        return false;
      }
      if (!(await ensureRecast())) return false;
      if (this.seed !== null) setRandomSeed(this.seed);
      if (id !== this.buildId || this.disposed) return false;

      const config = createGeneratorConfig();
      let navMesh: NavMesh | null = null;
      let builtIn: NavStats['builtIn'] = 'main';
      const bytes = await this.generateInWorker(id, geo, config);
      if (id !== this.buildId || this.disposed) return false;
      if (bytes) {
        navMesh = this.importBytes(bytes);
        if (navMesh) builtIn = 'worker';
      }
      if (!navMesh) {
        const result = generateNavMesh(geo.positions, geo.indices, config);
        if (!result.navMesh) {
          log.error(`Navmesh build failed (${result.error}) – enemies use direct steering`);
          return false;
        }
        navMesh = result.navMesh;
      }

      const { polys, tiles } = countNavMeshPolys(navMesh);
      this.activate(navMesh);
      this.stats.polys = polys;
      this.stats.tiles = tiles;
      this.stats.builtIn = builtIn;
      this.stats.buildMs = performance.now() - t0;
      log.info(
        `Navmesh: ${polys} polys in ${tiles} tiles from ${geo.triangles} tris / ${geo.meshes} meshes, ` +
          `${this.stats.buildMs.toFixed(0)} ms (${builtIn})`,
      );
      return true;
    } catch (err) {
      log.error('Navmesh build crashed – enemies use direct steering', err);
      return false;
    }
  }

  /**
   * Seed detour's random point queries and the fallback / disk samples (daily challenge
   * determinism). Takes the same seeds as Rng (strings are hashed).
   */
  setRandomSeed(seed: string | number): void {
    this.rng = new Rng(seed);
    this.seed = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : new Rng(seed).nextUint32();
    if (this.navMesh) setRandomSeed(this.seed);
  }

  private generateInWorker(
    id: number,
    geo: NavGeometry,
    config: NavGeneratorConfig,
  ): Promise<Uint8Array | null> {
    if (!NAV.build.useWorker || !this.createWorker) return Promise.resolve(null);
    let worker: Worker | null;
    try {
      worker = this.createWorker();
    } catch (err) {
      log.warn('Navmesh worker unavailable – building on the main thread', err);
      return Promise.resolve(null);
    }
    if (!worker) return Promise.resolve(null);
    const w = worker;
    return new Promise((resolve) => {
      let done = false;
      const finish = (data: Uint8Array | null): void => {
        if (done) return;
        done = true;
        if (this.cancelWorker === cancel) this.cancelWorker = null;
        clearTimeout(timer);
        w.onmessage = null;
        w.onerror = null;
        w.onmessageerror = null;
        w.terminate();
        resolve(data);
      };
      const cancel = (): void => finish(null);
      this.cancelWorker = cancel;
      const timer = setTimeout(() => {
        log.warn('Navmesh worker timed out – building on the main thread');
        finish(null);
      }, NAV.build.workerTimeoutMs);
      w.onmessage = (e: MessageEvent<NavBuildResponse>) => {
        const r = e.data;
        if (!r || r.id !== id) return;
        if (r.ok) {
          log.debug(`Navmesh worker: ${r.ms.toFixed(0)} ms, ${r.data.byteLength} bytes`);
          finish(r.data);
        } else {
          log.warn(`Navmesh worker failed (${r.error}) – retrying on the main thread`);
          finish(null);
        }
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        log.warn(`Navmesh worker error (${e.message}) – building on the main thread`);
        finish(null);
      };
      w.onmessageerror = () => {
        log.warn('Navmesh worker message error – building on the main thread');
        finish(null);
      };
      const req: NavBuildRequest = { id, positions: geo.positions, indices: geo.indices, config };
      try {
        // Copied, not transferred: the main-thread fallback still needs the triangles.
        w.postMessage(req);
      } catch (err) {
        log.warn('Navmesh worker postMessage failed', err);
        finish(null);
      }
    });
  }

  private importBytes(bytes: Uint8Array): NavMesh | null {
    try {
      const { navMesh } = importNavMesh(bytes);
      if (countNavMeshPolys(navMesh).polys > 0) return navMesh;
      navMesh.destroy();
      log.warn('Imported navmesh is empty – regenerating on the main thread');
    } catch (err) {
      log.warn('Navmesh import failed – regenerating on the main thread', err);
    }
    return null;
  }

  private activate(navMesh: NavMesh): void {
    const query = new NavQuery(navMesh, this.random);
    const crowd = new NavCrowd(navMesh, query, this.capacity);
    this.navMesh = navMesh;
    this.query = query;
    if (this.seed !== null) setRandomSeed(this.seed);
    this.swapBackend(crowd);
    this.stats.mode = 'navmesh';
    if (this.debugWanted) void this.createDebug();
  }

  /** Back to direct steering (agents migrate) and free the navmesh. */
  private releaseNavMesh(): void {
    this.disposeDebug();
    if (this.backend.kind === 'crowd') this.swapBackend(new DirectSteering(this.capacity, this.groundProbe));
    this.query?.destroy();
    this.query = null;
    this.navMesh?.destroy();
    this.navMesh = null;
    this.stats.mode = 'direct';
    this.stats.polys = 0;
    this.stats.tiles = 0;
    this.stats.builtIn = 'none';
    this.stats.pendingTargets = 0;
  }

  private swapBackend(next: SteeringBackend): void {
    const prev = this.backend;
    for (let s = 0; s < this.capacity; s++) {
      if (!this.slotActive[s]) continue;
      const old = this.slotIndex[s]!;
      if (old < 0) continue;
      prev.getAgentPosition(old, this._v);
      const idx = next.addAgent(this._v, this.readParams(s), true);
      this.slotIndex[s] = idx;
      if (idx < 0) {
        log.warn(`Nav agent ${s} could not be migrated`);
        continue;
      }
      if (this.slotHasTarget[s]) {
        const o = s * 3;
        this._v.set(this.slotTarget[o]!, this.slotTarget[o + 1]!, this.slotTarget[o + 2]!);
        next.setAgentTarget(idx, this._v);
      }
    }
    prev.dispose();
    this.backend = next;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  closestPoint(p: Vec3Like, out: Vector3): boolean {
    if (this.query) return this.query.closestPoint(p, out);
    return this.fallbackPoint(p.x, p.y, p.z, out);
  }

  randomPointAround(center: Vec3Like, radius: number, out: Vector3): boolean {
    if (this.query) return this.query.randomPointAround(center, radius, out);
    const a = this.rng.next() * TWO_PI;
    const r = (Number.isFinite(radius) ? Math.max(0, radius) : 0) * Math.sqrt(this.rng.next());
    return this.fallbackPoint(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r, out);
  }

  findPath(from: Vec3Like, to: Vec3Like, out: Vector3[]): number {
    if (this.query) return this.query.findPath(from, to, out);
    while (out.length < 2) out.push(new Vector3());
    out[0]!.set(from.x, from.y, from.z);
    out[1]!.set(to.x, to.y, to.z);
    return 2;
  }

  walkable(from: Vec3Like, to: Vec3Like): boolean {
    return this.query ? this.query.walkable(from, to) : true;
  }

  private fallbackPoint(x: number, y: number, z: number, out: Vector3): boolean {
    out.set(x, y, z);
    if (this.groundProbe) {
      const g = this.groundProbe(x, y + NAV.direct.probeUp, z);
      if (g !== null && Number.isFinite(g)) out.y = g;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  addAgent(position: Vec3Like, params: NavAgentParams): number {
    if (this.disposed || !finite(position) || !validParams(params)) return -1;
    let slot = -1;
    for (let s = 0; s < this.capacity; s++) {
      if (!this.slotActive[s]) {
        slot = s;
        break;
      }
    }
    if (slot < 0) return -1;
    const idx = this.backend.addAgent(position, params);
    if (idx < 0) return -1;
    this.slotActive[slot] = 1;
    this.slotIndex[slot] = idx;
    this.slotHasTarget[slot] = 0;
    this.writeParams(slot, params);
    this.stats.agents++;
    return slot;
  }

  removeAgent(id: number): void {
    const idx = this.index(id);
    if (idx === -2) return;
    if (idx >= 0) this.backend.removeAgent(idx);
    this.slotActive[id] = 0;
    this.slotIndex[id] = -1;
    this.slotHasTarget[id] = 0;
    this.stats.agents--;
  }

  setAgentTarget(id: number, target: Vec3Like): void {
    const idx = this.index(id);
    if (idx === -2 || !finite(target)) return;
    const o = id * 3;
    this.slotTarget[o] = target.x;
    this.slotTarget[o + 1] = target.y;
    this.slotTarget[o + 2] = target.z;
    this.slotHasTarget[id] = 1;
    if (idx >= 0) this.backend.setAgentTarget(idx, target);
  }

  stopAgent(id: number): void {
    const idx = this.index(id);
    if (idx === -2) return;
    this.slotHasTarget[id] = 0;
    if (idx >= 0) this.backend.stopAgent(idx);
  }

  setAgentMaxSpeed(id: number, speed: number): void {
    const idx = this.index(id);
    if (idx === -2 || !Number.isFinite(speed)) return;
    this.slotParams[id * PARAM_COUNT + P_MAX_SPEED] = speed;
    if (idx >= 0) this.backend.setAgentMaxSpeed(idx, speed);
  }

  teleportAgent(id: number, position: Vec3Like): void {
    const idx = this.index(id);
    if (idx >= 0 && finite(position)) this.backend.teleportAgent(idx, position);
  }

  getAgentPosition(id: number, out: Vector3): Vector3 {
    const idx = this.index(id);
    return idx >= 0 ? this.backend.getAgentPosition(idx, out) : out;
  }

  getAgentVelocity(id: number, out: Vector3): Vector3 {
    const idx = this.index(id);
    return idx >= 0 ? this.backend.getAgentVelocity(idx, out) : out.set(0, 0, 0);
  }

  update(dt: number): void {
    // NaN / non-positive steps would poison detour's agent state.
    if (this.disposed || !(dt > 0) || !Number.isFinite(dt)) return;
    const t0 = performance.now();
    this.backend.update(dt);
    if (this.backend instanceof NavCrowd) this.stats.pendingTargets = this.backend.pendingCount;
    this.stats.updateMs = performance.now() - t0;
  }

  /** Backend index for an agent id: -2 = unknown id, -1 = known but not placed (migration failed). */
  private index(id: number): number {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity || !this.slotActive[id]) return -2;
    return this.slotIndex[id]!;
  }

  private writeParams(slot: number, p: NavAgentParams): void {
    const o = slot * PARAM_COUNT;
    this.slotParams[o + P_RADIUS] = p.radius;
    this.slotParams[o + P_HEIGHT] = p.height;
    this.slotParams[o + P_MAX_SPEED] = p.maxSpeed;
    this.slotParams[o + P_MAX_ACCEL] = p.maxAcceleration;
    this.slotParams[o + P_SEPARATION] = p.separationWeight ?? NAV.crowd.defaultSeparation;
  }

  private readParams(slot: number): NavAgentParams {
    const o = slot * PARAM_COUNT;
    const p = this._params;
    p.radius = this.slotParams[o + P_RADIUS]!;
    p.height = this.slotParams[o + P_HEIGHT]!;
    p.maxSpeed = this.slotParams[o + P_MAX_SPEED]!;
    p.maxAcceleration = this.slotParams[o + P_MAX_ACCEL]!;
    p.separationWeight = this.slotParams[o + P_SEPARATION]!;
    return p;
  }

  // -------------------------------------------------------------------------
  // Debug view (dev console `nav`)
  // -------------------------------------------------------------------------

  setDebugVisible(visible: boolean, scene: Object3D): void {
    this.debugWanted = visible;
    if (!visible) {
      this.disposeDebug();
      return;
    }
    this.debugParent = scene;
    if (this.debugHelper) {
      if (this.debugHelper.parent !== scene) scene.add(this.debugHelper);
      return;
    }
    if (!this.navMesh) {
      log.info('Navmesh debug: no navmesh yet (shown once built)');
      return;
    }
    void this.createDebug();
  }

  private async createDebug(): Promise<void> {
    if (this.debugHelper || this.debugLoading || this.disposed) return;
    const navMesh = this.navMesh;
    if (!navMesh) return;
    this.debugLoading = true;
    try {
      const { NavMeshHelper } = await import('@recast-navigation/three');
      if (!this.debugWanted || this.navMesh !== navMesh || !this.debugParent || this.disposed) return;
      const d = NAV.debug;
      const fill = new MeshBasicMaterial({
        color: d.fillColor,
        transparent: true,
        opacity: d.fillOpacity,
        depthWrite: false,
      });
      const wire = new MeshBasicMaterial({
        color: d.wireColor,
        transparent: true,
        opacity: d.wireOpacity,
        depthWrite: false,
        wireframe: true,
      });
      const helper = new NavMeshHelper(navMesh, { navMeshMaterial: fill });
      const geometry: BufferGeometry = helper.navMeshGeometry;
      helper.add(new Mesh(geometry, wire));
      helper.name = 'nav:debug';
      // The helper draws the raw navmesh (heightBias above the corrected points).
      helper.position.y = d.lift;
      helper.traverse((o) => {
        o.userData[NAV.sources.ignoreFlag] = true;
      });
      this.debugDisposables = [geometry, fill, wire];
      this.debugHelper = helper;
      this.debugParent.add(helper);
    } catch (err) {
      log.warn('Navmesh debug view failed', err);
    } finally {
      this.debugLoading = false;
      // The navmesh changed while the helper module loaded: build the view for the new one.
      if (this.debugWanted && !this.debugHelper && this.navMesh && this.navMesh !== navMesh) {
        void this.createDebug();
      }
    }
  }

  private disposeDebug(): void {
    this.debugHelper?.removeFromParent();
    this.debugHelper = null;
    for (const d of this.debugDisposables) d.dispose();
    this.debugDisposables = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.buildId++;
    this.cancelWorker?.();
    this.releaseNavMesh();
    this.disposed = true;
    this.backend.dispose();
    this.slotActive.fill(0);
    this.slotIndex.fill(-1);
    this.stats.agents = 0;
  }
}
