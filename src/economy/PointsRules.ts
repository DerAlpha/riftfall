/**
 * Combat → points (CoD Zombies rules, tuning in defs/economy.ts ECONOMY.points). Listens to:
 * - combat:damage – a player hit that does not kill pays the kind's `hit` (bullets, pellets,
 *   projectiles, melee only – beam/blast/field/status ticks pay nothing until the kill);
 * - combat:kill – the killing blow pays the kind's `kill` (+ head / weakpoint bonus, or the melee
 *   bonus); the kind's table comes from `rewardOf(targetId)` (Game: the enemy's def `points`),
 *   ECONOMY.points.fallback without one;
 * - enemy:died – elite bonus, nuke kills (they bypass CombatWorld and have no combat:kill);
 * - wave:complete – waveBonus(wave).
 * Only source 'player' pays, and only damageables in the enemy id range that are not flagged
 * (`flagNoReward`: dev-console spawns): training dummies (ids from 1_000_000) never pay.
 *
 * Melee kills: combat events carry no damage kind, but the weapon system emits the melee blow's
 * combat:impact (kind 'melee') right before its dealDamage, at the same hit point – that impact arms
 * a flag the very next damage event consumes, and it counts only when that event is the blow
 * (same weapon, same point): a bash that hit a wall must not turn a later blast or chain burst kill
 * into a melee kill. Any other impact, shot, reload or swing start disarms it.
 *
 * Repairs (seals, M4 interactables): `awardRepair(planks)` pays ECONOMY.repair.perPlank each, capped
 * per wave (the cap resets on wave:start).
 */
import type { EconomyApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone, ImpactKind, PointsReason, Vec3Like } from '../core/events';
import { ECONOMY, waveBonus, type KillRewardDef } from '../defs/economy';
import { ENEMY_AI } from '../defs/enemies';

/** Damage kinds whose non-lethal hits pay `hit` points (discrete shots and blows). */
const HIT_PAYING_KINDS: ReadonlySet<ImpactKind> = new Set<ImpactKind>([
  'bullet',
  'pellet',
  'projectile',
  'melee',
]);

export interface PointsRulesDeps {
  events: EventBus<GameEvents>;
  economy: Pick<EconomyApi, 'earn'>;
  /**
   * Point table of the enemy kind behind a damageable id (Game: `enemies.getEnemy(id)?.def.points`),
   * asked on every paying hit and kill; null/undefined = ECONOMY.points.fallback.
   */
  rewardOf?: ((targetId: number) => KillRewardDef | null | undefined) | null;
}

/** Points paid for a killing blow (before the multiplier). */
export function killPoints(
  zone: HitZone | null,
  melee: boolean,
  reward: KillRewardDef = ECONOMY.points.fallback,
): number {
  if (melee) return reward.kill + ECONOMY.points.meleeKillBonus;
  if (zone === 'head') return reward.kill + reward.headshotBonus;
  if (zone === 'weakpoint') return reward.kill + reward.weakpointBonus;
  return reward.kill;
}

/** Popup / stats reason of a killing blow: melee wins, head and weakpoint count as 'headshot'. */
export function killReason(zone: HitZone | null, melee: boolean): PointsReason {
  if (melee) return 'melee';
  return zone === 'head' || zone === 'weakpoint' ? 'headshot' : 'kill';
}

/** Does damage to this damageable id pay points (enemy id range)? */
export function isRewardableId(id: number): boolean {
  const p = ECONOMY.points;
  return Number.isInteger(id) && id >= p.rewardIdMin && id <= p.rewardIdMax;
}

export class PointsRules {
  /** Points credited per kind this run (after multipliers; debug / run summary). */
  readonly stats = { hits: 0, kills: 0, headshots: 0, melee: 0, elite: 0, wave: 0, repair: 0 };

  private readonly economy: Pick<EconomyApi, 'earn'>;
  private readonly rewardOf: ((targetId: number) => KillRewardDef | null | undefined) | null;
  private readonly unsubscribe: (() => void)[];
  private readonly noReward = new Set<number>();
  private meleeArmed = false;
  /** Weapon and point of the arming melee impact (the blow's damage event repeats both). */
  private meleeWeapon = '';
  private readonly meleePoint: Vec3Like = { x: 0, y: 0, z: 0 };
  private repairThisWave = 0;
  private readonly pos: Vec3Like = { x: 0, y: 0, z: 0 };

  constructor(deps: PointsRulesDeps) {
    this.economy = deps.economy;
    this.rewardOf = deps.rewardOf ?? null;
    const ev = deps.events;
    this.unsubscribe = [
      ev.on('combat:impact', (e) => {
        this.meleeArmed = e.kind === 'melee';
        if (!this.meleeArmed) return;
        this.meleeWeapon = e.weaponId;
        copy(e.point, this.meleePoint);
      }),
      ev.on('weapon:fired', () => {
        this.meleeArmed = false;
      }),
      ev.on('weapon:reloadStart', () => {
        this.meleeArmed = false;
      }),
      ev.on('weapon:melee', () => {
        this.meleeArmed = false;
      }),
      ev.on('combat:damage', (e) => this.onDamage(e)),
      ev.on('combat:kill', (e) => this.onKill(e)),
      ev.on('enemy:died', (e) => this.onDied(e)),
      ev.on('wave:start', () => {
        this.repairThisWave = 0;
      }),
      ev.on('wave:complete', (e) => {
        this.stats.wave += this.economy.earn(waveBonus(e.wave), 'wave');
      }),
    ];
  }

  /** This damageable pays nothing (dev spawns); cleared when it dies. */
  flagNoReward(id: number): void {
    this.noReward.add(id);
  }

  /** Pays for `planks` restored planks within the per-wave cap; returns the points credited. */
  awardRepair(planks = 1, position?: Vec3Like): number {
    const r = ECONOMY.repair;
    if (!(planks > 0)) return 0;
    const allowed = Math.max(0, r.capPerWave - this.repairThisWave);
    const amount = Math.min(allowed, Math.floor(planks) * r.perPlank);
    if (amount <= 0) return 0;
    this.repairThisWave += amount;
    const got = this.economy.earn(amount, 'repair', position);
    this.stats.repair += got;
    return got;
  }

  /** Repair points left this wave (before the multiplier). */
  get repairAllowance(): number {
    return Math.max(0, ECONOMY.repair.capPerWave - this.repairThisWave);
  }

  /** New run. */
  reset(): void {
    this.noReward.clear();
    this.meleeArmed = false;
    this.repairThisWave = 0;
    const s = this.stats;
    s.hits = s.kills = s.headshots = s.melee = s.elite = s.wave = s.repair = 0;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.noReward.clear();
  }

  /** The kind's point table (killed enemies are still looked up: combat:kill precedes enemy:died). */
  private reward(targetId: number): KillRewardDef {
    return this.rewardOf?.(targetId) ?? ECONOMY.points.fallback;
  }

  private pays(targetId: number, source: string): boolean {
    return source === 'player' && isRewardableId(targetId) && !this.noReward.has(targetId);
  }

  private onDamage(e: GameEvents['combat:damage']): void {
    // The blow the melee impact announced is this event (kill or not): consume the flag.
    const melee = this.meleeArmed && e.weaponId === this.meleeWeapon && samePoint(e.point, this.meleePoint);
    this.meleeArmed = false;
    if (e.killed) {
      // combat:kill follows synchronously and pays the kill.
      this.meleeArmed = melee;
      return;
    }
    if (!(e.amount > 0) || !this.pays(e.targetId, e.source)) return;
    // Continuous and area damage (beam ticks, blasts, field and status ticks) pays kills only:
    // per-tick hit points would farm the economy.
    if (e.kind !== undefined && !HIT_PAYING_KINDS.has(e.kind)) return;
    const reward = this.reward(e.targetId);
    this.stats.hits += this.economy.earn(reward.hit, 'hit', copy(e.point, this.pos));
  }

  private onKill(e: GameEvents['combat:kill']): void {
    const melee = this.meleeArmed;
    this.meleeArmed = false;
    if (!this.pays(e.targetId, e.source)) return;
    const points = killPoints(e.zone, melee, this.reward(e.targetId));
    const reason = killReason(e.zone, melee);
    const got = this.economy.earn(points, reason, copy(e.position, this.pos));
    if (reason === 'headshot') this.stats.headshots += got;
    else if (reason === 'melee') this.stats.melee += got;
    else this.stats.kills += got;
  }

  private onDied(e: GameEvents['enemy:died']): void {
    const flagged = this.noReward.delete(e.id);
    if (flagged || e.source !== 'player' || !isRewardableId(e.id)) return;
    const p = ECONOMY.points;
    const nuke = e.weaponId === ENEMY_AI.nukeWeaponId;
    if (nuke && p.nukeKill > 0) this.economy.earn(p.nukeKill, 'nuke', copy(e.position, this.pos));
    if (e.elite && !nuke && p.eliteKillBonus > 0) {
      this.stats.elite += this.economy.earn(p.eliteKillBonus, 'kill', copy(e.position, this.pos));
    }
  }
}

function samePoint(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function copy(from: Vec3Like, to: Vec3Like): Vec3Like {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  return to;
}
