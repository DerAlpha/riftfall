/** Combat world tuning: hit resolution, penetration, damage zones. Distances in meters. */
import type { FleshSurface, HitZone, SurfaceType } from '../core/events';

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
  /** Aggregated pellet hits report the highest-priority zone that was hit (first = highest). */
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
