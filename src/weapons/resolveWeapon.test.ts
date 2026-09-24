import { describe, expect, it } from 'vitest';
import { ATTACHMENTS } from '../defs/attachments';
import { forgePaletteId, getForgeLook } from '../defs/forge';
import { WEAPONS, type WeaponDef, type WeaponUpgradeTier } from '../defs/weapons';
import { resolveWeapon, specialAt } from './resolveWeapon';

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

describe('resolveWeapon (M5): tiers, attachments, kind data', () => {
  it('a tier renames the weapon, brings its special (kept until replaced) and recolors the tracer', () => {
    const plasma = WEAPONS.plasma as WeaponDef;
    const t1 = resolveWeapon(plasma, { tier: 1 });
    expect(t1.name).toBe(plasma.upgrades[0]!.name);
    expect(t1.special).toEqual(plasma.upgrades[0]!.special);
    // Tier 1/2 without their own tracer color: the forge look's; tier 3: its own.
    expect(t1.tracer.color).toBe(getForgeLook(forgePaletteId(plasma, 1))!.tracer);
    const t3 = resolveWeapon(plasma, { tier: 3 });
    expect(t3.tracer.color).toBe(plasma.upgrades[2]!.tracerColor);
    expect(t3.special).toEqual(plasma.upgrades[2]!.special);
    // A wonder weapon's base special stays until a tier replaces it; `null` removes it.
    const harp = WEAPONS.aetherharp as WeaponDef;
    expect(resolveWeapon(harp, { element: 'fire' }).special).toEqual(harp.special);
    const noSpecial: WeaponDef = {
      ...harp,
      upgrades: harp.upgrades.map((u) => (u.tier === 2 ? { ...u, special: null } : u)),
    };
    expect(resolveWeapon(noSpecial, { tier: 2 }).special).toBeNull();
    expect(specialAt(noSpecial, 1)).toEqual(harp.upgrades[0]!.special);
    expect(resolveWeapon(WEAPONS.rifle, {}).name).toBe(WEAPONS.rifle.name);
  });

  it('attachments: an optic sets its absolute zoom, handling mods scale ADS / hip / move speed', () => {
    const r = resolveWeapon(WEAPONS.rifle, { attachments: ['acog', 'tacticallaser', 'drum', 'unknown'] });
    expect(r.ads.zoom).toBeCloseTo(0.48, 9);
    const acog = ATTACHMENTS.acog.mods;
    const drum = ATTACHMENTS.drum.mods;
    expect(r.ads.inTime).toBeCloseTo(WEAPONS.rifle.ads.inTime * acog.adsTime * drum.adsTime, 9);
    expect(r.spread.hip).toBeCloseTo(WEAPONS.rifle.spread.hip * acog.hipSpread * ATTACHMENTS.tacticallaser.mods.hipSpread, 9);
    expect(r.spread.ads).toBeCloseTo(WEAPONS.rifle.spread.ads, 9);
    expect(r.magazine).toBe(Math.round(WEAPONS.rifle.magazine * drum.magazine));
    expect(r.ads.moveSpeedMultiplier).toBeCloseTo(WEAPONS.rifle.ads.moveSpeedMultiplier * drum.moveSpeed, 9);
    expect(r.carrySpeedMultiplier).toBeCloseTo(drum.moveSpeed, 9);
    const light = resolveWeapon(WEAPONS.shotgun, { attachments: ['shortbarrel'] });
    expect(light.equipTime).toBeCloseTo(WEAPONS.shotgun.equipTime * 0.9, 9);
    // Heavy weapons keep their carry speed (× moveSpeed mods).
    expect(resolveWeapon(WEAPONS.minigun, { tier: 1 }).carrySpeedMultiplier).toBe(WEAPONS.minigun.carrySpeedMultiplier);
  });

  it('projectile data follows damage, projectileSpeed and blastRadius; an element mod retargets the blast', () => {
    const gl = WEAPONS.grenadelauncher as WeaponDef;
    const p = gl.projectile!;
    const r = resolveWeapon(gl, { mods: [{ damage: 2, projectileSpeed: 1.5, blastRadius: 1.2 }], element: 'fire' });
    expect(r.projectile!.speed).toBeCloseTo(p.speed * 1.5, 9);
    expect(r.projectile!.explosion!.damage).toBeCloseTo(p.explosion!.damage * 2, 9);
    expect(r.projectile!.explosion!.radius).toBeCloseTo(p.explosion!.radius * 1.2, 9);
    expect(r.projectile!.explosion!.element).toBe('fire');
    expect(r.projectile!.explosion!.vfx).toBe('explosion.fire');
    expect(r.projectile!.explosion!.audio).toBe('explosion.fire');
    // Blasts of another element than the weapon's (and non-convention ids) are kept.
    const plasma = resolveWeapon(WEAPONS.plasma as WeaponDef, { element: 'ice' });
    expect(plasma.projectile!.explosion!.element).toBe('ice');
    expect(plasma.projectile!.explosion!.vfx).toBe('impact.plasma');
    const bh = WEAPONS.blackhole as WeaponDef;
    const b2 = resolveWeapon(bh, { mods: [{ damage: 1.5 }] });
    expect(b2.projectile!.field!.dps).toBeCloseTo(bh.projectile!.field!.dps * 1.5, 9);
    expect(b2.projectile!.field!.collapse!.damage).toBeCloseTo(bh.projectile!.field!.collapse!.damage * 1.5, 9);
    expect(b2.projectile!.field!.radius).toBe(bh.projectile!.field!.radius);
    // The base def is never mutated.
    expect(gl.projectile!.explosion!.element).toBe('physical');
  });

  it('beams scale tick and drain rates with rpm and reach with range; charge time with chargeTime', () => {
    const cl = WEAPONS.chainlightning as WeaponDef;
    const r = resolveWeapon(cl, { mods: [{ rpm: 1.2, range: 1.5 }] });
    expect(r.beam!.tickRate).toBeCloseTo(cl.beam!.tickRate * 1.2, 9);
    expect(r.beam!.ammoPerSecond).toBeCloseTo(cl.beam!.ammoPerSecond * 1.2, 9);
    expect(r.beam!.range).toBeCloseTo(cl.beam!.range * 1.5, 9);
    const rail = WEAPONS.railgun as WeaponDef;
    const t2 = resolveWeapon(rail, { tier: 2 });
    expect(t2.charge!.time).toBeCloseTo(rail.charge!.time * 0.75, 9);
  });
});
