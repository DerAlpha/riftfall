/**
 * Map-level extensions of the LevelInstance contract (src/core/contracts.ts) that wave maps
 * expose for M4 (doors, wall buys, zones), for the composition root (volumetric content) and for
 * the M7 map kit (src/maps/kit: placements, traps, events, gravity, quest, boss arena, music).
 * All fields are optional on LevelInstance consumers: the calibration hall has none of them, and
 * every M7 field falls back to the per-map-id tables in src/defs (maps/kit/levelData.ts) – the
 * level's own data always wins. Map builders: read src/maps/kit/README.md first.
 */
import type * as THREE from 'three';
import type { LevelInstance } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import type { BoxLocationDef, PerkMachinePlacementDef } from '../defs/interactables';
import type { Facing } from '../defs/level';
import type { GeneratorSpotDef, GravityZoneDef, MapEventDef } from '../defs/mapEvents';
import type { QuestDef } from '../defs/quests';
import type { TrapSlotDef } from '../defs/traps';
import type { WorkshopPlacementDef } from '../defs/workshop';

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

/** M6 boss fights: the open floor a boss arena uses (center on the floor, radius). */
export interface BossArenaDef {
  readonly center: Vec3Like;
  readonly radius: number;
  /** Zone the arena lies in. */
  readonly zone: string;
}

/**
 * Dimmable lights of a level for the power outage (maps/kit/PowerGrid). Without `lightGroups` the
 * kit collects them from level.root (lights, `level:emissive_*` meshes, `VolumetricCone`s).
 */
export interface LevelLightGroup {
  readonly id: string;
  /** Emergency lighting: kept and boosted (pulsing red) during an outage instead of dimmed. */
  readonly emergency: boolean;
  readonly lights: readonly THREE.Light[];
  /** Emissive materials (fixture panels, strips): emissiveIntensity is scaled. */
  readonly materials: readonly THREE.Material[];
  /** Additive light cones / glows: their `uIntensity` uniform is scaled (ShaderMaterials). */
  readonly glows?: readonly THREE.Material[];
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
  /**
   * World box of the space the sun can reach (below the skylights), or null: everywhere. Hand it to
   * the enemy renderer (EnemyRenderer sunCasterBounds): the sun's shadow cascades skip enemies
   * outside it – under a roof they cast no shadow the roof does not already cast.
   */
  readonly sunCasterBounds?: { readonly min: Vec3Like; readonly max: Vec3Like } | null;
  /** Zone containing a world point (feet), or null (walls / outside). */
  zoneAt(x: number, z: number): string | null;

  // --- M7 map kit (optional; absent = the per-map tables in src/defs) ---------------------------
  /** Zones active at the run start (else ZONES.startZones[id]). */
  readonly startZones?: readonly string[];
  /** Perk machine spots (else PERK_MACHINES.placements[id]); pinned perks via `perk`. */
  readonly perkSpots?: readonly PerkMachinePlacementDef[];
  /** Rift-Kiste locations and the start candidates (else MYSTERY_BOX.locations / start[id]). */
  readonly boxLocations?: readonly BoxLocationDef[];
  readonly boxStartIds?: readonly string[];
  /** Rift Forge / Werkbank (else RIFT_FORGE_MACHINE / WORKBENCH placements[id]); null = none. */
  readonly forgePlacement?: WorkshopPlacementDef | null;
  readonly benchPlacement?: WorkshopPlacementDef | null;
  /** Traps (else TRAP_SLOTS[id]). */
  readonly trapSlots?: readonly TrapSlotDef[];
  /** Map events (else MAP_EVENT_DEFS[id]) and the power outage's generators (else GENERATORS[id]). */
  readonly eventDefs?: readonly MapEventDef[];
  readonly generators?: readonly GeneratorSpotDef[];
  /** Permanent gravity zones (orbital map low-g areas). */
  readonly gravityZones?: readonly GravityZoneDef[];
  /** The map's easter egg (else QUESTS[id]); null = none. */
  readonly questDef?: QuestDef | null;
  /** M6: where bosses fight (else the kit's default: the first spawn zone's center). */
  readonly bossArena?: BossArenaDef | null;
  /** Music theme (defs/music mapThemes key); default: the map id. */
  readonly musicTheme?: string;
  /** Dimmable lights for power outages (else collected from level.root). */
  readonly lightGroups?: readonly LevelLightGroup[];
  /**
   * Level-owned props that go dark in a power outage (monitors, signs): their emissive / uIntensity
   * materials are dimmed like the machines'.
   */
  readonly poweredObjects?: readonly THREE.Object3D[];
}

/** Narrow a LevelInstance to the wave-map extras (duck-typed). */
export function isMapLevel(level: LevelInstance): level is MapLevelInstance {
  const l = level as Partial<MapLevelInstance>;
  return Array.isArray(l.doorSlots) && Array.isArray(l.zones) && typeof l.zoneAt === 'function';
}
