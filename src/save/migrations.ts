/**
 * Save format versions and migrations.
 *
 * Version history:
 *  - v0 (legacy, unversioned pre-release build): a flat JSON object in localStorage under
 *    ENGINE.localStorageKey, e.g. `{ settings: { graphics: {...}, ... } (partial), sensitivity: 2.1,
 *    fov: 100, masterVolume: 0.7, invertY: false, createdAt: 1700000000000 }`. The flat fields were the
 *    source of truth for those values and override `settings`.
 *  - v1: `SaveData` from src/core/contracts.ts: `{ version: 1, settings, profile }`.
 *  - v2 (M9 meta progression): the profile gains `progression`, `skills`, `weaponProgress`,
 *    `achievements`, `challenges`, `cosmetics`, `lifetimeStats` and `leaderboards`. The migration
 *    fills their defaults and keeps every v1 field (settings, unlocks, quality flags).
 *
 * Adding a version: bump ENGINE.saveVersion and add MIGRATIONS[n] (n -> n+1). Migrations operate on
 * plain JSON objects; the final object is always validated with sanitizeSettings/sanitizeProfile.
 */
import type { SaveData } from '../core/contracts';
import { createLogger } from '../core/log';
import { ENGINE } from '../defs/engine';
import { createDefaultProgressionFields, createDefaultSave } from './defaults';
import { cloneJson, isRecord, sanitizeProfile, sanitizeSettings } from './sanitize';

const log = createLogger('Save');

export const SAVE_VERSION: number = ENGINE.saveVersion;

export type JsonObject = Record<string, unknown>;
/** Migrates a save object of version n to version n + 1. May throw on hopeless input. */
export type Migration = (data: JsonObject, now: number) => JsonObject;

/** Legacy (v0) save layout – documented for the migration and tests. */
export interface LegacySaveV0 {
  settings?: JsonObject;
  /** Mouse sensitivity multiplier (-> controls.mouseSensitivity). */
  sensitivity?: number;
  /** Horizontal FOV in degrees (-> controls.fov). */
  fov?: number;
  /** 0..1 (-> audio.master). */
  masterVolume?: number;
  /** (-> controls.invertY). */
  invertY?: boolean;
  createdAt?: number;
}

function section(obj: JsonObject, key: string): JsonObject {
  const existing = obj[key];
  if (isRecord(existing)) return existing;
  const created: JsonObject = {};
  obj[key] = created;
  return created;
}

function migrateV0toV1(data: JsonObject, now: number): JsonObject {
  const settings: JsonObject = isRecord(data.settings) ? cloneJson(data.settings) : {};
  const controls = section(settings, 'controls');
  const audio = section(settings, 'audio');
  if (data.sensitivity !== undefined) controls.mouseSensitivity = data.sensitivity;
  if (data.fov !== undefined) controls.fov = data.fov;
  if (data.invertY !== undefined) controls.invertY = data.invertY;
  if (data.masterVolume !== undefined) audio.master = data.masterVolume;
  const createdAt = typeof data.createdAt === 'number' ? data.createdAt : now;
  return {
    version: 1,
    settings,
    // Pre-release builds had no profile; auto-detection/benchmark run again for the new renderer.
    profile: { createdAt, lastPlayedAt: createdAt },
  };
}

function migrateV1toV2(data: JsonObject): JsonObject {
  const profile: JsonObject = isRecord(data.profile) ? cloneJson(data.profile) : {};
  const fresh = createDefaultProgressionFields() as unknown as JsonObject;
  // Fill what is missing; a (pre-release) v1 profile that already carries a field keeps it for the
  // sanitizer to validate.
  for (const key of Object.keys(fresh))
    if (!Object.prototype.hasOwnProperty.call(profile, key)) profile[key] = fresh[key];
  return { ...data, version: 2, profile };
}

export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: migrateV0toV1,
  1: migrateV1toV2,
};

export type MigrationStatus = 'empty' | 'current' | 'migrated' | 'corrupt' | 'future';

export interface MigrationResult {
  data: SaveData;
  /** Version the stored data had when it was migrated, null if no migration ran. */
  migratedFrom: number | null;
  /** True when stored data could not be used (corrupt or from a newer build) and defaults were returned. */
  recovered: boolean;
  status: MigrationStatus;
  /** Version found in the stored data (null for empty/unparseable data). */
  storedVersion: number | null;
}

function defaults(status: MigrationStatus, storedVersion: number | null, now: number): MigrationResult {
  return {
    data: createDefaultSave(now),
    migratedFrom: null,
    recovered: status === 'corrupt' || status === 'future',
    status,
    storedVersion,
  };
}

/** Detect the version of a parsed save object: missing field = legacy v0, invalid = null. */
export function detectVersion(obj: JsonObject): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, 'version')) return 0;
  const v = obj.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Turn whatever is stored (object, JSON string, undefined, garbage) into a valid current SaveData.
 * Never throws.
 */
export function migrateSave(raw: unknown, now: number = Date.now()): MigrationResult {
  if (raw === undefined || raw === null) return defaults('empty', null, now);

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn('Save data is not valid JSON – using defaults');
      return defaults('corrupt', null, now);
    }
  }
  if (!isRecord(parsed)) {
    log.warn('Save data is not an object – using defaults');
    return defaults('corrupt', null, now);
  }

  const storedVersion = detectVersion(parsed);
  if (storedVersion === null) {
    log.warn('Save data has an invalid version field – using defaults');
    return defaults('corrupt', null, now);
  }
  if (storedVersion > SAVE_VERSION) {
    log.warn(`Save data is from a newer version (v${storedVersion} > v${SAVE_VERSION}) – using defaults`);
    return defaults('future', storedVersion, now);
  }

  let obj: JsonObject = parsed;
  try {
    for (let v = storedVersion; v < SAVE_VERSION; v++) {
      const migrate = MIGRATIONS[v];
      if (!migrate) throw new Error(`no migration from v${v}`);
      obj = migrate(obj, now);
    }
  } catch (err) {
    log.error(`Save migration from v${storedVersion} failed – using defaults`, err);
    return defaults('corrupt', storedVersion, now);
  }

  const migrated = storedVersion < SAVE_VERSION;
  if (migrated) log.info(`Migrated save v${storedVersion} → v${SAVE_VERSION}`);
  return {
    data: {
      version: SAVE_VERSION,
      settings: sanitizeSettings(obj.settings),
      profile: sanitizeProfile(obj.profile, now),
    },
    migratedFrom: migrated ? storedVersion : null,
    recovered: false,
    status: migrated ? 'migrated' : 'current',
    storedVersion,
  };
}
