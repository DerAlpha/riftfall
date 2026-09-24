/**
 * Visuals of the M5 arsenal (ArsenalVfxApi): projectiles with trails, continuous beams with chain
 * arcs, one-shot rays, lingering fields and the charge glow. The simulation (ProjectileApi, beam
 * weapons, FieldApi, charge weapons) calls it; every look comes from defs/arsenalVfx.ts (+ effect
 * presets in defs/vfx.ts) – this class never branches on a visual id, unknown ids draw defaults.
 *
 * Construction: by VfxSystem (it shares the particle system, the pooled flash lights and preset
 * spawning); Game exposes it as sys.arsenalVfx. Everything is preallocated at its capacity
 * (ARSENAL_VFX); the particle quality budget scales ambient emission only – projectiles, beams and
 * fields themselves always draw (gameplay readability).
 *
 * Frame order: the simulation moves projectiles (projectileMove) and refreshes beams / charges
 * (beam, charge – each frame they last) BEFORE update(); update() then rebuilds the draw batches
 * (a few instanced draws: emissive glows, dark discs, strips, discs, grenade bodies) and ends the
 * frame – beams and charges not refreshed since the previous update() go dark. Handles are
 * generation-checked: a stale one (ended, or after clear()) is ignored.
 */
import * as THREE from 'three';
import type { ArsenalVfxApi, PhysicsApi, RenderApi, VfxSocketSource } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import { ARSENAL_VFX, DEFAULT_CHARGE_STYLE, getChargeStyle, type ChargeStyleDef } from '../../defs/arsenalVfx';
import type { Rand } from '../emit';
import type { LightPool } from '../LightPool';
import type { ParticleSystem } from '../ParticleSystem';
import { ArsenalBeams } from './ArsenalBeams';
import { ArsenalFields } from './ArsenalFields';
import { ArsenalProjectiles } from './ArsenalProjectiles';
import { BodyMeshes } from './BodyMeshes';
import { ChargeGlow } from './ChargeGlow';
import {
  LENS_STRIDE,
  createLensQueue,
  createSustainState,
  sustainLight,
  type ArsenalContext,
  type EffectSpawner,
  type LensSink,
  type SustainState,
} from './context';
import { DiscBatch } from './DiscBatch';
import { GlowSprites } from './GlowSprites';
import { StripBatch } from './StripBatch';

export type { EffectSpawner, LensSink };

export interface ArsenalVfxDeps {
  render: Pick<RenderApi, 'scene' | 'camera' | 'setupMaterial'>;
  /** Shared particle system (flame streams, infalling streaks); null draws without them. */
  particles?: ParticleSystem | null;
  /** Pooled VFX flash lights (beam / field / charge lights). */
  lights?: LightPool | null;
  /** Effect preset spawner (trail puffs, hit sparks, field ambience). */
  spawn: EffectSpawner;
  /** Floor probes under fields. */
  physics?: PhysicsApi | null;
  /** Viewmodel sockets: charge glow anchor, start of one-shot rays as displayed. */
  sockets?: () => VfxSocketSource | null;
  /** Screen-space lens (singularities); null = none. */
  lens?: LensSink | null;
  random?: Rand;
}

interface PendingShot {
  visual: string;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

const _v = new THREE.Vector3();
const _from = { x: 0, y: 0, z: 0 };
const _to = { x: 0, y: 0, z: 0 };
const _lens = { x: 0, y: 0, z: 0 };

export class ArsenalVfx implements ArsenalVfxApi {
  /** World-scene draw batches (add to render.scene). */
  readonly object = new THREE.Group();
  readonly projectiles: ArsenalProjectiles;
  readonly beams: ArsenalBeams;
  readonly fields: ArsenalFields;
  private readonly ctx: ArsenalContext;
  private readonly chargeGlow = new ChargeGlow();
  private readonly chargeLight: SustainState = createSustainState();
  private chargeStyle: ChargeStyleDef = DEFAULT_CHARGE_STYLE;
  private chargeAmount = 0;
  private chargeStamp = -1;
  private epoch = 0;
  private readonly sockets: () => VfxSocketSource | null;
  private readonly camera: THREE.Camera;
  private readonly lens: LensSink | null;
  /** Lens slots fed last frame (turned off once unused). */
  private lensUsed = 0;
  private readonly pending: PendingShot[] = [];
  private pendingCount = 0;
  private readonly time = { value: 0 };
  private readonly _stats = { projectiles: 0, trails: 0, beams: 0, fields: 0, glows: 0, segments: 0 };
  private preview: ((dt: number) => void) | null = null;
  private warming = false;
  private disposed = false;

  constructor(deps: ArsenalVfxDeps) {
    const g = ARSENAL_VFX.glows;
    const glows = new GlowSprites(g.capacity, false);
    const dark = new GlowSprites(g.darkCapacity, true);
    const strips = new StripBatch(ARSENAL_VFX.strips.capacity, this.time);
    const discs = new DiscBatch(ARSENAL_VFX.discs.capacity);
    const bodies = new BodyMeshes((m) => deps.render.setupMaterial(m));
    this.object.name = 'ArsenalVfx';
    this.object.add(dark.mesh, discs.mesh, strips.mesh, glows.mesh, bodies.object);
    this.ctx = {
      eye: new THREE.Vector3(),
      glows,
      dark,
      strips,
      discs,
      bodies,
      particles: deps.particles ?? null,
      spawn: deps.spawn,
      lights: deps.lights ?? null,
      physics: deps.physics ?? null,
      rand: deps.random ?? Math.random,
      budget: 1,
      flashScale: 1,
      time: 0,
      lensQueue: createLensQueue(),
      lensCount: 0,
    };
    this.camera = deps.render.camera;
    this.sockets = deps.sockets ?? (() => null);
    this.lens = deps.lens ?? null;
    this.projectiles = new ArsenalProjectiles(this.ctx);
    this.beams = new ArsenalBeams(this.ctx);
    this.fields = new ArsenalFields(this.ctx);
    for (let i = 0; i < ARSENAL_VFX.beams.shots; i++) {
      this.pending.push({ visual: '', fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // ArsenalVfxApi
  // -------------------------------------------------------------------------

  projectileStart(visual: string, trail: string | null, position: Vec3Like, velocity: Vec3Like): number {
    if (this.disposed) return 0;
    return this.projectiles.start(visual, trail, position, velocity);
  }

  projectileMove(handle: number, position: Vec3Like, velocity: Vec3Like): void {
    this.projectiles.move(handle, position, velocity);
  }

  projectileEnd(handle: number): void {
    this.projectiles.end(handle);
  }

  beam(visual: string, from: Vec3Like, to: Vec3Like, arcs: readonly Vec3Like[], arcCount: number): void {
    if (this.disposed) return;
    this.beams.beam(visual, from, to, arcs, arcCount);
  }

  fieldStart(visual: string, position: Vec3Like, radius: number, duration: number): number {
    if (this.disposed) return 0;
    return this.fields.start(visual, position, radius, duration);
  }

  fieldEnd(handle: number): void {
    this.fields.end(handle);
  }

  charge(visual: string, amount: number): void {
    if (this.disposed) return;
    this.chargeStyle = getChargeStyle(visual) ?? DEFAULT_CHARGE_STYLE;
    this.chargeAmount = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    this.chargeStamp = this.epoch;
  }

  /**
   * One-shot ray of a hitscan shot (railgun slug, void ray; VfxBridge for muzzle presets with a
   * `tracer` style): it starts at the muzzle socket as displayed this frame (`from`: fallback),
   * resolved in update() like the player tracers.
   */
  shot(visual: string, to: Vec3Like, from: Vec3Like): void {
    if (this.disposed || this.pendingCount >= this.pending.length) return;
    const p = this.pending[this.pendingCount++]!;
    p.visual = visual;
    p.fx = from.x;
    p.fy = from.y;
    p.fz = from.z;
    p.tx = to.x;
    p.ty = to.y;
    p.tz = to.z;
  }

  update(dt: number): void {
    if (this.disposed) return;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this.time.value += step;
    const ctx = this.ctx;
    ctx.time = this.time.value;
    this.camera.getWorldPosition(ctx.eye);
    this.preview?.(step);

    ctx.glows.begin();
    ctx.dark.begin();
    ctx.strips.begin();
    ctx.discs.begin();
    ctx.bodies.begin();
    ctx.lensCount = 0;

    this.flushShots();
    this.projectiles.update(step);
    this.beams.update(step);
    this.fields.update(step);
    this.updateCharge(step);

    ctx.glows.end();
    ctx.dark.end();
    ctx.strips.end();
    ctx.discs.end();
    ctx.bodies.end();
    this.flushLenses();
    this.epoch++;
  }

  clear(): void {
    this.projectiles.clear();
    this.beams.clear();
    this.fields.clear();
    this.pendingCount = 0;
    this.chargeStamp = -1;
    this.chargeGlow.hide();
    this.chargeLight.handle = 0;
    const ctx = this.ctx;
    for (const b of [ctx.glows, ctx.dark, ctx.strips, ctx.discs]) {
      b.begin();
      b.end();
    }
    ctx.bodies.begin();
    ctx.bodies.end();
    ctx.lensCount = 0;
    this.flushLenses();
  }

  // -------------------------------------------------------------------------
  // VFX-side controls (VfxSystem)
  // -------------------------------------------------------------------------

  /** Particle quality budget (QUALITY_LEVELS.particles.budgetMultiplier; 0 = no ambient particles). */
  setBudget(multiplier: number): void {
    this.ctx.budget = Math.max(0, Number.isFinite(multiplier) ? multiplier : 1);
  }

  /** Reduce-flashing multiplier on glows, beams and lights. */
  setFlashScale(scale: number): void {
    this.ctx.flashScale = Math.max(0, Number.isFinite(scale) ? scale : 1);
  }

  /** Dev preview driver (console `fx`), run at the start of every update(). */
  setPreviewDriver(driver: ((dt: number) => void) | null): void {
    this.preview = driver;
  }

  /** Something is drawn on RENDER.volumetricLayer (the volumetric pass must run). */
  get hasVolumetricContent(): boolean {
    return (
      this.warming ||
      this.projectiles.active > 0 ||
      this.projectiles.trailCount > 0 ||
      this.beams.live > 0 ||
      this.fields.active > 0
    );
  }

  /** Live counts (debug overlay / console; one reused object). */
  get stats(): Readonly<typeof this._stats> {
    const c = this.ctx;
    const s = this._stats;
    s.projectiles = this.projectiles.active;
    s.trails = this.projectiles.trailCount;
    s.beams = this.beams.live;
    s.fields = this.fields.active;
    s.glows = c.glows.count + c.dark.count;
    s.segments = c.strips.count;
    return s;
  }

  /** Shader warm-up: every batch draws one invisible instance during VfxSystem.warmup(). */
  setWarmup(active: boolean): void {
    const c = this.ctx;
    this.warming = active;
    for (const b of [c.glows, c.dark, c.strips, c.discs]) b.setWarmup(active);
    c.bodies.setWarmup(active);
    if (active) this.chargeGlow.attach(this.sockets()?.getSocketObject('muzzle') ?? null);
    this.chargeGlow.setWarmup(active);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    const c = this.ctx;
    c.glows.dispose();
    c.dark.dispose();
    c.strips.dispose();
    c.discs.dispose();
    c.bodies.dispose();
    this.chargeGlow.dispose();
    this.object.removeFromParent();
  }

  // -------------------------------------------------------------------------

  private flushShots(): void {
    const n = this.pendingCount;
    this.pendingCount = 0;
    const sockets = this.sockets();
    for (let i = 0; i < n; i++) {
      const p = this.pending[i]!;
      if (sockets) {
        sockets.getSocketWorldPosition('muzzle', _v);
        if (!Number.isFinite(_v.x + _v.y + _v.z)) _v.set(p.fx, p.fy, p.fz);
      } else {
        _v.set(p.fx, p.fy, p.fz);
      }
      _from.x = _v.x;
      _from.y = _v.y;
      _from.z = _v.z;
      _to.x = p.tx;
      _to.y = p.ty;
      _to.z = p.tz;
      this.beams.shot(p.visual, _from, _to);
    }
  }

  private updateCharge(dt: number): void {
    const glow = this.chargeGlow;
    const sockets = this.sockets();
    if (this.chargeStamp !== this.epoch || !(this.chargeAmount > 0) || !sockets) {
      glow.hide();
      this.chargeLight.handle = 0;
      this.chargeLight.timer = 0;
      return;
    }
    const style = this.chargeStyle;
    glow.attach(sockets.getSocketObject('muzzle'));
    glow.show(style, this.chargeAmount, this.time.value, this.ctx.flashScale);
    sockets.getSocketWorldPosition('muzzle', _v);
    if (Number.isFinite(_v.x + _v.y + _v.z)) {
      sustainLight(this.ctx, this.chargeLight, style.light, 1, dt, _v, null, this.chargeAmount * this.ctx.flashScale);
    }
  }

  private flushLenses(): void {
    const sink = this.lens;
    const ctx = this.ctx;
    if (!sink) return;
    const q = ctx.lensQueue;
    for (let i = 0; i < ctx.lensCount; i++) {
      const o = i * LENS_STRIDE;
      _lens.x = q[o]!;
      _lens.y = q[o + 1]!;
      _lens.z = q[o + 2]!;
      sink(i, _lens, q[o + 3]!, q[o + 4]!);
    }
    for (let i = ctx.lensCount; i < this.lensUsed; i++) sink(i, _lens, 0, 0);
    this.lensUsed = ctx.lensCount;
  }
}
