/** Brain registry: EnemyTypeDef.brain → behaviour. M6 archetypes register here. */
import type { EnemyBrainId } from '../../../defs/enemies';
import type { EnemyBrain } from '../types';
import { bruteBrain } from './brute';
import { rangedBrain } from './ranged';
import { swarmBrain } from './swarm';

export const BRAINS: Readonly<Record<EnemyBrainId, EnemyBrain>> = {
  swarm: swarmBrain,
  ranged: rangedBrain,
  brute: bruteBrain,
};

export function getBrain(id: string): EnemyBrain | undefined {
  return Object.prototype.hasOwnProperty.call(BRAINS, id) ? BRAINS[id as EnemyBrainId] : undefined;
}
