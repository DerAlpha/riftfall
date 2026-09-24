import { describe, expect, it } from 'vitest';
import { getMaterialDef } from './materials';
import { COMBAT } from './combat';
import { ACTIONS, DEFAULT_BINDINGS } from './input';
import {
  IMPLEMENTED_WEAPON_KINDS,
  WEAPON_IDS,
  WEAPON_RULES,
  WEAPONS,
  getLoadout,
  getWeaponDef,
  isWeaponId,
  type WeaponDef,
} from './weapons';

const defs: WeaponDef[] = WEAPON_IDS.map((id) => WEAPONS[id]);

describe('weapon defs', () => {
  it('fixed ids (the whole roster, unique), keys match ids, model ids equal weapon ids', () => {
    expect(WEAPON_IDS.slice(0, 1)).toEqual(['pistol']);
    for (const id of ['pistol', 'rifle', 'shotgun']) expect(WEAPON_IDS).toContain(id);
    expect(new Set(WEAPON_IDS).size).toBe(WEAPON_IDS.length);
    expect([...WEAPON_IDS].sort()).toEqual(Object.keys(WEAPONS).sort());
    for (const [key, def] of Object.entries(WEAPONS)) {
      expect(def.id).toBe(key);
      expect(def.model).toBe(key);
    }
    expect(getWeaponDef('rifle')).toBe(WEAPONS.rifle);
    expect(getWeaponDef('toString')).toBeUndefined();
    expect(isWeaponId('nope')).toBe(false);
  });

  it('every def is sane (positive timings, sorted reload markers inside the reload, valid pattern)', () => {
    for (const d of defs) {
      expect(d.rpm, d.id).toBeGreaterThan(0);
      expect(d.magazine).toBeGreaterThan(0);
      expect(d.reserve).toBeGreaterThanOrEqual(0);
      expect(d.pellets).toBeGreaterThanOrEqual(1);
      expect(d.range).toBeGreaterThan(d.damage.falloffEnd);
      expect(d.damage.falloffEnd).toBeGreaterThan(d.damage.falloffStart);
      expect(d.damage.minFalloffMultiplier).toBeGreaterThan(0);
      expect(d.damage.minFalloffMultiplier).toBeLessThanOrEqual(1);
      expect(d.equipTime).toBeGreaterThan(0);
      expect(d.holsterTime).toBeGreaterThan(0);
      expect(d.ads.zoom).toBeGreaterThan(0.3);
      expect(d.ads.zoom).toBeLessThanOrEqual(1);
      expect(d.spread.ads).toBeLessThanOrEqual(d.spread.hip);
      expect(d.spread.recoveryDelay).toBeGreaterThanOrEqual(0);
      expect(d.spread.bloomMax).toBeGreaterThanOrEqual(d.spread.perShotBloom);
      // Full auto must accumulate bloom: it may only start recovering after the next shot.
      if (d.fireMode === 'auto') expect(d.spread.recoveryDelay).toBeGreaterThan(60 / d.rpm);
      expect(d.recoil.pattern.length).toBeGreaterThan(0);
      expect(d.recoil.patternRepeatFrom).toBeGreaterThanOrEqual(0);
      expect(d.recoil.patternRepeatFrom).toBeLessThan(d.recoil.pattern.length);
      expect(d.recoil.kickTime).toBeGreaterThan(0);
      // Recovery must be able to undo a full-auto burst within a second or two.
      expect(d.recoil.recoveryPerSec).toBeGreaterThan(0);
      expect(d.melee.hitTime).toBeLessThan(d.melee.duration);
      expect(d.name.length).toBeGreaterThan(3);
      expect(d.description.length).toBeGreaterThan(10);
      if (d.reload.perShell) {
        const ps = d.reload.perShell;
        expect(ps.insertAt).toBeLessThan(ps.shell);
        expect(ps.pumpAt).toBeLessThan(ps.emptyEnd);
      } else {
        for (const [steps, total] of [
          [d.reload.tacticalSteps, d.reload.tactical],
          [d.reload.emptySteps, d.reload.empty],
        ] as const) {
          expect(steps.some((s) => s.step === 'magIn')).toBe(true);
          for (let i = 0; i < steps.length; i++) {
            expect(steps[i]!.at).toBeLessThan(total);
            if (i > 0) expect(steps[i]!.at).toBeGreaterThan(steps[i - 1]!.at);
          }
        }
        expect(d.reload.empty).toBeGreaterThan(d.reload.tactical);
      }
    }
  });

  it('M2 feel targets', () => {
    expect(WEAPONS.pistol.fireMode).toBe('semi');
    expect(WEAPONS.pistol.damage.base).toBe(45);
    expect(WEAPONS.rifle.fireMode).toBe('auto');
    expect(WEAPONS.rifle.rpm).toBe(650);
    expect(WEAPONS.rifle.damage.base).toBe(28);
    expect(WEAPONS.shotgun.fireMode).toBe('pump');
    expect(WEAPONS.shotgun.pellets).toBe(9);
    // M5 retune (was 14): the pump kept pace with the arsenal's shotguns.
    expect(WEAPONS.shotgun.damage.base).toBe(17);
    expect(Math.abs(WEAPONS.shotgun.rpm - 70)).toBeLessThanOrEqual(5);
    // The pistol is the most precise hip weapon, the shotgun kicks hardest.
    expect(WEAPONS.pistol.spread.hip).toBeLessThan(WEAPONS.rifle.spread.hip);
    expect(WEAPONS.shotgun.recoil.shake).toBeGreaterThan(WEAPONS.pistol.recoil.shake);
    expect(WEAPONS.shotgun.recoil.pattern[0]![1]).toBeGreaterThan(WEAPONS.pistol.recoil.pattern[0]![1]);
  });

  it('the M2 weapons fire with an implemented kind; other kinds carry their kind data', () => {
    for (const id of ['pistol', 'rifle', 'shotgun'] as const)
      expect(IMPLEMENTED_WEAPON_KINDS).toContain(WEAPONS[id].kind);
    const defsOfKind = (k: WeaponDef['kind']): WeaponDef[] => defs.filter((d) => d.kind === k);
    for (const d of defsOfKind('projectile')) expect(d.projectile, d.id).toBeTruthy();
    for (const d of defsOfKind('beam')) expect(d.beam, d.id).toBeTruthy();
    for (const d of defsOfKind('charge')) expect(d.charge, d.id).toBeTruthy();
  });

  it('every inventory slot has its own bound selection action', () => {
    const slotActions = WEAPON_RULES.inventory.slotActions;
    expect(slotActions.length).toBeGreaterThanOrEqual(WEAPON_RULES.inventory.maxSlots);
    for (const a of slotActions) {
      expect(ACTIONS).toContain(a);
      expect(DEFAULT_BINDINGS[a].length, a).toBeGreaterThan(0);
    }
    expect(new Set(slotActions).size).toBe(slotActions.length);
  });

  it('loadouts reference existing weapons and fit their slots', () => {
    expect(getLoadout('testroom').slots).toBe(3);
    expect(getLoadout('testroom').weapons).toEqual(['pistol', 'rifle', 'shotgun']);
    expect(getLoadout('unknown-map')).toBe(WEAPON_RULES.loadouts.default);
    for (const l of Object.values(WEAPON_RULES.loadouts)) {
      expect(l.weapons.length).toBeLessThanOrEqual(l.slots);
      expect(l.slots).toBeLessThanOrEqual(WEAPON_RULES.inventory.maxSlots);
      for (const id of l.weapons) expect(isWeaponId(id)).toBe(true);
    }
  });
});

describe('combat defs / penetrable materials', () => {
  it('thin materials are penetrable, structural ones are not', () => {
    expect(getMaterialDef('glass')?.penetrable).toBe(true);
    expect(getMaterialDef('floor_grate')?.penetrable).toBe(true);
    expect(getMaterialDef('crate')?.penetrable).toBe(true);
    expect(getMaterialDef('concrete_wall')?.penetrable).toBeFalsy();
    expect(getMaterialDef('wall_panel')?.penetrable).toBeFalsy();
  });

  it('penetration costs: glass is cheap, shields never pass', () => {
    expect(COMBAT.penetrationCost.glass).toBeLessThan(COMBAT.penetrationCost.metal);
    for (const d of defs) expect(d.penetration.power).toBeLessThan(COMBAT.penetrationCost.shield);
    // Shotgun pellets pass glass and grates but not bodies.
    expect(WEAPONS.shotgun.penetration.power).toBeGreaterThanOrEqual(COMBAT.penetrationCost.grate);
    expect(WEAPONS.shotgun.penetration.power).toBeLessThan(COMBAT.penetrationCost.flesh);
  });
});
