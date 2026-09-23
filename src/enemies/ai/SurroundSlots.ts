/**
 * Surround slots around one target: `slotCount` bearings (world angles, radians, atan2(z, x)) that
 * swarmers spread over so a pack encircles the player instead of queueing up in a line. Choosing a
 * slot is a cost minimisation (pure `slotCost`): being in the player's view cone costs (flankers
 * prefer the sides and the back), crowded slots cost, the distance to walk costs, keeping the
 * current slot is cheaper (hysteresis). The caller refines the cheapest candidates with the real nav
 * path length (walls!) when its path budget allows.
 */
export interface SurroundConfig {
  readonly slotCount: number;
  readonly frontPenalty: number;
  readonly occupancyPenalty: number;
  readonly distanceWeight: number;
  readonly hysteresis: number;
}

const TAU = Math.PI * 2;

/**
 * Cost of standing at bearing `angle` around a target that faces `facing` (world angle of its view
 * direction, same convention). `frontness` goes 1 (straight in front) → 0 (straight behind).
 */
export function slotCost(
  angle: number,
  facing: number,
  occupants: number,
  walkDistance: number,
  current: boolean,
  cfg: SurroundConfig,
): number {
  const frontness = (1 + Math.cos(angle - facing)) / 2;
  return (
    cfg.frontPenalty * frontness * frontness +
    cfg.occupancyPenalty * occupants +
    cfg.distanceWeight * walkDistance -
    (current ? cfg.hysteresis : 0)
  );
}

/** World bearing (atan2(z, x)) of a yaw in the three.js convention (forward = (sin yaw, cos yaw)). */
export function yawToBearing(yaw: number): number {
  return Math.atan2(Math.cos(yaw), Math.sin(yaw));
}

export class SurroundSlots {
  readonly count: number;
  private readonly occupants: Int32Array;
  /** Scratch: candidate slot indices sorted by cost (cheapest first) after rank(). */
  readonly ranked: Int32Array;
  readonly rankedCost: Float64Array;

  constructor(private readonly cfg: SurroundConfig) {
    this.count = Math.max(1, Math.floor(cfg.slotCount));
    this.occupants = new Int32Array(this.count);
    this.ranked = new Int32Array(this.count);
    this.rankedCost = new Float64Array(this.count);
  }

  /** World bearing of slot i. */
  angle(i: number): number {
    return (i / this.count) * TAU;
  }

  occupancy(i: number): number {
    return i >= 0 && i < this.count ? this.occupants[i]! : 0;
  }

  claim(i: number): void {
    if (i >= 0 && i < this.count) this.occupants[i] = this.occupants[i]! + 1;
  }

  release(i: number): void {
    if (i >= 0 && i < this.count && this.occupants[i]! > 0) this.occupants[i] = this.occupants[i]! - 1;
  }

  reset(): void {
    this.occupants.fill(0);
  }

  /**
   * Rank all slots for an enemy at (x, z) currently holding `current` (-1 = none) around a target
   * at (tx, tz) facing bearing `facing`, standing `radius` from it. Fills `ranked`/`rankedCost`
   * (cheapest first) and returns the cheapest slot.
   */
  rank(
    x: number,
    z: number,
    current: number,
    tx: number,
    tz: number,
    facing: number,
    radius: number,
  ): number {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const a = this.angle(i);
      const sx = tx + Math.cos(a) * radius;
      const sz = tz + Math.sin(a) * radius;
      const occ = this.occupants[i]! - (i === current ? 1 : 0);
      const cost = slotCost(a, facing, occ, Math.hypot(sx - x, sz - z), i === current, this.cfg);
      // Insertion sort (n ≈ 10).
      let j = i;
      while (j > 0 && this.rankedCost[j - 1]! > cost) {
        this.rankedCost[j] = this.rankedCost[j - 1]!;
        this.ranked[j] = this.ranked[j - 1]!;
        j--;
      }
      this.rankedCost[j] = cost;
      this.ranked[j] = i;
    }
    return this.ranked[0]!;
  }
}
