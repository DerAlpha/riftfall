/**
 * Timers of the timed power-ups (fixed table of ids, no allocation). Collecting an active one
 * refreshes it to its (new) full duration – timers never add up. Expiry is reported through the
 * callback of tick()/clear() in table order.
 */
export class PowerUpTimers {
  private readonly index = new Map<string, number>();
  private readonly left: Float64Array;
  private readonly full: Float64Array;
  /** Ids of running timers, table order (rebuilt only when the set changes). */
  private readonly _active: string[] = [];

  constructor(readonly ids: readonly string[]) {
    ids.forEach((id, i) => this.index.set(id, i));
    this.left = new Float64Array(ids.length);
    this.full = new Float64Array(ids.length);
  }

  /** Running timers (HUD), table order. */
  get active(): readonly string[] {
    return this._active;
  }

  isActive(id: string): boolean {
    const i = this.index.get(id);
    return i !== undefined && this.left[i]! > 0;
  }

  remaining(id: string): number {
    const i = this.index.get(id);
    return i === undefined ? 0 : Math.max(0, this.left[i]!);
  }

  /** Full duration of the running timer (0 when inactive). */
  duration(id: string): number {
    const i = this.index.get(id);
    return i === undefined || !(this.left[i]! > 0) ? 0 : this.full[i]!;
  }

  /** Start or refresh; returns true when it was not running (the caller applies the effect). */
  start(id: string, seconds: number): boolean {
    const i = this.index.get(id);
    if (i === undefined || !(seconds > 0) || !Number.isFinite(seconds)) return false;
    const fresh = !(this.left[i]! > 0);
    this.left[i] = seconds;
    this.full[i] = seconds;
    if (fresh) this.rebuild();
    return fresh;
  }

  /** Advance; `onExpire` runs for every timer that ran out. */
  tick(dt: number, onExpire: (id: string) => void): void {
    if (!(dt > 0)) return;
    let changed = false;
    for (let i = 0; i < this.left.length; i++) {
      if (!(this.left[i]! > 0)) continue;
      this.left[i] = this.left[i]! - dt;
      if (this.left[i]! <= 0) {
        this.left[i] = 0;
        this.full[i] = 0;
        changed = true;
        onExpire(this.ids[i]!);
      }
    }
    if (changed) this.rebuild();
  }

  /** Stop everything (new run); `onExpire` runs for each timer that was running. */
  clear(onExpire?: (id: string) => void): void {
    for (let i = 0; i < this.left.length; i++) {
      if (!(this.left[i]! > 0)) continue;
      this.left[i] = 0;
      this.full[i] = 0;
      onExpire?.(this.ids[i]!);
    }
    this.rebuild();
  }

  private rebuild(): void {
    this._active.length = 0;
    for (let i = 0; i < this.ids.length; i++) if (this.left[i]! > 0) this._active.push(this.ids[i]!);
  }
}
