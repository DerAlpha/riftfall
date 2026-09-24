/** Token bucket rate limiter (`now` in seconds): `capacity` burst, `refillPerSecond` sustained. */
export class TokenBucket {
  private tokens: number;
  private last = Number.NaN;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(now: number): boolean {
    if (Number.isFinite(this.last) && now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerSecond);
    }
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
