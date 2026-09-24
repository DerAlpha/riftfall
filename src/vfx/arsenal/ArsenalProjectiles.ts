/**
 * Projectile visuals and their trails. Projectiles live in a fixed slot pool (ARSENAL_VFX
 * .projectiles.capacity) addressed by generation-checked handles, so a stale handle (ended, or
 * cleared by a run reset) is a quiet no-op. Every frame each live projectile draws its glow
 * layers (and a lit grenade body), and its trail stores a point every `spacing` m.
 *
 * Trails are their own pool: when a projectile ends its ribbon stays behind and fades out as its
 * points expire, then the trail slot frees itself. Ribbon patterns are anchored to the flight
 * path (u = odometer), particle puffs are spawned every `puffs.spacing` m along it.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/events';
import {
  ARSENAL_VFX,
  DEFAULT_PROJECTILE_VISUAL,
  getProjectileVisual,
  getTrailStyle,
  type ProjectileVisualDef,
  type RibbonDef,
  type TrailStyleDef,
} from '../../defs/arsenalVfx';
import { projectileMeshIndex } from './BodyMeshes';
import { pushGlow, requestLens, type ArsenalContext } from './context';
import { stripStyleIndex } from './StripBatch';

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _n = { x: 0, y: 0, z: 0 };

class ProjectileSlot {
  active = false;
  gen = 0;
  visual: ProjectileVisualDef = DEFAULT_PROJECTILE_VISUAL;
  bodyMesh = 0;
  trail: TrailSlot | null = null;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly dir = new THREE.Vector3(0, 0, -1);
  /** Launch orientation of the body (+Z along the launch direction) and its tumble axis. */
  readonly baseQuat = new THREE.Quaternion();
  readonly tumbleAxis = new THREE.Vector3(1, 0, 0);
  readonly quat = new THREE.Quaternion();
  age = 0;
  seed = 0;
}

class TrailSlot {
  active = false;
  style: TrailStyleDef | null = null;
  owner: ProjectileSlot | null = null;
  /** Ring of stored points: x, y, z, birth time. Newest at head − 1. */
  readonly pts = new Float32Array(ARSENAL_VFX.trails.maxPoints * 4);
  head = 0;
  count = 0;
  /** Distance the head has flown (pattern anchor) and since the last particle puff. */
  odometer = 0;
  puffDist = 0;
  readonly last = new THREE.Vector3();
  seed = 0;
}

export class ArsenalProjectiles {
  readonly capacity = ARSENAL_VFX.projectiles.capacity;
  private readonly slots: ProjectileSlot[] = [];
  private readonly free: number[] = [];
  private readonly trails: TrailSlot[] = [];
  private _active = 0;
  private _trails = 0;

  constructor(private readonly ctx: ArsenalContext) {
    for (let i = 0; i < this.capacity; i++) this.slots.push(new ProjectileSlot());
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
    for (let i = 0; i < ARSENAL_VFX.trails.capacity; i++) this.trails.push(new TrailSlot());
  }

  /** Live projectiles. */
  get active(): number {
    return this._active;
  }

  /** Live trails (incl. fading ones whose projectile ended). */
  get trailCount(): number {
    return this._trails;
  }

  start(visual: string, trail: string | null, position: Vec3Like, velocity: Vec3Like): number {
    if (!finite(position) || !finite(velocity)) return 0;
    const index = this.free.pop();
    if (index === undefined) return 0;
    const s = this.slots[index]!;
    s.active = true;
    s.visual = getProjectileVisual(visual) ?? DEFAULT_PROJECTILE_VISUAL;
    s.bodyMesh = s.visual.body ? projectileMeshIndex(s.visual.body.mesh) : 0;
    s.pos.set(position.x, position.y, position.z);
    s.vel.set(velocity.x, velocity.y, velocity.z);
    if (s.vel.lengthSq() > 1e-8) s.dir.copy(s.vel).normalize();
    else s.dir.set(0, 0, -1);
    s.age = 0;
    s.seed = this.ctx.rand();
    s.baseQuat.setFromUnitVectors(Z_AXIS, s.dir);
    s.tumbleAxis.crossVectors(s.dir, UP);
    if (s.tumbleAxis.lengthSq() < 1e-6) s.tumbleAxis.set(1, 0, 0);
    s.tumbleAxis.normalize();
    s.quat.copy(s.baseQuat);
    s.trail = trail ? this.startTrail(trail, s) : null;
    this._active++;
    return this.handleOf(index);
  }

  move(handle: number, position: Vec3Like, velocity: Vec3Like): void {
    const s = this.slotOf(handle);
    if (!s || !finite(position) || !finite(velocity)) return;
    s.pos.set(position.x, position.y, position.z);
    s.vel.set(velocity.x, velocity.y, velocity.z);
    if (s.vel.lengthSq() > 1e-8) s.dir.copy(s.vel).normalize();
  }

  end(handle: number): void {
    const index = this.indexOf(handle);
    if (index >= 0) this.release(this.slots[index]!, index);
  }

  /** Age, draw and trail every live projectile; age and draw every trail. */
  update(dt: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.active) continue;
      s.age += dt;
      this.draw(s);
    }
    for (const t of this.trails) {
      if (t.active) this.updateTrail(t, ctx.time);
    }
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.active) this.release(s, i);
    }
    for (const t of this.trails) {
      if (t.active) this.freeTrail(t);
    }
  }

  // -------------------------------------------------------------------------

  private handleOf(index: number): number {
    return this.slots[index]!.gen * (this.capacity + 1) + index + 1;
  }

  /** Slot index of a live handle, -1 for 0, stale or foreign handles. */
  private indexOf(handle: number): number {
    if (!(handle > 0) || !Number.isFinite(handle)) return -1;
    const index = (handle % (this.capacity + 1)) - 1;
    const s = this.slots[index];
    if (!s || !s.active || s.gen !== Math.floor(handle / (this.capacity + 1))) return -1;
    return index;
  }

  private slotOf(handle: number): ProjectileSlot | null {
    const index = this.indexOf(handle);
    return index >= 0 ? this.slots[index]! : null;
  }

  private release(s: ProjectileSlot, index: number): void {
    if (s.trail) {
      // The ribbon keeps its last head point and fades out on its own.
      this.storePoint(s.trail, s.pos.x, s.pos.y, s.pos.z, this.ctx.time);
      s.trail.owner = null;
      s.trail = null;
    }
    s.active = false;
    s.gen = (s.gen + 1) % 0x100000;
    this.free.push(index);
    this._active--;
  }

  private draw(s: ProjectileSlot): void {
    const ctx = this.ctx;
    const v = s.visual;
    const speed = s.vel.length();
    const d = s.dir;
    for (const layer of v.glows) {
      pushGlow(ctx, layer, s.pos.x, s.pos.y, s.pos.z, d.x, d.y, d.z, speed, s.age, s.seed, 1, 1);
    }
    const body = v.body;
    if (body) {
      if (body.mesh === 'shell') {
        // Nose first, rolling around the flight axis.
        s.quat.setFromUnitVectors(Z_AXIS, d);
        s.quat.multiply(_q.setFromAxisAngle(Z_AXIS, body.tumble * s.age + s.seed * Math.PI * 2));
      } else {
        s.quat.setFromAxisAngle(s.tumbleAxis, body.tumble * s.age).multiply(s.baseQuat);
      }
      ctx.bodies.push(
        s.bodyMesh,
        s.pos,
        s.quat,
        body.radius,
        body.length,
        body.color,
        body.band,
        body.bandIntensity,
      );
    }
    if (v.lens) requestLens(ctx, s.pos, v.lens.radius, v.lens.strength);
  }

  private startTrail(id: string, owner: ProjectileSlot): TrailSlot | null {
    const style = getTrailStyle(id);
    if (!style) return null;
    let t: TrailSlot | null = null;
    for (const x of this.trails) {
      if (!x.active) {
        t = x;
        break;
      }
    }
    if (!t) return null;
    t.active = true;
    t.style = style;
    t.owner = owner;
    t.head = 0;
    t.count = 0;
    t.odometer = 0;
    t.puffDist = 0;
    t.seed = this.ctx.rand();
    t.last.copy(owner.pos);
    this.storePoint(t, owner.pos.x, owner.pos.y, owner.pos.z, this.ctx.time);
    this._trails++;
    return t;
  }

  private freeTrail(t: TrailSlot): void {
    if (t.owner) t.owner.trail = null;
    t.owner = null;
    t.active = false;
    t.count = 0;
    this._trails--;
  }

  private storePoint(t: TrailSlot, x: number, y: number, z: number, time: number): void {
    const max = ARSENAL_VFX.trails.maxPoints;
    const o = t.head * 4;
    t.pts[o] = x;
    t.pts[o + 1] = y;
    t.pts[o + 2] = z;
    t.pts[o + 3] = time;
    t.head = (t.head + 1) % max;
    t.count = Math.min(max, t.count + 1);
  }

  private updateTrail(t: TrailSlot, now: number): void {
    const style = t.style!;
    const ribbon = style.ribbon;
    const owner = t.owner;
    if (owner) {
      const dx = owner.pos.x - t.last.x;
      const dy = owner.pos.y - t.last.y;
      const dz = owner.pos.z - t.last.z;
      const moved = Math.hypot(dx, dy, dz);
      if (moved > 1e-6) {
        this.puffs(t, style, moved, dx / moved, dy / moved, dz / moved);
        t.odometer += moved;
        t.last.copy(owner.pos);
        this.maybeStore(t, ribbon, now);
      }
    }
    // Drop expired points (oldest first).
    const life = ribbon ? ribbon.life : 0;
    const max = ARSENAL_VFX.trails.maxPoints;
    while (t.count > 0) {
      const oldest = (t.head - t.count + max) % max;
      if (now - t.pts[oldest * 4 + 3]! <= life) break;
      t.count--;
    }
    if (!owner && t.count === 0) {
      this.freeTrail(t);
      return;
    }
    if (ribbon) this.drawRibbon(t, ribbon, now);
  }

  /** Store the head as a new point once it is `spacing` m from the newest stored point. */
  private maybeStore(t: TrailSlot, ribbon: RibbonDef | null, now: number): void {
    const owner = t.owner!;
    const max = ARSENAL_VFX.trails.maxPoints;
    if (t.count > 0) {
      const o = ((t.head - 1 + max) % max) * 4;
      const d = Math.hypot(owner.pos.x - t.pts[o]!, owner.pos.y - t.pts[o + 1]!, owner.pos.z - t.pts[o + 2]!);
      if (d < (ribbon ? ribbon.spacing : 0)) return;
    }
    this.storePoint(t, owner.pos.x, owner.pos.y, owner.pos.z, now);
  }

  private puffs(t: TrailSlot, style: TrailStyleDef, moved: number, dx: number, dy: number, dz: number): void {
    const puffs = style.puffs;
    if (!puffs || !(this.ctx.budget > 0)) return;
    t.puffDist += moved;
    let n = 0;
    _n.x = -dx;
    _n.y = -dy;
    _n.z = -dz;
    while (t.puffDist >= puffs.spacing && n < ARSENAL_VFX.trails.maxPuffsPerFrame) {
      t.puffDist -= puffs.spacing;
      // Along the path flown this frame, oldest first.
      const back = t.puffDist;
      const owner = t.owner!;
      _v.set(owner.pos.x - dx * back, owner.pos.y - dy * back, owner.pos.z - dz * back);
      this.ctx.spawn(puffs.effect, _v, _n, puffs.scale);
      n++;
    }
    if (t.puffDist > puffs.spacing) t.puffDist = puffs.spacing * 0.5;
  }

  private drawRibbon(t: TrailSlot, r: RibbonDef, now: number): void {
    const ctx = this.ctx;
    const strips = ctx.strips;
    const max = ARSENAL_VFX.trails.maxPoints;
    const k0 = ctx.flashScale;
    strips.beginStrip(stripStyleIndex(r.style), t.seed, t.odometer, -1);
    const owner = t.owner;
    let n = 0;
    if (owner) {
      // The live head leads the stored points.
      this.ribbonPoint(r, owner.pos.x, owner.pos.y, owner.pos.z, 0, k0);
      n++;
    }
    for (let i = 0; i < t.count; i++) {
      const o = ((t.head - 1 - i + max) % max) * 4;
      const age = now - t.pts[o + 3]!;
      this.ribbonPoint(r, t.pts[o]!, t.pts[o + 1]!, t.pts[o + 2]!, age / r.life, k0);
      n++;
    }
    if (n >= 2) strips.endStrip();
    else strips.beginStrip(0, 0);
  }

  private ribbonPoint(r: RibbonDef, x: number, y: number, z: number, k: number, flash: number): void {
    const t = Math.min(1, Math.max(0, k));
    const w = r.width + (r.widthTail - r.width) * t;
    const i0 = r.intensity * flash;
    const i1 = r.intensityTail * flash;
    const cr = r.color[0] * i0 + (r.colorTail[0] * i1 - r.color[0] * i0) * t;
    const cg = r.color[1] * i0 + (r.colorTail[1] * i1 - r.color[1] * i0) * t;
    const cb = r.color[2] * i0 + (r.colorTail[2] * i1 - r.color[2] * i0) * t;
    const fade = 1 - t;
    this.ctx.strips.point(x, y, z, w, cr, cg, cb, fade * fade);
  }
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
