import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ProfileData } from '../core/contracts';
import { ACHIEVEMENTS } from '../defs/achievements';
import { ENGINE } from '../defs/engine';
import { PROGRESSION, PROGRESSION_LIMITS } from '../defs/progression';
import { xpToNext } from '../progression/xpCurve';
import { createDefaultProfile, createDefaultProgressionFields, createDefaultSave } from './defaults';
import { MIGRATIONS, SAVE_VERSION, migrateSave } from './migrations';
import { sanitizeProfile } from './sanitize';
import {
  sanitizeAchievements,
  sanitizeChallenges,
  sanitizeCosmetics,
  sanitizeLeaderboards,
  sanitizeLifetimeStats,
  sanitizePlayerProgress,
  sanitizeSkills,
  sanitizeWeaponProgress,
} from './sanitizeProgression';
import { SaveSystem } from './SaveSystem';

/** A v1 save as the M1–M5 builds wrote it (no meta progression). */
const V1_FIXTURE = {
  version: 1,
  settings: { controls: { fov: 101, mouseSensitivity: 1.7 }, audio: { music: 0.3 } },
  profile: {
    createdAt: 1_700_000_000_000,
    lastPlayedAt: 1_750_000_000_000,
    unlocks: { doubleJump: true, dash: false },
    qualityAutoDetected: true,
    qualityBenchmarked: true,
  },
  savedAt: 1_750_000_000_001,
  baseSavedAt: 0,
};

/** The unversioned pre-release layout (v0). */
const V0_FIXTURE = { sensitivity: 2.5, fov: 99, masterVolume: 0.4, invertY: true, createdAt: 1234 };

describe('save v2 migration', () => {
  it('is version 2 with a migration for every older version', () => {
    expect(SAVE_VERSION).toBe(2);
    expect(ENGINE.saveVersion).toBe(2);
    expect(typeof MIGRATIONS[0]).toBe('function');
    expect(typeof MIGRATIONS[1]).toBe('function');
  });

  it('migrates v1 → v2: keeps settings and profile, fills the progression defaults', () => {
    const r = migrateSave(JSON.parse(JSON.stringify(V1_FIXTURE)), 5);
    expect(r).toMatchObject({ status: 'migrated', migratedFrom: 1, recovered: false, storedVersion: 1 });
    expect(r.data.version).toBe(2);
    expect(r.data.settings.controls.fov).toBe(101);
    expect(r.data.settings.controls.mouseSensitivity).toBe(1.7);
    expect(r.data.settings.audio.music).toBe(0.3);
    expect(r.data.profile).toEqual({
      createdAt: 1_700_000_000_000,
      lastPlayedAt: 1_750_000_000_000,
      unlocks: { doubleJump: true, dash: false },
      qualityAutoDetected: true,
      qualityBenchmarked: true,
      ...createDefaultProgressionFields(),
    });
  });

  it('migrates v0 → v1 → v2 in one load', () => {
    const r = migrateSave(JSON.stringify(V0_FIXTURE), 9);
    expect(r).toMatchObject({ status: 'migrated', migratedFrom: 0 });
    expect(r.data.settings.controls.fov).toBe(99);
    expect(r.data.settings.audio.master).toBe(0.4);
    expect(r.data.profile.createdAt).toBe(1234);
    expect(r.data.profile.progression).toEqual(createDefaultProgressionFields().progression);
    expect(r.data.profile.challenges.daily.key).toBe('');
  });

  it('keeps a pre-release v1 profile that already carried progression data (validated)', () => {
    const v1 = JSON.parse(JSON.stringify(V1_FIXTURE)) as { profile: Record<string, unknown> };
    v1.profile.progression = { level: 12, xp: 5, prestige: 0, highestLevel: 12, lifetimeXp: 1 };
    const r = migrateSave(v1);
    expect(r.data.profile.progression.level).toBe(12);
    expect(r.data.profile.progression.lifetimeXp).toBeGreaterThan(1);
  });

  it('a current v2 save round-trips unchanged (sanitizers are idempotent)', () => {
    const save = createDefaultSave(1000);
    const p = save.profile;
    p.progression = { level: 42, xp: 1234, prestige: 2, highestLevel: 100, lifetimeXp: 3_000_000 };
    p.skills = {
      ranks: { off_caliber: 3, tac_dash: 1 },
      respecs: 1,
      loadout: { grenade: 'brand', ability: null },
    };
    p.weaponProgress = {
      rifle: {
        level: 12,
        xp: 30,
        counters: { kills: 300, headshots: 60 },
        camos: ['camo.urban', 'camo.gold'],
        equippedCamo: 'camo.gold',
      },
    };
    p.achievements = {
      first_blood: { progress: 1, unlockedAt: 5000 },
      combos_all: { progress: 2, unlockedAt: 0, seen: ['thermoshock', 'neurotoxin'] },
    };
    p.challenges.daily = {
      key: 'riftfall-daily-2026-09-24',
      templates: ['kills', 'waves', 'box'],
      slots: [
        { progress: 3, claimed: false },
        { progress: 0, claimed: false },
        { progress: 9, claimed: true },
      ],
    };
    p.cosmetics = {
      currency: 77,
      unlocked: ['charm.tag', 'camo.aurora'],
      equipped: {
        crosshair: 'crosshair.cross',
        killEffect: 'killfx.default',
        charm: 'charm.tag',
        emblem: 'emblem.recruit',
      },
    };
    p.lifetimeStats = {
      counters: { kills: 10, timePlayed: 1.5 },
      killsByEnemy: { swarmer: 10 },
      killsByWeapon: { rifle: 10 },
      highestWave: { 'lab:classic': 9 },
      bestScore: { 'lab:classic': 4000 },
    };
    p.leaderboards = {
      'lab:classic': [
        {
          wave: 9,
          kills: 80,
          score: 4000,
          points: 20000,
          time: 700,
          date: 5,
          weapons: ['rifle'],
          perks: ['titan'],
          level: 40,
          prestige: 2,
          seed: null,
        },
      ],
    };
    const r = migrateSave(JSON.parse(JSON.stringify(save)));
    expect(r.status).toBe('current');
    expect(r.data).toEqual(save);
  });

  it('SaveSystem loads a stored v1 save from IndexedDB and persists it as v2', async () => {
    const factory = new IDBFactory();
    const sys = await SaveSystem.create({ env: { indexedDB: factory, localStorage: null } });
    await sys.backend.write(ENGINE.saveSlotKey, JSON.parse(JSON.stringify(V1_FIXTURE)));
    const loaded = await sys.load();
    expect(sys.lastLoad).toMatchObject({ status: 'migrated', migratedFrom: 1 });
    loaded.profile.progression.level = 3;
    await sys.save(loaded);
    const again = await SaveSystem.create({ env: { indexedDB: factory, localStorage: null } });
    const reloaded = await again.load();
    expect(again.lastLoad?.status).toBe('current');
    expect(reloaded.profile.progression.level).toBe(3);
    expect(reloaded.profile.unlocks.doubleJump).toBe(true);
  });
});

describe('sanitizing hostile progression data', () => {
  // Saves come from JSON / structured clone: a "__proto__" key is an own property there.
  const garbage: unknown[] = [
    undefined,
    null,
    42,
    'x',
    [],
    [1, 2],
    true,
    JSON.parse('{"__proto__":{"level":99}}'),
    Number.NaN,
  ];

  it('every sanitizer returns defaults for garbage', () => {
    const d = createDefaultProgressionFields();
    for (const g of garbage) {
      expect(sanitizePlayerProgress(g)).toEqual(d.progression);
      expect(sanitizeSkills(g)).toEqual(d.skills);
      expect(sanitizeWeaponProgress(g)).toEqual({});
      expect(sanitizeAchievements(g)).toEqual({});
      expect(sanitizeChallenges(g)).toEqual(d.challenges);
      expect(sanitizeCosmetics(g)).toEqual(d.cosmetics);
      expect(sanitizeLifetimeStats(g)).toEqual(d.lifetimeStats);
      expect(sanitizeLeaderboards(g)).toEqual({});
    }
    const p: ProfileData = sanitizeProfile({ progression: 'lol', skills: 7, leaderboards: [] }, 3);
    expect(p).toEqual(createDefaultProfile(3));
  });

  it('clamps level, XP, prestige and keeps the level consistent', () => {
    expect(sanitizePlayerProgress({ level: 999, xp: 1e9, prestige: -4, highestLevel: 3 })).toMatchObject({
      level: PROGRESSION.maxLevel,
      xp: 0,
      prestige: 0,
      highestLevel: PROGRESSION.maxLevel,
    });
    const need = xpToNext(PROGRESSION.curve, PROGRESSION.maxLevel, 5);
    expect(sanitizePlayerProgress({ level: '5', xp: 1e12 }).xp).toBe(need - 1);
    expect(sanitizePlayerProgress({ level: 5, xp: -3 }).xp).toBe(0);
    // A prestige rank implies level 100 was reached.
    expect(sanitizePlayerProgress({ level: 4, prestige: 3 }).highestLevel).toBe(PROGRESSION.maxLevel);
    expect(sanitizePlayerProgress({ level: 4, prestige: 99 }).prestige).toBe(PROGRESSION.prestige.maxRank);
    expect(sanitizePlayerProgress({ level: Number.POSITIVE_INFINITY }).level).toBe(1);
  });

  it('drops unknown skill nodes, clamps ranks, validates the loadout', () => {
    expect(
      sanitizeSkills({
        ranks: JSON.parse('{"off_caliber":99,"nope":1,"sur_tough":-1,"tac_dash":"x","__proto__":5}'),
        respecs: -2,
        loadout: { grenade: 'nuke', ability: 'chronofeld' },
      }),
    ).toEqual({ ranks: { off_caliber: 3 }, respecs: 0, loadout: { grenade: null, ability: 'chronofeld' } });
  });

  it('weapon progress: unknown weapons, unknown or global camos in the weapon list, bad equips', () => {
    const w = sanitizeWeaponProgress(
      {
        rifle: {
          level: 77,
          xp: 50,
          counters: { kills: -5, headshots: 12.7, bogus: 3 },
          camos: ['camo.gold', 'camo.gold', 'camo.nebula', 'camo.nope', 7],
          equippedCamo: 'camo.nebula',
        },
        blaster9000: { level: 5 },
        pistol: 'x',
      },
      [],
    );
    expect(Object.keys(w)).toEqual(['rifle']);
    expect(w.rifle).toEqual({
      level: PROGRESSION.weapon.maxLevel,
      xp: 0,
      counters: { headshots: 12 },
      camos: ['camo.gold'],
      equippedCamo: null,
    });
    expect(
      sanitizeWeaponProgress({ rifle: { equippedCamo: 'camo.nebula' } }, ['camo.nebula']).rifle!.equippedCamo,
    ).toBe('camo.nebula');
  });

  it('achievements: unknown ids dropped, distinct values filtered, capped and deduplicated', () => {
    const many = Array.from({ length: 500 }, (_, i) => `v${i}`);
    const a = sanitizeAchievements({
      nope: { progress: 5 },
      first_blood: { progress: 'NaN', unlockedAt: 12.9 },
      kills_100: { progress: 1e99 },
      combos_all: { progress: 99, seen: ['thermoshock', 'thermoshock', 'bogus', ...many] },
      weapons_10: { progress: 3, seen: many },
      kills_1000: { progress: 0, unlockedAt: 0 },
    });
    expect(Object.keys(a).sort()).toEqual(['combos_all', 'first_blood', 'kills_100'].sort());
    expect(a.first_blood).toEqual({ progress: 0, unlockedAt: 12 });
    expect(a.kills_100!.progress).toBe(PROGRESSION_LIMITS.maxCounter);
    expect(a.combos_all).toEqual({ progress: 1, unlockedAt: 0, seen: ['thermoshock'] });
    expect(ACHIEVEMENTS.some((x) => x.id === 'weapons_10')).toBe(true);
  });

  it('challenges: bad keys reset the set, slots capped to the templates', () => {
    const c = sanitizeChallenges({
      daily: { key: 'evil', templates: ['kills'], slots: [{ progress: 5 }] },
      weekly: {
        key: 'riftfall-weekly-2026-09-21',
        templates: ['kills', 'waves', 'box', 'extra'],
        slots: Array.from({ length: 50 }, () => ({ progress: -1, claimed: 'true' })),
      },
      completedDaily: 1e20,
      completedWeekly: 'a',
    });
    expect(c.daily).toEqual({ key: '', templates: [], slots: [] });
    expect(c.weekly.templates).toEqual(['kills', 'waves', 'box']);
    expect(c.weekly.slots).toHaveLength(3);
    expect(c.weekly.slots[0]).toEqual({ progress: 0, claimed: true });
    expect(c.completedDaily).toBe(PROGRESSION_LIMITS.maxCounter);
    expect(c.completedWeekly).toBe(0);
  });

  it('cosmetics: unknown / default ids dropped from unlocks, equips must be owned and of the right kind', () => {
    const c = sanitizeCosmetics({
      currency: -50,
      unlocked: ['charm.tag', 'crosshair.dot', 'camo.gold', 'camo.aurora', 'x', 'charm.tag'],
      equipped: { crosshair: 'charm.tag', killEffect: 'killfx.rift', charm: 'charm.skull', emblem: null },
    });
    expect(c).toEqual({
      currency: 0,
      unlocked: ['charm.tag', 'camo.aurora'],
      equipped: { crosshair: 'crosshair.dot', killEffect: 'killfx.default', charm: null, emblem: null },
    });
    expect(sanitizeCosmetics({ currency: 1e99 }).currency).toBe(PROGRESSION_LIMITS.maxCurrency);
  });

  it('lifetime stats: unknown counters dropped, bad keys dropped, maps capped', () => {
    const kills: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) kills[`enemy${i}`] = i + 1;
    const s = sanitizeLifetimeStats({
      counters: { kills: 5, timePlayed: 3.5, bogus: 3, deaths: -1, runs: Number.POSITIVE_INFINITY },
      killsByEnemy: kills,
      killsByWeapon: { 'bad key!': 3, rifle: 2.9 },
      highestWave: { 'lab:classic': 12, lab: 5, 'x:y:z': 3 },
    });
    expect(s.counters).toEqual({ kills: 5, timePlayed: 3.5 });
    expect(Object.keys(s.killsByEnemy)).toHaveLength(PROGRESSION_LIMITS.maxMapKeys);
    expect(s.killsByWeapon).toEqual({ rifle: 2 });
    expect(s.highestWave).toEqual({ 'lab:classic': 12 });
    expect(s.bestScore).toEqual({});
  });

  it('leaderboards: invalid entries dropped, sorted, capped per board and in boards', () => {
    const list = Array.from({ length: 200 }, (_, i) => ({
      wave: i % 17,
      score: i,
      kills: 1,
      date: i,
      weapons: ['rifle', 5],
    }));
    const boards: Record<string, unknown> = { 'lab:classic': [...list, null, { wave: -1 }, { score: 5 }] };
    for (let i = 0; i < 100; i++) boards[`map${i}:classic`] = [{ wave: 1 }];
    boards['bad key'] = [{ wave: 3 }];
    const lb = sanitizeLeaderboards(boards);
    expect(Object.keys(lb)).toHaveLength(PROGRESSION_LIMITS.maxBoards);
    const lab = lb['lab:classic']!;
    expect(lab).toHaveLength(PROGRESSION_LIMITS.leaderboardSize);
    for (let i = 1; i < lab.length; i++) {
      expect(
        lab[i - 1]!.wave > lab[i]!.wave ||
          (lab[i - 1]!.wave === lab[i]!.wave && lab[i - 1]!.score >= lab[i]!.score),
      ).toBe(true);
    }
    expect(lab[0]!.weapons).toEqual(['rifle']);
    expect(lab[0]!.seed).toBeNull();
    expect(lb['bad key']).toBeUndefined();
  });

  it('a fully hostile profile never throws and yields a valid profile', () => {
    const hostile = {
      createdAt: 'yesterday',
      progression: { level: { valueOf: () => 5 } },
      skills: { ranks: new Array(10000).fill(3) },
      weaponProgress: { rifle: { counters: [1, 2, 3], camos: 'camo.gold' } },
      achievements: { first_blood: null },
      challenges: { daily: { key: 'riftfall-daily-2026-09-24', templates: [{}], slots: 'x' } },
      cosmetics: { unlocked: { a: 1 }, equipped: 'x' },
      lifetimeStats: { counters: 'many' },
      leaderboards: { 'lab:classic': 'best' },
    };
    const p = sanitizeProfile(hostile, 9);
    expect(p.progression.level).toBe(1);
    expect(p.skills.ranks).toEqual({});
    expect(p.weaponProgress.rifle).toMatchObject({ counters: {}, camos: [] });
    expect(p.challenges.daily.key).toBe('');
    expect(p.leaderboards).toEqual({});
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
