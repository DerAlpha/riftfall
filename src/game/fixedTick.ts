/**
 * One fixed simulation tick (60 Hz) in its binding order – CLAUDE.md "Frame / tick flow".
 *
 * 1. player: kinematic move against the current world (samples input, latches edges).
 * 2. weapons: shots resolve against the hitboxes of the PREVIOUS tick. Those are the pose the last
 *    rendered frame interpolated towards (lerp(prev, cur, alpha)), i.e. what the player aimed at:
 *    the hitbox leads the visible model by (1 − alpha) ticks. Stepping targets/enemies first would
 *    move their hitboxes a further tick ahead ((2 − alpha) ticks – several cm on a moving target).
 * 3. targets (M3: enemies after them): move, refresh hitboxes, react to this tick's damage.
 * 4. kill plane, then physics.step: kinematic bodies land where their owners moved them this tick,
 *    props react to pushes and bullet impulses.
 * 5. health, level.
 */
import type { LevelInstance, PhysicsApi, PlayerApi, WeaponSystemApi } from '../core/contracts';
import { createLogger } from '../core/log';
import { PHYSICS } from '../defs/physics';

const log = createLogger('Game');

interface TickStep {
  fixedUpdate(dt: number): void;
}

/** What the fixed tick steps (structural: Game passes its GameSystems). */
export interface FixedTickSystems {
  player: Pick<PlayerApi, 'fixedUpdate' | 'noclip' | 'position' | 'teleport'>;
  weapons: Pick<WeaponSystemApi, 'fixedUpdate'>;
  /** Moving damageables (calibration-hall targets); null on maps without them. */
  targets: TickStep | null;
  physics: Pick<PhysicsApi, 'step'>;
  health: TickStep;
  level: Pick<LevelInstance, 'spawn' | 'fixedUpdate'>;
}

export function runFixedTick(s: FixedTickSystems, dt: number): void {
  const { player, weapons, targets, physics, health, level } = s;
  player.fixedUpdate(dt);
  weapons.fixedUpdate(dt);
  targets?.fixedUpdate(dt);
  if (!player.noclip && player.position.y < PHYSICS.killPlaneY) {
    // Fell out of the world (tp/noclip outside the hall, or a collision bug): back to spawn.
    log.warn(`Player below kill plane (y ${player.position.y.toFixed(1)}) – respawn`);
    player.teleport(level.spawn.position, level.spawn.yaw);
  }
  physics.step(dt);
  health.fixedUpdate(dt);
  level.fixedUpdate?.(dt);
}
