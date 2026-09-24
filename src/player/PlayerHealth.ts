/**
 * Player health/armor. Pure state functions (unit-tested) + a thin class that emits events.
 * Armor absorbs `armorAbsorb` of incoming damage while it lasts; health regenerates after
 * `regenDelay` seconds without damage.
 *
 * Stats (M4, optional `setStats`): maxHealth / maxArmor / regenDelay / regenRate scale the def by
 * value ÷ base (a custom def scales the same way); raising max health grants the extra health at
 * once, lowering it clamps. damageTaken scales all incoming damage, explosionDamageTaken /
 * fallDamageTaken those kinds on top. reviveCharges: lethal damage consumes a charge instead (see
 * `damage`). Without stats everything follows the def.
 */
import { EventBus } from '../core/EventBus';
import type { StatsApi } from '../core/contracts';
import type { GameEvents, Vec3Like } from '../core/events';
import { PLAYER, type PlayerHealthDef } from '../defs/player';
import { statRatio } from '../stats/StatSystem';

/** What hurt the player: 'explosion' and 'fall' get their damage-taken stats on top. */
export type PlayerDamageKind = 'generic' | 'explosion' | 'fall';

type MutableHealthDef = { -readonly [K in keyof PlayerHealthDef]: PlayerHealthDef[K] };

export interface HealthState {
  health: number;
  armor: number;
  /** Seconds since the last damage. */
  sinceDamage: number;
}

export interface DamageSplit {
  toHealth: number;
  toArmor: number;
}

/** Split incoming damage between armor and health without mutating the state. */
export function splitDamage(
  s: Readonly<HealthState>,
  amount: number,
  def: PlayerHealthDef,
  out: DamageSplit,
): DamageSplit {
  const amt = amount > 0 && Number.isFinite(amount) ? amount : 0;
  const toArmor = Math.min(s.armor, amt * def.armorAbsorb);
  out.toArmor = toArmor;
  out.toHealth = Math.min(s.health, amt - toArmor);
  return out;
}

/** Apply damage (mutates the state). Returns the split actually applied. */
export function applyDamage(
  s: HealthState,
  amount: number,
  def: PlayerHealthDef,
  out: DamageSplit,
): DamageSplit {
  splitDamage(s, amount, def, out);
  s.armor -= out.toArmor;
  s.health -= out.toHealth;
  if (out.toArmor > 0 || out.toHealth > 0) s.sinceDamage = 0;
  return out;
}

/** Regenerate health after the out-of-combat delay. Returns the health gained. Dead players do not regenerate. */
export function regenerate(s: HealthState, def: PlayerHealthDef, dt: number): number {
  s.sinceDamage += dt;
  if (s.health <= 0 || s.sinceDamage < def.regenDelay) return 0;
  const cap = def.maxHealth * def.regenCapFraction;
  if (s.health >= cap) return 0;
  const before = s.health;
  s.health = Math.min(cap, s.health + def.regenRate * dt);
  return s.health - before;
}

export interface PlayerHealthDeps {
  events: EventBus<GameEvents>;
  /** God mode source (PlayerApi.godMode); OR-ed with PlayerHealth.godMode. */
  player?: { readonly godMode: boolean };
}

const _split: DamageSplit = { toHealth: 0, toArmor: 0 };
const REVIVE = PLAYER.revive;

export class PlayerHealth {
  /** Local god mode flag (in addition to `deps.player.godMode`). */
  godMode = false;

  private readonly events: EventBus<GameEvents>;
  private readonly player: { readonly godMode: boolean } | undefined;
  private readonly def: PlayerHealthDef;
  /** The def with the stats applied (== def without stats). */
  private readonly eff: MutableHealthDef;
  private readonly s: HealthState;
  /** Last health value (rounded up) announced via player:healthChanged during regen. */
  private lastAnnounced = -1;

  // --- stats ---
  private stats: StatsApi | null = null;
  private statsVersion = -1;
  private damageTakenScale = 1;
  private explosionScale = 1;
  private fallScale = 1;
  /** Revive charges granted by the stat (whole charges). */
  private reviveGranted = 0;
  /** Charges consumed this run (see tryRevive). */
  private reviveUsed = 0;
  /** Seconds of post-revive invulnerability left. */
  private invulnTime = 0;
  /** Max values changed through the stats: the next tick announces them. */
  private pendingAnnounce = false;

  /** Accepts `{ events, player? }` or just the event bus (then only the local godMode flag applies). */
  constructor(deps: PlayerHealthDeps | EventBus<GameEvents>, def: PlayerHealthDef = PLAYER.health) {
    if (deps instanceof EventBus) {
      this.events = deps;
      this.player = undefined;
    } else {
      this.events = deps.events;
      this.player = deps.player;
    }
    this.def = def;
    this.eff = { ...def };
    this.s = { health: def.startHealth, armor: def.startArmor, sinceDamage: Number.POSITIVE_INFINITY };
  }

  get health(): number {
    return this.s.health;
  }
  get armor(): number {
    return this.s.armor;
  }
  get maxHealth(): number {
    return this.eff.maxHealth;
  }
  get maxArmor(): number {
    return this.eff.maxArmor;
  }
  get fraction(): number {
    return this.eff.maxHealth > 0 ? this.s.health / this.eff.maxHealth : 0;
  }
  get dead(): boolean {
    return this.s.health <= 0;
  }
  get timeSinceDamage(): number {
    return this.s.sinceDamage;
  }
  /** Self-revives left (reviveCharges stat minus the ones used this run). */
  get reviveCharges(): number {
    return Math.max(0, this.reviveGranted - this.reviveUsed);
  }
  /** Seconds of post-revive invulnerability left. */
  get invulnerableTime(): number {
    return this.invulnTime;
  }
  private get invulnerable(): boolean {
    return this.godMode || (this.player?.godMode ?? false) || this.invulnTime > 0;
  }

  /** Gameplay stats (perks, cards). null = def values. */
  setStats(stats: StatsApi | null): void {
    this.stats = stats;
    this.statsVersion = -1;
    this.syncStats(true);
  }

  /**
   * Apply damage (`kind` selects the extra damage-taken stat). Ignored in god mode, during the
   * post-revive invulnerability or when dead (no events). Emits `player:damaged` (amount = health +
   * armor actually removed) and `player:healthChanged`. Returns the amount.
   *
   * Lethal damage with a revive charge left does not kill: the charge is consumed, the player is
   * back at PLAYER.revive.healthFraction of max health, invulnerable for a moment, and
   * `player:revived` is emitted (between player:damaged and player:healthChanged – the run never
   * sees health 0).
   */
  damage(amount: number, direction?: Vec3Like, kind: PlayerDamageKind = 'generic'): number {
    if (this.invulnerable || this.dead) return 0;
    this.syncStats();
    applyDamage(this.s, amount * this.damageScale(kind), this.eff, _split);
    const total = _split.toArmor + _split.toHealth;
    if (total <= 0) return 0;
    const revived = this.s.health <= 0 && this.reviveCharges > 0;
    if (revived) this.standUp();
    this.events.emit('player:damaged', { amount: total, healthFraction: this.fraction, direction });
    if (revived) this.emitRevived();
    this.announce();
    return total;
  }

  /**
   * Drive health (and armor) to 0 regardless of stats and revive charges (dev console `run kill`);
   * god mode still refuses. Returns the amount removed.
   */
  kill(): number {
    if (this.godMode || (this.player?.godMode ?? false) || this.dead) return 0;
    const total = this.s.health + this.s.armor;
    this.s.health = 0;
    this.s.armor = 0;
    this.s.sinceDamage = 0;
    this.invulnTime = 0;
    this.events.emit('player:damaged', { amount: total, healthFraction: 0 });
    this.announce();
    return total;
  }

  /** Restore health (not above max, not while dead). Returns the amount healed. */
  heal(amount: number): number {
    if (this.dead || !(amount > 0)) return 0;
    this.syncStats();
    const before = this.s.health;
    this.s.health = Math.min(this.eff.maxHealth, this.s.health + amount);
    const gained = this.s.health - before;
    if (gained > 0) this.announce();
    return gained;
  }

  /** Add armor up to max. Returns the amount added. */
  addArmor(amount: number): number {
    if (!(amount > 0)) return 0;
    this.syncStats();
    const before = this.s.armor;
    this.s.armor = Math.min(this.eff.maxArmor, this.s.armor + amount);
    const gained = this.s.armor - before;
    if (gained > 0) this.announce();
    return gained;
  }

  /** Back to start values (respawn / new run): start health scaled like max health, revives unused. */
  reset(): void {
    this.syncStats();
    const hRatio = this.def.maxHealth > 0 ? this.eff.maxHealth / this.def.maxHealth : 1;
    this.s.health = Math.min(this.eff.maxHealth, this.def.startHealth * hRatio);
    this.s.armor = Math.min(this.eff.maxArmor, this.def.startArmor);
    this.s.sinceDamage = Number.POSITIVE_INFINITY;
    this.reviveUsed = 0;
    this.invulnTime = 0;
    this.announce();
  }

  /** Regeneration tick (+ stat changes, post-revive invulnerability). */
  fixedUpdate(dt: number): void {
    this.syncStats();
    if (this.invulnTime > 0) this.invulnTime = Math.max(0, this.invulnTime - dt);
    const cap = this.eff.maxHealth * this.eff.regenCapFraction;
    if (regenerate(this.s, this.eff, dt) <= 0) {
      if (this.pendingAnnounce) this.announce();
      return;
    }
    // Only announce whole-point changes (and reaching the cap) to keep HUD updates cheap.
    const rounded = Math.ceil(this.s.health);
    if (rounded !== this.lastAnnounced || this.s.health >= cap || this.pendingAnnounce) this.announce();
  }

  /** Emit the current values (e.g. once after construction so the HUD initialises). */
  announce(): void {
    this.lastAnnounced = Math.ceil(this.s.health);
    this.pendingAnnounce = false;
    this.events.emit('player:healthChanged', {
      health: this.s.health,
      maxHealth: this.eff.maxHealth,
      armor: this.s.armor,
      maxArmor: this.eff.maxArmor,
    });
  }

  dispose(): void {
    // Nothing subscribed/allocated; present for lifecycle symmetry.
  }

  private damageScale(kind: PlayerDamageKind): number {
    const k = kind === 'explosion' ? this.explosionScale : kind === 'fall' ? this.fallScale : 1;
    return this.damageTakenScale * k;
  }

  /** Consume a charge: back up with part of the health and a moment of invulnerability. */
  private standUp(): void {
    this.reviveUsed++;
    this.s.health = Math.max(1, this.eff.maxHealth * REVIVE.healthFraction);
    this.invulnTime = REVIVE.invulnerability;
  }

  /**
   * player:revived. A source that hands its charge back on use (the revive perk is lost when it
   * saves the player) removes its modifier synchronously in a handler: that drop is the consumed
   * charge, so it is taken off the used count – other sources' charges stay available.
   */
  private emitRevived(): void {
    const before = this.reviveGranted;
    this.events.emit('player:revived', {
      health: this.s.health,
      chargesLeft: this.reviveCharges,
      invulnerability: this.invulnTime,
    });
    this.syncStats();
    const dropped = before - this.reviveGranted;
    if (dropped > 0) this.reviveUsed = Math.max(0, this.reviveUsed - dropped);
  }

  /** Re-derive the effective def when the stats changed (cheap version compare otherwise). */
  private syncStats(force = false): void {
    const st = this.stats;
    if (!force && (!st || st.version === this.statsVersion)) return;
    this.statsVersion = st ? st.version : -1;
    const def = this.def;
    const eff = this.eff;
    const ratio = (id: string): number => (st ? statRatio(st, id) : 1);
    const factor = (id: string): number => {
      const v = st ? st.value(id) : 1;
      return v >= 0 && Number.isFinite(v) ? v : 1;
    };
    const oldMaxHealth = eff.maxHealth;
    const oldMaxArmor = eff.maxArmor;
    eff.maxHealth = def.maxHealth * ratio('maxHealth');
    eff.maxArmor = def.maxArmor * ratio('maxArmor');
    eff.regenDelay = def.regenDelay * ratio('regenDelay');
    eff.regenRate = def.regenRate * ratio('regenRate');
    this.damageTakenScale = factor('damageTaken');
    this.explosionScale = factor('explosionDamageTaken');
    this.fallScale = factor('fallDamageTaken');
    this.reviveGranted = st ? Math.max(0, Math.floor(st.value('reviveCharges'))) : 0;
    if (!this.dead) {
      // More max health arrives at once (a full bar stays full); less clamps.
      if (eff.maxHealth > oldMaxHealth) this.s.health += eff.maxHealth - oldMaxHealth;
      this.s.health = Math.min(this.s.health, eff.maxHealth);
    }
    this.s.armor = Math.min(this.s.armor, eff.maxArmor);
    if (eff.maxHealth !== oldMaxHealth || eff.maxArmor !== oldMaxArmor) this.pendingAnnounce = true;
  }
}
