/**
 * Map kit – what a map directory (src/maps/<id>/) imports. Read README.md next to this file first.
 */
export type {
  BossArenaDef,
  DoorSlotDef,
  LevelLightGroup,
  LevelZoneDef,
  MapLevelInstance,
  WallBuySlotDef,
} from '../types';
export type { MapEntry } from '../registry';
export type { BoxLocationDef, PerkMachinePlacementDef } from '../../defs/interactables';
export type { WorkshopPlacementDef } from '../../defs/workshop';
export type { TrapSlotDef, FenceSlotDef, TurretSlotDef, FanSlotDef, FlameSlotDef } from '../../defs/traps';
export type {
  GeneratorSpotDef,
  GravityZoneDef,
  MapEventDef,
  PowerOutageEventDef,
  InvasionEventDef,
  GravityAnomalyEventDef,
} from '../../defs/mapEvents';
export type { QuestDef, QuestStepDef, QuestRewardDef } from '../../defs/quests';
export { KitMaterials, type KitMaterialVariantDef } from './KitMaterials';
export { PropBuilder } from './PropBuilder';
export { LevelKit, WallFrame } from '../../world/LevelKit';
