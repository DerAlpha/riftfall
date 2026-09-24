/** Combat world tuning: hit resolution, penetration, damage zones. Distances in meters. */
import type { DamageElement, FleshSurface, HitZone, SurfaceType } from '../core/events';

export const COMBAT = {
  /**
   * Penetration budget a bullet spends to pass through a surface / body. Surfaces whose
   * material is not `penetrable` always stop bullets whatever the budget.
   */
  penetrationCost: {
    glass: 0.25,
    grate: 0.5,
    rubber: 0.75,
    metal: 1,
    concrete: 1.5,
    default: 1,
    flesh: 1,
    slime: 0.75,
    armor: 2,
    shield: 1000,
  } satisfies Record<SurfaceType | FleshSurface, number>,
  /** A penetrating trace continues this far past the entry point (skips the entered surface). */
  penetrationStep: 0.03,
  /** Hard cap of surfaces/bodies one bullet passes (guards degenerate geometry). */
  maxPenetrations: 4,
  /**
   * Zone order (first = highest): a shot's damage events on one target (one per zone hit) are sent
   * best zone first, so hit markers and hit sounds report the best zone.
   */
  zonePriority: ['weakpoint', 'head', 'body', 'limb', 'shield'] as const satisfies readonly HitZone[],
  /** Name prefixes of static level meshes that stop bullets (`level:<materialId>[:noshadow]`). */
  staticMeshPrefixes: ['level:', 'panel:'] as const,
  /** Line-of-sight rays end this short of the target point (the target's own surface). */
  lineOfSightEpsilon: 0.05,
  /** Rays shorter than this are ignored. */
  minRayLength: 1e-4,
  /** Hit normals with a squared length below this are degenerate (replaced by -ray direction). */
  minNormalLengthSq: 1e-8,
} as const;

/**
 * Fire-kinds engine (M5 arsenal): projectiles, explosions, lingering fields, beams, charge,
 * spin-up and the weapon specials. Pools are preallocated at these capacities (every quality).
 * Distances in meters, times in seconds, angles in DEGREES.
 */
export const ARSENAL = {
  projectiles: {
    /** Live projectiles (player weapons + grenades); spawns beyond it are refused. */
    capacity: 128,
    /** Contacts (bounces / pierces) resolved per projectile per tick at most. */
    maxContactsPerTick: 4,
    /** The drawn projectile starts at the muzzle and converges onto the true path (from the eye) in this time. */
    convergeTime: 0.1,
    /** A bounced projectile restarts this far off the surface. */
    bounceLift: 0.02,
    /** Detonations and blast line-of-sight start this far off the impact surface. */
    blastLift: 0.12,
    /** Below this speed a projectile that bounced off a floor (normal.y ≥ restNormalY) comes to rest. */
    restSpeed: 1.5,
    restNormalY: 0.65,
    /** Tangential speed kept per bounce: `restitution` blended this far towards 1 (skidding grenades). */
    tangentKeep: 0.5,
    /** Damageables a piercing projectile remembers (it never hits one twice). */
    maxPierceMemory: 8,
    /** Homing: search reach, cone around the flight direction, re-acquire interval. */
    homing: { range: 32, coneDeg: 75, retargetInterval: 0.12 },
    /** Knockback (m/s) of a direct projectile hit. */
    directImpulse: 1.5,
  },
  explosions: {
    /** Camera shake reaches this many blast radii (linear fade). */
    shakeReach: 3,
    /** Nested explode() calls allowed (an explosion's kill triggering another). */
    maxDepth: 4,
    /** Damageables considered per blast at most. */
    maxTargets: 64,
    /** Blasts lift the props they push by at least this fraction of the impulse (reads better than a shove). */
    propLift: 0.35,
  },
  fields: {
    capacity: 24,
    /** Damage ticks (dps × interval). */
    tickInterval: 0.25,
    /** Floor fields (damage, slow) snap to the floor within this reach below the spawn point. */
    floorProbe: 4,
    /** Floor fields reach this high above the floor (cylinder). */
    height: 2.4,
    /** Line-of-sight checks start this far above the field center. */
    losLift: 0.5,
    /** Pull: velocity = strength × responseTime × profile, eased in the core, capped. */
    pull: { responseTime: 0.4, coreRadius: 0.9, arrivalTime: 0.35, maxSpeed: 14 },
  },
  beam: {
    /** Cone beams (flamethrower): targets per tick at most, and how much of their bounds counts. */
    maxConeTargets: 16,
    coneBoundsFactor: 0.6,
    /** combat:impact events per beam tick at most (VFX/SFX budget). */
    maxImpactsPerTick: 3,
    /** Ticks resolved per fixed step at most (absurd tick rates). */
    maxTicksPerStep: 4,
  },
  specials: {
    /** Chain-arc visual (ArsenalVfxApi.beam) and how long an arc stays drawn. */
    arcVisual: 'beam.lightning',
    arcDuration: 0.16,
    /** Concurrent arc visuals and hops per arc at most (pool sizes). */
    arcCapacity: 24,
    maxChain: 8,
    /** Element and knockback of chain arcs. */
    arcElement: 'shock',
    /** Ricochet: search reach for the next target and the tracer kept per bounce. */
    ricochetRange: 30,
    /** Distinct tracer of a critBurst shot (linear hex). */
    critTracerColor: 0xfff4e0,
    /** Fields left by kills snap to the floor within this reach. */
    fieldFloorProbe: 4,
  },
  /**
   * Status build-up per damage point by damage element (DamageInfo.statusBuildup; the status
   * system, package B, turns applied damage × this into build-up). Physical builds nothing.
   */
  statusBuildup: {
    physical: 0,
    fire: 1,
    ice: 1,
    shock: 1,
    poison: 1,
    void: 1,
  } satisfies Record<DamageElement, number>,
} as const;
