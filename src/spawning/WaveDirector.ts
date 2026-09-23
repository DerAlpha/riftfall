/**
 * WaveDirector (WaveDirectorApi): classic CoD Zombies-like waves.
 *
 *   idle ─start()→ intermission ─timer→ active ─all spawned + all dead→ intermission → …
 *                                   ↑ skipIntermission()        setWave(n): clear + active(n)
 *   stop() → over (no more spawns; enemies keep their own AI)
 *
 * Per wave a WavePlan (defs/waves.ts via waveFormula.ts) fixes the total, the type counts, the
 * multipliers and the cadence; the spawn order is shuffled with the seeded rng (daily challenge
 * determinism). While active, a burst of 1..n enemies emerges from one rift every `interval`
 * seconds as long as fewer than `maxAlive` live; burst members follow each other `memberGap`
 * apart. Rifts are chosen by spawnPoints.ts: active zones, distance band, out of view (camera
 * frustum + optional line of sight), not the previous one.
 *
 * Fixed tick, O(1) per tick (spawn point scoring only when a burst starts), no allocations.
 * `remaining` = queued + living enemies; wave:progress is emitted when it (or the alive count)
 * changes, at most once per tick. The director freezes while the target is dead.
 */
import { Frustum, Matrix4, Sphere, Vector3, type Camera } from 'three';
import type {
  EnemyManagerApi,
  EnemySpawnOptions,
  EnemyTargetApi,
  SpawnPointDef,
  WaveDirectorApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import type { Rng } from '../core/Rng';
import { getEnemyDef } from '../defs/enemies';
import { SPAWN_POINTS, WAVES, type SpawnPointRules, type WaveModeDef } from '../defs/waves';
import { selectSpawnPoint, type SpawnSelectContext } from './spawnPoints';
import { buildSpawnOrder, createWavePlan, maxOrderLength, planWave, type WavePlan } from './waveFormula';

const log = createLogger('waves');

export type WaveState = WaveDirectorApi['state'];

export interface WaveDirectorDeps {
  events: EventBus<GameEvents>;
  enemies: EnemyManagerApi;
  /** The map's rifts (LevelInstance.spawnPoints). */
  spawnPoints: readonly SpawnPointDef[];
  /** The player: distance band, visibility (eye), freeze while dead. */
  target: EnemyTargetApi;
  /** World camera for the view-frustum check (null: nothing counts as visible). */
  camera: Camera | null;
  /** Seeded gameplay RNG (type order, burst sizes, member offsets, point jitter). */
  rng: Rng;
  /** M4 doors: spawn only in active zones (default: every zone). */
  isZoneActive?: (zone: string) => boolean;
  /** Static line of sight (CombatWorld.lineOfSight) – refines the frustum check. */
  lineOfSight?: (from: Vec3Like, to: Vec3Like) => boolean;
  /** Random reachable point (NavApi.randomPointAround) for maps without usable spawn points. */
  randomPoint?: (center: Vec3Like, radius: number, out: Vector3) => boolean;
  /** Can this enemy type spawn (default: it has an enemy def)? Unknown types are never queued. */
  isKnownType?: (type: string) => boolean;
  mode?: WaveModeDef;
  rules?: SpawnPointRules;
}

/** EnemyManager extra: leash relocation uses the map's spawn points. */
interface SpawnPointSink {
  setSpawnPoints?(points: readonly SpawnPointDef[] | null): void;
}

const TAU = Math.PI * 2;

const _frustum = new Frustum();
const _viewProj = new Matrix4();
const _viewInv = new Matrix4();
const _sphere = new Sphere();
const _pos = new Vector3();

export class WaveDirector implements WaveDirectorApi {
  readonly mode: WaveModeDef;
  readonly rules: SpawnPointRules;

  private readonly events: EventBus<GameEvents>;
  private readonly enemies: EnemyManagerApi;
  private readonly points: readonly SpawnPointDef[];
  private readonly target: EnemyTargetApi;
  private readonly camera: Camera | null;
  private readonly rng: Rng;
  private readonly zoneActive: (zone: string) => boolean;
  private readonly los: ((from: Vec3Like, to: Vec3Like) => boolean) | null;
  private readonly randomPoint: ((center: Vec3Like, radius: number, out: Vector3) => boolean) | null;
  private readonly isKnown: (type: string) => boolean;

  private _state: WaveState = 'idle';
  private _wave = 0;
  private _nextWave = 1;
  /** Intermission: seconds left. Active: seconds until the next burst may start. */
  private timer = 0;
  private waveTime = 0;
  private readonly _plan: WavePlan;
  private readonly order: Uint8Array;
  private readonly scratch: Uint8Array;
  private orderLength = 0;
  private nextIndex = 0;
  private burstLeft = 0;
  private burstMember = 0;
  private memberTimer = 0;
  private burstPoint: SpawnPointDef | null = null;
  private readonly burstCenter = new Vector3();
  private lastPoint = -1;
  private failures = 0;
  private losLeft = 0;
  private lastRemaining = -1;
  private lastAlive = -1;
  private warnedNoPoints = false;
  private readonly selectCtx: SpawnSelectContext & { lastIndex: number };
  private readonly spawnOpts: EnemySpawnOptions = {
    healthMultiplier: 1,
    speedMultiplier: 1,
    damageMultiplier: 1,
    spawnPoint: null,
  };

  private readonly intermissionPayload: GameEvents['wave:intermission'] = { nextWave: 1, duration: 0 };
  private readonly startPayload: GameEvents['wave:start'] = { wave: 0, total: 0, kind: 'normal' };
  private readonly progressPayload: GameEvents['wave:progress'] = { wave: 0, remaining: 0, alive: 0 };
  private readonly completePayload: GameEvents['wave:complete'] = { wave: 0, duration: 0 };

  constructor(deps: WaveDirectorDeps) {
    this.events = deps.events;
    this.enemies = deps.enemies;
    this.points = deps.spawnPoints;
    this.target = deps.target;
    this.camera = deps.camera;
    this.rng = deps.rng;
    this.zoneActive = deps.isZoneActive ?? (() => true);
    this.los = deps.lineOfSight ?? null;
    this.randomPoint = deps.randomPoint ?? null;
    this.isKnown = deps.isKnownType ?? ((type) => getEnemyDef(type) !== undefined);
    this.mode = deps.mode ?? WAVES.classic;
    this.rules = deps.rules ?? SPAWN_POINTS;
    this._plan = createWavePlan(this.mode);
    const len = maxOrderLength(this.mode);
    this.order = new Uint8Array(len);
    this.scratch = new Uint8Array(len);
    const target = deps.target;
    this.selectCtx = {
      // A getter: the target adapter may hand out its live vector through a getter too.
      get target(): Vec3Like {
        return target.position;
      },
      lastIndex: -1,
      isZoneActive: (zone) => this.zoneActive(zone),
      isVisible: (p) => this.isVisible(p),
    };
    (deps.enemies as EnemyManagerApi & SpawnPointSink).setSpawnPoints?.(deps.spawnPoints);
    if (deps.spawnPoints.length === 0) {
      log.warn('Map has no enemy spawn points – enemies emerge at random nav points around the player');
      this.warnedNoPoints = true;
    }
  }

  // -------------------------------------------------------------------------
  // WaveDirectorApi
  // -------------------------------------------------------------------------

  /** Last started wave (0 before the first). */
  get wave(): number {
    return this._wave;
  }

  get state(): WaveState {
    return this._state;
  }

  /** Enemies still to kill this wave (queued + alive); 0 outside a wave. */
  get remaining(): number {
    if (this._state !== 'active') return 0;
    return this.orderLength - this.nextIndex + this.enemies.alive;
  }

  /** Wave the running intermission leads to. */
  get nextWave(): number {
    return this._nextWave;
  }

  /** Seconds left in the intermission (0 otherwise). */
  get intermissionLeft(): number {
    return this._state === 'intermission' ? Math.max(0, this.timer) : 0;
  }

  /** The current wave's plan (read-only view for debug / dev console). */
  get plan(): Readonly<WavePlan> {
    return this._plan;
  }

  /** Queued spawns not yet emerged this wave. */
  get queued(): number {
    return this._state === 'active' ? this.orderLength - this.nextIndex : 0;
  }

  start(wave = 1): void {
    this.resetRun();
    this._nextWave = clampWave(wave);
    this._wave = this._nextWave - 1;
    this.enterIntermission(this.mode.firstIntermission);
  }

  setWave(wave: number): void {
    this.enemies.clear();
    this.resetRun();
    this.beginWave(clampWave(wave));
  }

  skipIntermission(): void {
    if (this._state === 'intermission') this.beginWave(this._nextWave);
  }

  stop(): void {
    this._state = 'over';
    this.burstLeft = 0;
  }

  /** Back to idle (restart / main menu); enemies are not touched. */
  reset(): void {
    this.resetRun();
    this._state = 'idle';
    this._wave = 0;
    this._nextWave = 1;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0) || !this.target.alive) return;
    if (this._state === 'intermission') {
      this.timer -= dt;
      if (this.timer <= 0) this.beginWave(this._nextWave);
      return;
    }
    if (this._state !== 'active') return;
    this.waveTime += dt;
    this.updateSpawning(dt);
    const alive = this.enemies.alive;
    if (this.nextIndex >= this.orderLength && this.burstLeft === 0 && alive === 0) {
      this.completeWave();
      return;
    }
    const remaining = this.orderLength - this.nextIndex + alive;
    if (remaining !== this.lastRemaining || alive !== this.lastAlive) {
      this.lastRemaining = remaining;
      this.lastAlive = alive;
      const p = this.progressPayload;
      p.wave = this._wave;
      p.remaining = remaining;
      p.alive = alive;
      this.events.emit('wave:progress', p);
    }
  }

  dispose(): void {
    this.stop();
    (this.enemies as EnemyManagerApi & SpawnPointSink).setSpawnPoints?.(null);
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  private resetRun(): void {
    this.orderLength = 0;
    this.nextIndex = 0;
    this.burstLeft = 0;
    this.failures = 0;
    this.lastPoint = -1;
    this.lastRemaining = -1;
    this.lastAlive = -1;
    this.waveTime = 0;
  }

  private enterIntermission(duration: number): void {
    this._state = 'intermission';
    this.timer = Math.max(0, duration);
    this.burstLeft = 0;
    const p = this.intermissionPayload;
    p.nextWave = this._nextWave;
    p.duration = this.timer;
    this.events.emit('wave:intermission', p);
  }

  private beginWave(wave: number): void {
    this._wave = wave;
    this._nextWave = wave + 1;
    this._state = 'active';
    this.waveTime = 0;
    const plan = planWave(this.mode, wave, this.enemies.capacity, this._plan, this.isKnown);
    this.orderLength = buildSpawnOrder(plan, this.rng, this.order, this.scratch);
    this.nextIndex = 0;
    this.burstLeft = 0;
    this.failures = 0;
    this.timer = this.mode.startDelay;
    this.lastRemaining = -1;
    this.lastAlive = -1;
    const p = this.startPayload;
    p.wave = wave;
    p.total = this.orderLength;
    p.kind = plan.kind;
    this.events.emit('wave:start', p);
  }

  private completeWave(): void {
    const p = this.completePayload;
    p.wave = this._wave;
    p.duration = this.waveTime;
    this.events.emit('wave:complete', p);
    this.enterIntermission(this.mode.intermission);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private updateSpawning(dt: number): void {
    if (this.nextIndex >= this.orderLength) {
      this.burstLeft = 0;
      return;
    }
    if (this.burstLeft > 0) {
      this.memberTimer -= dt;
      this.spawnDueMembers();
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    const plan = this._plan;
    const room = plan.maxAlive - this.enemies.alive;
    // Full: the timer stays expired, the burst starts as soon as someone dies.
    if (room <= 0) return;
    const size = Math.min(this.rng.int(plan.burstMin, plan.burstMax), room, this.orderLength - this.nextIndex);
    this.chooseBurstOrigin();
    this.burstLeft = size;
    this.burstMember = 0;
    this.memberTimer = 0;
    this.timer = plan.interval;
    this.spawnDueMembers();
  }

  private spawnDueMembers(): void {
    const gap = this.mode.cadence.memberGap;
    while (this.burstLeft > 0 && this.memberTimer <= 0 && this.nextIndex < this.orderLength) {
      if (this.enemies.alive >= this._plan.maxAlive) return;
      if (!this.spawnMember()) {
        // Pool / nav exhausted: end the burst and retry soon.
        this.burstLeft = 0;
        this.timer = Math.min(this.timer, this.mode.cadence.retryDelay);
        return;
      }
      this.memberTimer += gap;
    }
    if (this.nextIndex >= this.orderLength) this.burstLeft = 0;
  }

  /** Spawn the next queued enemy around the burst origin; false when the spawn failed. */
  private spawnMember(): boolean {
    const plan = this._plan;
    const type = plan.typeIds[this.order[this.nextIndex]!]!;
    _pos.copy(this.burstCenter);
    if (this.burstMember > 0) {
      const a = this.rng.next() * TAU;
      const r = this.mode.cadence.spread * Math.sqrt(this.rng.next());
      _pos.x += Math.cos(a) * r;
      _pos.z += Math.sin(a) * r;
    }
    const o = this.spawnOpts;
    o.healthMultiplier = plan.health;
    o.speedMultiplier = plan.speed;
    o.damageMultiplier = plan.damage;
    o.spawnPoint = this.burstPoint;
    const id = this.enemies.spawn(type, _pos, o);
    if (id !== null) {
      this.nextIndex++;
      this.burstLeft--;
      this.burstMember++;
      this.failures = 0;
      return true;
    }
    this.failures++;
    if (this.failures >= this.mode.maxSpawnFailures) {
      log.warn(`Wave ${this._wave}: "${type}" failed to spawn ${this.failures}× – dropped`);
      this.failures = 0;
      this.nextIndex++;
      this.burstLeft = Math.max(0, this.burstLeft - 1);
      return true;
    }
    return false;
  }

  /** Pick the rift of the next burst (or a fallback point around the player). */
  private chooseBurstOrigin(): void {
    if (this.points.length > 0) {
      this.updateFrustum();
      this.losLeft = this.rules.maxLosChecks;
      this.selectCtx.lastIndex = this.lastPoint;
      const idx = selectSpawnPoint(this.points, this.selectCtx, this.rules, this.rng);
      if (idx >= 0) {
        const p = this.points[idx]!;
        this.lastPoint = idx;
        this.burstPoint = p;
        this.burstCenter.copy(p.position);
        return;
      }
      if (!this.warnedNoPoints) {
        this.warnedNoPoints = true;
        log.warn('No spawn point in an active zone – using random nav points around the player');
      }
    }
    this.burstPoint = null;
    const t = this.target.position;
    const radius = this.rules.fallbackRadius;
    if (this.randomPoint?.(t, radius, this.burstCenter)) return;
    const a = this.rng.next() * TAU;
    this.burstCenter.set(t.x + Math.cos(a) * radius, t.y, t.z + Math.sin(a) * radius);
  }

  private updateFrustum(): void {
    const cam = this.camera;
    if (!cam) return;
    _viewInv.copy(cam.matrixWorld).invert();
    _viewProj.multiplyMatrices(cam.projectionMatrix, _viewInv);
    _frustum.setFromProjectionMatrix(_viewProj);
  }

  private isVisible(p: SpawnPointDef): boolean {
    if (!this.camera) return false;
    const R = this.rules;
    _sphere.center.set(p.position.x, p.position.y + R.probeHeight, p.position.z);
    _sphere.radius = R.probeRadius;
    if (!_frustum.intersectsSphere(_sphere)) return false;
    if (!this.los) return true;
    // Out of rays: count as visible (never spawn in view by accident).
    if (this.losLeft <= 0) return true;
    this.losLeft--;
    return this.los(this.target.eyePosition, _sphere.center);
  }
}

function clampWave(wave: number): number {
  return Number.isFinite(wave) ? Math.max(1, Math.floor(wave)) : 1;
}
