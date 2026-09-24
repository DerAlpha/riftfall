/**
 * Enemy type defs of the M6 types and bosses, one file per type (parallel authoring without a shared
 * file). getEnemyDef / enemyTypeIds (defs/enemies.ts) look here after ENEMIES; null = not built yet.
 */
import type { EnemyTypeDef } from '../enemies';
import { LEAPER_ENEMY } from './leaper';
import { BERSERKER_ENEMY } from './berserker';
import { MITE_ENEMY } from './mite';
import { EXPLODER_ENEMY } from './exploder';
import { SHIELDBEARER_ENEMY } from './shieldbearer';
import { STALKER_ENEMY } from './stalker';
import { TELEPORTER_ENEMY } from './teleporter';
import { SHOCKER_ENEMY } from './shocker';
import { HEALER_ENEMY } from './healer';
import { SUMMONER_ENEMY } from './summoner';
import { SNIPER_ENEMY } from './sniper';
import { CRAWLER_ENEMY } from './crawler';
import { FLYER_ENEMY } from './flyer';
import { PROBAND_ENEMY } from './proband';
import { FROSTKOLOSS_ENEMY } from './frostkoloss';
import { BROODQUEEN_ENEMY } from './broodqueen';
import { EMBERKOLOSS_ENEMY } from './emberkoloss';
import { VOIDWARDEN_ENEMY } from './voidwarden';
import { ARCHITECT_ENEMY } from './architect';

export const M6_ENEMIES: Readonly<Record<string, EnemyTypeDef | null>> = {
  leaper: LEAPER_ENEMY,
  berserker: BERSERKER_ENEMY,
  mite: MITE_ENEMY,
  exploder: EXPLODER_ENEMY,
  shieldbearer: SHIELDBEARER_ENEMY,
  stalker: STALKER_ENEMY,
  teleporter: TELEPORTER_ENEMY,
  shocker: SHOCKER_ENEMY,
  healer: HEALER_ENEMY,
  summoner: SUMMONER_ENEMY,
  sniper: SNIPER_ENEMY,
  crawler: CRAWLER_ENEMY,
  flyer: FLYER_ENEMY,
  proband: PROBAND_ENEMY,
  frostkoloss: FROSTKOLOSS_ENEMY,
  broodqueen: BROODQUEEN_ENEMY,
  emberkoloss: EMBERKOLOSS_ENEMY,
  voidwarden: VOIDWARDEN_ENEMY,
  architect: ARCHITECT_ENEMY,
};
