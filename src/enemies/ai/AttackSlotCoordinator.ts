/**
 * Melee attack tokens around one target – Left-4-Dead-style pressure without unfair burst damage.
 *
 * - At most `maxTokens` token units are held at once (a tank's swing costs 2, a swarmer's bite 1).
 * - Waiting enemies are served by priority, then first come, first served (strict order: a big
 *   enemy waiting for two units is not starved by small ones, and a tank next to the player does not
 *   queue behind a whole swarm). A request is a heartbeat: waiters that stop asking for
 *   `requestTimeout` seconds drop out of the queue.
 * - Tokens rotate: after `holdTime` seconds or `attacksPerToken` attacks the holder gives it back
 *   at its next request and waits `rerequestDelay` before asking again, so others move in.
 * - Melee attack starts are spaced by `minAttackSpacing` (no simultaneous bites).
 *
 * Fixed arrays, no allocations after construction. Ids are enemy (Damageable) ids.
 */
export interface SlotConfig {
  readonly maxTokens: number;
  readonly holdTime: number;
  readonly attacksPerToken: number;
  readonly minAttackSpacing: number;
  readonly requestTimeout: number;
  readonly rerequestDelay: number;
}

export class AttackSlotCoordinator {
  maxTokens: number;
  private readonly cfg: SlotConfig;
  private readonly capacity: number;

  private readonly holderId: Int32Array;
  private readonly holderCost: Int32Array;
  private readonly holderSince: Float64Array;
  private readonly holderSeen: Float64Array;
  private readonly holderAttacks: Int32Array;
  private holderCount = 0;
  private used = 0;

  private readonly waitId: Int32Array;
  private readonly waitSince: Float64Array;
  private readonly waitSeen: Float64Array;
  private readonly waitPriority: Float64Array;
  private waitCount = 0;

  /** Recently released holders and when they may ask again. */
  private readonly blockId: Int32Array;
  private readonly blockUntil: Float64Array;
  private blockCount = 0;

  private lastAttackStart = Number.NEGATIVE_INFINITY;

  constructor(cfg: SlotConfig, capacity: number) {
    this.cfg = cfg;
    this.maxTokens = cfg.maxTokens;
    this.capacity = Math.max(1, capacity);
    const n = this.capacity;
    this.holderId = new Int32Array(n);
    this.holderCost = new Int32Array(n);
    this.holderSince = new Float64Array(n);
    this.holderSeen = new Float64Array(n);
    this.holderAttacks = new Int32Array(n);
    this.waitId = new Int32Array(n);
    this.waitSince = new Float64Array(n);
    this.waitSeen = new Float64Array(n);
    this.waitPriority = new Float64Array(n);
    this.blockId = new Int32Array(n);
    this.blockUntil = new Float64Array(n);
  }

  /** Token units in use. */
  get inUse(): number {
    return this.used;
  }

  get holders(): number {
    return this.holderCount;
  }

  get waiting(): number {
    return this.waitCount;
  }

  holds(id: number): boolean {
    return this.holderIndex(id) >= 0;
  }

  /**
   * Keep or obtain a token (call every think while engaging). Returns true while `id` holds one.
   * An expired token (hold time / attack count) is returned here and false is reported. Higher
   * `priority` waiters are served first.
   */
  request(id: number, cost: number, now: number, priority = 0): boolean {
    const units = Math.max(1, Math.round(cost));
    const h = this.holderIndex(id);
    if (h >= 0) {
      const expired =
        now - this.holderSince[h]! >= this.cfg.holdTime || this.holderAttacks[h]! >= this.cfg.attacksPerToken;
      if (!expired) {
        this.holderSeen[h] = now;
        return true;
      }
      this.release(id, now);
      return false;
    }
    if (now < this.blockedUntil(id)) return false;
    this.expireWaiters(now);
    let w = this.waitIndex(id);
    if (w < 0) {
      if (this.waitCount >= this.capacity) return false;
      w = this.waitCount++;
      this.waitId[w] = id;
      this.waitSince[w] = now;
    }
    this.waitSeen[w] = now;
    this.waitPriority[w] = Number.isFinite(priority) ? priority : 0;
    // Strict order: only the head waiter (highest priority, then oldest) may take free tokens.
    if (this.headWaiter() !== w) return false;
    if (this.maxTokens - this.used < units || this.holderCount >= this.capacity) return false;
    this.removeWaiter(w);
    const i = this.holderCount++;
    this.holderId[i] = id;
    this.holderCost[i] = units;
    this.holderSince[i] = now;
    this.holderSeen[i] = now;
    this.holderAttacks[i] = 0;
    this.used += units;
    return true;
  }

  /** Give the token back; the enemy waits `rerequestDelay` before asking again. */
  release(id: number, now: number): void {
    const h = this.holderIndex(id);
    if (h >= 0) {
      this.removeHolder(h);
      this.block(id, now + this.cfg.rerequestDelay);
    }
  }

  /** Forget `id` completely (death, despawn, lost interest): token and queue place, no delay. */
  cancel(id: number): void {
    const h = this.holderIndex(id);
    if (h >= 0) this.removeHolder(h);
    const w = this.waitIndex(id);
    if (w >= 0) this.removeWaiter(w);
    const b = this.blockIndex(id);
    if (b >= 0) this.removeBlock(b);
  }

  /** May a melee attack start now (spacing between attack starts around this target)? */
  canStartAttack(now: number): boolean {
    return now - this.lastAttackStart >= this.cfg.minAttackSpacing;
  }

  /** A melee attack started (holder `id` spends one of its attacks). */
  noteAttack(id: number, now: number): void {
    this.lastAttackStart = now;
    const h = this.holderIndex(id);
    if (h >= 0) this.holderAttacks[h] = this.holderAttacks[h]! + 1;
  }

  /** Housekeeping once per tick: holders that stopped asking (stuck in a long state) expire. */
  update(now: number): void {
    const stale = this.cfg.holdTime * 2;
    for (let i = this.holderCount - 1; i >= 0; i--) {
      if (now - this.holderSeen[i]! > stale) this.removeHolder(i);
    }
    this.expireWaiters(now);
    for (let i = this.blockCount - 1; i >= 0; i--) {
      if (now >= this.blockUntil[i]!) this.removeBlock(i);
    }
  }

  reset(): void {
    this.holderCount = 0;
    this.used = 0;
    this.waitCount = 0;
    this.blockCount = 0;
    this.lastAttackStart = Number.NEGATIVE_INFINITY;
  }

  private holderIndex(id: number): number {
    for (let i = 0; i < this.holderCount; i++) if (this.holderId[i] === id) return i;
    return -1;
  }

  private waitIndex(id: number): number {
    for (let i = 0; i < this.waitCount; i++) if (this.waitId[i] === id) return i;
    return -1;
  }

  private blockIndex(id: number): number {
    for (let i = 0; i < this.blockCount; i++) if (this.blockId[i] === id) return i;
    return -1;
  }

  private blockedUntil(id: number): number {
    const b = this.blockIndex(id);
    return b >= 0 ? this.blockUntil[b]! : Number.NEGATIVE_INFINITY;
  }

  private block(id: number, until: number): void {
    let b = this.blockIndex(id);
    if (b < 0) {
      if (this.blockCount >= this.capacity) return;
      b = this.blockCount++;
      this.blockId[b] = id;
    }
    this.blockUntil[b] = until;
  }

  private headWaiter(): number {
    let best = -1;
    let prio = Number.NEGATIVE_INFINITY;
    let since = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.waitCount; i++) {
      const p = this.waitPriority[i]!;
      const t = this.waitSince[i]!;
      if (p > prio || (p === prio && t < since)) {
        prio = p;
        since = t;
        best = i;
      }
    }
    return best;
  }

  private expireWaiters(now: number): void {
    for (let i = this.waitCount - 1; i >= 0; i--) {
      if (now - this.waitSeen[i]! > this.cfg.requestTimeout) this.removeWaiter(i);
    }
  }

  private removeHolder(i: number): void {
    this.used -= this.holderCost[i]!;
    const last = --this.holderCount;
    this.holderId[i] = this.holderId[last]!;
    this.holderCost[i] = this.holderCost[last]!;
    this.holderSince[i] = this.holderSince[last]!;
    this.holderSeen[i] = this.holderSeen[last]!;
    this.holderAttacks[i] = this.holderAttacks[last]!;
  }

  private removeWaiter(i: number): void {
    const last = --this.waitCount;
    this.waitId[i] = this.waitId[last]!;
    this.waitSince[i] = this.waitSince[last]!;
    this.waitSeen[i] = this.waitSeen[last]!;
    this.waitPriority[i] = this.waitPriority[last]!;
  }

  private removeBlock(i: number): void {
    const last = --this.blockCount;
    this.blockId[i] = this.blockId[last]!;
    this.blockUntil[i] = this.blockUntil[last]!;
  }
}
