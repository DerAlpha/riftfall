/**
 * Map-level extensions of the LevelInstance contract (src/core/contracts.ts) that wave maps
 * expose for M4 (doors, wall buys, zones) and for the composition root (volumetric content).
 * All fields are optional on LevelInstance consumers: the calibration hall has none of them.
 */
import type * as THREE from 'three';
import type { LevelInstance } from '../core/contracts';
import type { Facing } from '../defs/level';

/** A zone of a wave map (spawn points and door slots reference its id). */
export interface LevelZoneDef {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
}

/**
 * Doorway of a purchasable M4 door (interactables/Door). `position` is the bottom center of the
 * passage (floor level, between the two walls); the door leaf spans `width` × `height` and may be
 * up to `depth` thick. `facing` points from zoneA into zoneB (yaw: three.js convention of an object
 * whose local +Z points that way, i.e. atan2(dir.x, dir.z)).
 */
export interface DoorSlotDef {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly facing: Facing;
  readonly yaw: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly zoneA: string;
  readonly zoneB: string;
  /** Suggested price (points). */
  readonly costHint: number;
  /** Heavy blast door (the big atrium → dock gate). */
  readonly blast: boolean;
}

/** Wall-buy spot placeholder (M4 economy): the framed outline board on a wall. */
export interface WallBuySlotDef {
  readonly id: string;
  /** Center of the board on the wall face. */
  readonly position: THREE.Vector3;
  /** Interior direction the board faces (the player stands in front of it). */
  readonly facing: Facing;
  readonly zone: string;
  /** Suggested weapon id (defs/weapons) and price. */
  readonly weaponHint: string;
  readonly costHint: number;
}

/** A LevelInstance with the wave-map extras. */
export interface MapLevelInstance extends LevelInstance {
  readonly zones: readonly LevelZoneDef[];
  readonly doorSlots: readonly DoorSlotDef[];
  readonly wallBuySlots: readonly WallBuySlotDef[];
  /**
   * The level draws on RENDER.volumetricLayer even with volumetrics off (rift portals). OR it into
   * RenderSystem.setVolumetricContentProbe, or the portals vanish on the 'low' preset.
   */
  readonly hasVolumetricContent: boolean;
  /** Zone containing a world point (feet), or null (walls / outside). */
  zoneAt(x: number, z: number): string | null;
}

/** Narrow a LevelInstance to the wave-map extras (duck-typed). */
export function isMapLevel(level: LevelInstance): level is MapLevelInstance {
  const l = level as Partial<MapLevelInstance>;
  return Array.isArray(l.doorSlots) && Array.isArray(l.zones) && typeof l.zoneAt === 'function';
}
