/**
 * Gameplay stats (M4+): every build-changing system – perks (M4), Rift Forge (M5), roguelite cards
 * (M8), skill tree (M9) – changes gameplay through stat modifiers (StatsApi, src/stats/StatSystem)
 * instead of hard-coded bonuses. value = clamp((base + Σadd) × Πmul, min, max), integer stats are
 * rounded down after clamping.
 *
 * Kinds of stats:
 * - Multipliers (base 1): consumers multiply their def values (fire rate ×1.33 → rpm × 1.33).
 *   "Speed" stats (fireRate, reloadSpeed, adsSpeed, dashRecharge) are RATES: durations divide by them.
 *   "Taken" stats (damageTaken, explosionDamageTaken, fallDamageTaken) scale incoming damage.
 * - Absolute values (maxHealth, maxArmor, regenDelay, regenRate, dashCharges, perkSlots,
 *   reviveCharges): the base is the def value. Consumers with their own def (PlayerHealth test defs)
 *   apply the RATIO value/base (statRatio), so a custom def scales the same way.
 * - weaponSlots is an ADD-ONLY BONUS (base 0): the inventory size is the map loadout's slots
 *   (WEAPON_RULES.loadouts) + this bonus, clamped to WEAPON_RULES.inventory.maxSlots. Maps keep
 *   their own base; a perk adds on top of whatever the map grants.
 */
import { MOVEMENT } from './movement';
import { PLAYER } from './player';
import { WEAPON_RULES } from './weapons';

export type StatFormat =
  /** ×1.25 */
  | 'multiplier'
  /** 3 */
  | 'count'
  /** 4.5 s / 22 HP/s (with `unit`) */
  | 'value';

export interface StatDef {
  readonly base: number;
  readonly min: number;
  readonly max: number;
  /** Player-facing label (German): stats readout, perk tooltips, skill tree. */
  readonly label: string;
  readonly format: StatFormat;
  /** Unit suffix for 'value' stats (German). */
  readonly unit?: string;
  /** Whole numbers (counts): rounded down after clamping. */
  readonly integer?: boolean;
  /**
   * For the UI: true when a LOWER value is better (damage taken, regen delay, spread, recoil) –
   * a perk tooltip colours "−30 % Rückstoß" as a buff.
   */
  readonly lowerIsBetter?: boolean;
}

const MUL_MIN = 0;
const MUL_MAX = 10;

function mul(label: string, extra?: Partial<StatDef>): StatDef {
  return { base: 1, min: MUL_MIN, max: MUL_MAX, label, format: 'multiplier', ...extra };
}

export const STAT_DEFS = {
  // --- movement ---
  moveSpeed: mul('Laufgeschwindigkeit', { min: 0.25, max: 3 }),
  /** On top of moveSpeed, sprint only. */
  sprintSpeed: mul('Sprintgeschwindigkeit', { min: 0.25, max: 3 }),
  dashCharges: {
    base: MOVEMENT.dash.charges,
    min: 0,
    max: 6,
    label: 'Dash-Ladungen',
    format: 'count',
    integer: true,
  },
  /** Recharge RATE (1.5 = a charge refills in rechargeTime / 1.5). */
  dashRecharge: mul('Dash-Aufladetempo', { min: 0.1, max: 5 }),

  // --- vitals ---
  maxHealth: {
    base: PLAYER.health.maxHealth,
    min: 1,
    max: 1000,
    label: 'Maximale Gesundheit',
    format: 'value',
    unit: 'HP',
  },
  maxArmor: {
    base: PLAYER.health.maxArmor,
    min: 0,
    max: 1000,
    label: 'Maximale Panzerung',
    format: 'value',
    unit: 'AP',
  },
  regenDelay: {
    base: PLAYER.health.regenDelay,
    min: 0,
    max: 30,
    label: 'Regenerationsverzögerung',
    format: 'value',
    unit: 's',
    lowerIsBetter: true,
  },
  regenRate: {
    base: PLAYER.health.regenRate,
    min: 0,
    max: 500,
    label: 'Regeneration',
    format: 'value',
    unit: 'HP/s',
  },
  damageTaken: mul('Erlittener Schaden', { lowerIsBetter: true }),
  explosionDamageTaken: mul('Erlittener Explosionsschaden', { lowerIsBetter: true }),
  fallDamageTaken: mul('Erlittener Fallschaden', { lowerIsBetter: true }),
  reviveCharges: {
    base: 0,
    min: 0,
    max: 5,
    label: 'Selbstwiederbelebungen',
    format: 'count',
    integer: true,
  },

  // --- weapons ---
  /** Rounds per minute multiplier (burst rate too). */
  fireRate: mul('Feuerrate', { min: 0.1, max: 5 }),
  /** Reload RATE: every reload duration and marker divides by it. */
  reloadSpeed: mul('Nachladetempo', { min: 0.1, max: 5 }),
  /** Aim-down-sights RATE (in and out). */
  adsSpeed: mul('Zieltempo', { min: 0.1, max: 5 }),
  damage: mul('Waffenschaden', { max: 20 }),
  /** Scales the weapon's head AND weakpoint multipliers. */
  headshotMultiplier: mul('Präzisionsschaden'),
  spread: mul('Streuung', { max: 5, lowerIsBetter: true }),
  recoil: mul('Rückstoß', { max: 5, lowerIsBetter: true }),
  magazineSize: mul('Magazingröße', { min: 0.1 }),
  reserveAmmo: mul('Reservemunition'),
  meleeDamage: mul('Nahkampfschaden', { max: 50 }),
  /** Add-only bonus on top of the map loadout's slots (see file header). */
  weaponSlots: {
    base: 0,
    min: 0,
    max: WEAPON_RULES.inventory.maxSlots - 1,
    label: 'Zusätzliche Waffenplätze',
    format: 'count',
    integer: true,
  },

  // --- economy / meta ---
  perkSlots: {
    base: 4,
    min: 0,
    max: 12,
    label: 'Perk-Plätze',
    format: 'count',
    integer: true,
  },
  /** Scales point EARNINGS (EconomySystem.earn), never costs. Double Points multiplies it by 2. */
  pointsMultiplier: mul('Punkte-Multiplikator'),
  powerUpDuration: mul('Power-up-Dauer', { min: 0.1 }),
  dropChance: mul('Drop-Chance'),
} as const satisfies Record<string, StatDef>;

export type StatKey = keyof typeof STAT_DEFS;

/** Every stat id, in table order (stats readout). */
export const STAT_IDS = Object.keys(STAT_DEFS) as StatKey[];

export function getStatDef(id: string): StatDef | undefined {
  return Object.prototype.hasOwnProperty.call(STAT_DEFS, id)
    ? (STAT_DEFS as Record<string, StatDef>)[id]
    : undefined;
}

export function isStatId(id: string): id is StatKey {
  return getStatDef(id) !== undefined;
}
