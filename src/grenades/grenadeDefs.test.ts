import { describe, expect, it } from 'vitest';
import { ABILITIES, ABILITY_GLYPHS, ABILITY_IDS } from '../defs/abilities';
import { FIELD_VISUALS, PROJECTILE_VISUALS, TRAIL_STYLES } from '../defs/arsenalVfx';
import { GRENADE_GLYPHS, GRENADE_IDS, GRENADES, getGrenadeDef, grenadeByWeaponId } from '../defs/grenades';
import { STAT_DEFS } from '../defs/stats';
import { getEffectPreset } from '../defs/vfx';

describe('grenade defs', () => {
  it('four types with glyphs, unique weapon ids and max ≥ 1', () => {
    expect(GRENADE_IDS).toEqual(['frag', 'brand', 'kryo', 'singularity']);
    const ids = new Set<string>();
    for (const id of GRENADE_IDS) {
      const d = GRENADES[id];
      expect(d.id).toBe(id);
      expect(GRENADE_GLYPHS[d.icon]).toBeTruthy();
      expect(d.weaponId).toBe(`grenade.${id}`);
      expect(ids.has(d.weaponId)).toBe(false);
      ids.add(d.weaponId);
      expect(d.max).toBeGreaterThanOrEqual(1);
      expect(grenadeByWeaponId(d.weaponId)).toBe(d);
      expect(getGrenadeDef(id)).toBe(d);
    }
    expect(getGrenadeDef('toString')).toBeUndefined();
    expect(grenadeByWeaponId('pistol')).toBeUndefined();
  });

  it('frag / brand / kryo / singularity do what their names say', () => {
    expect(GRENADES.frag.projectile.explosion.element).toBe('physical');
    expect(GRENADES.frag.projectile.fuse).toBeGreaterThan(0);
    expect(GRENADES.frag.projectile.bounces).toBeGreaterThan(0);
    expect(GRENADES.brand.projectile.field.kind).toBe('damage');
    expect(GRENADES.brand.projectile.field.element).toBe('fire');
    expect(GRENADES.kryo.projectile.explosion.element).toBe('ice');
    expect(GRENADES.kryo.projectile.field.kind).toBe('slow');
    expect(GRENADES.kryo.detonationStatus.element).toBe('ice');
    expect(GRENADES.singularity.projectile.field.kind).toBe('pull');
    expect(GRENADES.singularity.projectile.field.collapse).not.toBeNull();
  });

  it('reference arsenal visuals, trails and explosion presets that exist', () => {
    for (const id of GRENADE_IDS) {
      const p = GRENADES[id].projectile;
      expect(Object.hasOwn(PROJECTILE_VISUALS, p.visual)).toBe(true);
      if (p.trail) expect(Object.hasOwn(TRAIL_STYLES, p.trail)).toBe(true);
      if (p.explosion) expect(getEffectPreset(p.explosion.vfx)).toBeDefined();
      if (p.field) {
        expect(Object.hasOwn(FIELD_VISUALS, p.field.vfx)).toBe(true);
        if (p.field.collapse) expect(getEffectPreset(p.field.collapse.vfx)).toBeDefined();
      }
    }
  });
});

describe('ability defs (data)', () => {
  it('glyphs exist, blast presets exist, modifiers name real stats', () => {
    for (const id of ABILITY_IDS) {
      const d = ABILITIES[id];
      expect(ABILITY_GLYPHS[d.icon]).toBeTruthy();
      if (d.blast) expect(getEffectPreset(d.blast.explosion.vfx)).toBeDefined();
      for (const m of d.modifiers) expect(Object.hasOwn(STAT_DEFS, m.stat)).toBe(true);
    }
  });
});
