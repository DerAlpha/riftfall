/**
 * One fixed simulation tick (60 Hz) in its binding order – CLAUDE.md "Frame / tick flow".
 *
 * 1. player: kinematic move against the current world (samples input, latches edges); then the
 *    interaction focus (M4): a purchase's give()/switch is handled by this tick's weapon step.
 * 2. weapons: shots resolve against the hitboxes of the PREVIOUS tick. Those are the pose the last
 *    rendered frame interpolated towards (lerp(prev, cur, alpha)), i.e. what the player aimed at:
 *    the hitbox leads the visible model by (1 − alpha) ticks. Stepping targets/enemies first would
 *    move their hitboxes a further tick ahead ((2 − alpha) ticks – several cm on a moving target).
 * 3. targets (M3: enemies after them): move, refresh hitboxes, react to this tick's damage.
 *    M5: arsenal projectiles, then lingering fields – they collide with / tick on this tick's
 *    hitboxes (after the enemies moved) and blasts push props before physics.step; then status
 *    effects resolve this tick's build-up (statuses, combos, damage over time) – enemies read
 *    them on their next tick.
 * 4. interactables (door leaves, box), power-up pickups; kill plane, then physics.step: kinematic
 *    bodies land where their owners moved them this tick, props react to pushes and bullet impulses.
 * 5. health, perk hooks (cooldowns, buff decay), level, run flow.
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
  /** M3: wave director (spawns this tick get their first enemy tick right away). */
  waves: TickStep | null;
  /** M3: enemies (AI + crowd step + renderer commit) – after the weapons, before physics.step. */
  enemies: TickStep | null;
  /** M5: arsenal projectiles (weapons/fire ProjectileSystem) – after the enemies. */
  projectiles?: TickStep | null;
  /** M5: lingering fields (combat/FieldSystem) – after the projectiles that leave them. */
  fields?: TickStep | null;
  /** M5: status effects (combat/status) – after every damage source of the tick. */
  status?: TickStep | null;
  /** M3: run flow (survival time). */
  runFlow: TickStep | null;
  /** M4: interaction focus/hold (after the player moved, before the weapons). */
  interaction: TickStep | null;
  /** M4: doors (collider moves), mystery box. */
  interactables: TickStep | null;
  /** M4: power-up pickups (collection) and timers. */
  powerUps: TickStep | null;
  /** M4: perk hook cooldowns and buffs. */
  perks: TickStep | null;
  physics: Pick<PhysicsApi, 'step'>;
  health: TickStep;
  level: Pick<LevelInstance, 'spawn' | 'fixedUpdate'>;
}

export function runFixedTick(s: FixedTickSystems, dt: number): void {
  const { player, weapons, targets, waves, enemies, runFlow, physics, health, level } = s;
  player.fixedUpdate(dt);
  s.interaction?.fixedUpdate(dt);
  weapons.fixedUpdate(dt);
  targets?.fixedUpdate(dt);
  waves?.fixedUpdate(dt);
  enemies?.fixedUpdate(dt);
  s.projectiles?.fixedUpdate(dt);
  s.fields?.fixedUpdate(dt);
  s.status?.fixedUpdate(dt);
  s.interactables?.fixedUpdate(dt);
  s.powerUps?.fixedUpdate(dt);
  if (!player.noclip && player.position.y < PHYSICS.killPlaneY) {
    // Fell out of the world (tp/noclip outside the hall, or a collision bug): back to spawn.
    log.warn(`Player below kill plane (y ${player.position.y.toFixed(1)}) – respawn`);
    player.teleport(level.spawn.position, level.spawn.yaw);
  }
  physics.step(dt);
  health.fixedUpdate(dt);
  s.perks?.fixedUpdate(dt);
  level.fixedUpdate?.(dt);
  runFlow?.fixedUpdate(dt);
}
