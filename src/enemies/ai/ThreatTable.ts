/**
 * Aggro: who enemies hunt. Targets (the player now; decoys / turrets / co-op players later) register
 * with a threat bias. Every enemy keeps a small threat row (Float32Array, one entry per target slot):
 * damage from a target's side adds threat, threat decays over time, and the enemy picks the target
 * with the best `threat + bias − distance × distanceWeight`. A decoy with a big bias pulls aggro.
 *
 * The table also remembers the last gunshot noise (position + time) for hearing checks.
 */
import type { EnemyTargetApi } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';

export interface AggroConfig {
  readonly maxTargets: number;
  readonly damageThreat: number;
  readonly decay: number;
  readonly distanceWeight: number;
}

export interface NoiseEvent {
  x: number;
  y: number;
  z: number;
  /** Simulation time of the noise (−∞ = none yet). */
  time: number;
  /** Target slot that made it. */
  target: number;
}

export class ThreatTable {
  readonly maxTargets: number;
  private readonly targets: (EnemyTargetApi | null)[];
  private readonly bias: Float32Array;
  readonly noise: NoiseEvent = { x: 0, y: 0, z: 0, time: Number.NEGATIVE_INFINITY, target: -1 };

  constructor(private readonly cfg: AggroConfig) {
    this.maxTargets = Math.max(1, Math.floor(cfg.maxTargets));
    this.targets = new Array<EnemyTargetApi | null>(this.maxTargets).fill(null);
    this.bias = new Float32Array(this.maxTargets);
  }

  /** Register a target; returns its slot (-1 when full). Re-registering updates the bias. */
  register(target: EnemyTargetApi, bias: number): number {
    let slot = this.targets.indexOf(target);
    if (slot < 0) slot = this.targets.indexOf(null);
    if (slot < 0) return -1;
    this.targets[slot] = target;
    this.bias[slot] = bias;
    return slot;
  }

  unregister(target: EnemyTargetApi): void {
    const slot = this.targets.indexOf(target);
    if (slot >= 0) {
      this.targets[slot] = null;
      this.bias[slot] = 0;
    }
  }

  get(slot: number): EnemyTargetApi | null {
    return slot >= 0 && slot < this.maxTargets ? this.targets[slot]! : null;
  }

  slotOf(target: EnemyTargetApi): number {
    return this.targets.indexOf(target);
  }

  /** A fresh per-enemy threat row. */
  createRow(): Float32Array {
    return new Float32Array(this.maxTargets);
  }

  addThreat(row: Float32Array, slot: number, amount: number): void {
    if (slot >= 0 && slot < row.length && amount > 0 && Number.isFinite(amount))
      row[slot] = row[slot]! + amount;
  }

  addDamageThreat(row: Float32Array, slot: number, damage: number): void {
    this.addThreat(row, slot, damage * this.cfg.damageThreat);
  }

  decay(row: Float32Array, dt: number): void {
    const k = Math.exp(-this.cfg.decay * dt);
    for (let i = 0; i < row.length; i++) row[i] = row[i]! * k;
  }

  /** Best living target slot for an enemy at `from` (-1 = none alive). */
  select(row: Float32Array, from: Vec3Like): number {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.maxTargets; i++) {
      const t = this.targets[i];
      if (!t || !t.alive) continue;
      const d = Math.hypot(t.position.x - from.x, t.position.z - from.z);
      const score = (row[i] ?? 0) + this.bias[i]! - d * this.cfg.distanceWeight;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** A target made a noise (gunshot) at `p`. */
  makeNoise(p: Vec3Like, time: number, slot: number): void {
    const n = this.noise;
    n.x = p.x;
    n.y = p.y;
    n.z = p.z;
    n.time = time;
    n.target = slot;
  }

  clear(): void {
    this.targets.fill(null);
    this.bias.fill(0);
    this.noise.time = Number.NEGATIVE_INFINITY;
  }
}
