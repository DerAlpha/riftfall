/**
 * Physics constants. Rapier interaction groups are 32-bit: upper 16 bits = membership,
 * lower 16 bits = filter (which groups this collider interacts with).
 */
export const COLLISION_GROUP = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  ENEMY: 1 << 2,
  PROJECTILE: 1 << 3,
  PROP: 1 << 4,
  DEBRIS: 1 << 5,
  TRIGGER: 1 << 6,
} as const;

/** Build a Rapier InteractionGroups value from membership and filter masks. */
export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const ALL_GROUPS = 0xffff;

export const PHYSICS = {
  gravity: -23,
  /** Solver iterations (Rapier default is 4). */
  solverIterations: 4,
  /** Dynamic props: default friction/restitution/density. */
  propFriction: 0.7,
  propRestitution: 0.1,
  propDensity: 250,
  /** Dynamic bodies below this Y are reset/removed (fell out of the world). */
  killPlaneY: -60,
} as const;
