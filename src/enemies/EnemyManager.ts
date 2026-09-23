/**
 * EnemyManager (EnemyManagerApi): pooled enemies, their AI, nav agents, attacks and projectiles.
 *
 * Fixed tick (after the weapons – hits of this tick already landed on the previous tick's hitboxes):
 *   1. deaths recorded during the weapon tick → enemy:died, death VFX, sac burst, free nav agent
 *   2. perception: aggro target selection, gunshot hearing, horde sense, round-robin LOS rays
 *      (ENEMY_AI.budget.losPerTick) + alerts
 *   3. think: emerge → brain (attack choice / movement goal) → attack phases → stagger → death anim
 *   4. movement requests to the nav crowd (deduped), nav.update(dt) (stepNav), read positions;
 *      AI overrides (leap, charge, knockback) move the enemy directly while its agent is parked
 *   5. stuck detection, leash, player push-out, facing, pose, visuals transform/pose, hitboxes /
 *      bounds / aim point for combat, kinematic player-blocker bodies → visuals.commitTick()
 *   6. projectiles (when owned)
 * Frame: update(dt, alpha) → visuals.update (interpolation) + projectile blobs.
 *
 * Budgets keep 60 enemies inside ~2.5 ms/tick: LOS rays, nav path queries (surround slots), spot
 * rays (spitter search) are rationed per tick and handed out first come first served (the order
 * rotates with the LOS cursor), everything else is O(enemies) with no allocations.
 */
import { Vector3, type Object3D } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type {
  ColliderData,
  CombatWorldApi,
  DamageInfo,
  Damageable,
  EnemyManagerApi,
  EnemySpawnOptions,
  EnemyTargetApi,
  NavAgentParams,
  NavApi,
  PhysicsApi,
  SpawnPointDef,
  VfxApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD } from '../core/math';
import { Pool } from '../core/Pool';
import { Rng } from '../core/Rng';
import { ENEMIES, ENEMY_AI, getEnemyDef, type EnemyAttackDef, type EnemyTypeDef } from '../defs/enemies';
import { attackAnimIndex, getEnemyVisualDef } from '../defs/enemyVisuals';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { ProjectileSystem } from '../combat/Projectiles';
import { Enemy, PHASE_STRIKE, type EnemyOwner } from './Enemy';
import { AttackSlotCoordinator } from './ai/AttackSlotCoordinator';
import {
  aoeFactor,
  attackAnimProgress,
  distXZ,
  distanceToCapsule,
  inFov,
  locomotionBlend,
  turnTowards,
  wrapPi,
  yawTo,
} from './ai/attackMath';
import { cancelAttack, phaseDuration, updateAttack } from './ai/attacks';
import { getBrain } from './ai/brains';
import { STUCK_NONE, STUCK_REPATH, STUCK_TELEPORT, resetStuck, updateStuck } from './ai/StuckMonitor';
import { SurroundSlots } from './ai/SurroundSlots';
import { ThreatTable } from './ai/ThreatTable';
import type { AiHost, EnemyBrain } from './ai/types';
import type { EnemyVisualsApi } from './types';

const log = createLogger('enemies');

const TAU = Math.PI * 2;
const UP: Vec3Like = { x: 0, y: 1, z: 0 };
/** Enemy blocker bodies: ENEMY members that only touch the player. */
const BLOCKER_GROUPS = interactionGroups(COLLISION_GROUP.ENEMY, COLLISION_GROUP.PLAYER);

export interface EnemyManagerDeps {
  events: EventBus<GameEvents>;
  combat: CombatWorldApi;
  nav: NavApi;
  visuals: EnemyVisualsApi;
  /** The player (primary aggro target). */
  target: EnemyTargetApi;
  /** Kinematic player-blocking capsules for types with a `collider` (optional). */
  physics?: PhysicsApi | null;
  /** Spawn / death / slam effects (optional). */
  vfx?: VfxApi | null;
  /** Shared projectile system; by default the manager creates and owns one. */
  projectiles?: ProjectileSystem | null;
  /** Scene for the owned projectile blobs (none: simulation only). */
  scene?: Object3D | null;
  /** Step nav.update(dt) inside fixedUpdate (default true – the crowd ticks with the AI). */
  stepNav?: boolean;
  /** Max living enemies (default ENEMY_AI.capacity). */
  capacity?: number;
  /** Gameplay RNG seed (daily challenge determinism). */
  seed?: string | number;
}

/** PhysicsWorld extra (collider metadata registry) used when present. */
interface PhysicsExtras {
  createCollider?(
    desc: RAPIER.ColliderDesc,
    parent: RAPIER.RigidBody | null,
    data: ColliderData,
  ): RAPIER.Collider;
}

interface TypeRuntime {
  readonly def: EnemyTypeDef;
  readonly brain: EnemyBrain;
  readonly pool: Pool<Enemy>;
  /** Every record ever created for this type (dispose). */
  readonly records: Enemy[];
  readonly navParams: NavAgentParams;
  /** Per attack: EnemyPose.attackId and the animation's wind-up / strike ends (0..1). */
  readonly animIndex: Int16Array;
  readonly animWindup: Float32Array;
  readonly animStrike: Float32Array;
  readonly spawnEffect: string | null;
  readonly spawnScale: number;
  readonly deathEffect: string | null;
  readonly deathScale: number;
  readonly deathSocket: string | null;
}

export interface EnemyManagerStats {
  alive: number;
  byType: Record<string, number>;
  /** Last fixedUpdate cost (ms) and its moving average. */
  aiMs: number;
  aiMsAvg: number;
  /** Records in use (living + dying) and LOS rays cast in the last tick. */
  records: number;
  losRays: number;
}

// Scratch.
const _v = new Vector3();
const _w = new Vector3();
const _eye = new Vector3();
const _prev = new Vector3();
const _kin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

export class EnemyManager implements EnemyManagerApi, EnemyOwner, AiHost {
  readonly stats: EnemyManagerStats;
  readonly nav: NavApi;
  readonly combat: CombatWorldApi;
  readonly rng: Rng;
  readonly projectiles: ProjectileSystem | null;
  readonly vfx: VfxApi | null;
  readonly pathScratch: Vector3[] = [];
  /** AI on/off (dev console `enemy freeze`): frozen enemies still animate, die and dissolve. */
  aiEnabled = true;

  private readonly events: EventBus<GameEvents>;
  private readonly visuals: EnemyVisualsApi;
  private readonly physics: (PhysicsApi & PhysicsExtras) | null;
  private readonly ownsProjectiles: boolean;
  private readonly stepNav: boolean;
  private readonly _capacity: number;
  private readonly primary: EnemyTargetApi;
  private readonly primarySlot: number;

  private readonly types = new Map<string, TypeRuntime>();
  private readonly active: Enemy[] = [];
  private readonly threat: ThreatTable;
  private readonly coordinators: AttackSlotCoordinator[] = [];
  private readonly surrounds: SurroundSlots[] = [];
  private readonly facing: Float64Array;
  /** Last ranged attack start per aggro target (volley spacing). */
  private readonly lastVolley: Float64Array;
  private readonly shotDir = new Vector3();
  private shotTime = Number.NEGATIVE_INFINITY;
  private spawnPoints: readonly SpawnPointDef[] = [];

  private _time = 0;
  private aliveCount = 0;
  private nextId: number = ENEMY_AI.firstId;
  private serial = 0;
  private losCursor = 0;
  private nextAlertTime = 0;
  private disposed = false;
  private suppressBursts = false;
  private readonly warned = new Set<string>();
  private readonly unsubscribe: (() => void)[] = [];

  // Per-tick budgets.
  private losLeft = 0;
  private urgentLosLeft = 0;
  private pathsLeft = 0;
  private spotRaysLeft = 0;

  private readonly queryOut: Damageable[] = [];
  private readonly burstInfo: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 0 },
    weaponId: '',
    element: 'poison',
    source: 'enemy',
    kind: 'explosion',
  };
  private readonly spawnedPayload: GameEvents['enemy:spawned'] = {
    id: 0,
    type: '',
    position: { x: 0, y: 0, z: 0 },
    elite: false,
  };
  private readonly alertPayload: GameEvents['enemy:alert'] = {
    id: 0,
    type: '',
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly attackPayload: GameEvents['enemy:attack'] = {
    id: 0,
    type: '',
    attack: '',
    position: { x: 0, y: 0, z: 0 },
    windup: 0,
  };
  private readonly staggerPayload: GameEvents['enemy:staggered'] = {
    id: 0,
    type: '',
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly diedPayload: GameEvents['enemy:died'] = {
    id: 0,
    type: '',
    position: { x: 0, y: 0, z: 0 },
    weaponId: null,
    zone: null,
    elite: false,
    source: 'environment',
  };
  private readonly shakePayload: GameEvents['camera:shake'] = { trauma: 0 };

  constructor(deps: EnemyManagerDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.nav = deps.nav;
    this.visuals = deps.visuals;
    this.primary = deps.target;
    this.physics = (deps.physics ?? null) as (PhysicsApi & PhysicsExtras) | null;
    this.vfx = deps.vfx ?? null;
    this.stepNav = deps.stepNav ?? true;
    this._capacity = Math.max(1, Math.floor(deps.capacity ?? ENEMY_AI.capacity));
    this.rng = new Rng(deps.seed ?? 'enemies');
    if (deps.projectiles) {
      this.projectiles = deps.projectiles;
      this.ownsProjectiles = false;
    } else {
      this.projectiles = new ProjectileSystem({
        events: deps.events,
        combat: deps.combat,
        target: deps.target,
        vfx: deps.vfx ?? null,
        scene: deps.scene ?? null,
      });
      this.ownsProjectiles = true;
    }

    this.threat = new ThreatTable(ENEMY_AI.aggro);
    for (let i = 0; i < this.threat.maxTargets; i++) {
      this.coordinators.push(new AttackSlotCoordinator(ENEMY_AI.slots, this._capacity));
      this.surrounds.push(new SurroundSlots(ENEMY_AI.surround));
    }
    this.facing = new Float64Array(this.threat.maxTargets);
    this.lastVolley = new Float64Array(this.threat.maxTargets).fill(Number.NEGATIVE_INFINITY);
    this.primarySlot = this.threat.register(deps.target, ENEMY_AI.aggro.playerBias);

    const byType: Record<string, number> = {};
    for (const id of Object.keys(ENEMIES)) byType[id] = 0;
    this.stats = { alive: 0, byType, aiMs: 0, aiMsAvg: 0, records: 0, losRays: 0 };

    this.unsubscribe.push(
      this.events.on('weapon:fired', (e) => {
        this.threat.makeNoise(e.origin, this._time, this.primarySlot);
        this.shotDir.set(e.direction.x, e.direction.y, e.direction.z);
        this.shotTime = this._time;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // EnemyManagerApi
  // -------------------------------------------------------------------------

  get time(): number {
    return this._time;
  }

  get alive(): number {
    return this.aliveCount;
  }

  get capacity(): number {
    return this._capacity;
  }

  /** Living and dying enemies (read-only). */
  get enemies(): readonly Enemy[] {
    return this.active;
  }

  /**
   * The living or dying enemy with Damageable id `id` (combat:damage targetId → type / points /
   * audio lookups), or null.
   */
  getEnemy(id: number): Enemy | null {
    const list = this.active;
    for (let i = 0; i < list.length; i++)
      if (list[i]!.id === id && list[i]!.state !== 'free') return list[i]!;
    return null;
  }

  /** Spawn points for relocating leashed enemies (the wave director passes the map's). */
  setSpawnPoints(points: readonly SpawnPointDef[] | null | undefined): void {
    this.spawnPoints = points ?? [];
  }

  /** Extra aggro targets (decoys / turrets, M4+): a big bias pulls aggro. */
  registerTarget(target: EnemyTargetApi, bias: number): number {
    return this.threat.register(target, bias);
  }

  unregisterTarget(target: EnemyTargetApi): void {
    if (target === this.primary) return;
    const slot = this.threat.slotOf(target);
    this.threat.unregister(target);
    if (slot < 0) return;
    for (const e of this.active) {
      if (e.targetSlot === slot) this.switchTarget(e, this.primarySlot);
    }
  }

  /** Allocate `count` pooled records of `type` up front (no allocation when a wave starts). */
  prewarm(type: string, count: number): void {
    const rt = this.runtime(type);
    if (!rt) return;
    const tmp: Enemy[] = [];
    for (let i = 0; i < count; i++) {
      const e = rt.pool.acquire();
      if (!e) break;
      tmp.push(e);
    }
    for (const e of tmp) rt.pool.release(e);
  }

  spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null {
    if (this.disposed) return null;
    const rt = this.runtime(type);
    if (!rt) return null;
    if (this.aliveCount >= this._capacity) return null;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z))
      return null;
    const def = rt.def;
    const handle = this.visuals.acquire(type);
    if (handle < 0) {
      this.warnOnce(
        `visuals:${type}`,
        `No enemy visual slot for "${type}" (unknown type or capacity) – spawn skipped`,
      );
      return null;
    }
    if (!this.nav.closestPoint(position, _v)) _v.set(position.x, position.y, position.z);
    const speedMult = finiteOr(opts?.speedMultiplier, 1);
    const params = rt.navParams;
    params.maxSpeed = def.movement.runSpeed * speedMult;
    const agent = this.nav.addAgent(_v, params);
    if (agent < 0) {
      this.visuals.release(type, handle);
      this.warnOnce(
        `agent:${type}`,
        `Nav agent for "${type}" failed (crowd full / off mesh) – spawn skipped`,
      );
      return null;
    }
    const e = rt.pool.acquire();
    if (!e) {
      this.nav.removeAgent(agent);
      this.visuals.release(type, handle);
      return null;
    }
    this.initEnemy(e, rt, handle, agent, _v, speedMult, opts);
    this.active.push(e);
    this.aliveCount++;
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    this.stats.alive = this.aliveCount;

    this.syncVisual(e);
    this.combat.register(e);
    this.ensureBody(e);
    this.setBlocker(e, true);

    const p = this.spawnedPayload;
    p.id = e.id;
    p.type = type;
    copyVec(e.position, p.position);
    p.elite = e.elite;
    this.events.emit('enemy:spawned', p);
    if (rt.spawnEffect) this.vfx?.spawn(rt.spawnEffect, e.position, UP, rt.spawnScale * e.pose.scale);
    return e.id;
  }

  clear(): void {
    for (let i = 0; i < this.active.length; i++) this.releaseEnemy(this.active[i]!);
    this.compact();
    this.aliveCount = 0;
    for (const k of Object.keys(this.stats.byType)) this.stats.byType[k] = 0;
    this.stats.alive = 0;
    for (const c of this.coordinators) c.reset();
    for (const s of this.surrounds) s.reset();
    this.lastVolley.fill(Number.NEGATIVE_INFINITY);
    this.projectiles?.clear();
  }

  killAll(credit: boolean): number {
    let n = 0;
    // A nuke must not splash the player with every spitter's acid sac.
    this.suppressBursts = true;
    for (const e of this.active) {
      if (!e.alive) continue;
      e.lastWeaponId = ENEMY_AI.nukeWeaponId;
      e.lastZone = null;
      e.lastSource = credit ? 'player' : 'environment';
      e.health = 0;
      e.alive = false;
      e.deathPending = true;
      this.noteKilled(e);
      n++;
    }
    this.processDeaths();
    this.suppressBursts = false;
    return n;
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    const t0 = performance.now();
    this._time += dt;
    const B = ENEMY_AI.budget;
    this.losLeft = B.losPerTick;
    this.urgentLosLeft = B.urgentLosPerTick;
    this.pathsLeft = B.pathsPerTick;
    this.spotRaysLeft = B.spotRaysPerTick;
    this.stats.losRays = 0;
    for (let i = 0; i < this.coordinators.length; i++) this.coordinators[i]!.update(this._time);

    this.processDeaths();
    this.updateFacing();
    if (this.aiEnabled) this.perceive(dt);
    for (let i = 0; i < this.active.length; i++) this.think(this.active[i]!, dt);
    this.pushMoves();
    if (this.stepNav) this.nav.update(dt);
    for (let i = 0; i < this.active.length; i++) this.integrate(this.active[i]!, dt);
    this.visuals.commitTick();
    if (this.ownsProjectiles) this.projectiles?.fixedUpdate(dt);
    this.compact();

    const ms = performance.now() - t0;
    this.stats.aiMs = ms;
    this.stats.aiMsAvg += (ms - this.stats.aiMsAvg) * ENEMY_AI.statsSmoothing;
    this.stats.records = this.active.length;
  }

  update(dt: number, alpha: number): void {
    if (this.disposed) return;
    this.visuals.update(dt, alpha);
    if (this.ownsProjectiles) this.projectiles?.update(dt, alpha);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    const ph = this.physics;
    for (const rt of this.types.values()) {
      for (const e of rt.records) this.removeBody(e, ph);
      rt.records.length = 0;
    }
    this.types.clear();
    if (this.ownsProjectiles) this.projectiles?.dispose();
    this.threat.clear();
    this.disposed = true;
  }

  // -------------------------------------------------------------------------
  // EnemyOwner (called inside CombatWorld.dealDamage – record only)
  // -------------------------------------------------------------------------

  onEnemyDamaged(e: Enemy, info: Readonly<DamageInfo>, applied: number, killed: boolean): void {
    if (applied > 0) {
      e.aware = true;
      e.damagedSinceAlert = true;
      if (info.source === 'player' && this.primarySlot >= 0) {
        this.threat.addDamageThreat(e.threat, this.primarySlot, applied);
        e.lastKnown.copy(this.primary.position);
        e.lastKnownTime = this._time;
      }
    }
    if (killed) this.noteKilled(e);
  }

  // -------------------------------------------------------------------------
  // AiHost
  // -------------------------------------------------------------------------

  target(e: Enemy): EnemyTargetApi | null {
    const t = this.threat.get(e.targetSlot);
    return t && t.alive ? t : null;
  }

  targetFacing(slot: number): number {
    return this.facing[slot] ?? 0;
  }

  coordinator(slot: number): AttackSlotCoordinator {
    return this.coordinators[slot] ?? this.coordinators[0]!;
  }

  surround(slot: number): SurroundSlots {
    return this.surrounds[slot] ?? this.surrounds[0]!;
  }

  canVolley(slot: number): boolean {
    return this._time - (this.lastVolley[slot] ?? Number.NEGATIVE_INFINITY) >= ENEMY_AI.volley.minSpacing;
  }

  takePaths(n: number): boolean {
    if (this.pathsLeft < n) return false;
    this.pathsLeft -= n;
    return true;
  }

  takeSpotRays(n: number): boolean {
    if (this.spotRaysLeft < n) return false;
    this.spotRaysLeft -= n;
    return true;
  }

  refreshLos(e: Enemy, maxAge: number): boolean {
    if (this._time - e.losTime <= maxAge) return e.canSee;
    if (this.urgentLosLeft > 0) {
      this.urgentLosLeft--;
      this.checkLos(e);
    }
    return e.canSee;
  }

  moveTo(e: Enemy, point: Vector3, speed: number): void {
    e.moveTarget.copy(point);
    e.hasMove = true;
    e.moveSpeed = speed * e.speedMult;
  }

  stopMoving(e: Enemy): void {
    e.hasMove = false;
  }

  beginAttack(e: Enemy, index: number): void {
    const a = e.def.attacks[index];
    const rt = this.types.get(e.type);
    if (!a || !rt) return;
    e.state = 'attack';
    e.stateTime = 0;
    e.attackIndex = index;
    e.phase = 0;
    e.phaseTime = 0;
    e.attackHit = false;
    e.attackReady[index] = this._time + a.cooldown;
    if (a.usesSlot) this.coordinator(e.targetSlot).noteAttack(e.id, this._time);
    if (a.kind === 'projectile' && e.targetSlot < this.lastVolley.length)
      this.lastVolley[e.targetSlot] = this._time;
    e.hasMove = false;
    e.pose.attackId = rt.animIndex[index]!;
    e.pose.attack = 0;
    const p = this.attackPayload;
    p.id = e.id;
    p.type = e.type;
    p.attack = a.id;
    copyVec(e.position, p.position);
    p.windup = a.windup;
    this.events.emit('enemy:attack', p);
  }

  hitTarget(e: Enemy, _attack: EnemyAttackDef, target: EnemyTargetApi, amount: number, shake: number): void {
    const dmg = amount * e.damageMult;
    if (!(dmg > 0)) return;
    const ey = e.position.y + e.def.perception.eyeHeight * e.pose.scale;
    const dx = e.position.x - target.eyePosition.x;
    const dy = ey - target.eyePosition.y;
    const dz = e.position.z - target.eyePosition.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      _dir.x = dx / len;
      _dir.y = dy / len;
      _dir.z = dz / len;
    } else {
      _dir.x = 0;
      _dir.y = 0;
      _dir.z = -1;
    }
    target.damage(dmg, _dir);
    if (shake > 0) this.shake(shake);
  }

  shake(trauma: number): void {
    if (!(trauma > 0)) return;
    this.shakePayload.trauma = Math.min(1, trauma);
    this.events.emit('camera:shake', this.shakePayload);
  }

  socket(e: Enemy, name: string, out: Vector3): boolean {
    if (e.handle < 0) return false;
    out.set(Number.NaN, Number.NaN, Number.NaN);
    this.visuals.computeSocket(e.type, e.handle, name, out);
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  }

  staggerSelf(e: Enemy, duration: number): void {
    this.enterStagger(e, duration);
  }

  endOverride(e: Enemy): void {
    if (e.override === 'none') return;
    e.override = 'none';
    e.agentDirty = e.agent >= 0;
    e.sentValid = false;
  }

  // -------------------------------------------------------------------------
  // Tick stages
  // -------------------------------------------------------------------------

  private processDeaths(): void {
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]!;
      if (e.deathPending) this.die(e);
    }
  }

  /** Where each aggro target looks (flanking): its yaw, else its last shot, else its movement. */
  private updateFacing(): void {
    const A = ENEMY_AI.aggro;
    for (let s = 0; s < this.threat.maxTargets; s++) {
      const t = this.threat.get(s);
      if (!t) continue;
      const yaw = t.yaw;
      if (typeof yaw === 'number' && Number.isFinite(yaw)) {
        // PlayerApi yaw: 0 looks down −Z, forward = (−sin yaw, −cos yaw).
        this.facing[s] = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
      } else if (s === this.primarySlot && this._time - this.shotTime <= A.facingShotMemory) {
        this.facing[s] = Math.atan2(this.shotDir.z, this.shotDir.x);
      } else if (Math.hypot(t.velocity.x, t.velocity.z) > A.facingMinSpeed) {
        this.facing[s] = Math.atan2(t.velocity.z, t.velocity.x);
      }
    }
  }

  private perceive(dt: number): void {
    const P = ENEMY_AI.perception;
    const noise = this.threat.noise;
    const list = this.active;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!e.alive) continue;
      this.threat.decay(e.threat, dt);
      const slot = this.threat.select(e.threat, e.position);
      if (slot >= 0 && slot !== e.targetSlot) this.switchTarget(e, slot);
      const target = this.threat.get(e.targetSlot);
      if (!target || !target.alive) {
        e.canSee = false;
        continue;
      }
      let heard = false;
      if (noise.time > e.heardTime) {
        e.heardTime = noise.time;
        const r = e.def.perception.hearingRadius;
        const dx = noise.x - e.position.x;
        const dz = noise.z - e.position.z;
        if (dx * dx + dz * dz <= r * r) {
          heard = true;
          e.aware = true;
          e.lastKnown.set(noise.x, noise.y, noise.z);
          e.lastKnownTime = this._time;
        }
      }
      if (e.aware && this._time >= e.nextSenseTime) {
        e.nextSenseTime = this._time + P.hordeSenseInterval;
        e.lastKnown.copy(target.position);
        e.lastKnownTime = this._time;
      }
      if (
        e.aware &&
        !e.alerted &&
        e.state !== 'emerge' &&
        (e.canSee || heard || e.damagedSinceAlert || distXZ(e.position, target.position) <= P.alertDistance)
      ) {
        this.alert(e);
      }
    }
    // Round-robin line of sight.
    const n = list.length;
    let scanned = 0;
    while (this.losLeft > 0 && scanned < n) {
      const e = list[this.losCursor % n]!;
      this.losCursor = (this.losCursor + 1) % Math.max(1, n);
      scanned++;
      if (!e.alive || e.state === 'emerge') continue;
      if (this.checkLos(e)) this.losLeft--;
    }
  }

  /** Update e.canSee; returns true when a ray was cast. */
  private checkLos(e: Enemy): boolean {
    const target = this.target(e);
    e.losTime = this._time;
    if (!target) {
      e.canSee = false;
      return false;
    }
    const per = e.def.perception;
    const d = distXZ(e.position, target.position);
    if (
      d > per.sightRange ||
      (!e.aware && !inFov(e.position, e.yaw, target.position, per.fovDeg * DEG2RAD))
    ) {
      e.canSee = false;
      return false;
    }
    if (this.socket(e, per.eyeSocket, _eye)) {
      // The socket as it will be when the enemy faces the target (it turns to shoot): a mouth that
      // pokes past a wall edge only because of the current facing must not count as sight.
      const turn = wrapPi(yawTo(target.position.x - e.position.x, target.position.z - e.position.z) - e.yaw);
      const ox = _eye.x - e.position.x;
      const oz = _eye.z - e.position.z;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      _eye.x = e.position.x + ox * c + oz * s;
      _eye.z = e.position.z - ox * s + oz * c;
    } else {
      _eye.copy(e.position);
      _eye.y += per.eyeHeight * e.pose.scale;
    }
    e.canSee = this.combat.lineOfSight(_eye, target.eyePosition);
    this.stats.losRays++;
    if (e.canSee) {
      e.lastSeenTime = this._time;
      e.lastKnown.copy(target.position);
      e.lastKnownTime = this._time;
      e.aware = true;
    }
    return true;
  }

  private alert(e: Enemy): void {
    e.alerted = true;
    e.damagedSinceAlert = false;
    // Audio spam guard: only one roar per `alertSpacing`; the others alert silently.
    if (this._time < this.nextAlertTime) return;
    this.nextAlertTime = this._time + ENEMY_AI.perception.alertSpacing;
    const p = this.alertPayload;
    p.id = e.id;
    p.type = e.type;
    copyVec(e.position, p.position);
    this.events.emit('enemy:alert', p);
  }

  private switchTarget(e: Enemy, slot: number): void {
    const rt = this.types.get(e.type);
    rt?.brain.release(e, this);
    this.coordinator(e.targetSlot).cancel(e.id);
    e.targetSlot = slot;
    rt?.brain.resume(e, this);
  }

  private think(e: Enemy, dt: number): void {
    const rt = this.types.get(e.type);
    if (!rt) return;
    e.stateTime += dt;
    const PP = ENEMY_AI.pose;
    e.pose.hitFlash = Math.max(0, e.pose.hitFlash - PP.hitFlashDecay * dt);
    e.flinch = Math.max(0, e.flinch - PP.flinchDecay * dt);
    e.staggerAccum = Math.max(0, e.staggerAccum - e.def.stagger.decayPerSecond * dt);
    e.faceTarget = false;

    switch (e.state) {
      case 'emerge': {
        e.pose.emerge = e.def.emergeTime > 0 ? Math.min(1, e.stateTime / e.def.emergeTime) : 1;
        if (e.pose.emerge >= 1) this.setActive(e, rt);
        return;
      }
      case 'active':
      case 'attack': {
        const S = e.def.stagger;
        if (
          e.staggerAccum >= S.threshold &&
          this._time >= e.staggerImmuneUntil &&
          !(e.state === 'attack' && e.phase === PHASE_STRIKE)
        ) {
          this.enterStagger(e, S.duration);
          return;
        }
        const target = this.target(e);
        if (e.state === 'attack') {
          if (updateAttack(e, this, target, dt)) {
            if (e.state === 'attack') this.setActive(e, rt);
          } else if (e.state === 'attack') {
            const a = e.def.attacks[e.attackIndex]!;
            const i = e.attackIndex;
            e.pose.attack = attackAnimProgress(
              e.phase,
              e.phaseTime,
              phaseDuration(a, e.phase),
              rt.animWindup[i]!,
              rt.animStrike[i]!,
            );
          }
          return;
        }
        e.hasMove = false;
        if (target && this.aiEnabled) rt.brain.think(e, this, target, dt);
        return;
      }
      case 'stagger': {
        if (e.stateTime >= e.staggerDuration) {
          e.staggerImmuneUntil = this._time + e.def.stagger.immunity;
          this.setActive(e, rt);
        }
        return;
      }
      case 'dying': {
        const D = e.def.death;
        e.pose.death = D.collapse > 0 ? Math.min(1, e.stateTime / D.collapse) : 1;
        if (e.stateTime >= D.collapse + D.linger) {
          e.state = 'dissolve';
          e.stateTime = 0;
        }
        return;
      }
      case 'dissolve': {
        const D = e.def.death;
        e.pose.dissolve = D.dissolve > 0 ? Math.min(1, e.stateTime / D.dissolve) : 1;
        if (e.pose.dissolve >= 1) this.releaseEnemy(e);
        return;
      }
      case 'free':
        return;
    }
  }

  private setActive(e: Enemy, rt: TypeRuntime): void {
    e.state = 'active';
    e.stateTime = 0;
    e.attackIndex = -1;
    e.pose.attackId = -1;
    e.pose.attack = 0;
    e.pose.emerge = 1;
    resetStuck(e.stuck, e.position.x, e.position.z, this._time, ENEMY_AI.stuck);
    rt.brain.resume(e, this);
  }

  private enterStagger(e: Enemy, duration: number): void {
    if (e.state === 'attack') cancelAttack(e, this);
    this.coordinator(e.targetSlot).release(e.id, this._time);
    e.state = 'stagger';
    e.stateTime = 0;
    e.staggerDuration = duration;
    e.staggerAccum = 0;
    e.hasMove = false;
    const p = this.staggerPayload;
    p.id = e.id;
    p.type = e.type;
    copyVec(e.position, p.position);
    this.events.emit('enemy:staggered', p);
  }

  /** Movement requests → nav crowd (deduped; agents of overridden enemies stay parked). */
  private pushMoves(): void {
    const nav = this.nav;
    const r2 = ENEMY_AI.movement.retargetDistance ** 2;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]!;
      if (e.agent < 0 || e.override !== 'none') continue;
      if (e.agentDirty) {
        nav.teleportAgent(e.agent, e.position);
        e.agentDirty = false;
        e.sentValid = false;
      }
      if (e.hasMove && e.state === 'active') {
        if (e.moveSpeed !== e.sentSpeed) {
          nav.setAgentMaxSpeed(e.agent, e.moveSpeed);
          e.sentSpeed = e.moveSpeed;
        }
        if (!e.sentValid || e.agentStopped || e.sentTarget.distanceToSquared(e.moveTarget) > r2) {
          nav.setAgentTarget(e.agent, e.moveTarget);
          e.sentTarget.copy(e.moveTarget);
          e.sentValid = true;
        }
        e.agentStopped = false;
      } else if (!e.agentStopped) {
        nav.stopAgent(e.agent);
        e.agentStopped = true;
        e.sentValid = false;
      }
    }
  }

  private integrate(e: Enemy, dt: number): void {
    if (e.state === 'free') return;
    _prev.copy(e.position);
    const K = ENEMY_AI.knockback;
    const hasKnock = e.knock.x * e.knock.x + e.knock.z * e.knock.z >= K.minSpeed * K.minSpeed;
    if (hasKnock && e.override === 'none') {
      e.override = 'knockback';
      if (e.agent >= 0 && !e.agentStopped) {
        this.nav.stopAgent(e.agent);
        e.agentStopped = true;
        e.sentValid = false;
      }
    } else if (
      (!hasKnock && e.override !== 'knockback') ||
      e.override === 'leap' ||
      e.override === 'charge'
    ) {
      // Attack movement ignores knockback.
      e.knock.set(0, 0, 0);
    }

    switch (e.override) {
      case 'none':
        if (e.agent >= 0) {
          this.nav.getAgentPosition(e.agent, e.position);
          this.nav.getAgentVelocity(e.agent, e.velocity);
        }
        break;
      case 'leap':
      case 'charge':
        e.velocity.subVectors(e.position, _prev).multiplyScalar(1 / dt);
        break;
      case 'knockback': {
        _v.copy(e.position).addScaledVector(e.knock, dt);
        if (this.nav.walkable(e.position, _v)) {
          if (this.nav.closestPoint(_v, _w)) _v.y = _w.y;
          e.position.copy(_v);
        } else {
          e.knock.set(0, 0, 0);
        }
        e.velocity.copy(e.knock);
        e.knock.multiplyScalar(Math.exp(-K.friction * dt));
        if (e.knock.x * e.knock.x + e.knock.z * e.knock.z < K.minSpeed * K.minSpeed) {
          e.knock.set(0, 0, 0);
          this.endOverride(e);
        }
        break;
      }
    }

    const target = this.target(e);
    if (e.alive && target) {
      this.pushOutOfPlayer(e, target);
      if (e.state === 'active' && e.override === 'none' && e.agent >= 0) {
        this.checkStuck(e);
        this.checkLeash(e, target);
      }
    }
    this.updateFacingOf(e, target, dt);
    this.updatePose(e, target, dt);
    this.syncVisual(e);
    this.syncBlocker(e);
  }

  private pushOutOfPlayer(e: Enemy, target: EnemyTargetApi): void {
    const t = target.position;
    if (Math.abs(e.position.y - t.y) > e.def.nav.height) return;
    const dx = e.position.x - t.x;
    const dz = e.position.z - t.z;
    const minD = e.def.nav.radius * e.pose.scale + ENEMY_AI.player.radius + ENEMY_AI.movement.playerGap;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) return;
    const d = Math.sqrt(d2);
    if (d < 1e-4) {
      e.position.x = t.x - Math.sin(e.yaw) * minD;
      e.position.z = t.z - Math.cos(e.yaw) * minD;
    } else {
      e.position.x = t.x + (dx / d) * minD;
      e.position.z = t.z + (dz / d) * minD;
    }
  }

  private checkStuck(e: Enemy): void {
    const S = ENEMY_AI.stuck;
    const wants = e.hasMove && distXZ(e.position, e.moveTarget) > S.goalSlack;
    const checkedBefore = e.stuck.next;
    const act = updateStuck(e.stuck, e.position.x, e.position.z, this._time, wants, S);
    if (act === STUCK_NONE && e.stuck.next !== checkedBefore && e.stuck.fails === 0) e.stuckTeleports = 0;
    if (act === STUCK_TELEPORT && ++e.stuckTeleports >= S.relocateAfter) {
      // Teleporting around did not help (unreachable pocket): re-emerge near the target.
      e.stuckTeleports = 0;
      const target = this.target(e);
      if (target) this.relocate(e, target);
      return;
    }
    if (act === STUCK_REPATH) {
      this.nav.stopAgent(e.agent);
      e.agentStopped = true;
      e.sentValid = false;
      e.mode = 0;
      e.slotEvalAt = 0;
    } else if (act === STUCK_TELEPORT) {
      let ok = this.nav.closestPoint(e.position, _v) && _v.distanceTo(e.position) > S.offMeshDistance;
      if (!ok) ok = this.nav.randomPointAround(e.position, S.teleportRadius, _v);
      if (ok) {
        e.position.copy(_v);
        this.nav.teleportAgent(e.agent, _v);
        e.sentValid = false;
        e.mode = 0;
        e.slotEvalAt = 0;
      }
    }
  }

  private checkLeash(e: Enemy, target: EnemyTargetApi): void {
    const L = ENEMY_AI.leash;
    if (this._time < e.leashCheckAt) return;
    e.leashCheckAt = this._time + L.checkInterval;
    if (distXZ(e.position, target.position) > L.maxDistance) e.leashTime += L.checkInterval;
    else e.leashTime = 0;
    if (e.leashTime >= L.time) this.relocate(e, target);
  }

  /** Too far for too long: re-emerge at the spawn point nearest to the target (not too close). */
  private relocate(e: Enemy, target: EnemyTargetApi): void {
    const L = ENEMY_AI.leash;
    e.leashTime = 0;
    let best: SpawnPointDef | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const sp of this.spawnPoints) {
      const d = distXZ(sp.position, target.position);
      if (d >= L.minRelocateDistance && d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    const ok = best
      ? this.nav.closestPoint(best.position, _v)
      : this.nav.randomPointAround(target.position, L.fallbackRadius, _v);
    if (!ok || distXZ(_v, target.position) < L.minRelocateDistance * L.fallbackMinFraction) return;
    const rt = this.types.get(e.type);
    rt?.brain.release(e, this);
    this.coordinator(e.targetSlot).cancel(e.id);
    e.position.copy(_v);
    this.nav.teleportAgent(e.agent, _v);
    e.sentValid = false;
    e.hasMove = false;
    e.state = 'emerge';
    e.stateTime = 0;
    e.pose.emerge = 0;
    e.yaw = yawTo(target.position.x - _v.x, target.position.z - _v.z);
    if (rt?.spawnEffect) this.vfx?.spawn(rt.spawnEffect, _v, UP, rt.spawnScale * e.pose.scale);
  }

  private updateFacingOf(e: Enemy, target: EnemyTargetApi | null, dt: number): void {
    if (e.state !== 'active' || e.override !== 'none') return;
    const M = ENEMY_AI.movement;
    const speed = Math.hypot(e.velocity.x, e.velocity.z);
    let want = e.yaw;
    if (
      target &&
      (e.faceTarget || speed < M.faceMoveSpeed || distXZ(e.position, target.position) < M.faceTargetDistance)
    ) {
      want = yawTo(target.position.x - e.position.x, target.position.z - e.position.z);
    } else if (speed >= M.faceMoveSpeed) {
      want = yawTo(e.velocity.x, e.velocity.z);
    }
    e.yaw = turnTowards(e.yaw, want, e.def.movement.turnRateDeg * DEG2RAD * dt);
  }

  private updatePose(e: Enemy, target: EnemyTargetApi | null, dt: number): void {
    const pose = e.pose;
    const mv = e.def.movement;
    const moved = Math.hypot(e.position.x - _prev.x, e.position.z - _prev.z);
    if (e.override === 'leap' || e.override === 'charge') pose.locomotion = 2;
    else if (e.state === 'dying' || e.state === 'dissolve' || e.state === 'emerge') pose.locomotion = 0;
    else {
      const speed = dt > 0 ? moved / dt : 0;
      pose.locomotion = locomotionBlend(speed, mv.walkSpeed * e.speedMult, mv.runSpeed * e.speedMult);
    }
    const stride = mv.stride * pose.scale;
    if (stride > 0) pose.phase = (pose.phase + (moved / stride) * TAU) % TAU;

    if (e.state === 'stagger') {
      const f = e.staggerDuration > 0 ? e.stateTime / e.staggerDuration : 1;
      const ramp = ENEMY_AI.pose.staggerRampIn;
      pose.stagger = f < ramp ? f / ramp : Math.max(0, 1 - (f - ramp) / (1 - ramp));
      pose.stagger = Math.max(pose.stagger, e.flinch);
    } else {
      pose.stagger = e.alive ? e.flinch : 0;
    }

    if (target && e.alive && e.state !== 'emerge') {
      const want = yawTo(target.eyePosition.x - e.position.x, target.eyePosition.z - e.position.z);
      pose.lookYaw = wrapPi(want - e.yaw);
      const headY = e.position.y + e.def.perception.eyeHeight * pose.scale;
      pose.lookPitch = Math.atan2(
        target.eyePosition.y - headY,
        Math.max(1e-3, distXZ(e.position, target.eyePosition)),
      );
    } else {
      pose.lookYaw = 0;
      pose.lookPitch = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle helpers
  // -------------------------------------------------------------------------

  private initEnemy(
    e: Enemy,
    rt: TypeRuntime,
    handle: number,
    agent: number,
    position: Vector3,
    speedMult: number,
    opts: EnemySpawnOptions | undefined,
  ): void {
    const def = rt.def;
    const E = ENEMY_AI.elite;
    const now = this._time;
    e.id = this.allocId();
    e.serial = this.serial++;
    e.handle = handle;
    e.agent = agent;
    e.elite = (opts?.affixes?.length ?? 0) > 0;
    e.speedMult = speedMult;
    e.damageMult = finiteOr(opts?.damageMultiplier, 1) * (e.elite ? E.damageMultiplier : 1);
    e.maxHealth = def.health * finiteOr(opts?.healthMultiplier, 1) * (e.elite ? E.healthMultiplier : 1);
    e.health = e.maxHealth;
    e.alive = true;
    e.state = def.emergeTime > 0 ? 'emerge' : 'active';
    e.stateTime = 0;
    e.position.copy(position);
    e.velocity.set(0, 0, 0);
    const t = this.primary;
    e.yaw = opts?.spawnPoint
      ? opts.spawnPoint.yaw
      : yawTo(t.position.x - position.x, t.position.z - position.z);

    const pose = e.pose;
    pose.locomotion = 0;
    pose.phase = this.rng.next() * TAU;
    pose.attackId = -1;
    pose.attack = 0;
    pose.stagger = 0;
    pose.death = 0;
    pose.dissolve = 0;
    pose.emerge = def.emergeTime > 0 ? 0 : 1;
    pose.hitFlash = 0;
    pose.lookYaw = 0;
    pose.lookPitch = 0;
    pose.rim = e.elite ? E.rim : 0;
    pose.scale = e.elite ? E.scale : 1;

    e.aware = ENEMY_AI.perception.awareOnSpawn;
    e.alerted = false;
    e.canSee = false;
    e.losTime = Number.NEGATIVE_INFINITY;
    e.lastSeenTime = Number.NEGATIVE_INFINITY;
    e.lastKnown.copy(t.position);
    e.lastKnownTime = now;
    e.heardTime = this.threat.noise.time;
    e.nextSenseTime = now + this.rng.next() * ENEMY_AI.perception.hordeSenseInterval;
    e.threat.fill(0);
    e.targetSlot = this.primarySlot >= 0 ? this.primarySlot : 0;
    e.damagedSinceAlert = false;

    e.hasMove = false;
    e.moveSpeed = 0;
    e.sentValid = false;
    e.sentSpeed = -1;
    e.agentStopped = true;
    e.override = 'none';
    e.overrideTime = 0;
    e.overrideDist = 0;
    e.knock.set(0, 0, 0);
    e.agentDirty = false;
    e.faceTarget = false;

    e.attackIndex = -1;
    e.phase = 0;
    e.phaseTime = 0;
    e.attackHit = false;
    // Stagger the first attacks of a wave (no synchronized volley after emerging).
    for (let i = 0; i < def.attacks.length; i++) {
      e.attackReady[i] = now + this.rng.next() * def.attacks[i]!.cooldown * ENEMY_AI.firstAttackJitter;
    }

    e.staggerAccum = 0;
    e.staggerImmuneUntil = 0;
    e.staggerDuration = 0;
    e.flinch = 0;

    e.mode = 0;
    e.modeTime = now;
    e.slot = -1;
    e.slotEvalAt = 0;
    e.orbitPhase = this.rng.next() * TAU;
    e.spotValid = false;
    e.spotBest = Number.NEGATIVE_INFINITY;
    e.searchIndex = 0;
    e.strafeSign = this.rng.chance(0.5) ? 1 : -1;
    e.nextActionTime = now;
    e.laneClear = false;
    e.laneCheckAt = 0;

    resetStuck(e.stuck, position.x, position.z, now, ENEMY_AI.stuck);
    e.stuckTeleports = 0;
    e.leashTime = 0;
    e.leashCheckAt = now + this.rng.next() * ENEMY_AI.leash.checkInterval;

    e.deathPending = false;
    e.lastWeaponId = null;
    e.lastZone = null;
    e.lastSource = 'environment';
    e.lastElement = 'physical';
  }

  private noteKilled(e: Enemy): void {
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    const n = this.stats.byType[e.type] ?? 0;
    this.stats.byType[e.type] = Math.max(0, n - 1);
    this.stats.alive = this.aliveCount;
  }

  /** Death side effects (enemy:died, VFX, sac burst) and freeing nav/combat/tokens. */
  private die(e: Enemy): void {
    e.deathPending = false;
    const rt = this.types.get(e.type);
    if (e.state === 'attack') cancelAttack(e, this);
    if (e.override === 'leap' || e.override === 'charge') e.override = 'none';
    rt?.brain.release(e, this);
    this.coordinator(e.targetSlot).cancel(e.id);
    if (e.agent >= 0) {
      this.nav.removeAgent(e.agent);
      e.agent = -1;
    }
    this.combat.unregister(e);
    this.setBlocker(e, false);
    e.state = 'dying';
    e.stateTime = 0;
    e.hasMove = false;
    e.pose.attackId = -1;
    e.pose.attack = 0;
    e.pose.stagger = 0;
    e.pose.emerge = 1;

    const p = this.diedPayload;
    p.id = e.id;
    p.type = e.type;
    copyVec(e.position, p.position);
    p.weaponId = e.lastWeaponId;
    p.zone = e.lastZone;
    p.elite = e.elite;
    p.source = e.lastSource;
    this.events.emit('enemy:died', p);

    if (rt?.deathEffect && this.vfx) {
      if (!rt.deathSocket || !this.socket(e, rt.deathSocket, _v)) _v.copy(e.boundsCenter);
      this.vfx.spawn(rt.deathEffect, _v, UP, rt.deathScale * e.pose.scale);
    }
    const burst = e.def.death.burst;
    if (burst && !this.suppressBursts) this.burst(e, burst);
  }

  private burst(e: Enemy, b: NonNullable<EnemyTypeDef['death']['burst']>): void {
    if (!this.socket(e, b.socket, _v)) _v.copy(e.boundsCenter);
    const center = _v;
    const radius = b.radius * e.pose.scale;
    // Player (and other aggro targets).
    for (let s = 0; s < this.threat.maxTargets; s++) {
      const t = this.threat.get(s);
      if (!t || !t.alive) continue;
      const d = Math.max(0, distanceToCapsule(center, t.position, t.eyePosition, ENEMY_AI.player.radius));
      const f = aoeFactor(d, b.innerRadius, radius, b.minFactor);
      if (f <= 0) continue;
      const dx = center.x - t.eyePosition.x;
      const dy = center.y - t.eyePosition.y;
      const dz = center.z - t.eyePosition.z;
      const len = Math.max(1e-6, Math.hypot(dx, dy, dz));
      _dir.x = dx / len;
      _dir.y = dy / len;
      _dir.z = dz / len;
      t.damage(b.playerDamage * f * e.damageMult, _dir);
      if (b.shake > 0) this.shake(b.shake * f);
    }
    // Other enemies (chain reactions, credited to whoever killed this one).
    if (b.enemyDamage > 0) {
      const list = this.combat.queryRadius(center, radius, this.queryOut);
      const info = this.burstInfo;
      info.weaponId = e.lastWeaponId ?? e.type;
      info.element = b.element;
      info.source = e.lastSource;
      info.kind = 'explosion';
      info.zone = 'body';
      copyVec(center, info.point);
      for (let i = 0; i < list.length; i++) {
        const t = list[i]!;
        if (t === e || !t.alive || t.team !== 'enemy') continue;
        const d = Math.max(0, t.boundsCenter.distanceTo(center) - t.boundsRadius);
        const f = aoeFactor(d, b.innerRadius, radius, b.minFactor);
        if (f <= 0) continue;
        _w.subVectors(t.boundsCenter, center);
        const len = _w.length();
        if (len > 1e-6) _w.multiplyScalar(1 / len);
        else _w.set(0, 1, 0);
        copyVec(_w, info.direction);
        info.amount = b.enemyDamage * f;
        info.impulse = 0;
        this.combat.dealDamage(t, info);
      }
      list.length = 0;
    }
    if (b.puddle && this.projectiles) this.projectiles.spawnPuddle(b.puddle, e.position, { source: 'enemy' });
  }

  /** Return everything the enemy holds and put the record back into its pool. */
  private releaseEnemy(e: Enemy): void {
    if (e.state === 'free') return;
    const rt = this.types.get(e.type);
    if (e.alive) {
      e.alive = false;
      this.noteKilled(e);
    }
    rt?.brain.release(e, this);
    this.coordinator(e.targetSlot).cancel(e.id);
    if (e.agent >= 0) {
      this.nav.removeAgent(e.agent);
      e.agent = -1;
    }
    this.combat.unregister(e);
    this.setBlocker(e, false);
    if (e.handle >= 0) {
      this.visuals.release(e.type, e.handle);
      e.handle = -1;
    }
    e.state = 'free';
    e.deathPending = false;
    e.override = 'none';
    e.hitboxes.length = 0;
    // The record goes back to its pool in compact(): a spawn from an event handler during this
    // tick must not re-acquire a record that is still in the active list.
  }

  /** Drop freed records from the active list and return them to their pools. */
  private compact(): void {
    const list = this.active;
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const e = list[r]!;
      if (e.state !== 'free') list[w++] = e;
      else this.types.get(e.type)?.pool.release(e);
    }
    list.length = w;
    if (this.losCursor >= w) this.losCursor = 0;
  }

  /** Transform + pose to the renderer; hitboxes / bounds / aim point for combat (living only). */
  private syncVisual(e: Enemy): void {
    if (e.handle < 0) return;
    const v = this.visuals;
    v.setTransform(e.type, e.handle, e.position, e.yaw);
    v.setPose(e.type, e.handle, e.pose);
    if (!e.alive) return;
    const n = v.computeHitboxes(e.type, e.handle, e.hitboxStore);
    const view = e.hitboxes;
    if (view.length !== n || (n > 0 && view[0] !== e.hitboxStore[0])) {
      view.length = 0;
      for (let i = 0; i < n; i++) view.push(e.hitboxStore[i]!);
    }
    e.boundsRadius = v.computeBounds(e.type, e.handle, e.boundsCenter);
    v.computeAimPoint(e.type, e.handle, e.aimPoint);
  }

  // -------------------------------------------------------------------------
  // Player-blocking bodies (kinematic capsules, optional)
  // -------------------------------------------------------------------------

  private ensureBody(e: Enemy): void {
    const ph = this.physics;
    const c = e.def.collider;
    if (!ph || !c || e.body) return;
    try {
      const R = ph.rapier;
      const half = Math.max(0.01, c.height / 2 - c.radius);
      const body = ph.world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased().setTranslation(e.position.x, e.position.y, e.position.z),
      );
      const desc = R.ColliderDesc.capsule(half, c.radius)
        .setTranslation(0, c.height / 2, 0)
        .setCollisionGroups(BLOCKER_GROUPS)
        .setSolverGroups(BLOCKER_GROUPS);
      const data: ColliderData = { kind: 'enemy', surface: 'default', entityId: e.id };
      e.collider = ph.createCollider
        ? ph.createCollider(desc, body, data)
        : ph.world.createCollider(desc, body);
      e.body = body;
    } catch (err) {
      this.warnOnce(`body:${e.type}`, `Enemy blocker body for "${e.type}" failed – no player blocking`, err);
      e.body = null;
      e.collider = null;
    }
  }

  private setBlocker(e: Enemy, on: boolean): void {
    if (!e.collider || e.colliderOn === on) return;
    e.colliderOn = on;
    try {
      e.collider.setEnabled(on);
      if (on && e.body) e.body.setTranslation(e.position, true);
    } catch {
      // A disposed physics world: nothing to block anymore.
    }
  }

  private syncBlocker(e: Enemy): void {
    const body = e.body;
    if (!body || !e.colliderOn) return;
    _kin.x = e.position.x;
    _kin.y = e.position.y;
    _kin.z = e.position.z;
    body.setNextKinematicTranslation(_kin);
  }

  private removeBody(e: Enemy, ph: PhysicsApi | null): void {
    if (e.body && ph) ph.removeBody(e.body);
    e.body = null;
    e.collider = null;
    e.colliderOn = false;
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private runtime(type: string): TypeRuntime | null {
    const cached = this.types.get(type);
    if (cached) return cached;
    const def = getEnemyDef(type);
    if (!def) {
      this.warnOnce(`type:${type}`, `Unknown enemy type "${type}" – spawn skipped`);
      return null;
    }
    const brain = getBrain(def.brain);
    if (!brain) {
      this.warnOnce(`brain:${def.brain}`, `Enemy "${type}": unknown brain "${def.brain}" – spawn skipped`);
      return null;
    }
    const n = def.attacks.length;
    const animIndex = new Int16Array(n);
    const animWindup = new Float32Array(n);
    const animStrike = new Float32Array(n);
    const vdef = getEnemyVisualDef(type);
    for (let i = 0; i < n; i++) {
      const a = def.attacks[i]!;
      const idx = attackAnimIndex(type, a.id);
      animIndex[i] = idx;
      const anim = idx >= 0 ? vdef?.attacks[idx] : undefined;
      const total = a.windup + a.strike + a.recover;
      animWindup[i] = anim ? anim.windup : total > 0 ? a.windup / total : 0;
      animStrike[i] = anim ? anim.strike : total > 0 ? (a.windup + a.strike) / total : 1;
    }
    const records: Enemy[] = [];
    const pool = new Pool<Enemy>({
      create: () => {
        const e = new Enemy(def, this.threat.createRow(), this);
        records.push(e);
        return e;
      },
      maxSize: this._capacity * 2,
    });
    const rt: TypeRuntime = {
      def,
      brain,
      pool,
      navParams: {
        radius: def.nav.radius,
        height: def.nav.height,
        maxSpeed: def.movement.runSpeed,
        maxAcceleration: def.movement.acceleration,
        separationWeight: def.nav.separation,
      },
      animIndex,
      animWindup,
      animStrike,
      spawnEffect: vdef?.effects.spawn ?? null,
      spawnScale: vdef?.effects.spawnScale ?? 1,
      deathEffect: vdef?.effects.death ?? null,
      deathScale: vdef?.effects.deathScale ?? 1,
      deathSocket: vdef?.effects.deathSocket ?? null,
      records,
    };
    this.types.set(type, rt);
    return rt;
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId = id >= ENEMY_AI.maxId ? ENEMY_AI.firstId : id + 1;
    return id;
  }

  private warnOnce(key: string, msg: string, err?: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (err !== undefined) log.warn(msg, err);
    else log.warn(msg);
  }
}

function finiteOr(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
