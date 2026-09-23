/**
 * Wave director + run flow tuning (M3 classic mode, CoD Zombies-like).
 *
 * Every wave is computed from these curves (src/spawning/waveFormula.ts, pure + unit-tested):
 * - `total`: enemies per wave, base + linear·(w−1) + quadratic·(w−1)², capped,
 * - `maxAlive`: simultaneous enemies (24 early → 60 later; 60 is the M3 performance budget),
 * - `health` / `speed` / `damage`: spawn multipliers, linear up to `knee`, then ×`growth` per
 *   wave, capped (monotonic),
 * - type mix: `types` are "filler" types weighted per wave once unlocked; `specials` (tanks) come
 *   in fixed counts on their own schedule and are spread through the wave,
 * - `swarm`: every N waves a swarm wave (only swarmers, more of them, faster cadence),
 * - cadence: bursts of 1..n enemies from one rift every `interval` seconds while below maxAlive.
 *
 * M6 adds types by adding entries to `types` / `specials` (ids from defs/enemies). M8 modes add
 * more WaveModeDef entries. Units: seconds, meters.
 */

export interface WaveCountCurveDef {
  readonly base: number;
  readonly linear: number;
  readonly quadratic: number;
  readonly max: number;
}

export interface WaveLinearDef {
  readonly base: number;
  readonly perWave: number;
  readonly max: number;
}

/** Spawn multiplier: 1 + perWave·(min(w, knee) − 1), then ×growth per wave beyond `knee`, capped. */
export interface WaveMultiplierDef {
  readonly perWave: number;
  readonly knee: number;
  readonly growth: number;
  readonly max: number;
}

/** Weighted filler type (share of the non-special spawns). */
export interface WaveTypeDef {
  readonly id: string;
  readonly unlockWave: number;
  /** Weight = min(max, base + perWave·(w − unlockWave)). */
  readonly weight: WaveLinearDef;
}

/** Special type with its own schedule (tanks): count per scheduled wave, spread through the wave. */
export interface WaveSpecialDef {
  readonly id: string;
  readonly firstWave: number;
  /** Scheduled every `every` waves from firstWave (1 = every wave). */
  readonly every: number;
  /** Count = min(max, base + floor((w − firstWave) / growthEvery)). */
  readonly count: { readonly base: number; readonly growthEvery: number; readonly max: number };
  /** Placed evenly between these fractions of the spawn order (never the very first spawns). */
  readonly placement: readonly [number, number];
  /** A wave with this special is announced with this kind (HUD banner / wave:start `kind`). */
  readonly announce: boolean;
}

export interface SwarmWaveDef {
  readonly firstWave: number;
  readonly every: number;
  /** Only these types spawn (weights from `types`, unlock waves ignored). */
  readonly types: readonly string[];
  readonly totalMultiplier: number;
  readonly maxAliveMultiplier: number;
  readonly intervalMultiplier: number;
  readonly burstMultiplier: number;
  /** Applied on top of the wave's multipliers (swarmers come weaker but faster). */
  readonly healthMultiplier: number;
  readonly speedMultiplier: number;
}

export interface WaveCadenceDef {
  /** Seconds between bursts: max(min, base · decay^(w−1)). */
  readonly interval: { readonly base: number; readonly decay: number; readonly min: number };
  /** Burst size rng.int(min, maxOf(w)), maxOf(w) = min(cap, max + floor(perWave·(w−1))). */
  readonly burst: { readonly min: number; readonly max: number; readonly perWave: number; readonly cap: number };
  /** Seconds between the members of one burst (emergence staggered, spawn cost spread). */
  readonly memberGap: number;
  /** A failed spawn (pool / nav agent exhausted) ends the burst; the next try comes after this (s). */
  readonly retryDelay: number;
  /** Members spawn within this radius around the rift (m; the manager snaps them to the navmesh). */
  readonly spread: number;
}

export interface WaveModeDef {
  readonly id: string;
  /** Seconds before wave 1 and between waves. */
  readonly firstIntermission: number;
  readonly intermission: number;
  /** After wave:start, the first burst waits this long (the sting plays, the HUD banner shows). */
  readonly startDelay: number;
  readonly total: WaveCountCurveDef;
  readonly maxAlive: WaveLinearDef;
  readonly health: WaveMultiplierDef;
  readonly speed: WaveMultiplierDef;
  readonly damage: WaveMultiplierDef;
  readonly cadence: WaveCadenceDef;
  readonly types: readonly WaveTypeDef[];
  readonly specials: readonly WaveSpecialDef[];
  readonly swarm: SwarmWaveDef | null;
  /**
   * A queued spawn that fails this many times in a row (unknown type, no visual slot, no nav
   * agent) is dropped so the wave can still finish.
   */
  readonly maxSpawnFailures: number;
}

export const WAVES = {
  classic: {
    id: 'classic',
    firstIntermission: 6,
    intermission: 14,
    startDelay: 1.4,
    total: { base: 8, linear: 3.2, quadratic: 0.22, max: 150 },
    maxAlive: { base: 24, perWave: 3, max: 60 },
    health: { perWave: 0.1, knee: 10, growth: 1.06, max: 5 },
    speed: { perWave: 0.025, knee: 13, growth: 1, max: 1.3 },
    damage: { perWave: 0.05, knee: 20, growth: 1.02, max: 2.2 },
    cadence: {
      interval: { base: 2.2, decay: 0.93, min: 0.6 },
      burst: { min: 1, max: 3, perWave: 0.25, cap: 6 },
      memberGap: 0.2,
      retryDelay: 0.5,
      spread: 1.6,
    },
    types: [
      { id: 'swarmer', unlockWave: 1, weight: { base: 1, perWave: 0, max: 1 } },
      { id: 'spitter', unlockWave: 3, weight: { base: 0.18, perWave: 0.025, max: 0.45 } },
    ],
    specials: [
      {
        id: 'tank',
        firstWave: 5,
        every: 3,
        count: { base: 1, growthEvery: 6, max: 4 },
        placement: [0.25, 0.85],
        announce: true,
      },
    ],
    swarm: {
      firstWave: 6,
      every: 6,
      types: ['swarmer'],
      totalMultiplier: 1.6,
      maxAliveMultiplier: 1.25,
      intervalMultiplier: 0.5,
      burstMultiplier: 2,
      healthMultiplier: 0.75,
      speedMultiplier: 1.12,
    },
    maxSpawnFailures: 45,
  },
} as const satisfies Record<string, WaveModeDef>;

export type WaveModeId = keyof typeof WAVES;

/** Wave kinds (wave:start `kind`, HUD banner): 'normal', 'swarm' or an announced special's id. */
export type WaveKind = 'normal' | 'swarm' | (string & {});

/**
 * Spawn point selection (src/spawning/spawnPoints.ts): active zones only, a distance band around
 * the player, points in view (camera frustum + optional line of sight) are penalized, the previous
 * point is skipped when another one qualifies.
 */
export interface SpawnPointRules {
  /** Distance band from the player's feet (m). */
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Best distance; the score drops by `distanceWeight` per meter away from it. */
  readonly preferredDistance: number;
  readonly distanceWeight: number;
  /** Score penalty of a point the player can see. */
  readonly visiblePenalty: number;
  /** Random score jitter 0..jitter (seeded; spreads bursts over similar points). */
  readonly jitter: number;
  /** Visibility probe: a sphere this high above the point with this radius (m). */
  readonly probeHeight: number;
  readonly probeRadius: number;
  /** Line-of-sight rays per selection (points beyond count as visible: conservative). */
  readonly maxLosChecks: number;
  /**
   * No point in the band: the one closest to it wins; a meter too close weighs this much more
   * than a meter too far (a rift next to the player is unfair, a far one only slow).
   */
  readonly tooCloseWeight: number;
  /** Without spawn points (or none in an active zone): random nav point this far from the player. */
  readonly fallbackRadius: number;
}

export const SPAWN_POINTS: SpawnPointRules = {
  minDistance: 9,
  maxDistance: 48,
  preferredDistance: 20,
  distanceWeight: 1,
  visiblePenalty: 30,
  jitter: 6,
  probeHeight: 1,
  probeRadius: 1.2,
  maxLosChecks: 8,
  tooCloseWeight: 4,
  fallbackRadius: 22,
};

/** Run flow (src/modes): death sequence, score. */
export const RUN = {
  /** Mode id reported in run:over. */
  defaultMode: 'classic',
  death: {
    /** Time scale right after death, eased to `endScale` over `easeSeconds` (real seconds). */
    slowScale: 0.3,
    endScale: 0.12,
    easeSeconds: 1.8,
    /** Time-scale changes smaller than this are not pushed. */
    scaleEpsilon: 0.005,
    /** Camera drop duration handed to the camera callback (real seconds). */
    cameraDropSeconds: 1.3,
    /** Real seconds from death to run:over + the game over screen. */
    gameOverDelay: 2.4,
  },
  score: {
    /** Kill points: the enemy def's `points` (kill + head/weakpoint bonus); unknown types use these. */
    defaultKill: 50,
    defaultHeadshotBonus: 25,
    defaultWeakpointBonus: 25,
    /** Per completed wave. */
    waveBonus: 400,
    /** Per second survived. */
    perSecond: 2,
    /** Per kill at 100 % accuracy (scaled by accuracy). */
    accuracyPerKill: 20,
  },
} as const;
