/**
 * Generic object pool. Used for projectiles, particles, decals, enemies, audio voices.
 * Objects are never garbage collected during gameplay: `acquire` recycles, `release`
 * returns. When `maxSize` is reached, `acquire` recycles the oldest active item
 * (if `recycleOldest`) or returns null.
 */
export interface PoolOptions<T> {
  create: () => T;
  /** Called when an object is handed out. */
  reset?: (item: T) => void;
  /** Called when an object is returned (hide mesh, stop sound, ...). */
  onRelease?: (item: T) => void;
  initialSize?: number;
  maxSize?: number;
  /** When full, steal the oldest active object instead of failing. */
  recycleOldest?: boolean;
}

export class Pool<T> {
  private readonly free: T[] = [];
  private readonly active: T[] = [];
  private readonly opts: Required<Omit<PoolOptions<T>, 'reset' | 'onRelease'>> &
    Pick<PoolOptions<T>, 'reset' | 'onRelease'>;

  constructor(opts: PoolOptions<T>) {
    this.opts = {
      initialSize: 0,
      maxSize: Number.POSITIVE_INFINITY,
      recycleOldest: false,
      ...opts,
    };
    for (let i = 0; i < this.opts.initialSize; i++) this.free.push(this.opts.create());
  }

  get activeCount(): number {
    return this.active.length;
  }

  get freeCount(): number {
    return this.free.length;
  }

  get totalCount(): number {
    return this.active.length + this.free.length;
  }

  /** Read-only view of active objects (do not mutate while iterating + releasing; use forEachActive). */
  get activeItems(): readonly T[] {
    return this.active;
  }

  acquire(): T | null {
    let item: T | undefined = this.free.pop();
    if (item === undefined) {
      if (this.totalCount < this.opts.maxSize) {
        item = this.opts.create();
      } else if (this.opts.recycleOldest && this.active.length > 0) {
        item = this.active.shift() as T;
        this.opts.onRelease?.(item);
      } else {
        return null;
      }
    }
    this.opts.reset?.(item);
    this.active.push(item);
    return item;
  }

  release(item: T): boolean {
    const idx = this.active.indexOf(item);
    if (idx < 0) return false;
    // Swap-remove would break "oldest first" ordering used by recycleOldest; splice keeps order.
    this.active.splice(idx, 1);
    this.opts.onRelease?.(item);
    this.free.push(item);
    return true;
  }

  /** Iterate active items; the callback may return true to release the item. */
  forEachActive(fn: (item: T) => boolean | void): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i] as T;
      if (fn(item) === true) {
        this.active.splice(i, 1);
        this.opts.onRelease?.(item);
        this.free.push(item);
      }
    }
  }

  releaseAll(): void {
    while (this.active.length > 0) {
      const item = this.active.pop() as T;
      this.opts.onRelease?.(item);
      this.free.push(item);
    }
  }
}
