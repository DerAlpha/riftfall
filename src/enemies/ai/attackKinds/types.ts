/**
 * Executor of an M6 attack kind (enemies/ai/attacks.ts dispatches every kind it does not implement
 * itself here). Phases: windup (attacks.ts turns towards the target) → strike (begin, then update
 * each tick) → recover.
 */
import type { EnemyTargetApi } from '../../../core/contracts';
import type { EnemyAttackDef } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import type { AiHost } from '../types';

export interface AttackExecutor {
  /** Strike start. False: the strike is void (no line, no room) → straight to recovery. */
  begin(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null): boolean;
  /** Each tick of the strike phase; true = the strike ended early. */
  update?(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null, dt: number): boolean;
  /** The attack was cancelled (stagger, death, reset): undo overrides, stop effects. */
  cancel?(e: Enemy, host: AiHost, a: EnemyAttackDef): void;
}
