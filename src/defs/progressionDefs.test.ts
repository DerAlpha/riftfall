import { describe, expect, it } from 'vitest';
import { ABILITY_IDS } from './abilities';
import { ACHIEVEMENTS, ACHIEVEMENT_CATEGORIES } from './achievements';
import { CHALLENGE_RULES, CHALLENGE_TEMPLATES } from './challenges';
import { CAMOS, COSMETICS, DEFAULT_COSMETICS, getCosmeticDef, isAnimatedCamo } from './cosmetics';
import { COMBOS, STATUS_ELEMENTS } from './elements';
import { ENEMIES } from './enemies';
import { GRENADE_IDS } from './grenades';
import { PERK_IDS } from './perks';
import { POWERUP_IDS } from './powerups';
import {
  LIFETIME_COUNTERS,
  METRICS,
  PROGRESSION_GLYPHS,
  WEAPON_COUNTERS,
  isGlyphId,
  isMetricId,
  type ProgressCondition,
  type SignalFilter,
} from './progression';
import { SKILL_BRANCH_IDS, SKILL_NODES, SKILL_RULES, getSkillNode } from './skills';
import { isStatId } from './stats';
import { VFX_EFFECTS } from './vfx';
import { WEAPONS, WEAPON_IDS } from './weapons';

const CATEGORIES = new Set<string>([...Object.values(WEAPONS).map((w) => w.category), 'grenade', 'ability']);
const ENEMY_IDS = new Set(Object.keys(ENEMIES));

function checkFilter(f: SignalFilter | undefined, where: string): void {
  if (!f) return;
  if (f.enemy !== undefined) expect(ENEMY_IDS.has(f.enemy), `${where}: enemy ${f.enemy}`).toBe(true);
  if (f.weapon !== undefined) expect(WEAPON_IDS as readonly string[], where).toContain(f.weapon);
  if (f.category !== undefined)
    expect(CATEGORIES.has(f.category), `${where}: category ${f.category}`).toBe(true);
  if (f.element !== undefined) expect(STATUS_ELEMENTS as readonly string[], where).toContain(f.element);
  if (f.perk !== undefined) expect(PERK_IDS as readonly string[], where).toContain(f.perk);
  if (f.powerup !== undefined) expect(POWERUP_IDS as readonly string[], where).toContain(f.powerup);
  if (f.grenade !== undefined) expect(GRENADE_IDS as readonly string[], where).toContain(f.grenade);
  if (f.ability !== undefined) expect(ABILITY_IDS as readonly string[], where).toContain(f.ability);
  if (f.combo !== undefined)
    expect(
      COMBOS.map((c) => c.id),
      where,
    ).toContain(f.combo);
}

function checkCondition(c: ProgressCondition, where: string): void {
  expect(isMetricId(c.metric), `${where}: metric ${c.metric}`).toBe(true);
  expect(c.target, where).toBeGreaterThan(0);
  const mode = METRICS[c.metric];
  if (c.kind === 'max') expect(mode, `${where}: max over a count metric`).toBe('max');
  if (c.kind === 'count') expect(mode, `${where}: count over a level metric`).toBe('add');
  if (c.kind === 'distinct' && c.values) expect(c.target, where).toBeLessThanOrEqual(c.values.length);
  checkFilter(c.filter, where);
}

describe('achievement defs', () => {
  it('has at least 60 achievements with unique ids, German text and hidden ones', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    expect(ACHIEVEMENTS.filter((a) => a.hidden).length).toBeGreaterThanOrEqual(5);
    for (const a of ACHIEVEMENTS) {
      expect(a.name.length, a.id).toBeGreaterThan(2);
      expect(a.description.length, a.id).toBeGreaterThan(5);
      expect(isGlyphId(a.icon), `${a.id}: icon ${a.icon}`).toBe(true);
      expect(ACHIEVEMENT_CATEGORIES[a.category], a.id).toBeDefined();
      checkCondition(a.condition, a.id);
    }
  });

  it('covers the spec examples: waves per map, forge tier 3, every combo, every grenade, streaks', () => {
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const id of [
      'first_blood',
      'kills_1000',
      'lab_wave_10',
      'lab_wave_20',
      'lab_wave_30',
      'perks_full',
      'forge_tier3',
      'combos_all',
      'grenades_all',
      'headshot_streak_10',
      'no_damage_wave',
      'box_wonder',
      'doors_all',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    // Progress-based ones exist (count targets > 1).
    expect(ACHIEVEMENTS.filter((a) => a.condition.target >= 100).length).toBeGreaterThan(10);
  });
});

describe('skill tree defs', () => {
  it('has >= 42 nodes, >= 14 per branch, unique ids and layout cells', () => {
    expect(SKILL_NODES.length).toBeGreaterThanOrEqual(42);
    expect(new Set(SKILL_NODES.map((n) => n.id)).size).toBe(SKILL_NODES.length);
    for (const b of SKILL_BRANCH_IDS) {
      const nodes = SKILL_NODES.filter((n) => n.branch === b);
      expect(nodes.length, b).toBeGreaterThanOrEqual(14);
      const cells = new Set(nodes.map((n) => `${n.layout.row}:${n.layout.col}`));
      expect(cells.size, `${b}: layout cells`).toBe(nodes.length);
      expect(
        nodes.some((n) => n.capstone),
        `${b}: capstone`,
      ).toBe(true);
    }
  });

  it('prerequisites exist, sit in earlier tiers of the same branch; effects are valid', () => {
    for (const n of SKILL_NODES) {
      expect(n.tier, n.id).toBeGreaterThanOrEqual(1);
      expect(n.tier, n.id).toBeLessThanOrEqual(SKILL_RULES.tierGates.length);
      expect(n.layout.row, n.id).toBe(n.tier - 1);
      expect(n.layout.col, n.id).toBeLessThan(SKILL_RULES.columns);
      expect(n.maxRank, n.id).toBeGreaterThanOrEqual(1);
      expect(n.cost, n.id).toBeGreaterThanOrEqual(1);
      expect(isGlyphId(n.icon), `${n.id}: icon`).toBe(true);
      expect(n.effects.length, n.id).toBeGreaterThan(0);
      expect(n.name.length).toBeGreaterThan(2);
      expect(n.description.length).toBeGreaterThan(5);
      if (n.tier > 1) expect(n.requires.length, `${n.id}: needs a prerequisite`).toBeGreaterThan(0);
      for (const r of n.requires) {
        const req = getSkillNode(r);
        expect(req, `${n.id} requires ${r}`).toBeDefined();
        expect(req!.branch).toBe(n.branch);
        expect(req!.tier).toBeLessThan(n.tier);
      }
      for (const e of n.effects) {
        if (e.kind === 'stat') {
          expect(isStatId(e.stat), `${n.id}: stat ${e.stat}`).toBe(true);
          expect(Number.isFinite(e.value) && e.value > 0).toBe(true);
        }
        if (e.kind === 'grenade') expect(GRENADE_IDS as readonly string[]).toContain(e.id);
        if (e.kind === 'ability') expect(ABILITY_IDS as readonly string[]).toContain(e.id);
      }
    }
    for (const g of SKILL_RULES.defaultGrenades) expect(GRENADE_IDS as readonly string[]).toContain(g);
    for (const a of SKILL_RULES.defaultAbilities) expect(ABILITY_IDS as readonly string[]).toContain(a);
  });
});

describe('challenge templates', () => {
  it('are valid and each period has enough templates to draw a full set', () => {
    expect(new Set(CHALLENGE_TEMPLATES.map((t) => t.id)).size).toBe(CHALLENGE_TEMPLATES.length);
    for (const period of ['daily', 'weekly'] as const) {
      expect(CHALLENGE_TEMPLATES.filter((t) => t.targets[period]).length).toBeGreaterThanOrEqual(
        CHALLENGE_RULES[period].count * 3,
      );
    }
    for (const t of CHALLENGE_TEMPLATES) {
      checkCondition({ ...t.condition, target: 1 } as ProgressCondition, t.id);
      expect(isGlyphId(t.icon), t.id).toBe(true);
      for (const r of Object.values(t.targets)) {
        expect(r.min, t.id).toBeGreaterThan(0);
        expect(r.max, t.id).toBeGreaterThanOrEqual(r.min);
        expect(r.step, t.id).toBeGreaterThan(0);
      }
      if (t.variants) {
        expect(t.description).toContain('{v}');
        for (const v of t.variants.values) {
          checkFilter({ [t.variants.tag]: v.id }, `${t.id}/${v.id}`);
          expect(v.scale).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('cosmetic defs', () => {
  it('have unique ids, valid unlock sources and VFX presets', () => {
    const ids = [...COSMETICS.map((c) => c.id), ...CAMOS.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const achievementIds = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const c of COSMETICS) {
      if (c.unlock.kind === 'achievement') expect(achievementIds.has(c.unlock.id), c.id).toBe(true);
      if (c.kind === 'killEffect')
        expect(Object.prototype.hasOwnProperty.call(VFX_EFFECTS, c.vfx), c.vfx).toBe(true);
      if (c.kind === 'emblem')
        expect(Object.prototype.hasOwnProperty.call(PROGRESSION_GLYPHS, c.glyph), c.id).toBe(true);
    }
    for (const slot of Object.keys(DEFAULT_COSMETICS) as (keyof typeof DEFAULT_COSMETICS)[]) {
      const id = DEFAULT_COSMETICS[slot];
      if (id !== null) expect(getCosmeticDef(id)?.unlock.kind, slot).toBe('default');
    }
    for (const kind of ['charm', 'crosshair', 'killEffect', 'emblem']) {
      expect(COSMETICS.filter((c) => c.kind === kind).length, kind).toBeGreaterThanOrEqual(4);
    }
    expect(COSMETICS.filter((c) => c.unlock.kind === 'challenge').length).toBeGreaterThanOrEqual(3);
  });

  it('camos carry shader parameters; animated endgame camos exist; references resolve', () => {
    const camoIds = new Set(CAMOS.map((c) => c.id));
    expect(CAMOS.filter(isAnimatedCamo).length).toBeGreaterThanOrEqual(4);
    for (const c of CAMOS) {
      expect(c.shader.colors).toHaveLength(3);
      for (const col of c.shader.colors) expect(col).toBeGreaterThanOrEqual(0);
      expect(c.shader.scale).toBeGreaterThan(0);
      expect(c.shader.roughness).toBeGreaterThanOrEqual(0);
      expect(c.shader.roughness).toBeLessThanOrEqual(1);
      expect(c.shader.metalness).toBeGreaterThanOrEqual(0);
      expect(c.shader.metalness).toBeLessThanOrEqual(1);
      if (isAnimatedCamo(c)) expect(c.shader.animation.speed, c.id).toBeGreaterThan(0);
      const u = c.unlock;
      if (u.kind === 'weaponCounter') expect(Object.keys(WEAPON_COUNTERS)).toContain(u.counter);
      if (u.kind === 'weaponMastery') for (const r of u.requires) expect(camoIds.has(r), r).toBe(true);
      if (u.kind === 'weaponsMastered') {
        expect(camoIds.has(u.camo)).toBe(true);
        expect(u.count).toBeLessThanOrEqual(WEAPON_IDS.length);
      }
      if (c.scope === 'weapon') {
        expect(['weaponLevel', 'weaponCounter', 'weaponMastery']).toContain(u.kind);
      } else {
        expect(['weaponsMastered', 'prestige', 'achievement']).toContain(u.kind);
      }
    }
  });
});

describe('progression vocabulary', () => {
  it('lifetime counters and weapon counters reference known metrics', () => {
    for (const [id, c] of Object.entries(LIFETIME_COUNTERS)) {
      expect(isMetricId(c.metric), id).toBe(true);
      expect(METRICS[c.metric], id).toBe('add');
    }
    for (const [id, c] of Object.entries(WEAPON_COUNTERS))
      expect(isMetricId(c.condition.metric), id).toBe(true);
  });

  it('glyphs are stroke path data', () => {
    for (const [id, d] of Object.entries(PROGRESSION_GLYPHS)) {
      expect(d, id).toMatch(/^[MLHVCSQTAZmlhvcsqtaz0-9 .,-]+$/);
      expect(d.startsWith('M'), id).toBe(true);
    }
  });
});
