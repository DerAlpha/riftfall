/**
 * Validation/repair of the M9 meta progression fields of ProfileData (save v2). Never throws:
 * every field falls back to its default, numbers are clamped to their valid ranges, unknown ids
 * (achievements, skill nodes, weapons, cosmetics, counters) are dropped, arrays and maps are
 * capped (PROGRESSION_LIMITS), duplicates removed. Rules that need the whole profile (skill
 * prerequisites vs. earned points, licensed loadouts) are repaired by the SkillTree on load.
 */
import type {
  AchievementProgressData,
  ChallengeData,
  ChallengeSetData,
  ChallengeSlotData,
  CosmeticsData,
  LeaderboardEntry,
  LifetimeStatsData,
  PlayerProgressData,
  SkillTreeData,
  WeaponProgressData,
} from '../core/contracts';
import type { ChallengePeriod } from '../core/events';
import { ABILITY_IDS } from '../defs/abilities';
import { getAchievementDef } from '../defs/achievements';
import { CHALLENGE_RULES } from '../defs/challenges';
import { DEFAULT_COSMETICS, getCamoDef, getCosmeticDef, type CosmeticDef } from '../defs/cosmetics';
import { GRENADE_IDS } from '../defs/grenades';
import {
  LIFETIME_COUNTER_IDS,
  PROGRESSION,
  PROGRESSION_LIMITS,
  TIME_PLAYED_COUNTER,
  WEAPON_COUNTER_IDS,
} from '../defs/progression';
import { getSkillNode } from '../defs/skills';
import { isWeaponId } from '../defs/weapons';
import { compareEntries } from '../progression/Leaderboards';
import { xpForLevel, xpToNext } from '../progression/xpCurve';
import {
  createDefaultChallenges,
  createDefaultCosmetics,
  createDefaultLifetimeStats,
  createDefaultPlayerProgress,
  createDefaultSkills,
  type ProgressionProfileFields,
} from './defaults';

const L = PROGRESSION_LIMITS;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Finite number or numeric string; null otherwise. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = num(v);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Non-negative amount (counters may be fractional: damage, seconds). */
function amount(v: unknown, max: number = L.maxCounter): number {
  const n = num(v);
  return n !== null && n > 0 ? Math.min(max, n) : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Id-like string within the length limit, else null. */
function idString(v: unknown): string | null {
  return typeof v === 'string' && v.length <= L.maxIdLength && ID_RE.test(v) ? v : null;
}

/** Unique strings passing `keep`, at most `max`. */
function idList(raw: unknown, max: number, keep: (id: string) => boolean): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= max) break;
    const id = idString(v);
    if (id !== null && keep(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Map of id → amount; keys passing `keep`, at most `max` keys, zero values dropped. */
function amountMap(raw: unknown, max: number, keep: (id: string) => boolean, integer = false): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (n >= max) break;
    if (idString(k) === null || !keep(k)) continue;
    const v = amount(raw[k]);
    if (v <= 0) continue;
    out[k] = integer ? Math.floor(v) : v;
    n++;
  }
  return out;
}

// ---------------------------------------------------------------------------

export function sanitizePlayerProgress(raw: unknown): PlayerProgressData {
  const d = createDefaultPlayerProgress();
  if (!isRecord(raw)) return d;
  const max = PROGRESSION.maxLevel;
  const level = int(raw.level, 1, max, d.level);
  const need = xpToNext(PROGRESSION.curve, max, level);
  const xp = need > 0 ? Math.min(need - 1, int(raw.xp, 0, L.maxCounter, 0)) : 0;
  const prestige = int(raw.prestige, 0, PROGRESSION.prestige.maxRank, 0);
  // A prestige rank means level 100 was reached at least once.
  const floor = prestige > 0 ? max : level;
  const highestLevel = Math.max(floor, int(raw.highestLevel, 1, max, 1));
  const lifetimeXp = Math.max(xpForLevel(PROGRESSION.curve, max, level) + xp, Math.floor(amount(raw.lifetimeXp)));
  return { level, xp, prestige, highestLevel, lifetimeXp };
}

export function sanitizeSkills(raw: unknown): SkillTreeData {
  const d = createDefaultSkills();
  if (!isRecord(raw)) return d;
  const ranks: Record<string, number> = {};
  if (isRecord(raw.ranks)) {
    for (const id of Object.keys(raw.ranks)) {
      const node = getSkillNode(id);
      if (!node) continue;
      const r = int(raw.ranks[id], 0, node.maxRank, 0);
      if (r > 0) ranks[id] = r;
    }
  }
  const loadout = isRecord(raw.loadout) ? raw.loadout : {};
  const grenade = typeof loadout.grenade === 'string' && (GRENADE_IDS as readonly string[]).includes(loadout.grenade);
  const ability = typeof loadout.ability === 'string' && (ABILITY_IDS as readonly string[]).includes(loadout.ability);
  return {
    ranks,
    respecs: int(raw.respecs, 0, L.maxCounter, 0),
    loadout: {
      grenade: grenade ? (loadout.grenade as string) : null,
      ability: ability ? (loadout.ability as string) : null,
    },
  };
}

function weaponCamo(id: string): boolean {
  return getCamoDef(id)?.scope === 'weapon';
}

export function sanitizeWeaponProgress(raw: unknown, globalCamos: readonly string[] = []): Record<string, WeaponProgressData> {
  const out: Record<string, WeaponProgressData> = {};
  if (!isRecord(raw)) return out;
  const W = PROGRESSION.weapon;
  for (const id of Object.keys(raw)) {
    if (!isWeaponId(id)) continue;
    const e = raw[id];
    if (!isRecord(e)) continue;
    const level = int(e.level, 1, W.maxLevel, 1);
    const need = xpToNext(W.curve, W.maxLevel, level);
    const camos = idList(e.camos, L.maxUnlocked, weaponCamo);
    const eq = idString(e.equippedCamo);
    const usable = eq !== null && (camos.includes(eq) || (getCamoDef(eq)?.scope === 'global' && globalCamos.includes(eq)));
    out[id] = {
      level,
      xp: need > 0 ? Math.min(need - 1, int(e.xp, 0, L.maxCounter, 0)) : 0,
      counters: amountMap(e.counters, WEAPON_COUNTER_IDS.length, (k) => (WEAPON_COUNTER_IDS as readonly string[]).includes(k), true),
      camos,
      equippedCamo: usable ? eq : null,
    };
  }
  return out;
}

export function sanitizeAchievements(raw: unknown): Record<string, AchievementProgressData> {
  const out: Record<string, AchievementProgressData> = {};
  if (!isRecord(raw)) return out;
  for (const id of Object.keys(raw)) {
    const def = getAchievementDef(id);
    const e = raw[id];
    if (!def || !isRecord(e)) continue;
    const c = def.condition;
    const entry: AchievementProgressData = {
      progress: amount(e.progress),
      unlockedAt: int(e.unlockedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    };
    if (c.kind === 'distinct' && (c.scope ?? 'lifetime') === 'lifetime') {
      const values = c.values;
      entry.seen = idList(e.seen, L.maxSeen, (v) => !values || values.includes(v));
      entry.progress = entry.seen.length;
    }
    if (entry.progress <= 0 && entry.unlockedAt === 0) continue;
    out[id] = entry;
  }
  return out;
}

const KEY_RE: Readonly<Record<ChallengePeriod, RegExp>> = {
  daily: /^riftfall-daily-\d{4}-\d{2}-\d{2}$/,
  weekly: /^riftfall-weekly-\d{4}-\d{2}-\d{2}$/,
};

function sanitizeChallengeSet(raw: unknown, period: ChallengePeriod): ChallengeSetData {
  const empty: ChallengeSetData = { key: '', templates: [], slots: [] };
  if (!isRecord(raw) || typeof raw.key !== 'string' || !KEY_RE[period].test(raw.key)) return empty;
  const count = CHALLENGE_RULES[period].count;
  if (!Array.isArray(raw.templates)) return empty;
  const templates: string[] = [];
  for (const t of raw.templates.slice(0, count)) {
    const id = idString(t);
    if (id === null) return empty;
    templates.push(id);
  }
  const slots: ChallengeSlotData[] = [];
  const rawSlots = Array.isArray(raw.slots) ? raw.slots.slice(0, templates.length) : [];
  for (const s of rawSlots) {
    const slot = isRecord(s) ? s : {};
    slots.push({ progress: amount(slot.progress), claimed: bool(slot.claimed) });
  }
  return { key: raw.key, templates, slots };
}

export function sanitizeChallenges(raw: unknown): ChallengeData {
  const d = createDefaultChallenges();
  if (!isRecord(raw)) return d;
  return {
    daily: sanitizeChallengeSet(raw.daily, 'daily'),
    weekly: sanitizeChallengeSet(raw.weekly, 'weekly'),
    completedDaily: int(raw.completedDaily, 0, L.maxCounter, 0),
    completedWeekly: int(raw.completedWeekly, 0, L.maxCounter, 0),
  };
}

function isGlobalCamo(id: string): boolean {
  return getCamoDef(id)?.scope === 'global';
}

export function sanitizeCosmetics(raw: unknown): CosmeticsData {
  const d = createDefaultCosmetics();
  if (!isRecord(raw)) return d;
  const unlocked = idList(raw.unlocked, L.maxUnlocked, (id) => {
    const def = getCosmeticDef(id);
    return (def !== undefined && def.unlock.kind !== 'default') || isGlobalCamo(id);
  });
  const owned = (id: string, kind: CosmeticDef['kind']): boolean => {
    const def = getCosmeticDef(id);
    return def !== undefined && def.kind === kind && (def.unlock.kind === 'default' || unlocked.includes(id));
  };
  const eq = isRecord(raw.equipped) ? raw.equipped : {};
  const pick = (v: unknown, kind: CosmeticDef['kind']): string | null => {
    const id = idString(v);
    return id !== null && owned(id, kind) ? id : null;
  };
  return {
    currency: Math.floor(amount(raw.currency, L.maxCurrency)),
    unlocked,
    equipped: {
      crosshair: pick(eq.crosshair, 'crosshair') ?? DEFAULT_COSMETICS.crosshair,
      killEffect: pick(eq.killEffect, 'killEffect') ?? DEFAULT_COSMETICS.killEffect,
      charm: pick(eq.charm, 'charm'),
      emblem: eq.emblem === null ? null : (pick(eq.emblem, 'emblem') ?? DEFAULT_COSMETICS.emblem),
    },
  };
}

const COUNTER_IDS: readonly string[] = [...LIFETIME_COUNTER_IDS, TIME_PLAYED_COUNTER];
const BOARD_KEY_RE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

function boardKeyOk(k: string): boolean {
  return k.length <= L.maxIdLength && BOARD_KEY_RE.test(k);
}

export function sanitizeLifetimeStats(raw: unknown): LifetimeStatsData {
  const d = createDefaultLifetimeStats();
  if (!isRecord(raw)) return d;
  return {
    counters: amountMap(raw.counters, COUNTER_IDS.length, (k) => COUNTER_IDS.includes(k)),
    killsByEnemy: amountMap(raw.killsByEnemy, L.maxMapKeys, () => true, true),
    killsByWeapon: amountMap(raw.killsByWeapon, L.maxMapKeys, () => true, true),
    highestWave: amountMap(raw.highestWave, L.maxBoards, boardKeyOk, true),
    bestScore: amountMap(raw.bestScore, L.maxBoards, boardKeyOk, true),
  };
}

function sanitizeEntry(raw: unknown): LeaderboardEntry | null {
  if (!isRecord(raw)) return null;
  const wave = num(raw.wave);
  if (wave === null || wave < 0) return null;
  const seed = raw.seed === null || raw.seed === undefined ? null : idString(raw.seed);
  return {
    wave: Math.floor(wave),
    kills: Math.floor(amount(raw.kills)),
    score: Math.floor(amount(raw.score)),
    points: Math.floor(amount(raw.points)),
    time: Math.round(amount(raw.time)),
    date: int(raw.date, 0, Number.MAX_SAFE_INTEGER, 0),
    weapons: idList(raw.weapons, L.maxEntryIds, () => true),
    perks: idList(raw.perks, L.maxEntryIds, () => true),
    level: int(raw.level, 1, PROGRESSION.maxLevel, 1),
    prestige: int(raw.prestige, 0, PROGRESSION.prestige.maxRank, 0),
    seed,
  };
}

export function sanitizeLeaderboards(raw: unknown): Record<string, LeaderboardEntry[]> {
  const out: Record<string, LeaderboardEntry[]> = {};
  if (!isRecord(raw)) return out;
  let boards = 0;
  for (const key of Object.keys(raw)) {
    if (boards >= L.maxBoards) break;
    const list = raw[key];
    if (!boardKeyOk(key) || !Array.isArray(list)) continue;
    const entries: LeaderboardEntry[] = [];
    // Hostile saves: only look at a bounded prefix.
    for (const e of list.slice(0, L.leaderboardSize * 4)) {
      const entry = sanitizeEntry(e);
      if (entry) entries.push(entry);
    }
    // Array.prototype.sort is stable: equal runs keep their stored order.
    entries.sort(compareEntries);
    if (entries.length > L.leaderboardSize) entries.length = L.leaderboardSize;
    if (entries.length === 0) continue;
    out[key] = entries;
    boards++;
  }
  return out;
}

/** Every M9 field of a profile from anything (missing, corrupt, hostile). */
export function sanitizeProgressionFields(src: Record<string, unknown>): ProgressionProfileFields {
  const cosmetics = sanitizeCosmetics(src.cosmetics);
  const globals = cosmetics.unlocked.filter(isGlobalCamo);
  return {
    progression: sanitizePlayerProgress(src.progression),
    skills: sanitizeSkills(src.skills),
    weaponProgress: sanitizeWeaponProgress(src.weaponProgress, globals),
    achievements: sanitizeAchievements(src.achievements),
    challenges: sanitizeChallenges(src.challenges),
    cosmetics,
    lifetimeStats: sanitizeLifetimeStats(src.lifetimeStats),
    leaderboards: sanitizeLeaderboards(src.leaderboards),
  };
}
