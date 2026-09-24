/**
 * Rift Forge (logic; visuals: visuals/RiftForgeView.ts): upgrades the HELD weapon one Rift Forge
 * tier (defs/forge.ts; the price is the def's `upgrades[tier].cost`).
 *
 * A purchase applies the tier at once through WeaponSystem.setWeaponMods (refill, forge:upgraded:
 * the HUD shows the new name, package D plays the forge.upgrade sequence sound) and hands the
 * weapon to the machine: it is lowered out of view and does nothing until the machine hands it
 * back at RIFT_FORGE_MACHINE.sequence.releaseAt, now wearing its forged look (the viewmodel swaps
 * the look while it is out of view). The machine is busy for the whole sequence (empty prompt: not
 * focusable). A death or a new run ends the sequence and hands the weapon back at once. An
 * unaffordable press is refused by the economy (economy:purchase kind 'forge', ok false: the HUD
 * denial and the forge.deny sound).
 *
 * Prompts are cached per (held weapon, tier): prompt()/cost() run every tick without allocating.
 */
import type { Vector3 } from 'three';
import type { EconomyApi, Interactable } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { FORGE, forgeTierCost, nextForgeTier } from '../defs/forge';
import { RIFT_FORGE_MACHINE } from '../defs/workshop';
import { getWeaponDef, type WeaponDef } from '../defs/weapons';
import type { WeaponModState } from '../weapons/resolveWeapon';

/** The weapon inventory as the forge and the bench see it (WeaponSystem satisfies it). */
export interface WorkshopWeapons {
  readonly currentWeaponId: string | null;
  /** Weapon state machine state ('holstering' / 'equipping': the hand is changing). */
  readonly state: string;
  effectiveDef(weaponId: string): WeaponDef | null;
  modsOf(weaponId: string): WeaponModState | null;
  setWeaponMods(weaponId: string, mods: WeaponModState): boolean;
}

/** Hands the held weapon to a machine and back (WeaponSystem.setStowed + ViewmodelRig.setStowed). */
export interface WorkshopHands {
  stow(): void;
  release(): void;
}

/** What the forge view reads every frame. */
export interface RiftForgeReadout {
  readonly forging: boolean;
  /** Seconds into the sequence (0 when idle). */
  readonly time: number;
  /** Weapon on the anvil and the tier it was forged to (null / 0 when idle). */
  readonly weaponId: string | null;
  readonly tier: number;
  /** The weapon went back to the player (after releaseAt). */
  readonly released: boolean;
}

export interface RiftForgeViewApi {
  /** A sequence started for `weaponId` at `tier`. */
  begin(weaponId: string, tier: number): void;
  /** Anvil strike `index` (0-based) of the running sequence. */
  strike(index: number): void;
  /** The weapon goes back to the player. */
  release(): void;
  update(dt: number, time: number, readout: RiftForgeReadout): void;
  dispose(): void;
}

export interface RiftForgeDeps {
  weapons: WorkshopWeapons;
  economy: Pick<EconomyApi, 'spend' | 'earn'>;
  hands?: WorkshopHands | null;
  view?: RiftForgeViewApi | null;
  /** Death (player:died) ends a running sequence; strikes shake the camera of a player nearby. */
  events?: EventBus<GameEvents> | null;
  /** Player feet (strike shake distance); null = no shake. */
  player?: { readonly position: Vec3Like } | null;
  /** Base defs (upgrade tiers); default: the static weapon table. */
  defs?: (weaponId: string) => WeaponDef | undefined;
  /** Solid volume (collider, bullets, nav) disposed with the machine. */
  blocker?: { dispose(): void } | null;
}

type ForgeOffer = 'none' | 'busy' | 'max' | 'upgrade';

const SEQ = RIFT_FORGE_MACHINE.sequence;

export class RiftForge implements Interactable {
  readonly id: string;
  readonly range = RIFT_FORGE_MACHINE.range;
  private forging = false;
  private time = 0;
  private released = true;
  private forgedWeapon: string | null = null;
  private forgedTier = 0;
  private nextStrike = 0;
  private readonly lookupDef: (id: string) => WeaponDef | undefined;
  private readonly unsubs: (() => void)[] = [];
  private readonly shakePayload: GameEvents['camera:shake'] = { trauma: 0 };
  // Offer cache (held weapon + its tier).
  private cacheWeapon: string | null = null;
  private cacheTier = -1;
  private cacheOffer: ForgeOffer = 'none';
  private cachePrompt: string = FORGE.prompts.noWeapon;
  private cacheCost: number | null = null;
  private readonly readoutState = {
    forging: false,
    time: 0,
    weaponId: null as string | null,
    tier: 0,
    released: true,
  };
  private disposed = false;

  constructor(
    id: string,
    readonly position: Vector3,
    private readonly deps: RiftForgeDeps,
  ) {
    this.id = id;
    this.lookupDef = deps.defs ?? getWeaponDef;
    if (deps.events) this.unsubs.push(deps.events.on('player:died', () => this.abort()));
  }

  /** A sequence is running (the machine is busy). */
  get busy(): boolean {
    return this.forging;
  }

  get readout(): RiftForgeReadout {
    const r = this.readoutState;
    r.forging = this.forging;
    r.time = this.time;
    r.weaponId = this.forgedWeapon;
    r.tier = this.forgedTier;
    r.released = this.released;
    return r;
  }

  prompt(): string {
    if (this.forging) return '';
    this.refreshOffer();
    return this.cachePrompt;
  }

  cost(): number | null {
    if (this.forging) return null;
    this.refreshOffer();
    return this.cacheCost;
  }

  canInteract(): boolean {
    if (this.forging || this.disposed) return false;
    return this.refreshOffer() === 'upgrade';
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    if (!this.canInteract()) return;
    const { weapons, economy } = this.deps;
    const id = weapons.currentWeaponId;
    const base = id ? this.lookupDef(id) : undefined;
    if (!id || !base) return;
    const mods = weapons.modsOf(id);
    const next = nextForgeTier(base, mods?.tier ?? 0);
    if (!next) return;
    const price = forgePrice(next.cost, next.tier);
    if (!economy.spend(price, `forge:${id}`, 'forge')) return;
    if (!weapons.setWeaponMods(id, { ...(mods ?? {}), tier: next.tier })) {
      economy.earn(price, 'refund');
      return;
    }
    this.forging = true;
    this.time = 0;
    this.nextStrike = 0;
    this.released = false;
    this.forgedWeapon = id;
    this.forgedTier = next.tier;
    this.cacheWeapon = null;
    this.deps.hands?.stow();
    this.deps.view?.begin(id, next.tier);
  }

  fixedUpdate(dt: number): void {
    if (!this.forging || !(dt > 0)) return;
    this.time += dt;
    const strikes = SEQ.strikes;
    while (this.nextStrike < strikes.length && this.time >= strikes[this.nextStrike]!) {
      this.deps.view?.strike(this.nextStrike);
      this.shake();
      this.nextStrike++;
    }
    if (!this.released && this.time >= SEQ.releaseAt) this.release();
    if (this.time >= SEQ.duration) this.finish();
  }

  update(dt: number, time: number): void {
    this.deps.view?.update(dt, time, this.readout);
  }

  /** End a running sequence now (death, new run): the weapon goes back to the player. */
  abort(): void {
    if (!this.forging) return;
    this.release();
    this.finish();
  }

  /** New run: machine idle, nothing on the anvil. */
  reset(): void {
    this.abort();
    this.cacheWeapon = null;
    this.cacheTier = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.abort();
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.deps.blocker?.dispose();
    this.deps.view?.dispose();
  }

  // -------------------------------------------------------------------------

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.deps.hands?.release();
    this.deps.view?.release();
  }

  private finish(): void {
    this.forging = false;
    this.time = 0;
    this.forgedWeapon = null;
    this.forgedTier = 0;
    this.cacheWeapon = null;
  }

  /** What the forge offers for the weapon in hand (cached per weapon + tier). */
  private refreshOffer(): ForgeOffer {
    const weapons = this.deps.weapons;
    const id = weapons.currentWeaponId;
    // The hand is changing: no weapon to hand over yet (not cached – it passes in a moment).
    if (id && (weapons.state === 'holstering' || weapons.state === 'equipping')) {
      this.cacheWeapon = null;
      this.cacheOffer = 'busy';
      this.cachePrompt = RIFT_FORGE_MACHINE.prompts.busy;
      this.cacheCost = null;
      return 'busy';
    }
    const tier = id ? (weapons.modsOf(id)?.tier ?? 0) : 0;
    if (id === this.cacheWeapon && tier === this.cacheTier && this.cacheOffer !== 'busy') {
      return this.cacheOffer;
    }
    this.cacheWeapon = id;
    this.cacheTier = tier;
    const base = id ? this.lookupDef(id) : undefined;
    if (!id || !base) {
      this.cacheOffer = 'none';
      this.cachePrompt = FORGE.prompts.noWeapon;
      this.cacheCost = null;
      return 'none';
    }
    const next = nextForgeTier(base, tier);
    if (!next) {
      this.cacheOffer = 'max';
      this.cachePrompt = FORGE.prompts.maxTier;
      this.cacheCost = null;
      return 'max';
    }
    const name = weapons.effectiveDef(id)?.name ?? base.name;
    this.cacheOffer = 'upgrade';
    this.cachePrompt = forgePrompt(name, next.tier);
    this.cacheCost = forgePrice(next.cost, next.tier);
    return 'upgrade';
  }

  private shake(): void {
    const events = this.deps.events;
    const p = this.deps.player?.position;
    if (!events || !p) return;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d > SEQ.shakeRange) return;
    this.shakePayload.trauma = SEQ.strikeShake * (1 - d / SEQ.shakeRange);
    events.emit('camera:shake', this.shakePayload);
  }
}

/** Price of a tier: the def's cost, else the FORGE table. */
export function forgePrice(defCost: number, tier: number): number {
  return defCost > 0 && Number.isFinite(defCost) ? defCost : forgeTierCost(tier);
}

/** "{name} schmieden ({tier})" with the next tier's label. */
export function forgePrompt(name: string, nextTier: number): string {
  const label = FORGE.tierLabels[nextTier - 1] ?? String(nextTier);
  return FORGE.prompts.upgrade.replace('{name}', name).replace('{tier}', label);
}
