import { describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponDef, type WeaponUpgradeTier } from '../defs/weapons';
import { resolveWeapon } from './resolveWeapon';

const tiers: readonly WeaponUpgradeTier[] = [
  { tier: 1, name: 'Stufe I', cost: 5000, mods: { damage: 1.5, magazine: 1.5 } },
  { tier: 2, name: 'Stufe II', cost: 15000, mods: { damage: 2, reloadTime: 0.5, element: 'shock' } },
];
const rifle: WeaponDef = { ...WEAPONS.rifle, upgrades: tiers };

describe('resolveWeapon', () => {
  it('returns the base def itself when nothing changes', () => {
    expect(resolveWeapon(WEAPONS.rifle)).toBe(WEAPONS.rifle);
    expect(resolveWeapon(rifle, { tier: 0, mods: [] })).toBe(rifle);
    expect(resolveWeapon(rifle, { mods: [{ damage: 1, rpm: Number.NaN, spread: -2 }] })).toBe(rifle);
  });

  it('applies Rift Forge tiers cumulatively, then attachment mods, then the element mod', () => {
    const t1 = resolveWeapon(rifle, { tier: 1 });
    expect(t1.damage.base).toBeCloseTo(WEAPONS.rifle.damage.base * 1.5, 9);
    expect(t1.magazine).toBe(48);
    expect(t1.damage.element).toBe('physical');
    const t2 = resolveWeapon(rifle, { tier: 2, mods: [{ rpm: 1.2, extraPellets: 0 }] });
    expect(t2.damage.base).toBeCloseTo(WEAPONS.rifle.damage.base * 3, 9);
    expect(t2.rpm).toBeCloseTo(WEAPONS.rifle.rpm * 1.2, 9);
    expect(t2.damage.element).toBe('shock');
    expect(resolveWeapon(rifle, { tier: 2, element: 'fire' }).damage.element).toBe('fire');
    // The base def is never mutated.
    expect(rifle.damage.base).toBe(WEAPONS.rifle.damage.base);
    expect(rifle.magazine).toBe(WEAPONS.rifle.magazine);
  });

  it('scales reload durations and marker times together (gameplay commit = animation marker)', () => {
    const r = resolveWeapon(rifle, { tier: 2 }).reload;
    const base = WEAPONS.rifle.reload;
    expect(r.tactical).toBeCloseTo(base.tactical * 0.5, 9);
    expect(r.empty).toBeCloseTo(base.empty * 0.5, 9);
    for (const [i, m] of r.tacticalSteps.entries()) {
      expect(m.step).toBe(base.tacticalSteps[i]!.step);
      expect(m.at / r.tactical).toBeCloseTo(base.tacticalSteps[i]!.at / base.tactical, 9);
    }
    const sg = resolveWeapon(WEAPONS.shotgun, { mods: [{ reloadTime: 0.8 }] }).reload.perShell!;
    const ps = WEAPONS.shotgun.reload.perShell!;
    expect(sg.shell).toBeCloseTo(ps.shell * 0.8, 9);
    expect(sg.insertAt / sg.shell).toBeCloseTo(ps.insertAt / ps.shell, 9);
    expect(sg.pumpAt / sg.emptyEnd).toBeCloseTo(ps.pumpAt / ps.emptyEnd, 9);
  });

  it('spread, recoil, range, penetration and pellets', () => {
    const d = resolveWeapon(WEAPONS.shotgun, {
      mods: [{ spread: 0.5, recoil: 0.5, range: 2, penetration: 3, extraPellets: 2, reserve: 1.5 }],
    });
    const b = WEAPONS.shotgun;
    expect(d.spread.hip).toBeCloseTo(b.spread.hip * 0.5, 9);
    expect(d.spread.bloomMax).toBeCloseTo(b.spread.bloomMax * 0.5, 9);
    expect(d.spread.recoveryPerSec).toBe(b.spread.recoveryPerSec);
    expect(d.recoil.pattern[0]![1]).toBeCloseTo(b.recoil.pattern[0]![1] * 0.5, 9);
    expect(d.recoil.randomYaw).toBeCloseTo(b.recoil.randomYaw * 0.5, 9);
    expect(d.recoil.recoveryPerSec).toBe(b.recoil.recoveryPerSec);
    expect(d.range).toBe(b.range * 2);
    expect(d.penetration.power).toBeCloseTo(b.penetration.power * 3, 9);
    expect(d.penetration.damageKeep).toBe(b.penetration.damageKeep);
    expect(d.pellets).toBe(b.pellets + 2);
    expect(d.reserve).toBe(60);
    // Magazine and pellets never drop below one.
    const tiny = resolveWeapon(WEAPONS.pistol, { mods: [{ magazine: 0.01, extraPellets: -5 }] });
    expect(tiny.magazine).toBe(1);
    expect(tiny.pellets).toBe(1);
  });
});
