import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../defs/weapons';
import { HitAccumulator, hitDamage, zoneMultiplier, zoneRank } from './damage';

const P = WEAPONS.pistol.damage;
const R = WEAPONS.rifle.damage;
const S = WEAPONS.shotgun.damage;

describe('damage', () => {
  it('zone multipliers come from the def', () => {
    expect(zoneMultiplier(P, 'head')).toBe(P.headMultiplier);
    expect(zoneMultiplier(P, 'limb')).toBe(P.limbMultiplier);
    expect(zoneMultiplier(P, 'weakpoint')).toBe(P.weakpointMultiplier);
    expect(zoneMultiplier(P, 'body')).toBe(1);
    expect(zoneMultiplier(P, 'shield')).toBe(1);
  });

  it('full damage up close, falloff to the minimum at range', () => {
    expect(hitDamage(P, 'body', 5)).toBe(45);
    expect(hitDamage(P, 'head', 5)).toBe(90);
    expect(hitDamage(R, 'body', 1000)).toBeCloseTo(R.base * R.minFalloffMultiplier, 9);
    const mid = (R.falloffStart + R.falloffEnd) / 2;
    expect(hitDamage(R, 'body', mid)).toBeCloseTo(R.base * (1 + R.minFalloffMultiplier) * 0.5, 9);
  });

  it('penetration keep and external scale multiply; garbage yields 0', () => {
    expect(hitDamage(P, 'body', 1, 0.5)).toBeCloseTo(22.5, 9);
    expect(hitDamage(P, 'body', 1, 1, 2)).toBe(90);
    expect(hitDamage(P, 'body', 1, Number.NaN)).toBe(0);
    expect(hitDamage(P, 'body', 1, -1)).toBe(0);
  });

  it('M2 feel targets: shotgun devastating close, weak far; rifle ~28', () => {
    const close = S.base * WEAPONS.shotgun.pellets;
    expect(close).toBe(126);
    expect(hitDamage(S, 'body', 30) * WEAPONS.shotgun.pellets).toBeLessThan(close * 0.3);
    expect(R.base).toBe(28);
    expect(WEAPONS.rifle.rpm).toBe(650);
  });

  it('zone rank orders weakpoint > head > body > limb > shield', () => {
    expect(zoneRank('weakpoint')).toBeGreaterThan(zoneRank('head'));
    expect(zoneRank('head')).toBeGreaterThan(zoneRank('body'));
    expect(zoneRank('body')).toBeGreaterThan(zoneRank('limb'));
    expect(zoneRank('limb')).toBeGreaterThan(zoneRank('shield'));
  });
});

describe('HitAccumulator', () => {
  it('aggregates pellets per target with the best zone and its first point', () => {
    const acc = new HitAccumulator<string>();
    acc.add('a', 10, 'body', 1, 0, 0);
    acc.add('b', 5, 'limb', 2, 0, 0);
    acc.add('a', 10, 'limb', 3, 0, 0);
    acc.add('a', 15, 'head', 4, 0, 0);
    acc.add('a', 15, 'head', 5, 0, 0);
    expect(acc.count).toBe(2);
    expect(acc.targets[0]).toBe('a');
    expect(acc.amounts[0]).toBe(50);
    expect(acc.hits[0]).toBe(4);
    expect(acc.zones[0]).toBe('head');
    expect(acc.px[0]).toBe(4);
    expect(acc.amounts[1]).toBe(5);
    acc.reset();
    expect(acc.count).toBe(0);
    acc.add('c', 1, 'body', 0, 0, 0);
    expect(acc.count).toBe(1);
    expect(acc.targets[0]).toBe('c');
  });
});
