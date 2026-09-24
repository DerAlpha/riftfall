import { describe, expect, it } from 'vitest';
import type { GameEvents } from '../core/events';
import { ACHIEVEMENT_REWARDS, PROGRESSION } from '../defs/progression';
import { STAT_DEFS } from '../defs/stats';
import { createDefaultProfile } from '../save/defaults';
import { StatSystem } from '../stats/StatSystem';
import { killXp, waveXp } from './ProgressionSystem';
import { createTags } from './signals';
import { TEST_NOW, beginLabRun, createHarness, killEnemy, runOver } from './testFakes';
import { xpForLevel, xpToNext } from './xpCurve';

const MAX = PROGRESSION.maxLevel;

describe('XP sources', () => {
  it('kill XP depends on the enemy type, the zone, melee and elites', () => {
    const t = createTags();
    t.enemy = 'swarmer';
    expect(killXp(t)).toBe(PROGRESSION.killXp.swarmer);
    t.enemy = 'unknown-m6-boss';
    expect(killXp(t)).toBe(PROGRESSION.killDefault);
    t.enemy = 'tank';
    t.zone = 'head';
    t.elite = true;
    expect(killXp(t)).toBe(
      (PROGRESSION.killXp.tank! + PROGRESSION.headshotBonus) * PROGRESSION.eliteMultiplier,
    );
    expect(waveXp(1)).toBe(PROGRESSION.wave.base + PROGRESSION.wave.perWave);
    expect(waveXp(10_000)).toBe(PROGRESSION.wave.max);
  });

  it('pays kills and waves live during a ranked run and emits progression:xp', () => {
    const h = createHarness();
    const xp: GameEvents['progression:xp'][] = [];
    h.events.on('progression:xp', (e) => xp.push({ ...e }));
    beginLabRun(h.system);
    killEnemy(h.events, { type: 'spitter', zone: 'head' });
    h.events.emit('wave:start', { wave: 1, total: 5 });
    h.events.emit('wave:complete', { wave: 1, duration: 20 });
    const kill = PROGRESSION.killXp.spitter! + PROGRESSION.headshotBonus;
    expect(xp.map((e) => [e.source, e.amount])).toEqual(
      expect.arrayContaining([
        ['kill', kill],
        ['wave', waveXp(1)],
      ]),
    );
    // first_blood (bronze) also paid its reward.
    expect(h.profile.progression.lifetimeXp).toBe(kill + waveXp(1) + ACHIEVEMENT_REWARDS.bronze.xp);
  });

  it('pays survival XP at the run end and reports the run', () => {
    const h = createHarness();
    beginLabRun(h.system);
    killEnemy(h.events);
    runOver(h.events, { timeSurvived: 250, wave: 3 });
    const report = h.system.lastRun!;
    expect(report.xp).toBe(h.profile.progression.lifetimeXp);
    expect(report.achievements).toContain('first_blood');
    expect(report.rank).toBe(1);
    // 4 full minutes of survival XP are part of it.
    expect(report.xp).toBeGreaterThanOrEqual(4 * PROGRESSION.survivalPerMinute);
    expect(h.saves.count).toBe(1);
  });
});

describe('levels and prestige', () => {
  it('levels up across several levels with one levelUp event and unlocks level cosmetics', () => {
    const h = createHarness();
    const ups: GameEvents['progression:levelUp'][] = [];
    h.events.on('progression:levelUp', (e) => ups.push({ ...e }));
    h.system.addXp(xpForLevel(PROGRESSION.curve, MAX, 6), 'dev');
    expect(h.system.level).toBe(6);
    expect(ups).toEqual([{ level: 6, previous: 1, prestige: 0, skillPoints: 5 }]);
    h.system.setLevel(25);
    expect(h.profile.progression.highestLevel).toBe(25);
    expect(h.profile.cosmetics.unlocked).toEqual(
      expect.arrayContaining(['charm.tag', 'charm.die', 'emblem.level25']),
    );
    expect(h.system.achievementTracker.isUnlocked('level_10')).toBe(true);
    expect(h.system.achievementTracker.isUnlocked('level_25')).toBe(true);
  });

  it('prestige: only at the max level, resets the level, keeps unlocks and skill points, adds the XP bonus', () => {
    const h = createHarness();
    expect(h.system.canPrestige()).toBe(false);
    expect(h.system.prestige()).toBe(false);
    h.system.setLevel(MAX);
    expect(h.system.xpToNext).toBe(0);
    h.system.addXp(5000, 'dev');
    expect(h.profile.progression.xp).toBe(0);
    h.system.skills.unlock('tac_dash');
    const pointsBefore = h.system.skills.earned;
    const unlockedBefore = [...h.profile.cosmetics.unlocked];
    const events: number[] = [];
    h.events.on('progression:prestige', (e) => events.push(e.prestige));
    expect(h.system.prestige()).toBe(true);
    expect(events).toEqual([1]);
    // Back to level 1 – the prestige achievement's XP already counts towards the new pass.
    expect(h.profile.progression).toMatchObject({ prestige: 1, highestLevel: MAX });
    expect(h.profile.progression.level).toBeLessThan(10);
    expect(h.system.xpMultiplier).toBeCloseTo(1 + PROGRESSION.prestige.xpBonusPerRank);
    expect(h.system.skills.earned).toBe(pointsBefore + PROGRESSION.skillPoints.perPrestige);
    expect(h.system.skills.rank('tac_dash')).toBe(1);
    expect(h.profile.cosmetics.unlocked).toEqual(
      expect.arrayContaining([...unlockedBefore, 'emblem.prestige1', 'killfx.rift']),
    );
    expect(h.profile.cosmetics.currency).toBeGreaterThanOrEqual(PROGRESSION.prestige.currency);
    expect(h.system.achievementTracker.isUnlocked('prestige_1')).toBe(true);
    // XP is now scaled by the prestige bonus.
    const gained = h.system.addXp(1000, 'dev');
    expect(gained).toBe(Math.round(1000 * (1 + PROGRESSION.prestige.xpBonusPerRank)));
    // Up to the max rank, never beyond.
    for (let r = 2; r <= PROGRESSION.prestige.maxRank; r++) {
      h.system.setLevel(MAX);
      expect(h.system.prestige()).toBe(true);
    }
    h.system.setLevel(MAX);
    expect(h.system.prestige()).toBe(false);
    expect(h.system.prestigeRank).toBe(PROGRESSION.prestige.maxRank);
    expect(h.profile.cosmetics.unlocked).toContain('emblem.prestige10');
  });
});

describe('skills through the system', () => {
  it('applies modifiers to the live stat table on purchase and at run start', () => {
    const h = createHarness();
    const stats = new StatSystem();
    h.system.setLiveStats(stats);
    h.system.setLevel(10);
    const changes: (string | null)[] = [];
    h.events.on('progression:skills', (e) => changes.push(e.nodeId));
    expect(h.system.skills.unlock('sur_tough')).toBe(true);
    expect(changes).toEqual(['sur_tough']);
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base + 5);
    stats.reset();
    h.system.applyRunStart();
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base + 5);
    expect(h.system.achievementTracker.isUnlocked('skill_first')).toBe(true);
  });

  it('pays back a share of box purchases (cashback skill)', () => {
    const h = createHarness();
    h.system.setLevel(MAX);
    const path = [
      'tac_capital',
      'tac_capital',
      'tac_capital',
      'tac_dash',
      'tac_light',
      'tac_light',
      'tac_grenadier',
      'tac_haggler',
    ];
    for (const id of path) {
      expect(h.system.skills.unlock(id)).toBe(true);
    }
    h.events.emit('economy:purchase', { item: 'box', kind: 'box', cost: 950, ok: true });
    h.events.emit('economy:purchase', { item: 'box', kind: 'box', cost: 950, ok: false });
    h.events.emit('economy:purchase', { item: 'door', kind: 'door', cost: 950, ok: true });
    expect(h.refunds).toEqual([95]);
  });
});

describe('persistence', () => {
  it('never saves per kill; level ups and unlocks schedule one coalesced save', () => {
    const h = createHarness();
    beginLabRun(h.system);
    killEnemy(h.events); // first_blood + level-free XP
    expect(h.saves.count).toBe(0);
    expect(h.scheduler.pending.size).toBe(1);
    for (let i = 0; i < 50; i++) killEnemy(h.events);
    expect(h.saves.count).toBe(0);
    expect(h.scheduler.pending.size).toBe(1);
    h.scheduler.run();
    expect(h.saves.count).toBe(1);
    // Plain progress (no unlock) only marks dirty; flush() writes it, a clean flush does nothing.
    killEnemy(h.events);
    expect(h.scheduler.pending.size).toBe(0);
    expect(h.system.dirty).toBe(true);
    h.system.flush();
    expect(h.saves.count).toBe(2);
    h.system.flush();
    expect(h.saves.count).toBe(2);
  });

  it('attach() re-binds to a replaced profile (resetsave)', () => {
    const h = createHarness();
    h.system.setLevel(30);
    h.system.skills.unlock('off_caliber');
    const fresh = createDefaultProfile(TEST_NOW);
    h.system.attach(fresh);
    expect(h.system.level).toBe(1);
    expect(h.system.skills.rank('off_caliber')).toBe(0);
    h.system.addXp(100, 'dev');
    expect(fresh.progression.xp).toBe(100);
  });

  it('a run replaced before it ended still counts its stats but no death', () => {
    const h = createHarness();
    beginLabRun(h.system);
    killEnemy(h.events);
    beginLabRun(h.system);
    expect(h.profile.lifetimeStats.counters).toMatchObject({ kills: 1 });
    expect(h.profile.lifetimeStats.counters.deaths).toBeUndefined();
    killEnemy(h.events);
    runOver(h.events);
    expect(h.profile.lifetimeStats.counters).toMatchObject({ kills: 2, deaths: 1, runs: 1 });
  });

  it('the level XP never exceeds what the level needs after loading', () => {
    const h = createHarness();
    h.system.addXp(xpToNext(PROGRESSION.curve, MAX, 1) - 1, 'dev');
    expect(h.system.level).toBe(1);
    expect(h.system.xp).toBe(xpToNext(PROGRESSION.curve, MAX, 1) - 1);
  });
});
