/**
 * Zone gating with the level's own start zones (M7): ZoneSystem.forLevel reads the per-map table
 * ZONES.startZones; a map directory brings its start zones with the level instead
 * (MapLevelInstance.startZones – levelData.resolveStartZones prefers them).
 */
import type { LevelInstance } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { ZoneSystem } from '../../interactables/ZoneSystem';
import { isMapLevel } from '../types';
import { resolveStartZones } from './levelData';

export function createZoneSystem(level: LevelInstance, events: EventBus<GameEvents>): ZoneSystem {
  if (!isMapLevel(level) || level.zones.length === 0) return ZoneSystem.forLevel(level, events);
  return new ZoneSystem({
    events,
    zones: level.zones.map((z) => z.id),
    startZones: resolveStartZones(level),
  });
}
