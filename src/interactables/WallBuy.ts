/**
 * Wall buy (logic; visuals: visuals/WallBuyView.ts): buys its weapon, or – once carried – a refill
 * of that weapon's ammo at the ammo price (WeaponSystem.give refills a carried weapon and raises
 * it). A full weapon in hand refuses the refill ("Munition voll").
 */
import type { Vector3 } from 'three';
import type { EconomyApi, Interactable } from '../core/contracts';
import { INTERACTION, WALL_BUYS } from '../defs/interactables';
import { formatPrompt, type InteractablePrices, type InteractableWeapons } from './types';

export interface WallBuyViewApi {
  /** The player carries the weapon (the board offers ammo). */
  setOwned(owned: boolean): void;
  /** A purchase went through. */
  flash(): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface WallBuyDeps {
  weapons: InteractableWeapons;
  economy: Pick<EconomyApi, 'spend'>;
  prices: Pick<InteractablePrices, 'weapon' | 'ammo'>;
  view?: WallBuyViewApi | null;
}

export interface WallBuyOptions {
  id: string;
  weaponId: string;
  /** Player-facing names (defs/weapons name / shortName). */
  name: string;
  shortName: string;
  /** Prompt anchor (in front of the board). */
  position: Vector3;
}

export class WallBuy implements Interactable {
  readonly id: string;
  readonly weaponId: string;
  readonly position: Vector3;
  readonly range = INTERACTION.range.wallBuy;
  readonly weaponPrice: number;
  readonly ammoPrice: number;
  private readonly promptBuy: string;
  private readonly promptAmmo: string;
  private shownOwned: boolean | null = null;

  constructor(
    opts: WallBuyOptions,
    private readonly deps: WallBuyDeps,
  ) {
    this.id = opts.id;
    this.weaponId = opts.weaponId;
    this.position = opts.position;
    this.weaponPrice = deps.prices.weapon(opts.weaponId);
    this.ammoPrice = deps.prices.ammo(opts.weaponId);
    this.promptBuy = formatPrompt(WALL_BUYS.prompts.buy, opts.name, opts.shortName);
    this.promptAmmo = formatPrompt(WALL_BUYS.prompts.ammo, opts.name, opts.shortName);
  }

  get owned(): boolean {
    return this.deps.weapons.owns(this.weaponId);
  }

  private get full(): boolean {
    return this.deps.weapons.ammoFull?.(this.weaponId) === true;
  }

  prompt(): string {
    if (!this.owned) return this.promptBuy;
    return this.full ? WALL_BUYS.prompts.ammoFull : this.promptAmmo;
  }

  cost(): number | null {
    if (!this.owned) return this.weaponPrice;
    return this.full ? null : this.ammoPrice;
  }

  canInteract(): boolean {
    return !(this.owned && this.full);
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    const { economy, weapons } = this.deps;
    if (weapons.owns(this.weaponId)) {
      if (this.full || !economy.spend(this.ammoPrice, `ammo:${this.weaponId}`, 'ammo')) return;
    } else if (!economy.spend(this.weaponPrice, this.weaponId, 'weapon')) {
      return;
    }
    weapons.give(this.weaponId);
    this.deps.view?.flash();
  }

  update(dt: number, time: number): void {
    const view = this.deps.view;
    if (!view) return;
    const owned = this.owned;
    if (owned !== this.shownOwned) {
      this.shownOwned = owned;
      view.setOwned(owned);
    }
    view.update(dt, time);
  }

  /** New run: the board shows the weapon offer again (the loadout was reset). */
  reset(): void {
    this.shownOwned = null;
  }

  dispose(): void {
    this.deps.view?.dispose();
  }
}
