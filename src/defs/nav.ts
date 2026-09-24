/**
 * Navigation tuning: navmesh generation (recast), queries and crowd steering (detour), the
 * direct-steering fallback and the debug view. Meters, seconds, degrees where noted.
 *
 * The navmesh is built for the MEDIUM enemy (agentRadius / agentHeight): smaller swarmers walk the
 * same mesh; bigger tanks may brush walls slightly (their crowd radius still keeps them apart).
 * Stairs rise 0.2 m (TEST_ROOM_LAYOUT.stairs.maxStepRise), ramps are 18° / 25°: `agentClimb` and
 * `walkableSlopeDeg` cover both with margin, mantle ledges and crates (≥ 0.5 m) stay obstacles.
 */
import { COMBAT } from './combat';

/** Detour obstacle-avoidance sampling preset (dtObstacleAvoidanceParams). */
export interface NavAvoidancePreset {
  readonly velBias: number;
  readonly weightDesVel: number;
  readonly weightCurVel: number;
  readonly weightSide: number;
  readonly weightToi: number;
  /** Seconds of look-ahead for collisions. */
  readonly horizTime: number;
  readonly gridSize: number;
  readonly adaptiveDivs: number;
  readonly adaptiveRings: number;
  readonly adaptiveDepth: number;
}

/** Detour crowd update flags (DT_CROWD_* in DetourCrowd.h). */
export const CROWD_FLAG = {
  anticipateTurns: 1,
  obstacleAvoidance: 2,
  separation: 4,
  optimizeVisibility: 8,
  optimizeTopology: 16,
} as const;

export const NAV = {
  build: {
    /**
     * 'tiled' (default): independent ~10 m tiles – robust for 60 × 60 m levels with stacked
     * decks (no 65k-vertex limit of a single poly mesh, smaller regions, tiles can be rebuilt
     * one by one for M4 doors). 'solo' is one poly mesh (a little faster on tiny test levels).
     */
    mode: 'tiled' as 'tiled' | 'solo',
    /** Voxel size on XZ (m). The agent radius should be a multiple of it (no rounding slack). */
    cellSize: 0.2,
    /**
     * Voxel height (m). Floors at multiples of it come out exact (navBuild aligns the voxel grid);
     * slopes and polygon corners next to steps float up to ~1.5 cells above the rendered surface.
     */
    cellHeight: 0.05,
    walkableSlopeDeg: 45,
    /** Medium enemy: clearance height, radius the walkable area is eroded by, max step (m). */
    agentHeight: 1.8,
    agentRadius: 0.4,
    agentClimb: 0.35,
    /** Tile edge length for the tiled mode (m; rounded to whole cells). */
    tileSize: 9.6,
    /** Max contour edge length (m) – long wall edges get extra vertices (better crowd corners). */
    maxEdgeLength: 6,
    /** Max contour deviation from the raw outline (cells). */
    maxSimplificationError: 1.3,
    /** Regions smaller than this² cells are dropped (tops of lamps, pillar caps, pipes). */
    minRegionSize: 8,
    /** Regions smaller than this² cells merge into neighbours. */
    mergeRegionSize: 20,
    maxVertsPerPoly: 6,
    /** Detail mesh sampling distance (cells) and max height error (voxel heights). */
    detailSampleDist: 6,
    detailSampleMaxError: 1,
    /** Generate in a Web Worker when available (main-thread fallback otherwise / on failure). */
    useWorker: true,
    /** Give up on the worker after this long and build on the main thread instead (ms). */
    workerTimeoutMs: 20000,
  },
  sources: {
    /** Default nav sources (collectNavSources): the static level meshes that also stop bullets. */
    prefixes: COMBAT.staticMeshPrefixes as readonly string[],
    /** `mesh.userData[ignoreFlag] = true` excludes decoration from the navmesh. */
    ignoreFlag: 'navIgnore',
  },
  query: {
    /** Search box half extents for closestPoint / spawn snapping / walkable (m). */
    halfExtents: { x: 2, y: 2, z: 2 },
    /**
     * Agent move targets (the player may be airborne: a taller box snaps a jumping player to the
     * floor under them; the nearest poly still wins, so a deck overhead does not steal the snap).
     */
    targetHalfExtents: { x: 2, y: 4, z: 2 },
    /** A* node pool of the shared query object. */
    maxNodes: 2048,
    maxPathPolys: 256,
    /** findPath writes at most this many corners. */
    maxStraightPathPoints: 32,
    /**
     * walkable(): an endpoint whose navmesh snap moved it further than this on XZ is off the
     * walkable area (inside a wall, past a ledge) → not walkable. Covers the player hugging a wall
     * (radius 0.38 < agentRadius) plus the contour simplification error (1.3 cells = 0.26 m);
     * knockback / charge probes therefore stop at most this far past the eroded edge.
     */
    walkableSnapTolerance: 0.3,
    /**
     * Polygons a navmesh raycast records (walkable / randomPointAround): the last one tells which
     * layer the ray ended on (floor under a deck vs. the deck). Longer rays fall back to a
     * reverse ray.
     */
    maxRaycastPolys: 64,
    /** randomPointAround: detour samples (a random polygon touching the circle) until one lies inside. */
    randomPointAttempts: 4,
    /** ...then a disk sample clipped at walls, pulled back this far from the wall (m). */
    randomPointWallMargin: 0.05,
    /**
     * Lowers every point handed out (closest / random / path / agent positions) by this much (m).
     * 0: grid-aligned floors are exact (measured on the calibration hall: median error 0, p90
     * 0.05 m on slopes and polygon corners beside steps).
     */
    heightBias: 0,
  },
  crowd: {
    /** 60 active enemies + headroom (bosses' minions, M6). */
    maxAgents: 72,
    /** Largest crowd agent radius (tank). */
    maxAgentRadius: 1.2,
    updateFlags:
      CROWD_FLAG.anticipateTurns |
      CROWD_FLAG.obstacleAvoidance |
      CROWD_FLAG.separation |
      CROWD_FLAG.optimizeVisibility |
      CROWD_FLAG.optimizeTopology,
    /** Neighbour / wall query range and path shortcut range as multiples of the agent radius. */
    collisionQueryRangeFactor: 8,
    pathOptimizationRangeFactor: 30,
    /** NavAgentParams.separationWeight (0..1) × this = detour separation weight. */
    separationWeightScale: 2.5,
    /** Used when NavAgentParams.separationWeight is omitted. */
    defaultSeparation: 0.6,
    /**
     * Obstacle-avoidance presets (index = dtCrowd avoidance slot). Swarms of fast agents need
     * short horizons and few samples: 'swarm' is cheap and decisive, 'quality' is for few big
     * agents. 60 agents (every 10th a tank) chasing a moving target, retargeted every tick:
     * ~0.35 ms/tick avg, < 1 ms worst (wasm in node, calibration hall – NavSystem.testroom.test).
     */
    avoidance: [
      {
        velBias: 0.5,
        weightDesVel: 2,
        weightCurVel: 0.75,
        weightSide: 0.75,
        weightToi: 2.5,
        horizTime: 1.5,
        gridSize: 33,
        adaptiveDivs: 7,
        adaptiveRings: 2,
        adaptiveDepth: 2,
      },
      {
        velBias: 0.4,
        weightDesVel: 2,
        weightCurVel: 0.75,
        weightSide: 0.75,
        weightToi: 2.5,
        horizTime: 2.5,
        gridSize: 33,
        adaptiveDivs: 7,
        adaptiveRings: 3,
        adaptiveDepth: 3,
      },
    ] as readonly NavAvoidancePreset[],
    /** Preset index for agents at or below / above `qualityRadius` (m). */
    swarmAvoidance: 0,
    qualityAvoidance: 1,
    qualityRadius: 0.7,
    /**
     * Move-target throttling: a new target is only sent to detour when it moved more than
     * max(retargetMinDistance, distance-to-agent × retargetDistanceFraction) from the last one
     * (far agents do not need a precise goal; every request costs an A* search).
     */
    retargetMinDistance: 0.4,
    retargetDistanceFraction: 0.1,
    /** Pending move requests sent per tick (round-robin) – spreads a wave's A* spike. */
    maxTargetRequestsPerTick: 12,
  },
  /** Fallback when recast is unavailable: straight lines + separation, no pathing. */
  direct: {
    /** Stop steering within this distance of the target (m). */
    arriveDistance: 0.25,
    /** Decelerate linearly inside this distance (m). */
    slowdownDistance: 1.2,
    /** Separation acts within (rA + rB) × this. */
    separationRangeFactor: 1.6,
    /** Separation push in multiples of max speed at full overlap (× the agent's weight). */
    separationStrength: 1.5,
    /** Ground probe (optional physics ray): start this far above the agent (m), cast this far... */
    probeUp: 1,
    probeRange: 3,
    /** ...and re-probe each agent every N ticks (staggered). */
    probeInterval: 3,
  },
  debug: {
    /** sRGB hex (MeshBasicMaterial colors are converted to the working space). */
    fillColor: 0x19c2ff,
    fillOpacity: 0.28,
    wireColor: 0x7df9ff,
    wireOpacity: 0.55,
    /** Lift above the navmesh against z-fighting (m). */
    lift: 0.03,
  },
} as const;

/** NAV.build with numbers widened (tests / tools pass variations). */
export type NavBuildDefs = {
  readonly [K in keyof typeof NAV.build]: (typeof NAV.build)[K] extends number
    ? number
    : (typeof NAV.build)[K];
};
