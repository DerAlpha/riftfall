import { describe, expect, it } from 'vitest';
import type { ChallengeData } from '../core/contracts';
import { CHALLENGE_RULES, CHALLENGE_TEMPLATES } from '../defs/challenges';
import { createDefaultChallenges } from '../save/defaults';
import { ChallengeTracker } from './ChallengeTracker';
import {
  generateChallengeSet,
  periodEnd,
  periodKey,
  weekStart,
  type ChallengeInstance,
} from './challengeSeed';
import { createSignal, type ProgressSignal } from './signals';
import { createHarness } from './testFakes';

const THU = Date.UTC(2026, 8, 24, 12); // Thursday
const DAY = 86_400_000;

function setup(start = THU, data: ChallengeData = createDefaultChallenges(), autoClaim = true) {
  const clock = { t: start };
  const log = { completed: [] as string[], claimed: [] as string[], rotated: [] as string[] };
  const tracker = new ChallengeTracker(
    data,
    {
      onComplete: (c) => log.completed.push(c.id),
      onClaim: (c) => log.claimed.push(c.id),
      onRotate: (p, k) => log.rotated.push(`${p}:${k}`),
    },
    () => clock.t,
    ['charm.crystal', 'charm.eye'],
    autoClaim,
  );
  return { tracker, data, clock, log };
}

/** A signal that satisfies (part of) an instance's condition. */
function signalFor(c: ChallengeInstance, amount: number): ProgressSignal {
  const s = createSignal();
  s.metric = c.condition.metric;
  s.amount = amount;
  const f = c.condition.filter ?? {};
  Object.assign(s.tags, f);
  if (f.minWave !== undefined) s.tags.wave = f.minWave;
  return s;
}

describe('challenge seeding', () => {
  it('is deterministic per date and differs between dates', () => {
    const key = periodKey('daily', new Date(THU));
    expect(key).toBe('riftfall-daily-2026-09-24');
    const a = generateChallengeSet('daily', key);
    const b = generateChallengeSet('daily', key);
    expect(a.map((c) => [c.template.id, c.variant?.id, c.target, c.xp])).toEqual(
      b.map((c) => [c.template.id, c.variant?.id, c.target, c.xp]),
    );
    expect(a).toHaveLength(CHALLENGE_RULES.daily.count);
    expect(new Set(a.map((c) => c.template.id)).size).toBe(a.length);
    const sets = new Set<string>();
    for (let d = 0; d < 14; d++) {
      const k = periodKey('daily', new Date(THU + d * DAY));
      sets.add(JSON.stringify(generateChallengeSet('daily', k).map((c) => [c.template.id, c.target])));
    }
    expect(sets.size).toBeGreaterThan(10);
  });

  it('keys rotate at UTC midnight (daily) and Monday 00:00 UTC (weekly)', () => {
    const sunLate = Date.UTC(2026, 8, 27, 23, 59, 59);
    const monday = Date.UTC(2026, 8, 28, 0, 0, 0);
    expect(periodKey('daily', new Date(sunLate))).toBe('riftfall-daily-2026-09-27');
    expect(periodKey('daily', new Date(monday))).toBe('riftfall-daily-2026-09-28');
    expect(periodKey('weekly', new Date(THU))).toBe('riftfall-weekly-2026-09-21');
    expect(periodKey('weekly', new Date(sunLate))).toBe('riftfall-weekly-2026-09-21');
    expect(periodKey('weekly', new Date(monday))).toBe('riftfall-weekly-2026-09-28');
    expect(weekStart(new Date(monday)).getTime()).toBe(monday);
    expect(periodEnd('daily', new Date(THU))).toBe(Date.UTC(2026, 8, 25));
    expect(periodEnd('weekly', new Date(THU))).toBe(monday);
  });

  it('targets stay inside the template range (scaled by the variant) with German text', () => {
    for (let d = 0; d < 60; d++) {
      for (const period of ['daily', 'weekly'] as const) {
        const set = generateChallengeSet(period, periodKey(period, new Date(THU + d * DAY)), ['charm.eye']);
        set.forEach((c, i) => {
          const r = c.template.targets[period]!;
          const scale = c.variant?.scale ?? 1;
          expect(c.target).toBeGreaterThanOrEqual(Math.max(1, Math.floor(r.min * scale * 0.5)));
          expect(c.target).toBeLessThanOrEqual(Math.ceil(r.max * scale) + r.step);
          expect(c.description).not.toMatch(/\{[nv]\}/);
          expect(c.xp).toBeGreaterThan(0);
          expect(c.cosmetic !== null).toBe(i < CHALLENGE_RULES[period].cosmeticSlots);
          if (c.variant) expect(c.condition.filter?.[c.template.variants!.tag]).toBe(c.variant.id);
        });
      }
    }
    expect(CHALLENGE_TEMPLATES.length).toBeGreaterThanOrEqual(15);
  });
});

describe('ChallengeTracker', () => {
  it('generates the current sets on first refresh and persists keys + slots', () => {
    const { tracker, data, log } = setup();
    expect(data.daily.key).toBe('');
    expect(tracker.refresh()).toBe(true);
    expect(data.daily.key).toBe('riftfall-daily-2026-09-24');
    expect(data.weekly.key).toBe('riftfall-weekly-2026-09-21');
    expect(data.daily.slots).toHaveLength(CHALLENGE_RULES.daily.count);
    expect(log.rotated).toHaveLength(2);
    expect(tracker.refresh()).toBe(false);
  });

  it('tracks progress, completes and auto-claims once', () => {
    const { tracker, data, log } = setup();
    tracker.refresh();
    const c = tracker.instances()[0]!;
    tracker.signal(signalFor(c, c.target - 1));
    expect(data.daily.slots[0]!.progress).toBe(c.target - 1);
    expect(log.completed).toEqual([]);
    tracker.signal(signalFor(c, 5));
    expect(log.completed).toEqual([c.id]);
    expect(log.claimed).toEqual([c.id]);
    expect(data.daily.slots[0]!.claimed).toBe(true);
    expect(data.completedDaily).toBe(1);
    tracker.signal(signalFor(c, 5));
    expect(log.completed).toEqual([c.id]);
    const view = tracker.views().find((v) => v.id === c.id)!;
    expect(view).toMatchObject({ completed: true, claimed: true, progress: c.target });
  });

  it('rotation at the day boundary grants unclaimed rewards and starts fresh', () => {
    const { tracker, data, clock, log } = setup(THU, createDefaultChallenges(), false);
    tracker.refresh();
    const c = tracker.instances()[0]!;
    tracker.signal(signalFor(c, c.target));
    expect(log.completed).toEqual([c.id]);
    expect(log.claimed).toEqual([]);
    clock.t = THU + DAY;
    tracker.refresh();
    expect(log.claimed).toEqual([c.id]);
    expect(data.daily.key).toBe('riftfall-daily-2026-09-25');
    expect(data.daily.slots.every((s) => s.progress === 0 && !s.claimed)).toBe(true);
    // The week did not change: its progress stays.
    expect(log.rotated.filter((r) => r.startsWith('weekly'))).toHaveLength(1);
  });

  it('manual claiming works when auto-claim is off', () => {
    const { tracker, log } = setup(THU, createDefaultChallenges(), false);
    tracker.refresh();
    const c = tracker.instances()[1]!;
    expect(tracker.claim(c.id)).toBe(false);
    tracker.signal(signalFor(c, c.target));
    expect(tracker.claim(c.id)).toBe(true);
    expect(tracker.claim(c.id)).toBe(false);
    expect(log.claimed).toEqual([c.id]);
  });

  it('keeps a stored set of today, drops one whose templates do not match', () => {
    const first = setup();
    first.tracker.refresh();
    const c = first.tracker.instances()[0]!;
    first.tracker.signal(signalFor(c, 1));
    const stored = JSON.parse(JSON.stringify(first.data)) as ChallengeData;
    const again = setup(THU, JSON.parse(JSON.stringify(stored)) as ChallengeData);
    expect(again.tracker.refresh()).toBe(false);
    expect(again.data.daily.slots[0]!.progress).toBe(Math.min(1, c.target));
    const tampered = JSON.parse(JSON.stringify(stored)) as ChallengeData;
    tampered.daily.templates = ['kills', 'kills', 'kills'];
    tampered.daily.slots[0]!.progress = 1e9;
    const third = setup(THU, tampered);
    third.tracker.refresh();
    expect(third.data.daily.slots.every((s) => s.progress === 0)).toBe(true);
  });

  it('progress is clamped to the target on load (a tampered slot cannot overflow)', () => {
    const first = setup();
    first.tracker.refresh();
    const stored = JSON.parse(JSON.stringify(first.data)) as ChallengeData;
    stored.weekly.slots[0]!.progress = 1e12;
    const second = setup(THU, stored);
    const w = second.tracker.views().find((v) => v.period === 'weekly')!;
    expect(w.progress).toBe(w.target);
  });

  it('is wired into progression: rewards XP and currency, weekly cosmetic', () => {
    const h = createHarness();
    h.system.beginRun({ mapId: 'lab', mode: 'classic', seed: null, ranked: true });
    const weekly = h.system.challengeTracker.instances().find((c) => c.period === 'weekly' && c.cosmetic)!;
    const completions: string[] = [];
    h.events.on('challenge:completed', (e) => completions.push(e.id));
    h.system.challengeTracker.complete(weekly.id);
    expect(completions).toEqual([weekly.id]);
    expect(h.profile.cosmetics.currency).toBeGreaterThanOrEqual(weekly.currency);
    expect(h.profile.cosmetics.unlocked).toContain(weekly.cosmetic);
    expect(h.profile.progression.lifetimeXp).toBeGreaterThanOrEqual(weekly.xp);
    expect(h.profile.challenges.completedWeekly).toBe(1);
  });
});
