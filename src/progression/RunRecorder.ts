/**
 * Gameplay events → progress signals (defs/progression METRICS) while a ranked run is recorded.
 * One reused signal object, no allocation per event (a Map entry per kill for the killing blow's
 * element / kind is the only write that may allocate).
 *
 * Mirrors RunStats where both count the same thing: every weapon:fired is a shot, the first player
 * combat:damage of that weapon after it makes the shot a hit, melee swings close the shot; kills are
 * player-credited enemy:died (console spawns flagged with flagNoReward and training dummies never
 * count). Kill tags: enemy type, weapon (roster ids only), weapon category ('grenade' / 'ability'
 * for their blasts), hit zone, elite, and the element / delivery kind of the killing damage.
 */
import type { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents, ImpactKind } from '../core/events';
import { PROGRESSION } from '../defs/progression';
import { RUN } from '../defs/waves';
import { getWeaponDef } from '../defs/weapons';
import { isRewardableId } from '../economy/PointsRules';
import { clearTags, createSignal, type ProgressSignal } from './signals';

export interface SignalSink {
  signal(s: ProgressSignal): void;
  /** A wave started (wave-scoped conditions reset). */
  waveStart(wave: number): void;
}

export interface RunRecorderDeps {
  events: EventBus<GameEvents>;
  sink: SignalSink;
  /** Real-time seconds (multi-kill window). Default performance.now() / 1000. */
  clock?: () => number;
  /** Doors of the level: opening all of them in one run emits allDoors. */
  doorCount?: () => number;
  /** Perk slots in use and available: filling all emits perkSlotsFull. */
  perkSlots?: () => { owned: number; max: number };
  /** Seconds survived in the run (survived signals). */
  runTime?: () => number;
}

const GRENADE_PREFIX = 'grenade.';
const ABILITY_PREFIX = 'ability.';
/** Pending killing-blow records are dropped beyond this (kills whose enemy:died never came). */
const MAX_PENDING_KILLS = 256;

export interface RunEndInfo {
  wave: number;
  timeSurvived: number;
  /** The run ended by death (run:over); false for a replaced run. */
  died: boolean;
}

function defaultClock(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

export class RunRecorder {
  private readonly sig: ProgressSignal = createSignal();
  private readonly offs: (() => void)[] = [];
  private readonly clock: () => number;
  private readonly noReward = new Set<number>();
  private readonly killElement = new Map<number, DamageElement>();
  private readonly killKind = new Map<number, ImpactKind | undefined>();
  private _active = false;
  // run state
  private wave = 0;
  private damagedThisWave = false;
  private shotsThisRun = 0;
  private shotOpen = false;
  private shotHit = false;
  private shotWeapon = '';
  private headshotStreak = 0;
  private killStreak = 0;
  private multiKill = 0;
  private lastKillAt = Number.NEGATIVE_INFINITY;
  private doorsThisRun = 0;
  private allDoorsSent = false;
  private slotsFullSent = false;

  constructor(private readonly deps: RunRecorderDeps) {
    this.clock = deps.clock ?? defaultClock;
    const ev = deps.events;
    this.offs.push(
      ev.on('weapon:fired', (e) => this.onFired(e.weaponId)),
      ev.on('weapon:melee', () => {
        this.shotOpen = false;
      }),
      ev.on('combat:damage', (e) => this.onDamage(e)),
      ev.on('enemy:died', (e) => this.onDied(e)),
      ev.on('player:damaged', (e) => this.onPlayerDamaged(e.amount)),
      ev.on('wave:start', (e) => this.onWaveStart(e.wave)),
      ev.on('wave:complete', (e) => this.onWaveComplete(e.wave)),
      ev.on('economy:points', (e) => {
        if (e.delta > 0 && !RUN.unearnedPointReasons.includes(e.reason)) this.emit('pointsEarned', e.delta);
      }),
      ev.on('economy:purchase', (e) => {
        if (e.ok && e.cost > 0) this.emit('pointsSpent', e.cost);
      }),
      ev.on('door:opened', () => this.onDoor()),
      ev.on('perk:acquired', (e) => this.onPerk(e.perkId)),
      ev.on('box:opened', () => this.emit('boxRoll', 1)),
      ev.on('box:resolved', (e) => this.onBoxResolved(e.weaponId)),
      ev.on('forge:upgraded', (e) => this.onForge(e.weaponId, e.tier)),
      ev.on('powerup:collected', (e) => {
        if (!this.begin('powerUp', 1)) return;
        this.sig.tags.powerup = e.type;
        this.flush();
      }),
      ev.on('seal:repaired', () => this.emit('sealRepaired', 1)),
      ev.on('grenade:thrown', (e) => {
        if (!this.begin('grenadeThrown', 1)) return;
        this.sig.tags.grenade = e.grenadeId;
        this.flush();
      }),
      ev.on('ability:used', (e) => {
        if (!this.begin('abilityUsed', 1)) return;
        this.sig.tags.ability = e.abilityId;
        this.flush();
      }),
      ev.on('combat:combo', (e) => {
        if (!this.begin('combo', 1)) return;
        this.sig.tags.combo = e.combo;
        this.flush();
      }),
      ev.on('player:revived', () => this.emit('revive', 1)),
    );
  }

  get active(): boolean {
    return this._active;
  }

  /** Start recording a run on `mapId` / `mode` (every per-run counter resets). */
  start(mapId: string, mode: string): void {
    const t = this.sig.tags;
    t.map = mapId;
    t.mode = mode;
    t.wave = 0;
    this.wave = 0;
    this.damagedThisWave = false;
    this.shotsThisRun = 0;
    this.shotOpen = false;
    this.shotHit = false;
    this.shotWeapon = '';
    this.headshotStreak = 0;
    this.killStreak = 0;
    this.multiKill = 0;
    this.lastKillAt = Number.NEGATIVE_INFINITY;
    this.doorsThisRun = 0;
    this.allDoorsSent = false;
    this.slotsFullSent = false;
    this.killElement.clear();
    this.killKind.clear();
    this._active = true;
  }

  /**
   * The run ends: final survival / wave signals and, for a death, runEnd, death and earlyDeath.
   * Recording stops.
   */
  finish(info: RunEndInfo): void {
    if (!this._active) return;
    const wave = Math.max(this.wave, Number.isFinite(info.wave) ? Math.floor(info.wave) : 0);
    if (wave > 0) this.emit('waveReached', wave);
    if (info.timeSurvived > 0) this.emit('survived', Math.floor(info.timeSurvived));
    if (info.died) {
      this.emit('runEnd', 1);
      this.emit('death', 1);
      if (wave <= PROGRESSION.tracking.earlyDeathWave) this.emit('earlyDeath', 1);
    }
    this._active = false;
  }

  /** Stop without run-end signals (main menu, dispose). */
  stop(): void {
    this._active = false;
  }

  /** Dev-console spawns: their kills never count (like their points). */
  flagNoReward(id: number): void {
    this.noReward.add(id);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this._active = false;
  }

  // -------------------------------------------------------------------------

  /** Prepare the shared signal; false while not recording. */
  private begin(metric: ProgressSignal['metric'], amount: number): boolean {
    if (!this._active) return false;
    clearTags(this.sig.tags);
    this.sig.metric = metric;
    this.sig.amount = amount;
    return true;
  }

  private flush(): void {
    this.deps.sink.signal(this.sig);
  }

  private emit(metric: ProgressSignal['metric'], amount: number): void {
    if (this.begin(metric, amount)) this.flush();
  }

  private tagWeapon(weaponId: string | null): void {
    const t = this.sig.tags;
    if (weaponId === null) return;
    if (weaponId.startsWith(GRENADE_PREFIX)) {
      t.category = 'grenade';
      t.grenade = weaponId.slice(GRENADE_PREFIX.length);
      return;
    }
    if (weaponId.startsWith(ABILITY_PREFIX)) {
      t.category = 'ability';
      t.ability = weaponId.slice(ABILITY_PREFIX.length);
      return;
    }
    const def = getWeaponDef(weaponId);
    if (def) {
      t.weapon = weaponId;
      t.category = def.category;
    }
  }

  private onFired(weaponId: string): void {
    if (!this._active) return;
    this.shotsThisRun++;
    this.shotOpen = true;
    this.shotHit = false;
    this.shotWeapon = weaponId;
    if (!this.begin('shotFired', 1)) return;
    this.tagWeapon(weaponId);
    this.flush();
  }

  private onDamage(e: GameEvents['combat:damage']): void {
    if (!this._active || e.source !== 'player') return;
    if (e.killed && isRewardableId(e.targetId)) {
      if (this.killElement.size >= MAX_PENDING_KILLS) {
        this.killElement.clear();
        this.killKind.clear();
      }
      this.killElement.set(e.targetId, e.element);
      this.killKind.set(e.targetId, e.kind);
    }
    if (this.shotOpen && !this.shotHit && e.weaponId === this.shotWeapon) {
      this.shotHit = true;
      if (this.begin('shotHit', 1)) {
        this.tagWeapon(e.weaponId);
        this.flush();
      }
    }
    if (e.amount > 0 && Number.isFinite(e.amount)) this.emit('damageDealt', e.amount);
  }

  private onDied(e: GameEvents['enemy:died']): void {
    const flagged = this.noReward.delete(e.id);
    const element = this.killElement.get(e.id) ?? null;
    const kind = this.killKind.get(e.id) ?? null;
    this.killElement.delete(e.id);
    this.killKind.delete(e.id);
    if (flagged || !this._active || e.source !== 'player' || !isRewardableId(e.id)) return;
    if (!this.begin('kill', 1)) return;
    const t = this.sig.tags;
    t.enemy = e.type;
    t.zone = e.zone;
    t.elite = e.elite;
    t.element = element;
    t.kind = kind;
    this.tagWeapon(e.weaponId);
    this.flush();

    this.headshotStreak = e.zone === 'head' ? this.headshotStreak + 1 : 0;
    if (this.headshotStreak > 0) this.emit('headshotStreak', this.headshotStreak);
    this.killStreak++;
    this.emit('killStreak', this.killStreak);
    const now = this.clock();
    this.multiKill = now - this.lastKillAt <= PROGRESSION.tracking.multiKillWindow ? this.multiKill + 1 : 1;
    this.lastKillAt = now;
    if (this.multiKill > 1) this.emit('multiKill', this.multiKill);
  }

  private onPlayerDamaged(amount: number): void {
    if (!this._active || !(amount > 0) || !Number.isFinite(amount)) return;
    this.damagedThisWave = true;
    this.killStreak = 0;
    this.emit('damageTaken', amount);
  }

  private onWaveStart(wave: number): void {
    if (!this._active) return;
    this.wave = Math.max(this.wave, wave);
    this.sig.tags.wave = wave;
    this.damagedThisWave = false;
    this.deps.sink.waveStart(wave);
    this.emit('waveReached', wave);
  }

  private onWaveComplete(wave: number): void {
    if (!this.begin('waveComplete', 1)) return;
    this.sig.tags.wave = wave;
    this.flush();
    if (!this.damagedThisWave && wave >= PROGRESSION.tracking.noDamageMinWave) this.emit('noDamageWave', 1);
    if (this.shotsThisRun === 0) this.emit('pacifistWave', wave);
    const time = this.deps.runTime?.() ?? 0;
    if (time > 0) this.emit('survived', Math.floor(time));
  }

  private onDoor(): void {
    if (!this._active) return;
    this.doorsThisRun++;
    this.emit('doorOpened', 1);
    const total = this.deps.doorCount?.() ?? 0;
    if (!this.allDoorsSent && total > 0 && this.doorsThisRun >= total) {
      this.allDoorsSent = true;
      this.emit('allDoors', 1);
    }
  }

  private onPerk(perkId: string): void {
    if (!this.begin('perkBought', 1)) return;
    this.sig.tags.perk = perkId;
    this.flush();
    const slots = this.deps.perkSlots?.();
    if (!this.slotsFullSent && slots && slots.max > 0 && slots.owned >= slots.max) {
      this.slotsFullSent = true;
      this.emit('perkSlotsFull', 1);
    }
  }

  private onBoxResolved(weaponId: string | null): void {
    if (weaponId === null || getWeaponDef(weaponId)?.category !== 'wonder') return;
    if (!this.begin('boxWonder', 1)) return;
    this.tagWeapon(weaponId);
    this.flush();
  }

  private onForge(weaponId: string, tier: number): void {
    if (!this.begin('forgeUpgrade', 1)) return;
    this.tagWeapon(weaponId);
    this.sig.tags.tier = tier;
    this.flush();
    this.emit('forgeTier', tier);
  }
}
