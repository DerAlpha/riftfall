/**
 * Allocation-free navmesh queries on the raw detour bindings. The high-level recast-navigation
 * wrappers allocate result objects and wasm temporaries per call; here every wasm out-parameter
 * and array is created once and positions go through reused 3-element arrays (the emscripten glue
 * copies them into its own scratch heap).
 *
 * Output heights are lowered by NAV.query.heightBias (the navmesh floats a fraction of a voxel
 * above the rendered floor); inputs are snapped with the search boxes in NAV.query.
 *
 * Raycasts record the polygons they cross (dtRaycastHit.path): the bindings expose the field only
 * element-wise, so the buffer pointer is written into the struct once, after validating the
 * struct layout at runtime. If the layout ever differs, rays run without a path and walkable()
 * falls back to a reverse ray (see there).
 */
import {
  NavMeshQuery,
  Raw,
  statusFailed,
  statusSucceed,
  type NavMesh,
  type RawModule,
} from 'recast-navigation';
import { Vector3 } from 'three';
import type { Vec3Like } from '../core/events';
import { NAV } from '../defs/nav';

/** detour's raycast reports "reached the end" with t = FLT_MAX. */
const RAY_CLEAR_T = 1;
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * dtRaycastHit layout (DetourNavMeshQuery.h, wasm32): float t; float hitNormal[3];
 * int hitEdgeIndex; dtPolyRef* path; int pathCount; int maxPath; float pathCost.
 */
const HIT_EDGE_INDEX_OFFSET = 16;
const HIT_PATH_OFFSET = 20;
const HIT_PATH_COUNT_OFFSET = 24;
const HIT_MAX_PATH_OFFSET = 28;
/** Distinct marker values for the layout check. */
const LAYOUT_MARKERS = [0x5a17, 0x6b28, 0x7c39] as const;

function set3(arr: number[], x: number, y: number, z: number): number[] {
  arr[0] = x;
  arr[1] = y;
  arr[2] = z;
  return arr;
}

export class NavQuery {
  /** Result of the last `nearest()` call (valid when it returned a non-zero ref). */
  nx = 0;
  ny = 0;
  nz = 0;

  private readonly query: NavMeshQuery;
  private readonly raw: RawModule.NavMeshQuery;
  readonly filter: RawModule.dtQueryFilter;
  private readonly refOut: RawModule.UnsignedIntRef;
  private readonly ptOut: RawModule.Vec3;
  private readonly overOut: RawModule.BoolRef;
  private readonly countOut: RawModule.IntRef;
  private readonly polys: RawModule.UnsignedIntArray;
  private readonly straight: RawModule.FloatArray;
  private readonly straightFlags: RawModule.UnsignedCharArray;
  private readonly straightRefs: RawModule.UnsignedIntArray;
  private readonly hit: RawModule.dtRaycastHit;
  /** Buffer behind hit.path (null: layout check failed, rays record no polygons). */
  private readonly rayPolys: RawModule.UnsignedIntArray | null;
  private readonly heightOut: RawModule.FloatRef;
  private readonly bias = NAV.query.heightBias;
  private readonly maxRisePerMeter = Math.tan(NAV.build.walkableSlopeDeg * DEG);
  private readonly random: () => number;
  private destroyed = false;

  // Reused position / extents arrays handed to the bindings.
  private readonly _a: number[] = [0, 0, 0];
  private readonly _b: number[] = [0, 0, 0];
  private readonly _ext: number[] = [0, 0, 0];

  /** `random` (0..1) drives the disk fallback of randomPointAround (seeded by NavSystem). */
  constructor(navMesh: NavMesh, random: () => number = Math.random) {
    this.random = random;
    this.query = new NavMeshQuery(navMesh, { maxNodes: NAV.query.maxNodes });
    this.raw = this.query.raw;
    this.filter = this.query.defaultFilter.raw;
    this.refOut = new Raw.Module.UnsignedIntRef();
    this.ptOut = new Raw.Module.Vec3();
    this.overOut = new Raw.Module.BoolRef();
    this.countOut = new Raw.Module.IntRef();
    this.polys = new Raw.Module.UnsignedIntArray();
    this.polys.resize(NAV.query.maxPathPolys);
    const maxPts = NAV.query.maxStraightPathPoints;
    this.straight = new Raw.Module.FloatArray();
    this.straight.resize(maxPts * 3);
    this.straightFlags = new Raw.Module.UnsignedCharArray();
    this.straightFlags.resize(maxPts);
    this.straightRefs = new Raw.Module.UnsignedIntArray();
    this.straightRefs.resize(maxPts);
    this.hit = new Raw.Module.dtRaycastHit();
    this.rayPolys = attachRayPath(this.hit, NAV.query.maxRaycastPolys);
    this.heightOut = new Raw.Module.FloatRef();
  }

  /** Rays record the polygons they cross (the layer check of walkable is exact). */
  get recordsRayPath(): boolean {
    return this.rayPolys !== null;
  }

  /**
   * Nearest navmesh polygon to p within the half extents (default NAV.query.halfExtents).
   * Returns its ref (0 = none) and writes the snapped point (raw navmesh height) to nx/ny/nz.
   */
  nearest(p: Vec3Like, ext: Vec3Like = NAV.query.halfExtents): number {
    return this.nearestXYZ(p.x, p.y, p.z, ext);
  }

  /** `nearest` for loose coordinates (no temporary point object). */
  nearestXYZ(x: number, y: number, z: number, ext: Vec3Like = NAV.query.halfExtents): number {
    if (this.destroyed) return 0;
    this.refOut.value = 0;
    this.raw.findNearestPoly(
      set3(this._a, x, y, z),
      set3(this._ext, ext.x, ext.y, ext.z),
      this.filter,
      this.refOut,
      this.ptOut,
      this.overOut,
    );
    const ref = this.refOut.value;
    if (ref !== 0) {
      this.nx = this.ptOut.x;
      this.ny = this.ptOut.y;
      this.nz = this.ptOut.z;
    }
    return ref;
  }

  closestPoint(p: Vec3Like, out: Vector3, ext?: Vec3Like): boolean {
    if (this.nearest(p, ext) === 0) return false;
    out.set(this.nx, this.ny - this.bias, this.nz);
    return true;
  }

  /**
   * Random point on the navmesh connected to `center`'s polygon, within `radius` (XZ) of the
   * snapped center. Detour picks a random polygon touching the circle and a point anywhere on
   * it, which can lie far outside a small circle on big polygons: such samples are retried, then
   * a disk sample is taken and clipped where the straight line from the center meets a wall.
   */
  randomPointAround(center: Vec3Like, radius: number, out: Vector3): boolean {
    const start = this.nearest(center);
    if (start === 0) return false;
    const cx = this.nx;
    const cy = this.ny;
    const cz = this.nz;
    const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const r2 = r * r;
    for (let i = 0; i < NAV.query.randomPointAttempts; i++) {
      this.refOut.value = 0;
      this.raw.findRandomPointAroundCircle(
        start,
        set3(this._a, cx, cy, cz),
        r,
        this.filter,
        this.refOut,
        this.ptOut,
      );
      if (this.refOut.value === 0) break;
      const dx = this.ptOut.x - cx;
      const dz = this.ptOut.z - cz;
      if (dx * dx + dz * dz <= r2) {
        out.set(this.ptOut.x, this.ptOut.y - this.bias, this.ptOut.z);
        return true;
      }
    }
    // Disk sample, clipped at the first wall on the straight line from the center.
    const angle = this.random() * TWO_PI;
    const dist = r * Math.sqrt(this.random());
    const tx = cx + Math.cos(angle) * dist;
    const tz = cz + Math.sin(angle) * dist;
    let t = 1;
    if (dist > 0) {
      const status = this.cast(start, cx, cy, cz, tx, cy, tz);
      if (statusFailed(status)) t = 0;
      else if (this.hit.t < RAY_CLEAR_T) {
        t = Math.max(0, this.hit.t - NAV.query.randomPointWallMargin / dist);
      }
    }
    const px = cx + (tx - cx) * t;
    const pz = cz + (tz - cz) * t;
    let py = t > 0 ? this.lastRayHeight(px, cy, pz) : cy;
    if (Number.isNaN(py)) py = this.nearestXYZ(px, cy, pz) !== 0 ? this.ny : cy;
    out.set(px, py - this.bias, pz);
    return true;
  }

  /**
   * Straight-path corners from → to into `out` (grown to at most NAV.query.maxStraightPathPoints
   * vectors on first use, reused afterwards). An unreachable `to` yields the partial path to the
   * closest reachable point. Returns the corner count (0 = no path).
   */
  findPath(from: Vec3Like, to: Vec3Like, out: Vector3[]): number {
    const startRef = this.nearest(from);
    if (startRef === 0) return 0;
    const sx = this.nx;
    const sy = this.ny;
    const sz = this.nz;
    const endRef = this.nearest(to, NAV.query.targetHalfExtents);
    if (endRef === 0) return 0;
    const start = set3(this._a, sx, sy, sz);
    let end = set3(this._b, this.nx, this.ny, this.nz);
    const maxPolys = NAV.query.maxPathPolys;
    this.polys.resize(maxPolys);
    const status = this.raw.findPath(startRef, endRef, start, end, this.filter, this.polys, maxPolys);
    const n = this.polys.size;
    if (statusFailed(status) || n <= 0) return 0;
    const last = this.polys.get(n - 1);
    if (last !== endRef) {
      // Partial path: aim for the closest point on the last reachable polygon.
      this.raw.closestPointOnPoly(last, end, this.ptOut, this.overOut);
      end = set3(this._b, this.ptOut.x, this.ptOut.y, this.ptOut.z);
    }
    const maxPts = NAV.query.maxStraightPathPoints;
    this.countOut.value = 0;
    const sStatus = this.raw.findStraightPath(
      start,
      end,
      this.polys,
      this.straight,
      this.straightFlags,
      this.straightRefs,
      this.countOut,
      maxPts,
      0,
    );
    if (statusFailed(sStatus)) return 0;
    const count = Math.min(this.countOut.value, maxPts);
    while (out.length < count) out.push(new Vector3());
    const s = this.straight;
    for (let i = 0; i < count; i++) {
      out[i]!.set(s.get(i * 3), s.get(i * 3 + 1) - this.bias, s.get(i * 3 + 2));
    }
    return count;
  }

  /**
   * Straight walkable line on the navmesh (no wall / ledge in between):
   * - both endpoints must lie on the walkable area (snapped by at most
   *   NAV.query.walkableSnapTolerance on XZ – not inside a wall or past a ledge),
   * - the height difference must be climbable over the distance,
   * - detour's (2D) raycast must reach the end on the same layer as `to`: the last polygon the
   *   ray crossed is `to`'s polygon or lies at its height there (a ray along the floor under a
   *   deck reaches the deck's XZ on the wrong layer). Rays crossing more than
   *   NAV.query.maxRaycastPolys polygons check the reverse ray instead.
   */
  walkable(from: Vec3Like, to: Vec3Like): boolean {
    const tol2 = NAV.query.walkableSnapTolerance ** 2;
    const aRef = this.nearest(from);
    if (aRef === 0) return false;
    const ax = this.nx;
    const ay = this.ny;
    const az = this.nz;
    if ((ax - from.x) ** 2 + (az - from.z) ** 2 > tol2) return false;
    const bRef = this.nearest(to);
    if (bRef === 0) return false;
    const bx = this.nx;
    const by = this.ny;
    const bz = this.nz;
    if ((bx - to.x) ** 2 + (bz - to.z) ** 2 > tol2) return false;
    const horiz = Math.hypot(bx - ax, bz - az);
    if (Math.abs(by - ay) > horiz * this.maxRisePerMeter + NAV.build.agentClimb) return false;
    if (aRef === bRef) return true;
    if (!this.rayClear(aRef, ax, ay, az, bx, by, bz)) return false;
    const endRef = this.lastRayPoly();
    if (endRef === bRef) return true;
    if (endRef !== 0) {
      const h = this.polyHeight(endRef, bx, by, bz);
      if (!Number.isNaN(h)) return Math.abs(h - by) <= NAV.build.agentClimb;
    }
    return this.rayClear(bRef, bx, by, bz, ax, ay, az);
  }

  /** Detail-mesh height of polygon `ref` at (x, z) (raw navmesh height), or NaN. */
  polyHeight(ref: number, x: number, y: number, z: number): number {
    const status = this.raw.getPolyHeight(ref, set3(this._a, x, y, z), this.heightOut);
    return statusSucceed(status) ? this.heightOut.value : Number.NaN;
  }

  private rayClear(
    ref: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): boolean {
    return statusSucceed(this.cast(ref, x0, y0, z0, x1, y1, z1)) && this.hit.t >= RAY_CLEAR_T;
  }

  /** Navmesh raycast into `hit` (t, crossed polygons when recorded); returns the status. */
  private cast(
    ref: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): number {
    this.hit.t = 0;
    this.hit.pathCount = 0;
    return this.raw.raycast(
      ref,
      set3(this._a, x0, y0, z0),
      set3(this._b, x1, y1, z1),
      this.filter,
      0,
      this.hit,
      0,
    );
  }

  /** Last polygon the previous ray crossed (0 = unknown: not recorded / buffer overflow). */
  private lastRayPoly(): number {
    if (!this.rayPolys) return 0;
    const n = this.hit.pathCount;
    if (n <= 0 || n >= NAV.query.maxRaycastPolys) return 0;
    return this.hit.get_path(n - 1);
  }

  /** Height at (x, z) of the polygon the previous ray ended in, or NaN. */
  private lastRayHeight(x: number, y: number, z: number): number {
    const ref = this.lastRayPoly();
    return ref === 0 ? Number.NaN : this.polyHeight(ref, x, y, z);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rayPolys) {
      // The struct only borrows the buffer: unhook it before freeing.
      writeHitPathPointer(this.hit, 0);
      this.hit.maxPath = 0;
      Raw.destroy(this.rayPolys);
    }
    for (const o of [
      this.refOut,
      this.ptOut,
      this.overOut,
      this.countOut,
      this.polys,
      this.straight,
      this.straightFlags,
      this.straightRefs,
      this.hit,
      this.heightOut,
    ]) {
      Raw.destroy(o);
    }
    this.query.destroy();
    Raw.destroy(this.filter);
  }
}

function writeHitPathPointer(hit: RawModule.dtRaycastHit, ptr: number): void {
  const M = Raw.Module;
  M.HEAPU32[(M.getPointer(hit) + HIT_PATH_OFFSET) >> 2] = ptr;
}

/**
 * Point dtRaycastHit.path at a buffer of `size` polygon refs. Validates the struct layout with
 * marker values written through the typed setters first; returns null (no path recording) if
 * anything does not match.
 */
function attachRayPath(hit: RawModule.dtRaycastHit, size: number): RawModule.UnsignedIntArray | null {
  const M = Raw.Module;
  try {
    const base = M.getPointer(hit);
    const [m0, m1, m2] = LAYOUT_MARKERS;
    hit.hitEdgeIndex = m0;
    hit.pathCount = m1;
    hit.maxPath = m2;
    const heap = M.HEAP32;
    const layoutOk =
      heap[(base + HIT_EDGE_INDEX_OFFSET) >> 2] === m0 &&
      heap[(base + HIT_PATH_COUNT_OFFSET) >> 2] === m1 &&
      heap[(base + HIT_MAX_PATH_OFFSET) >> 2] === m2 &&
      heap[(base + HIT_PATH_OFFSET) >> 2] === 0;
    hit.hitEdgeIndex = 0;
    hit.pathCount = 0;
    hit.maxPath = 0;
    if (!layoutOk) return null;
    const buffer = new M.UnsignedIntArray();
    buffer.resize(size);
    writeHitPathPointer(hit, buffer.getDataPointer() as number);
    // Round trip through the binding's element accessor: it must land in the buffer.
    hit.set_path(0, m0);
    if (buffer.get(0) !== m0) {
      writeHitPathPointer(hit, 0);
      Raw.destroy(buffer);
      return null;
    }
    buffer.set(0, 0);
    hit.maxPath = size;
    return buffer;
  } catch {
    return null;
  }
}
