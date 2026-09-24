/**
 * VFX orchestration (VfxApi): particles, decals, tracers, casings, pooled flash lights, the
 * viewmodel muzzle flash and explosions (+ camera shake and the screen-space shockwave).
 * Presets and tuning come from defs/vfx.ts; this class never branches on a preset id.
 *
 * Timing: spawns may happen anywhere in the frame (event handlers run inside the 60 Hz tick).
 * Muzzle flashes and casings are queued and resolved in update(), after the viewmodel has been
 * animated for this frame, so they start exactly at the sockets the player sees. update() runs
 * once per unpaused frame (after the viewmodel / camera update, before rendering) – paused, all
 * effects freeze.
 *
 * Everything is pooled and allocated up front: the particle / decal / casing / tracer buffers at
 * their maximum quality capacity, the flash lights (constant light count → no shader recompiles).
 * Boot: construct it (VfxSystem.create) during loading BEFORE render.applyAtmosphere() – its
 * pooled flash lights change the scene's light count, and the atmosphere warm-up should compile
 * the world materials for the final count only once – attach the viewmodel sockets (setSockets)
 * once the rig exists, then call warmup() after the atmosphere: it renders one frame with every
 * VFX draw call active (invisible) so no program compiles at the first shot.
 *
 * M5: the arsenal visuals (projectiles, trails, beams, fields, charge glow – vfx/arsenal) are
 * constructed here too (`arsenal`): they share the particles, flash lights and preset spawning,
 * warm up, clear and follow the particle budget with the rest. Their per-frame update is separate
 * (Game calls arsenal.update() after the arsenal simulation's frame update).
 */
import * as THREE from 'three';
import type {
  PhysicsApi,
  RaycastOptions,
  RenderApi,
  SettingsStore,
  VfxSocket,
  VfxSocketSource,
  VfxWeaponApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type {
  DamageElement,
  FleshSurface,
  GameEvents,
  ImpactKind,
  SurfaceType,
  Vec3Like,
} from '../core/events';
import { createLogger } from '../core/log';
import { ARSENAL_VFX } from '../defs/arsenalVfx';
import { QUALITY_LEVELS } from '../defs/graphics';
import { interactionGroups } from '../defs/physics';
import {
  DECAL_KINDS,
  ELEMENT_TINTS,
  EXPLOSION_PRESET,
  IMPACT_PROFILE_BY_KIND,
  IMPACT_USES_WEAPON_PROFILE,
  MAX_PARTICLE_BUDGET,
  SURFACE_IMPACTS,
  VFX,
  casingCapacity,
  decalCapacity,
  getCasingDef,
  getEffectPreset,
  getImpactProfile,
  type DecalKind,
  type EffectPreset,
  type ImpactProfileDef,
  type Rgb,
} from '../defs/vfx';
import type { AccessibilitySettings, GraphicsSettings, QualityLevel } from '../save/settingsSchema';
import { ArsenalVfx, type LensSink } from './arsenal/ArsenalVfx';
import { CasingSystem, type ClinkCallback } from './CasingSystem';
import {
  createDecalAtlas,
  decalAtlasTextures,
  generateDecalAtlasPixelsAsync,
  type DecalAtlasTextures,
} from './decalAtlas';
import { DecalSystem } from './DecalSystem';
import { createEmitContext, lerpRange, presetCollides, reflectDirection, tintColor, type Rand } from './emit';
import { LightPool } from './LightPool';
import { MuzzleFlash } from './MuzzleFlash';
import { ParticleSystem } from './ParticleSystem';
import { createSpriteAtlas, generateSpriteAtlasPixelsAsync, spriteAtlasTexture } from './spriteAtlas';
import { TracerSystem } from './TracerSystem';

const log = createLogger('vfx');

/** Viewmodel socket contracts live in core/contracts.ts (re-exported for existing imports). */
export type { VfxSocket, VfxSocketSource };

export interface VfxDeps {
  render: RenderApi;
  settings: SettingsStore;
  /** Probes (floor under effects, decal prop check, splatter, casing collisions). Optional. */
  physics?: PhysicsApi | null;
  /** Explosion camera shake is emitted here (camera:shake). */
  events?: EventBus<GameEvents> | null;
  sockets?: VfxSocketSource | null;
  /** Screen-space shockwave trigger (RenderSystem.addShockwave). */
  shockwave?: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  /** Screen-space lens slots (RenderSystem.setLens): singularities bend the image around them. */
  lens?: LensSink | null;
  /** Casing bounce sound hook (position, sound id, impact speed m/s) → AudioEventBridge.playCasing. */
  onClink?: ClinkCallback | null;
  /** Cosmetic randomness (default Math.random). */
  random?: Rand;
  /** Pre-generated procedural atlases (VfxSystem.create); generated synchronously when omitted. Owned. */
  atlases?: VfxAtlases | null;
}

export interface VfxAtlases {
  sprite: THREE.DataTexture;
  decal: DecalAtlasTextures;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Generate the procedural sprite + decal atlases cell by cell, yielding between cells (~50–150 ms
 * of CPU work in total that would otherwise block the loading screen in one piece).
 */
export async function createVfxAtlases(yieldFn: () => Promise<void> = nextTask): Promise<VfxAtlases> {
  const sprite = spriteAtlasTexture(await generateSpriteAtlasPixelsAsync(yieldFn));
  const decal = decalAtlasTextures(await generateDecalAtlasPixelsAsync(yieldFn));
  return { sprite, decal };
}

/** Queued muzzle event (resolved in update()). */
interface PendingShot {
  preset: string;
  lightColor: number;
  casing: string | null;
  ads: boolean;
  mx: number;
  my: number;
  mz: number;
  dx: number;
  dy: number;
  dz: number;
}

/** Queued player tracer: starts at the muzzle socket as shown this frame (resolved in update()). */
interface PendingTracer {
  /** Fire-time muzzle (used without sockets). */
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  color: number;
}

interface PendingCasing {
  id: string;
  delay: number;
}

const PROBE_GROUPS = interactionGroups(VFX.probe.membership, VFX.probe.filter);
/** Shared (read-only) raycast options: no object literal per probe. */
const PROBE_OPTS: RaycastOptions = { groups: PROBE_GROUPS };

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = { x: 0, y: 1, z: 0 };
const _aim = { x: 0, y: 0, z: -1 };
const _hitPoint = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _tinted: [number, number, number] = [0, 0, 0];
const _cam = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _reflect = { x: 0, y: 1, z: 0 };
const _tracerTo = { x: 0, y: 0, z: 0 };
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _into = new THREE.Vector3();

export class VfxSystem implements VfxWeaponApi {
  readonly particles: ParticleSystem;
  readonly decals: DecalSystem;
  readonly tracers: TracerSystem;
  readonly casings: CasingSystem;
  readonly lights: LightPool;
  readonly muzzleFlash: MuzzleFlash;
  /** M5 arsenal visuals (ArsenalVfxApi): projectiles, trails, beams, fields, charge glow. */
  readonly arsenal: ArsenalVfx;

  private readonly render: RenderApi;
  private readonly physics: PhysicsApi | null;
  private readonly events: EventBus<GameEvents> | null;
  private sockets: VfxSocketSource | null = null;
  private readonly shockwave: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  private readonly rand: Rand;
  private readonly spriteAtlas: THREE.DataTexture;
  private readonly decalAtlas: DecalAtlasTextures;
  private readonly time = { value: 0 };
  private readonly ctx = createEmitContext();
  private readonly _stats = { particles: 0, decals: 0, lights: 0 };
  private readonly shakePayload = { trauma: 0 };
  private readonly pulsePayload = { strength: 0 };
  private readonly unknown = new Set<string>();

  private readonly pendingShots: PendingShot[] = [];
  private pendingShotCount = 0;
  private readonly pendingCasings: PendingCasing[] = [];
  private pendingCasingCount = 0;
  private readonly pendingTracers: PendingTracer[] = [];
  private pendingTracerCount = 0;

  /** Smoothed camera velocity (casings inherit it). */
  private readonly camVel = new THREE.Vector3();
  private readonly camPrev = new THREE.Vector3();
  private camValid = false;
  private particleLevel: QualityLevel;
  /** Reduce-flashing multiplier for flash lights, `flash` emitters and the muzzle flash sprite. */
  private flashScale = 1;
  /** accessibility.screenShake: also scales the explosion shockwave distortion. */
  private shockwaveScale = 1;
  private warming = false;
  private disposed = false;

  /** Preferred at boot: generates the atlases without blocking the loading screen, then constructs. */
  static async create(deps: Omit<VfxDeps, 'atlases'>, yieldFn?: () => Promise<void>): Promise<VfxSystem> {
    return new VfxSystem({ ...deps, atlases: await createVfxAtlases(yieldFn) });
  }

  constructor(deps: VfxDeps) {
    this.render = deps.render;
    this.physics = deps.physics ?? null;
    this.events = deps.events ?? null;
    this.shockwave = deps.shockwave ?? null;
    this.rand = deps.random ?? Math.random;

    const t0 = performance.now();
    this.spriteAtlas = deps.atlases?.sprite ?? createSpriteAtlas();
    this.decalAtlas = deps.atlases?.decal ?? createDecalAtlas();

    const g = deps.settings.current.graphics;
    this.particleLevel = g.particles;
    this.particles = new ParticleSystem(this.spriteAtlas, this.rand);
    this.decals = new DecalSystem(
      this.decalAtlas,
      this.render,
      Math.ceil(VFX.decals.capacity * MAX_PARTICLE_BUDGET),
      decalCapacity(g.particles),
      this.time,
    );
    this.tracers = new TracerSystem();
    this.casings = new CasingSystem(
      Math.ceil(VFX.casings.capacity * MAX_PARTICLE_BUDGET),
      this.render,
      this.physics,
      this.rand,
      deps.onClink ?? null,
    );
    // Also one light in the viewmodel scene (before the ViewmodelRig compiles its materials).
    this.lights = new LightPool(this.render.scene, this.rand, this.render.viewmodelScene);
    this.muzzleFlash = new MuzzleFlash(this.spriteAtlas, this.rand);

    const lens = deps.lens ?? null;
    this.arsenal = new ArsenalVfx({
      render: this.render,
      particles: this.particles,
      lights: this.lights,
      spawn: (effect, position, normal, scale) => this.spawn(effect, position, normal, scale),
      physics: this.physics,
      sockets: () => this.sockets,
      // Lens distortion follows the screen-shake accessibility option like the shockwave.
      lens: lens
        ? (slot, p, radius, strength) => lens(slot, p, radius, strength * this.shockwaveScale)
        : null,
      random: this.rand,
    });

    const scene = this.render.scene;
    scene.add(
      this.particles.object,
      this.tracers.mesh,
      this.decals.mesh,
      this.casings.object,
      this.arsenal.object,
    );
    this.setSockets(deps.sockets ?? null);

    for (let i = 0; i < VFX.queue.shots; i++) {
      this.pendingShots.push({
        preset: '',
        lightColor: 0,
        casing: null,
        ads: false,
        mx: 0,
        my: 0,
        mz: 0,
        dx: 0,
        dy: 0,
        dz: -1,
      });
    }
    for (let i = 0; i < VFX.queue.casings; i++) this.pendingCasings.push({ id: '', delay: 0 });
    for (let i = 0; i < VFX.queue.tracers; i++) {
      this.pendingTracers.push({ fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, color: 0 });
    }

    this.applyGraphics(g);
    this.applyAccessibility(deps.settings.current.accessibility);
    log.info(`VFX ready (${(performance.now() - t0).toFixed(1)} ms)`);
  }

  // -------------------------------------------------------------------------
  // VfxApi
  // -------------------------------------------------------------------------

  spawn(effect: string, position: Vec3Like, normal?: Vec3Like, scale = 1): void {
    const preset = this.preset(effect);
    if (!preset) return;
    this.play(preset, position, normal ?? UP, scale, false, null, 0);
  }

  tracer(from: Vec3Like, to: Vec3Like, color: number = VFX.tracers.defaultColor): void {
    this.tracers.spawn(from, to, color);
  }

  /**
   * A player tracer to `to`. Shots are traced in the fixed tick, before this frame's camera and
   * viewmodel moved: like the muzzle flash, the start is resolved in update() at the muzzle
   * socket as displayed (`from`, the fire-time muzzle, is the fallback without sockets).
   */
  muzzleTracer(to: Vec3Like, color: number, from: Vec3Like): void {
    if (!this.sockets) {
      this.tracers.spawn(from, to, color);
      return;
    }
    if (this.pendingTracerCount >= VFX.queue.tracers) return;
    const t = this.pendingTracers[this.pendingTracerCount++]!;
    t.fx = from.x;
    t.fy = from.y;
    t.fz = from.z;
    t.tx = to.x;
    t.ty = to.y;
    t.tz = to.z;
    t.color = color;
  }

  /**
   * An explosion of `radius` m. `presetId` (M5 ExplosionDef.vfx, via combat:explosion): the blast's
   * own preset – element blasts, small splashes that name an impact preset; unknown or absent: the
   * element's preset (EXPLOSION_PRESET), or the physical one tinted by ELEMENT_TINTS.
   */
  explosion(
    position: Vec3Like,
    radius: number,
    element: DamageElement = 'physical',
    presetId?: string,
  ): void {
    if (!finite(position) || !(radius > 0)) return;
    let preset = presetId ? getEffectPreset(presetId) : undefined;
    if (presetId && !preset) this.warnUnknown(`effect:${presetId}`);
    let tinted = false;
    if (!preset) {
      preset = getEffectPreset(EXPLOSION_PRESET[element] ?? EXPLOSION_PRESET.physical);
      if (!preset) {
        preset = this.preset(EXPLOSION_PRESET.physical);
        tinted = true;
      }
    }
    if (!preset) return;
    const [minScale, maxScale] = VFX.explosionScale;
    const scale = Math.min(maxScale, Math.max(minScale, radius / (preset.referenceRadius ?? radius)));
    // Element presets are authored in their colours; only a fallback frag blast is tinted.
    const tint = tinted ? (ELEMENT_TINTS[element] ?? null) : null;
    this.play(preset, position, UP, scale, false, tint?.tint ?? null, tint?.strength ?? 0);
    if (preset.shockwave && this.shockwave && this.shockwaveScale > 0) {
      this.shockwave(
        position,
        radius * preset.shockwave.radiusScale,
        preset.shockwave.strength * this.shockwaveScale,
      );
    }
  }

  decal(kind: string, position: Vec3Like, normal: Vec3Like, size = 1): void {
    if (!this.decals.add(kind, position, normal, size, this.rand() * Math.PI * 2, this.rand())) {
      this.warnUnknown(`decal:${kind}`);
    }
  }

  get stats(): { particles: number; decals: number; lights: number } {
    const s = this._stats;
    s.particles = this.particles.count;
    s.decals = this.decals.count;
    s.lights = this.lights.active;
    return s;
  }

  /**
   * True while VFX draws something on RENDER.volumetricLayer (live particles or tracers, or the
   * warm-up frame): the post chain skips that layer's pass otherwise when level volumetrics are off.
   */
  get hasVolumetricContent(): boolean {
    return (
      this.warming || this.particles.count > 0 || this.tracers.count > 0 || this.arsenal.hasVolumetricContent
    );
  }

  update(dt: number): void {
    if (this.disposed) return;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this.time.value += step;
    this.trackCamera(step);

    // Age existing flashes first so flashes started this frame render at full strength.
    this.lights.update(step);
    this.muzzleFlash.update(step, this.render.viewmodelCamera);
    // Age the delayed casings before this frame's shots queue theirs: a delayed casing leaves the
    // port at least ejectDelay after its shot – never in the frame of its full-peak muzzle light.
    this.flushCasings(step);
    this.flushShots();
    this.flushTracers();
    this.lights.endFrame();
    this.lights.writeUniforms(
      this.particles.flashPos,
      this.particles.flashColor,
      VFX.particles.flashLightScale,
    );
    this.render.camera.getWorldPosition(_eye);
    this.lights.updateViewmodel(_eye);

    this.particles.update(step, this.render.camera);
    this.tracers.update(step);
    this.casings.update(step);
  }

  /**
   * Compile every VFX shader now, in its real render context (post chain render targets), and
   * upload the atlases – call once while the loading screen is up, after construction. Without it
   * the first shot / impact / explosion would compile programs mid-game (renderer.compile() alone
   * compiles for the canvas color space, not for the composer's HDR targets).
   */
  warmup(): void {
    if (this.disposed) return;
    const parts = [this.particles, this.tracers, this.decals, this.casings, this.muzzleFlash, this.arsenal];
    for (const p of parts) p.setWarmup(true);
    this.warming = true;
    try {
      this.render.render(0);
    } catch (err) {
      log.warn('VFX warm-up render failed', err);
    } finally {
      this.warming = false;
      for (const p of parts) p.setWarmup(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.particles.dispose();
    this.decals.dispose();
    this.tracers.dispose();
    this.casings.dispose();
    this.lights.dispose();
    this.muzzleFlash.dispose();
    this.arsenal.dispose();
    this.spriteAtlas.dispose();
    this.decalAtlas.dispose();
  }

  // -------------------------------------------------------------------------
  // Weapon / combat entry points (VfxBridge)
  // -------------------------------------------------------------------------

  /**
   * A shot was fired: queue the viewmodel flash, the world flash light + muzzle smoke at the muzzle
   * and the casing ejection (resolved in update() at this frame's socket positions).
   * `muzzle` / `direction` are the world muzzle position and aim direction at fire time (used
   * without viewmodel sockets). `lightColor`: linear hex (weapon def), 0 = preset color.
   */
  muzzle(
    preset: string,
    lightColor: number,
    casing: string | null,
    ads: boolean,
    muzzle: Vec3Like,
    direction: Vec3Like,
  ): void {
    if (this.pendingShotCount >= VFX.queue.shots) return;
    const s = this.pendingShots[this.pendingShotCount++]!;
    s.preset = preset;
    s.lightColor = lightColor;
    s.casing = casing;
    s.ads = ads;
    s.mx = muzzle.x;
    s.my = muzzle.y;
    s.mz = muzzle.z;
    s.dx = direction.x;
    s.dy = direction.y;
    s.dz = direction.z;
  }

  /**
   * A shot hit a surface. `profile`: the weapon's impact profile id (WeaponVfxDef.impact), null =
   * by impact kind. `decal` false suppresses the surface decal (exit wounds, bodies). `direction`:
   * the shot's travel direction when known (ricochet sparks, splatter behind bodies), else the
   * surface normal stands in.
   */
  impact(
    surface: SurfaceType | FleshSurface,
    profile: string | null,
    kind: ImpactKind,
    point: Vec3Like,
    normal: Vec3Like,
    decal: boolean,
    direction: Vec3Like | null = null,
  ): void {
    if (!finite(point)) return;
    const prof = this.resolveProfile(profile, kind);
    if (!prof) return;
    const entry = SURFACE_IMPACTS[surface] ?? SURFACE_IMPACTS.default;
    const surfaceScale = prof.scale * (prof.surfaceScale ?? 1);
    const preset = surfaceScale > 0 ? this.preset(entry.effect) : undefined;
    if (preset) this.play(preset, point, normal, surfaceScale, true, null, 0, 0, direction);
    // Energy / element shots add their own burst (plasma splash, arcs, frost ...).
    const extra = prof.effect ? this.preset(prof.effect) : undefined;
    if (extra) this.play(extra, point, normal, prof.scale, true, null, 0, 0, direction);
    // Bodies keep their surface's decal rule (none on flesh); world hits may take the profile's.
    const decalKind = entry.decal && prof.decal !== undefined ? prof.decal : entry.decal;
    if (decal && prof.decals && decalKind && !this.onDynamicProp(point, normal)) {
      this.decals.add(decalKind, point, normal, prof.decalScale, this.rand() * Math.PI * 2, this.rand());
    }
    const splatter = entry.splatter;
    if (splatter && this.physics && this.rand() < splatter.chance) {
      // Behind the body along the shot (−normal of the entry hit when the shot is unknown).
      if (direction) _dir.set(direction.x, direction.y, direction.z);
      else _dir.set(-normal.x, -normal.y, -normal.z);
      if (_dir.lengthSq() > 1e-8) {
        _dir.normalize();
        const hit = this.physics.raycast(point, _dir, splatter.distance, PROBE_OPTS);
        if (hit && hit.data?.kind !== 'prop') {
          _hitPoint.copy(hit.point);
          _hitNormal.copy(hit.normal);
          this.addFittedDecal(splatter.decal, lerpRange(splatter.size, this.rand()));
        }
      }
    }
  }

  /**
   * Attach (or replace / detach) the viewmodel socket source: VFX can be created before the
   * ViewmodelRig exists (see the header); without sockets shots use the fire-time muzzle.
   */
  setSockets(sockets: VfxSocketSource | null): void {
    this.sockets = sockets;
    this.muzzleFlash.hide();
    this.muzzleFlash.attach(sockets ? sockets.getSocketObject('muzzle') : null);
  }

  /** Hide the viewmodel flash (weapon switch). */
  hideMuzzleFlash(): void {
    this.muzzleFlash.hide();
  }

  /**
   * A hitscan shot drawn as an arsenal ray (`style`: defs/arsenalVfx BEAM_STYLES; muzzle presets
   * with a `tracer`, e.g. the railgun slug) instead of a thin tracer; starts at the displayed muzzle.
   */
  beamShot(style: string, to: Vec3Like, from: Vec3Like): void {
    if (!finite(to) || !finite(from)) return;
    this.arsenal.shot(style, to, from);
  }

  applyGraphics(g: Readonly<GraphicsSettings>): void {
    const level = g.particles;
    const budget = QUALITY_LEVELS.particles[level]?.budgetMultiplier ?? 1;
    this.particles.setBudget(budget);
    this.arsenal.setBudget(budget);
    if (level !== this.particleLevel || this.decals.capacity !== decalCapacity(level)) {
      this.decals.setCapacity(decalCapacity(level));
    }
    this.casings.setLimit(casingCapacity(level));
    this.particleLevel = level;
  }

  applyAccessibility(a: Readonly<AccessibilitySettings>): void {
    this.flashScale = a.reduceFlashing ? VFX.lights.reducedFlashingScale : 1;
    this.lights.setIntensityScale(this.flashScale);
    this.arsenal.setFlashScale(a.reduceFlashing ? ARSENAL_VFX.reducedFlashingScale : 1);
    const shake = a.screenShake;
    this.shockwaveScale = Number.isFinite(shake) ? Math.min(1, Math.max(0, shake)) : 1;
  }

  /** Remove every live effect (level change, respawn). */
  clear(): void {
    this.particles.clear();
    this.decals.clear();
    this.tracers.clear();
    this.casings.clear();
    this.lights.clear();
    this.muzzleFlash.hide();
    this.arsenal.clear();
    this.pendingShotCount = 0;
    this.pendingCasingCount = 0;
    this.pendingTracerCount = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Spawn a preset: particles (+ floor probe), light, shake, ground decal. `lightColor`: linear hex
   * (0 = preset color); `shot`: travel direction of the shot for 'reflect' emitters.
   */
  private play(
    preset: EffectPreset,
    position: Vec3Like,
    normal: Vec3Like,
    scale: number,
    surfacePlane: boolean,
    tint: Rgb | null,
    tintStrength: number,
    lightColor = 0,
    shot: Vec3Like | null = null,
  ): void {
    if (!finite(position)) return;
    unit(normal, _n);
    const ctx = this.ctx;
    ctx.x = position.x;
    ctx.y = position.y;
    ctx.z = position.z;
    ctx.nx = _n.x;
    ctx.ny = _n.y;
    ctx.nz = _n.z;
    if (shot) reflectDirection(shot.x, shot.y, shot.z, _n.x, _n.y, _n.z, _reflect);
    else reflectDirection(0, 0, 0, _n.x, _n.y, _n.z, _reflect);
    ctx.rx = _reflect.x;
    ctx.ry = _reflect.y;
    ctx.rz = _reflect.z;
    ctx.scale = scale;
    ctx.surfacePlane = surfacePlane;
    ctx.tint = tint;
    ctx.tintStrength = tintStrength;
    ctx.flashScale = this.flashScale;
    ctx.floorY = Number.NEGATIVE_INFINITY;

    // One floor probe per effect for bouncing particles / the ground decal.
    const ground = preset.groundDecal;
    let groundHit = false;
    const needFloor = this.particles.budgetMultiplier > 0 && presetCollides(preset);
    if (this.physics && (needFloor || ground)) {
      const reach = ground
        ? Math.max(VFX.particles.floorProbe, ground.probe * scale)
        : VFX.particles.floorProbe;
      // Start off the surface: a probe starting on a wall would report the wall itself as the floor.
      const lift = VFX.particles.probeLift;
      _probe.set(position.x + _n.x * lift, position.y + _n.y * lift, position.z + _n.z * lift);
      const hit = this.physics.raycast(_probe, DOWN, reach, PROBE_OPTS);
      if (hit) {
        ctx.floorY = hit.point.y;
        // Props move (shots push them): a scorch on one would be left floating in the air.
        if (hit.data?.kind !== 'prop') {
          groundHit = true;
          _hitPoint.copy(hit.point);
          _hitNormal.copy(hit.normal);
        }
      }
    }
    if (preset.emitters.length > 0) this.particles.emit(preset, ctx);
    if (preset.light) {
      let color: Rgb | number | undefined = lightColor || undefined;
      if (tint && tintStrength > 0) {
        // Elemental explosions tint their flash light like their elemental emitters.
        const c = preset.light.color;
        tintColor(c[0], c[1], c[2], tint, tintStrength, _tinted);
        color = _tinted;
      }
      this.lights.flash(preset.light, position, _n, scale, color);
    }
    const events = this.events;
    if (preset.shake && events) {
      const k = this.proximity(position, preset.shake.range * scale);
      if (k > 0) {
        this.shakePayload.trauma = preset.shake.trauma * k;
        events.emit('camera:shake', this.shakePayload);
      }
    }
    if (preset.hitPulse && events) {
      const k = this.proximity(position, preset.hitPulse.range * scale);
      if (k > 0) {
        this.pulsePayload.strength = preset.hitPulse.strength * k;
        events.emit('fx:hitPulse', this.pulsePayload);
      }
    }
    if (ground && groundHit && position.y - _hitPoint.y <= ground.probe * scale) {
      this.addFittedDecal(ground.kind, scale * ground.sizePerScale);
    }
  }

  /** Linear falloff from 1 at the camera to 0 at `range` m (0 beyond or for a bad range). */
  private proximity(position: Vec3Like, range: number): number {
    if (!(range > 0)) return 0;
    this.render.camera.getWorldPosition(_cam);
    const d = Math.hypot(position.x - _cam.x, position.y - _cam.y, position.z - _cam.z);
    return Math.max(0, 1 - d / range);
  }

  /**
   * Add a large flat decal at _hitPoint / _hitNormal, shrunk until its rim lies on the surface
   * (VFX.decals.surfaceFit) – an unclipped quad would overhang ledges, stairs and wall edges.
   * Skipped when even the smallest size does not fit.
   */
  private addFittedDecal(kind: DecalKind, size: number): void {
    const sizeRand = this.rand();
    const fit = this.fitDecalSize(kind, size, sizeRand);
    if (fit > 0) this.decals.add(kind, _hitPoint, _hitNormal, fit, this.rand() * Math.PI * 2, sizeRand);
  }

  private fitDecalSize(kind: DecalKind, size: number, sizeRand: number): number {
    const physics = this.physics;
    if (!physics) return size;
    const cfg = VFX.decals.surfaceFit;
    // Tangent basis of the surface; probes run back into it along −normal.
    _t1.crossVectors(Math.abs(_hitNormal.y) < 0.9 ? Y_AXIS : X_AXIS, _hitNormal);
    if (_t1.lengthSq() < 1e-8) return size;
    _t1.normalize();
    _t2.crossVectors(_hitNormal, _t1);
    _into.copy(_hitNormal).negate();
    const edge = lerpRange(DECAL_KINDS[kind].size, sizeRand);
    let s = size;
    for (let i = 0; i <= cfg.maxHalvings; i++, s *= 0.5) {
      const r = edge * s * 0.5 * cfg.rimFraction;
      let fits = true;
      for (let c = 0; c < 4 && fits; c++) {
        const a = c === 0 ? r : c === 1 ? -r : 0;
        const b = c === 2 ? r : c === 3 ? -r : 0;
        _probe
          .copy(_hitPoint)
          .addScaledVector(_t1, a)
          .addScaledVector(_t2, b)
          .addScaledVector(_hitNormal, cfg.lift);
        fits = physics.raycast(_probe, _into, cfg.lift + cfg.tolerance, PROBE_OPTS) !== null;
      }
      if (fits) return s;
    }
    return 0;
  }

  private resolveProfile(profile: string | null, kind: ImpactKind): ImpactProfileDef | undefined {
    // The weapon's profile describes its shots; melee bashes etc. use the profile of their kind.
    if (profile && IMPACT_USES_WEAPON_PROFILE[kind]) {
      const p = getImpactProfile(profile);
      if (p) return p;
      this.warnUnknown(`impact profile:${profile}`);
    }
    const byKind = IMPACT_PROFILE_BY_KIND[kind];
    return byKind ? getImpactProfile(byKind) : undefined;
  }

  /** True when the surface under `point` is a dynamic prop (decals would float when it moves). */
  private onDynamicProp(point: Vec3Like, normal: Vec3Like): boolean {
    if (!this.physics) return false;
    const reach = VFX.decals.propProbe;
    unit(normal, _n);
    _v.set(point.x + _n.x * reach, point.y + _n.y * reach, point.z + _n.z * reach);
    _dir.set(-_n.x, -_n.y, -_n.z);
    const hit = this.physics.raycast(_v, _dir, reach * 2, PROBE_OPTS);
    return hit?.data?.kind === 'prop';
  }

  private flushShots(): void {
    const n = this.pendingShotCount;
    this.pendingShotCount = 0;
    for (let i = 0; i < n; i++) {
      const s = this.pendingShots[i]!;
      const preset = this.preset(s.preset);
      // Muzzle world position as displayed this frame (falls back to the fire-time position).
      if (this.sockets) this.sockets.getSocketWorldPosition('muzzle', _v);
      else _v.set(s.mx, s.my, s.mz);
      if (!finite(_v)) _v.set(s.mx, s.my, s.mz);
      if (preset) {
        _aim.x = s.dx;
        _aim.y = s.dy;
        _aim.z = s.dz;
        this.keepInFront(_v, preset.light?.offset ?? 0, _aim);
        this.play(preset, _v, _aim, 1, false, null, 0, s.lightColor);
        if (preset.flash) {
          if (this.sockets) this.muzzleFlash.attach(this.sockets.getSocketObject('muzzle'));
          this.muzzleFlash.fire(preset.flash, s.ads, this.flashScale);
          this.muzzleFlash.update(0, this.render.viewmodelCamera);
        }
      }
      if (s.casing) {
        const def = getCasingDef(s.casing);
        if (!def) this.warnUnknown(`casing:${s.casing}`);
        else if (def.ejectDelay > 0) this.queueCasing(s.casing, def.ejectDelay);
        else this.ejectCasing(s.casing);
      }
    }
  }

  private flushTracers(): void {
    const n = this.pendingTracerCount;
    this.pendingTracerCount = 0;
    for (let i = 0; i < n; i++) {
      const t = this.pendingTracers[i]!;
      if (this.sockets) this.sockets.getSocketWorldPosition('muzzle', _v);
      else _v.set(t.fx, t.fy, t.fz);
      if (!finite(_v)) _v.set(t.fx, t.fy, t.fz);
      this.keepInFront(_v, 0, null);
      _tracerTo.x = t.tx;
      _tracerTo.y = t.ty;
      _tracerTo.z = t.tz;
      this.tracers.spawn(_v, _tracerTo, t.color);
    }
  }

  private queueCasing(id: string, delay: number): void {
    if (this.pendingCasingCount >= VFX.queue.casings) return;
    const c = this.pendingCasings[this.pendingCasingCount++]!;
    c.id = id;
    c.delay = delay;
  }

  private flushCasings(dt: number): void {
    let i = 0;
    while (i < this.pendingCasingCount) {
      const c = this.pendingCasings[i]!;
      c.delay -= dt;
      if (c.delay > 0) {
        i++;
        continue;
      }
      this.ejectCasing(c.id);
      // Swap-remove (order of simultaneous ejections does not matter).
      const last = this.pendingCasings[--this.pendingCasingCount]!;
      this.pendingCasings[i] = last;
      this.pendingCasings[this.pendingCasingCount] = c;
    }
  }

  private ejectCasing(id: string): void {
    const cam = this.render.camera;
    cam.getWorldDirection(_fwd);
    const sockets = this.sockets;
    if (sockets) {
      sockets.getSocketWorldPosition('ejectPort', _v);
      if (sockets.getSocketWorldDirection) sockets.getSocketWorldDirection('ejectPort', _v2);
      else this.fallbackEjectDirection(_v2);
    } else {
      const p = VFX.casings.fallbackPort;
      this.cameraBasis();
      cam.getWorldPosition(_v);
      _v.addScaledVector(_right, p[0]).addScaledVector(_up, p[1]).addScaledVector(_fwd, p[2]);
      this.fallbackEjectDirection(_v2);
    }
    if (!finite(_v) || !finite(_v2)) return;
    this.keepInFront(_v, 0, null);
    _v2.normalize();
    this.casings.eject(id, _v, _v2, _fwd, this.camVel);
  }

  /**
   * Socket points are mapped ~0.5 m in front of the eye: hugging a wall puts them inside it (the
   * flash light would light the room behind it, casings would stick in it). Pull `p` back along
   * the eye ray until `p` – plus `lead` m along `aim` (the muzzle light offset) – is at least
   * VFX.socketProbe.backoff away from the surface in the way.
   */
  private keepInFront(p: THREE.Vector3, lead: number, aim: Vec3Like | null): void {
    if (!this.physics) return;
    const cfg = VFX.socketProbe;
    this.render.camera.getWorldPosition(_eye);
    _ray.subVectors(p, _eye);
    const dist = _ray.length();
    if (!(dist > 1e-4)) return;
    _ray.multiplyScalar(1 / dist);
    const ahead = aim ? Math.max(0, lead) : 0;
    const hit = this.physics.raycast(_eye, _ray, dist + ahead + cfg.margin, PROBE_OPTS);
    if (!hit) return;
    const n = hit.normal;
    // Cosine between the ray and the surface (> 0: the ray runs into it).
    const into = -(n.x * _ray.x + n.y * _ray.y + n.z * _ray.z);
    if (!(into > 1e-3)) return;
    let lift = 0;
    if (aim) {
      const len = Math.hypot(aim.x, aim.y, aim.z);
      if (len > 1e-6) lift = (ahead * (n.x * aim.x + n.y * aim.y + n.z * aim.z)) / len;
    }
    // Largest t along the ray with n·(eye + ray·t + aim·ahead − hit) ≥ backoff.
    const t = (hit.distance * into + lift - cfg.backoff) / into;
    if (t >= dist) return;
    // Up to `ahead` behind the eye: the light (p + aim·ahead) then still sits at the eye.
    p.copy(_eye).addScaledVector(_ray, Math.max(-ahead, t));
  }

  private fallbackEjectDirection(out: THREE.Vector3): void {
    const d = VFX.casings.fallbackDirection;
    this.cameraBasis();
    out.set(0, 0, 0).addScaledVector(_right, d[0]).addScaledVector(_up, d[1]).addScaledVector(_fwd, d[2]);
  }

  /** Camera right/up/forward into _right/_up/_fwd. */
  private cameraBasis(): void {
    const e = this.render.camera.matrixWorld.elements;
    _right.set(e[0]!, e[1]!, e[2]!).normalize();
    _up.set(e[4]!, e[5]!, e[6]!).normalize();
    _fwd.set(-e[8]!, -e[9]!, -e[10]!).normalize();
  }

  private trackCamera(dt: number): void {
    const c = VFX.casings;
    this.render.camera.getWorldPosition(_v);
    if (!this.camValid || !(dt > 0)) {
      this.camPrev.copy(_v);
      this.camValid = true;
      return;
    }
    _v2.copy(_v).sub(this.camPrev).divideScalar(dt);
    this.camPrev.copy(_v);
    // Teleports / respawns: a jump far above any movement speed resets the estimate.
    if (_v2.length() > c.maxInheritSpeed * 4) {
      this.camVel.set(0, 0, 0);
      return;
    }
    _v2.clampLength(0, c.maxInheritSpeed);
    this.camVel.lerp(_v2, 1 - Math.exp(-c.inheritLambda * dt));
  }

  private preset(id: string): EffectPreset | undefined {
    const p = getEffectPreset(id);
    if (!p) this.warnUnknown(`effect:${id}`);
    return p;
  }

  private warnUnknown(what: string): void {
    if (this.unknown.has(what)) return;
    this.unknown.add(what);
    log.warn(`Unknown VFX id ${what} – ignored`);
  }
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Normalize `v` into `out` (world up for degenerate input). */
function unit(v: Vec3Like, out: { x: number; y: number; z: number }): void {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 1e-8) || !Number.isFinite(len)) {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return;
  }
  out.x = v.x / len;
  out.y = v.y / len;
  out.z = v.z / len;
}
