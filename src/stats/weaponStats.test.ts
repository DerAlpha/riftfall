import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../defs/weapons';
import { resolveWeapon } from '../weapons/resolveWeapon';
import { StatSystem } from './StatSystem';
import { createWeaponStatFactors, precisionScale, readWeaponStats, weaponStatMods } from './weaponStats';

describe('weapon stat conversion', () => {
  it('neutral stats change nothing (weapons keep their base def)', () => {
    const f = createWeaponStatFactors();
    expect(readWeaponStats(null, f)).toBe(false);
    expect(readWeaponStats(new StatSystem(), f)).toBe(false);
    expect(weaponStatMods(f)).toBeNull();
  });

  it('maps rates and sizes onto resolveWeapon mods', () => {
    const stats = new StatSystem();
    const f = createWeaponStatFactors();
    stats.addModifier({ source: 'p', stat: 'fireRate', op: 'mul', value: 1.5 });
    stats.addModifier({ source: 'p', stat: 'reloadSpeed', op: 'mul', value: 2 });
    stats.addModifier({ source: 'p', stat: 'magazineSize', op: 'mul', value: 1.25 });
    stats.addModifier({ source: 'p', stat: 'weaponSlots', op: 'add', value: 1 });
    stats.addModifier({ source: 'p', stat: 'headshotMultiplier', op: 'mul', value: 1.4 });
    expect(readWeaponStats(stats, f)).toBe(true);
    expect(readWeaponStats(stats, f)).toBe(false);
    expect(f.weaponSlots).toBe(1);
    const mods = weaponStatMods(f)!;
    const def = resolveWeapon(WEAPONS.rifle, { mods: [mods] });
    expect(def.rpm).toBeCloseTo(WEAPONS.rifle.rpm * 1.5);
    expect(def.reload.tactical).toBeCloseTo(WEAPONS.rifle.reload.tactical / 2);
    expect(def.reload.tacticalSteps[1]!.at).toBeCloseTo(WEAPONS.rifle.reload.tacticalSteps[1]!.at / 2);
    expect(def.magazine).toBe(40);
    expect(precisionScale('head', f.headshot)).toBeCloseTo(1.4);
    expect(precisionScale('weakpoint', f.headshot)).toBeCloseTo(1.4);
    expect(precisionScale('body', f.headshot)).toBe(1);
  });

  it('a zero spread stat still applies (resolveWeapon ignores factor 0)', () => {
    const stats = new StatSystem();
    const f = createWeaponStatFactors();
    stats.addModifier({ source: 'p', stat: 'spread', op: 'mul', value: 0 });
    readWeaponStats(stats, f);
    const def = resolveWeapon(WEAPONS.pistol, { mods: [weaponStatMods(f)!] });
    expect(def.spread.hip).toBeLessThan(1e-5);
  });
});
