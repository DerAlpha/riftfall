import { describe, expect, it } from 'vitest';
import { Rng } from '../core/Rng';
import { POWERUP_DEFS, POWERUP_IDS, POWERUPS, type PowerUpDef } from '../defs/powerups';
import {
  createDropState,
  noteDrop,
  pickDropType,
  pityReached,
  resetDropState,
  rollKill,
  startDropWave,
  type DropRuleDef,
} from './dropRules';

const DEFS: readonly PowerUpDef[] = POWERUP_IDS.map((id) => POWERUP_DEFS[id]!);
const OPEN: DropRuleDef = {
  chance: 0.25,
  maxPerWave: 1e9,
  pity: { kills: 1e9, seconds: 1e9 },
  minSpacing: 0,
  noRepeat: true,
};

describe('drop chance', () => {
  it('rolls chance × the dropChance stat per kill', () => {
    const rate = (mul: number): number => {
      const s = createDropState();
      const rng = new Rng('chance');
      let hits = 0;
      for (let i = 0; i < 20000; i++) if (rollKill(s, OPEN, rng, mul, i)) hits++;
      return hits / 20000;
    };
    expect(rate(1)).toBeCloseTo(0.25, 1);
    expect(rate(2)).toBeCloseTo(0.5, 1);
    expect(rate(0)).toBe(0);
    // Garbage multipliers count as ×1.
    expect(rate(Number.NaN)).toBeCloseTo(0.25, 1);
  });

  it('respects the per-wave cap (a new wave reopens it) and the spacing', () => {
    const rule: DropRuleDef = { ...OPEN, chance: 1, maxPerWave: 2, minSpacing: 5 };
    const s = createDropState();
    const rng = new Rng('cap');
    expect(rollKill(s, rule, rng, 1, 0)).toBe(true);
    noteDrop(s, 'nuke', 0);
    expect(rollKill(s, rule, rng, 1, 3)).toBe(false); // spaced
    expect(rollKill(s, rule, rng, 1, 6)).toBe(true);
    noteDrop(s, 'maxAmmo', 6);
    expect(rollKill(s, rule, rng, 1, 60)).toBe(false); // capped
    startDropWave(s);
    expect(rollKill(s, rule, rng, 1, 61)).toBe(true);
    resetDropState(s);
    expect(s).toEqual(createDropState());
  });

  it('pity: a drop is guaranteed after N kills or T seconds of wave time without one', () => {
    const rule: DropRuleDef = { ...OPEN, chance: 0, pity: { kills: 10, seconds: 30 } };
    const s = createDropState();
    const rng = new Rng('pity');
    let at = -1;
    for (let i = 1; i <= 25 && at < 0; i++) if (rollKill(s, rule, rng, 1, i)) at = i;
    expect(at).toBe(10);
    noteDrop(s, 'nuke', 10);
    expect(pityReached(s, rule)).toBe(false);
    s.timeSinceDrop = 30;
    expect(rollKill(s, rule, rng, 1, 40)).toBe(true);
  });
});

describe('drop type', () => {
  it('weighted, never the same type twice in a row, conditions respected', () => {
    const rng = new Rng('types');
    const counts = new Map<string, number>();
    let last: string | null = null;
    for (let i = 0; i < 6000; i++) {
      const t = pickDropType(DEFS, last, rng, (c) => c === 'none');
      expect(t).not.toBeNull();
      expect(t).not.toBe(last);
      // Carpenter needs damaged seals; perk scraps never drop at random.
      expect(t).not.toBe('carpenter');
      expect(t).not.toBe('ammoScrap');
      counts.set(t!, (counts.get(t!) ?? 0) + 1);
      last = t;
    }
    for (const id of ['nuke', 'doublePoints', 'instakill', 'maxAmmo', 'slowmo']) {
      expect(counts.get(id) ?? 0).toBeGreaterThan(500);
    }
    // With damaged seals the carpenter joins.
    let carpenter = 0;
    for (let i = 0; i < 2000; i++) if (pickDropType(DEFS, null, rng, () => true) === 'carpenter') carpenter++;
    expect(carpenter).toBeGreaterThan(100);
  });

  it('falls back to the excluded type when it is the only one; null when nothing qualifies', () => {
    const only = [POWERUP_DEFS.maxAmmo!];
    const rng = new Rng('x');
    expect(pickDropType(only, 'maxAmmo', rng, () => true)).toBe('maxAmmo');
    expect(pickDropType(only, null, rng, () => false)).toBeNull();
    expect(pickDropType([POWERUP_DEFS.ammoScrap!], null, rng, () => true)).toBeNull();
  });

  it('is deterministic per seed', () => {
    const seq = (seed: string): string[] => {
      const rng = new Rng(seed);
      const s = createDropState();
      const out: string[] = [];
      for (let i = 0; i < 400; i++) {
        if (!rollKill(s, POWERUPS.drops, rng, 1, i * 2)) continue;
        const t = pickDropType(DEFS, s.lastType, rng, () => true)!;
        noteDrop(s, t, i * 2);
        if (s.dropsThisWave >= POWERUPS.drops.maxPerWave) startDropWave(s);
        out.push(`${i}:${t}`);
      }
      return out;
    };
    expect(seq('daily-1')).toEqual(seq('daily-1'));
    expect(seq('daily-1')).not.toEqual(seq('daily-2'));
    expect(seq('daily-1').length).toBeGreaterThan(5);
  });
});
