/**
 * Enemy visual defs of the M6 types and bosses, one file per type. getEnemyVisualDef /
 * enemyVisualTypeIds (defs/enemyVisuals.ts) look here after ENEMY_VISUALS; null = not built yet.
 */
import type { EnemyVisualDef } from '../enemyVisuals';
import { LEAPER_VISUAL } from './leaper';
import { BERSERKER_VISUAL } from './berserker';
import { MITE_VISUAL } from './mite';
import { EXPLODER_VISUAL } from './exploder';
import { SHIELDBEARER_VISUAL } from './shieldbearer';
import { STALKER_VISUAL } from './stalker';
import { TELEPORTER_VISUAL } from './teleporter';
import { SHOCKER_VISUAL } from './shocker';
import { HEALER_VISUAL } from './healer';
import { SUMMONER_VISUAL } from './summoner';
import { SNIPER_VISUAL } from './sniper';
import { CRAWLER_VISUAL } from './crawler';
import { FLYER_VISUAL } from './flyer';
import { PROBAND_VISUAL } from './proband';
import { FROSTKOLOSS_VISUAL } from './frostkoloss';
import { BROODQUEEN_VISUAL } from './broodqueen';
import { EMBERKOLOSS_VISUAL } from './emberkoloss';
import { VOIDWARDEN_VISUAL } from './voidwarden';
import { ARCHITECT_VISUAL } from './architect';

export const M6_ENEMY_VISUALS: Readonly<Record<string, EnemyVisualDef | null>> = {
  leaper: LEAPER_VISUAL,
  berserker: BERSERKER_VISUAL,
  mite: MITE_VISUAL,
  exploder: EXPLODER_VISUAL,
  shieldbearer: SHIELDBEARER_VISUAL,
  stalker: STALKER_VISUAL,
  teleporter: TELEPORTER_VISUAL,
  shocker: SHOCKER_VISUAL,
  healer: HEALER_VISUAL,
  summoner: SUMMONER_VISUAL,
  sniper: SNIPER_VISUAL,
  crawler: CRAWLER_VISUAL,
  flyer: FLYER_VISUAL,
  proband: PROBAND_VISUAL,
  frostkoloss: FROSTKOLOSS_VISUAL,
  broodqueen: BROODQUEEN_VISUAL,
  emberkoloss: EMBERKOLOSS_VISUAL,
  voidwarden: VOIDWARDEN_VISUAL,
  architect: ARCHITECT_VISUAL,
};
