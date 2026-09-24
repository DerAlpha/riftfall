/**
 * Arsenal projectiles (ProjectileApi, M5): plasma bolts, grenades, void/shock/ice orbs – and the
 * grenades of package E1. Distinct from combat/Projectiles.ts (the enemies' acid globs).
 *
 * Simulation (fixed tick, after the enemies – hitboxes are this tick's): exact constant-gravity
 * integration, then the tick's segment is swept against the static world, props and hitboxes
 * through CombatWorld.raycast (the ray reaches `radius` further: a swept sphere for everything the
 * ray meets head on). Contacts per tick are resolved in order (ARSENAL.projectiles
 * maxContactsPerTick):
 * - a damageable of another team: direct damage (zone multipliers of the source), then it passes
 *   through while `pierce` lasts (it never hits the same body twice), else it stops – detonating
 *   when it has an explosion or field ("direct hits detonate");
 * - the world: it bounces while `bounces` last (restitution; slow projectiles on a floor come to
 *   rest until their fuse), else it detonates / splashes there.
 * `fuse` (> 0) detonates it wherever it is; at the end of `lifetime` it detonates if it can, else
 * it vanishes. Homing projectiles turn (≤ `homing` rad/s) towards the enemy nearest their flight
 * line (re-acquired every ARSENAL.projectiles.homing.retargetInterval, line of sight required).
 *
 * Detonation: ExplosionApi (radius × blastScale, damage × the source's areaScale) and/or a
 * FieldApi field at the contact point lifted off the surface; `projectile:impact` always, and a
 * combat:impact (impact VFX/SFX by the weapon's profile) for direct hits and non-exploding ones.
 *
 * WYSIWYG: the simulation starts at the rendered camera (`origin`), the visual at the muzzle as
 * shown (`visualFrom`); the drawn position converges onto the true path within
 * ARSENAL.projectiles.convergeTime. Visuals are driven per frame through ArsenalVfxApi
 * (interpolated between ticks); projectile:spawned / :ended + positionOf() serve flight audio.
 *
 * Pool: structure of arrays, preallocated; nothing allocates per tick or frame.
 */
import { Vector3 } from 'three';
import type {
  ArsenalVfxApi,
  CombatHit,
  CombatRaycastOptions,
  DamageInfo,
  Damageable,
  ExplosionApi,
  FieldApi,
  ProjectileApi,
  ProjectileSpawnOptions,
  WeaponCombatApi,
} from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type {
  DamageElement,
  FleshSurface,
  GameEvents,
  HitZone,
  SurfaceType,
  Vec3Like,
} from '../../core/events';
import { ARSENAL } from '../../defs/combat';
import type { ExplosionDef, WeaponProjectileDef, WeaponSpecialDef } from '../../defs/weapons';
import { DEG2RAD } from '../../core/math';
import { TIME_EPS, bounceVelocity, convergeWeight, homingScore, turnTowards } from './fireMath';
import { NULL_ARSENAL_VFX } from './nullArsenalVfx';
import { createSpecialHit, type SpecialsHook } from './types';
import { statusBuildupFor } from './WeaponSpecials';

export type ProjectileCombat = Pick<WeaponCombatApi, 'raycast' | 'dealDamage' | 'lineOfSight' | 'targets'>;

export interface ProjectileSystemDeps {
  events: EventBus<GameEvents>;
  combat: ProjectileCombat;
  explosions: ExplosionApi;
  fields: FieldApi;
  vfx?: ArsenalVfxApi | null;
  specials?: SpecialsHook | null;
  capacity?: number;
}

type Source = DamageInfo['source'];
const SOURCES: readonly Source[] = ['player', 'enemy', 'trap', 'environment'];

/** Mutable copy of an ExplosionDef (scaled detonations without allocating). */
type MutableExplosion = { -readonly [K in keyof ExplosionDef]: ExplosionDef[K] };

const _s = new Vector3();
const _e = new Vector3();
const _d = new Vector3();
const _v = new Vector3();
const _n = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
const _to = new Vector3();
// spawn() has its own scratch: a handler may spawn while a step is using the ones above.
const _spawnV = new Vector3();
const _spawnP = new Vector3();

export class ProjectileSystem implements ProjectileApi {
  readonly capacity: number;
  readonly stats = { spawned: 0, refused: 0, detonations: 0, bounces: 0, hits: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly combat: ProjectileCombat;
  private readonly explosions: ExplosionApi;
  private readonly fields: FieldApi;
  private vfx: ArsenalVfxApi;
  private specials: SpecialsHook | null;

  // --- pool (structure of arrays) ---
  private readonly pos: Float64Array;
  private readonly prev: Float64Array;
  private readonly vel: Float64Array;
  private readonly visOff: Float64Array;
  private readonly vis: Float64Array;
  private readonly age: Float64Array;
  private readonly blastScale: Float64Array;
  private readonly areaScale: Float64Array;
  private readonly damage: Float64Array;
  private readonly headMul: Float64Array;
  private readonly weakMul: Float64Array;
  private readonly buildup: Float64Array;
  private readonly homingTimer: Float64Array;
  private readonly bounces: Int16Array;
  private readonly pierce: Int16Array;
  private readonly resting: Uint8Array;
  private readonly source: Uint8Array;
  private readonly piercedCount: Uint8Array;
  private readonly handle: Int32Array;
  private readonly ids: Int32Array;
  private readonly defs: (WeaponProjectileDef | null)[];
  private readonly weaponIds: string[];
  private readonly elements: DamageElement[];
  private readonly specialDefs: (WeaponSpecialDef | null)[];
  private readonly homingTarget: (Damageable | null)[];
  private readonly pierced: (Damageable | null)[];
  private readonly free: Int32Array;
  private freeTop = 0;
  private readonly activeList: Int32Array;
  private activeCount = 0;
  private seq = 0;
  private tickDt = 0;
  private readonly memory: number;

  // --- scratch ---
  private readonly ignore: Damageable[] = [];
  private readonly rayOpts: CombatRaycastOptions = { ignoreMany: this.ignore };
  private readonly blast: MutableExplosion = {
    radius: 0,
    damage: 0,
    minFalloffMultiplier: 0,
    element: 'physical',
    impulse: 0,
    propImpulse: 0,
    selfDamageScale: 0,
    shake: 0,
    vfx: '',
    audio: '',
  };
  private readonly from: {
    weaponId: string;
    source: Source;
    statusBuildup: number;
    special: WeaponSpecialDef | null;
    areaScale: number;
  } = { weaponId: '', source: 'player', statusBuildup: 0, special: null, areaScale: 1 };
  private readonly info: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: '',
    element: 'physical',
    source: 'player',
    kind: 'projectile',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly hit = createSpecialHit();
  private readonly spawnedPayload: GameEvents['projectile:spawned'] = {
    id: 0,
    weaponId: '',
    visual: '',
    flightAudio: null,
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly endedPayload: GameEvents['projectile:ended'] = { id: 0 };
  private readonly impactPayload: GameEvents['projectile:impact'] = {
    weaponId: '',
    position: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    detonated: false,
  };
  private readonly combatImpact: GameEvents['combat:impact'] = {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 'default',
    kind: 'projectile',
    weaponId: '',
    decal: true,
  };

  constructor(deps: ProjectileSystemDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.explosions = deps.explosions;
    this.fields = deps.fields;
    this.vfx = deps.vfx ?? NULL_ARSENAL_VFX;
    this.specials = deps.specials ?? null;
    const n = Math.max(1, Math.floor(deps.capacity ?? ARSENAL.projectiles.capacity));
    this.capacity = n;
    this.memory = ARSENAL.projectiles.maxPierceMemory;
    this.pos = new Float64Array(n * 3);
    this.prev = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.visOff = new Float64Array(n * 3);
    this.vis = new Float64Array(n * 3);
    this.age = new Float64Array(n);
    this.blastScale = new Float64Array(n);
    this.areaScale = new Float64Array(n);
    this.damage = new Float64Array(n);
    this.headMul = new Float64Array(n);
    this.weakMul = new Float64Array(n);
    this.buildup = new Float64Array(n);
    this.homingTimer = new Float64Array(n);
    this.bounces = new Int16Array(n);
    this.pierce = new Int16Array(n);
    this.resting = new Uint8Array(n);
    this.source = new Uint8Array(n);
    this.piercedCount = new Uint8Array(n);
    this.handle = new Int32Array(n);
    this.ids = new Int32Array(n);
    this.defs = new Array<WeaponProjectileDef | null>(n).fill(null);
    this.weaponIds = new Array<string>(n).fill('');
    this.elements = new Array<DamageElement>(n).fill('physical');
    this.specialDefs = new Array<WeaponSpecialDef | null>(n).fill(null);
    this.homingTarget = new Array<Damageable | null>(n).fill(null);
    this.pierced = new Array<Damageable | null>(n * this.memory).fill(null);
    this.free = new Int32Array(n);
    this.activeList = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeTop = n;
  }

  get active(): number {
    return this.activeCount;
  }

  setVfx(vfx: ArsenalVfxApi | null): void {
    this.vfx = vfx ?? NULL_ARSENAL_VFX;
  }

  setSpecials(specials: SpecialsHook | null): void {
    this.specials = specials;
  }

  spawn(opts: ProjectileSpawnOptions): number {
    const def = opts.def;
    const o0 = opts.origin;
    const dir = opts.direction;
    if (!def || !finite(o0) || !finite(dir)) return 0;
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    if (!(dl > 1e-9)) return 0;
    if (this.freeTop === 0) {
      this.stats.refused++;
      return 0;
    }
    const i = this.free[--this.freeTop]!;
    this.activeList[this.activeCount++] = i;
    const o = i * 3;
    const speed = def.speed * positive(opts.speedScale, 1);
    const inherit = opts.inherit && finite(opts.inherit) ? opts.inherit : null;
    this.vel[o] = (dir.x / dl) * speed + (inherit ? inherit.x : 0);
    this.vel[o + 1] = (dir.y / dl) * speed + (inherit ? inherit.y : 0);
    this.vel[o + 2] = (dir.z / dl) * speed + (inherit ? inherit.z : 0);
    this.pos[o] = this.prev[o] = o0.x;
    this.pos[o + 1] = this.prev[o + 1] = o0.y;
    this.pos[o + 2] = this.prev[o + 2] = o0.z;
    const vf = opts.visualFrom && finite(opts.visualFrom) ? opts.visualFrom : o0;
    this.visOff[o] = vf.x - o0.x;
    this.visOff[o + 1] = vf.y - o0.y;
    this.visOff[o + 2] = vf.z - o0.z;
    this.vis[o] = vf.x;
    this.vis[o + 1] = vf.y;
    this.vis[o + 2] = vf.z;
    this.age[i] = 0;
    this.blastScale[i] = positive(opts.blastScale, 1);
    const src = opts.damage;
    this.areaScale[i] = src.areaScale !== undefined && src.areaScale >= 0 ? src.areaScale : 1;
    this.damage[i] = Math.max(0, src.damage);
    this.headMul[i] = src.headMultiplier;
    this.weakMul[i] = src.weakpointMultiplier;
    this.buildup[i] = src.statusBuildup;
    this.homingTimer[i] = 0;
    this.bounces[i] = Math.max(0, Math.floor(def.bounces));
    this.pierce[i] = Math.max(0, Math.floor(def.pierce));
    this.resting[i] = 0;
    this.source[i] = Math.max(0, SOURCES.indexOf(src.source));
    this.piercedCount[i] = 0;
    this.defs[i] = def;
    this.weaponIds[i] = src.weaponId;
    this.elements[i] = src.element;
    this.specialDefs[i] = src.special ?? null;
    this.homingTarget[i] = null;
    const id = ++this.seq;
    this.ids[i] = id;
    _spawnV.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
    _spawnP.set(vf.x, vf.y, vf.z);
    this.handle[i] = this.vfx.projectileStart(def.visual, def.trail, _spawnP, _spawnV);
    this.stats.spawned++;
    const e = this.spawnedPayload;
    e.id = id;
    e.weaponId = src.weaponId;
    e.visual = def.visual;
    e.flightAudio = def.flightAudio;
    copyVec(_spawnP, e.position);
    this.events.emit('projectile:spawned', e);
    return id;
  }

  positionOf(id: number, out: Vector3): boolean {
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      if (this.ids[i] !== id) continue;
      const o = i * 3;
      out.set(this.vis[o]!, this.vis[o + 1]!, this.vis[o + 2]!);
      return true;
    }
    return false;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.tickDt = dt;
    for (let k = this.activeCount - 1; k >= 0; k--) {
      if (k >= this.activeCount) continue;
      const i = this.activeList[k]!;
      if (this.step(i, dt)) this.release(i);
    }
  }

  /** Per frame: interpolated, muzzle-converged visuals. */
  update(_dt: number, alpha: number): void {
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const behind = (1 - a) * this.tickDt;
    const converge = ARSENAL.projectiles.convergeTime;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      const o = i * 3;
      const w = convergeWeight(this.age[i]! - behind, converge);
      for (let c = 0; c < 3; c++) {
        const p = this.prev[o + c]! + (this.pos[o + c]! - this.prev[o + c]!) * a;
        this.vis[o + c] = p + this.visOff[o + c]! * w;
      }
      const h = this.handle[i]!;
      if (h === 0) continue;
      _p.set(this.vis[o]!, this.vis[o + 1]!, this.vis[o + 2]!);
      _v.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
      this.vfx.projectileMove(h, _p, _v);
    }
  }

  /** Remove every projectile without detonating (run reset). */
  clear(): void {
    while (this.activeCount > 0) this.release(this.activeList[this.activeCount - 1]!);
  }

  /** Live projectiles (debug / tests): simulated position, velocity, weapon id. */
  forEachProjectile(
    fn: (
      id: number,
      x: number,
      y: number,
      z: number,
      vx: number,
      vy: number,
      vz: number,
      weaponId: string,
    ) => void,
  ): void {
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      const o = i * 3;
      fn(
        this.ids[i]!,
        this.pos[o]!,
        this.pos[o + 1]!,
        this.pos[o + 2]!,
        this.vel[o]!,
        this.vel[o + 1]!,
        this.vel[o + 2]!,
        this.weaponIds[i]!,
      );
    }
  }

  dispose(): void {
    this.clear();
    this.specials = null;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** Advance projectile i by dt; true when it is gone. */
  private step(i: number, dt: number): boolean {
    const def = this.defs[i]!;
    const o = i * 3;
    this.prev[o] = this.pos[o]!;
    this.prev[o + 1] = this.pos[o + 1]!;
    this.prev[o + 2] = this.pos[o + 2]!;
    const age = (this.age[i] = this.age[i]! + dt);
    if (def.fuse > 0 && age >= def.fuse - TIME_EPS) {
      _c.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
      this.detonate(i, _c, 0, 1, 0, null);
      return true;
    }
    if (age >= def.lifetime - TIME_EPS) {
      _c.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
      if (def.explosion || def.field) this.detonate(i, _c, 0, 1, 0, null);
      return true;
    }
    if (this.resting[i] === 1) return false;
    if (def.homing > 0) this.home(i, def, dt);

    // Exact constant-gravity step.
    const vy = this.vel[o + 1]!;
    _s.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
    _e.set(
      _s.x + this.vel[o]! * dt,
      _s.y + vy * dt - 0.5 * def.gravity * dt * dt,
      _s.z + this.vel[o + 2]! * dt,
    );
    this.vel[o + 1] = vy - def.gravity * dt;

    const P = ARSENAL.projectiles;
    let contact = 0;
    for (; contact < P.maxContactsPerTick; contact++) {
      _d.subVectors(_e, _s);
      const len = _d.length();
      if (!(len > 1e-6)) break;
      _d.multiplyScalar(1 / len);
      const hit = this.cast(i, _s, _d, len + def.radius);
      if (!hit) break;
      const t = Math.max(0, hit.distance - def.radius);
      if (t > len) break;
      _c.copy(_s).addScaledVector(_d, t);
      const target = hit.target;
      if (target) {
        // Read the shared hit before anything emits or raycasts.
        const zone: HitZone = hit.zone ?? 'body';
        const surface = hit.surface;
        _p.copy(hit.point);
        _n.copy(hit.normal);
        this.directHit(i, target, zone, surface, _p, _n, _d);
        if (this.pierce[i]! > 0) {
          this.pierce[i] = this.pierce[i]! - 1;
          this.remember(i, target);
          continue;
        }
        this.detonateOrEnd(i, def, _c, -_d.x, -_d.y, -_d.z, null);
        return true;
      }
      const surface = hit.surface;
      _n.copy(hit.normal);
      _p.copy(hit.point);
      if (this.bounces[i]! > 0) {
        this.bounces[i] = this.bounces[i]! - 1;
        this.stats.bounces++;
        this.emitImpact(i, _p, _n, false);
        const oldSpeed = Math.hypot(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
        _v.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
        bounceVelocity(_v, _n, def.restitution, P.tangentKeep, _v);
        this.vel[o] = _v.x;
        this.vel[o + 1] = _v.y;
        this.vel[o + 2] = _v.z;
        _s.copy(_p).addScaledVector(_n, def.radius + P.bounceLift);
        const newSpeed = _v.length();
        if (newSpeed < P.restSpeed && _n.y >= P.restNormalY) {
          this.resting[i] = 1;
          this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
          _e.copy(_s);
          break;
        }
        // The rest of the tick's travel continues along the new velocity.
        const remaining = oldSpeed > 1e-6 ? ((len - t) * newSpeed) / oldSpeed : 0;
        _e.copy(_s).addScaledVector(_v, newSpeed > 1e-6 ? remaining / newSpeed : 0);
        continue;
      }
      _c.copy(_p);
      this.detonateOrEnd(i, def, _c, _n.x, _n.y, _n.z, surface);
      return true;
    }
    // Out of contacts this tick (a corner): stay at the last free point instead of tunnelling.
    if (contact >= P.maxContactsPerTick) _e.copy(_s);
    this.pos[o] = _e.x;
    this.pos[o + 1] = _e.y;
    this.pos[o + 2] = _e.z;
    return false;
  }

  /**
   * Nearest contact along the segment: world, props and damageables of other teams (own team,
   * dead and already pierced bodies are passed – the whole ray is cast again without them).
   */
  private cast(i: number, from: Vector3, dir: Vector3, reach: number): CombatHit | null {
    const ignore = this.ignore;
    ignore.length = 0;
    const base = i * this.memory;
    for (let k = 0; k < this.piercedCount[i]!; k++) {
      const t = this.pierced[base + k];
      if (t) ignore.push(t);
    }
    const team = SOURCES[this.source[i]!] === 'player' ? 'player' : 'enemy';
    let result: CombatHit | null = null;
    for (let pass = 0; pass <= this.memory; pass++) {
      const hit = this.combat.raycast(from, dir, reach, this.rayOpts);
      if (!hit) break;
      const t = hit.target;
      if (t && (t.team === team || !t.alive)) {
        ignore.push(t);
        continue;
      }
      result = hit;
      break;
    }
    ignore.length = 0;
    return result;
  }

  private remember(i: number, target: Damageable): void {
    const n = this.piercedCount[i]!;
    if (n >= this.memory) return;
    this.pierced[i * this.memory + n] = target;
    this.piercedCount[i] = n + 1;
  }

  private directHit(
    i: number,
    target: Damageable,
    zone: HitZone,
    surface: SurfaceType | FleshSurface,
    point: Vector3,
    normal: Vector3,
    dir: Vector3,
  ): void {
    const mult = zone === 'head' ? this.headMul[i]! : zone === 'weakpoint' ? this.weakMul[i]! : 1;
    const amount = this.damage[i]! * mult;
    const weaponId = this.weaponIds[i]!;
    const ci = this.combatImpact;
    copyVec(point, ci.point);
    copyVec(normal, ci.normal);
    ci.surface = surface;
    ci.kind = 'projectile';
    ci.weaponId = weaponId;
    ci.decal = false;
    this.events.emit('combat:impact', ci);
    if (!(amount > 0) || !target.alive) return;
    const info = this.info;
    info.amount = amount;
    info.zone = zone;
    copyVec(point, info.point);
    copyVec(dir, info.direction);
    info.weaponId = weaponId;
    info.element = this.elements[i]!;
    info.source = SOURCES[this.source[i]!]!;
    info.kind = 'projectile';
    info.impulse = ARSENAL.projectiles.directImpulse;
    info.statusBuildup = this.buildup[i]!;
    const res = this.combat.dealDamage(target, info);
    this.stats.hits++;
    const special = this.specialDefs[i] ?? null;
    if (special && this.specials) {
      const h = this.hit;
      h.special = special;
      h.via = 'direct';
      h.weaponId = weaponId;
      h.source = info.source;
      h.target = target;
      copyVec(point, h.point);
      h.applied = res.applied;
      h.killed = res.killed;
      h.primary = true;
      this.specials.onHit(h);
    }
  }

  /** It stops at `at` (surface normal n): detonate when it can, else splash (impact VFX/SFX). */
  private detonateOrEnd(
    i: number,
    def: WeaponProjectileDef,
    at: Vector3,
    nx: number,
    ny: number,
    nz: number,
    surface: SurfaceType | FleshSurface | null,
  ): void {
    if (def.explosion || def.field) {
      this.detonate(i, at, nx, ny, nz, surface);
      return;
    }
    _n.set(nx, ny, nz);
    if (surface !== null) {
      const ci = this.combatImpact;
      copyVec(at, ci.point);
      copyVec(_n, ci.normal);
      ci.surface = surface;
      ci.kind = 'projectile';
      ci.weaponId = this.weaponIds[i]!;
      ci.decal = true;
      this.events.emit('combat:impact', ci);
    }
    this.emitImpact(i, at, _n, false);
  }

  private detonate(
    i: number,
    at: Vector3,
    nx: number,
    ny: number,
    nz: number,
    _surface: SurfaceType | FleshSurface | null,
  ): void {
    const def = this.defs[i]!;
    const lift = ARSENAL.projectiles.blastLift;
    // Copy: `at` may be module scratch that nested calls reuse.
    const x = at.x + nx * lift;
    const y = at.y + ny * lift;
    const z = at.z + nz * lift;
    this.stats.detonations++;
    const from = this.from;
    from.weaponId = this.weaponIds[i]!;
    from.source = SOURCES[this.source[i]!]!;
    from.special = this.specialDefs[i] ?? null;
    from.areaScale = this.areaScale[i]!;
    const ex = def.explosion;
    if (ex) {
      const b = this.blast;
      Object.assign(b, ex);
      b.radius = ex.radius * this.blastScale[i]!;
      from.statusBuildup = statusBuildupFor(ex.element);
      this.explosions.explode(_to.set(x, y, z), b, from);
    }
    const field = def.field;
    if (field) {
      from.weaponId = this.weaponIds[i]!;
      from.source = SOURCES[this.source[i]!]!;
      from.special = this.specialDefs[i] ?? null;
      from.areaScale = this.areaScale[i]!;
      from.statusBuildup = statusBuildupFor(field.element);
      this.fields.spawn(_to.set(x, y, z), field, from);
    }
    _to.set(x, y, z);
    _n.set(nx, ny, nz);
    this.emitImpact(i, _to, _n, ex !== null || field !== null);
  }

  private emitImpact(i: number, at: Vec3Like, normal: Vec3Like, detonated: boolean): void {
    const e = this.impactPayload;
    e.weaponId = this.weaponIds[i]!;
    copyVec(at, e.position);
    copyVec(normal, e.normal);
    e.detonated = detonated;
    this.events.emit('projectile:impact', e);
  }

  /** Turn towards the enemy nearest the flight line (re-acquired on a timer, LOS required). */
  private home(i: number, def: WeaponProjectileDef, dt: number): void {
    const H = ARSENAL.projectiles.homing;
    const o = i * 3;
    _p.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
    _v.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
    const speed = _v.length();
    if (!(speed > 1e-6)) return;
    this.homingTimer[i] = this.homingTimer[i]! - dt;
    if (this.homingTimer[i]! <= 0) {
      this.homingTimer[i] = H.retargetInterval;
      _d.copy(_v).multiplyScalar(1 / speed);
      const cosCone = Math.cos(H.coneDeg * DEG2RAD);
      const targets = this.combat.targets;
      const team = SOURCES[this.source[i]!] === 'player' ? 'player' : 'enemy';
      let best: Damageable | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let k = 0; k < targets.length; k++) {
        const t = targets[k]!;
        if (!t.alive || t.team === team || t.team === 'neutral' || this.wasPierced(i, t)) continue;
        const s = homingScore(_p, _d, t.aimPoint, H.range, cosCone);
        if (s < 0 || s >= bestScore) continue;
        best = t;
        bestScore = s;
      }
      if (best && !this.combat.lineOfSight(_p, best.aimPoint)) best = null;
      this.homingTarget[i] = best;
    }
    const t = this.homingTarget[i];
    if (!t || !t.alive) return;
    _to.subVectors(t.aimPoint, _p);
    const len = _to.length();
    if (!(len > 1e-6)) return;
    _to.multiplyScalar(1 / len);
    turnTowards(_v, _to, def.homing * dt, _v);
    this.vel[o] = _v.x;
    this.vel[o + 1] = _v.y;
    this.vel[o + 2] = _v.z;
  }

  private wasPierced(i: number, t: Damageable): boolean {
    const base = i * this.memory;
    for (let k = 0; k < this.piercedCount[i]!; k++) if (this.pierced[base + k] === t) return true;
    return false;
  }

  /** End projectile slot i: visual, event, references, back to the pool. */
  private release(i: number): void {
    let k = -1;
    for (let j = this.activeCount - 1; j >= 0; j--) {
      if (this.activeList[j] === i) {
        k = j;
        break;
      }
    }
    if (k < 0) return;
    this.activeList[k] = this.activeList[--this.activeCount]!;
    this.free[this.freeTop++] = i;
    const h = this.handle[i]!;
    this.handle[i] = 0;
    if (h !== 0) this.vfx.projectileEnd(h);
    this.defs[i] = null;
    this.specialDefs[i] = null;
    this.homingTarget[i] = null;
    const base = i * this.memory;
    for (let j = 0; j < this.memory; j++) this.pierced[base + j] = null;
    this.piercedCount[i] = 0;
    this.endedPayload.id = this.ids[i]!;
    this.events.emit('projectile:ended', this.endedPayload);
  }
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
