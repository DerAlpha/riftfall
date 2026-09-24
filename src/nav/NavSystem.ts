/**
 * NavApi implementation: recast navmesh + detour crowd, with a direct-steering fallback.
 *
 * build(): level meshes → world-space triangles (navGeometry) → Web Worker (navWorker.ts)
 * generates a tiled navmesh and transfers the serialized bytes → importNavMesh here → NavQuery
 * (allocation-free queries) + NavCrowd (agents). Without a Worker (node/tests), or when it fails
 * or times out, the navmesh is generated on the main thread. build() never rejects: on failure it
 * logs, returns false and the agents keep running on DirectSteering. A rebuild keeps the current
 * navmesh active until the new one is ready (agents then migrate from crowd to crowd).
 *
 * Agent ids are NavSystem slots, stable across backend swaps: agents added before the navmesh is
 * ready (or while a rebuild runs) are migrated with their position, params and goal.
 *
 * Fallback queries (no navmesh): closestPoint / randomPointAround return the point itself
 * (dropped onto the ground probe when one is given), findPath returns [from, to], walkable true.
 *
 * Tick: call update(dt) once per fixed tick (EnemyManager does, after its movement requests): move
 * targets set since the last update are sent (round-robin budget), then the crowd steps; positions
 * read afterwards are this tick's.
 *
 * Blockable areas (M4 doors, machines – setAreaBlocked): an area is an axis-aligned box. The tiles
 * under it are regenerated on the main thread with the box marked as its own recast area id
 * (AreaTileBuilder: the tile pipeline of recast-navigation's tiled generator plus markBoxArea;
 * neighbouring areas get different ids, NAV.areas), so its polygons end exactly at the box; while blocked they carry NAV.areas.disabledFlag, which the
 * query filter (NavQuery) and the crowd filter (NavCrowd) exclude – closestPoint, randomPointAround,
 * findPath, walkable and agent paths all avoid them. Toggling only rewrites poly flags (instant);
 * registering a new area regenerates its tiles once (a few ms each, batched on the next update or
 * flushAreas()). Areas survive rebuilds. Without a tiled navmesh (solo mode, regeneration failure)
 * every polygon overlapping the box is flagged instead (coarse but safe).
 */
import { Mesh, MeshBasicMaterial, Vector3, type BufferGeometry, type Object3D } from 'three';
import {
  ChunkIdsArray,
  Detour,
  NavMeshCreateParams,
  Raw,
  Recast,
  RecastBuildContext,
  RecastChunkyTriMesh,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocContourSet,
  allocHeightfield,
  allocPolyMesh,
  allocPolyMeshDetail,
  buildCompactHeightfield,
  buildContours,
  buildDistanceField,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  cloneRcConfig,
  createHeightfield,
  createNavMeshData,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freePolyMesh,
  freePolyMeshDetail,
  importNavMesh,
  markBoxArea,
  markWalkableTriangles,
  rasterizeTriangles,
  setRandomSeed,
  statusFailed,
  type FloatArray,
  type IntArray,
  type NavMesh,
  type RawModule,
  type RecastCompactHeightfield,
  type RecastContourSet,
  type RecastHeightfield,
  type RecastPolyMesh,
  type RecastPolyMeshDetail,
  type UnsignedCharArray,
} from 'recast-navigation';
import { buildTiledNavMeshRcConfig, tiledNavMeshGeneratorConfigDefaults } from 'recast-navigation/generators';
import type { NavAgentParams, NavApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import { NAV } from '../defs/nav';
import { DirectSteering } from './DirectSteering';
import {
  alignForVoxels,
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

/** A registered blockable area (world AABB) and whether the current navmesh has it split off. */
interface BlockArea {
  readonly center: { x: number; y: number; z: number };
  readonly half: { x: number; y: number; z: number };
  /** Recast area id of its polygons (differs from every neighbour's, NAV.areas). */
  readonly areaId: number;
  blocked: boolean;
  /** pending: tiles not regenerated yet · exact: own polygons (area id) · coarse: overlap flags. */
  mode: 'pending' | 'exact' | 'coarse';
}

/** Two registrations within this distance (m) are the same area. */
const AREA_MATCH_EPSILON = 1e-3;

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

  // Blockable areas (M4 doors).
  private readonly areas: BlockArea[] = [];
  private areasDirty = false;
  /** Geometry + config of the current navmesh (tile regeneration). */
  private areaSource: { geo: NavGeometry; config: NavGeneratorConfig } | null = null;
  private areaTiles: AreaTileBuilder | null = null;

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
    // A newer build supersedes the running one; its worker is ended right away.
    this.cancelWorker?.();
    let pending: NavMesh | null = null;
    try {
      // The current navmesh (if any) keeps serving queries and the crowd until the new one is
      // ready: a rebuild (dev console, M4 doors) never drops the agents to direct steering.
      const geo = gatherNavGeometry(sources);
      if (geo.triangles === 0) {
        log.warn('Navmesh: no source triangles – enemies use direct steering');
        this.releaseNavMesh();
        return false;
      }
      const config = createGeneratorConfig();
      // The worker loads its own recast copy: start it before the main thread's init (parallel).
      const fromWorker = this.generateInWorker(id, geo, config);
      if (!(await ensureRecast())) {
        if (id === this.buildId) {
          this.cancelWorker?.();
          this.releaseNavMesh();
        }
        return false;
      }
      const bytes = await fromWorker;
      if (id !== this.buildId || this.disposed) return false;

      let builtIn: NavStats['builtIn'] = 'main';
      if (bytes) {
        pending = this.importBytes(bytes);
        if (pending) builtIn = 'worker';
      }
      if (!pending) {
        const result = generateNavMesh(geo.positions, geo.indices, config);
        if (!result.navMesh) {
          log.error(`Navmesh build failed (${result.error}) – enemies use direct steering`);
          this.releaseNavMesh();
          return false;
        }
        pending = result.navMesh;
      }

      const { polys, tiles } = countNavMeshPolys(pending);
      this.activate(pending);
      this.stats.polys = polys;
      this.stats.tiles = tiles;
      this.stats.builtIn = builtIn;
      // Blockable areas: split their tiles in the new navmesh (main thread, before the first query).
      this.areaSource = { geo, config };
      for (const a of this.areas) a.mode = 'pending';
      this.areasDirty = this.areas.length > 0;
      this.flushAreas();
      this.stats.buildMs = performance.now() - t0;
      log.info(
        `Navmesh: ${polys} polys in ${tiles} tiles from ${geo.triangles} tris / ${geo.meshes} meshes, ` +
          `${this.stats.buildMs.toFixed(0)} ms (${builtIn})`,
      );
      return true;
    } catch (err) {
      log.error('Navmesh build crashed – enemies use direct steering', err);
      if (pending && pending !== this.navMesh) pending.destroy();
      if (id === this.buildId && !this.disposed) {
        try {
          this.releaseNavMesh();
        } catch (releaseErr) {
          log.error('Navmesh release failed', releaseErr);
        }
      }
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

  /**
   * Switch to `navMesh`: new query + crowd, agents migrate from the current backend (the old crowd
   * or direct steering), then the old navmesh is freed.
   */
  private activate(navMesh: NavMesh): void {
    const query = new NavQuery(navMesh, this.random);
    let crowd: NavCrowd;
    try {
      crowd = new NavCrowd(navMesh, query, this.capacity);
    } catch (err) {
      query.destroy();
      throw err;
    }
    const oldQuery = this.query;
    const oldNavMesh = this.navMesh;
    this.disposeDebug();
    // The tile builder belongs to the old geometry.
    this.destroyAreaTiles();
    // Reads the positions from the old backend (still alive), then disposes it.
    this.swapBackend(crowd);
    this.navMesh = navMesh;
    this.query = query;
    oldQuery?.destroy();
    oldNavMesh?.destroy();
    if (this.seed !== null) setRandomSeed(this.seed);
    this.stats.mode = 'navmesh';
    this.stats.pendingTargets = crowd.pendingCount;
    if (this.debugWanted) void this.createDebug();
  }

  /** Back to direct steering (agents migrate) and free the navmesh. */
  private releaseNavMesh(): void {
    this.disposeDebug();
    this.destroyAreaTiles();
    this.areaSource = null;
    for (const a of this.areas) a.mode = 'pending';
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
    if (this.areasDirty) this.flushAreas();
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
  // Blockable areas (M4 doors, machines)
  // -------------------------------------------------------------------------

  /**
   * Block / unblock the navmesh inside an axis-aligned box (center ± halfExtents). The first call
   * registers the area (its tiles are regenerated on the next update() / flushAreas()); later
   * calls with the same box only toggle it (instant). Registered areas persist across rebuilds.
   */
  setAreaBlocked(center: Vec3Like, halfExtents: Vec3Like, blocked: boolean): void {
    if (this.disposed || !finite(center) || !finite(halfExtents)) return;
    let area = this.findArea(center, halfExtents);
    if (!area) {
      const half = { x: Math.abs(halfExtents.x), y: Math.abs(halfExtents.y), z: Math.abs(halfExtents.z) };
      area = {
        center: { x: center.x, y: center.y, z: center.z },
        half,
        areaId: this.pickAreaId(center, half),
        blocked,
        mode: 'pending',
      };
      this.areas.push(area);
      this.areasDirty = true;
      return;
    }
    if (area.blocked === blocked) return;
    area.blocked = blocked;
    if (area.mode === 'pending') this.areasDirty = true;
    else this.applyAreaFlags(area);
  }

  /** Blocked areas right now (debug / tests). */
  get blockedAreaCount(): number {
    let n = 0;
    for (const a of this.areas) if (a.blocked) n++;
    return n;
  }

  /** Split newly registered areas off the navmesh and apply every area's flags now. */
  flushAreas(): void {
    if (!this.areasDirty) return;
    this.areasDirty = false;
    if (!this.navMesh || !this.query) return;
    let pending = false;
    for (const a of this.areas) if (a.mode === 'pending') pending = true;
    if (pending) this.splitPendingAreas();
    for (const a of this.areas) this.applyAreaFlags(a);
  }

  /**
   * Smallest area id no neighbouring area uses (NAV.areas.separation): recast would merge touching
   * spans of one id into shared polygons, and a door beside a machine must toggle on its own.
   */
  private pickAreaId(c: Vec3Like, h: Vec3Like): number {
    const A = NAV.areas;
    let used = 0;
    for (const a of this.areas) {
      const gx = Math.abs(a.center.x - c.x) - a.half.x - h.x;
      const gz = Math.abs(a.center.z - c.z) - a.half.z - h.z;
      const gy = Math.abs(a.center.y - c.y) - a.half.y - h.y;
      if (gx < A.separation && gz < A.separation && gy < A.separation)
        used |= 1 << (a.areaId - A.firstAreaId);
    }
    for (let i = 0; i < A.areaIdCount; i++) if ((used & (1 << i)) === 0) return A.firstAreaId + i;
    log.warn(`Navmesh: more than ${A.areaIdCount} blockable areas side by side – they share polygons`);
    return A.firstAreaId;
  }

  private findArea(c: Vec3Like, h: Vec3Like): BlockArea | null {
    const e = AREA_MATCH_EPSILON;
    for (const a of this.areas) {
      if (
        Math.abs(a.center.x - c.x) < e &&
        Math.abs(a.center.y - c.y) < e &&
        Math.abs(a.center.z - c.z) < e &&
        Math.abs(a.half.x - Math.abs(h.x)) < e &&
        Math.abs(a.half.y - Math.abs(h.y)) < e &&
        Math.abs(a.half.z - Math.abs(h.z)) < e
      ) {
        return a;
      }
    }
    return null;
  }

  /** Regenerate every tile under a pending area once (with ALL areas of that tile marked). */
  private splitPendingAreas(): void {
    const navMesh = this.navMesh!;
    const src = this.areaSource;
    let builder: AreaTileBuilder | null = null;
    if (src && src.config.mode === 'tiled') {
      try {
        builder = this.areaTiles ??= new AreaTileBuilder(src.geo, src.config);
      } catch (err) {
        log.warn('Navmesh area tiles unavailable – blocked areas flag whole polygons', err);
      }
    }
    if (!builder) {
      for (const a of this.areas) if (a.mode === 'pending') a.mode = 'coarse';
      return;
    }
    const tiles = new Set<number>();
    for (const a of this.areas) {
      if (a.mode !== 'pending') continue;
      builder.forEachTile(a, (key) => tiles.add(key));
    }
    const failed = new Set<number>();
    const t0 = performance.now();
    for (const key of tiles) {
      if (!builder.rebuildTile(navMesh, key, this.areas)) failed.add(key);
    }
    for (const a of this.areas) {
      if (a.mode !== 'pending') continue;
      let ok = true;
      builder.forEachTile(a, (key) => {
        if (failed.has(key)) ok = false;
      });
      a.mode = ok ? 'exact' : 'coarse';
    }
    if (failed.size > 0) log.warn(`Navmesh: ${failed.size} area tile(s) failed to regenerate – coarse flags`);
    log.debug(
      `Navmesh areas: ${tiles.size} tile(s) regenerated in ${(performance.now() - t0).toFixed(1)} ms`,
    );
    // Areas are registered in bursts (map load): free the wasm copy of the geometry until the next.
    this.destroyAreaTiles();
  }

  /**
   * Write the area's flags onto its polygons (exact: its own area-id polygons only; coarse: every
   * overlapping polygon – an unblocked coarse area re-applies the blocked coarse ones, blocked wins).
   */
  private applyAreaFlags(a: BlockArea, reapplyCoarse = true): void {
    const navMesh = this.navMesh;
    const q = this.query;
    if (!navMesh || !q || a.mode === 'pending') return;
    const A = NAV.areas;
    const flags = a.blocked ? A.walkFlag | A.disabledFlag : A.walkFlag;
    const n = q.queryBoxPolys(a.center, a.half);
    for (let i = 0; i < n; i++) {
      const ref = q.boxPoly(i);
      if (a.mode === 'exact' && navMesh.getPolyArea(ref).area !== a.areaId) continue;
      navMesh.setPolyFlags(ref, flags);
    }
    if (a.mode === 'coarse' && !a.blocked && reapplyCoarse) {
      for (const b of this.areas)
        if (b !== a && b.mode === 'coarse' && b.blocked) this.applyAreaFlags(b, false);
    }
  }

  private destroyAreaTiles(): void {
    this.areaTiles?.destroy();
    this.areaTiles = null;
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
    this.areas.length = 0;
    this.cancelWorker?.();
    this.releaseNavMesh();
    this.disposed = true;
    this.backend.dispose();
    this.slotActive.fill(0);
    this.slotIndex.fill(-1);
    this.stats.agents = 0;
  }
}

// ---------------------------------------------------------------------------
// Area tiles: one tile of the tiled generator with blockable areas marked
// ---------------------------------------------------------------------------

/**
 * Regenerates single tiles of a tiled navmesh on the main thread from the build geometry, with the
 * blockable area boxes marked (markBoxArea after erosion) – the per-tile pipeline of
 * recast-navigation's generateTileNavMeshData, same config and voxel alignment as navBuild, so the
 * regenerated tile matches its neighbours. Area polygons keep their area's id and get the
 * walk flag; everything else becomes area 0 / walk flag like the generator's output.
 * Holds the geometry + chunky triangle mesh in wasm memory until destroy().
 */
class AreaTileBuilder {
  private readonly ctx = new RecastBuildContext(false);
  private readonly verts: FloatArray;
  private readonly tris: IntArray;
  private readonly chunky: RecastChunkyTriMesh;
  private readonly chunkIds: IntArray;
  private readonly rc: RawModule.rcConfig;
  private readonly bmin: readonly [number, number, number];
  private readonly bmax: readonly [number, number, number];
  private readonly tileWorld: number;
  private readonly tilesX: number;
  private readonly tilesZ: number;
  private destroyed = false;

  constructor(geo: NavGeometry, config: NavGeneratorConfig) {
    const aligned = alignForVoxels(geo.positions, config.recast.ch);
    const genCfg = { ...tiledNavMeshGeneratorConfigDefaults, ...config.recast };
    const built = buildTiledNavMeshRcConfig({ recastConfig: genCfg, navMeshBounds: aligned.bounds });
    this.rc = built.config;
    this.tileWorld = built.tcs;
    this.tilesX = built.tileWidth;
    this.tilesZ = built.tileHeight;
    this.bmin = aligned.bounds[0];
    this.bmax = aligned.bounds[1];
    this.verts = new VerticesArray();
    this.verts.copy(aligned.positions);
    this.tris = new TrianglesArray();
    // Same bits, signed view (indices stay far below 2^31).
    this.tris.copy(new Int32Array(geo.indices.buffer, geo.indices.byteOffset, geo.indices.length));
    this.chunky = new RecastChunkyTriMesh();
    this.chunkIds = new ChunkIdsArray();
    this.chunkIds.resize(NAV.areas.maxChunks);
    if (!this.chunky.init(this.verts, this.tris, geo.indices.length / 3, genCfg.chunkyTriMeshTrisPerChunk)) {
      this.destroy();
      throw new Error('chunky triangle mesh failed');
    }
  }

  /** Tile keys (tx + ty × tilesX) whose bounds overlap the area box on XZ. */
  forEachTile(a: BlockArea, fn: (key: number) => void): void {
    const w = this.tileWorld;
    const x0 = Math.max(0, Math.floor((a.center.x - a.half.x - this.bmin[0]) / w));
    const x1 = Math.min(this.tilesX - 1, Math.floor((a.center.x + a.half.x - this.bmin[0]) / w));
    const z0 = Math.max(0, Math.floor((a.center.z - a.half.z - this.bmin[2]) / w));
    const z1 = Math.min(this.tilesZ - 1, Math.floor((a.center.z + a.half.z - this.bmin[2]) / w));
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) fn(tx + tz * this.tilesX);
  }

  /**
   * Replace tile `key` in `navMesh` by a regeneration with `areas` marked; false on failure. A tile
   * without walkable polygons stays as it is (its original has none either: same geometry).
   */
  rebuildTile(navMesh: NavMesh, key: number, areas: readonly BlockArea[]): boolean {
    if (this.destroyed) return false;
    const tx = key % this.tilesX;
    const tz = Math.floor(key / this.tilesX);
    let data: UnsignedCharArray | 'empty' | null;
    try {
      data = this.buildTile(tx, tz, areas);
    } catch (err) {
      log.warn(`Navmesh area tile ${tx},${tz} crashed`, err);
      return false;
    }
    if (data === 'empty') return true;
    if (!data) return false;
    const ref = navMesh.getTileRefAt(tx, tz, 0);
    if (ref !== 0) navMesh.removeTile(ref);
    const res = navMesh.addTile(data, Detour.DT_TILE_FREE_DATA, 0);
    if (statusFailed(res.status)) {
      data.destroy();
      log.warn(`Navmesh area tile ${tx},${tz} could not be added`);
      return false;
    }
    return true;
  }

  /** Tile data, 'empty' (no geometry / no walkable polygon), or null on a failed build step. */
  private buildTile(tx: number, tz: number, areas: readonly BlockArea[]): UnsignedCharArray | 'empty' | null {
    const ctx = this.ctx;
    const cfg = cloneRcConfig(this.rc);
    const border = cfg.borderSize * cfg.cs;
    const w = this.tileWorld;
    const bmin: [number, number, number] = [
      this.bmin[0] + tx * w - border,
      this.bmin[1],
      this.bmin[2] + tz * w - border,
    ];
    const bmax: [number, number, number] = [
      this.bmin[0] + (tx + 1) * w + border,
      this.bmax[1],
      this.bmin[2] + (tz + 1) * w + border,
    ];
    for (let i = 0; i < 3; i++) {
      cfg.set_bmin(i, bmin[i]!);
      cfg.set_bmax(i, bmax[i]!);
    }
    let hf: RecastHeightfield | null = allocHeightfield();
    let chf: RecastCompactHeightfield | null = null;
    let cset: RecastContourSet | null = null;
    let pmesh: RecastPolyMesh | null = null;
    let dmesh: RecastPolyMeshDetail | null = null;
    let params: NavMeshCreateParams | null = null;
    try {
      if (!createHeightfield(ctx, hf, cfg.width, cfg.height, bmin, bmax, cfg.cs, cfg.ch)) return null;
      const nChunks = this.chunky.getChunksOverlappingRect(
        [bmin[0], bmin[2]],
        [bmax[0], bmax[2]],
        this.chunkIds,
        NAV.areas.maxChunks,
      );
      if (nChunks === 0) return 'empty';
      for (let i = 0; i < nChunks; i++) {
        const nodeId = this.chunkIds.get(i);
        const nodeTris = this.chunky.getNodeTris(nodeId);
        const n = this.chunky.nodes(nodeId).n;
        const triAreas = new TriangleAreasArray();
        triAreas.resize(n);
        markWalkableTriangles(ctx, cfg.walkableSlopeAngle, this.verts, this.tris.size, nodeTris, n, triAreas);
        const ok = rasterizeTriangles(
          ctx,
          this.verts,
          this.tris.size,
          nodeTris,
          triAreas,
          n,
          hf,
          cfg.walkableClimb,
        );
        triAreas.destroy();
        if (!ok) return null;
      }
      filterLowHangingWalkableObstacles(ctx, cfg.walkableClimb, hf);
      filterLedgeSpans(ctx, cfg.walkableHeight, cfg.walkableClimb, hf);
      filterWalkableLowHeightSpans(ctx, cfg.walkableHeight, hf);
      chf = allocCompactHeightfield();
      if (!buildCompactHeightfield(ctx, cfg.walkableHeight, cfg.walkableClimb, hf, chf)) return null;
      freeHeightfield(hf);
      hf = null;
      if (!erodeWalkableArea(ctx, cfg.walkableRadius, chf)) return null;
      // Registration order: a later area owns the overlap with an earlier one.
      for (const a of areas) {
        const c = a.center;
        const h = a.half;
        if (c.x + h.x < bmin[0] || c.x - h.x > bmax[0] || c.z + h.z < bmin[2] || c.z - h.z > bmax[2])
          continue;
        markBoxArea(ctx, [c.x - h.x, c.y - h.y, c.z - h.z], [c.x + h.x, c.y + h.y, c.z + h.z], a.areaId, chf);
      }
      if (!buildDistanceField(ctx, chf)) return null;
      if (!buildRegions(ctx, chf, cfg.borderSize, cfg.minRegionArea, cfg.mergeRegionArea)) return null;
      cset = allocContourSet();
      if (
        !buildContours(
          ctx,
          chf,
          cfg.maxSimplificationError,
          cfg.maxEdgeLen,
          cset,
          Recast.RC_CONTOUR_TESS_WALL_EDGES,
        )
      ) {
        return null;
      }
      pmesh = allocPolyMesh();
      if (!buildPolyMesh(ctx, cset, cfg.maxVertsPerPoly, pmesh)) return null;
      dmesh = allocPolyMeshDetail();
      if (!buildPolyMeshDetail(ctx, pmesh, chf, cfg.detailSampleDist, cfg.detailSampleMaxError, dmesh))
        return null;
      const A = NAV.areas;
      for (let i = 0; i < pmesh.npolys(); i++) {
        const area = pmesh.areas(i);
        if (area === Recast.RC_WALKABLE_AREA) pmesh.setAreas(i, 0);
        const blockable = area >= A.firstAreaId && area < A.firstAreaId + A.areaIdCount;
        if (area === Recast.RC_WALKABLE_AREA || area === 0 || blockable) pmesh.setFlags(i, A.walkFlag);
      }
      if (pmesh.npolys() === 0) return 'empty';
      params = new NavMeshCreateParams();
      params.setPolyMeshCreateParams(pmesh);
      params.setPolyMeshDetailCreateParams(dmesh);
      params.setWalkableHeight(cfg.walkableHeight * cfg.ch);
      params.setWalkableRadius(cfg.walkableRadius * cfg.cs);
      params.setWalkableClimb(cfg.walkableClimb * cfg.ch);
      params.setCellSize(cfg.cs);
      params.setCellHeight(cfg.ch);
      params.setBuildBvTree(tiledNavMeshGeneratorConfigDefaults.buildBvTree);
      params.setTileX(tx);
      params.setTileY(tz);
      const res = createNavMeshData(params);
      return res.success ? res.navMeshData : null;
    } finally {
      if (hf) freeHeightfield(hf);
      if (chf) freeCompactHeightfield(chf);
      if (cset) freeContourSet(cset);
      if (pmesh) freePolyMesh(pmesh);
      if (dmesh) freePolyMeshDetail(dmesh);
      if (params) Raw.destroy(params.raw);
      Raw.destroy(cfg);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.verts.destroy();
    this.tris.destroy();
    this.chunkIds.destroy();
    Raw.destroy(this.chunky.raw);
  }
}
