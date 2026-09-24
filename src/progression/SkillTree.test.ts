import { describe, expect, it } from 'vitest';
import type { PlayerProgressData, SkillTreeData } from '../core/contracts';
import { PROGRESSION } from '../defs/progression';
import { SKILL_NODES, SKILL_RULES, skillSource, totalSkillCost } from '../defs/skills';
import { STAT_DEFS } from '../defs/stats';
import { createDefaultPlayerProgress, createDefaultSkills } from '../save/defaults';
import { StatSystem } from '../stats/StatSystem';
import { SkillTree, skillPointsEarned, tierGate } from './SkillTree';

function setup(level = 30, prestige = 0, data: SkillTreeData = createDefaultSkills()) {
  const progress: PlayerProgressData = {
    ...createDefaultPlayerProgress(),
    level,
    highestLevel: level,
    prestige,
  };
  const wallet = { currency: 0 };
  const run = { active: false };
  const changes: (string | null)[] = [];
  const tree = new SkillTree(data, {
    progress: () => progress,
    spendCurrency: (n) => {
      if (wallet.currency < n) return false;
      wallet.currency -= n;
      return true;
    },
    inRun: () => run.active,
    onChange: (id) => changes.push(id),
  });
  return { tree, progress, wallet, run, changes, data };
}

describe('skill points', () => {
  it('come from the highest level reached and the prestige ranks', () => {
    const S = PROGRESSION.skillPoints;
    expect(skillPointsEarned({ ...createDefaultPlayerProgress() })).toBe(0);
    expect(skillPointsEarned({ ...createDefaultPlayerProgress(), highestLevel: 10 })).toBe(9 * S.perLevel);
    // A prestige resets the level but keeps the level points.
    expect(
      skillPointsEarned({ ...createDefaultPlayerProgress(), level: 1, highestLevel: 100, prestige: 2 }),
    ).toBe(99 * S.perLevel + 2 * S.perPrestige);
  });

  it('accounts spent and available points per purchase', () => {
    const { tree } = setup(6); // 5 points
    expect(tree.earned).toBe(5);
    expect(tree.unlock('off_caliber')).toBe(true);
    expect(tree.unlock('off_caliber')).toBe(true);
    expect(tree.spent).toBe(2);
    expect(tree.available).toBe(3);
    expect(tree.rank('off_caliber')).toBe(2);
    expect(tree.ranksBought).toBe(2);
  });

  it('the whole tree costs less than the max prestige grants but more than level 100 alone', () => {
    const total = totalSkillCost();
    const max = skillPointsEarned({
      ...createDefaultPlayerProgress(),
      highestLevel: PROGRESSION.maxLevel,
      prestige: PROGRESSION.prestige.maxRank,
    });
    const level100 = skillPointsEarned({
      ...createDefaultPlayerProgress(),
      highestLevel: PROGRESSION.maxLevel,
    });
    expect(total).toBeLessThanOrEqual(max);
    expect(total).toBeGreaterThan(level100);
  });
});

describe('purchase rules', () => {
  it('checks unknown, prerequisites, points and max rank', () => {
    const { tree } = setup(3); // 2 points
    expect(tree.check('nope')).toBe('unknown');
    expect(tree.check('off_acquire')).toBe('locked');
    expect(tree.unlock('off_acquire')).toBe(false);
    expect(tree.unlock('tac_dash')).toBe(true);
    expect(tree.check('tac_dash')).toBe('maxed');
    expect(tree.unlock('off_caliber')).toBe(true);
    expect(tree.check('off_marksman')).toBe('points');
  });

  it('opens tiers only after enough points in the same branch', () => {
    const { tree } = setup(40);
    tree.unlock('off_marksman');
    // Tier 2 needs SKILL_RULES.tierGates[1] points in the offensive branch.
    expect(tree.check('off_acquire')).toBe(tierGate(2) > 1 ? 'tier' : 'ok');
    // Points in another branch do not count.
    tree.unlock('sur_tough');
    tree.unlock('sur_tough');
    tree.unlock('sur_tough');
    expect(tree.check('off_acquire')).toBe('tier');
    while (tree.branchSpent('offensive') < tierGate(2)) {
      expect(tree.unlock(tree.rank('off_marksman') < 3 ? 'off_marksman' : 'off_caliber')).toBe(true);
    }
    expect(tree.check('off_acquire')).toBe('ok');
  });

  it('every node can be bought in a valid order with the max prestige points', () => {
    const { tree } = setup(PROGRESSION.maxLevel, PROGRESSION.prestige.maxRank);
    let progress = true;
    while (progress) {
      progress = false;
      for (const n of SKILL_NODES) if (tree.unlock(n.id)) progress = true;
    }
    for (const n of SKILL_NODES) expect(tree.rank(n.id)).toBe(n.maxRank);
    for (const b of ['offensive', 'survival', 'tactics'] as const) expect(tree.branchComplete(b)).toBe(true);
  });
});

describe('stat modifiers', () => {
  it('are applied through the StatSystem and removed exactly', () => {
    const { tree } = setup(20);
    const stats = new StatSystem();
    tree.unlock('sur_tough');
    tree.unlock('sur_tough');
    tree.unlock('off_caliber');
    tree.applyTo(stats);
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base + 10);
    expect(stats.value('damage')).toBeCloseTo(1.02);
    expect(stats.hasSource(skillSource('sur_tough'))).toBe(true);
    // Idempotent: applying again does not stack.
    tree.applyTo(stats);
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base + 10);
    // After a run reset of the stat table they come back with the next apply.
    stats.reset();
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base);
    tree.applyTo(stats);
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base + 10);
    // A respec removes them on the next apply; other sources stay untouched.
    stats.addModifier({ source: 'perk:titan', stat: 'maxHealth', op: 'mul', value: 2 });
    tree.reset();
    tree.applyTo(stats);
    expect(stats.hasSource(skillSource('sur_tough'))).toBe(false);
    expect(stats.value('maxHealth')).toBe(STAT_DEFS.maxHealth.base * 2);
  });

  it("multiplies 'mul' effects per rank and adds 'add' effects per rank", () => {
    const { tree } = setup(30);
    tree.unlock('off_caliber');
    tree.unlock('off_caliber');
    tree.unlock('off_caliber');
    const mods = tree.modifiers();
    const dmg = mods.find((m) => m.stat === 'damage')!;
    expect(dmg.value).toBeCloseTo(1.02 ** 3);
    expect(dmg.source).toBe('skill:off_caliber');
  });
});

describe('run bonuses and licences', () => {
  it('collects start points, grenades, cashback and movement unlocks', () => {
    const { tree } = setup(PROGRESSION.maxLevel, PROGRESSION.prestige.maxRank);
    expect(tree.bonuses.dash).toBe(false);
    tree.unlock('tac_dash');
    tree.unlock('tac_capital');
    tree.unlock('tac_capital');
    expect(tree.bonuses).toMatchObject({ dash: true, doubleJump: false, startPoints: 500 });
    tree.unlock('tac_capital');
    tree.unlock('tac_doublejump');
    tree.unlock('tac_grenadier');
    tree.unlock('tac_haggler');
    expect(tree.bonuses).toMatchObject({ doubleJump: true, startGrenades: 1, boxCashback: 0.1 });
    expect(tree.bonuses.grenades).toEqual(SKILL_RULES.defaultGrenades);
  });

  it('allows a start grenade / ability only when licensed', () => {
    const { tree, data } = setup(PROGRESSION.maxLevel);
    expect(tree.setLoadout('grenade', 'brand')).toBe(false);
    tree.unlock('tac_capital');
    tree.unlock('tac_capital');
    tree.unlock('tac_capital');
    tree.unlock('tac_ordnance');
    expect(tree.bonuses.grenades).toContain('brand');
    expect(tree.setLoadout('grenade', 'brand')).toBe(true);
    expect(data.loadout.grenade).toBe('brand');
    expect(tree.setLoadout('grenade', null)).toBe(true);
    expect(tree.setLoadout('ability', 'schockwelle')).toBe(true);
  });
});

describe('respec', () => {
  it('is free once, then costs Rift-Splitter, and never during a run', () => {
    const { tree, wallet, run } = setup(10);
    tree.unlock('off_caliber');
    run.active = true;
    expect(tree.respec()).toBe(false);
    run.active = false;
    expect(tree.respecCost).toBe(0);
    expect(tree.respec()).toBe(true);
    expect(tree.spent).toBe(0);
    expect(tree.respec()).toBe(false); // nothing to refund
    tree.unlock('off_caliber');
    expect(tree.respecCost).toBe(SKILL_RULES.respec.currency);
    expect(tree.respec()).toBe(false); // no currency
    wallet.currency = SKILL_RULES.respec.currency;
    expect(tree.respec()).toBe(true);
    expect(wallet.currency).toBe(0);
    expect(tree.respecs).toBe(2);
  });
});

describe('repairing loaded allocations', () => {
  it('drops unknown nodes, clamps ranks and removes nodes without prerequisites or tier gate', () => {
    const data = createDefaultSkills();
    data.ranks = { off_caliber: 9, bogus: 3, off_acquire: 1, off_trigger: 2 };
    const { tree } = setup(30, 0, data);
    expect(tree.rank('off_caliber')).toBe(3);
    expect(tree.rank('bogus')).toBe(0);
    // off_acquire needs off_marksman; off_trigger needs off_quickload.
    expect(tree.rank('off_acquire')).toBe(0);
    expect(tree.rank('off_trigger')).toBe(0);
    expect(Object.keys(data.ranks)).toEqual(['off_caliber']);
  });

  it('refunds everything when more points are spent than earned', () => {
    const data = createDefaultSkills();
    data.ranks = { off_caliber: 3, sur_tough: 3 };
    data.loadout.grenade = 'brand';
    const { tree } = setup(3, 0, data); // 2 points
    expect(tree.spent).toBe(0);
    expect(data.loadout.grenade).toBeNull();
  });
});
