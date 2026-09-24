/**
 * Level-provided placements (M7): every resolver PREFERS the level's own data (MapLevelInstance
 * M7 fields, duck-typed – the calibration hall is no wave map but may carry them too) and falls
 * back to the per-map-id tables in src/defs, so the lab and the calibration hall keep working
 * unchanged while a new map ships everything in its own directory. Pure – tested in
 * levelData.test.ts.
 *
 * `undefined` on the level = "not provided" (table fallback); `null` / [] = "provided: none".
 */
import type { LevelInstance } from '../../core/contracts';
import {
  MYSTERY_BOX,
  PERK_MACHINES,
  ZONES,
  type BoxLocationDef,
  type PerkMachinePlacementDef,
} from '../../defs/interactables';
import {
  BOSS_ARENAS,
  GENERATORS,
  MAP_EVENT_DEFS,
  type GeneratorSpotDef,
  type GravityZoneDef,
  type MapEventDef,
} from '../../defs/mapEvents';
import { QUESTS, type QuestDef } from '../../defs/quests';
import { TRAP_SLOTS, type TrapSlotDef } from '../../defs/traps';
import { RIFT_FORGE_MACHINE, WORKBENCH, type WorkshopPlacementDef } from '../../defs/workshop';
import type { BossArenaDef, MapLevelInstance } from '../types';

/** The M7 fields of any level (absent on levels that predate the kit). */
type KitFields = Partial<MapLevelInstance>;

function kit(level: LevelInstance): KitFields {
  return level as KitFields;
}

function own<T>(table: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
}

/** Map id of the per-map tables: the level id unless the caller names another. */
function idOf(level: LevelInstance, mapId?: string): string {
  return mapId ?? level.id;
}

export function resolveStartZones(level: LevelInstance, mapId?: string): readonly string[] {
  return kit(level).startZones ?? own(ZONES.startZones, idOf(level, mapId)) ?? [];
}

export function resolvePerkSpots(level: LevelInstance, mapId?: string): readonly PerkMachinePlacementDef[] {
  return kit(level).perkSpots ?? own(PERK_MACHINES.placements, idOf(level, mapId)) ?? [];
}

export function resolveBoxLocations(level: LevelInstance, mapId?: string): readonly BoxLocationDef[] {
  return kit(level).boxLocations ?? own(MYSTERY_BOX.locations, idOf(level, mapId)) ?? [];
}

/** Start candidates of the box: the level's ids go with the level's locations. */
export function resolveBoxStartIds(level: LevelInstance, mapId?: string): readonly string[] {
  const k = kit(level);
  if (k.boxStartIds) return k.boxStartIds;
  // Level locations without start ids: any of them (the table's ids name other locations).
  if (k.boxLocations) return [];
  return own(MYSTERY_BOX.start, idOf(level, mapId)) ?? [];
}

export function resolveForgePlacement(level: LevelInstance, mapId?: string): WorkshopPlacementDef | null {
  const k = kit(level).forgePlacement;
  if (k !== undefined) return k;
  return own(RIFT_FORGE_MACHINE.placements, idOf(level, mapId))?.[0] ?? null;
}

export function resolveBenchPlacement(level: LevelInstance, mapId?: string): WorkshopPlacementDef | null {
  const k = kit(level).benchPlacement;
  if (k !== undefined) return k;
  return own(WORKBENCH.placements, idOf(level, mapId))?.[0] ?? null;
}

export function resolveTrapSlots(level: LevelInstance, mapId?: string): readonly TrapSlotDef[] {
  return kit(level).trapSlots ?? own(TRAP_SLOTS, idOf(level, mapId)) ?? [];
}

export function resolveEventDefs(level: LevelInstance, mapId?: string): readonly MapEventDef[] {
  return kit(level).eventDefs ?? own(MAP_EVENT_DEFS, idOf(level, mapId)) ?? [];
}

export function resolveGenerators(level: LevelInstance, mapId?: string): readonly GeneratorSpotDef[] {
  return kit(level).generators ?? own(GENERATORS, idOf(level, mapId)) ?? [];
}

export function resolveGravityZones(level: LevelInstance): readonly GravityZoneDef[] {
  return kit(level).gravityZones ?? [];
}

export function resolveQuestDef(level: LevelInstance, mapId?: string): QuestDef | null {
  const k = kit(level).questDef;
  if (k !== undefined) return k;
  return own(QUESTS, idOf(level, mapId)) ?? null;
}

/**
 * M6 boss arena: the level's, the table's, or – on a wave map – the centroid of the first start
 * zone's spawn points (radius: their spread). Null when nothing is known.
 */
export function resolveBossArena(level: LevelInstance, mapId?: string): BossArenaDef | null {
  const k = kit(level).bossArena;
  if (k !== undefined) return k;
  const t = own(BOSS_ARENAS, idOf(level, mapId));
  if (t) return { center: { x: t.center[0], y: t.center[1], z: t.center[2] }, radius: t.radius, zone: t.zone };
  const points = level.spawnPoints ?? [];
  if (points.length === 0) return null;
  const zone = resolveStartZones(level, mapId)[0] ?? points[0]!.zone;
  const inZone = points.filter((p) => p.zone === zone);
  const list = inZone.length > 0 ? inZone : points;
  let x = 0;
  let z = 0;
  let y = Number.POSITIVE_INFINITY;
  for (const p of list) {
    x += p.position.x;
    z += p.position.z;
    y = Math.min(y, p.position.y);
  }
  x /= list.length;
  z /= list.length;
  let r = 0;
  for (const p of list) r = Math.max(r, Math.hypot(p.position.x - x, p.position.z - z));
  return { center: { x, y, z }, radius: r, zone };
}

/** Music theme id (defs/music mapThemes): the level's or the map id. */
export function resolveMusicTheme(level: LevelInstance, mapId?: string): string {
  return kit(level).musicTheme ?? idOf(level, mapId);
}
