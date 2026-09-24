import { describe, expect, it } from 'vitest';
import type { LeaderboardEntry } from '../core/contracts';
import { PROGRESSION_LIMITS, TIME_PLAYED_COUNTER } from '../defs/progression';
import { createDefaultLifetimeStats } from '../save/defaults';
import { Leaderboards, compareEntries } from './Leaderboards';
import { LifetimeStats, accuracy, favourite } from './LifetimeStats';
import { createSignal, type ProgressSignal } from './signals';
import { beginLabRun, createHarness, fire, hit, killEnemy, runOver } from './testFakes';

function kill(weapon: string, enemy = 'swarmer', zone: 'head' | 'body' = 'body'): ProgressSignal {
  const s = createSignal();
  s.metric = 'kill';
  s.amount = 1;
  s.tags.weapon = weapon;
  s.tags.enemy = enemy;
  s.tags.zone = zone;
  return s;
}

const commit = { mapId: 'lab', mode: 'classic', wave: 7, score: 900, timeSurvived: 120, died: true };

describe('LifetimeStats', () => {
  it('aggregates a run and commits it into the totals', () => {
    const data = createDefaultLifetimeStats();
    const st = new LifetimeStats(data);
    st.signal(kill('rifle')); // not recording yet
    st.beginRun();
    st.signal(kill('rifle', 'swarmer', 'head'));
    st.signal(kill('rifle', 'spitter'));
    st.signal(kill('shotgun', 'tank'));
    expect(st.runValue('kills')).toBe(3);
    expect(data.counters.kills).toBeUndefined();
    st.commit(commit);
    expect(data.counters).toMatchObject({ kills: 3, headshots: 1, [TIME_PLAYED_COUNTER]: 120 });
    expect(data.killsByEnemy).toEqual({ swarmer: 1, spitter: 1, tank: 1 });
    expect(data.killsByWeapon).toEqual({ rifle: 2, shotgun: 1 });
    expect(st.favouriteWeapon).toBe('rifle');
    expect(st.highestWave('lab')).toBe(7);
    expect(st.highestWave('lab', 'classic')).toBe(7);
    expect(st.bestScore('lab')).toBe(900);
    // A second commit without a new run changes nothing.
    st.commit(commit);
    expect(data.counters.kills).toBe(3);
    st.beginRun();
    st.commit({ ...commit, wave: 3, score: 100 });
    expect(st.highestWave('lab')).toBe(7);
    expect(st.highestWave('testroom')).toBe(0);
  });

  it('accuracy and favourite weapon helpers', () => {
    expect(accuracy(0, 0)).toBe(0);
    expect(accuracy(10, 4)).toBeCloseTo(0.4);
    expect(accuracy(10, 40)).toBe(1);
    expect(favourite({})).toBeNull();
    expect(favourite({ a: 2, b: 5, c: 5 })).toBe('b');
  });

  it('counts shots, hits (one per shot, like RunStats) and kills from gameplay events', () => {
    const h = createHarness({ loadout: () => ({ weapons: ['rifle', 'pistol'], perks: ['titan'] }) });
    beginLabRun(h.system);
    fire(h.events, 'rifle');
    hit(h.events, 'rifle');
    hit(h.events, 'rifle'); // same shot (pellets / penetration)
    fire(h.events, 'rifle'); // miss
    fire(h.events, 'pistol');
    hit(h.events, 'rifle'); // other weapon's damage never marks the pistol shot
    killEnemy(h.events, { weaponId: 'pistol', zone: 'head' });
    killEnemy(h.events, { weaponId: 'pistol' });
    killEnemy(h.events, { weaponId: 'rifle', type: 'tank' });
    runOver(h.events, { wave: 4, kills: 3, score: 500, timeSurvived: 95 });
    const s = h.system.stats;
    expect(s.counters).toMatchObject({ runs: 1, deaths: 1, kills: 3, headshots: 1, shotsFired: 3 });
    // The pistol shot was marked by its own kill's combat:damage.
    expect(s.counters.shotsHit).toBe(2);
    expect(s.accuracy).toBeCloseTo(2 / 3);
    expect(s.favouriteWeapon).toBe('pistol');
    expect(s.killsByEnemy).toEqual({ swarmer: 2, tank: 1 });
    expect(s.highestWave('lab')).toBe(4);
    const board = h.system.leaderboard('lab');
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      wave: 4,
      kills: 3,
      score: 500,
      time: 95,
      weapons: ['rifle', 'pistol'],
      perks: ['titan'],
    });
    expect(board[0]!.seed).toBeNull();
  });
});

function entry(wave: number, score: number, kills = 0, date = 0): LeaderboardEntry {
  return {
    wave,
    score,
    kills,
    points: 0,
    time: 0,
    date,
    weapons: [],
    perks: [],
    level: 1,
    prestige: 0,
    seed: null,
  };
}

describe('Leaderboards', () => {
  it('orders by wave, then score, then kills; ties keep the older run first', () => {
    const boards: Record<string, LeaderboardEntry[]> = {};
    const lb = new Leaderboards(boards, 5, 3);
    expect(lb.submit('lab', 'classic', entry(5, 100, 0, 1))).toBe(1);
    expect(lb.submit('lab', 'classic', entry(7, 50, 0, 2))).toBe(1);
    expect(lb.submit('lab', 'classic', entry(5, 300, 0, 3))).toBe(2);
    expect(lb.submit('lab', 'classic', entry(5, 100, 5, 4))).toBe(3);
    expect(lb.submit('lab', 'classic', entry(5, 100, 0, 5))).toBe(5); // exact tie: after the older one
    expect(lb.get('lab').map((e) => e.date)).toEqual([2, 3, 4, 1, 5]);
    expect(compareEntries(entry(5, 100), entry(5, 100))).toBe(0);
  });

  it('caps entries per board and the number of boards', () => {
    const boards: Record<string, LeaderboardEntry[]> = {};
    const lb = new Leaderboards(boards, 3, 2);
    for (let i = 1; i <= 5; i++) lb.submit('lab', 'classic', entry(i, 0));
    expect(lb.get('lab').map((e) => e.wave)).toEqual([5, 4, 3]);
    expect(lb.submit('lab', 'classic', entry(1, 0))).toBe(0);
    expect(lb.submit('testroom', 'classic', entry(1, 0))).toBe(1);
    expect(lb.submit('lab', 'daily', entry(1, 0))).toBe(0); // third board refused
    expect(lb.keys()).toEqual(['lab:classic', 'testroom:classic']);
    expect(PROGRESSION_LIMITS.leaderboardSize).toBeGreaterThanOrEqual(5);
  });
});
