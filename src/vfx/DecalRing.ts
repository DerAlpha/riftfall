/**
 * Ring buffer bookkeeping for decals (pure, unit-tested). New decals overwrite the oldest slot
 * once the ring is full; the decal `fadeAhead` spawns away from being overwritten is told to fade
 * out, so old decals dissolve instead of popping.
 */
export interface DecalAllocation {
  /** Slot to write the new decal into. */
  slot: number;
  /** Slot that should start fading now, or -1. */
  fadeSlot: number;
}

export class DecalRing {
  private head = 0;
  private used = 0;
  private _capacity: number;

  constructor(
    readonly maxCapacity: number,
    capacity: number = maxCapacity,
    private readonly fadeAhead = 0,
  ) {
    this._capacity = DecalRing.clampCapacity(capacity, maxCapacity);
  }

  private static clampCapacity(n: number, max: number): number {
    return Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : max)));
  }

  get capacity(): number {
    return this._capacity;
  }

  /** Occupied slots (0..capacity). Slots [0, used) are live once the ring wrapped. */
  get count(): number {
    return this.used;
  }

  /** Highest slot index + 1 that may hold a decal (draw range). */
  get drawCount(): number {
    return this.used;
  }

  /** Change the capacity; clears the ring (slot layout changes). */
  setCapacity(n: number): void {
    this._capacity = DecalRing.clampCapacity(n, this.maxCapacity);
    this.clear();
  }

  clear(): void {
    this.head = 0;
    this.used = 0;
  }

  /** Reserve the next slot. Returns null when the capacity is 0. */
  allocate(out: DecalAllocation): DecalAllocation | null {
    const cap = this._capacity;
    if (cap <= 0) return null;
    const slot = this.head;
    this.head = (this.head + 1) % cap;
    if (this.used < cap) this.used++;
    out.slot = slot;
    out.fadeSlot = -1;
    const ahead = Math.min(this.fadeAhead, cap - 1);
    if (ahead > 0) {
      // The slot that will be overwritten `ahead` allocations from now – if it holds a decal
      // (occupied slots are [0, used) until the ring wraps, then all of them).
      const fade = (slot + ahead) % cap;
      if (fade < this.used) out.fadeSlot = fade;
    }
    return out;
  }
}
