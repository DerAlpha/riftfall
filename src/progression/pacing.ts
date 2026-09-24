/**
 * XP pacing model (balancing aid, M12): XP per hour of the reference player in
 * PROGRESSION.pacing, built from the same XP rules the game pays out, and the hours to level 100.
 */
import { ACHIEVEMENTS } from '../defs/achievements';
import { CHALLENGE_RULES, CHALLENGE_TEMPLATES } from '../defs/challenges';
import { ACHIEVEMENT_REWARDS, PROGRESSION } from '../defs/progression';
import { createTags } from './signals';
import { killXp, waveXp } from './ProgressionSystem';
import { xpForLevel } from './xpCurve';

const HOURS_PER_DAY_WEEK = 7;

/** Average challenge reward of a period (reward scale at the middle of the range). */
function averageChallengeXp(period: 'daily' | 'weekly'): number {
  const pool = CHALLENGE_TEMPLATES.filter((t) => t.targets[period]);
  const R = CHALLENGE_RULES.rangeRewardScale;
  let weight = 0;
  let sum = 0;
  for (const t of pool) {
    weight += t.weight;
    sum += t.weight * t.difficulty;
  }
  const difficulty = weight > 0 ? sum / weight : 1;
  return CHALLENGE_RULES[period].xp * difficulty * ((R.min + R.max) / 2);
}

export interface XpPacing {
  kills: number;
  waves: number;
  survival: number;
  challenges: number;
  achievements: number;
  total: number;
}

/** XP per hour of play of the reference player (before prestige bonuses). */
export function estimateXpPerHour(): XpPacing {
  const P = PROGRESSION.pacing;
  const tags = createTags();
  let perKill = 0;
  for (const enemy of Object.keys(P.killMix)) {
    tags.enemy = enemy;
    tags.zone = null;
    tags.kind = null;
    tags.elite = false;
    perKill += P.killMix[enemy]! * killXp(tags);
  }
  const base = perKill;
  perKill += base * P.eliteShare * (PROGRESSION.eliteMultiplier - 1);
  perKill += P.headshotShare * PROGRESSION.headshotBonus;
  perKill += P.weakpointShare * PROGRESSION.weakpointBonus;
  perKill += P.meleeShare * PROGRESSION.meleeBonus;
  const kills = P.killsPerHour * perKill;
  const waves = P.wavesPerHour * waveXp(P.averageWave);
  const survival = 60 * PROGRESSION.survivalPerMinute;
  const D = CHALLENGE_RULES.daily;
  const Wk = CHALLENGE_RULES.weekly;
  const challenges =
    P.challengeCompletion *
    ((D.count * averageChallengeXp('daily')) / P.hoursPerDay +
      (Wk.count * averageChallengeXp('weekly')) / (P.hoursPerDay * HOURS_PER_DAY_WEEK));
  let achievementXp = 0;
  for (const a of ACHIEVEMENTS) achievementXp += ACHIEVEMENT_REWARDS[a.tier].xp;
  const hours = (P.targetHours.min + P.targetHours.max) / 2;
  const achievements = (achievementXp * P.achievementShare) / hours;
  return {
    kills,
    waves,
    survival,
    challenges,
    achievements,
    total: kills + waves + survival + challenges + achievements,
  };
}

/** Hours of play from level 1 to the max level for the reference player. */
export function hoursToMaxLevel(): number {
  const total = xpForLevel(PROGRESSION.curve, PROGRESSION.maxLevel, PROGRESSION.maxLevel);
  return total / estimateXpPerHour().total;
}
