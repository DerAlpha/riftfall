import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { STAT_DEFS, STAT_IDS, getStatDef, type StatDef } from '../defs/stats';
import { MOVEMENT } from '../defs/movement';
import { PLAYER } from '../defs/player';
import { WEAPON_RULES } from '../defs/weapons';
import { StatSystem, computeStat, statRatio } from './StatSystem';

const DEFS: Record<string, StatDef> = {
  speed: { base: 1, min: 0.5, max: 2, label: 'Tempo', format: 'multiplier' },
  health: { base: 100, min: 1, max: 500, label: 'HP', format: 'value', unit: 'HP' },
  charges: { base: 2, min: 0, max: 5, label: 'Ladungen', format: 'count', integer: true },
};

function setup() {
  const events = new EventBus<GameEvents>();
  const changes: string[][] = [];
  events.on('stats:changed', (e) => changes.push([...e.stats]));
  const stats = new StatSystem({ events, defs: DEFS });
  return { events, stats, changes };
}

describe('stat table', () => {
  it('covers every stat the spec names, with sane bounds and German labels', () => {
    const required = [
      'moveSpeed',
      'sprintSpeed',
      'dashCharges',
      'dashRecharge',
      'maxHealth',
      'maxArmor',
      'regenDelay',
      'regenRate',
      'damageTaken',
      'explosionDamageTaken',
      'fallDamageTaken',
      'fireRate',
      'reloadSpeed',
      'adsSpeed',
      'damage',
      'headshotMultiplier',
      'spread',
      'recoil',
      'magazineSize',
      'reserveAmmo',
      'meleeDamage',
      'weaponSlots',
      'perkSlots',
      'pointsMultiplier',
      'powerUpDuration',
      'dropChance',
      'reviveCharges',
    ];
    for (const id of required) expect(getStatDef(id), id).toBeDefined();
    for (const id of STAT_IDS) {
      const d: StatDef = STAT_DEFS[id];
      expect(d.min, id).toBeLessThanOrEqual(d.base);
      expect(d.max, id).toBeGreaterThanOrEqual(d.base);
      expect(d.label.length, id).toBeGreaterThan(2);
      if (d.format === 'multiplier') expect(d.base, id).toBe(1);
    }
  });

  it('absolute stats take their base from the gameplay defs', () => {
    expect(STAT_DEFS.maxHealth.base).toBe(PLAYER.health.maxHealth);
    expect(STAT_DEFS.regenDelay.base).toBe(PLAYER.health.regenDelay);
    expect(STAT_DEFS.dashCharges.base).toBe(MOVEMENT.dash.charges);
    // weaponSlots is an add-only bonus on top of the map loadout.
    expect(STAT_DEFS.weaponSlots.base).toBe(0);
    expect(STAT_DEFS.weaponSlots.max).toBe(WEAPON_RULES.inventory.maxSlots - 1);
    expect(STAT_DEFS.perkSlots.base).toBe(4);
  });
});

describe('computeStat', () => {
  it('(base + Σadd) × Πmul, clamped', () => {
    const d = DEFS.health!;
    expect(computeStat(d, [])).toBe(100);
    expect(
      computeStat(d, [
        { source: 'a', stat: 'health', op: 'add', value: 50 },
        { source: 'b', stat: 'health', op: 'mul', value: 1.5 },
        { source: 'c', stat: 'health', op: 'add', value: 10 },
        { source: 'd', stat: 'health', op: 'mul', value: 2 },
      ]),
    ).toBe((100 + 60) * 3);
    expect(computeStat(d, [{ source: 'a', stat: 'health', op: 'mul', value: 100 }])).toBe(500);
    expect(computeStat(d, [{ source: 'a', stat: 'health', op: 'mul', value: 0 }])).toBe(1);
  });

  it('rounds integer stats down after clamping, tolerant of float noise', () => {
    const d = DEFS.charges!;
    expect(computeStat(d, [{ source: 'a', stat: 'charges', op: 'mul', value: 1.7 }])).toBe(3);
    const tenths = [0.1, 0.1, 0.1].map((value) => ({
      source: 'a',
      stat: 'charges',
      op: 'add' as const,
      value,
    }));
    // 2 + 0.1 + 0.1 + 0.1 = 2.3000000000000003, and 0.7 + 0.1 + 0.1 + 0.1 = 0.9999999999999999
    expect(computeStat(d, tenths)).toBe(2);
    const noisy = { ...d, base: 0.7 };
    expect(computeStat(noisy, tenths)).toBe(1);
  });
});

describe('StatSystem', () => {
  it('caches values, bumps the version and emits changed ids once per call', () => {
    const { stats, changes } = setup();
    expect(stats.value('speed')).toBe(1);
    expect(stats.version).toBe(0);
    stats.addModifier({ source: 'perk:a', stat: 'speed', op: 'mul', value: 1.25 });
    expect(stats.value('speed')).toBe(1.25);
    expect(stats.version).toBe(1);
    expect(changes).toEqual([['speed']]);
    stats.addModifier({ source: 'perk:a', stat: 'health', op: 'add', value: 50 });
    expect(stats.value('health')).toBe(150);
    expect(stats.version).toBe(2);
    expect(stats.hasSource('perk:a')).toBe(true);
  });

  it('a modifier that does not change the clamped value is stored but silent', () => {
    const { stats, changes } = setup();
    stats.addModifier({ source: 'a', stat: 'speed', op: 'mul', value: 5 });
    expect(stats.value('speed')).toBe(2);
    const v = stats.version;
    stats.addModifier({ source: 'b', stat: 'speed', op: 'mul', value: 3 });
    expect(stats.version).toBe(v);
    expect(changes).toHaveLength(1);
    stats.removeSource('a');
    // 1 × 3 = 3 → still clamped to 2: no change.
    expect(stats.value('speed')).toBe(2);
    expect(stats.version).toBe(v);
    stats.removeSource('b');
    expect(stats.value('speed')).toBe(1);
  });

  it('removeSource restores the exact previous values (one event for all its stats)', () => {
    const { stats, changes } = setup();
    stats.addModifier({ source: 'x', stat: 'speed', op: 'mul', value: 1.1 });
    stats.addModifier({ source: 'x', stat: 'speed', op: 'add', value: 0.03 });
    const before = { speed: stats.value('speed'), health: stats.value('health') };
    stats.batch(() => {
      stats.addModifier({ source: 'perk:z', stat: 'speed', op: 'mul', value: 1.37 });
      stats.addModifier({ source: 'perk:z', stat: 'health', op: 'mul', value: 1.8 });
      stats.addModifier({ source: 'perk:z', stat: 'health', op: 'add', value: 7 });
    });
    expect(changes.at(-1)).toEqual(['speed', 'health']);
    const v = stats.version;
    stats.removeSource('perk:z');
    expect(stats.version).toBe(v + 1);
    expect(changes.at(-1)).toEqual(['speed', 'health']);
    expect(stats.value('speed')).toBe(before.speed);
    expect(stats.value('health')).toBe(before.health);
    expect(stats.hasSource('perk:z')).toBe(false);
    stats.removeSource('perk:z');
    expect(stats.version).toBe(v + 1);
  });

  it('batch merges several calls into one version step and one event', () => {
    const { stats, changes } = setup();
    stats.batch(() => {
      stats.addModifier({ source: 'a', stat: 'speed', op: 'mul', value: 1.5 });
      stats.addModifier({ source: 'a', stat: 'charges', op: 'add', value: 1 });
      stats.batch(() => stats.addModifier({ source: 'b', stat: 'health', op: 'add', value: 1 }));
      expect(changes).toHaveLength(0);
    });
    expect(stats.version).toBe(1);
    expect(changes).toEqual([['speed', 'charges', 'health']]);
  });

  it('setSource replaces a source in one step (stacking buffs)', () => {
    const { stats, changes } = setup();
    stats.setSource('buff', [{ stat: 'speed', op: 'mul', value: 1.1 }]);
    stats.setSource('buff', [{ stat: 'speed', op: 'mul', value: 1.2 }]);
    expect(stats.value('speed')).toBeCloseTo(1.2);
    expect(stats.modifiers('speed')).toHaveLength(1);
    expect(stats.version).toBe(2);
    expect(changes).toHaveLength(2);
  });

  it('stores copies (callers may reuse their modifier objects)', () => {
    const { stats } = setup();
    const mod = { source: 'a', stat: 'speed', op: 'mul' as const, value: 1.5 };
    stats.addModifier(mod);
    mod.value = 1.9;
    expect(stats.value('speed')).toBe(1.5);
    stats.removeSource('a');
    expect(stats.value('speed')).toBe(1);
  });

  it('reset drops every modifier', () => {
    const { stats, changes } = setup();
    stats.addModifier({ source: 'a', stat: 'speed', op: 'mul', value: 1.5 });
    stats.addModifier({ source: 'b', stat: 'charges', op: 'add', value: 2 });
    stats.reset();
    expect(stats.value('speed')).toBe(1);
    expect(stats.value('charges')).toBe(2);
    expect(stats.activeSources).toEqual([]);
    expect(changes.at(-1)).toEqual(['speed', 'charges']);
    const v = stats.version;
    stats.reset();
    expect(stats.version).toBe(v);
  });

  it('ignores unknown stats and invalid values instead of crashing', () => {
    const { stats } = setup();
    expect(stats.value('nope')).toBe(0);
    expect(stats.base('nope')).toBe(0);
    stats.addModifier({ source: 'a', stat: 'nope', op: 'add', value: 1 });
    stats.addModifier({ source: 'a', stat: 'speed', op: 'mul', value: Number.NaN });
    stats.addModifier({ source: 'a', stat: 'speed', op: 'pow' as 'mul', value: 2 });
    expect(stats.value('speed')).toBe(1);
    expect(stats.version).toBe(0);
    expect(stats.hasSource('a')).toBe(false);
  });

  it('lists modified stats and works without an event bus on the real table', () => {
    const stats = new StatSystem();
    expect(stats.modified()).toEqual([]);
    stats.addModifier({ source: 'p', stat: 'fireRate', op: 'mul', value: 1.33 });
    expect(stats.modified()).toEqual(['fireRate']);
    expect(stats.value('perkSlots')).toBe(4);
    expect(stats.ids.length).toBe(STAT_IDS.length);
  });

  it('statRatio: value ÷ base, 1 for zero bases', () => {
    const { stats } = setup();
    stats.addModifier({ source: 'a', stat: 'health', op: 'mul', value: 1.8 });
    expect(statRatio(stats, 'health')).toBeCloseTo(1.8);
    expect(statRatio(stats, 'nope')).toBe(1);
  });
});
