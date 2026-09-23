import { describe, expect, it } from 'vitest';
import type { FleshSurface, ImpactKind, SurfaceType } from '../core/events';
import { POSTFX } from '../defs/postfx';
import {
  CASINGS,
  DECAL_CELLS,
  DECAL_KINDS,
  ELEMENT_TINTS,
  EXPLOSION_PRESET,
  IMPACT_PROFILE_BY_KIND,
  IMPACT_USES_WEAPON_PROFILE,
  SPRITES,
  SURFACE_IMPACTS,
  VFX,
  VFX_EFFECTS,
  getCasingDef,
  getEffectPreset,
  getImpactProfile,
  type EffectPreset,
} from '../defs/vfx';
import { VIEWMODELS, type PartMotionDef } from '../defs/viewmodels';
import { WEAPON_IDS, getWeaponDef } from '../defs/weapons';

const luminance = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const presets = Object.entries(VFX_EFFECTS) as [string, EffectPreset][];

describe('VFX defs', () => {
  it('every weapon references existing muzzle / impact / casing presets', () => {
    for (const id of WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      const muzzle = getEffectPreset(def.vfx.muzzle);
      expect(muzzle, `${id} muzzle`).toBeDefined();
      expect(muzzle!.flash, `${id} flash`).toBeDefined();
      expect(muzzle!.light, `${id} light`).toBeDefined();
      expect(getImpactProfile(def.vfx.impact), `${id} impact`).toBeDefined();
      if (def.vfx.casing) expect(getCasingDef(def.vfx.casing), `${id} casing`).toBeDefined();
    }
  });

  it('every surface maps to an existing effect and decal kind', () => {
    const surfaces: (SurfaceType | FleshSurface)[] = [
      'metal',
      'concrete',
      'grate',
      'rubber',
      'glass',
      'default',
      'flesh',
      'slime',
      'armor',
      'shield',
    ];
    for (const s of surfaces) {
      const e = SURFACE_IMPACTS[s];
      expect(getEffectPreset(e.effect), s).toBeDefined();
      if (e.decal) expect(DECAL_CELLS, s).toContain(e.decal);
      if (e.splatter) expect(DECAL_CELLS, s).toContain(e.splatter.decal);
    }
    const kinds: ImpactKind[] = ['bullet', 'pellet', 'projectile', 'melee', 'explosion', 'beam'];
    for (const k of kinds) {
      const p = IMPACT_PROFILE_BY_KIND[k];
      if (p) expect(getImpactProfile(p), k).toBeDefined();
    }
  });

  it('emitters use valid sprites and sane ranges', () => {
    for (const [id, p] of presets) {
      for (const e of p.emitters) {
        expect(SPRITES, id).toContain(e.sprite);
        for (const r of [e.count, e.life, e.speed, e.size]) expect(r[0], id).toBeLessThanOrEqual(r[1]);
        expect(e.life[0], id).toBeGreaterThan(0);
        expect(e.spread, id).toBeGreaterThanOrEqual(0);
        expect(e.spread, id).toBeLessThanOrEqual(180);
        if (e.bounce !== undefined) expect(e.bounce, id).toBeLessThanOrEqual(1);
      }
    }
  });

  it('sparks, flashes and fire are HDR enough to bloom', () => {
    const threshold = POSTFX.bloom.luminanceThreshold + POSTFX.bloom.luminanceSmoothing;
    for (const [id, p] of presets) {
      for (const e of p.emitters) {
        if (e.blend !== 'add' || !['spark', 'streak', 'flash', 'star', 'flame', 'glow'].includes(e.sprite))
          continue;
        expect(luminance(e.color) * (e.intensity ?? 1), `${id}:${e.sprite}`).toBeGreaterThan(threshold);
      }
      if (p.flash) expect(luminance(p.flash.color) * p.flash.intensity, id).toBeGreaterThan(threshold);
    }
    expect(VFX.tracers.intensity).toBeGreaterThan(threshold);
  });

  it('muzzle flashes are short and lights decay in about 50 ms', () => {
    for (const [id, p] of presets) {
      if (!id.startsWith('muzzle.')) continue;
      expect(p.flash!.duration, id).toBeLessThanOrEqual(0.06);
      expect(p.light!.duration, id).toBeLessThanOrEqual(0.08);
    }
    expect(VFX.tracers.minTravel).toBeGreaterThan(0);
    expect(VFX.tracers.maxTravel).toBeLessThanOrEqual(0.08);
  });

  it('explosions are complete: reference radius, light, shake, shockwave, scorch', () => {
    for (const el of Object.keys(ELEMENT_TINTS) as (keyof typeof ELEMENT_TINTS)[]) {
      const p = getEffectPreset(EXPLOSION_PRESET[el])!;
      expect(p, el).toBeDefined();
      expect(p.referenceRadius, el).toBeGreaterThan(0);
      expect(p.light?.priority, el).toBe(2);
      expect(p.shake, el).toBeDefined();
      expect(p.shockwave, el).toBeDefined();
      expect(DECAL_CELLS).toContain(p.groundDecal!.kind);
    }
  });

  it('decal kinds and casings are well-formed', () => {
    for (const kind of DECAL_CELLS) {
      const d = DECAL_KINDS[kind];
      expect(d.size[0], kind).toBeGreaterThan(0);
      expect(d.size[0], kind).toBeLessThanOrEqual(d.size[1]);
    }
    for (const [id, c] of Object.entries(CASINGS)) {
      expect(c.length, id).toBeGreaterThan(c.radius);
      expect(c.ejectDelay, id).toBeGreaterThanOrEqual(0);
      expect(c.bounce, id).toBeLessThan(1);
    }
    expect(VFX.lights.count).toBeGreaterThan(0);
  });

  it('casings leave the port when the slide / bolt / pump stroke hits its rear stop', () => {
    const actions = { pistol: 'slide', rifle: 'bolt', shotgun: 'pump' } as const;
    for (const [weaponId, part] of Object.entries(actions) as [keyof typeof actions, string][]) {
      const casing = getCasingDef(getWeaponDef(weaponId)!.vfx.casing!)!;
      const fire: readonly PartMotionDef[] = VIEWMODELS[weaponId].fire;
      const stroke = fire.find((m) => m.part === part)!;
      expect(stroke, weaponId).toBeDefined();
      expect(casing.ejectDelay, weaponId).toBeCloseTo((stroke.delay ?? 0) + stroke.duration, 3);
    }
  });

  it('only shot kinds use the weapon impact profile', () => {
    expect(IMPACT_USES_WEAPON_PROFILE.bullet).toBe(true);
    expect(IMPACT_USES_WEAPON_PROFILE.pellet).toBe(true);
    expect(IMPACT_USES_WEAPON_PROFILE.melee).toBe(false);
    expect(IMPACT_USES_WEAPON_PROFILE.explosion).toBe(false);
  });
});
