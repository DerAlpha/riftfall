/**
 * Level curves (player and weapon levels): xpToNext(level) = base + scale × (level − 1)^exponent,
 * rounded to `roundTo` (never below `roundTo`). Pure functions – the tables are small and cached
 * per curve object so lookups in hot paths (XP per kill) are array reads.
 */
import type { XpCurveDef } from '../defs/progression';

interface CurveTable {
  readonly toNext: Float64Array;
  /** XP from level 1 to reach level i (index = level). */
  readonly cumulative: Float64Array;
}

const tables = new WeakMap<XpCurveDef, Map<number, CurveTable>>();

function rawToNext(curve: XpCurveDef, level: number): number {
  const v = curve.base + curve.scale * Math.pow(Math.max(0, level - 1), curve.exponent);
  const step = curve.roundTo > 0 ? curve.roundTo : 1;
  return Math.max(step, Math.round(v / step) * step);
}

function table(curve: XpCurveDef, maxLevel: number): CurveTable {
  let byMax = tables.get(curve);
  if (!byMax) {
    byMax = new Map();
    tables.set(curve, byMax);
  }
  let t = byMax.get(maxLevel);
  if (!t) {
    const toNext = new Float64Array(maxLevel + 1);
    const cumulative = new Float64Array(maxLevel + 1);
    for (let l = 1; l <= maxLevel; l++) {
      cumulative[l] = l === 1 ? 0 : cumulative[l - 1]! + toNext[l - 1]!;
      toNext[l] = l < maxLevel ? rawToNext(curve, l) : 0;
    }
    t = { toNext, cumulative };
    byMax.set(maxLevel, t);
  }
  return t;
}

/** XP needed from `level` to the next one (0 at / above the max level). */
export function xpToNext(curve: XpCurveDef, maxLevel: number, level: number): number {
  if (!(level >= 1) || level >= maxLevel) return 0;
  return table(curve, maxLevel).toNext[Math.floor(level)]!;
}

/** Total XP from level 1 to reach `level` (clamped to 1..maxLevel). */
export function xpForLevel(curve: XpCurveDef, maxLevel: number, level: number): number {
  const l = Math.min(maxLevel, Math.max(1, Math.floor(level)));
  return table(curve, maxLevel).cumulative[l]!;
}

/** Level and XP into it for a total XP amount (from level 1). */
export function levelFromTotal(
  curve: XpCurveDef,
  maxLevel: number,
  total: number,
): { level: number; xp: number } {
  const t = table(curve, maxLevel);
  const xp = Number.isFinite(total) && total > 0 ? total : 0;
  let level = 1;
  while (level < maxLevel && t.cumulative[level + 1]! <= xp) level++;
  return { level, xp: level >= maxLevel ? 0 : xp - t.cumulative[level]! };
}

export interface LevelState {
  level: number;
  xp: number;
}

/**
 * Add XP to a level state in place; returns the number of levels gained. At the max level the
 * XP stays 0 (the excess is only counted elsewhere, e.g. lifetime XP).
 */
export function addLevelXp(state: LevelState, amount: number, curve: XpCurveDef, maxLevel: number): number {
  if (!(amount > 0) || !Number.isFinite(amount) || state.level >= maxLevel) {
    if (state.level >= maxLevel) state.xp = 0;
    return 0;
  }
  let gained = 0;
  state.xp += amount;
  let need = xpToNext(curve, maxLevel, state.level);
  while (need > 0 && state.xp >= need) {
    state.xp -= need;
    state.level++;
    gained++;
    need = xpToNext(curve, maxLevel, state.level);
  }
  if (state.level >= maxLevel) state.xp = 0;
  return gained;
}
