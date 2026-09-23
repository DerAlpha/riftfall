/**
 * Default save/profile data. Pure (no browser APIs) so migrations and tests can use it.
 */
import type { ProfileData, SaveData } from '../core/contracts';
import { ENGINE } from '../defs/engine';
import { createDefaultSettings } from './settingsSchema';

/** Fresh profile: movement abilities start locked (meta progression unlocks them later). */
export function createDefaultProfile(now: number = Date.now()): ProfileData {
  return {
    createdAt: now,
    lastPlayedAt: now,
    unlocks: { doubleJump: false, dash: false },
    qualityAutoDetected: false,
    qualityBenchmarked: false,
  };
}

export function createDefaultSave(now: number = Date.now()): SaveData {
  return {
    version: ENGINE.saveVersion,
    settings: createDefaultSettings(),
    profile: createDefaultProfile(now),
  };
}
