/**
 * What the interactables need from the rest of the game, as narrow adapters (tests use fakes):
 * prices (economy + perk table), the weapon inventory, perk info for the machines. Default
 * implementations read defs/economy.ts, defs/perks.ts and the concrete WeaponSystem.
 */
import { ECONOMY, ammoCost, doorCost, weaponCost } from '../defs/economy';
import { PERK_GLYPHS, PERK_IDS, getPerkDef } from '../defs/perks';
import type { WeaponSystem } from '../weapons/WeaponSystem';

/** Weapon inventory as seen by wall buys and the box. */
export interface InteractableWeapons {
  /** The player carries this weapon. */
  owns(weaponId: string): boolean;
  /** Add it (or refill + switch to it when already carried). */
  give(weaponId: string): void;
  /** Optional: reserve and magazine are full (the wall buy refuses a pointless refill). */
  ammoFull?(weaponId: string): boolean;
}

/** Purchase prices (points). */
export interface InteractablePrices {
  weapon(weaponId: string): number;
  /** Wall-buy refill of a carried weapon. */
  ammo(weaponId: string): number;
  door(costHint: number, blast: boolean): number;
  box(): number;
  perk(perkId: string): number;
}

/** A perk as a machine shows it. */
export interface PerkMachineInfo {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
  readonly tagline: string;
  /** Neon color, sRGB hex. */
  readonly color: number;
  /** SVG path data of the logo glyph (24 × 24 box, stroke only), '' = none. */
  readonly glyph: string;
}

/** Prices from the economy defs (and the perk table for perks). */
export function createDefaultPrices(): InteractablePrices {
  return {
    weapon: (id) => weaponCost(id),
    ammo: (id) => ammoCost(weaponCost(id)),
    door: (hint, blast) => doorCost(hint, blast),
    box: () => ECONOMY.costs.box,
    perk: (id) => getPerkDef(id)?.price ?? ECONOMY.costs.weaponDefault,
  };
}

/** Machine info of every perk in table order (defs/perks.ts). */
export function defaultPerkMachineInfos(): PerkMachineInfo[] {
  const out: PerkMachineInfo[] = [];
  for (const id of PERK_IDS) {
    const def = getPerkDef(id);
    if (!def) continue;
    out.push({
      id,
      name: def.name,
      tagline: def.tagline,
      color: def.color,
      glyph: PERK_GLYPHS[def.icon] ?? '',
    });
  }
  return out;
}

/** The subset of WeaponSystem the adapter reads (all allocation-free). */
export type WeaponAdapterSource = Pick<WeaponSystem, 'effectiveDef' | 'give' | 'currentWeaponId' | 'ammo'>;

/**
 * InteractableWeapons over the weapon system. `ammoFull` is only known for the weapon in hand
 * (the system reports ammo of the current weapon); other carried weapons always accept a refill.
 */
export function createWeaponAdapter(weapons: WeaponAdapterSource): InteractableWeapons {
  return {
    owns: (id) => weapons.effectiveDef(id) !== null,
    give: (id) => weapons.give(id),
    ammoFull: (id) => {
      if (weapons.currentWeaponId !== id) return false;
      const def = weapons.effectiveDef(id);
      const ammo = weapons.ammo;
      return def !== null && ammo !== null && ammo.reserve >= def.reserve && ammo.mag >= ammo.magSize;
    },
  };
}

/** `{name}` / `{short}` placeholders of the prompt defs. */
export function formatPrompt(template: string, name: string, short = name): string {
  return template.replace('{name}', name).replace('{short}', short);
}
