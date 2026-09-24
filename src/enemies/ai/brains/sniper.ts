/**
 * Sniper brain (M6 Späher): the ranged brain's positioning (distance band, firing spots with line
 * of sight and peek cover, repositioning when sight is lost or the target closes in – it backs off
 * to its long band) plus shoot-and-move: after each laser shot (a 'beam' attack with `laser`) it
 * either ducks behind the spot's cover or – with `relocateChance` – searches a new firing spot, so
 * a player cannot simply pre-aim the last glint. Cornered, the ranged brain's melee bash fires.
 */
import type { EnemyTargetApi } from '../../../core/contracts';
import type { Enemy } from '../../Enemy';
import type { AiHost, EnemyBrain } from '../types';
import { RANGED_SEARCH, rangedBrain } from './ranged';

/** Leave for a new spot right away (ranged search from scratch; runs once the shot is over). */
function relocate(e: Enemy, host: AiHost): void {
  e.mode = RANGED_SEARCH;
  e.modeTime = host.time;
  e.searchIndex = 0;
  e.spotBest = Number.NEGATIVE_INFINITY;
  e.spotValid = false;
  e.coverSide = 0;
  e.hideAfterShot = false;
}

export const sniperBrain: EnemyBrain = {
  think(e: Enemy, host: AiHost, target: EnemyTargetApi, dt: number): void {
    rangedBrain.think(e, host, target, dt);
    if (e.state !== 'attack') return;
    const a = e.def.attacks[e.attackIndex];
    if (!a || a.kind !== 'beam' || !a.beam?.laser) return;
    // The shot just started (the brain is not called again until it is over): plan what follows.
    const chance = e.def.sniper?.relocateChance ?? 0;
    if (chance > 0 && host.rng.chance(chance)) relocate(e, host);
    else e.hideAfterShot = e.coverSide !== 0;
  },

  resume(e: Enemy, host: AiHost): void {
    rangedBrain.resume(e, host);
  },

  release(e: Enemy, host: AiHost): void {
    rangedBrain.release(e, host);
  },
};
