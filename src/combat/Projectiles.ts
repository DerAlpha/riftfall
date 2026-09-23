/**
 * Pooled projectile system: slow visible projectiles (spitter acid globs now; player launchers and
 * grenades in M5 reuse it with their own PROJECTILES defs).
 *
 * Simulation (fixed tick): exact constant-gravity integration, collision per substep of at most
 * `def.substep` meters – the player's capsule by a swept segment test (enemy shots), the world
 * (BVH level meshes + props) and damageables through CombatWorld.raycast. Damageables a projectile
 * does not affect (an enemy glob passing its own kind) are passed through. On impact: direct damage,
 * splash with linear falloff, a `combat:impact` event (surface from the def → the VFX/audio bridges
 * spawn 'impact.slime' + splatter decal + sound) and optionally a lingering puddle (pooled damage
 * zone with DoT, dropped to the floor below wall hits).
 *
 * Rendering: ONE InstancedMesh of glowing HDR blobs (unlit, instance colors > 1 bloom) draws both
 * flying projectiles (stretched along their velocity, interpolated between ticks) and puddles
 * (flattened blobs that shrink away). Capacities are preallocated; nothing allocates per tick/frame.
 *
 * Aiming: `solveLob` computes a lobbed launch velocity with lead prediction on the target's
 * horizontal velocity.
 */
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type {
  CombatHit,
  CombatRaycastOptions,
  CombatWorldApi,
  DamageInfo,
  Damageable,
  EnemyTargetApi,
  VfxApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { ENEMY_AI, PROJECTILES, PROJECTILE_POOL, type ProjectileDef } from '../defs/enemies';
import { aoeFactor, distanceToCapsule, segmentSegment, type SegmentClosest } from '../enemies/ai/attackMath';

const log = createLogger('projectiles');

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };
const TAU = Math.PI * 2;

type DamageSource = DamageInfo['source'];
const SOURCES: readonly DamageSource[] = ['player', 'enemy', 'trap', 'environment'];

/** The CombatWorld part projectiles use (CombatWorld honours the extended raycast options). */
export type ProjectileCombat = Pick<CombatWorldApi, 'raycast' | 'queryRadius' | 'dealDamage'>;

export interface ProjectileSystemDeps {
  events: EventBus<GameEvents>;
  combat: ProjectileCombat;
  /** The player: enemy projectiles collide with and splash its capsule. */
  target?: EnemyTargetApi | null;
  vfx?: Pick<VfxApi, 'spawn' | 'decal'> | null;
  /** World scene for the blob mesh (none: simulation only, e.g. tests). */
  scene?: Object3D | null;
  capacity?: number;
  puddleCapacity?: number;
}

export interface FireOptions {
  /** Never hit by its own projectile. */
  owner?: Damageable | null;
  source?: DamageSource;
  /** Damage multiplier (elites, difficulty). */
  damageScale?: number;
}

/** Launch parameters `solveLob` needs from a def. */
export type LobParams = Pick<ProjectileDef, 'lobSpeed' | 'minFlightTime' | 'maxFlightTime' | 'gravity'>;

/**
 * Lobbed launch velocity from `origin` to hit `aim` moving with `targetVel` (horizontal lead scaled
 * by `lead` 0..1). Flight time = horizontal distance to the predicted point / lobSpeed (clamped),
 * iterated so the prediction and the flight time agree. Writes the velocity into `out` and returns
 * the flight time. Exact for constant gravity (Projectiles integrates analytically).
 */
export function solveLob(
  origin: Vec3Like,
  aim: Vec3Like,
  targetVel: Vec3Like,
  lead: number,
  def: LobParams,
  out: Vec3Like,
  iterations: number = PROJECTILE_POOL.leadIterations,
): number {
  const speed = Math.max(1e-3, def.lobSpeed);
  const minT = Math.max(1e-3, def.minFlightTime);
  const maxT = Math.max(minT, def.maxFlightTime);
  const k = Number.isFinite(lead) ? Math.max(0, lead) : 0;
  const vx = Number.isFinite(targetVel.x) ? targetVel.x * k : 0;
  const vz = Number.isFinite(targetVel.z) ? targetVel.z * k : 0;
  let t = clamp(Math.hypot(aim.x - origin.x, aim.z - origin.z) / speed, minT, maxT);
  for (let i = 0; i < iterations; i++) {
    t = clamp(Math.hypot(aim.x + vx * t - origin.x, aim.z + vz * t - origin.z) / speed, minT, maxT);
  }
  const px = aim.x + vx * t;
  const pz = aim.z + vz * t;
  out.x = (px - origin.x) / t;
  out.z = (pz - origin.z) / t;
  out.y = (aim.y - origin.y) / t + 0.5 * def.gravity * t;
  return t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Scratch (module-level, allocation-free hot paths).
const _a = new Vector3();
const _b = new Vector3();
const _dir = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();
const _hitPoint = new Vector3();
const _hitNormal = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _pos = new Vector3();
const _vel = new Vector3();
const _Y = new Vector3(0, 1, 0);
const _seg: SegmentClosest = { distSq: 0, s: 0 };
const _dirTo = { x: 0, y: 0, z: 0 };

const IMPACT_NONE = 0;
const IMPACT_WORLD = 1;
const IMPACT_PLAYER = 2;
const IMPACT_TARGET = 3;

export class ProjectileSystem {
  readonly stats = { active: 0, puddles: 0, fired: 0, impacts: 0 };
  readonly capacity: number;
  readonly puddleCapacity: number;
  /** The blob mesh (null without a scene). */
  readonly mesh: InstancedMesh | null = null;

  private readonly events: EventBus<GameEvents>;
  private readonly combat: ProjectileCombat;
  private target: EnemyTargetApi | null;
  private readonly vfx: Pick<VfxApi, 'spawn' | 'decal'> | null;
  private readonly scene: Object3D | null;

  private readonly defs: ProjectileDef[] = [];
  private readonly defIndex = new Map<string, number>();
  private readonly warned = new Set<string>();

  // Projectiles (SoA).
  private readonly pos: Float64Array;
  private readonly prev: Float64Array;
  private readonly vel: Float64Array;
  private readonly origin: Float64Array;
  private readonly age: Float32Array;
  private readonly trailTimer: Float32Array;
  private readonly scale: Float32Array;
  private readonly seed: Float32Array;
  private readonly def: Int16Array;
  private readonly source: Uint8Array;
  private readonly owner: (Damageable | null)[];
  private readonly free: Int32Array;
  private freeTop = 0;
  private readonly active: Int32Array;
  private activeCount = 0;

  // Puddles (SoA).
  private readonly pPos: Float64Array;
  private readonly pAge: Float32Array;
  private readonly pTick: Float32Array;
  private readonly pScale: Float32Array;
  private readonly pDef: Int16Array;
  private readonly pSource: Uint8Array;
  private readonly pFree: Int32Array;
  private pFreeTop = 0;
  private readonly pActive: Int32Array;
  private pActiveCount = 0;

  private readonly ignore: Damageable[] = [];
  private readonly rayOpts: CombatRaycastOptions = { ignore: null, ignoreMany: this.ignore };
  private readonly queryOut: Damageable[] = [];
  private readonly damageInfo: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 0 },
    weaponId: '',
    element: 'physical',
    source: 'enemy',
    kind: 'projectile',
  };
  private readonly impactPayload: GameEvents['combat:impact'] = {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 'slime',
    kind: 'projectile',
    weaponId: '',
    decal: true,
  };
  private readonly shakePayload: GameEvents['camera:shake'] = { trauma: 0 };

  private readonly colorAttr: InstancedBufferAttribute | null = null;
  private readonly material: MeshBasicMaterial | null = null;
  private readonly geometry: SphereGeometry | null = null;
  /** Damageable behind the latest IMPACT_TARGET contact. */
  private hitTarget: Damageable | null = null;
  /** Player DoT: strongest puddle under the player this tick, and the running tick timer. */
  private burnDps = 0;
  private burnInterval = 0;
  private burnTimer = 0;
  private readonly burnAt = new Vector3();
  private time = 0;
  private disposed = false;

  constructor(deps: ProjectileSystemDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.target = deps.target ?? null;
    this.vfx = deps.vfx ?? null;
    this.scene = deps.scene ?? null;
    this.capacity = Math.max(1, deps.capacity ?? PROJECTILE_POOL.projectiles);
    this.puddleCapacity = Math.max(0, deps.puddleCapacity ?? PROJECTILE_POOL.puddles);
    for (const d of Object.values(PROJECTILES) as ProjectileDef[]) {
      this.defIndex.set(d.id, this.defs.length);
      this.defs.push(d);
    }

    const n = this.capacity;
    this.pos = new Float64Array(n * 3);
    this.prev = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.origin = new Float64Array(n * 3);
    this.age = new Float32Array(n);
    this.trailTimer = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.def = new Int16Array(n);
    this.source = new Uint8Array(n);
    this.owner = new Array<Damageable | null>(n).fill(null);
    this.free = new Int32Array(n);
    this.active = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeTop = n;

    const m = this.puddleCapacity;
    this.pPos = new Float64Array(m * 3);
    this.pAge = new Float32Array(m);
    this.pTick = new Float32Array(m);
    this.pScale = new Float32Array(m);
    this.pDef = new Int16Array(m);
    this.pSource = new Uint8Array(m);
    this.pFree = new Int32Array(m);
    this.pActive = new Int32Array(m);
    for (let i = 0; i < m; i++) this.pFree[i] = m - 1 - i;
    this.pFreeTop = m;

    if (this.scene) {
      const P = PROJECTILE_POOL;
      const geometry = new SphereGeometry(1, P.widthSegments, P.heightSegments);
      const material = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const mesh = new InstancedMesh(geometry, material, n + m);
      mesh.name = 'projectiles';
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const colors = new InstancedBufferAttribute(new Float32Array((n + m) * 3), 3);
      colors.setUsage(DynamicDrawUsage);
      mesh.instanceColor = colors;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.scene.add(mesh);
      this.mesh = mesh;
      this.colorAttr = colors;
      this.material = material;
      this.geometry = geometry;
    }
  }

  /** Swap the player target (respawn / restart). */
  setTarget(target: EnemyTargetApi | null): void {
    this.target = target;
  }

  /** Fire `defId` from `origin` with `velocity`. Returns false when the pool is full / id unknown. */
  fire(defId: string, origin: Vec3Like, velocity: Vec3Like, opts?: FireOptions): boolean {
    if (this.disposed) return false;
    const d = this.resolve(defId);
    if (d < 0 || this.freeTop === 0) return false;
    if (!finite3(origin.x, origin.y, origin.z) || !finite3(velocity.x, velocity.y, velocity.z)) return false;
    const i = this.free[--this.freeTop]!;
    this.active[this.activeCount++] = i;
    const o = i * 3;
    this.pos[o] = this.prev[o] = this.origin[o] = origin.x;
    this.pos[o + 1] = this.prev[o + 1] = this.origin[o + 1] = origin.y;
    this.pos[o + 2] = this.prev[o + 2] = this.origin[o + 2] = origin.z;
    this.vel[o] = velocity.x;
    this.vel[o + 1] = velocity.y;
    this.vel[o + 2] = velocity.z;
    this.age[i] = 0;
    this.trailTimer[i] = 0;
    this.scale[i] = opts?.damageScale ?? 1;
    this.seed[i] = (this.stats.fired * 0.6180339887) % 1;
    this.def[i] = d;
    this.source[i] = Math.max(0, SOURCES.indexOf(opts?.source ?? 'enemy'));
    this.owner[i] = opts?.owner ?? null;
    this.stats.fired++;
    this.stats.active = this.activeCount;
    return true;
  }

  /** Lobbed shot at `aim` with lead on `targetVel` (see solveLob). */
  lob(
    defId: string,
    origin: Vec3Like,
    aim: Vec3Like,
    targetVel: Vec3Like,
    lead: number,
    opts?: FireOptions,
  ): boolean {
    const d = this.resolve(defId);
    if (d < 0) return false;
    solveLob(origin, aim, targetVel, lead, this.defs[d]!, _vel);
    return this.fire(defId, origin, _vel, opts);
  }

  /** Leave a puddle of `defId` at `position` (floor point). */
  spawnPuddle(defId: string, position: Vec3Like, opts?: FireOptions): boolean {
    const d = this.resolve(defId);
    if (d < 0) return false;
    const def = this.defs[d]!;
    if (!def.puddle || this.pFreeTop === 0 || !finite3(position.x, position.y, position.z)) return false;
    const i = this.pFree[--this.pFreeTop]!;
    this.pActive[this.pActiveCount++] = i;
    const o = i * 3;
    this.pPos[o] = position.x;
    this.pPos[o + 1] = position.y;
    this.pPos[o + 2] = position.z;
    this.pAge[i] = 0;
    this.pTick[i] = 0;
    this.pScale[i] = opts?.damageScale ?? 1;
    this.pDef[i] = d;
    this.pSource[i] = Math.max(0, SOURCES.indexOf(opts?.source ?? 'enemy'));
    if (def.puddle.decal && this.vfx)
      this.vfx.decal(def.puddle.decal.kind, position, UP, def.puddle.decal.size);
    this.stats.puddles = this.pActiveCount;
    return true;
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    for (let k = this.activeCount - 1; k >= 0; k--) {
      const i = this.active[k]!;
      if (this.step(i, dt)) this.releaseAt(k);
    }
    this.burnDps = 0;
    this.burnInterval = 0;
    for (let k = this.pActiveCount - 1; k >= 0; k--) {
      const i = this.pActive[k]!;
      if (this.stepPuddle(i, dt)) this.releasePuddleAt(k);
    }
    this.burnPlayer(dt);
    this.stats.active = this.activeCount;
    this.stats.puddles = this.pActiveCount;
  }

  /** Per frame: interpolate blobs between ticks and upload the instance buffers. */
  update(dt: number, alpha: number): void {
    const mesh = this.mesh;
    const colors = this.colorAttr;
    if (!mesh || !colors || this.disposed) return;
    this.time += Number.isFinite(dt) ? dt : 0;
    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    const col = colors.array as Float32Array;
    let n = 0;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k]!;
      const d = this.defs[this.def[i]!]!;
      const V = d.visual;
      const o = i * 3;
      _pos.set(
        this.prev[o]! + (this.pos[o]! - this.prev[o]!) * a,
        this.prev[o + 1]! + (this.pos[o + 1]! - this.prev[o + 1]!) * a,
        this.prev[o + 2]! + (this.pos[o + 2]! - this.prev[o + 2]!) * a,
      );
      _vel.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
      const speed = _vel.length();
      if (speed > 1e-4) _q.setFromUnitVectors(_Y, _vel.multiplyScalar(1 / speed));
      else _q.identity();
      const pulse = 1 + V.pulseAmount * Math.sin((this.time * V.pulseHz + this.seed[i]!) * TAU);
      const w = V.size * pulse;
      _s.set(w, w * V.stretch, w);
      _m.compose(_pos, _q, _s);
      mesh.setMatrixAt(n, _m);
      col[n * 3] = V.color[0] * V.intensity;
      col[n * 3 + 1] = V.color[1] * V.intensity;
      col[n * 3 + 2] = V.color[2] * V.intensity;
      n++;
    }
    for (let k = 0; k < this.pActiveCount; k++) {
      const i = this.pActive[k]!;
      const d = this.defs[this.pDef[i]!]!;
      const P = d.puddle;
      if (!P) continue;
      const V = d.visual;
      const o = i * 3;
      const left = P.duration - this.pAge[i]!;
      const fade = P.fadeTime > 0 ? clamp(left / P.fadeTime, 0, 1) : 1;
      if (fade <= 0) continue;
      _pos.set(this.pPos[o]!, this.pPos[o + 1]! + V.puddleLift, this.pPos[o + 2]!);
      _q.identity();
      const r = P.radius * fade;
      _s.set(r, V.puddleThickness, r);
      _m.compose(_pos, _q, _s);
      mesh.setMatrixAt(n, _m);
      const intensity = V.puddleIntensity * fade;
      col[n * 3] = V.puddleColor[0] * intensity;
      col[n * 3 + 1] = V.puddleColor[1] * intensity;
      col[n * 3 + 2] = V.puddleColor[2] * intensity;
      n++;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
    }
  }

  /** Remove every projectile and puddle (restart). */
  clear(): void {
    while (this.activeCount > 0) this.releaseAt(this.activeCount - 1);
    while (this.pActiveCount > 0) this.releasePuddleAt(this.pActiveCount - 1);
    this.stats.active = 0;
    this.stats.puddles = 0;
    if (this.mesh) {
      this.mesh.count = 0;
      this.mesh.visible = false;
    }
  }

  /** Active projectile positions (debug / tests). */
  forEachProjectile(fn: (x: number, y: number, z: number, defId: string) => void): void {
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k]!;
      fn(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!, this.defs[this.def[i]!]!.id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.dispose();
    }
    this.geometry?.dispose();
    this.material?.dispose();
    this.owner.fill(null);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** Advance projectile i; true when it is gone (impact / expired). */
  private step(i: number, dt: number): boolean {
    const def = this.defs[this.def[i]!]!;
    const o = i * 3;
    this.prev[o] = this.pos[o]!;
    this.prev[o + 1] = this.pos[o + 1]!;
    this.prev[o + 2] = this.pos[o + 2]!;
    this.age[i] = this.age[i]! + dt;
    if (this.age[i]! > def.lifetime) return true;

    const x0 = this.pos[o]!;
    const y0 = this.pos[o + 1]!;
    const z0 = this.pos[o + 2]!;
    const vy = this.vel[o + 1]!;
    const x1 = x0 + this.vel[o]! * dt;
    const y1 = y0 + vy * dt - 0.5 * def.gravity * dt * dt;
    const z1 = z0 + this.vel[o + 2]! * dt;
    this.vel[o + 1] = vy - def.gravity * dt;

    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / Math.max(1e-3, def.substep)));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      _a.set(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, z0 + (z1 - z0) * t0);
      _b.set(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, z0 + (z1 - z0) * t1);
      const kind = this.collide(i, def);
      if (kind !== IMPACT_NONE) {
        this.impact(i, def, kind);
        return true;
      }
    }
    this.pos[o] = x1;
    this.pos[o + 1] = y1;
    this.pos[o + 2] = z1;

    const trail = def.trail;
    if (trail && this.vfx) {
      this.trailTimer[i] = this.trailTimer[i]! + dt;
      if (this.trailTimer[i]! >= trail.interval) {
        this.trailTimer[i] = 0;
        _pos.set(x1, y1, z1);
        this.vfx.spawn(trail.effect, _pos, UP, trail.scale);
      }
    }
    return false;
  }

  /**
   * Collide the substep _a → _b. Fills _hitPoint/_hitNormal (and hitTarget) and returns the impact
   * kind of the earliest contact.
   */
  private collide(i: number, def: ProjectileDef): number {
    _dir.subVectors(_b, _a);
    const len = _dir.length();
    if (len < 1e-6) return IMPACT_NONE;
    _dir.multiplyScalar(1 / len);

    // Player capsule (swept): parameter along the substep of the closest approach.
    let playerT = 2;
    const target = this.target;
    const P = ENEMY_AI.player;
    if (def.hitsPlayer && target && target.alive) {
      _capA.set(target.position.x, target.position.y + P.hitRadius, target.position.z);
      _capB.set(target.eyePosition.x, Math.max(_capA.y, target.eyePosition.y), target.eyePosition.z);
      segmentSegment(_a, _b, _capA, _capB, _seg);
      const r = P.hitRadius + def.radius;
      if (_seg.distSq <= r * r) playerT = _seg.s;
    }

    // World + damageables (pass through the ones this projectile ignores).
    const reach = len + def.radius;
    const ownerTeam = SOURCES[this.source[i]!] === 'player' ? 'player' : 'enemy';
    const ignore = this.ignore;
    ignore.length = 0;
    const owner = this.owner[i] ?? null;
    this.rayOpts.ignore = owner;
    let from = 0;
    let hit: CombatHit | null = null;
    let hitTarget: Damageable | null = null;
    for (let pass = 0; pass <= PROJECTILE_POOL.maxPassThrough; pass++) {
      _pos.copy(_a).addScaledVector(_dir, from);
      hit = this.combat.raycast(_pos, _dir, reach - from, this.rayOpts);
      if (!hit) break;
      const t = hit.target;
      if (!t) break;
      if (def.hitsDamageables && t.team !== ownerTeam && t !== owner) {
        hitTarget = t;
        break;
      }
      // Not ours to hit: continue behind it.
      ignore.push(t);
      from += hit.distance + PROJECTILE_POOL.passThroughStep;
      hit = null;
      if (from >= reach) break;
    }
    ignore.length = 0;
    this.rayOpts.ignore = null;

    let worldT = 2;
    if (hit) {
      worldT = Math.max(0, (from + hit.distance - def.radius) / len);
      _hitPoint.copy(hit.point);
      _hitNormal.copy(hit.normal);
    }
    if (playerT <= 1 && playerT <= worldT) {
      _hitPoint.copy(_a).lerp(_b, playerT);
      _hitNormal.copy(_dir).negate();
      return IMPACT_PLAYER;
    }
    if (hit) {
      this.hitTarget = hitTarget;
      return hitTarget ? IMPACT_TARGET : IMPACT_WORLD;
    }
    return IMPACT_NONE;
  }

  private impact(i: number, def: ProjectileDef, kind: number): void {
    this.stats.impacts++;
    const scale = this.scale[i]!;
    const source = SOURCES[this.source[i]!]!;
    const o = i * 3;
    const target = this.target;
    const owner = this.owner[i] ?? null;
    // Copy: event handlers may raycast (shared hit) before we are done.
    const px = _hitPoint.x;
    const py = _hitPoint.y;
    const pz = _hitPoint.z;
    const nx = _hitNormal.x;
    const ny = _hitNormal.y;
    const nz = _hitNormal.z;

    if (kind === IMPACT_PLAYER && target) {
      dirTowards(target.eyePosition, this.origin[o]!, this.origin[o + 1]!, this.origin[o + 2]!);
      target.damage(def.damage * scale, _dirTo);
      if (def.directShake > 0) {
        this.shakePayload.trauma = def.directShake;
        this.events.emit('camera:shake', this.shakePayload);
      }
    } else if (def.hitsPlayer && target && target.alive) {
      _pos.set(px, py, pz);
      const dist = Math.max(
        0,
        distanceToCapsule(_pos, target.position, target.eyePosition, ENEMY_AI.player.radius),
      );
      const f = aoeFactor(dist, def.splash.innerRadius, def.splash.radius, def.splash.minFactor);
      if (f > 0 && def.splash.damage > 0) {
        dirTowards(target.eyePosition, px, py, pz);
        target.damage(def.splash.damage * f * scale, _dirTo);
      }
    }

    if (def.hitsDamageables) {
      const direct = kind === IMPACT_TARGET ? this.hitTarget : null;
      const info = this.damageInfo;
      info.weaponId = def.weaponId;
      info.element = def.element;
      info.source = source;
      info.kind = 'projectile';
      info.point.x = px;
      info.point.y = py;
      info.point.z = pz;
      info.direction.x = -nx;
      info.direction.y = -ny;
      info.direction.z = -nz;
      info.impulse = 0;
      if (direct && direct.alive) {
        info.amount = def.damage * scale;
        info.zone = 'body';
        this.combat.dealDamage(direct, info);
      }
      const ownerTeam = source === 'player' ? 'player' : 'enemy';
      _pos.set(px, py, pz);
      const list = this.combat.queryRadius(_pos, def.splash.radius, this.queryOut);
      for (let k = 0; k < list.length; k++) {
        const t = list[k]!;
        if (t === direct || t === owner || t.team === ownerTeam || !t.alive) continue;
        const dist = Math.max(0, t.boundsCenter.distanceTo(_pos) - t.boundsRadius);
        const f = aoeFactor(dist, def.splash.innerRadius, def.splash.radius, def.splash.minFactor);
        if (f <= 0) continue;
        info.amount = def.splash.damage * f * scale;
        info.zone = 'body';
        this.combat.dealDamage(t, info);
      }
      list.length = 0;
    }
    this.hitTarget = null;

    const e = this.impactPayload;
    e.point.x = px;
    e.point.y = py;
    e.point.z = pz;
    e.normal.x = nx;
    e.normal.y = ny;
    e.normal.z = nz;
    e.surface = def.impactSurface;
    e.kind = 'projectile';
    e.weaponId = def.weaponId;
    e.decal = kind === IMPACT_WORLD;
    this.events.emit('combat:impact', e);

    const puddle = def.puddle;
    if (puddle && kind === IMPACT_WORLD) {
      _pos.set(px, py, pz);
      if (ny >= puddle.minNormalY) {
        this.spawnPuddle(def.id, _pos, { source, damageScale: scale });
      } else {
        // Wall / ceiling: the acid runs down to the floor below.
        _pos.set(px + nx * def.radius, py + ny * def.radius, pz + nz * def.radius);
        const floor = this.raycastWorld(_pos, DOWN, puddle.dropDistance);
        if (floor && floor.normal.y >= puddle.minNormalY) {
          _pos.copy(floor.point);
          this.spawnPuddle(def.id, _pos, { source, damageScale: scale });
        }
      }
    }
    // A direct hit leaves no puddle under the player: the hit itself was the punishment.
  }

  /** Static world / prop hit only (damageables passed through). */
  private raycastWorld(origin: Vec3Like, dir: Vec3Like, maxDistance: number): CombatHit | null {
    const ignore = this.ignore;
    ignore.length = 0;
    let from = 0;
    let result: CombatHit | null = null;
    _a.set(origin.x, origin.y, origin.z);
    for (let pass = 0; pass <= PROJECTILE_POOL.maxPassThrough; pass++) {
      _b.set(_a.x + dir.x * from, _a.y + dir.y * from, _a.z + dir.z * from);
      const hit = this.combat.raycast(_b, dir, maxDistance - from, this.rayOpts);
      if (!hit) break;
      if (!hit.target) {
        result = hit;
        break;
      }
      ignore.push(hit.target);
      from += hit.distance + PROJECTILE_POOL.passThroughStep;
      if (from >= maxDistance) break;
    }
    ignore.length = 0;
    return result;
  }

  /**
   * Advance puddle i; true when it is gone. The player part only records the strongest puddle the
   * player stands in (overlapping puddles do not stack – burnPlayer applies it); damageables (player
   * puddles, M5) burn per puddle.
   */
  private stepPuddle(i: number, dt: number): boolean {
    const def = this.defs[this.pDef[i]!]!;
    const P = def.puddle;
    if (!P) return true;
    this.pAge[i] = this.pAge[i]! + dt;
    if (this.pAge[i]! >= P.duration) return true;
    const o = i * 3;
    const x = this.pPos[o]!;
    const y = this.pPos[o + 1]!;
    const z = this.pPos[o + 2]!;
    const target = this.target;
    if (def.hitsPlayer && target && target.alive) {
      const dy = target.position.y - y;
      const inside =
        dy >= -PROJECTILE_POOL.puddleDepthTolerance &&
        dy <= P.height &&
        Math.hypot(target.position.x - x, target.position.z - z) <=
          P.radius + ENEMY_AI.player.radius * PROJECTILE_POOL.puddleFootFraction;
      const dps = P.dps * this.pScale[i]!;
      if (inside && dps > this.burnDps) {
        this.burnDps = dps;
        this.burnInterval = P.tickInterval;
        this.burnAt.set(x, y, z);
      }
    }
    if (!def.hitsDamageables) return false;
    this.pTick[i] = this.pTick[i]! + dt;
    if (this.pTick[i]! < P.tickInterval) return false;
    this.pTick[i] = this.pTick[i]! - P.tickInterval;
    const amount = P.dps * P.tickInterval * this.pScale[i]!;
    const source = SOURCES[this.pSource[i]!]!;
    const team = source === 'player' ? 'player' : 'enemy';
    _pos.set(x, y, z);
    const list = this.combat.queryRadius(_pos, P.radius, this.queryOut);
    const info = this.damageInfo;
    info.weaponId = def.weaponId;
    info.element = def.element;
    info.source = source;
    info.kind = 'projectile';
    info.zone = 'limb';
    info.amount = amount;
    info.point.x = x;
    info.point.y = y;
    info.point.z = z;
    info.direction.x = 0;
    info.direction.y = 1;
    info.direction.z = 0;
    info.impulse = 0;
    for (let k = 0; k < list.length; k++) {
      const t = list[k]!;
      if (t.team !== team && t.alive) this.combat.dealDamage(t, info);
    }
    list.length = 0;
    return false;
  }

  /** DoT of the strongest puddle the player stands in, applied in ticks of its interval. */
  private burnPlayer(dt: number): void {
    const target = this.target;
    if (!(this.burnDps > 0) || !target || !target.alive || !(this.burnInterval > 0)) {
      this.burnTimer = 0;
      return;
    }
    this.burnTimer += dt;
    if (this.burnTimer < this.burnInterval) return;
    this.burnTimer -= this.burnInterval;
    dirTowards(target.eyePosition, this.burnAt.x, this.burnAt.y, this.burnAt.z);
    target.damage(this.burnDps * this.burnInterval, _dirTo);
  }

  private releaseAt(k: number): void {
    const i = this.active[k]!;
    this.active[k] = this.active[--this.activeCount]!;
    this.owner[i] = null;
    this.free[this.freeTop++] = i;
  }

  private releasePuddleAt(k: number): void {
    const i = this.pActive[k]!;
    this.pActive[k] = this.pActive[--this.pActiveCount]!;
    this.pFree[this.pFreeTop++] = i;
  }

  private resolve(defId: string): number {
    const d = this.defIndex.get(defId);
    if (d !== undefined) return d;
    if (!this.warned.has(defId)) {
      this.warned.add(defId);
      log.warn(`Unknown projectile "${defId}" – ignored`);
    }
    return -1;
  }
}

/** Unit direction from `from` towards (x, y, z) into _dirTo (the player:damaged convention). */
function dirTowards(from: Vec3Like, x: number, y: number, z: number): void {
  const dx = x - from.x;
  const dy = y - from.y;
  const dz = z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-6) {
    _dirTo.x = dx / len;
    _dirTo.y = dy / len;
    _dirTo.z = dz / len;
  } else {
    _dirTo.x = 0;
    _dirTo.y = 0;
    _dirTo.z = -1;
  }
}

function finite3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
