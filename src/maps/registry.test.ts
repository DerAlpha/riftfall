import { describe, expect, it } from 'vitest';
import { LAB, MAPS, TEST_ROOM } from '../defs/maps';
import { buildTestRoom } from '../world/TestRoom';
import { buildResearchLab } from './lab/ResearchLab';
import { getAssetEntry } from '../assets/manifest';
import {
  DEFAULT_MAP_ID,
  M7_MAP_ENTRIES,
  MAP_REGISTRY,
  buildRegistry,
  getMap,
  hasMap,
  listMaps,
  type MapEntry,
} from './registry';
import { ARCTIC_ID } from './arctic';
import { BIODOME_ID } from './biodome';
import { ORBITAL_ID } from './orbital';
import { REACTOR_ID } from './reactor';
import { RIFT_ID } from './rift';

describe('map registry', () => {
  it('registers the calibration hall and the research lab with their builders and atmospheres', () => {
    const hall = MAP_REGISTRY.testroom!;
    expect(hall.build).toBe(buildTestRoom);
    expect(hall.atmosphere).toBe(TEST_ROOM);
    expect(hall.movementSandbox).toBe(true);
    expect(hall.waves).toBe(false);
    const lab = MAP_REGISTRY.lab!;
    expect(lab.build).toBe(buildResearchLab);
    expect(lab.atmosphere).toBe(LAB);
    expect(lab.recommended).toBe(true);
    expect(lab.waves).toBe(true);
    expect(lab.movementSandbox).toBeUndefined();
  });

  it('keeps ids, atmospheres and the MAPS table consistent', () => {
    for (const [key, entry] of Object.entries(MAP_REGISTRY)) {
      expect(entry.id).toBe(key);
      expect(entry.atmosphere.id).toBe(key);
      // M1–M4 maps keep their atmosphere in defs/maps.ts; M7 maps bring theirs in their directory.
      if (MAPS[key]) expect(MAPS[key]).toBe(entry.atmosphere);
      for (const id of entry.atmosphere.preload) expect(getAssetEntry(id), `${key}: ${id}`).toBeDefined();
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.build).toBe('function');
    }
    expect(hasMap(DEFAULT_MAP_ID)).toBe(true);
  });

  it('falls back to the calibration hall for unknown, empty or missing ids', () => {
    expect(getMap('lab').id).toBe('lab');
    for (const id of ['nope', '', null, undefined, 'LAB', 'toString', '__proto__', 'constructor']) {
      expect(hasMap(id)).toBe(false);
      expect(getMap(id).id).toBe(DEFAULT_MAP_ID);
    }
  });

  it('lists recommended maps first', () => {
    const list = listMaps();
    expect(list.length).toBe(Object.keys(MAP_REGISTRY).length);
    expect(list[0]!.recommended).toBe(true);
    const firstPlain = list.findIndex((m) => !m.recommended);
    if (firstPlain >= 0) expect(list.slice(firstPlain).every((m) => !m.recommended)).toBe(true);
  });

  it('lists the M7 maps from their directories only once built (null stubs are skipped)', () => {
    const ids = [ARCTIC_ID, BIODOME_ID, REACTOR_ID, ORBITAL_ID, RIFT_ID];
    expect(ids).toEqual(['arctic', 'biodome', 'reactor', 'orbital', 'rift']);
    expect(M7_MAP_ENTRIES.length).toBe(5);
    M7_MAP_ENTRIES.forEach((entry, i) => {
      expect(hasMap(ids[i])).toBe(entry !== null);
      if (entry) expect(entry.id).toBe(ids[i]);
    });
    const listed = listMaps().map((m) => m.id);
    for (const [i, entry] of M7_MAP_ENTRIES.entries()) {
      expect(listed.includes(ids[i]!)).toBe(entry !== null);
    }
  });

  it('builds a registry from entries: nulls skipped, duplicates and id mismatches rejected', () => {
    const lab = MAP_REGISTRY.lab!;
    const fake: MapEntry = { ...lab, id: 'arctic', name: 'Arktis-Station', recommended: false };
    const mismatched: MapEntry = { ...lab, id: 'reactor' };
    const reg = buildRegistry([lab, null, undefined, fake, { ...lab, name: 'Kopie' }, mismatched]);
    expect(Object.keys(reg)).toEqual(['lab']);
    const withArctic = buildRegistry([lab, { ...fake, atmosphere: { ...lab.atmosphere, id: 'arctic' } }]);
    expect(Object.keys(withArctic).sort()).toEqual(['arctic', 'lab']);
    expect(withArctic.lab!.name).toBe(lab.name);
  });
});
