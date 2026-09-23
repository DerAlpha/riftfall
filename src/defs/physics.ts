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

/**
 * Default filter masks per collider kind (see ColliderData.kind). The membership group is
 * derived from the kind; the filter says what the collider interacts with.
 */
export const COLLISION_FILTER = {
  world: ALL_GROUPS,
  prop: ALL_GROUPS,
  enemy: ALL_GROUPS,
  player: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP | COLLISION_GROUP.ENEMY | COLLISION_GROUP.TRIGGER,
  trigger: COLLISION_GROUP.PLAYER | COLLISION_GROUP.ENEMY,
  /** What the player's character controller collides with while moving. */
  playerMovement: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP | COLLISION_GROUP.ENEMY,
  /** What player probes (ground, mantle, headroom) consider solid. */
  playerProbe: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP,
  /** Camera center ray (ADS depth-of-field focus). */
  cameraProbe: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP | COLLISION_GROUP.ENEMY,
  /**
   * Solver (contact force) filter for the player capsule. Props are included so thrown/falling
   * props cannot pass through the player; pushing is done by the character controller's
   * impulses (`MOVEMENT.collider.mass`), which stops the capsule at the skin distance.
   */
  playerSolver: COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP | COLLISION_GROUP.ENEMY,
} as const;

export const PHYSICS = {
  gravity: -23,
  /** Solver iterations (Rapier default is 4). */
  solverIterations: 4,
  /** Dynamic props: default friction/restitution/density. */
  propFriction: 0.7,
  propRestitution: 0.1,
  propDensity: 250,
  /** Light damping so props settle instead of sliding forever on low-friction contacts. */
  propLinearDamping: 0.05,
  propAngularDamping: 0.15,
  /** Dynamic bodies below this Y are reset/removed (fell out of the world). */
  killPlaneY: -60,
} as const;
