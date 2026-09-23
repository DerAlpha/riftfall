/**
 * Allocation-free navmesh queries on the raw detour bindings. The high-level recast-navigation
 * wrappers allocate result objects and wasm temporaries per call; here every wasm out-parameter
 * and array is created once and positions go through reused 3-element arrays (the emscripten glue
 * copies them into its own scratch heap).
 *
 * Output heights are lowered by NAV.query.heightBias (the navmesh floats a fraction of a voxel
 * above the rendered floor); inputs are snapped with the search boxes in NAV.query.
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
  private readonly heightOut: RawModule.FloatRef;
  private readonly bias = NAV.query.heightBias;
  private readonly maxRisePerMeter = Math.tan(NAV.build.walkableSlopeDeg * DEG);
  private destroyed = false;

  // Reused position / extents arrays handed to the bindings.
  private readonly _a: number[] = [0, 0, 0];
  private readonly _b: number[] = [0, 0, 0];
  private readonly _ext: number[] = [0, 0, 0];

  constructor(navMesh: NavMesh) {
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
    this.heightOut = new Raw.Module.FloatRef();
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

  /** Random point on polygons reachable from `center` whose area touches the circle. */
  randomPointAround(center: Vec3Like, radius: number, out: Vector3): boolean {
    const start = this.nearest(center);
    if (start === 0) return false;
    this.refOut.value = 0;
    this.raw.findRandomPointAroundCircle(
      start,
      set3(this._a, this.nx, this.ny, this.nz),
      Math.max(0, radius),
      this.filter,
      this.refOut,
      this.ptOut,
    );
    if (this.refOut.value === 0) return false;
    out.set(this.ptOut.x, this.ptOut.y - this.bias, this.ptOut.z);
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
   * Straight walkable line on the navmesh (no wall / ledge in between). Detour's raycast is 2D,
   * so the ray is cast both ways (a ray along the floor under a deck reaches the deck's XZ, the
   * reverse ray along the deck hits its edge) and the height difference must be climbable over
   * the distance. Remaining blind spot: both endpoints under the other's surface.
   */
  walkable(from: Vec3Like, to: Vec3Like): boolean {
    const aRef = this.nearest(from);
    if (aRef === 0) return false;
    const ax = this.nx;
    const ay = this.ny;
    const az = this.nz;
    const bRef = this.nearest(to);
    if (bRef === 0) return false;
    const bx = this.nx;
    const by = this.ny;
    const bz = this.nz;
    const horiz = Math.hypot(bx - ax, bz - az);
    if (Math.abs(by - ay) > horiz * this.maxRisePerMeter + NAV.build.agentClimb) return false;
    if (aRef === bRef) return true;
    return this.rayClear(aRef, ax, ay, az, bx, by, bz) && this.rayClear(bRef, bx, by, bz, ax, ay, az);
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
    this.hit.t = 0;
    this.hit.maxPath = 0;
    const status = this.raw.raycast(
      ref,
      set3(this._a, x0, y0, z0),
      set3(this._b, x1, y1, z1),
      this.filter,
      0,
      this.hit,
      0,
    );
    return statusSucceed(status) && this.hit.t >= RAY_CLEAR_T;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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
