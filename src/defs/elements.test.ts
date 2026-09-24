import { describe, expect, it } from 'vitest';
import {
  COMBOS,
  ELEMENTS,
  ELEMENT_MODS,
  ELEMENT_STATUS,
  STATUS_ELEMENT,
  STATUS_ELEMENTS,
  STATUS_IDS,
  STATUS_NAMES,
  STATUS_RESIST,
  elementModsFor,
  getElementMod,
  statusResistFor,
} from './elements';
import { getEffectPreset } from './vfx';
import { WEAPON_IDS, getWeaponDef } from './weapons';

describe('defs/elements', () => {
  it('every element builds a status and every status maps back to its element', () => {
    for (const el of STATUS_ELEMENTS) {
      expect(STATUS_ELEMENT[ELEMENT_STATUS[el]]).toBe(el);
      expect(ELEMENTS.buildup.threshold[el]).toBeGreaterThan(0);
    }
    expect(STATUS_ELEMENT.frozen).toBe('ice');
    for (const id of STATUS_IDS) expect(STATUS_NAMES[id].length).toBeGreaterThan(0);
  });

  it('the five combos of the spec, pairs before voidrupture', () => {
    expect(COMBOS.map((c) => c.id)).toEqual([
      'thermoshock',
      'neurotoxin',
      'toxicblaze',
      'superconductor',
      'voidrupture',
    ]);
    expect(COMBOS[COMBOS.length - 1]!.elements[1]).toBe('any');
    for (const c of COMBOS) {
      expect(c.vfx).toBe(`combo.${c.id}`);
      expect(c.damage).toBeGreaterThan(0);
      for (const st of c.consume) expect(STATUS_IDS).toContain(st);
    }
  });

  it('every status and combo VFX preset exists (package A3)', () => {
    for (const id of STATUS_IDS) expect(getEffectPreset(`status.${id}`), id).toBeDefined();
    for (const c of COMBOS) expect(getEffectPreset(c.vfx), c.id).toBeDefined();
    expect(getEffectPreset(ELEMENTS.frozen.shatter.vfx)).toBeDefined();
  });

  it('five purchasable element modules with German names, costs, colors and glyphs', () => {
    expect(ELEMENT_MODS.map((m) => m.element)).toEqual(['fire', 'ice', 'shock', 'poison', 'void']);
    for (const m of ELEMENT_MODS) {
      expect(m.id).toBe(`element.${m.element}`);
      expect(m.name.startsWith('Element-Modul: ')).toBe(true);
      expect(m.description.length).toBeGreaterThan(20);
      expect(m.cost).toBeGreaterThan(0);
      expect(m.css).toMatch(/^#[0-9a-f]{6}$/);
      expect(m.glyph.startsWith('M')).toBe(true);
      expect(m.status).toBe(ELEMENT_STATUS[m.element]);
      expect(getElementMod(m.id)).toBe(m);
      expect(getElementMod(m.element)).toBe(m);
    }
  });

  it('element modules fit every non-wonder weapon, never its own base element', () => {
    for (const id of WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      const mods = elementModsFor(def);
      if (def.category === 'wonder') expect(mods).toHaveLength(0);
      else {
        expect(mods.length).toBeGreaterThanOrEqual(4);
        expect(mods.some((m) => m.element === def.damage.element)).toBe(false);
      }
    }
  });

  it('resistances: bosses never freeze, unknown kinds use the default', () => {
    expect(statusResistFor('anything', true)).toBe(STATUS_RESIST.boss);
    expect(STATUS_RESIST.boss.freeze).toBe(false);
    expect(statusResistFor('nope')).toBe(STATUS_RESIST.default);
    expect(statusResistFor(null)).toBe(STATUS_RESIST.default);
    expect(statusResistFor('tank').control).toBeLessThan(1);
  });
});
