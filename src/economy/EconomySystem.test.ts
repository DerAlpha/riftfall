import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { ECONOMY, ammoCost, doorCost, startPointsFor, waveBonus, weaponCost } from '../defs/economy';
import { WEAPONS } from '../defs/weapons';
import { StatSystem } from '../stats/StatSystem';
import { EconomySystem, roundPoints } from './EconomySystem';

function setup(start?: number) {
  const events = new EventBus<GameEvents>();
  const stats = new StatSystem({ events });
  const points: GameEvents['economy:points'][] = [];
  const purchases: GameEvents['economy:purchase'][] = [];
  events.on('economy:points', (e) =>
    points.push({ ...e, position: e.position ? { ...e.position } : undefined }),
  );
  events.on('economy:purchase', (e) => purchases.push({ ...e }));
  const economy = new EconomySystem({ events, stats }, start);
  return { events, stats, economy, points, purchases };
}

describe('EconomySystem', () => {
  it('starts with the start points (CoD: 500)', () => {
    expect(ECONOMY.startPoints).toBe(500);
    expect(setup().economy.points).toBe(500);
    expect(setup(1234).economy.points).toBe(1234);
    expect(setup(-5).economy.points).toBe(ECONOMY.startPoints);
  });

  it('earns with the pointsMultiplier stat (earnings only) and emits economy:points', () => {
    const { economy, stats, points } = setup(0);
    expect(economy.earn(10, 'hit', { x: 1, y: 2, z: 3 })).toBe(10);
    expect(points.at(-1)).toEqual({ delta: 10, total: 10, reason: 'hit', position: { x: 1, y: 2, z: 3 } });
    stats.addModifier({ source: 'powerup:doublePoints', stat: 'pointsMultiplier', op: 'mul', value: 2 });
    expect(economy.multiplier).toBe(2);
    expect(economy.earn(60, 'kill')).toBe(120);
    expect(economy.points).toBe(130);
    expect(points.at(-1)).toMatchObject({ delta: 120, total: 130, reason: 'kill' });
    expect(points.at(-1)!.position).toBeUndefined();
    // Spending is never scaled.
    expect(economy.spend(100, 'door_a', 'door')).toBe(true);
    expect(economy.points).toBe(30);
    // Refunds and dev grants are unscaled.
    expect(economy.earn(50, 'refund')).toBe(50);
    expect(economy.earn(50, 'dev')).toBe(50);
    stats.removeSource('powerup:doublePoints');
    expect(economy.earn(10, 'hit')).toBe(10);
    // The refund took 50 of the door purchase back out of the totals.
    expect(economy.totals).toEqual({ earned: 10 + 120 + 50 + 10, spent: 50, purchases: 0 });
  });

  it('rounds earnings to whole points and ignores non-positive or invalid amounts', () => {
    const { economy, stats, points } = setup(0);
    stats.addModifier({ source: 'card', stat: 'pointsMultiplier', op: 'mul', value: 1.15 });
    expect(economy.earn(10, 'hit')).toBe(12);
    expect(economy.earn(0, 'hit')).toBe(0);
    expect(economy.earn(-10, 'hit')).toBe(0);
    expect(economy.earn(Number.NaN, 'hit')).toBe(0);
    expect(economy.earn(Number.POSITIVE_INFINITY, 'hit')).toBe(0);
    expect(points).toHaveLength(1);
    stats.addModifier({ source: 'curse', stat: 'pointsMultiplier', op: 'mul', value: 0 });
    expect(economy.earn(100, 'kill')).toBe(0);
    expect(roundPoints(12.5)).toBe(13);
    expect(roundPoints(Number.NaN)).toBe(0);
  });

  it('spend is atomic: all or nothing, never below zero', () => {
    const { economy, points, purchases } = setup(950);
    expect(economy.canAfford(950)).toBe(true);
    expect(economy.canAfford(951)).toBe(false);
    expect(economy.spend(951, 'box', 'box')).toBe(false);
    expect(economy.points).toBe(950);
    expect(points).toHaveLength(0);
    expect(purchases.at(-1)).toEqual({ item: 'box', kind: 'box', cost: 951, ok: false });
    expect(economy.spend(950, 'box', 'box')).toBe(true);
    expect(economy.points).toBe(0);
    expect(points.at(-1)).toEqual({ delta: -950, total: 0, reason: 'purchase', position: undefined });
    expect(purchases.at(-1)).toEqual({ item: 'box', kind: 'box', cost: 950, ok: true });
    expect(economy.totals).toEqual({ earned: 0, spent: 950, purchases: 1 });
    // Free items succeed without a points event; invalid costs fail.
    expect(economy.spend(0, 'free', 'other')).toBe(true);
    expect(points).toHaveLength(1);
    expect(economy.spend(Number.NaN, 'bad', 'other')).toBe(false);
    expect(economy.spend(-100, 'bad', 'other')).toBe(false);
    expect(economy.canAfford(-1)).toBe(false);
    expect(economy.points).toBe(0);
  });

  it('adjust (dev) is unscaled and clamps at zero; reset restores the start points', () => {
    const { economy, stats, points } = setup(100);
    stats.addModifier({ source: 'x', stat: 'pointsMultiplier', op: 'mul', value: 2 });
    expect(economy.adjust(500)).toBe(500);
    expect(economy.points).toBe(600);
    expect(economy.adjust(-1000)).toBe(-600);
    expect(economy.points).toBe(0);
    expect(economy.adjust(-10)).toBe(0);
    economy.earn(10, 'hit');
    // Back to the constructor's start value (the map's).
    economy.reset();
    expect(economy.points).toBe(100);
    expect(economy.totals).toEqual({ earned: 0, spent: 0, purchases: 0 });
    // The HUD sets the total without a popup.
    expect(points.at(-1)).toMatchObject({ delta: 0, total: 100 });
    economy.reset(2000);
    expect(economy.points).toBe(2000);
  });

  it('a refund undoes the purchase in the run totals instead of counting as earnings', () => {
    const { economy, stats, points } = setup(1000);
    stats.addModifier({ source: 'powerup:doublePoints', stat: 'pointsMultiplier', op: 'mul', value: 2 });
    expect(economy.spend(950, 'box', 'box')).toBe(true);
    expect(economy.earn(950, 'refund')).toBe(950);
    expect(economy.points).toBe(1000);
    expect(points.at(-1)).toMatchObject({ delta: 950, total: 1000, reason: 'refund' });
    expect(economy.totals).toEqual({ earned: 0, spent: 0, purchases: 0 });
    // A refund beyond what was spent (dev, content error) still never makes the totals negative.
    economy.earn(100, 'refund');
    expect(economy.totals).toEqual({ earned: 100, spent: 0, purchases: 0 });
  });

  it("reset restores the map's start value (the calibration hall's sandbox budget)", () => {
    expect(startPointsFor({ movementSandbox: true })).toBe(ECONOMY.sandboxStartPoints);
    expect(startPointsFor({})).toBe(ECONOMY.startPoints);
    const { economy } = setup(startPointsFor({ movementSandbox: true }));
    economy.spend(950, 'box', 'box');
    economy.reset();
    expect(economy.points).toBe(ECONOMY.sandboxStartPoints);
  });

  it('works without stats (×1)', () => {
    const events = new EventBus<GameEvents>();
    const economy = new EconomySystem({ events });
    expect(economy.earn(60, 'kill')).toBe(60);
    economy.setStats(null);
    expect(economy.multiplier).toBe(1);
  });
});

describe('economy defs', () => {
  it('prices: box 950, ammo half the weapon price, door default and hints', () => {
    expect(ECONOMY.costs.box).toBe(950);
    expect(ammoCost(WEAPONS.rifle.cost)).toBe(600);
    expect(ammoCost(1500)).toBe(750);
    expect(ammoCost(1250)).toBe(630);
    expect(ammoCost(0)).toBe(0);
    expect(weaponCost('rifle')).toBe(WEAPONS.rifle.cost);
    expect(weaponCost('nope')).toBe(ECONOMY.costs.weaponDefault);
    expect(doorCost(1000)).toBe(1000);
    expect(doorCost(undefined)).toBe(ECONOMY.costs.doorDefault);
    expect(doorCost(0, true)).toBe(ECONOMY.costs.blastDoorDefault);
  });

  it('wave bonus grows per wave up to its cap', () => {
    const w = ECONOMY.points.wave;
    expect(waveBonus(0)).toBe(0);
    expect(waveBonus(1)).toBe(w.base + w.perWave);
    expect(waveBonus(5)).toBe(w.base + 5 * w.perWave);
    expect(waveBonus(1000)).toBe(w.max);
    expect(waveBonus(Number.NaN)).toBe(0);
  });
});
