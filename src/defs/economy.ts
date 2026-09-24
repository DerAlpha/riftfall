/**
 * Economy tuning (M4): start points, CoD-Zombies-style point rewards, prices. Systems:
 * EconomySystem (balance, earn/spend), PointsRules (combat → points), PerkSystem (perk prices live
 * in defs/perks.ts), interactables (doors, wall buys, box, seals) read their prices here.
 *
 * Point rewards (PointsRules, player-caused only):
 * - a hit that does not kill: `hit` per damage event (a shotgun blast is one event per hit zone);
 * - the killing blow: `kill` / `headshotKill` (head or weakpoint) / `meleeKill` – these include the
 *   hit, nothing else is paid for it;
 * - elite kills add `eliteKillBonus`; a completed wave pays waveBonus(wave);
 * - nuke kills pay `nukeKill` each (0: the nuke's flat `powerUps.nukeBonus` is paid by the power-up).
 * Only enemies earn points: damageable ids in [rewardIdMin, rewardIdMax] (the enemy manager's id
 * range; training dummies start at 1_000_000), minus ids flagged with PointsRules.flagNoReward
 * (dev-console spawns that should not pay).
 *
 * Every earning is scaled by the pointsMultiplier stat (Double Points ×2) except `unscaledReasons`.
 */
import type { PointsReason } from '../core/events';
import { ENEMY_AI } from './enemies';
import { getWeaponDef } from './weapons';

export interface WaveBonusDef {
  readonly base: number;
  readonly perWave: number;
  readonly max: number;
}

export const ECONOMY = {
  /** Points at the start of a run (CoD: 500). */
  startPoints: 500,
  /** Points are whole numbers: earnings (after the multiplier) round to this step. */
  roundTo: 1,

  points: {
    hit: 10,
    kill: 60,
    headshotKill: 100,
    meleeKill: 130,
    /** Zones that count as a headshot kill. */
    headshotZones: ['head', 'weakpoint'] as readonly string[],
    eliteKillBonus: 50,
    nukeKill: 0,
    /** Completed wave n pays min(max, base + perWave × n). */
    wave: { base: 50, perWave: 10, max: 400 } satisfies WaveBonusDef,
    /** Damageable id range that pays points (enemies); see the file header. */
    rewardIdMin: ENEMY_AI.firstId,
    rewardIdMax: ENEMY_AI.maxId,
  },

  /** Reasons that are never scaled by pointsMultiplier (refunds, dev grants, spending). */
  unscaledReasons: ['refund', 'dev', 'purchase'] as readonly PointsReason[],

  /** Barricade (seal) repairs: points per restored plank, capped per wave (anti-farming). */
  repair: {
    perPlank: 10,
    capPerWave: 500,
  },

  costs: {
    /** Door without a costHint from the map. */
    doorDefault: 750,
    /** Heavy blast doors without a costHint. */
    blastDoorDefault: 1500,
    /** Mystery Box roll. */
    box: 950,
    /** Mystery Box during a fire sale (reserved for a later power-up). */
    boxFireSale: 10,
    /** Wall-buy ammo refill = weapon price × this, rounded up to `ammoRoundTo`. */
    ammoFactor: 0.5,
    ammoRoundTo: 10,
    /** Wall buy of a weapon without a price in its def. */
    weaponDefault: 1000,
    /** Rift Forge (M5): upgrade a weapon to tier 1. */
    forge: 5000,
  },

  /** Flat power-up rewards (paid by the power-up system through EconomyApi.earn). */
  powerUps: {
    /** Nuke ('nuke' reason). */
    nukeBonus: 400,
    /** Carpenter equivalent ('carpenter' reason): all seals restored. */
    carpenterBonus: 200,
  },
} as const;

/** Completed-wave bonus (points before the multiplier). */
export function waveBonus(wave: number, def: WaveBonusDef = ECONOMY.points.wave): number {
  if (!(wave >= 1)) return 0;
  return Math.max(0, Math.min(def.max, def.base + def.perWave * Math.floor(wave)));
}

/** Price of a wall-buy weapon (its def's `cost`, else the default). */
export function weaponCost(weaponId: string): number {
  const def = getWeaponDef(weaponId);
  return def && def.cost > 0 ? def.cost : ECONOMY.costs.weaponDefault;
}

/** Wall-buy ammo for a weapon costing `weaponPrice`: half the price, rounded up to 10. */
export function ammoCost(weaponPrice: number): number {
  const c = ECONOMY.costs;
  if (!(weaponPrice > 0)) return 0;
  return Math.ceil((weaponPrice * c.ammoFactor) / c.ammoRoundTo) * c.ammoRoundTo;
}

/** Door price: the map's hint when positive, else the default for its kind. */
export function doorCost(costHint: number | undefined, blast = false): number {
  if (costHint !== undefined && costHint > 0 && Number.isFinite(costHint)) return Math.round(costHint);
  return blast ? ECONOMY.costs.blastDoorDefault : ECONOMY.costs.doorDefault;
}
