/**
 * Fixed-timestep game loop with render interpolation ("Fix Your Timestep").
 *
 * - Simulation (physics, AI, movement) runs in `fixedUpdate` at exactly `tickRate` Hz.
 * - Rendering runs once per animation frame; `alpha` in [0,1) tells how far we are
 *   between the last two simulation states so visuals can be interpolated.
 * - `maxSubSteps` prevents the spiral of death on slow frames (time is dropped).
 */
import { ENGINE } from '../defs/engine';

export interface LoopCallbacks {
  /**
   * Once per frame BEFORE the fixed ticks (also while paused). Poll input and latch intents here so
   * the ticks of this very frame already see them (no extra frame of input latency).
   */
  beginFrame?(realDt: number): void;
  /** Fixed simulation step. `dt` is always 1 / tickRate (already time-scaled via tick count). */
  fixedUpdate(dt: number, tick: number): void;
  /** Once per frame before rendering. `dt` = scaled frame delta, `alpha` = interpolation factor. */
  update(dt: number, alpha: number): void;
  /** Once per frame. `realDt` is the unscaled frame delta in seconds. */
  render(realDt: number, alpha: number): void;
}

export interface LoopOptions {
  tickRate: number;
  maxSubSteps: number;
  /** Clamp for a single frame delta in seconds (tab switches, breakpoints...). */
  maxFrameDelta: number;
}

export interface LoopStats {
  /** Unscaled seconds of the last frame. */
  frameDelta: number;
  /** Fixed ticks executed during the last frame. */
  ticksLastFrame: number;
  /** Total fixed ticks executed. */
  tick: number;
  /** Seconds of simulated (scaled) time. */
  simTime: number;
  /** Ticks dropped because of maxSubSteps. */
  droppedTicks: number;
}

export class GameLoop {
  readonly fixedDt: number;
  /** Simulation speed multiplier (dev console `timescale`, slow-mo power-up later). */
  timeScale = 1;
  /** When paused, update/fixedUpdate are skipped but render still runs (menus over the scene). */
  paused = false;
  /** Optional frame limiter in FPS, 0 = unlimited (vsync). */
  fpsLimit = 0;

  readonly stats: LoopStats = { frameDelta: 0, ticksLastFrame: 0, tick: 0, simTime: 0, droppedTicks: 0 };

  private accumulator = 0;
  private lastTime = -1;
  private rafId = 0;
  private running = false;
  private limiterCarry = 0;

  constructor(
    private readonly cb: LoopCallbacks,
    private readonly opts: LoopOptions,
  ) {
    this.fixedDt = 1 / opts.tickRate;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = -1;
    const frame = (now: number): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      this.onAnimationFrame(now);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Drop accumulated time, e.g. after a long pause, so the sim does not jump. */
  resetAccumulator(): void {
    this.accumulator = 0;
    this.lastTime = -1;
  }

  private onAnimationFrame(nowMs: number): void {
    if (this.lastTime < 0) {
      this.lastTime = nowMs;
      return;
    }
    const deltaMs = nowMs - this.lastTime;
    if (this.fpsLimit > 0) {
      const budget = 1000 / this.fpsLimit;
      // Allow slight early frames (rAF jitter) by carrying the remainder.
      if (deltaMs + this.limiterCarry < budget * ENGINE.fpsLimiterTolerance) return;
      this.limiterCarry = Math.min(budget, Math.max(0, deltaMs + this.limiterCarry - budget));
    }
    this.lastTime = nowMs;
    this.advance(deltaMs / 1000);
  }

  /**
   * Advance the loop by a real (unscaled) delta. Public so tests and tools can drive
   * the loop deterministically without requestAnimationFrame.
   */
  advance(realDt: number): void {
    const frameDelta = Math.min(Math.max(realDt, 0), this.opts.maxFrameDelta);
    this.stats.frameDelta = frameDelta;
    let ticks = 0;
    this.cb.beginFrame?.(frameDelta);

    if (!this.paused) {
      this.accumulator += frameDelta * this.timeScale;
      while (this.accumulator >= this.fixedDt) {
        if (ticks >= this.opts.maxSubSteps) {
          const dropped = Math.floor(this.accumulator / this.fixedDt);
          this.stats.droppedTicks += dropped;
          this.accumulator -= dropped * this.fixedDt;
          break;
        }
        this.cb.fixedUpdate(this.fixedDt, this.stats.tick);
        this.stats.tick++;
        this.stats.simTime += this.fixedDt;
        this.accumulator -= this.fixedDt;
        ticks++;
      }
    }
    this.stats.ticksLastFrame = ticks;

    const alpha = this.paused ? 1 : this.accumulator / this.fixedDt;
    if (!this.paused) this.cb.update(frameDelta * this.timeScale, alpha);
    this.cb.render(frameDelta, alpha);
  }
}
