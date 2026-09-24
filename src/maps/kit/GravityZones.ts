/**
 * Gravity zones (GravityFieldApi, M7): boxes and spheres with a gravity multiplier – the orbital
 * map's permanent low-g areas (MapLevelInstance.gravityZones) and the temporary gravity anomalies
 * of the map events. PlayerController and ProjectileSystem sample `scaleAt` every tick (arsenal
 * projectiles and grenades); enemies walk the navmesh unaffected.
 *
 * Every zone blends from 1 at its border to its scale `feather` meters inside (smoothstep), so a
 * jump across the border never pops; overlapping zones multiply (clamped to GRAVITY.minScale ..
 * maxScale). Zones are stored as flat typed arrays (no objects touched per sample): a point test
 * is a few compares per zone, allocation-free. Temporary zones get a handle and an adjustable
 * strength (0..1: the anomaly fades in and out).
 */
import type { GravityFieldApi } from '../../core/contracts';
import { createLogger } from '../../core/log';
import { GRAVITY, type GravityZoneDef } from '../../defs/mapEvents';

const log = createLogger('gravity');

const SHAPE_BOX = 0;
const SHAPE_SPHERE = 1;
/** Floats per zone: shape, a(xyz), b(xyz), scale, feather, strength. */
const STRIDE = 10;

/** Smoothstep 0..1 of how deep `d` (distance inside the border) is within `feather`. */
export function featherWeight(depthInside: number, feather: number): number {
  if (depthInside <= 0) return 0;
  if (!(feather > 0) || depthInside >= feather) return 1;
  const t = depthInside / feather;
  return t * t * (3 - 2 * t);
}

/** Depth of a point inside an AABB (distance to the nearest face; ≤ 0 outside). */
export function boxDepth(
  x: number,
  y: number,
  z: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  return Math.min(x - minX, maxX - x, y - minY, maxY - y, z - minZ, maxZ - z);
}

/** Depth of a point inside a sphere (radius − distance; ≤ 0 outside). */
export function sphereDepth(
  x: number,
  y: number,
  z: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number {
  return r - Math.hypot(x - cx, y - cy, z - cz);
}

export interface GravityZoneInfo {
  readonly id: string;
  readonly shape: 'box' | 'sphere';
  readonly scale: number;
  readonly strength: number;
  readonly temporary: boolean;
  /** Box min / max or sphere center + (radius, 0, 0) in `b`. */
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
}

export class GravityZones implements GravityFieldApi {
  private data: Float64Array;
  private count = 0;
  private readonly ids: string[] = [];
  /** Handle per slot (0 = permanent), and the next handle. */
  private handles: Int32Array;
  private nextHandle = 1;
  private readonly permanent: number;

  constructor(zones: readonly GravityZoneDef[] = [], capacity = 8) {
    const cap = Math.max(1, zones.length + capacity);
    this.data = new Float64Array(cap * STRIDE);
    this.handles = new Int32Array(cap);
    for (const z of zones) this.addSlot(z, 1, 0);
    this.permanent = this.count;
  }

  /** Zones currently in the field (permanent + temporary). */
  get size(): number {
    return this.count;
  }

  scaleAt(x: number, y: number, z: number): number {
    const n = this.count;
    if (n === 0) return 1;
    const d = this.data;
    let s = 1;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const strength = d[o + 9]!;
      if (!(strength > 0)) continue;
      const depth =
        d[o] === SHAPE_BOX
          ? boxDepth(x, y, z, d[o + 1]!, d[o + 2]!, d[o + 3]!, d[o + 4]!, d[o + 5]!, d[o + 6]!)
          : sphereDepth(x, y, z, d[o + 1]!, d[o + 2]!, d[o + 3]!, d[o + 4]!);
      if (depth <= 0) continue;
      const w = featherWeight(depth, d[o + 8]!) * strength;
      s *= 1 + (d[o + 7]! - 1) * w;
    }
    return Math.min(GRAVITY.maxScale, Math.max(GRAVITY.minScale, s));
  }

  /** Add a temporary zone (anomaly); returns its handle (0 when the def is invalid). */
  add(def: GravityZoneDef, strength = 1): number {
    const handle = this.nextHandle++;
    return this.addSlot(def, strength, handle) ? handle : 0;
  }

  /** Strength 0..1 of a temporary zone (fades); false when the handle is gone. */
  setStrength(handle: number, strength: number): boolean {
    const i = this.slotOf(handle);
    if (i < 0) return false;
    this.data[i * STRIDE + 9] = Math.min(1, Math.max(0, strength));
    return true;
  }

  remove(handle: number): boolean {
    const i = this.slotOf(handle);
    if (i < 0) return false;
    const last = this.count - 1;
    if (i !== last) {
      this.data.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
      this.ids[i] = this.ids[last]!;
      this.handles[i] = this.handles[last]!;
    }
    this.ids.length = last;
    this.handles[last] = 0;
    this.count = last;
    return true;
  }

  /** Drop every temporary zone (new run). */
  clearTemporary(): void {
    this.count = this.permanent;
    this.ids.length = this.permanent;
  }

  /** Zones for the dev console / debug view. */
  list(): GravityZoneInfo[] {
    const out: GravityZoneInfo[] = [];
    const d = this.data;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const box = d[o] === SHAPE_BOX;
      out.push({
        id: this.ids[i]!,
        shape: box ? 'box' : 'sphere',
        scale: d[o + 7]!,
        strength: d[o + 9]!,
        temporary: this.handles[i]! !== 0,
        a: [d[o + 1]!, d[o + 2]!, d[o + 3]!],
        b: box ? [d[o + 4]!, d[o + 5]!, d[o + 6]!] : [d[o + 4]!, 0, 0],
      });
    }
    return out;
  }

  private slotOf(handle: number): number {
    if (handle <= 0) return -1;
    for (let i = this.permanent; i < this.count; i++) if (this.handles[i] === handle) return i;
    return -1;
  }

  private addSlot(def: GravityZoneDef, strength: number, handle: number): boolean {
    if (!(def.scale >= 0) || !Number.isFinite(def.scale)) {
      log.warn(`Gravity zone "${def.id}": invalid scale ${def.scale} – ignored`);
      return false;
    }
    if (def.shape === 'sphere' && !(def.radius > 0)) {
      log.warn(`Gravity zone "${def.id}": radius must be > 0 – ignored`);
      return false;
    }
    if (this.count * STRIDE >= this.data.length) this.grow();
    const o = this.count * STRIDE;
    const d = this.data;
    if (def.shape === 'box') {
      d[o] = SHAPE_BOX;
      d[o + 1] = Math.min(def.min[0], def.max[0]);
      d[o + 2] = Math.min(def.min[1], def.max[1]);
      d[o + 3] = Math.min(def.min[2], def.max[2]);
      d[o + 4] = Math.max(def.min[0], def.max[0]);
      d[o + 5] = Math.max(def.min[1], def.max[1]);
      d[o + 6] = Math.max(def.min[2], def.max[2]);
    } else {
      d[o] = SHAPE_SPHERE;
      d[o + 1] = def.center[0];
      d[o + 2] = def.center[1];
      d[o + 3] = def.center[2];
      d[o + 4] = def.radius;
      d[o + 5] = 0;
      d[o + 6] = 0;
    }
    d[o + 7] = def.scale;
    d[o + 8] = def.feather ?? GRAVITY.feather;
    d[o + 9] = Math.min(1, Math.max(0, strength));
    this.ids[this.count] = def.id;
    this.handles[this.count] = handle;
    this.count++;
    return true;
  }

  /** Outside the hot path: only when more temporary zones than planned overlap. */
  private grow(): void {
    const cap = (this.data.length / STRIDE) * 2;
    const next = new Float64Array(cap * STRIDE);
    next.set(this.data);
    this.data = next;
    const h = new Int32Array(cap);
    h.set(this.handles);
    this.handles = h;
  }
}
