/**
 * Map registry: every playable map with its builder and atmosphere. The composition root picks a
 * map by id (menu, `?map=`, dev console) through getMap(), which falls back to the calibration
 * hall for unknown ids so a stale save or a typo never breaks the boot.
 *
 * M7: every new map lives in its own directory (src/maps/<id>/index.ts exports `<ID>_MAP`); a map
 * that is not built yet exports null and is not listed. Adding a map never touches this file.
 */
import type { LevelBuilder } from '../core/contracts';
import { createLogger } from '../core/log';
import { LAB, TEST_ROOM, type MapAtmosphereDef } from '../defs/maps';
import { buildTestRoom } from '../world/TestRoom';
import { ARCTIC_MAP } from './arctic';
import { BIODOME_MAP } from './biodome';
import { buildResearchLab } from './lab/ResearchLab';
import { ORBITAL_MAP } from './orbital';
import { REACTOR_MAP } from './reactor';
import { RIFT_MAP } from './rift';

const log = createLogger('maps');

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

const TEST_ROOM_ENTRY: MapEntry = {
  id: TEST_ROOM.id,
  name: 'Kalibrierhalle',
  description: 'Testgelände: Bewegung, Waffen und Zielübungen – alle Fähigkeiten freigeschaltet.',
  atmosphere: TEST_ROOM,
  build: buildTestRoom,
  recommended: false,
  movementSandbox: TEST_ROOM.movementSandbox === true,
  waves: false,
};

const LAB_ENTRY: MapEntry = {
  id: LAB.id,
  name: LAB.name,
  description:
    'Ein Riss hat die Forschungsstation verschlungen. Halte im Atrium unter der Anomalie stand – ' +
    'Welle um Welle.',
  atmosphere: LAB,
  build: buildResearchLab,
  recommended: true,
  waves: true,
};

/** The M7 maps from their own directories (null = not built yet). */
export const M7_MAP_ENTRIES: readonly (MapEntry | null)[] = [
  ARCTIC_MAP,
  BIODOME_MAP,
  REACTOR_MAP,
  ORBITAL_MAP,
  RIFT_MAP,
];

/**
 * Registry from a list of entries: null stubs are skipped, an entry whose id is taken or does not
 * match its atmosphere id is rejected with a warning (the first one wins). Pure – exported for tests.
 */
export function buildRegistry(entries: readonly (MapEntry | null | undefined)[]): Record<string, MapEntry> {
  const out: Record<string, MapEntry> = {};
  for (const e of entries) {
    if (!e) continue;
    if (Object.prototype.hasOwnProperty.call(out, e.id)) {
      log.warn(`Map "${e.id}" is registered twice – the second entry is ignored`);
      continue;
    }
    if (e.atmosphere.id !== e.id) {
      log.warn(`Map "${e.id}": atmosphere id "${e.atmosphere.id}" differs – entry ignored`);
      continue;
    }
    out[e.id] = e;
  }
  return out;
}

export const MAP_REGISTRY: Readonly<Record<string, MapEntry>> = buildRegistry([
  TEST_ROOM_ENTRY,
  LAB_ENTRY,
  ...M7_MAP_ENTRIES,
]);

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
