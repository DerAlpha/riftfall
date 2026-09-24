import { describe, expect, it } from 'vitest';
import { PROGRESSION } from '../defs/progression';
import { estimateXpPerHour, hoursToMaxLevel } from './pacing';
import { addLevelXp, levelFromTotal, xpForLevel, xpToNext } from './xpCurve';

const C = PROGRESSION.curve;
const MAX = PROGRESSION.maxLevel;

describe('player XP curve', () => {
  it('is monotonic: every level needs at least as much XP as the one before', () => {
    let prev = 0;
    for (let l = 1; l < MAX; l++) {
      const need = xpToNext(C, MAX, l);
      expect(need).toBeGreaterThan(0);
      expect(need).toBeGreaterThanOrEqual(prev);
      expect(need % C.roundTo).toBe(0);
      prev = need;
    }
    expect(xpToNext(C, MAX, MAX)).toBe(0);
    expect(xpToNext(C, MAX, 0)).toBe(0);
  });

  it('cumulative XP matches the per-level steps and inverts', () => {
    expect(xpForLevel(C, MAX, 1)).toBe(0);
    let sum = 0;
    for (let l = 1; l < MAX; l++) {
      expect(xpForLevel(C, MAX, l)).toBe(sum);
      sum += xpToNext(C, MAX, l);
      expect(levelFromTotal(C, MAX, sum)).toEqual({ level: l + 1, xp: 0 });
      expect(levelFromTotal(C, MAX, sum - 1)).toEqual({ level: l, xp: xpToNext(C, MAX, l) - 1 });
    }
    expect(xpForLevel(C, MAX, MAX)).toBe(sum);
    expect(levelFromTotal(C, MAX, sum * 10)).toEqual({ level: MAX, xp: 0 });
    expect(levelFromTotal(C, MAX, Number.NaN)).toEqual({ level: 1, xp: 0 });
  });

  it('level 100 is reachable in 40–60 hours for the reference player', () => {
    const pace = estimateXpPerHour();
    expect(pace.total).toBeGreaterThan(0);
    // Kills are the main source; challenges and achievements add a noticeable share.
    expect(pace.kills).toBeGreaterThan(pace.challenges);
    const hours = hoursToMaxLevel();
    expect(hours).toBeGreaterThanOrEqual(PROGRESSION.pacing.targetHours.min);
    expect(hours).toBeLessThanOrEqual(PROGRESSION.pacing.targetHours.max);
    // Early levels are quick (minutes), the last one takes about an hour.
    expect(xpToNext(C, MAX, 1) / pace.total).toBeLessThan(0.1);
    expect(xpToNext(C, MAX, MAX - 1) / pace.total).toBeGreaterThan(0.5);
  });

  it('addLevelXp carries over several levels and stops at the max level', () => {
    const s = { level: 1, xp: 0 };
    const two = xpToNext(C, MAX, 1) + xpToNext(C, MAX, 2);
    expect(addLevelXp(s, two + 7, C, MAX)).toBe(2);
    expect(s).toEqual({ level: 3, xp: 7 });
    expect(addLevelXp(s, -5, C, MAX)).toBe(0);
    expect(addLevelXp(s, Number.NaN, C, MAX)).toBe(0);
    expect(s).toEqual({ level: 3, xp: 7 });
    const gained = addLevelXp(s, xpForLevel(C, MAX, MAX) * 2, C, MAX);
    expect(gained).toBe(MAX - 3);
    expect(s).toEqual({ level: MAX, xp: 0 });
    expect(addLevelXp(s, 1000, C, MAX)).toBe(0);
    expect(s.xp).toBe(0);
  });
});

describe('weapon XP curve', () => {
  const W = PROGRESSION.weapon;

  it('is monotonic and the max weapon level takes a few hours of one weapon', () => {
    let prev = 0;
    for (let l = 1; l < W.maxLevel; l++) {
      const need = xpToNext(W.curve, W.maxLevel, l);
      expect(need).toBeGreaterThanOrEqual(prev);
      prev = need;
    }
    const total = xpForLevel(W.curve, W.maxLevel, W.maxLevel);
    // ~700 kills an hour with one weapon (+ hits): 3–10 hours to master it.
    const perHour = PROGRESSION.pacing.killsPerHour * (W.xpPerKill + PROGRESSION.pacing.headshotShare * W.headshotBonus);
    expect(total / perHour).toBeGreaterThan(3);
    expect(total / perHour).toBeLessThan(10);
  });
});
