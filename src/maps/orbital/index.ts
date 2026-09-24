/**
 * "Orbitalplattform" (M7 map, id `orbital`) – orbitale Plattform mit Zonen niedriger Schwerkraft (gravityZones).
 *
 * NOT BUILT YET: `ORBITAL_MAP` stays null until the map's builder lands – the registry lists only
 * non-null entries, so the map is not selectable. The map engineer owns this directory: replace the
 * null with the MapEntry (id `orbital`, German name / description, atmosphere, builder) and keep every
 * file of the map in here. Read src/maps/kit/README.md first.
 */
import type { MapEntry } from '../registry';

/** Map id: music theme (defs/music mapThemes), loadout, leaderboards and achievements key on it. */
export const ORBITAL_ID = 'orbital';

export const ORBITAL_MAP: MapEntry | null = null;
