/**
 * Power-ups (PowerUpApi, M4): rift-energy drops of killed enemies, collected by walking into them.
 *
 * Drops: `enemy:died` by the player (not nuke kills, not ids flagged with flagNoDrop – dev spawns)
 * rolls the drop rules (dropRules.ts: chance × dropChance stat, per-wave cap, spacing, pity) and
 * picks a weighted type (no repeat; carpenter only with damaged seals). Seeded Rng: the same kills
 * give the same drops (daily challenge). `rollDrop(p, type)` forces one; `dropAmmo` is the Aasgeier
 * perk's small-ammo hook (PerkSystem.setAmmoDropHandler).
 *
 * Pickups: pooled (POWERUPS.capacity; when full the one closest to despawning is replaced, ammo
 * scraps first, and a scrap never replaces a real drop), snapped to the floor,
 * float for `lifetime` s (blinking at the end), collected in fixedUpdate when the player's feet come
 * within the pickup radius; the view (PickupView) draws them.
 *
 * Effects (defs/powerups.ts, by effect kind):
 *   nuke           enemies.killAll(true) (non-boss, credited), flat points ('nuke'), fx.nuke flash
 *   stat           timed StatModifier (source `powerup:<id>`) – Double Points: pointsMultiplier ×2
 *   instakill      timed enemies.instakill
 *   maxAmmo        weapons.refillAmmo
 *   carpenter      seals.repairAll(), armor refill, flat points ('carpenter')
 *   enemyTimeScale timed enemies.timeScale (Slow Motion ×0.4) + fx.timeTint (eased per frame)
 *   ammoScrap      weapons.addReserveFraction (without it no scraps drop: a full reserve refill
 *                  every few kills would turn the Aasgeier perk into a permanent Max Ammo)
 * Timed effects last duration × powerUpDuration stat; collecting one again refreshes the timer.
 * Expiry (and clear()) undoes exactly what the start applied (stat sources are removed as a whole).
 *
 * Events: powerup:spawned, powerup:collected (duration 0 = instant), powerup:expired.
 */
import { Vector3, type Object3D } from 'three';
import type { EconomyApi, EnemyManagerApi, PowerUpApi, StatsApi, VfxApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import { ENEMY_AI } from '../defs/enemies';
import {
  POWERUP_DEFS,
  POWERUP_IDS,
  POWERUPS,
  getPowerUpDef,
  type PowerUpCondition,
  type PowerUpDef,
} from '../defs/powerups';
import {
  createDropState,
  noteDrop,
  pickDropType,
  resetDropState,
  rollKill,
  startDropWave,
  type DropRuleDef,
  type DropState,
} from './dropRules';
import { glyphCell } from './glyphAtlas';
import { PickupView, type PickupVisual } from './PickupView';
import { PowerUpTimers } from './PowerUpTimers';

const log = createLogger('powerups');

/** Enemy side of the effects (EnemyManager satisfies it). */
export interface PowerUpEnemies {
  killAll: EnemyManagerApi['killAll'];
  timeScale: number;
  instakill: boolean;
}

export interface PowerUpWeapons {
  refillAmmo(fillMagazines?: boolean): void;
  /**
   * Add `fraction` of every carried weapon's full reserve, capped at full (ammo scraps). Optional:
   * without it the Aasgeier scraps are not dropped.
   */
  addReserveFraction?(fraction: number): void;
}

export interface PowerUpSeals {
  repairAll(): number;
  readonly brokenSegments: number;
}

export interface PowerUpArmor {
  addArmor(amount: number): number;
  readonly maxArmor: number;
}

/** Screen effects the composition root wires (render / post). */
export interface PowerUpFx {
  /** Nuke flash + shockwave (default: fx:hitPulse + camera:shake events). */
  nuke?(position: Vec3Like): void;
  /** Slow Motion screen tint 0..1 (called per frame while it changes). */
  timeTint?(amount: number): void;
}

export interface PowerUpDeps {
  events: EventBus<GameEvents>;
  /** Player feet (live vector): pickups are collected by walking into them. */
  player: { readonly position: Vec3Like };
  /** Collection allowed right now (alive, not in the death sequence). Default: always. */
  canCollect?: () => boolean;
  stats?: Pick<StatsApi, 'value' | 'addModifier' | 'removeSource' | 'hasSource'> | null;
  economy?: Pick<EconomyApi, 'earn'> | null;
  enemies?: PowerUpEnemies | null;
  weapons?: PowerUpWeapons | null;
  seals?: PowerUpSeals | null;
  armor?: PowerUpArmor | null;
  /** Floor below a drop point (NavApi.closestPoint); without it pickups keep the given height. */
  snapToFloor?: ((p: Vec3Like, out: Vector3) => boolean) | null;
  vfx?: Pick<VfxApi, 'spawn'> | null;
  fx?: PowerUpFx | null;
  /** World scene for the holograms (null: logic only). */
  scene?: Object3D | null;
  seed?: string | number;
  reduceFlashing?: boolean;
  /** Tuning overrides (tests). */
  rules?: DropRuleDef;
  capacity?: number;
}

/** A pooled pickup (also what the view draws). */
interface Pickup extends PickupVisual {
  active: boolean;
  serial: number;
  type: string;
  def: PowerUpDef;
  x: number;
  y: number;
  z: number;
  cell: number;
  color: PowerUpDef['color'];
  scale: number;
  seed: number;
  age: number;
  lifetime: number;
  collecting: number;
}

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
/** Low-discrepancy step for the cosmetic per-pickup phase (bob, ring dashes). */
const GOLDEN_RATIO = 0.6180339887;
const _v = new Vector3();
const _pos = { x: 0, y: 0, z: 0 };

/** Timed types, table order (the timer table). */
const TIMED_IDS = POWERUP_IDS.filter((id) => POWERUP_DEFS[id]!.duration > 0);
/** Every def (drop candidates, table order). */
const ALL_DEFS: readonly PowerUpDef[] = POWERUP_IDS.map((id) => POWERUP_DEFS[id]!);

export class PowerUpSystem implements PowerUpApi {
  readonly view: PickupView | null;
  /** Drop bookkeeping (debug / tests). */
  readonly drops: DropState = createDropState();
  /** Run totals: drops, collected, despawned. */
  readonly stats = { dropped: 0, collected: 0, despawned: 0 };

  private readonly deps: PowerUpDeps;
  private readonly events: EventBus<GameEvents>;
  private readonly rules: DropRuleDef;
  private rng: Rng;
  private readonly timers = new PowerUpTimers(TIMED_IDS);
  private readonly pickups: Pickup[] = [];
  private readonly noDrop = new Set<number>();
  private readonly offs: (() => void)[] = [];
  private time = 0;
  private serial = 1;
  private waveActive = false;
  private tint = 0;
  private tintTarget = 0;
  private disposed = false;
  private warnedScrap = false;
  private readonly spawnedPayload: GameEvents['powerup:spawned'] = {
    id: 0,
    type: '',
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly collectedPayload: GameEvents['powerup:collected'] = {
    type: '',
    position: { x: 0, y: 0, z: 0 },
    duration: 0,
  };
  private readonly expiredPayload: GameEvents['powerup:expired'] = { type: '' };
  /** Where the power-up being applied was picked up (own copy: effects re-enter spawn()). */
  private readonly at: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly expire = (id: string): void => this.endEffect(id);
  private readonly conditionMet = (c: PowerUpCondition): boolean => this.condition(c);

  constructor(deps: PowerUpDeps) {
    this.deps = deps;
    this.events = deps.events;
    this.rules = deps.rules ?? POWERUPS.drops;
    this.rng = new Rng(deps.seed ?? 'powerups');
    const cap = Math.max(1, Math.floor(deps.capacity ?? POWERUPS.capacity));
    for (let i = 0; i < cap; i++) this.pickups.push(createPickup());
    this.view = deps.scene ? new PickupView(deps.scene, cap, deps.reduceFlashing ?? false) : null;
    const ev = deps.events;
    this.offs.push(
      ev.on('enemy:died', (e) => this.onEnemyDied(e)),
      ev.on('wave:start', () => {
        this.waveActive = true;
        startDropWave(this.drops);
      }),
      ev.on('wave:complete', () => {
        this.waveActive = false;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // PowerUpApi
  // -------------------------------------------------------------------------

  rollDrop(position: Vec3Like, type?: string): void {
    if (this.disposed) return;
    if (type !== undefined) {
      this.spawn(type, position);
      return;
    }
    const chanceMul = this.deps.stats ? this.deps.stats.value('dropChance') : 1;
    if (!rollKill(this.drops, this.rules, this.rng, chanceMul, this.time)) return;
    const picked = pickDropType(
      ALL_DEFS,
      this.rules.noRepeat ? this.drops.lastType : null,
      this.rng,
      this.conditionMet,
    );
    if (picked === null) return;
    if (this.spawn(picked, position) >= 0) noteDrop(this.drops, picked, this.time);
  }

  isActive(type: string): boolean {
    return this.timers.isActive(type);
  }

  remaining(type: string): number {
    return this.timers.remaining(type);
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    this.time += dt;
    if (this.waveActive) this.drops.timeSinceDrop += dt;
    this.timers.tick(dt, this.expire);
    const P = POWERUPS.pickup;
    const player = this.deps.player.position;
    const collect = this.deps.canCollect ? this.deps.canCollect() : true;
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i]!;
      if (!pk.active) continue;
      if (pk.collecting >= 0) {
        pk.collecting += dt;
        if (pk.collecting >= P.collectTime) pk.active = false;
        continue;
      }
      pk.age += dt;
      if (pk.age >= pk.lifetime) {
        pk.active = false;
        this.stats.despawned++;
        continue;
      }
      if (!collect) continue;
      const dx = player.x - pk.x;
      const dz = player.z - pk.z;
      if (dx * dx + dz * dz <= P.radius * P.radius && Math.abs(player.y - pk.y) <= P.height) {
        this.collect(pk);
      }
    }
  }

  /** Per frame: tint easing (fx.timeTint) and the holograms. */
  update(dt: number): void {
    if (this.disposed) return;
    const T = POWERUPS.effects.tint;
    if (this.tint !== this.tintTarget && dt > 0) {
      const rate = this.tintTarget > this.tint ? 1 / Math.max(1e-3, T.fadeIn) : 1 / Math.max(1e-3, T.fadeOut);
      const step = rate * dt;
      this.tint =
        this.tintTarget > this.tint
          ? Math.min(this.tintTarget, this.tint + step)
          : Math.max(this.tintTarget, this.tint - step);
      this.deps.fx?.timeTint?.(this.tint);
    }
    this.view?.update(dt, this.pickups);
  }

  /** New run: pickups gone, every timed effect ended (stats restored), drop counters reset. */
  clear(): void {
    for (const pk of this.pickups) pk.active = false;
    this.timers.clear(this.expire);
    resetDropState(this.drops);
    this.noDrop.clear();
    this.waveActive = false;
    this.stats.dropped = this.stats.collected = this.stats.despawned = 0;
    if (this.tint !== 0 || this.tintTarget !== 0) {
      this.tint = 0;
      this.tintTarget = 0;
      this.deps.fx?.timeTint?.(0);
    }
    // Now, not next frame: a new run is prepared behind a menu (no update() while paused).
    this.view?.update(0, this.pickups);
  }

  // -------------------------------------------------------------------------
  // Extras (HUD, console, perks)
  // -------------------------------------------------------------------------

  /** Full duration of a running timed power-up (HUD bar), 0 when inactive. */
  duration(type: string): number {
    return this.timers.duration(type);
  }

  /** Running timed power-ups, table order (reused array). */
  get activeTimed(): readonly string[] {
    return this.timers.active;
  }

  /** Pickups on the floor (not collecting). */
  get pickupCount(): number {
    let n = 0;
    for (const pk of this.pickups) if (pk.active && pk.collecting < 0) n++;
    return n;
  }

  /**
   * The pickup of powerup:spawned `id` still floats (not collected, despawned or replaced in a
   * full pool – those send no event). The economy audio ends its floating loop by this.
   */
  hasPickup(id: number): boolean {
    for (const pk of this.pickups) if (pk.active && pk.collecting < 0 && pk.serial === id) return true;
    return false;
  }

  /** Holograms draw on the volumetric layer while any pickup exists. */
  get hasVolumetricContent(): boolean {
    return this.view !== null && this.view.visible;
  }

  /** Kills of this enemy id drop nothing (dev spawns); cleared when it dies. */
  flagNoDrop(id: number): void {
    this.noDrop.add(id);
  }

  /** Aasgeier perk hook (PerkSystem.setAmmoDropHandler): a small ammo pickup. */
  readonly dropAmmo = (position: Vec3Like): void => {
    if (this.deps.weapons?.addReserveFraction) this.spawn('ammoScrap', position);
    else if (!this.warnedScrap) {
      this.warnedScrap = true;
      log.warn('Ammo scraps need weapons.addReserveFraction – Aasgeier drops disabled');
    }
  };

  /**
   * Place a pickup of `type` (no drop rules). Returns its id; -1 for an unknown type or when the
   * pool is full of real drops and `type` is an ammo scrap (scraps never replace a real drop).
   */
  spawn(type: string, position: Vec3Like): number {
    const def = getPowerUpDef(type);
    if (!def || this.disposed) {
      if (!def) log.warn(`Unknown power-up "${type}"`);
      return -1;
    }
    const pk = this.freePickup(def.counted);
    if (!pk) return -1;
    const P = POWERUPS.pickup;
    let y = position.y;
    if (this.deps.snapToFloor?.(position, _v) && Math.abs(_v.y - position.y) <= P.snapMaxDrop) y = _v.y;
    pk.active = true;
    pk.serial = this.serial++;
    pk.type = def.id;
    pk.def = def;
    pk.x = position.x;
    pk.y = y;
    pk.z = position.z;
    pk.cell = glyphCell(def.glyph);
    pk.color = def.color;
    pk.scale = def.scale;
    // Cosmetic phase from the serial: console / perk spawns never shift the seeded drop stream.
    pk.seed = fract(pk.serial * GOLDEN_RATIO);
    pk.age = 0;
    pk.lifetime = def.lifetime > 0 ? def.lifetime : P.lifetime;
    pk.collecting = -1;
    if (def.counted) this.stats.dropped++;
    const e = this.spawnedPayload;
    e.id = pk.serial;
    e.type = def.id;
    setPos(e.position, pk.x, pk.y, pk.z);
    this.events.emit('powerup:spawned', e);
    const V = POWERUPS.vfx;
    this.deps.vfx?.spawn(
      V.spawn,
      setPos(_pos, pk.x, pk.y + P.hover * def.scale, pk.z),
      UP,
      V.spawnScale * def.scale,
    );
    return pk.serial;
  }

  /**
   * Apply a power-up's effect right away (collection, dev console). `position`: where it was picked
   * up (points popups, nuke FX); defaults to the player.
   */
  activate(type: string, position?: Vec3Like): boolean {
    const def = getPowerUpDef(type);
    if (!def || this.disposed) return false;
    // Copied first: a nuke's kills reach the Aasgeier hook (dropAmmo → spawn) mid-effect.
    const src = position ?? this.deps.player.position;
    const at = setPos(this.at, src.x, src.y, src.z);
    const d = this.deps;
    const fx = def.effect;
    let duration = 0;
    switch (fx.kind) {
      case 'nuke': {
        d.enemies?.killAll(true);
        if (fx.points > 0) d.economy?.earn(fx.points, 'nuke', at);
        this.nukeFx(at);
        break;
      }
      case 'maxAmmo':
        d.weapons?.refillAmmo(fx.fillMagazines);
        break;
      case 'carpenter': {
        d.seals?.repairAll();
        if (fx.armor && d.armor) d.armor.addArmor(d.armor.maxArmor);
        if (fx.points > 0) d.economy?.earn(fx.points, 'carpenter', at);
        break;
      }
      case 'ammoScrap':
        d.weapons?.addReserveFraction?.(fx.reserveFraction);
        break;
      case 'stat':
      case 'instakill':
      case 'enemyTimeScale': {
        const mul = d.stats ? d.stats.value('powerUpDuration') : 1;
        duration = def.duration * (mul > 0 && Number.isFinite(mul) ? mul : 1);
        // Refreshing re-applies too: idempotent, and it heals a state someone else reset.
        this.timers.start(def.id, duration);
        this.startEffect(def);
        break;
      }
    }
    const e = this.collectedPayload;
    e.type = def.id;
    setPos(e.position, at.x, at.y, at.z);
    e.duration = duration;
    this.events.emit('powerup:collected', e);
    return true;
  }

  setReducedFlashing(on: boolean): void {
    this.view?.setReducedFlashing(on);
  }

  /** New deterministic stream (daily challenge / a new run seed). */
  reseed(seed: string | number): void {
    this.rng = new Rng(seed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.view?.dispose();
  }

  // -------------------------------------------------------------------------

  private onEnemyDied(e: GameEvents['enemy:died']): void {
    const flagged = this.noDrop.delete(e.id);
    if (flagged || e.source !== 'player' || e.weaponId === ENEMY_AI.nukeWeaponId) return;
    this.rollDrop(e.position);
  }

  private collect(pk: Pickup): void {
    pk.collecting = 0;
    this.stats.collected++;
    const V = POWERUPS.vfx;
    const P = POWERUPS.pickup;
    this.deps.vfx?.spawn(V.collect, setPos(_pos, pk.x, pk.y + P.hover * pk.scale, pk.z), UP, V.collectScale);
    this.activate(pk.type, setPos(_pos, pk.x, pk.y, pk.z));
  }

  private startEffect(def: PowerUpDef): void {
    const d = this.deps;
    const fx = def.effect;
    switch (fx.kind) {
      case 'stat': {
        const source = sourceOf(def.id);
        if (d.stats && !d.stats.hasSource(source)) {
          d.stats.addModifier({ source, stat: fx.stat, op: fx.op, value: fx.value });
        }
        break;
      }
      case 'instakill':
        if (d.enemies) d.enemies.instakill = true;
        break;
      case 'enemyTimeScale':
        if (d.enemies) d.enemies.timeScale = fx.scale;
        this.tintTarget = 1;
        break;
      default:
        break;
    }
  }

  private endEffect(id: string): void {
    const def = getPowerUpDef(id);
    if (!def) return;
    const d = this.deps;
    const fx = def.effect;
    switch (fx.kind) {
      case 'stat':
        d.stats?.removeSource(sourceOf(def.id));
        break;
      case 'instakill':
        if (d.enemies) d.enemies.instakill = false;
        break;
      case 'enemyTimeScale':
        if (d.enemies) d.enemies.timeScale = 1;
        this.tintTarget = 0;
        break;
      default:
        break;
    }
    this.expiredPayload.type = def.id;
    this.events.emit('powerup:expired', this.expiredPayload);
  }

  private nukeFx(at: Vec3Like): void {
    const f = this.deps.fx;
    if (f?.nuke) {
      f.nuke(at);
      return;
    }
    const N = POWERUPS.effects.nuke;
    this.events.emit('fx:hitPulse', { strength: N.pulse });
    this.events.emit('camera:shake', { trauma: N.shake });
  }

  private condition(c: PowerUpCondition): boolean {
    switch (c) {
      case 'none':
        return true;
      case 'sealsDamaged':
        return (this.deps.seals?.brokenSegments ?? 0) > 0;
    }
  }

  /**
   * A free slot, else the cheapest pickup to lose, closest to despawning first: one playing its
   * collect animation (its effect is applied), then an ammo scrap, then – only for a real drop
   * (`counted`) – another real drop. Null: a scrap finds only real drops (it is not placed).
   */
  private freePickup(counted: boolean): Pickup | null {
    let best: Pickup | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestLeft = Number.POSITIVE_INFINITY;
    for (const pk of this.pickups) {
      if (!pk.active) return pk;
      // 0: collected (animation only), 1: a floating scrap, 2: a floating real drop.
      const rank = pk.collecting >= 0 ? 0 : pk.def.counted ? 2 : 1;
      if (rank === 2 && !counted) continue;
      const left = pk.lifetime - pk.age;
      if (rank < bestRank || (rank === bestRank && left < bestLeft)) {
        bestRank = rank;
        bestLeft = left;
        best = pk;
      }
    }
    return best;
  }
}

/** Stat modifier source of a timed stat power-up. */
export function sourceOf(id: string): string {
  return `powerup:${id}`;
}

function createPickup(): Pickup {
  const def = POWERUP_DEFS[POWERUP_IDS[0]!]!;
  return {
    active: false,
    serial: 0,
    type: def.id,
    def,
    x: 0,
    y: 0,
    z: 0,
    cell: 0,
    color: def.color,
    scale: 1,
    seed: 0,
    age: 0,
    lifetime: POWERUPS.pickup.lifetime,
    collecting: -1,
  };
}

function fract(v: number): number {
  return v - Math.floor(v);
}

function setPos(out: Vec3Like, x: number, y: number, z: number): Vec3Like {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
