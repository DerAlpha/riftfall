import { describe, expect, it } from 'vitest';
import { LAB, MAPS, TEST_ROOM } from '../defs/maps';
import { buildTestRoom } from '../world/TestRoom';
import { buildResearchLab } from './lab/ResearchLab';
import { DEFAULT_MAP_ID, MAP_REGISTRY, getMap, hasMap, listMaps } from './registry';

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
      expect(MAPS[key]).toBe(entry.atmosphere);
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
});
