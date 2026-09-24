/**
 * Default save/profile data. Pure (no browser APIs) so migrations and tests can use it.
 */
import type {
  ChallengeData,
  CosmeticsData,
  LifetimeStatsData,
  PlayerProgressData,
  ProfileData,
  SaveData,
  SkillTreeData,
} from '../core/contracts';
import { DEFAULT_COSMETICS } from '../defs/cosmetics';
import { ENGINE } from '../defs/engine';
import { createDefaultSettings } from './settingsSchema';

/** M9 meta progression fields of a fresh profile (save v2). */
export type ProgressionProfileFields = Pick<
  ProfileData,
  | 'progression'
  | 'skills'
  | 'weaponProgress'
  | 'achievements'
  | 'challenges'
  | 'cosmetics'
  | 'lifetimeStats'
  | 'leaderboards'
>;

export function createDefaultPlayerProgress(): PlayerProgressData {
  return { level: 1, xp: 0, prestige: 0, highestLevel: 1, lifetimeXp: 0 };
}

export function createDefaultSkills(): SkillTreeData {
  return { ranks: {}, respecs: 0, loadout: { grenade: null, ability: null } };
}

export function createDefaultChallenges(): ChallengeData {
  return {
    daily: { key: '', templates: [], slots: [] },
    weekly: { key: '', templates: [], slots: [] },
    completedDaily: 0,
    completedWeekly: 0,
  };
}

export function createDefaultCosmetics(): CosmeticsData {
  return { currency: 0, unlocked: [], equipped: { ...DEFAULT_COSMETICS } };
}

export function createDefaultLifetimeStats(): LifetimeStatsData {
  return { counters: {}, killsByEnemy: {}, killsByWeapon: {}, highestWave: {}, bestScore: {} };
}

export function createDefaultProgressionFields(): ProgressionProfileFields {
  return {
    progression: createDefaultPlayerProgress(),
    skills: createDefaultSkills(),
    weaponProgress: {},
    achievements: {},
    challenges: createDefaultChallenges(),
    cosmetics: createDefaultCosmetics(),
    lifetimeStats: createDefaultLifetimeStats(),
    leaderboards: {},
  };
}

/** Fresh profile: movement abilities start locked (the skill tree unlocks them). */
export function createDefaultProfile(now: number = Date.now()): ProfileData {
  return {
    createdAt: now,
    lastPlayedAt: now,
    unlocks: { doubleJump: false, dash: false },
    qualityAutoDetected: false,
    qualityBenchmarked: false,
    ...createDefaultProgressionFields(),
  };
}

export function createDefaultSave(now: number = Date.now()): SaveData {
  return {
    version: ENGINE.saveVersion,
    settings: createDefaultSettings(),
    profile: createDefaultProfile(now),
  };
}
