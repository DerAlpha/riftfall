/**
 * Perks (PerkApi) from defs/perks.ts. Granting applies the perk's stat modifiers (one batch → one
 * stats:changed) under the source `perk:<id>` and starts its special hook (perkHooks.ts); revoking
 * removes exactly that source (stats return to their previous values bit for bit) and disposes the
 * hook. At most `perkSlots` (stat) perks; lowering the stat later keeps what is owned.
 *
 * Revive (decision, see defs/perks.ts): when a revive charge saves the player (player:revived), the
 * perks with `lostOnRevive` (Phoenix-Protokoll) are revoked synchronously – PlayerHealth counts
 * that as the consumed charge – and every other perk is kept.
 *
 * Buying: interactables call `buy(perkId, economy)` (checks → atomic spend → grant) or check
 * `canGrant` themselves. `grant` alone is free (dev console, rewards).
 */
import type { EconomyApi, PerkApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import { PERK_IDS, getPerkDef, perkSource, type PerkDef, type PerkHookId } from '../defs/perks';
import {
  PERK_HOOKS,
  type PerkCombatApi,
  type PerkHook,
  type PerkHookContext,
  type PerkStatsApi,
} from './perkHooks';

const log = createLogger('perks');

export interface PerkSystemDeps {
  events: EventBus<GameEvents>;
  stats: PerkStatsApi;
  /** Blast damage of hook perks (CombatWorld); null = blasts deal no damage. */
  combat?: PerkCombatApi | null;
  /** Player feet (live vector). */
  player?: { readonly position: Vec3Like } | null;
  /** Seed of the hooks' gameplay randomness (Aasgeier drops). */
  seed?: string | number;
  /** Hook blast VFX; default emits combat:explosion (VFX + sound + shake). */
  blastFx?: PerkHookContext['blastFx'];
  /** Aasgeier ammo pickup spawner (power-up system); null = the perk only raises dropChance. */
  dropAmmo?: ((position: Vec3Like) => void) | null;
  /** Perk table lookup override (tests). */
  defs?: (id: string) => PerkDef | undefined;
}

export type PerkPurchaseResult = 'ok' | 'unknown' | 'owned' | 'full' | 'unaffordable';

export class PerkSystem implements PerkApi {
  private readonly events: EventBus<GameEvents>;
  private readonly stats: PerkStatsApi;
  private readonly lookup: (id: string) => PerkDef | undefined;
  private readonly ctx: PerkHookContext;
  private readonly _owned: string[] = [];
  private readonly hooks = new Map<string, PerkHook>();
  private readonly hookList: PerkHook[] = [];
  private readonly unsubscribe: (() => void)[];
  private dropAmmo: ((position: Vec3Like) => void) | null;

  constructor(deps: PerkSystemDeps) {
    this.events = deps.events;
    this.stats = deps.stats;
    this.lookup = deps.defs ?? getPerkDef;
    this.dropAmmo = deps.dropAmmo ?? null;
    const events = deps.events;
    this.ctx = {
      events,
      stats: deps.stats,
      combat: deps.combat ?? null,
      player: deps.player ?? null,
      rng: new Rng(deps.seed ?? 'perks'),
      blastFx:
        deps.blastFx ??
        ((position: Vec3Like, radius: number, element: DamageElement) =>
          events.emit('combat:explosion', {
            position: { x: position.x, y: position.y, z: position.z },
            radius,
            element,
          })),
      // Late-bound: the power-up system may be built after the perks.
      ammoDrop: () => this.dropAmmo,
    };
    this.unsubscribe = [events.on('player:revived', () => this.onRevived())];
  }

  get owned(): readonly string[] {
    return this._owned;
  }

  get maxPerks(): number {
    return Math.max(0, Math.floor(this.stats.value('perkSlots')));
  }

  /** Every perk id of the table (machines, console). */
  get all(): readonly string[] {
    return PERK_IDS;
  }

  def(perkId: string): PerkDef | undefined {
    return this.lookup(perkId);
  }

  has(perkId: string): boolean {
    return this._owned.includes(perkId);
  }

  /** Why a grant would fail right now ('ok' when it would succeed; never 'unaffordable'). */
  check(perkId: string): Exclude<PerkPurchaseResult, 'unaffordable'> {
    if (!this.lookup(perkId)) return 'unknown';
    if (this.has(perkId)) return 'owned';
    if (this._owned.length >= this.maxPerks) return 'full';
    return 'ok';
  }

  canGrant(perkId: string): boolean {
    return this.check(perkId) === 'ok';
  }

  grant(perkId: string): boolean {
    if (this.check(perkId) !== 'ok') return false;
    const def = this.lookup(perkId)!;
    const source = perkSource(perkId);
    this.stats.batch(() => {
      for (const m of def.modifiers)
        this.stats.addModifier({ source, stat: m.stat, op: m.op, value: m.value });
    });
    if (def.hook) this.startHook(perkId, def.hook);
    this._owned.push(perkId);
    this.events.emit('perk:acquired', { perkId, slot: this._owned.length - 1 });
    return true;
  }

  /**
   * Machine purchase: validity and limit first, then the atomic spend (economy:purchase), then the
   * grant. Nothing is charged unless the perk is granted.
   */
  buy(perkId: string, economy: Pick<EconomyApi, 'spend' | 'canAfford'>): PerkPurchaseResult {
    const check = this.check(perkId);
    if (check !== 'ok') return check;
    const def = this.lookup(perkId)!;
    if (!economy.spend(def.price, perkId, 'perk')) return 'unaffordable';
    this.grant(perkId);
    return 'ok';
  }

  revoke(perkId: string): void {
    const i = this._owned.indexOf(perkId);
    if (i < 0) return;
    this._owned.splice(i, 1);
    this.stopHook(perkId);
    this.stats.removeSource(perkSource(perkId));
    this.events.emit('perk:lost', { perkId });
  }

  clear(): void {
    for (let i = this._owned.length - 1; i >= 0; i--) this.revoke(this._owned[i]!);
  }

  /** Hand the Aasgeier ammo spawner over once the power-up system exists. */
  setAmmoDropHandler(drop: ((position: Vec3Like) => void) | null): void {
    this.dropAmmo = drop;
  }

  /** Hook timers (cooldowns, buff decay). Fixed tick. */
  fixedUpdate(dt: number): void {
    const list = this.hookList;
    for (let i = 0; i < list.length; i++) list[i]!.fixedUpdate?.(dt);
  }

  dispose(): void {
    this.clear();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  private onRevived(): void {
    for (let i = this._owned.length - 1; i >= 0; i--) {
      const id = this._owned[i]!;
      if (this.lookup(id)?.lostOnRevive) this.revoke(id);
    }
  }

  private startHook(perkId: string, hookId: PerkHookId): void {
    const factory = PERK_HOOKS[hookId];
    if (!factory) {
      log.warn(`Perk "${perkId}": unknown hook "${hookId}" – stats only`);
      return;
    }
    try {
      const hook = factory(this.ctx, perkId);
      this.hooks.set(perkId, hook);
      this.hookList.push(hook);
    } catch (err) {
      log.warn(`Perk "${perkId}": hook "${hookId}" failed to start – stats only`, err);
    }
  }

  private stopHook(perkId: string): void {
    const hook = this.hooks.get(perkId);
    if (!hook) return;
    this.hooks.delete(perkId);
    const i = this.hookList.indexOf(hook);
    if (i >= 0) this.hookList.splice(i, 1);
    hook.dispose();
  }
}
