/**
 * Perk machine (logic; visuals: visuals/PerkMachineView.ts): buys its perk through
 * EconomyApi.spend + PerkApi.grant – a grant that fails after paying (limit reached meanwhile,
 * unknown perk) refunds the price. Owned perks show "Bereits aktiv", a full perk rack "Perk-Limit
 * erreicht" (no cost, not usable). Perks lost later (revive, new run) make the machine buyable
 * again: availability is read live from PerkApi.
 */
import type { Vector3 } from 'three';
import type { EconomyApi, Interactable, PerkApi } from '../core/contracts';
import { INTERACTION, PERK_MACHINES } from '../defs/interactables';
import { formatPrompt, type PerkMachineInfo } from './types';

export type PerkAvailability = 'available' | 'owned' | 'limit';

export interface PerkMachineViewApi {
  setAvailability(a: PerkAvailability): void;
  /** A purchase went through. */
  flash(): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface PerkMachineDeps {
  perks: Pick<PerkApi, 'has' | 'grant' | 'owned' | 'maxPerks'>;
  economy: Pick<EconomyApi, 'spend' | 'earn'>;
  price: number;
  view?: PerkMachineViewApi | null;
  /** Collider + bullets + nav of the cabinet (disposed with the machine). */
  blocker?: { dispose(): void } | null;
}

export class PerkMachine implements Interactable {
  readonly id: string;
  readonly perkId: string;
  readonly perk: PerkMachineInfo;
  readonly range = INTERACTION.range.perk;
  readonly price: number;
  private readonly promptBuy: string;
  private shown: PerkAvailability | null = null;

  constructor(
    perk: PerkMachineInfo,
    readonly position: Vector3,
    private readonly deps: PerkMachineDeps,
  ) {
    this.perk = perk;
    this.perkId = perk.id;
    this.id = `perk:${perk.id}`;
    this.price = deps.price;
    this.promptBuy = formatPrompt(PERK_MACHINES.prompts.buy, perk.name);
  }

  get availability(): PerkAvailability {
    const perks = this.deps.perks;
    if (perks.has(this.perkId)) return 'owned';
    return perks.owned.length >= perks.maxPerks ? 'limit' : 'available';
  }

  prompt(): string {
    switch (this.availability) {
      case 'owned':
        return PERK_MACHINES.prompts.owned;
      case 'limit':
        return PERK_MACHINES.prompts.limit;
      default:
        return this.promptBuy;
    }
  }

  cost(): number | null {
    return this.availability === 'available' ? this.price : null;
  }

  canInteract(): boolean {
    return this.availability === 'available';
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    if (this.availability !== 'available') return;
    const { economy, perks } = this.deps;
    if (!economy.spend(this.price, this.id, 'perk')) return;
    if (!perks.grant(this.perkId)) {
      economy.earn(this.price, 'refund');
      return;
    }
    this.deps.view?.flash();
  }

  update(dt: number, time: number): void {
    const view = this.deps.view;
    if (!view) return;
    const a = this.availability;
    if (a !== this.shown) {
      this.shown = a;
      view.setAvailability(a);
    }
    view.update(dt, time);
  }

  dispose(): void {
    this.deps.blocker?.dispose();
    this.deps.view?.dispose();
  }
}
