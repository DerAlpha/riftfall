/**
 * Map registry: every playable map with its builder and atmosphere. The composition root picks a
 * map by id (menu, `?map=`, dev console) through getMap(), which falls back to the calibration
 * hall for unknown ids so a stale save or a typo never breaks the boot.
 */
import type { LevelBuilder } from '../core/contracts';
import { LAB, TEST_ROOM, type MapAtmosphereDef } from '../defs/maps';
import { buildTestRoom } from '../world/TestRoom';
import { buildResearchLab } from './lab/ResearchLab';

export interface MapEntry {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
  /** Player-facing (German) one-liner for the map selection. */
  readonly description: string;
  readonly atmosphere: MapAtmosphereDef;
  readonly build: LevelBuilder;
  /** Shown first / highlighted in the map selection. */
  readonly recommended: boolean;
  /** Every movement ability unlocked regardless of the profile (the calibration hall). */
  readonly movementSandbox?: boolean;
  /** Wave map with enemy spawn points (the calibration hall only has a few for testing). */
  readonly waves: boolean;
}

export const DEFAULT_MAP_ID = TEST_ROOM.id;

export const MAP_REGISTRY: Readonly<Record<string, MapEntry>> = {
  [TEST_ROOM.id]: {
    id: TEST_ROOM.id,
    name: 'Kalibrierhalle',
    description: 'Testgelände: Bewegung, Waffen und Zielübungen – alle Fähigkeiten freigeschaltet.',
    atmosphere: TEST_ROOM,
    build: buildTestRoom,
    recommended: false,
    movementSandbox: TEST_ROOM.movementSandbox === true,
    waves: false,
  },
  [LAB.id]: {
    id: LAB.id,
    name: LAB.name,
    description:
      'Ein Riss hat die Forschungsstation verschlungen. Halte im Atrium unter der Anomalie stand – ' +
      'Welle um Welle.',
    atmosphere: LAB,
    build: buildResearchLab,
    recommended: true,
    waves: true,
  },
};

export function hasMap(id: string | null | undefined): boolean {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAP_REGISTRY, id);
}

/** Map by id; unknown / missing ids fall back to the calibration hall. */
export function getMap(id: string | null | undefined): MapEntry {
  return hasMap(id) ? MAP_REGISTRY[id as string]! : MAP_REGISTRY[DEFAULT_MAP_ID]!;
}

/** Maps in menu order (recommended first, then by name). */
export function listMaps(): MapEntry[] {
  return Object.values(MAP_REGISTRY).sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name, 'de'),
  );
}
