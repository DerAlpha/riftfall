/** Brain registry: EnemyTypeDef.brain → behaviour. M6 archetypes register here. */
import type { EnemyBrainId } from '../../../defs/enemies';
import type { EnemyBrain } from '../types';
import { bruteBrain } from './brute';
import { rangedBrain } from './ranged';
import { swarmBrain } from './swarm';
import { shieldBrain } from './shield';
import { stalkerBrain } from './stalker';
import { blinkBrain } from './blink';
import { supportBrain } from './support';
import { sniperBrain } from './sniper';
import { crawlerBrain } from './crawler';
import { flyerBrain } from './flyer';
import { bossBrain } from './boss';

/** null entries are M6 brains not built yet (one file each, parallel authoring). */
export const BRAINS: Readonly<Record<EnemyBrainId, EnemyBrain | null>> = {
  swarm: swarmBrain,
  ranged: rangedBrain,
  brute: bruteBrain,
  shield: shieldBrain,
  stalker: stalkerBrain,
  blink: blinkBrain,
  support: supportBrain,
  sniper: sniperBrain,
  crawler: crawlerBrain,
  flyer: flyerBrain,
  boss: bossBrain,
};

export function getBrain(id: string): EnemyBrain | undefined {
  return Object.prototype.hasOwnProperty.call(BRAINS, id)
    ? (BRAINS[id as EnemyBrainId] ?? undefined)
    : undefined;
}
