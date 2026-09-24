import { describe, expect, it } from 'vitest';
import type { AchievementProgressData } from '../core/contracts';
import type { GameEvents } from '../core/events';
import type { AchievementDef } from '../defs/achievements';
import { COMBOS } from '../defs/elements';
import { AchievementTracker } from './AchievementTracker';
import { createSignal, type ProgressSignal } from './signals';
import { beginLabRun, createHarness, fire, hit, killEnemy, runOver } from './testFakes';

const DEFS: readonly AchievementDef[] = [
  {
    id: 'a_count',
    name: 'Zähler',
    description: '3 Kills.',
    category: 'combat',
    tier: 'bronze',
    icon: 'skull',
    condition: { kind: 'count', metric: 'kill', target: 3 },
  },
  {
    id: 'a_run',
    name: 'Lauf',
    description: '2 Kopfschuss-Kills in einem Run.',
    category: 'combat',
    tier: 'silver',
    icon: 'skull',
    hidden: true,
    condition: { kind: 'count', metric: 'kill', target: 2, scope: 'run', filter: { zone: 'head' } },
  },
  {
    id: 'a_max',
    name: 'Welle',
    description: 'Welle 4.',
    category: 'waves',
    tier: 'gold',
    icon: 'wave',
    condition: { kind: 'max', metric: 'waveReached', target: 4 },
  },
  {
    id: 'a_distinct',
    name: 'Kombos',
    description: 'Jede Kombo.',
    category: 'elements',
    tier: 'gold',
    icon: 'flask',
    condition: { kind: 'distinct', metric: 'combo', tag: 'combo', target: 2, values: ['x', 'y'] },
  },
];

function sig(
  metric: ProgressSignal['metric'],
  amount = 1,
  set?: (s: ProgressSignal) => void,
): ProgressSignal {
  const s = createSignal();
  s.metric = metric;
  s.amount = amount;
  set?.(s);
  return s;
}

function tracker(store: Record<string, AchievementProgressData> = {}) {
  const unlocked: string[] = [];
  const t = new AchievementTracker(store, { onUnlock: (d) => unlocked.push(d.id) }, () => 42, DEFS);
  return { t, store, unlocked };
}

describe('AchievementTracker', () => {
  it('counts lifetime progress, persists it and unlocks once', () => {
    const { t, store, unlocked } = tracker();
    t.signal(sig('kill'));
    t.signal(sig('kill'));
    expect(store.a_count).toEqual({ progress: 2, unlockedAt: 0 });
    t.signal(sig('kill'));
    expect(unlocked).toEqual(['a_count']);
    expect(store.a_count!.unlockedAt).toBe(42);
    t.signal(sig('kill'));
    expect(unlocked).toEqual(['a_count']);
    expect(t.unlockedCount).toBe(1);
  });

  it('run-scoped counts need the target within ONE run (best run is kept)', () => {
    const { t, store, unlocked } = tracker();
    const head = (): ProgressSignal => sig('kill', 1, (s) => (s.tags.zone = 'head'));
    t.beginRun();
    t.signal(head());
    t.signal(sig('kill'));
    t.beginRun();
    t.signal(head());
    expect(unlocked).not.toContain('a_run');
    expect(store.a_run!.progress).toBe(1);
    t.signal(head());
    expect(unlocked).toContain('a_run');
    expect(t.view('a_run')).toMatchObject({ hidden: true, progress: 2, target: 2 });
  });

  it('max conditions keep the highest value; distinct conditions collect values', () => {
    const { t, store, unlocked } = tracker();
    t.signal(sig('waveReached', 3));
    t.signal(sig('waveReached', 2));
    expect(store.a_max!.progress).toBe(3);
    t.signal(sig('waveReached', 4));
    expect(unlocked).toContain('a_max');
    const combo = (c: string): ProgressSignal => sig('combo', 1, (s) => (s.tags.combo = c));
    t.signal(combo('x'));
    t.signal(combo('x'));
    t.signal(combo('z')); // not a listed value
    expect(store.a_distinct).toEqual({ progress: 1, unlockedAt: 0, seen: ['x'] });
    t.signal(combo('y'));
    expect(unlocked).toContain('a_distinct');
  });

  it('restores progress from the store and reconciles met targets', () => {
    const store: Record<string, AchievementProgressData> = {
      a_count: { progress: 5, unlockedAt: 0 },
      a_distinct: { progress: 1, unlockedAt: 0, seen: ['y'] },
      a_max: { progress: 4, unlockedAt: 7 },
    };
    const { t, unlocked } = tracker(store);
    expect(t.unlockedCount).toBe(1);
    t.reconcile();
    expect(unlocked).toEqual(['a_count']);
    t.signal(sig('combo', 1, (s) => (s.tags.combo = 'x')));
    expect(unlocked).toContain('a_distinct');
    expect(store.a_distinct!.seen).toEqual(['y', 'x']);
  });

  it('dev unlock sets the progress to the target', () => {
    const { t, store } = tracker();
    expect(t.unlock('a_max')).toBe(true);
    expect(t.unlock('a_max')).toBe(false);
    expect(t.unlock('nope')).toBe(false);
    expect(store.a_max!.progress).toBe(4);
  });
});

describe('achievements from gameplay event sequences', () => {
  function unlockedIds(events: ReturnType<typeof createHarness>['events']): string[] {
    const ids: string[] = [];
    events.on('achievement:unlocked', (e) => ids.push(e.id));
    return ids;
  }

  it('first kill, headshot streaks and the hidden tank-melee kill', () => {
    const h = createHarness();
    const ids = unlockedIds(h.events);
    beginLabRun(h.system);
    killEnemy(h.events, { zone: 'head' });
    expect(ids).toEqual(['first_blood']);
    for (let i = 0; i < 9; i++) killEnemy(h.events, { zone: 'head' });
    expect(ids).toContain('headshot_streak_10');
    killEnemy(h.events, { type: 'tank', weaponId: 'rifle', kind: 'melee' });
    expect(ids).toContain('melee_tank');
    const e = h.system.achievements().find((a) => a.id === 'melee_tank')!;
    expect(e.hidden).toBe(true);
    expect(e.unlockedAt).toBeGreaterThan(0);
  });

  it('a body kill breaks the headshot streak', () => {
    const h = createHarness();
    beginLabRun(h.system);
    for (let i = 0; i < 9; i++) killEnemy(h.events, { zone: 'head' });
    killEnemy(h.events, { zone: 'body' });
    for (let i = 0; i < 5; i++) killEnemy(h.events, { zone: 'head' });
    expect(h.system.achievementTracker.isUnlocked('headshot_streak_10')).toBe(false);
    expect(h.profile.achievements.headshot_streak_10!.progress).toBe(9);
  });

  it('no-damage waves count from the minimum wave on; damage in the wave spoils it', () => {
    const h = createHarness();
    beginLabRun(h.system);
    const wave = (n: number, damaged: boolean): void => {
      h.events.emit('wave:start', { wave: n, total: 10 });
      if (damaged) h.events.emit('player:damaged', { amount: 5, healthFraction: 0.9 });
      h.events.emit('wave:complete', { wave: n, duration: 30 });
    };
    wave(1, false);
    wave(2, false);
    expect(h.system.achievementTracker.isUnlocked('no_damage_wave')).toBe(false);
    wave(3, true);
    expect(h.system.achievementTracker.isUnlocked('no_damage_wave')).toBe(false);
    wave(4, false);
    expect(h.system.achievementTracker.isUnlocked('no_damage_wave')).toBe(true);
    expect(h.system.achievementTracker.isUnlocked('wave_5')).toBe(false);
    h.events.emit('wave:start', { wave: 5, total: 10 });
    expect(h.system.achievementTracker.isUnlocked('wave_5')).toBe(true);
  });

  it('every elemental combo, the forge tier 3 and a box wonder weapon', () => {
    const h = createHarness();
    beginLabRun(h.system);
    const p = { x: 0, y: 0, z: 0 };
    for (const c of COMBOS) h.events.emit('combat:combo', { targetId: 1, combo: c.id, position: p });
    h.events.emit('combat:combo', { targetId: 1, combo: COMBOS[0]!.id, position: p });
    expect(h.system.achievementTracker.isUnlocked('combo_first')).toBe(true);
    expect(h.system.achievementTracker.isUnlocked('combos_all')).toBe(true);
    h.events.emit('forge:upgraded', { weaponId: 'rifle', tier: 2, name: 'x' });
    expect(h.system.achievementTracker.isUnlocked('forge_tier3')).toBe(false);
    h.events.emit('forge:upgraded', { weaponId: 'rifle', tier: 3, name: 'x' });
    expect(h.system.achievementTracker.isUnlocked('forge_tier3')).toBe(true);
    h.events.emit('box:resolved', { boxId: 'b', weaponId: 'rifle' });
    expect(h.system.achievementTracker.isUnlocked('box_wonder')).toBe(false);
    h.events.emit('box:resolved', { boxId: 'b', weaponId: 'riftripper' });
    expect(h.system.achievementTracker.isUnlocked('box_wonder')).toBe(true);
  });

  it('every door and every perk slot in one run', () => {
    let owned = 0;
    const h = createHarness({ doorCount: () => 2, perkSlots: () => ({ owned, max: 2 }) });
    beginLabRun(h.system);
    h.events.emit('door:opened', { doorId: 'd1', zones: [] });
    expect(h.system.achievementTracker.isUnlocked('door_first')).toBe(true);
    expect(h.system.achievementTracker.isUnlocked('doors_all')).toBe(false);
    h.events.emit('door:opened', { doorId: 'd2', zones: [] });
    expect(h.system.achievementTracker.isUnlocked('doors_all')).toBe(true);
    owned = 1;
    h.events.emit('perk:acquired', { perkId: 'titan', slot: 0 });
    expect(h.system.achievementTracker.isUnlocked('perks_full')).toBe(false);
    owned = 2;
    h.events.emit('perk:acquired', { perkId: 'quickload', slot: 1 });
    expect(h.system.achievementTracker.isUnlocked('perks_full')).toBe(true);
  });

  it('the pacifist wave (no shot fired) and the early death are hidden run achievements', () => {
    const h = createHarness();
    beginLabRun(h.system);
    for (let w = 1; w <= 3; w++) {
      h.events.emit('wave:start', { wave: w, total: 5 });
      h.events.emit('wave:complete', { wave: w, duration: 20 });
    }
    expect(h.system.achievementTracker.isUnlocked('pacifist')).toBe(true);
    beginLabRun(h.system);
    fire(h.events);
    hit(h.events);
    h.events.emit('wave:start', { wave: 1, total: 5 });
    const over: Partial<GameEvents['run:over']> = { wave: 1, timeSurvived: 20 };
    runOver(h.events, over);
    expect(h.system.achievementTracker.isUnlocked('early_death')).toBe(true);
  });

  it('nothing counts outside a ranked run or for console spawns', () => {
    const h = createHarness();
    killEnemy(h.events);
    beginLabRun(h.system, false);
    killEnemy(h.events);
    expect(h.system.achievementTracker.isUnlocked('first_blood')).toBe(false);
    beginLabRun(h.system);
    h.system.flagNoReward(4242);
    killEnemy(h.events, { id: 4242 });
    expect(h.system.achievementTracker.isUnlocked('first_blood')).toBe(false);
    expect(h.profile.progression.lifetimeXp).toBe(0);
  });
});
