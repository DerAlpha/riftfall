/**
 * Cosmetics owned and equipped (ProfileData.cosmetics, defs/cosmetics.ts): unlock sources
 * level / prestige / achievement are evaluated against the progression state, 'challenge'
 * cosmetics come from weekly challenge rewards, 'shop' ones are bought with Rift-Splitter
 * (the currency, also spent on skill respecs). Global camos live here too; weapon-scope camos
 * are per weapon (WeaponProgress).
 */
import type { CosmeticLoadout, CosmeticsData } from '../core/contracts';
import type { UnlockKind } from '../core/events';
import {
  CAMOS,
  COSMETICS,
  DEFAULT_COSMETICS,
  getCamoDef,
  getCosmeticDef,
  type CosmeticDef,
  type CosmeticUnlock,
} from '../defs/cosmetics';
import { PROGRESSION_LIMITS } from '../defs/progression';

export interface CosmeticHooks {
  onUnlock(kind: UnlockKind, id: string, name: string): void;
}

/** What unlock sources are checked against. */
export interface CosmeticContext {
  /** Highest level ever reached. */
  highestLevel: number;
  prestige: number;
  hasAchievement(id: string): boolean;
}

export type EquipSlot = keyof CosmeticLoadout;

const SLOT_KIND: Readonly<Record<EquipSlot, CosmeticDef['kind']>> = {
  crosshair: 'crosshair',
  killEffect: 'killEffect',
  charm: 'charm',
  emblem: 'emblem',
};

/** Ids of the weekly challenge reward pool. */
export function challengeCosmeticPool(): string[] {
  return COSMETICS.filter((c) => c.unlock.kind === 'challenge').map((c) => c.id);
}

export class CosmeticInventory {
  private data!: CosmeticsData;
  private owned = new Set<string>();

  constructor(
    data: CosmeticsData,
    private readonly hooks: CosmeticHooks,
  ) {
    this.attach(data);
  }

  attach(data: CosmeticsData): void {
    this.data = data;
    this.owned = new Set(data.unlocked);
  }

  get currency(): number {
    return this.data.currency;
  }

  get equipped(): Readonly<CosmeticLoadout> {
    return this.data.equipped;
  }

  /** Owned (default cosmetics always are). */
  has(id: string): boolean {
    if (this.owned.has(id)) return true;
    return getCosmeticDef(id)?.unlock.kind === 'default';
  }

  /** Unlock a cosmetic or global camo; false when unknown or already owned. */
  unlock(id: string): boolean {
    if (this.has(id)) return false;
    const def = getCosmeticDef(id);
    const camo = def ? undefined : getCamoDef(id);
    if (!def && (!camo || camo.scope !== 'global')) return false;
    if (this.data.unlocked.length >= PROGRESSION_LIMITS.maxUnlocked) return false;
    this.owned.add(id);
    this.data.unlocked.push(id);
    if (def) this.hooks.onUnlock(def.kind, id, def.name);
    else if (camo) this.hooks.onUnlock('camo', id, camo.name);
    return true;
  }

  /** Unlock everything whose level / prestige / achievement source is met. Returns the count. */
  evaluate(ctx: CosmeticContext): number {
    let n = 0;
    for (const def of COSMETICS) {
      if (!this.owned.has(def.id) && sourceMet(def.unlock, ctx) && this.unlock(def.id)) n++;
    }
    for (const camo of CAMOS) {
      if (camo.scope !== 'global' || this.owned.has(camo.id)) continue;
      const u = camo.unlock;
      const met =
        (u.kind === 'prestige' && ctx.prestige >= u.rank) ||
        (u.kind === 'achievement' && ctx.hasAchievement(u.id));
      if (met && this.unlock(camo.id)) n++;
    }
    return n;
  }

  addCurrency(amount: number): void {
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    this.data.currency = Math.min(PROGRESSION_LIMITS.maxCurrency, Math.floor(this.data.currency + amount));
  }

  spendCurrency(amount: number): boolean {
    const cost = Math.max(0, Math.round(amount));
    if (this.data.currency < cost) return false;
    this.data.currency -= cost;
    return true;
  }

  /** Buy a shop cosmetic with Rift-Splitter. */
  buy(id: string): boolean {
    const def = getCosmeticDef(id);
    if (!def || def.unlock.kind !== 'shop' || this.has(id)) return false;
    if (!this.spendCurrency(def.unlock.price)) return false;
    return this.unlock(id);
  }

  /** Equip an owned cosmetic of the slot's kind (null clears the optional slots). */
  equip(slot: EquipSlot, id: string | null): boolean {
    if (id === null) {
      if (slot !== 'charm' && slot !== 'emblem') return false;
      this.data.equipped[slot] = null;
      return true;
    }
    const def = getCosmeticDef(id);
    if (!def || def.kind !== SLOT_KIND[slot] || !this.has(id)) return false;
    this.data.equipped[slot] = id;
    return true;
  }

  /** Every owned id (defaults included). */
  list(): string[] {
    const out = COSMETICS.filter((c) => c.unlock.kind === 'default').map((c) => c.id);
    for (const id of this.data.unlocked) if (!out.includes(id)) out.push(id);
    return out;
  }

  /** Global camos owned (usable on every weapon). */
  globalCamos(): string[] {
    return this.data.unlocked.filter((id) => getCamoDef(id)?.scope === 'global');
  }
}

function sourceMet(u: CosmeticUnlock, ctx: CosmeticContext): boolean {
  switch (u.kind) {
    case 'level':
      return ctx.highestLevel >= u.level;
    case 'prestige':
      return ctx.prestige >= u.rank;
    case 'achievement':
      return ctx.hasAchievement(u.id);
    default:
      return false;
  }
}

/** The default loadout (fresh profiles, repaired equip slots). */
export function defaultCosmeticLoadout(): CosmeticLoadout {
  return { ...DEFAULT_COSMETICS };
}
