/**
 * Lingering field visuals (singularity, fire pool, poison cloud, frost field). A fixed slot pool
 * with generation-checked handles; a field grows in, lives for its duration (or until fieldEnd)
 * and fades out, then frees itself. One floor probe at the start places ground discs; pull cores
 * are lifted to their style's coreHeight above the floor so the accretion disc is never cut by it.
 * Ambient particles (flames, mist, glitter, motes) spawn at area-proportional rates × particle
 * budget; pull fields launch streaks that fall into the core and bend the image (screen lens).
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/events';
import {
  ARSENAL_VFX,
  DEFAULT_FIELD_VISUAL,
  getFieldVisual,
  type FieldAmbientDef,
  type FieldVisualDef,
} from '../../defs/arsenalVfx';
import { spriteCell } from '../atlas';
import { createParticleSpawn } from '../ParticleBuffer';
import { discStyleIndex } from './DiscBatch';
import {
  PROBE_OPTS,
  createSustainState,
  pushGlow,
  requestLens,
  sustainLight,
  type ArsenalContext,
  type SustainState,
} from './context';

const DOWN = { x: 0, y: -1, z: 0 };
const UP = { x: 0, y: 1, z: 0 };
/** Floor probes start this far above the field point (it may sit exactly on the floor). */
const PROBE_LIFT = 0.25;
/** Core glows scale with the field radius within these bounds (× referenceRadius). */
const CORE_SCALE: readonly [number, number] = [0.6, 1.5];
/** Ground discs grow over fadeIn × this. */
const GROW_TIME = 2;
const MAX_AMBIENT = 4;

const _p = new THREE.Vector3();
const _probe = new THREE.Vector3();
const spawn = createParticleSpawn();
const STREAK_CELL = spriteCell('streak');

class FieldSlot {
  active = false;
  gen = 0;
  def: FieldVisualDef = DEFAULT_FIELD_VISUAL;
  readonly core = new THREE.Vector3();
  readonly floor = new THREE.Vector3();
  readonly floorNormal = new THREE.Vector3(0, 1, 0);
  hasFloor = false;
  radius = 1;
  duration = 0;
  age = 0;
  /** Age at which fieldEnd() started the fade-out (−1 = not ended). */
  endedAt = -1;
  seed = 0;
  readonly acc = new Float32Array(MAX_AMBIENT);
  infallAcc = 0;
  readonly light: SustainState = createSustainState();
}

export class ArsenalFields {
  readonly capacity = ARSENAL_VFX.fields.capacity;
  private readonly slots: FieldSlot[] = [];
  private _active = 0;

  constructor(private readonly ctx: ArsenalContext) {
    for (let i = 0; i < this.capacity; i++) this.slots.push(new FieldSlot());
  }

  get active(): number {
    return this._active;
  }

  start(visual: string, position: Vec3Like, radius: number, duration: number): number {
    if (!finite(position) || !(radius > 0)) return 0;
    let index = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]!.active) {
        index = i;
        break;
      }
    }
    if (index < 0) return 0;
    const f = this.slots[index]!;
    const def = getFieldVisual(visual) ?? DEFAULT_FIELD_VISUAL;
    f.active = true;
    f.def = def;
    f.radius = radius;
    f.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    f.age = 0;
    f.endedAt = -1;
    f.seed = this.ctx.rand();
    f.acc.fill(0);
    f.infallAcc = 0;
    f.light.timer = 0;
    f.light.handle = 0;
    this.place(f, position);
    this._active++;
    return f.gen * (this.capacity + 1) + index + 1;
  }

  end(handle: number): void {
    const f = this.slotOf(handle);
    if (f && f.endedAt < 0) f.endedAt = f.age;
  }

  update(dt: number): void {
    for (const f of this.slots) {
      if (!f.active) continue;
      f.age += dt;
      const fade = this.fadeOf(f);
      if (fade <= 0 && f.age > f.def.fadeIn) {
        this.release(f);
        continue;
      }
      this.draw(f, fade, dt);
    }
  }

  clear(): void {
    for (const f of this.slots) if (f.active) this.release(f);
  }

  // -------------------------------------------------------------------------

  private slotOf(handle: number): FieldSlot | null {
    if (!(handle > 0) || !Number.isFinite(handle)) return null;
    const index = (handle % (this.capacity + 1)) - 1;
    const f = this.slots[index];
    if (!f || !f.active || f.gen !== Math.floor(handle / (this.capacity + 1))) return null;
    return f;
  }

  private release(f: FieldSlot): void {
    f.active = false;
    f.gen = (f.gen + 1) % 0x100000;
    this._active--;
  }

  private place(f: FieldSlot, position: Vec3Like): void {
    const def = f.def;
    f.core.set(position.x, position.y, position.z);
    f.hasFloor = false;
    const physics = this.ctx.physics;
    if (physics) {
      _probe.set(position.x, position.y + PROBE_LIFT, position.z);
      const hit = physics.raycast(_probe, DOWN, ARSENAL_VFX.fields.floorProbe + PROBE_LIFT, PROBE_OPTS);
      if (hit) {
        f.hasFloor = true;
        f.floor.copy(hit.point);
        f.floorNormal.copy(hit.normal);
      }
    }
    if (!f.hasFloor) {
      f.floor.copy(f.core);
      f.floorNormal.set(0, 1, 0);
    }
    if (def.coreHeight > 0 && f.hasFloor) f.core.y = Math.max(f.core.y, f.floor.y + def.coreHeight);
  }

  /** Grow-in × fade-out (duration end or fieldEnd). */
  private fadeOf(f: FieldSlot): number {
    const def = f.def;
    const fadeIn = def.fadeIn > 0 ? Math.min(1, f.age / def.fadeIn) : 1;
    let out = 1;
    if (f.endedAt >= 0) out = def.fadeOut > 0 ? 1 - (f.age - f.endedAt) / def.fadeOut : 0;
    else if (f.duration > 0) out = def.fadeOut > 0 ? (f.duration - f.age) / def.fadeOut : f.age < f.duration ? 1 : 0;
    return Math.max(0, Math.min(fadeIn, out, 1));
  }

  private draw(f: FieldSlot, fade: number, dt: number): void {
    const ctx = this.ctx;
    const def = f.def;
    const disc = def.disc;
    const flash = ctx.flashScale;
    if (disc) {
      const r = Math.min(disc.maxRadius, f.radius * disc.radiusScale);
      const grow = def.fadeIn > 0 ? Math.min(1, f.age / (def.fadeIn * GROW_TIME)) : 1;
      const k = disc.intensity * fade * flash;
      const lift = ARSENAL_VFX.discs.lift;
      const c = disc.ground ? f.floor : f.core;
      const n = disc.ground ? f.floorNormal : _p.set(0, 1, 0);
      ctx.discs.push(
        c.x + n.x * lift,
        c.y + n.y * lift,
        c.z + n.z * lift,
        r,
        n.x,
        n.y,
        n.z,
        f.seed * Math.PI * 2,
        disc.color[0] * k,
        disc.color[1] * k,
        disc.color[2] * k,
        1,
        discStyleIndex(disc.style),
        f.seed,
        f.age,
        grow,
      );
    }
    const ref = ARSENAL_VFX.fields.referenceRadius;
    const coreScale = Math.min(CORE_SCALE[1], Math.max(CORE_SCALE[0], f.radius / ref));
    for (const layer of def.glows) {
      pushGlow(ctx, layer, f.core.x, f.core.y, f.core.z, 0, 1, 0, 0, f.age, f.seed, coreScale * (0.6 + 0.4 * fade), fade);
    }
    // Ambient particles (area-proportional, budget-scaled, stop spawning while fading out).
    if (ctx.budget > 0 && fade > 0.5) {
      const area = (f.radius / ref) * (f.radius / ref);
      for (let i = 0; i < def.ambient.length && i < MAX_AMBIENT; i++) {
        const a = def.ambient[i]!;
        f.acc[i] = f.acc[i]! + dt * a.rate * area * ctx.budget;
        let n = 0;
        while (f.acc[i]! >= 1 && n++ < ARSENAL_VFX.fields.maxSpawnsPerFrame) {
          f.acc[i] = f.acc[i]! - 1;
          this.ambientPoint(f, a, _p);
          ctx.spawn(a.effect, _p, UP, a.scale);
        }
        if (f.acc[i]! > 1) f.acc[i] = 1;
      }
      if (def.infall) this.infall(f, dt, coreScale);
    }
    if (def.lens) {
      const lr = Math.min(def.lens.maxRadius, f.radius * def.lens.radiusScale);
      requestLens(ctx, f.core, lr, def.lens.strength * fade);
    }
    const lightAt = disc && disc.ground ? f.floor : f.core;
    sustainLight(ctx, f.light, def.light, 0, dt, lightAt, disc && disc.ground ? f.floorNormal : null, fade * flash);
  }

  private ambientPoint(f: FieldSlot, a: FieldAmbientDef, out: THREE.Vector3): void {
    const r = this.ctx.rand;
    const h = a.height[0] + (a.height[1] - a.height[0]) * r();
    const ang = r() * Math.PI * 2;
    if (a.area === 'core') {
      const rr = 0.3 * Math.cbrt(r());
      out.set(f.core.x + Math.cos(ang) * rr, f.core.y + h * (r() * 2 - 1), f.core.z + Math.sin(ang) * rr);
      return;
    }
    const disc = f.def.disc;
    const radius = disc ? Math.min(disc.maxRadius, f.radius * disc.radiusScale) : f.radius;
    const rr = a.area === 'rim' ? radius * (0.85 + 0.15 * r()) : radius * Math.sqrt(r()) * 0.92;
    const base = disc && !disc.ground ? f.core : f.floor;
    out.set(base.x + Math.cos(ang) * rr, base.y + h, base.z + Math.sin(ang) * rr);
  }

  /** Streaks falling into the core with a swirl (direct spawns: velocity per particle). */
  private infall(f: FieldSlot, dt: number, coreScale: number): void {
    const inf = f.def.infall!;
    const buf = this.ctx.particles?.additiveBuffer;
    if (!buf) return;
    const r = this.ctx.rand;
    f.infallAcc += dt * inf.rate * this.ctx.budget;
    let n = 0;
    const reach = Math.min(f.radius * 0.7, 2.6 * coreScale);
    const k = inf.intensity * this.ctx.flashScale;
    while (f.infallAcc >= 1 && n++ < ARSENAL_VFX.fields.maxSpawnsPerFrame * 2) {
      f.infallAcc -= 1;
      // Mostly in the disc plane (flattened sphere).
      const ang = r() * Math.PI * 2;
      const y = (r() * 2 - 1) * 0.35;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const dist = reach * (0.55 + 0.45 * r());
      const speed = inf.speed[0] + (inf.speed[1] - inf.speed[0]) * r();
      spawn.x = f.core.x + dx * dist;
      spawn.y = f.core.y + y * dist;
      spawn.z = f.core.z + dz * dist;
      // Inward + tangential (the swirl makes them spiral past the core, behind the horizon).
      const sw = inf.swirl;
      spawn.vx = (-dx + -dz * sw) * speed;
      spawn.vy = -y * speed;
      spawn.vz = (-dz + dx * sw) * speed;
      spawn.life = (dist / speed) * 0.95;
      spawn.size0 = inf.size;
      spawn.size1 = inf.size * 0.6;
      spawn.r0 = inf.color[0] * k * 0.4;
      spawn.g0 = inf.color[1] * k * 0.4;
      spawn.b0 = inf.color[2] * k * 0.4;
      spawn.r1 = inf.colorEnd[0] * k;
      spawn.g1 = inf.colorEnd[1] * k;
      spawn.b1 = inf.colorEnd[2] * k;
      spawn.a0 = 1;
      spawn.a1 = 1;
      spawn.fadeIn = 0.3;
      spawn.fadeOut = 0.15;
      spawn.gravity = 0;
      spawn.drag = 0;
      spawn.rotation = 0;
      spawn.spin = 0;
      spawn.stretch = 0.035;
      spawn.cell = STREAK_CELL;
      spawn.bounce = -1;
      spawn.planeNx = spawn.planeNy = spawn.planeNz = spawn.planeD = 0;
      spawn.floorY = Number.NEGATIVE_INFINITY;
      buf.spawn(spawn);
    }
    if (f.infallAcc > 1) f.infallAcc = 1;
  }
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
