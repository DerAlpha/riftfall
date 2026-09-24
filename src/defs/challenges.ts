/**
 * Daily and weekly challenges (M9, src/progression/ChallengeTracker.ts).
 *
 * Every UTC day (and every UTC week, starting Monday) a set of CHALLENGE_RULES[period].count
 * challenges is drawn from the templates with the date seed (core/Rng dailySeed + a suffix), so
 * every player gets the same set. A template names a condition over progress signals (like an
 * achievement), an optional variant (enemy type, weapon category, element …) and a target range
 * per period; the draw picks the variant and a target, the reward scales with the template's
 * difficulty and with where the target fell in its range.
 *
 * Progress counts from the moment the set is active: 'lifetime' templates across every run of the
 * day/week, 'run' templates within one run. Completed challenges are claimed automatically unless
 * `autoClaim` is off (the M11 screen may claim by hand); a rotation grants unclaimed rewards.
 * `{n}` in names/descriptions is the target, `{v}` the variant label. German text.
 */
import type { ChallengePeriod } from '../core/events';
import type { MetricId, ProgressionGlyphId, SignalFilter } from './progression';

/** Tags a template may vary. */
export type ChallengeVariantTag = 'enemy' | 'category' | 'element';

export interface ChallengeVariantDef {
  readonly id: string;
  /** German label for `{v}`. */
  readonly label: string;
  /** Target multiplier (rare enemies need fewer kills). */
  readonly scale: number;
}

export interface ChallengeTargetRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface ChallengeTemplateDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: ProgressionGlyphId;
  readonly weight: number;
  /** Reward multiplier (harder templates pay more). */
  readonly difficulty: number;
  readonly condition: {
    readonly kind: 'count' | 'max';
    readonly metric: MetricId;
    readonly scope?: 'lifetime' | 'run';
    readonly filter?: SignalFilter;
  };
  readonly variants?: { readonly tag: ChallengeVariantTag; readonly values: readonly ChallengeVariantDef[] };
  /** Periods without a range never draw this template. */
  readonly targets: Partial<Readonly<Record<ChallengePeriod, ChallengeTargetRange>>>;
}

export const CHALLENGE_RULES = {
  daily: {
    count: 3,
    /** Seed: dailySeed(date) + suffix (the daily challenge MODE of M8 uses the bare seed). */
    seedSuffix: ':challenges',
    xp: 1800,
    currency: 12,
    /** Slots whose reward includes a cosmetic of the 'challenge' pool (from slot 0 on). */
    cosmeticSlots: 0,
  },
  weekly: {
    count: 3,
    seedSuffix: ':weekly-challenges',
    xp: 7500,
    currency: 60,
    cosmeticSlots: 1,
  },
  /** Reward × this, interpolated by where the target fell in its range. */
  rangeRewardScale: { min: 0.85, max: 1.25 },
  rewardRoundTo: 50,
  /** Rift-Splitter instead of a cosmetic the player already owns. */
  duplicateCurrency: 40,
  /** Rewards are granted on completion (the M11 screen may switch to manual claiming). */
  autoClaim: true,
} as const;

const ENEMY_VARIANTS: readonly ChallengeVariantDef[] = [
  { id: 'swarmer', label: 'Schwärmer', scale: 1 },
  { id: 'spitter', label: 'Spucker', scale: 0.25 },
  { id: 'tank', label: 'Kolosse', scale: 0.05 },
];

const CATEGORY_VARIANTS: readonly ChallengeVariantDef[] = [
  { id: 'pistol', label: 'Pistolen', scale: 1 },
  { id: 'smg', label: 'Maschinenpistolen', scale: 1 },
  { id: 'rifle', label: 'Sturmgewehren', scale: 1 },
  { id: 'shotgun', label: 'Schrotflinten', scale: 1 },
  { id: 'lmg', label: 'Maschinengewehren', scale: 1 },
  { id: 'energy', label: 'Energiewaffen', scale: 0.6 },
];

const ELEMENT_VARIANTS: readonly ChallengeVariantDef[] = [
  { id: 'fire', label: 'Feuer', scale: 1 },
  { id: 'ice', label: 'Eis', scale: 1 },
  { id: 'shock', label: 'Schock', scale: 1 },
  { id: 'poison', label: 'Gift', scale: 1 },
  { id: 'void', label: 'Void', scale: 1 },
];

export const CHALLENGE_TEMPLATES: readonly ChallengeTemplateDef[] = [
  {
    id: 'kills',
    name: 'Kopfgeld',
    description: 'Töte {n} Gegner.',
    icon: 'skull',
    weight: 3,
    difficulty: 1,
    condition: { kind: 'count', metric: 'kill' },
    targets: { daily: { min: 150, max: 300, step: 25 }, weekly: { min: 1500, max: 2500, step: 100 } },
  },
  {
    id: 'kills_enemy',
    name: 'Zielgruppe',
    description: 'Töte {n} {v}.',
    icon: 'skull',
    weight: 2,
    difficulty: 1,
    condition: { kind: 'count', metric: 'kill' },
    variants: { tag: 'enemy', values: ENEMY_VARIANTS },
    targets: { daily: { min: 120, max: 240, step: 20 }, weekly: { min: 1000, max: 1800, step: 100 } },
  },
  {
    id: 'headshots',
    name: 'Präzisionsarbeit',
    description: '{n} Kopfschuss-Kills.',
    icon: 'crosshair',
    weight: 2,
    difficulty: 1.2,
    condition: { kind: 'count', metric: 'kill', filter: { zone: 'head' } },
    targets: { daily: { min: 30, max: 60, step: 5 }, weekly: { min: 300, max: 500, step: 25 } },
  },
  {
    id: 'kills_category',
    name: 'Waffengattung',
    description: 'Töte {n} Gegner mit {v}.',
    icon: 'crosshair',
    weight: 2,
    difficulty: 1.1,
    condition: { kind: 'count', metric: 'kill' },
    variants: { tag: 'category', values: CATEGORY_VARIANTS },
    targets: { daily: { min: 60, max: 120, step: 10 }, weekly: { min: 500, max: 800, step: 50 } },
  },
  {
    id: 'melee',
    name: 'Nahkampf',
    description: '{n} Nahkampf-Kills.',
    icon: 'fist',
    weight: 1,
    difficulty: 1.2,
    condition: { kind: 'count', metric: 'kill', filter: { kind: 'melee' } },
    targets: { daily: { min: 10, max: 20, step: 5 }, weekly: { min: 60, max: 100, step: 10 } },
  },
  {
    id: 'element_kills',
    name: 'Elementar',
    description: '{n} Kills mit {v}schaden.',
    icon: 'flask',
    weight: 1,
    difficulty: 1.3,
    condition: { kind: 'count', metric: 'kill' },
    variants: { tag: 'element', values: ELEMENT_VARIANTS },
    targets: { daily: { min: 25, max: 50, step: 5 }, weekly: { min: 200, max: 350, step: 25 } },
  },
  {
    id: 'combos',
    name: 'Reaktionskette',
    description: 'Löse {n} Elementarkombos aus.',
    icon: 'flask',
    weight: 1,
    difficulty: 1.4,
    condition: { kind: 'count', metric: 'combo' },
    targets: { daily: { min: 5, max: 10, step: 1 }, weekly: { min: 40, max: 60, step: 5 } },
  },
  {
    id: 'waves',
    name: 'Wellenbrecher',
    description: 'Schließe {n} Wellen ab.',
    icon: 'wave',
    weight: 2,
    difficulty: 1,
    condition: { kind: 'count', metric: 'waveComplete' },
    targets: { daily: { min: 10, max: 20, step: 2 }, weekly: { min: 60, max: 100, step: 5 } },
  },
  {
    id: 'reach_wave',
    name: 'Durchbruch',
    description: 'Erreiche Welle {n} in einem Run.',
    icon: 'wave',
    weight: 2,
    difficulty: 1.2,
    condition: { kind: 'max', metric: 'waveReached' },
    targets: { daily: { min: 8, max: 12, step: 1 }, weekly: { min: 15, max: 20, step: 1 } },
  },
  {
    id: 'no_damage_waves',
    name: 'Unversehrt',
    description: 'Schließe {n} Wellen ohne Schaden ab.',
    icon: 'shield',
    weight: 1,
    difficulty: 1.5,
    condition: { kind: 'count', metric: 'noDamageWave' },
    targets: { daily: { min: 1, max: 3, step: 1 }, weekly: { min: 5, max: 10, step: 1 } },
  },
  {
    id: 'points',
    name: 'Geschäftsmann',
    description: 'Verdiene {n} Punkte.',
    icon: 'coin',
    weight: 2,
    difficulty: 1,
    condition: { kind: 'count', metric: 'pointsEarned' },
    targets: {
      daily: { min: 25000, max: 50000, step: 5000 },
      weekly: { min: 250000, max: 400000, step: 25000 },
    },
  },
  {
    id: 'perks',
    name: 'Aufgerüstet',
    description: 'Kaufe {n} Perks.',
    icon: 'hex',
    weight: 1,
    difficulty: 0.9,
    condition: { kind: 'count', metric: 'perkBought' },
    targets: { daily: { min: 4, max: 8, step: 1 }, weekly: { min: 25, max: 40, step: 5 } },
  },
  {
    id: 'doors',
    name: 'Türöffner',
    description: 'Öffne {n} Türen.',
    icon: 'door',
    weight: 1,
    difficulty: 0.8,
    condition: { kind: 'count', metric: 'doorOpened' },
    targets: { daily: { min: 5, max: 10, step: 1 }, weekly: { min: 30, max: 50, step: 5 } },
  },
  {
    id: 'box',
    name: 'Glücksritter',
    description: 'Nutze die Rift-Kiste {n}-mal.',
    icon: 'box',
    weight: 1,
    difficulty: 0.9,
    condition: { kind: 'count', metric: 'boxRoll' },
    targets: { daily: { min: 3, max: 6, step: 1 }, weekly: { min: 20, max: 30, step: 5 } },
  },
  {
    id: 'grenade_kills',
    name: 'Sprengmeister',
    description: '{n} Kills mit Granaten.',
    icon: 'grenade',
    weight: 1,
    difficulty: 1.1,
    condition: { kind: 'count', metric: 'kill', filter: { category: 'grenade' } },
    targets: { daily: { min: 15, max: 30, step: 5 }, weekly: { min: 100, max: 150, step: 10 } },
  },
  {
    id: 'abilities',
    name: 'Kraftprobe',
    description: 'Setze Fähigkeiten {n}-mal ein.',
    icon: 'orbit',
    weight: 1,
    difficulty: 0.9,
    condition: { kind: 'count', metric: 'abilityUsed' },
    targets: { daily: { min: 8, max: 15, step: 1 }, weekly: { min: 50, max: 80, step: 5 } },
  },
  {
    id: 'powerups',
    name: 'Schatzsucher',
    description: 'Sammle {n} Power-ups.',
    icon: 'star',
    weight: 1,
    difficulty: 1,
    condition: { kind: 'count', metric: 'powerUp' },
    targets: { daily: { min: 5, max: 10, step: 1 }, weekly: { min: 30, max: 50, step: 5 } },
  },
  {
    id: 'forge',
    name: 'Schmiedefeuer',
    description: 'Schmiede {n} Waffen-Upgrades.',
    icon: 'anvil',
    weight: 1,
    difficulty: 1.3,
    condition: { kind: 'count', metric: 'forgeUpgrade' },
    targets: { daily: { min: 1, max: 2, step: 1 }, weekly: { min: 6, max: 10, step: 1 } },
  },
  {
    id: 'elites',
    name: 'Elitejagd',
    description: 'Töte {n} Elite-Gegner.',
    icon: 'star',
    weight: 1,
    difficulty: 1.4,
    condition: { kind: 'count', metric: 'kill', filter: { elite: true } },
    targets: { weekly: { min: 15, max: 25, step: 5 } },
  },
  {
    id: 'seals',
    name: 'Siegelwacht',
    description: 'Repariere {n} Rift-Siegel.',
    icon: 'hex',
    weight: 1,
    difficulty: 0.9,
    condition: { kind: 'count', metric: 'sealRepaired' },
    targets: { daily: { min: 5, max: 10, step: 1 }, weekly: { min: 30, max: 50, step: 5 } },
  },
  {
    id: 'run_kills',
    name: 'Amoklauf',
    description: 'Töte {n} Gegner in einem einzigen Run.',
    icon: 'burst',
    weight: 1,
    difficulty: 1.3,
    condition: { kind: 'count', metric: 'kill', scope: 'run' },
    targets: { daily: { min: 200, max: 300, step: 25 }, weekly: { min: 400, max: 600, step: 50 } },
  },
];

const INDEX: ReadonlyMap<string, ChallengeTemplateDef> = new Map(CHALLENGE_TEMPLATES.map((t) => [t.id, t]));

export function getChallengeTemplate(id: string): ChallengeTemplateDef | undefined {
  return INDEX.get(id);
}
