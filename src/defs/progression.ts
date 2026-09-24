/**
 * Meta progression (M9): player level 1..100 with prestige ranks, XP sources, weapon levels,
 * the progress-signal vocabulary shared by achievements, challenges, lifetime stats and camo
 * challenges, save limits and the progression toasts.
 *
 * How progress is tracked (src/progression):
 * - RunRecorder turns gameplay events into PROGRESS SIGNALS: a metric id (METRICS) + an amount +
 *   tags (enemy type, weapon, weapon category, hit zone, element, map, …). 'add' metrics count
 *   (kills, points earned); 'max' metrics report a level reached (wave reached, headshot streak).
 * - Achievements, challenges and lifetime counters are CONDITIONS over those signals
 *   (ProgressCondition): a metric, an optional tag filter and a scope (lifetime / one run / one
 *   wave). New content (M6 enemies, M7 maps, M8 modes) extends the defs, not the code: a new enemy
 *   type is just another `enemy` tag value, a new map another `map` value.
 *
 * XP curve (xpToNext(level) = base + scale × (level − 1)^exponent, rounded to `roundTo`): the
 * reference player (PROGRESSION.pacing, src/progression/pacing.ts) reaches level 100 in ~50 h of
 * play (tests keep it inside 40–60 h); early levels take minutes, the last ones about an hour.
 * Prestige (level 100 → rank + 1, level 1) keeps every unlock and the skill points of the levels
 * and adds PROGRESSION.prestige.xpBonusPerRank XP per rank.
 *
 * Numbers are XP unless noted; times in seconds.
 */
import type { AchievementTier, DamageElement, HitZone, ImpactKind } from '../core/events';
import { PERK_GLYPHS } from './perks';

// ---------------------------------------------------------------------------
// Signals and conditions
// ---------------------------------------------------------------------------

/**
 * Progress metrics RunRecorder emits (and ProgressionSystem for the meta ones). 'max' metrics
 * carry the level reached as their amount; every other metric is a count.
 */
export const METRICS = {
  // --- combat (tags: enemy, weapon, category, zone, elite, element, kind, grenade, ability) ---
  kill: 'add',
  shotFired: 'add',
  shotHit: 'add',
  damageDealt: 'add',
  damageTaken: 'add',
  /** Headshot kills in a row (any other player kill breaks it). */
  headshotStreak: 'max',
  /** Kills without taking damage in between. */
  killStreak: 'max',
  /** Kills inside PROGRESSION.tracking.multiKillWindow. */
  multiKill: 'max',
  // --- waves / runs (tags: map, mode, wave) ---
  waveComplete: 'add',
  waveReached: 'max',
  /** A wave (≥ tracking.noDamageMinWave) completed without taking damage. */
  noDamageWave: 'add',
  /** Seconds survived in the run (wave completions and the run end). */
  survived: 'max',
  /** Highest wave completed without firing a shot (grenades, abilities, melee only). */
  pacifistWave: 'max',
  runEnd: 'add',
  death: 'add',
  /** The run ended in wave ≤ tracking.earlyDeathWave. */
  earlyDeath: 'add',
  revive: 'add',
  // --- economy / interactables ---
  pointsEarned: 'add',
  pointsSpent: 'add',
  doorOpened: 'add',
  /** Every door of the map opened in one run. */
  allDoors: 'add',
  /** tag perk */
  perkBought: 'add',
  /** Every perk slot filled in one run. */
  perkSlotsFull: 'add',
  boxRoll: 'add',
  /** The Rift-Kiste handed out a wonder weapon (tag weapon). */
  boxWonder: 'add',
  /** tags weapon, tier */
  forgeUpgrade: 'add',
  forgeTier: 'max',
  /** tag powerup */
  powerUp: 'add',
  sealRepaired: 'add',
  // --- arsenal (M5) ---
  /** tag grenade */
  grenadeThrown: 'add',
  /** tag ability */
  abilityUsed: 'add',
  /** tag combo */
  combo: 'add',
  // --- meta (ProgressionSystem) ---
  playerLevel: 'max',
  prestige: 'max',
  /** tag weapon */
  weaponLevel: 'max',
  /** A weapon reached the max weapon level (tag weapon). */
  weaponMastered: 'add',
  /** An animated camo was unlocked (tag camo). */
  animatedCamo: 'add',
  /** Skill ranks bought in total. */
  skillRanks: 'max',
  /** A branch had every node at its max rank (tag branch). */
  skillBranchComplete: 'add',
  achievementsUnlocked: 'max',
  /** tag period */
  challengeCompleted: 'add',
} as const satisfies Record<string, 'add' | 'max'>;

export type MetricId = keyof typeof METRICS;

export function isMetricId(id: string): id is MetricId {
  return Object.prototype.hasOwnProperty.call(METRICS, id);
}

/** Tag filter of a condition: every given field must equal the signal's tag. */
export interface SignalFilter {
  readonly enemy?: string;
  readonly weapon?: string;
  /** Weapon category (defs/weapons WeaponCategory). */
  readonly category?: string;
  readonly zone?: HitZone;
  readonly elite?: boolean;
  readonly element?: DamageElement;
  readonly kind?: ImpactKind;
  readonly grenade?: string;
  readonly ability?: string;
  readonly combo?: string;
  readonly perk?: string;
  readonly powerup?: string;
  readonly map?: string;
  readonly mode?: string;
  readonly period?: string;
  readonly branch?: string;
  /** Signals with a lower `tier` / `wave` tag do not count. */
  readonly minTier?: number;
  readonly minWave?: number;
}

/** String tags a distinct condition can collect. */
export type DistinctTag =
  | 'enemy'
  | 'weapon'
  | 'category'
  | 'element'
  | 'grenade'
  | 'ability'
  | 'combo'
  | 'perk'
  | 'powerup'
  | 'map';

/** Where a count accumulates: forever, within one run, or within one wave. */
export type ConditionScope = 'lifetime' | 'run' | 'wave';

export type ProgressCondition =
  /** Sum of the metric's amounts ≥ target (within `scope`, default lifetime). */
  | {
      readonly kind: 'count';
      readonly metric: MetricId;
      readonly target: number;
      readonly scope?: ConditionScope;
      readonly filter?: SignalFilter;
    }
  /** Highest amount of a 'max' metric ≥ target. */
  | { readonly kind: 'max'; readonly metric: MetricId; readonly target: number; readonly filter?: SignalFilter }
  /**
   * `target` distinct values of a tag seen (e.g. every combo): `values` restricts which values
   * count (absent = any value).
   */
  | {
      readonly kind: 'distinct';
      readonly metric: MetricId;
      readonly tag: DistinctTag;
      readonly target: number;
      readonly values?: readonly string[];
      readonly scope?: 'lifetime' | 'run';
      readonly filter?: SignalFilter;
    };

// ---------------------------------------------------------------------------
// Level, XP, prestige
// ---------------------------------------------------------------------------

export interface XpCurveDef {
  readonly base: number;
  readonly scale: number;
  readonly exponent: number;
  readonly roundTo: number;
}

export const PROGRESSION = {
  maxLevel: 100,
  /** xpToNext(level) = base + scale × (level − 1)^exponent (rounded). */
  curve: { base: 1000, scale: 64, exponent: 1.3, roundTo: 50 } satisfies XpCurveDef,
  prestige: {
    maxRank: 10,
    /** Permanent XP bonus per rank (0.02 = +2 % XP per rank). */
    xpBonusPerRank: 0.02,
    /** Rift-Splitter granted per prestige. */
    currency: 250,
  },
  /** XP per kill by enemy type; types without an entry (new M6 enemies) use `killDefault`. */
  killXp: { swarmer: 10, spitter: 25, tank: 75 } as Readonly<Record<string, number>>,
  killDefault: 15,
  eliteMultiplier: 2,
  headshotBonus: 5,
  weakpointBonus: 3,
  meleeBonus: 5,
  /** Wave completed: base + perWave × wave, capped. */
  wave: { base: 50, perWave: 15, max: 600 },
  /** Run end: XP per full minute survived. */
  survivalPerMinute: 20,
  /** Skill points: per level reached (highest level ever) and per prestige rank. */
  skillPoints: { perLevel: 1, perPrestige: 3 },
  /**
   * Reference player for the pacing test (src/progression/pacing.ts): a solid but not expert
   * player on the research lab, ~2 h a day.
   */
  pacing: {
    killsPerHour: 700,
    killMix: { swarmer: 0.75, spitter: 0.18, tank: 0.07 } as Readonly<Record<string, number>>,
    headshotShare: 0.2,
    weakpointShare: 0.05,
    meleeShare: 0.03,
    eliteShare: 0.02,
    wavesPerHour: 22,
    averageWave: 9,
    hoursPerDay: 2,
    /** Share of the daily / weekly challenges completed. */
    challengeCompletion: 0.8,
    /** Achievements unlocked within the first 50 hours. */
    achievementShare: 0.5,
    targetHours: { min: 40, max: 60 },
  },
  /** Tracking windows and thresholds (RunRecorder). */
  tracking: {
    /** Kills this close together (s, real time) form a multi-kill. */
    multiKillWindow: 1.2,
    /** No-damage waves count from this wave on (wave 1 is trivial). */
    noDamageMinWave: 3,
    /** A run that ends in this wave or earlier is an early death. */
    earlyDeathWave: 1,
  },
  weapon: {
    maxLevel: 30,
    curve: { base: 1500, scale: 58, exponent: 1.25, roundTo: 25 } satisfies XpCurveDef,
    xpPerKill: 20,
    xpPerHit: 1,
    headshotBonus: 10,
    eliteMultiplier: 2,
  },
  /** Profile writes are coalesced this long (level ups, unlocks); run ends save at once. */
  saveDebounceMs: 1500,
} as const;

/** Mode id of runs without a mode (M8 adds modes). */
export const DEFAULT_MODE = 'classic';

/** Leaderboard / highest-wave key of a map + mode. */
export function boardKey(mapId: string, mode: string = DEFAULT_MODE): string {
  return `${mapId}:${mode}`;
}

// ---------------------------------------------------------------------------
// Weapon counters (camo challenges) and lifetime counters
// ---------------------------------------------------------------------------

/** Per-weapon counters camo challenges read (WeaponProgressData.counters). */
export const WEAPON_COUNTERS = {
  kills: { label: 'Kills', condition: { metric: 'kill' } },
  headshots: { label: 'Kopfschuss-Kills', condition: { metric: 'kill', filter: { zone: 'head' } } },
  weakpoints: { label: 'Schwachstellen-Kills', condition: { metric: 'kill', filter: { zone: 'weakpoint' } } },
  elites: { label: 'Elite-Kills', condition: { metric: 'kill', filter: { elite: true } } },
} as const satisfies Record<
  string,
  { readonly label: string; readonly condition: { readonly metric: MetricId; readonly filter?: SignalFilter } }
>;

export type WeaponCounterId = keyof typeof WEAPON_COUNTERS;
export const WEAPON_COUNTER_IDS = Object.keys(WEAPON_COUNTERS) as WeaponCounterId[];

/**
 * Lifetime totals (LifetimeStatsData.counters): each sums one metric (with a filter). Runs and
 * deaths are counted at the run end. Add entries freely – the save keeps unknown-to-old-builds
 * ids out and new ids start at 0.
 */
export const LIFETIME_COUNTERS = {
  runs: { label: 'Runs', metric: 'runEnd' },
  deaths: { label: 'Tode', metric: 'death' },
  kills: { label: 'Kills', metric: 'kill' },
  headshots: { label: 'Kopfschuss-Kills', metric: 'kill', filter: { zone: 'head' } },
  weakpointKills: { label: 'Schwachstellen-Kills', metric: 'kill', filter: { zone: 'weakpoint' } },
  meleeKills: { label: 'Nahkampf-Kills', metric: 'kill', filter: { kind: 'melee' } },
  eliteKills: { label: 'Elite-Kills', metric: 'kill', filter: { elite: true } },
  shotsFired: { label: 'Schüsse', metric: 'shotFired' },
  shotsHit: { label: 'Treffer', metric: 'shotHit' },
  damageDealt: { label: 'Verursachter Schaden', metric: 'damageDealt' },
  damageTaken: { label: 'Erlittener Schaden', metric: 'damageTaken' },
  wavesCompleted: { label: 'Abgeschlossene Wellen', metric: 'waveComplete' },
  noDamageWaves: { label: 'Wellen ohne Schaden', metric: 'noDamageWave' },
  pointsEarned: { label: 'Verdiente Punkte', metric: 'pointsEarned' },
  pointsSpent: { label: 'Ausgegebene Punkte', metric: 'pointsSpent' },
  doorsOpened: { label: 'Geöffnete Türen', metric: 'doorOpened' },
  perksBought: { label: 'Gekaufte Perks', metric: 'perkBought' },
  boxRolls: { label: 'Rift-Kisten', metric: 'boxRoll' },
  powerUpsCollected: { label: 'Power-ups', metric: 'powerUp' },
  forgeUpgrades: { label: 'Schmiede-Upgrades', metric: 'forgeUpgrade' },
  sealsRepaired: { label: 'Reparierte Siegel', metric: 'sealRepaired' },
  grenadesThrown: { label: 'Geworfene Granaten', metric: 'grenadeThrown' },
  abilitiesUsed: { label: 'Eingesetzte Fähigkeiten', metric: 'abilityUsed' },
  combos: { label: 'Elementarkombos', metric: 'combo' },
  revives: { label: 'Wiederbelebungen', metric: 'revive' },
} as const satisfies Record<
  string,
  { readonly label: string; readonly metric: MetricId; readonly filter?: SignalFilter }
>;

export type LifetimeCounterId = keyof typeof LIFETIME_COUNTERS;
export const LIFETIME_COUNTER_IDS = Object.keys(LIFETIME_COUNTERS) as LifetimeCounterId[];

/** Seconds played (run time) are summed at the run end into this counter. */
export const TIME_PLAYED_COUNTER = 'timePlayed';

// ---------------------------------------------------------------------------
// Rewards, limits, toasts
// ---------------------------------------------------------------------------

/** XP and Rift-Splitter per achievement tier. */
export const ACHIEVEMENT_REWARDS: Readonly<Record<AchievementTier, { xp: number; currency: number }>> = {
  bronze: { xp: 250, currency: 5 },
  silver: { xp: 1000, currency: 15 },
  gold: { xp: 2500, currency: 40 },
  platinum: { xp: 6000, currency: 100 },
};

/** Caps of the persisted progression data (sanitizing hostile saves). */
export const PROGRESSION_LIMITS = {
  /** Values kept per distinct condition. */
  maxSeen: 64,
  /** Map/mode keys (leaderboards, highest waves) and entries per board. */
  maxBoards: 32,
  leaderboardSize: 10,
  /** Ids per board entry list (weapons, perks). */
  maxEntryIds: 16,
  /** Keys per kill map (enemy types, weapons) and unlocked cosmetics. */
  maxMapKeys: 128,
  maxUnlocked: 512,
  /** Id-like strings (map/mode keys, seeds) longer than this are dropped. */
  maxIdLength: 64,
  /** Counters never exceed this (hand-edited saves). */
  maxCounter: 1e12,
  maxCurrency: 1e7,
} as const;

/** Progression toasts (HUD, src/ui/hud/ProgressionToasts.ts): game time, queued. */
export const PROGRESSION_TOASTS = {
  /** Seconds a toast stays (entry + hold) and its exit fade. */
  duration: 3.6,
  outSeconds: 0.35,
  /** Toasts on screen at once and waiting at most (older queued ones are dropped). */
  visible: 3,
  maxQueued: 8,
  /** Weapon level ups are toasted every `weaponLevelStep` levels (and at the max level). */
  weaponLevelStep: 5,
} as const;

// ---------------------------------------------------------------------------
// Glyphs (skill tree, achievements, challenges, emblems): stroke-only SVG paths, 24×24
// ---------------------------------------------------------------------------

export const PROGRESSION_GLYPHS = {
  ...PERK_GLYPHS,
  skull:
    'M12 3C7.5 3 4.5 6 4.5 10.5 4.5 13 5.5 14.5 7 15.5V19H17V15.5C18.5 14.5 19.5 13 19.5 10.5 19.5 6 16.5 3 12 3Z M8 10.5H10.5V12.5H8Z M13.5 10.5H16V12.5H13.5Z M10 19V21.5 M14 19V21.5',
  star: 'M12 2.5 14.8 8.6 21.5 9.3 16.5 13.8 17.9 20.5 12 17.1 6.1 20.5 7.5 13.8 2.5 9.3 9.2 8.6Z',
  wave: 'M2 12C4.5 7 7 7 9.5 12 12 17 14.5 17 17 12 18.5 9 20.5 8 22 10 M2 17.5C4.5 14.5 7 14.5 9.5 17.5',
  door: 'M5 21V3H19V21 M3 21H21 M15 11.5V13.5',
  coin: 'M12 2.5A9.5 9.5 0 1 0 12 21.5 9.5 9.5 0 1 0 12 2.5 M12 5.5V18.5 M15 8.5C14 7.5 13 7.2 12 7.2 10 7.2 9 8.2 9 9.5 9 12.5 15 11.2 15 14.3 15 15.8 13.7 16.8 12 16.8 10.8 16.8 9.6 16.3 8.8 15.4',
  grenade:
    'M12 7.5A6.5 6.5 0 1 0 12 20.5 6.5 6.5 0 1 0 12 7.5 M10 7.5V4.5H14V7.5 M14 4.5 18 3 M9 12.5H15 M9 15.5H15',
  flask: 'M9 2.5H15 M10 2.5V9L4.5 19C4 20.2 4.7 21.5 6 21.5H18C19.3 21.5 20 20.2 19.5 19L14 9V2.5 M7 15H17',
  medal: 'M8 2.5 12 9 16 2.5 M12 9A6 6 0 1 0 12 21 6 6 0 1 0 12 9 M12 12 13 14.2 15.3 14.4 13.5 15.9 14.1 18.2 12 17 9.9 18.2 10.5 15.9 8.7 14.4 11 14.2Z',
  box: 'M3 8 12 3 21 8V16L12 21 3 16Z M3 8 12 13 21 8 M12 13V21',
  anvil: 'M3 8H16C16 11 18.5 12 21 12V13H15L13.5 16H16V20H6V16H8.5L7 13C4.5 13 3 11 3 8Z',
  eye: 'M2 12C4.5 7 8 5 12 5 16 5 19.5 7 22 12 19.5 17 16 19 12 19 8 19 4.5 17 2 12Z M12 9A3 3 0 1 0 12 15 3 3 0 1 0 12 9',
  clock: 'M12 2.5A9.5 9.5 0 1 0 12 21.5 9.5 9.5 0 1 0 12 2.5 M12 6.5V12L16 14.5',
  crown: 'M3 18.5H21 M3 18.5 4.5 7 9 11.5 12 5 15 11.5 19.5 7 21 18.5',
  boot: 'M6 3V13L3.5 16V19.5H20.5C20.5 17 18.5 15.5 16 15L11 13.5V3Z',
  snow: 'M12 2.5V21.5 M3.8 7.25 20.2 16.75 M3.8 16.75 20.2 7.25 M9.5 4 12 6 14.5 4 M9.5 20 12 18 14.5 20',
  flame:
    'M12 21.5C8 21.5 5.5 18.5 5.5 15 5.5 11 9 9 9.5 5 12 7 13.5 9.5 13.5 12 15 11 15.5 9.5 15.5 8 17.5 10 18.5 12.5 18.5 15 18.5 18.5 16 21.5 12 21.5Z',
  drop: 'M12 2.5C9 7 5.5 10.5 5.5 14.5A6.5 6.5 0 0 0 18.5 14.5C18.5 10.5 15 7 12 2.5Z',
  lock: 'M6 11H18V21H6Z M8.5 11V7.5A3.5 3.5 0 0 1 15.5 7.5V11 M12 15V17',
  calendar: 'M4 5H20V20H4Z M4 9.5H20 M8 3V7 M16 3V7',
  trophy:
    'M7 3.5H17V9A5 5 0 0 1 7 9Z M7 5.5H3.5C3.5 9 5 10.5 7.2 10.8 M17 5.5H20.5C20.5 9 19 10.5 16.8 10.8 M12 14V18 M8 20.5H16 M9.5 18H14.5V20.5',
  rune: 'M12 2.5 19 12 12 21.5 5 12Z M12 7 15.5 12 12 17 8.5 12Z',
  fist: 'M6 11V7.5C6 6.5 7.5 6.5 7.5 7.5V10.5 M7.5 10V6C7.5 5 9 5 9 6V10 M9 10V6C9 5 10.5 5 10.5 6V10 M10.5 10V6.5C10.5 5.5 12 5.5 12 6.5V11.5L13.5 10C14.3 9.3 15.5 10 15 11L13 14.5V19H6.5V14.5L6 11Z',
} as const satisfies Record<string, string>;

export type ProgressionGlyphId = keyof typeof PROGRESSION_GLYPHS;

export function isGlyphId(id: string): id is ProgressionGlyphId {
  return Object.prototype.hasOwnProperty.call(PROGRESSION_GLYPHS, id);
}
