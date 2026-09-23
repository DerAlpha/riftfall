/**
 * Player health/armor. Pure state functions (unit-tested) + a thin class that emits events.
 * Armor absorbs `armorAbsorb` of incoming damage while it lasts; health regenerates after
 * `regenDelay` seconds without damage.
 */
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { PLAYER, type PlayerHealthDef } from '../defs/player';

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

export class PlayerHealth {
  /** Local god mode flag (in addition to `deps.player.godMode`). */
  godMode = false;
  readonly maxHealth: number;
  readonly maxArmor: number;

  private readonly events: EventBus<GameEvents>;
  private readonly player: { readonly godMode: boolean } | undefined;
  private readonly def: PlayerHealthDef;
  private readonly s: HealthState;
  /** Last health value (rounded up) announced via player:healthChanged during regen. */
  private lastAnnounced = -1;

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
    this.maxHealth = def.maxHealth;
    this.maxArmor = def.maxArmor;
    this.s = { health: def.startHealth, armor: def.startArmor, sinceDamage: Number.POSITIVE_INFINITY };
  }

  get health(): number {
    return this.s.health;
  }
  get armor(): number {
    return this.s.armor;
  }
  get fraction(): number {
    return this.maxHealth > 0 ? this.s.health / this.maxHealth : 0;
  }
  get dead(): boolean {
    return this.s.health <= 0;
  }
  get timeSinceDamage(): number {
    return this.s.sinceDamage;
  }
  private get invulnerable(): boolean {
    return this.godMode || (this.player?.godMode ?? false);
  }

  /**
   * Apply damage. Ignored in god mode or when dead (no events). Emits `player:damaged`
   * (amount = health + armor actually removed) and `player:healthChanged`. Returns the amount.
   */
  damage(amount: number, direction?: Vec3Like): number {
    if (this.invulnerable || this.dead) return 0;
    applyDamage(this.s, amount, this.def, _split);
    const total = _split.toArmor + _split.toHealth;
    if (total <= 0) return 0;
    this.events.emit('player:damaged', { amount: total, healthFraction: this.fraction, direction });
    this.announce();
    return total;
  }

  /** Restore health (not above max, not while dead). Returns the amount healed. */
  heal(amount: number): number {
    if (this.dead || !(amount > 0)) return 0;
    const before = this.s.health;
    this.s.health = Math.min(this.maxHealth, this.s.health + amount);
    const gained = this.s.health - before;
    if (gained > 0) this.announce();
    return gained;
  }

  /** Add armor up to max. Returns the amount added. */
  addArmor(amount: number): number {
    if (!(amount > 0)) return 0;
    const before = this.s.armor;
    this.s.armor = Math.min(this.maxArmor, this.s.armor + amount);
    const gained = this.s.armor - before;
    if (gained > 0) this.announce();
    return gained;
  }

  /** Back to start values (respawn / new run). */
  reset(): void {
    this.s.health = this.def.startHealth;
    this.s.armor = this.def.startArmor;
    this.s.sinceDamage = Number.POSITIVE_INFINITY;
    this.announce();
  }

  /** Regeneration tick. */
  fixedUpdate(dt: number): void {
    if (regenerate(this.s, this.def, dt) <= 0) return;
    // Only announce whole-point changes (and reaching the cap) to keep HUD updates cheap.
    const rounded = Math.ceil(this.s.health);
    if (rounded !== this.lastAnnounced || this.s.health >= this.maxHealth * this.def.regenCapFraction)
      this.announce();
  }

  /** Emit the current values (e.g. once after construction so the HUD initialises). */
  announce(): void {
    this.lastAnnounced = Math.ceil(this.s.health);
    this.events.emit('player:healthChanged', {
      health: this.s.health,
      maxHealth: this.maxHealth,
      armor: this.s.armor,
      maxArmor: this.maxArmor,
    });
  }

  dispose(): void {
    // Nothing subscribed/allocated; present for lifecycle symmetry.
  }
}
