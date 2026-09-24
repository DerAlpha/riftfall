import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_RECIPES,
  INSTRUMENT_SLOTS,
  MUSIC,
  MUSIC_LAYERS,
  MUSIC_STINGS,
  MUSIC_THEMES,
  SCALES,
} from '../../defs/music';
import {
  HELD_SLOTS,
  LAYER_INDEX,
  NATURAL,
  bossThemeFor,
  composeTheme,
  getThemeDef,
  oddGroups,
  rangeOf,
  themeIdForMap,
} from './composer';
import { hasRecipe } from './instruments';
import { mod, scalePitchClasses } from './theory';

const THEME_IDS = Object.keys(MUSIC_THEMES);

/** Layer each slot's base pattern belongs to (percussion and fills may also sit in peak). */
const SLOT_LAYERS: Record<string, readonly string[]> = {
  drone: ['ambient'],
  pad: ['ambient'],
  choir: ['ambient'],
  swell: ['ambient'],
  scrape: ['ambient'],
  fx: ['ambient'],
  bass: ['low'],
  sub: ['low'],
  arp: ['high'],
  strings: ['high'],
  lead: ['high'],
  dist: ['peak'],
  stab: ['peak'],
  crash: ['peak'],
  openHat: ['peak'],
};

describe('music themes', () => {
  it('resolves maps to themes by id, unknown maps to the lab theme', () => {
    for (const map of ['lab', 'testroom', 'arctic', 'biodome', 'reactor', 'orbital', 'rift']) {
      expect(themeIdForMap(map)).toBe(map);
      expect(MUSIC_THEMES[themeIdForMap(map)]).toBeDefined();
    }
    expect(themeIdForMap('does-not-exist')).toBe(MUSIC.fallbackTheme);
    expect(themeIdForMap(null)).toBe(MUSIC.fallbackTheme);
    expect(getThemeDef('nope').id).toBe(MUSIC.fallbackTheme);
    expect(bossThemeFor(null)).toBe(MUSIC.bossTheme);
    expect(bossThemeFor('some-future-boss')).toBe(MUSIC.bossTheme);
  });

  it('defines every theme with valid keys, meters, progressions and implemented instruments', () => {
    for (const id of THEME_IDS) {
      const def = MUSIC_THEMES[id]!;
      expect(def.id).toBe(id);
      expect(def.key >= 36 && def.key <= 47).toBe(true);
      expect(def.tempo).toBeGreaterThan(40);
      expect(def.meter.length).toBeGreaterThan(0);
      for (const p of def.progressions)
        for (const d of p) expect(d >= 0 && d < SCALES[def.scale].length).toBe(true);
      for (const [slot, inst] of Object.entries(def.palette)) {
        expect(INSTRUMENT_SLOTS).toContain(slot);
        expect(INSTRUMENT_RECIPES[inst!.recipe]).toBeDefined();
        expect(hasRecipe(inst!.recipe)).toBe(true);
        expect(inst!.gain).toBeGreaterThan(0);
      }
    }
    // Every sting only names instrument slots.
    for (const sting of Object.values(MUSIC_STINGS))
      for (const n of sting.notes) expect(INSTRUMENT_SLOTS).toContain(n.slot);
  });

  it('composes deterministically: same theme → same music, other themes → other music', () => {
    for (const id of THEME_IDS) {
      const a = composeTheme(id, false);
      const b = composeTheme(id, false);
      expect(JSON.stringify(a.phrases)).toBe(JSON.stringify(b.phrases));
    }
    const lead = (id: string) =>
      composeTheme(id).phrases[0]!.bars.flatMap((b) =>
        b.events.filter((e) => e.slot === 'lead').map((e) => e.note),
      );
    expect(lead('lab')).not.toEqual(lead('menu'));
    expect(lead('lab').length).toBeGreaterThan(8);
  });

  it('keeps every pitched note in key and in its register', () => {
    for (const id of THEME_IDS) {
      const t = composeTheme(id);
      const pcs = scalePitchClasses(t.def.key, SCALES[t.def.scale]);
      for (const phrase of t.phrases) {
        for (const bar of phrase.bars) {
          for (const e of bar.events) {
            const inst = t.def.palette[e.slot];
            const pitched = inst ? INSTRUMENT_RECIPES[inst.recipe].pitched : e.note !== NATURAL;
            if (!pitched || !Object.prototype.hasOwnProperty.call(MUSIC.ranges, e.slot)) continue;
            expect(pcs).toContain(mod(e.note, 12));
            const [lo, hi] = rangeOf(e.slot);
            // Octave jumps of the bass / dist lines may reach a little past the register.
            expect(e.note).toBeGreaterThanOrEqual(lo - 7);
            expect(e.note).toBeLessThanOrEqual(hi + 12);
          }
        }
      }
    }
  });

  it('lays bars out by the meter (the rift shifts 7/8 5/8 7/8 9/8) with sorted, valid events', () => {
    const rift = composeTheme('rift');
    expect(rift.phrases[0]!.bars.map((b) => b.steps)).toEqual([14, 10, 14, 18, 14, 10, 14, 18]);
    expect(oddGroups(14)).toEqual([4, 4, 6]);
    expect(oddGroups(10)).toEqual([4, 6]);
    expect(oddGroups(18)).toEqual([4, 4, 4, 6]);
    for (const id of THEME_IDS) {
      const t = composeTheme(id);
      expect(t.order.length).toBeGreaterThan(0);
      for (const phrase of t.phrases) {
        expect(phrase.bars).toHaveLength(t.def.phraseBars);
        for (const bar of phrase.bars) {
          let last = -1;
          for (const e of bar.events) {
            expect(e.step).toBeGreaterThanOrEqual(last);
            expect(e.step).toBeLessThan(bar.steps);
            expect(e.dur).toBeGreaterThan(0);
            expect(e.tier >= 0 && e.tier <= 1).toBe(true);
            expect(e.vel > 0 && e.vel <= 1).toBe(true);
            const allowed = SLOT_LAYERS[e.slot];
            if (allowed && e.slot !== 'openHat') expect(allowed).toContain(MUSIC_LAYERS[e.layer]);
            last = e.step;
          }
        }
      }
    }
  });

  it('builds layers that grow with intensity: calm = drone and pads, peak = fills and distortion', () => {
    const lab = composeTheme('lab');
    const events = lab.phrases[0]!.bars.flatMap((b) => b.events);
    const calm = events.filter((e) => e.tier <= 0.3);
    expect(calm.some((e) => e.slot === 'drone')).toBe(true);
    expect(calm.some((e) => e.slot === 'pad')).toBe(true);
    expect(events.filter((e) => e.layer === LAYER_INDEX.peak).every((e) => e.tier >= 0.75)).toBe(true);
    expect(events.some((e) => e.slot === 'dist')).toBe(true);
    // Dense hats and arp fills only at high intensity.
    const hats = events.filter((e) => e.slot === 'hat');
    expect(hats.some((e) => e.tier >= 0.55)).toBe(true);
    expect(events.some((e) => e.slot === 'lead' && e.tier === lab.def.leadTier)).toBe(true);
  });

  it('re-strikes sustained chords from holds when a layer comes in mid-chord', () => {
    const lab = composeTheme('lab');
    const bar1 = lab.phrases[0]!.bars[1]!;
    const heldSlots = new Set(bar1.holds.map((h) => h.event.slot));
    expect(heldSlots.has('pad')).toBe(true);
    for (const h of bar1.holds) {
      expect(HELD_SLOTS.has(h.event.slot)).toBe(true);
      expect(h.elapsed).toBeGreaterThan(0);
      expect(h.elapsed).toBeLessThan(h.event.dur);
    }
  });
});
