/**
 * Dynamic resolution controller (pure logic, no DOM/WebGL): watches frame (or GPU) time and
 * steps the render scale between `minScale` and the user's render scale.
 *
 * - EMA-smoothed load metric, compared against the frame budget with hysteresis
 *   (down above budget * downThreshold, up below budget * upThreshold).
 * - Adjusts at most every `adjustInterval` seconds (render-target reallocation is not free).
 * - Ignores the first `warmupSeconds` after start / reset (shader compilation spikes).
 * - Isolated hitches (a few frames far above budget: tab switch, GC, streaming) are ignored and
 *   samples are capped, so spikes do not cost resolution while sustained overload still does.
 * - GPU time (EXT_disjoint_timer_query) is preferred when available because it reveals
 *   headroom even when the frame time is pinned to vsync. Without it, the controller probes
 *   one step up after `probeSeconds` of stable frames and backs off exponentially when the
 *   probe immediately fails.
 * - Without GPU time, a frame time that does not improve over `displayBoundSteps` consecutive
 *   down-steps is display/rAF- or CPU-bound: the scale is restored and that frame time becomes a
 *   floor for the budget (a 50 Hz panel or a 30 FPS rAF cap never drags the scale to minScale).
 * - Raising the cap (render scale / preset) or enabling the controller starts at the new cap.
 */
import { DYNAMIC_RESOLUTION } from '../defs/graphics';

export interface DynamicResolutionConfig {
  minScale: number;
  step: number;
  adjustInterval: number;
  downThreshold: number;
  upThreshold: number;
  emaAlpha: number;
  warmupSeconds: number;
  probeSeconds: number;
  probeBackoffMax: number;
  /** Samples are capped at budget * this; longer frames count as hitches. */
  maxSampleBudgetRatio: number;
  /** Up to this many consecutive hitch frames are ignored (isolated spikes never cost resolution). */
  spikeToleranceFrames: number;
  /** Consecutive frame-time down-steps without improvement before the load counts as display-bound (0 = off). */
  displayBoundSteps: number;
  /** "Improvement" = smoothed frame time below the sequence start * this. */
  displayBoundImprovement: number;
}

export interface DynamicResolutionOptions {
  enabled: boolean;
  targetFps: number;
  /** Upper bound (the user's render scale). */
  maxScale: number;
}

/** Scales are snapped to this grid to avoid float drift (0.05 steps => 1/1000 is plenty). */
const SNAP = 1000;

function snap(v: number): number {
  return Math.round(v * SNAP) / SNAP;
}

export class DynamicResolutionController {
  private _scale = 1;
  private enabled = false;
  private targetFps = 60;
  private maxScale = 1;

  private time = 0;
  private sinceAdjust = 0;
  private stableTime = 0;
  private probeBackoff = 1;
  private lastWasProbe = false;
  private frameEma = 0;
  private gpuEma = 0;
  private hasFrameEma = false;
  private hasGpuEma = false;
  private spikeFrames = 0;
  /** Scale / smoothed frame time when the current run of consecutive down-steps began (-1: none). */
  private downStartScale = -1;
  private downStartMs = 0;
  /** Frame time the display / rAF / CPU cannot go below (ms, 0 = unknown); raises the budget. */
  private budgetFloorMs = 0;

  constructor(private readonly config: DynamicResolutionConfig = DYNAMIC_RESOLUTION) {}

  /** Current scale in [minScale, maxScale] (equals maxScale while disabled). */
  get scale(): number {
    return this._scale;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Frame budget (ms): the target frame time, raised to a detected display / rAF limit. */
  get budgetMs(): number {
    return Math.max(1000 / this.targetFps, this.budgetFloorMs);
  }

  /** Apply settings. Returns true if the scale changed. */
  configure(opts: DynamicResolutionOptions): boolean {
    const prev = this._scale;
    const prevMax = this.maxScale;
    const wasEnabled = this.enabled;
    this.enabled = opts.enabled;
    this.targetFps = Math.max(1, opts.targetFps);
    this.maxScale = Math.max(this.config.minScale, opts.maxScale);
    if (!this.enabled || !wasEnabled || this.maxScale > prevMax) {
      // Raised cap / newly enabled: start at the cap and let the controller scale down if needed
      // (climbing back one probe at a time would show the new preset blurry for minutes).
      this._scale = this.maxScale;
      this.probeBackoff = 1;
    } else {
      this._scale = snap(Math.min(this.maxScale, Math.max(this.config.minScale, this._scale)));
    }
    // New target / settings: a previously detected display limit has to be measured again.
    this.budgetFloorMs = 0;
    this.reset();
    return this._scale !== prev;
  }

  /** Force a scale (e.g. benchmark wants full resolution). Clamped to the configured range. */
  setScale(scale: number): boolean {
    const prev = this._scale;
    this._scale = snap(Math.min(this.maxScale, Math.max(this.config.minScale, scale)));
    return this._scale !== prev;
  }

  /** Restart warmup and forget smoothed history (after resize / settings change). */
  reset(): void {
    this.time = 0;
    this.sinceAdjust = 0;
    this.stableTime = 0;
    this.lastWasProbe = false;
    this.hasFrameEma = false;
    this.hasGpuEma = false;
    this.frameEma = 0;
    this.gpuEma = 0;
    this.spikeFrames = 0;
    this.downStartScale = -1;
  }

  /**
   * Feed one frame. `dt` in seconds, `gpuMs` the GPU frame time in ms or a negative value if
   * unknown. Returns true if the scale changed this frame.
   */
  update(dt: number, gpuMs = -1): boolean {
    if (!this.enabled || !(dt > 0)) return false;
    const c = this.config;
    const maxSampleMs = this.budgetMs * c.maxSampleBudgetRatio;
    const rawMs = dt * 1000;
    // Isolated hitches (tab switch, GC, streaming) are skipped entirely; only a run of slow frames counts.
    if (rawMs > maxSampleMs) {
      this.spikeFrames++;
      if (this.spikeFrames <= c.spikeToleranceFrames) return false;
    } else {
      this.spikeFrames = 0;
    }
    const frameMs = Math.min(rawMs, maxSampleMs);

    this.time += dt;
    if (this.time < c.warmupSeconds) return false;

    this.frameEma = this.hasFrameEma ? this.frameEma + c.emaAlpha * (frameMs - this.frameEma) : frameMs;
    this.hasFrameEma = true;
    if (gpuMs >= 0 && Number.isFinite(gpuMs)) {
      const g = Math.min(gpuMs, maxSampleMs);
      this.gpuEma = this.hasGpuEma ? this.gpuEma + c.emaAlpha * (g - this.gpuEma) : g;
      this.hasGpuEma = true;
    }

    this.sinceAdjust += dt;
    if (this.sinceAdjust < c.adjustInterval) return false;

    // Frames clearly faster than the floor: the display is faster than measured (e.g. moved screens).
    if (this.budgetFloorMs > 0 && this.frameEma < this.budgetFloorMs * c.upThreshold) this.budgetFloorMs = 0;
    const budgetMs = this.budgetMs;
    const useGpu = this.hasGpuEma;
    const load = useGpu ? this.gpuEma : this.frameEma;
    const prev = this._scale;

    if (load > budgetMs * c.downThreshold) {
      // A probe that immediately overloads was a false alarm: wait longer before the next one.
      if (this.lastWasProbe) this.probeBackoff = Math.min(c.probeBackoffMax, this.probeBackoff * 2);
      if (!useGpu && this.isDisplayBound()) {
        // Lower resolution did not make frames faster: give the resolution back, raise the budget.
        this.budgetFloorMs = this.frameEma;
        this._scale = this.downStartScale;
        this.downStartScale = -1;
      } else {
        if (useGpu) this.downStartScale = -1;
        else if (this.downStartScale < 0) {
          this.downStartScale = this._scale;
          this.downStartMs = this.frameEma;
        }
        this._scale = snap(Math.max(c.minScale, this._scale - c.step));
      }
      this.stableTime = 0;
      this.lastWasProbe = false;
    } else if (load < budgetMs * c.upThreshold) {
      this.downStartScale = -1;
      this._scale = snap(Math.min(this.maxScale, this._scale + c.step));
      this.stableTime = 0;
      this.lastWasProbe = false;
      this.probeBackoff = 1;
    } else {
      this.downStartScale = -1;
      this.lastWasProbe = false;
      this.stableTime += this.sinceAdjust;
      if (!useGpu && this._scale < this.maxScale && this.stableTime >= c.probeSeconds * this.probeBackoff) {
        this._scale = snap(Math.min(this.maxScale, this._scale + c.step));
        this.stableTime = 0;
        this.lastWasProbe = true;
      }
    }

    this.sinceAdjust = 0;
    return this._scale !== prev;
  }

  /**
   * True when the current run of down-steps went `displayBoundSteps` deep (or hit minScale) and
   * the smoothed frame time did not improve meaningfully since the run started.
   */
  private isDisplayBound(): boolean {
    const c = this.config;
    if (c.displayBoundSteps <= 0 || this.downStartScale < 0) return false;
    const depth = Math.min(c.displayBoundSteps * c.step, this.downStartScale - c.minScale);
    if (!(depth > 0)) return false;
    const stepped = this.downStartScale - this._scale;
    return stepped >= depth - 1 / SNAP && this.frameEma > this.downStartMs * c.displayBoundImprovement;
  }
}
