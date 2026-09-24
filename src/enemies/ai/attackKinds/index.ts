/** Executors of the M6 attack kinds, one file each; null = not built yet. */
import type { EnemyAttackKind } from '../../../defs/enemies';
import type { AttackExecutor } from './types';
import { beamAttack } from './beam';
import { summonAttack } from './summon';
import { blinkAttack } from './blink';
import { dischargeAttack } from './discharge';
import { diveAttack } from './dive';
import { dropAttack } from './drop';

export type { AttackExecutor } from './types';

export const ATTACK_EXECUTORS: Readonly<Partial<Record<EnemyAttackKind, AttackExecutor | null>>> = {
  beam: beamAttack,
  summon: summonAttack,
  blink: blinkAttack,
  discharge: dischargeAttack,
  dive: diveAttack,
  drop: dropAttack,
};

export function getAttackExecutor(kind: EnemyAttackKind): AttackExecutor | null {
  return ATTACK_EXECUTORS[kind] ?? null;
}
