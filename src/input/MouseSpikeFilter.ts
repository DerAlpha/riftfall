/**
 * Rejects bogus pointer-lock mouse deltas. Browsers deliver a huge first event after locking
 * (the cursor-to-center jump) and some Chrome builds emit isolated large spikes. Genuine fast
 * flicks ramp up over several events, so a single event far above the recent average is dropped;
 * a sustained run of large events is accepted after `maxConsecutive` rejections.
 */
export interface SpikeFilterConfig {
  lockSettleMs: number;
  skipEventsAfterLock: number;
  spikeMinCounts: number;
  spikeRatio: number;
  spikeEmaAlpha: number;
  maxConsecutiveSpikes: number;
}

export class MouseSpikeFilter {
  private lockedAt = Number.NEGATIVE_INFINITY;
  private skipped = 0;
  private ema = 0;
  private rejects = 0;
  /** Diagnostics: total events dropped. */
  droppedEvents = 0;

  constructor(private readonly cfg: SpikeFilterConfig) {}

  /** Call when pointer lock was (re)acquired. */
  onLock(now: number): void {
    this.lockedAt = now;
    this.skipped = 0;
    this.ema = 0;
    this.rejects = 0;
  }

  /** Returns true if the event delta should be applied. */
  accept(dx: number, dy: number, now: number): boolean {
    const c = this.cfg;
    if (this.skipped < c.skipEventsAfterLock || now - this.lockedAt < c.lockSettleMs) {
      this.skipped++;
      this.droppedEvents++;
      return false;
    }
    const mag = Math.abs(dx) + Math.abs(dy);
    if (mag > c.spikeMinCounts && mag > this.ema * c.spikeRatio && this.rejects < c.maxConsecutiveSpikes) {
      this.rejects++;
      this.droppedEvents++;
      return false;
    }
    this.rejects = 0;
    this.ema += (mag - this.ema) * c.spikeEmaAlpha;
    return true;
  }
}
