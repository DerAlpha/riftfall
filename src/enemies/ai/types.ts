/**
 * Contracts between EnemyManager (the host: services, budgets, bookkeeping) and the per-archetype
 * brains / attack executors in this folder. Brains only decide (which attack, where to move); the
 * host owns nav agents, visuals, events and the per-tick query budgets.
 */
import type { Vector3 } from 'three';
import type { CombatWorldApi, EnemyTargetApi, NavApi, VfxApi } from '../../core/contracts';
import type { Rng } from '../../core/Rng';
import type { EnemyAttackDef, EnemyAttackKind } from '../../defs/enemies';
import type { ProjectileSystem } from '../../combat/Projectiles';
import type { Enemy } from '../Enemy';
import type { AttackSlotCoordinator } from './AttackSlotCoordinator';
import type { SurroundSlots } from './SurroundSlots';

export interface AiHost {
  /** Simulation time (s). */
  readonly time: number;
  readonly nav: NavApi;
  readonly combat: CombatWorldApi;
  readonly rng: Rng;
  readonly projectiles: ProjectileSystem | null;
  readonly vfx: Pick<VfxApi, 'spawn'> | null;
  /** Living and dying enemies (read-only; crowding checks). */
  readonly enemies: readonly Enemy[];
  /** Reused corner array for nav.findPath. */
  readonly pathScratch: Vector3[];

  /** Target the enemy hunts (null when none is alive). */
  target(e: Enemy): EnemyTargetApi | null;
  /** World bearing (atan2(z, x)) the target of slot `slot` is facing – flankers avoid it. */
  targetFacing(slot: number): number;
  /** Melee token coordinator of the enemy's pool at its current target. */
  coordinator(e: Enemy): AttackSlotCoordinator;
  surround(slot: number): SurroundSlots;
  /**
   * Per-kind attack spacing at the enemy's target (ENEMY_AI.attackSpacing): may its attack of
   * `kind` start now? (No synchronized acid volleys, no simultaneous charges.) Ask only when the
   * attack is otherwise ready: askers queue up and the one waiting longest goes next.
   */
  spacingAllows(e: Enemy, kind: EnemyAttackKind): boolean;

  /** Spend nav path queries / static spot rays of this tick's budget (false: try next tick). */
  takePaths(n: number): boolean;
  takeSpotRays(n: number): boolean;
  /**
   * Line of sight not older than `maxAge` (re-checked from the urgent budget when stale). Returns
   * e.canSee.
   */
  refreshLos(e: Enemy, maxAge: number): boolean;

  /** Ask the nav crowd to walk to `point` at `speed` (m/s, before the spawn speed multiplier). */
  moveTo(e: Enemy, point: Vector3, speed: number): void;
  stopMoving(e: Enemy): void;

  /** Start attack `index` of the enemy's def (host bookkeeping, events, animation). */
  beginAttack(e: Enemy, index: number): void;
  /** Deal `amount` (× the enemy's damage multiplier) to the target with this attack's shake. */
  hitTarget(e: Enemy, attack: EnemyAttackDef, target: EnemyTargetApi, amount: number, shake: number): void;
  /** Camera trauma (heavy impacts near the player). */
  shake(trauma: number): void;
  /** World position of a visual socket of the enemy (latest tick pose); false if unknown. */
  socket(e: Enemy, name: string, out: Vector3): boolean;
  /** Self-stagger (charge into a wall). */
  staggerSelf(e: Enemy, duration: number): void;
  /** End an AI movement override: the parked nav agent is teleported to the enemy. */
  endOverride(e: Enemy): void;
}

export interface EnemyBrain {
  /** Every tick while the enemy is 'active' (not emerging / attacking / staggered / dying). */
  think(e: Enemy, host: AiHost, target: EnemyTargetApi, dt: number): void;
  /** Back in 'active' after spawn, an attack or a stagger. */
  resume(e: Enemy, host: AiHost): void;
  /** The enemy dies / despawns: give back slots and tokens. */
  release(e: Enemy, host: AiHost): void;
}
