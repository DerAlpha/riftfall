/**
 * Skill tree (M9): three branches – Offensive, Überleben, Taktik – of five tiers each.
 *
 * Rules (src/progression/SkillTree.ts):
 * - Skill points: PROGRESSION.skillPoints.perLevel for every level up to the highest level ever
 *   reached, plus perPrestige per prestige rank (a prestige keeps them). The whole tree costs a
 *   little less than what the max prestige rank grants (tests keep it that way).
 * - Buying a rank needs the node's `requires` (rank ≥ 1 each), `cost` points and, from tier 2 on,
 *   SKILL_RULES.tierGates[tier − 1] points already spent IN THAT BRANCH.
 * - Effects: 'stat' effects are StatModifiers (source `skill:<nodeId>`) applied through the
 *   StatSystem at every run start (after its reset) – per rank an 'add' adds `value`, a 'mul'
 *   multiplies by `value` (value^rank). The other effects are run bonuses the composition root
 *   applies (start points, start grenades, box cashback, movement unlocks, loadout licences).
 * - Respec: refunds every point; the first SKILL_RULES.respec.free are free, later ones cost
 *   Rift-Splitter; never during a run.
 *
 * Layout: `row` = tier − 1 (top to bottom), `col` 0..SKILL_RULES.columns − 1 per branch (the
 * future skill screen draws prerequisite lines between the cells). Icons: PROGRESSION_GLYPHS ids.
 * Names and descriptions are German (per-rank values in the text).
 */
import type { AbilityId } from './abilities';
import type { GrenadeId } from './grenades';
import type { ProgressionGlyphId } from './progression';
import type { StatKey } from './stats';

export type SkillBranchId = 'offensive' | 'survival' | 'tactics';

export interface SkillBranchDef {
  readonly id: SkillBranchId;
  readonly name: string;
  readonly description: string;
  /** sRGB hex. */
  readonly color: number;
  readonly icon: ProgressionGlyphId;
}

export type SkillEffect =
  | { readonly kind: 'stat'; readonly stat: StatKey; readonly op: 'add' | 'mul'; readonly value: number }
  /** Extra start points per rank. */
  | { readonly kind: 'startPoints'; readonly value: number }
  /** Extra grenades of the start type per rank. */
  | { readonly kind: 'startGrenades'; readonly value: number }
  /** Fraction of every Rift-Kiste price paid back, per rank. */
  | { readonly kind: 'boxCashback'; readonly value: number }
  | { readonly kind: 'movement'; readonly ability: 'dash' | 'doubleJump' }
  /** Licence: the grenade / ability may be chosen as the run's start type. */
  | { readonly kind: 'grenade'; readonly id: GrenadeId }
  | { readonly kind: 'ability'; readonly id: AbilityId };

export interface SkillNodeDef {
  readonly id: string;
  readonly branch: SkillBranchId;
  /** 1..SKILL_RULES.tierGates.length. */
  readonly tier: number;
  readonly name: string;
  readonly description: string;
  readonly icon: ProgressionGlyphId;
  readonly maxRank: number;
  /** Points per rank. */
  readonly cost: number;
  /** Nodes that need rank ≥ 1 first (earlier tiers of the same branch). */
  readonly requires: readonly string[];
  readonly effects: readonly SkillEffect[];
  readonly layout: { readonly row: number; readonly col: number };
  /** The branch's signature node (bigger cell). */
  readonly capstone?: boolean;
}

export const SKILL_BRANCHES: Readonly<Record<SkillBranchId, SkillBranchDef>> = {
  offensive: {
    id: 'offensive',
    name: 'Offensive',
    description: 'Schaden, Präzision und Feuerkraft.',
    color: 0xff4b2b,
    icon: 'crosshair',
  },
  survival: {
    id: 'survival',
    name: 'Überleben',
    description: 'Gesundheit, Panzerung und Regeneration.',
    color: 0x3ddc84,
    icon: 'heartbeat',
  },
  tactics: {
    id: 'tactics',
    name: 'Taktik',
    description: 'Bewegung, Wirtschaft und Ausrüstung.',
    color: 0x4fc3ff,
    icon: 'rune',
  },
};

export const SKILL_BRANCH_IDS: readonly SkillBranchId[] = ['offensive', 'survival', 'tactics'];

export const SKILL_RULES = {
  /** Points spent in the branch before a tier opens (index = tier − 1). */
  tierGates: [0, 3, 7, 12, 18] as readonly number[],
  /** Layout columns per branch (licence nodes use the last one). */
  columns: 4,
  respec: {
    /** Respecs without a price. */
    free: 1,
    /** Rift-Splitter per respec after the free ones. */
    currency: 250,
    /** Refused while a run is going (the stat table holds the old build). */
    duringRun: false,
  },
  /** Start types everybody may choose (defaults of defs/grenades and defs/abilities). */
  defaultGrenades: ['frag'] as readonly string[],
  defaultAbilities: ['schockwelle'] as readonly string[],
} as const;

/** `skill:<nodeId>` – the StatSystem source of a node's modifiers. */
export function skillSource(nodeId: string): string {
  return `skill:${nodeId}`;
}

const stat = (s: StatKey, op: 'add' | 'mul', value: number): SkillEffect => ({
  kind: 'stat',
  stat: s,
  op,
  value,
});

export const SKILL_NODES: readonly SkillNodeDef[] = [
  // ------------------------------------------------------------------ Offensive
  {
    id: 'off_marksman',
    branch: 'offensive',
    tier: 1,
    name: 'Scharfschütze',
    description: '+4 % Präzisionsschaden (Kopf und Schwachstellen) pro Rang.',
    icon: 'crosshair',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [stat('headshotMultiplier', 'mul', 1.04)],
    layout: { row: 0, col: 0 },
  },
  {
    id: 'off_caliber',
    branch: 'offensive',
    tier: 1,
    name: 'Kaliber',
    description: '+2 % Waffenschaden pro Rang.',
    icon: 'burst',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [stat('damage', 'mul', 1.02)],
    layout: { row: 0, col: 1 },
  },
  {
    id: 'off_steady',
    branch: 'offensive',
    tier: 1,
    name: 'Ruhige Hand',
    description: '−6 % Rückstoß pro Rang.',
    icon: 'eye',
    maxRank: 2,
    cost: 1,
    requires: [],
    effects: [stat('recoil', 'mul', 0.94)],
    layout: { row: 0, col: 2 },
  },
  {
    id: 'off_acquire',
    branch: 'offensive',
    tier: 2,
    name: 'Zielerfassung',
    description: '+6 % Zieltempo pro Rang.',
    icon: 'eye',
    maxRank: 2,
    cost: 1,
    requires: ['off_marksman'],
    effects: [stat('adsSpeed', 'mul', 1.06)],
    layout: { row: 1, col: 0 },
  },
  {
    id: 'off_quickload',
    branch: 'offensive',
    tier: 2,
    name: 'Schnelllader',
    description: '+4 % Nachladetempo pro Rang.',
    icon: 'reload',
    maxRank: 3,
    cost: 1,
    requires: ['off_caliber'],
    effects: [stat('reloadSpeed', 'mul', 1.04)],
    layout: { row: 1, col: 1 },
  },
  {
    id: 'off_tightgroup',
    branch: 'offensive',
    tier: 2,
    name: 'Enge Streuung',
    description: '−5 % Streuung pro Rang.',
    icon: 'crosshair',
    maxRank: 2,
    cost: 1,
    requires: ['off_steady'],
    effects: [stat('spread', 'mul', 0.95)],
    layout: { row: 1, col: 2 },
  },
  {
    id: 'off_trigger',
    branch: 'offensive',
    tier: 3,
    name: 'Abzugsfinger',
    description: '+3 % Feuerrate pro Rang.',
    icon: 'double',
    maxRank: 2,
    cost: 2,
    requires: ['off_quickload'],
    effects: [stat('fireRate', 'mul', 1.03)],
    layout: { row: 2, col: 0 },
  },
  {
    id: 'off_extmag',
    branch: 'offensive',
    tier: 3,
    name: 'Erweiterte Magazine',
    description: '+8 % Magazingröße pro Rang.',
    icon: 'ammo',
    maxRank: 2,
    cost: 2,
    requires: ['off_quickload'],
    effects: [stat('magazineSize', 'mul', 1.08)],
    layout: { row: 2, col: 1 },
  },
  {
    id: 'off_bandolier',
    branch: 'offensive',
    tier: 3,
    name: 'Munitionsgurt',
    description: '+10 % Reservemunition pro Rang.',
    icon: 'ammo',
    maxRank: 2,
    cost: 1,
    requires: ['off_tightgroup'],
    effects: [stat('reserveAmmo', 'mul', 1.1)],
    layout: { row: 2, col: 2 },
  },
  {
    id: 'off_headhunter',
    branch: 'offensive',
    tier: 4,
    name: 'Kopfjäger',
    description: '+8 % Präzisionsschaden.',
    icon: 'skull',
    maxRank: 1,
    cost: 3,
    requires: ['off_acquire'],
    effects: [stat('headshotMultiplier', 'mul', 1.08)],
    layout: { row: 3, col: 0 },
  },
  {
    id: 'off_firepower',
    branch: 'offensive',
    tier: 4,
    name: 'Feuerkraft',
    description: '+3 % Waffenschaden pro Rang.',
    icon: 'impact',
    maxRank: 2,
    cost: 2,
    requires: ['off_trigger'],
    effects: [stat('damage', 'mul', 1.03)],
    layout: { row: 3, col: 1 },
  },
  {
    id: 'off_brawler',
    branch: 'offensive',
    tier: 4,
    name: 'Schlagkraft',
    description: '+15 % Nahkampfschaden pro Rang.',
    icon: 'fist',
    maxRank: 2,
    cost: 1,
    requires: ['off_bandolier'],
    effects: [stat('meleeDamage', 'mul', 1.15)],
    layout: { row: 3, col: 2 },
  },
  {
    id: 'off_deadeye',
    branch: 'offensive',
    tier: 5,
    name: 'Todesschütze',
    description: '+10 % Präzisionsschaden und −10 % Streuung.',
    icon: 'crosshair',
    maxRank: 1,
    cost: 4,
    requires: ['off_headhunter'],
    effects: [stat('headshotMultiplier', 'mul', 1.1), stat('spread', 'mul', 0.9)],
    layout: { row: 4, col: 0 },
  },
  {
    id: 'off_annihilator',
    branch: 'offensive',
    tier: 5,
    name: 'Vernichter',
    description: '+5 % Waffenschaden und +3 % Feuerrate.',
    icon: 'burst',
    maxRank: 1,
    cost: 4,
    requires: ['off_firepower'],
    effects: [stat('damage', 'mul', 1.05), stat('fireRate', 'mul', 1.03)],
    layout: { row: 4, col: 1 },
  },
  {
    id: 'off_arsenal',
    branch: 'offensive',
    tier: 5,
    name: 'Waffennarr',
    description: '+1 Waffenplatz.',
    icon: 'holster',
    maxRank: 1,
    cost: 5,
    requires: ['off_extmag'],
    effects: [stat('weaponSlots', 'add', 1)],
    layout: { row: 4, col: 2 },
    capstone: true,
  },

  // ------------------------------------------------------------------ Überleben
  {
    id: 'sur_tough',
    branch: 'survival',
    tier: 1,
    name: 'Zähigkeit',
    description: '+5 maximale Gesundheit pro Rang.',
    icon: 'heartbeat',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [stat('maxHealth', 'add', 5)],
    layout: { row: 0, col: 0 },
  },
  {
    id: 'sur_plating',
    branch: 'survival',
    tier: 1,
    name: 'Panzerplatten',
    description: '+10 maximale Panzerung pro Rang.',
    icon: 'shield',
    maxRank: 2,
    cost: 1,
    requires: [],
    effects: [stat('maxArmor', 'add', 10)],
    layout: { row: 0, col: 1 },
  },
  {
    id: 'sur_mending',
    branch: 'survival',
    tier: 1,
    name: 'Schnelle Heilung',
    description: '+8 % Regeneration pro Rang.',
    icon: 'heartbeat',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [stat('regenRate', 'mul', 1.08)],
    layout: { row: 0, col: 2 },
  },
  {
    id: 'sur_hardened',
    branch: 'survival',
    tier: 2,
    name: 'Abgehärtet',
    description: '−3 % erlittener Schaden pro Rang.',
    icon: 'shield',
    maxRank: 3,
    cost: 1,
    requires: ['sur_tough'],
    effects: [stat('damageTaken', 'mul', 0.97)],
    layout: { row: 1, col: 0 },
  },
  {
    id: 'sur_softlanding',
    branch: 'survival',
    tier: 2,
    name: 'Weiche Landung',
    description: '−40 % Fallschaden.',
    icon: 'boot',
    maxRank: 1,
    cost: 1,
    requires: ['sur_plating'],
    effects: [stat('fallDamageTaken', 'mul', 0.6)],
    layout: { row: 1, col: 1 },
  },
  {
    id: 'sur_adrenaline',
    branch: 'survival',
    tier: 2,
    name: 'Adrenalinschub',
    description: '−8 % Regenerationsverzögerung pro Rang.',
    icon: 'clock',
    maxRank: 2,
    cost: 1,
    requires: ['sur_mending'],
    effects: [stat('regenDelay', 'mul', 0.92)],
    layout: { row: 1, col: 2 },
  },
  {
    id: 'sur_vitalcore',
    branch: 'survival',
    tier: 3,
    name: 'Vitalkern',
    description: '+5 % maximale Gesundheit pro Rang.',
    icon: 'heartbeat',
    maxRank: 2,
    cost: 2,
    requires: ['sur_hardened'],
    effects: [stat('maxHealth', 'mul', 1.05)],
    layout: { row: 2, col: 0 },
  },
  {
    id: 'sur_blastshield',
    branch: 'survival',
    tier: 3,
    name: 'Explosionsschutz',
    description: '−12 % erlittener Explosionsschaden pro Rang.',
    icon: 'impact',
    maxRank: 2,
    cost: 1,
    requires: ['sur_softlanding'],
    effects: [stat('explosionDamageTaken', 'mul', 0.88)],
    layout: { row: 2, col: 1 },
  },
  {
    id: 'sur_reactive',
    branch: 'survival',
    tier: 3,
    name: 'Reaktivpanzerung',
    description: '+10 % maximale Panzerung pro Rang.',
    icon: 'hex',
    maxRank: 2,
    cost: 2,
    requires: ['sur_softlanding'],
    effects: [stat('maxArmor', 'mul', 1.1)],
    layout: { row: 2, col: 2 },
  },
  {
    id: 'sur_ironskin',
    branch: 'survival',
    tier: 4,
    name: 'Stählerne Haut',
    description: '−5 % erlittener Schaden.',
    icon: 'shield',
    maxRank: 1,
    cost: 3,
    requires: ['sur_vitalcore'],
    effects: [stat('damageTaken', 'mul', 0.95)],
    layout: { row: 3, col: 0 },
  },
  {
    id: 'sur_survivor',
    branch: 'survival',
    tier: 4,
    name: 'Überlebenskünstler',
    description: '+10 maximale Gesundheit pro Rang.',
    icon: 'heartbeat',
    maxRank: 2,
    cost: 2,
    requires: ['sur_vitalcore'],
    effects: [stat('maxHealth', 'add', 10)],
    layout: { row: 3, col: 1 },
  },
  {
    id: 'sur_regenerator',
    branch: 'survival',
    tier: 4,
    name: 'Regenerator',
    description: '+12 % Regeneration und −10 % Regenerationsverzögerung.',
    icon: 'clock',
    maxRank: 1,
    cost: 3,
    requires: ['sur_adrenaline'],
    effects: [stat('regenRate', 'mul', 1.12), stat('regenDelay', 'mul', 0.9)],
    layout: { row: 3, col: 2 },
  },
  {
    id: 'sur_phoenix',
    branch: 'survival',
    tier: 5,
    name: 'Phönixfunke',
    description: 'Eine Selbstwiederbelebung pro Run.',
    icon: 'phoenix',
    maxRank: 1,
    cost: 6,
    requires: ['sur_ironskin'],
    effects: [stat('reviveCharges', 'add', 1)],
    layout: { row: 4, col: 0 },
    capstone: true,
  },
  {
    id: 'sur_unbreakable',
    branch: 'survival',
    tier: 5,
    name: 'Unverwüstlich',
    description: '−15 % Explosionsschaden und −50 % Fallschaden.',
    icon: 'impact',
    maxRank: 1,
    cost: 3,
    requires: ['sur_blastshield'],
    effects: [stat('explosionDamageTaken', 'mul', 0.85), stat('fallDamageTaken', 'mul', 0.5)],
    layout: { row: 4, col: 1 },
  },
  {
    id: 'sur_bulwark',
    branch: 'survival',
    tier: 5,
    name: 'Bollwerk',
    description: '+25 maximale Panzerung und −4 % erlittener Schaden.',
    icon: 'shield',
    maxRank: 1,
    cost: 4,
    requires: ['sur_reactive'],
    effects: [stat('maxArmor', 'add', 25), stat('damageTaken', 'mul', 0.96)],
    layout: { row: 4, col: 2 },
  },

  // ------------------------------------------------------------------ Taktik
  {
    id: 'tac_dash',
    branch: 'tactics',
    tier: 1,
    name: 'Rift-Dash',
    description: 'Schaltet den Dash frei.',
    icon: 'dash',
    maxRank: 1,
    cost: 1,
    requires: [],
    effects: [{ kind: 'movement', ability: 'dash' }],
    layout: { row: 0, col: 0 },
  },
  {
    id: 'tac_light',
    branch: 'tactics',
    tier: 1,
    name: 'Leichtfuß',
    description: '+2 % Laufgeschwindigkeit pro Rang.',
    icon: 'boot',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [stat('moveSpeed', 'mul', 1.02)],
    layout: { row: 0, col: 1 },
  },
  {
    id: 'tac_capital',
    branch: 'tactics',
    tier: 1,
    name: 'Startkapital',
    description: '+250 Startpunkte pro Rang.',
    icon: 'coin',
    maxRank: 3,
    cost: 1,
    requires: [],
    effects: [{ kind: 'startPoints', value: 250 }],
    layout: { row: 0, col: 2 },
  },
  {
    id: 'tac_doublejump',
    branch: 'tactics',
    tier: 2,
    name: 'Doppelsprung',
    description: 'Schaltet den Doppelsprung frei.',
    icon: 'boot',
    maxRank: 1,
    cost: 2,
    requires: ['tac_dash'],
    effects: [{ kind: 'movement', ability: 'doubleJump' }],
    layout: { row: 1, col: 0 },
  },
  {
    id: 'tac_sprinter',
    branch: 'tactics',
    tier: 2,
    name: 'Sprinter',
    description: '+4 % Sprintgeschwindigkeit pro Rang.',
    icon: 'runner',
    maxRank: 2,
    cost: 1,
    requires: ['tac_light'],
    effects: [stat('sprintSpeed', 'mul', 1.04)],
    layout: { row: 1, col: 1 },
  },
  {
    id: 'tac_grenadier',
    branch: 'tactics',
    tier: 2,
    name: 'Granatengurt',
    description: '+1 Granate zu Rundenbeginn pro Rang.',
    icon: 'grenade',
    maxRank: 2,
    cost: 1,
    requires: ['tac_capital'],
    effects: [{ kind: 'startGrenades', value: 1 }],
    layout: { row: 1, col: 2 },
  },
  {
    id: 'tac_ordnance',
    branch: 'tactics',
    tier: 2,
    name: 'Sprengstofflizenz',
    description: 'Brand- und Kryogranaten als Startgranate wählbar.',
    icon: 'flame',
    maxRank: 1,
    cost: 2,
    requires: ['tac_capital'],
    effects: [
      { kind: 'grenade', id: 'brand' },
      { kind: 'grenade', id: 'kryo' },
    ],
    layout: { row: 1, col: 3 },
  },
  {
    id: 'tac_capacitor',
    branch: 'tactics',
    tier: 3,
    name: 'Dash-Kondensator',
    description: '+10 % Dash-Aufladetempo pro Rang.',
    icon: 'dash',
    maxRank: 2,
    cost: 1,
    requires: ['tac_doublejump'],
    effects: [stat('dashRecharge', 'mul', 1.1)],
    layout: { row: 2, col: 0 },
  },
  {
    id: 'tac_lucky',
    branch: 'tactics',
    tier: 3,
    name: 'Glückspilz',
    description: '+8 % Drop-Chance für Power-ups pro Rang.',
    icon: 'star',
    maxRank: 2,
    cost: 2,
    requires: ['tac_sprinter'],
    effects: [stat('dropChance', 'mul', 1.08)],
    layout: { row: 2, col: 1 },
  },
  {
    id: 'tac_haggler',
    branch: 'tactics',
    tier: 3,
    name: 'Rückvergütung',
    description: '10 % jedes Rift-Kisten-Preises werden pro Rang gutgeschrieben.',
    icon: 'box',
    maxRank: 2,
    cost: 2,
    requires: ['tac_grenadier'],
    effects: [{ kind: 'boxCashback', value: 0.1 }],
    layout: { row: 2, col: 2 },
  },
  {
    id: 'tac_modules',
    branch: 'tactics',
    tier: 3,
    name: 'Fähigkeitenmodul',
    description: 'Phasenbarriere und Überladung als Startfähigkeit wählbar.',
    icon: 'orbit',
    maxRank: 1,
    cost: 2,
    requires: ['tac_ordnance'],
    effects: [
      { kind: 'ability', id: 'phasenbarriere' },
      { kind: 'ability', id: 'ueberladung' },
    ],
    layout: { row: 2, col: 3 },
  },
  {
    id: 'tac_extracharge',
    branch: 'tactics',
    tier: 4,
    name: 'Zusatzladung',
    description: '+1 Dash-Ladung.',
    icon: 'dash',
    maxRank: 1,
    cost: 3,
    requires: ['tac_capacitor'],
    effects: [stat('dashCharges', 'add', 1)],
    layout: { row: 3, col: 0 },
  },
  {
    id: 'tac_longevity',
    branch: 'tactics',
    tier: 4,
    name: 'Langzeitwirkung',
    description: '+10 % Power-up-Dauer pro Rang.',
    icon: 'clock',
    maxRank: 2,
    cost: 2,
    requires: ['tac_lucky'],
    effects: [stat('powerUpDuration', 'mul', 1.1)],
    layout: { row: 3, col: 1 },
  },
  {
    id: 'tac_interest',
    branch: 'tactics',
    tier: 4,
    name: 'Zinseszins',
    description: '+3 % Punkte-Multiplikator pro Rang.',
    icon: 'coin',
    maxRank: 2,
    cost: 2,
    requires: ['tac_haggler'],
    effects: [stat('pointsMultiplier', 'mul', 1.03)],
    layout: { row: 3, col: 2 },
  },
  {
    id: 'tac_warchest',
    branch: 'tactics',
    tier: 5,
    name: 'Kriegskasse',
    description: '+1000 Startpunkte.',
    icon: 'coin',
    maxRank: 1,
    cost: 3,
    requires: ['tac_interest'],
    effects: [{ kind: 'startPoints', value: 1000 }],
    layout: { row: 4, col: 1 },
  },
  {
    id: 'tac_implant',
    branch: 'tactics',
    tier: 5,
    name: 'Implantat-Slot',
    description: '+1 Perk-Platz.',
    icon: 'hex',
    maxRank: 1,
    cost: 5,
    requires: ['tac_interest'],
    effects: [stat('perkSlots', 'add', 1)],
    layout: { row: 4, col: 2 },
    capstone: true,
  },
  {
    id: 'tac_prototypes',
    branch: 'tactics',
    tier: 5,
    name: 'Rift-Prototypen',
    description: 'Singularitätsgranate und Chronofeld als Startausrüstung wählbar.',
    icon: 'rune',
    maxRank: 1,
    cost: 4,
    requires: ['tac_modules'],
    effects: [
      { kind: 'grenade', id: 'singularity' },
      { kind: 'ability', id: 'chronofeld' },
    ],
    layout: { row: 4, col: 3 },
  },
];

const NODE_INDEX: ReadonlyMap<string, SkillNodeDef> = new Map(SKILL_NODES.map((n) => [n.id, n]));

export function getSkillNode(id: string): SkillNodeDef | undefined {
  return NODE_INDEX.get(id);
}

/** Points to max out every node. */
export function totalSkillCost(nodes: readonly SkillNodeDef[] = SKILL_NODES): number {
  let sum = 0;
  for (const n of nodes) sum += n.cost * n.maxRank;
  return sum;
}
