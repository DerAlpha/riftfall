/**
 * Pure power-up drop rules (unit-tested with a seeded Rng; allocation-free):
 * - every eligible kill counts towards the pity counter, then – unless the wave cap is reached or
 *   the last drop was less than `minSpacing` s ago – rolls `chance` × the dropChance stat;
 * - pity: after `pity.kills` kills or `pity.seconds` of wave time without a drop, the next kill
 *   that is not capped / spaced drops for sure;
 * - the type is a weighted pick among the types whose condition holds, never the last dropped one
 *   (`noRepeat`) unless nothing else qualifies.
 */
import type { Rng } from '../core/Rng';
import type { PowerUpCondition, PowerUpDef } from '../defs/powerups';

export interface DropRuleDef {
  readonly chance: number;
  readonly maxPerWave: number;
  readonly pity: { readonly kills: number; readonly seconds: number };
  readonly minSpacing: number;
  readonly noRepeat: boolean;
}

export interface DropState {
  dropsThisWave: number;
  killsSinceDrop: number;
  /** Wave time since the last drop (s; advanced only while a wave runs). */
  timeSinceDrop: number;
  /** Game time of the last drop (−∞ = none yet). */
  lastDropAt: number;
  lastType: string | null;
}

export function createDropState(): DropState {
  return {
    dropsThisWave: 0,
    killsSinceDrop: 0,
    timeSinceDrop: 0,
    lastDropAt: Number.NEGATIVE_INFINITY,
    lastType: null,
  };
}

/** New run. */
export function resetDropState(s: DropState): void {
  s.dropsThisWave = 0;
  s.killsSinceDrop = 0;
  s.timeSinceDrop = 0;
  s.lastDropAt = Number.NEGATIVE_INFINITY;
  s.lastType = null;
}

/** A new wave: the per-wave cap starts over (pity progress carries on). */
export function startDropWave(s: DropState): void {
  s.dropsThisWave = 0;
}

/** Pity reached (the next uncapped kill drops for sure)? */
export function pityReached(s: DropState, rule: DropRuleDef): boolean {
  return s.killsSinceDrop >= rule.pity.kills || s.timeSinceDrop >= rule.pity.seconds;
}

/**
 * An eligible kill at game time `now`: does it drop? `chanceMultiplier` = the dropChance stat.
 * Consumes one random number whenever the kill is neither capped nor spaced out.
 */
export function rollKill(
  s: DropState,
  rule: DropRuleDef,
  rng: Rng,
  chanceMultiplier: number,
  now: number,
): boolean {
  s.killsSinceDrop++;
  if (s.dropsThisWave >= rule.maxPerWave) return false;
  if (now - s.lastDropAt < rule.minSpacing) return false;
  const roll = rng.next();
  const mul = chanceMultiplier >= 0 && Number.isFinite(chanceMultiplier) ? chanceMultiplier : 1;
  return pityReached(s, rule) || roll < rule.chance * mul;
}

/** Book a drop that happened (counted types only). */
export function noteDrop(s: DropState, type: string, now: number): void {
  s.dropsThisWave++;
  s.killsSinceDrop = 0;
  s.timeSinceDrop = 0;
  s.lastDropAt = now;
  s.lastType = type;
}

/**
 * Weighted random type among `defs` (weight > 0, condition met via `conditionMet`), excluding
 * `exclude` unless it is the only candidate. Null when nothing qualifies.
 */
export function pickDropType(
  defs: readonly PowerUpDef[],
  exclude: string | null,
  rng: Rng,
  conditionMet: (c: PowerUpCondition) => boolean,
): string | null {
  let total = 0;
  let fallback: PowerUpDef | null = null;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]!;
    if (!(d.weight > 0) || !conditionMet(d.condition)) continue;
    if (d.id === exclude) {
      fallback = d;
      continue;
    }
    total += d.weight;
  }
  if (total <= 0) return fallback ? fallback.id : null;
  let r = rng.next() * total;
  let last: PowerUpDef | null = null;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]!;
    if (!(d.weight > 0) || d.id === exclude || !conditionMet(d.condition)) continue;
    last = d;
    r -= d.weight;
    if (r < 0) return d.id;
  }
  return last ? last.id : null;
}
