/**
 * Stuck detection (pure): every `interval` seconds an enemy that wants to move must have made
 * `minProgress` meters of progress. After `repathAfter` failed checks it re-requests its path, after
 * `teleportAfter` it is teleported to the navmesh (nearest point / a random nearby point).
 */
export interface StuckConfig {
  readonly interval: number;
  readonly minProgress: number;
  readonly repathAfter: number;
  readonly teleportAfter: number;
}

export interface StuckState {
  /** Position at the last check. */
  ax: number;
  az: number;
  /** Time of the next check. */
  next: number;
  fails: number;
}

export const STUCK_NONE = 0;
export const STUCK_REPATH = 1;
export const STUCK_TELEPORT = 2;
export type StuckAction = typeof STUCK_NONE | typeof STUCK_REPATH | typeof STUCK_TELEPORT;

export function resetStuck(s: StuckState, x: number, z: number, now: number, cfg: StuckConfig): void {
  s.ax = x;
  s.az = z;
  s.next = now + cfg.interval;
  s.fails = 0;
}

/**
 * Advance the monitor. `wantsToMove`: the enemy has a goal it has not reached. Returns the action to
 * take this tick (at most one per check).
 */
export function updateStuck(
  s: StuckState,
  x: number,
  z: number,
  now: number,
  wantsToMove: boolean,
  cfg: StuckConfig,
): StuckAction {
  if (now < s.next) return STUCK_NONE;
  const moved = Math.hypot(x - s.ax, z - s.az);
  s.ax = x;
  s.az = z;
  s.next = now + cfg.interval;
  if (!wantsToMove || moved >= cfg.minProgress) {
    s.fails = 0;
    return STUCK_NONE;
  }
  s.fails++;
  if (s.fails >= cfg.teleportAfter) {
    s.fails = 0;
    return STUCK_TELEPORT;
  }
  return s.fails === cfg.repathAfter ? STUCK_REPATH : STUCK_NONE;
}
