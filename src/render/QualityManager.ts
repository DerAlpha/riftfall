/**
 * Quality management: GPU identification, hardware-based preset detection, dynamic resolution
 * and the first-run benchmark. Owned by RenderSystem, which feeds it GPU timings and applies
 * the resolution scale (it polls `resolutionScale` every frame).
 */
import type * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { QualityApi } from '../core/contracts';
import { createLogger } from '../core/log';
import { AUTO_DETECT, DYNAMIC_RESOLUTION } from '../defs/graphics';
import type { GraphicsSettings, QualityPreset } from '../save/settingsSchema';
import { DynamicResolutionController } from './dynamicResolution';
import { detectPresetFromHardware, lowerPreset, type HardwareInfo } from './qualityDetect';

const log = createLogger('Quality');

interface BenchmarkState {
  current: QualityPreset;
  /** Wall-clock time fed so far, including discarded frames (drives the timeout). */
  elapsed: number;
  warmup: number;
  time: number;
  frames: number;
  resolve: (p: QualityPreset | null) => void;
  promise: Promise<QualityPreset | null>;
}

interface NavigatorHints {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

function readGpuName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const unmasked: unknown = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    if (typeof unmasked === 'string' && unmasked.length > 0) return unmasked;
    const masked: unknown = gl.getParameter(gl.RENDERER);
    if (typeof masked === 'string' && masked.length > 0) return masked;
  } catch (err) {
    log.warn('Could not query GPU name', err);
  }
  return 'unknown';
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const hints = navigator as Navigator & NavigatorHints;
  if (typeof hints.userAgentData?.mobile === 'boolean') return hints.userAgentData.mobile;
  const ua = navigator.userAgent || '';
  // iPadOS reports a desktop Safari UA but has touch points.
  const iPad = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return iPad || /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
}

export class QualityManager implements QualityApi {
  readonly gpuName: string;
  private readonly dynres = new DynamicResolutionController(DYNAMIC_RESOLUTION);
  private gpuMs = -1;
  private targetFps = 60;
  private benchmark: BenchmarkState | null = null;
  /** User setting; the controller is additionally disabled while the benchmark runs. */
  private requestedDynres = false;
  private lastOptions = { enabled: false, targetFps: 60, maxScale: 1 };

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly events: EventBus<GameEvents>,
  ) {
    this.gpuName = readGpuName(renderer);
  }

  get resolutionScale(): number {
    return this.dynres.scale;
  }

  /** Apply graphics settings (dynamic resolution bounds, target frame rate incl. the fps limiter). */
  configure(g: Readonly<GraphicsSettings>): void {
    // A frame limiter below the target would otherwise read as "too slow" and drive the scale down.
    const target = g.fpsLimit > 0 ? Math.min(g.targetFps, g.fpsLimit) : g.targetFps;
    this.targetFps = Math.max(1, target);
    this.requestedDynres = g.dynamicResolution;
    this.lastOptions = {
      enabled: g.dynamicResolution && !this.benchmark,
      targetFps: this.targetFps,
      maxScale: g.renderScale,
    };
    if (this.dynres.configure(this.lastOptions)) this.emitScale();
  }

  /** GPU frame time from timer queries (ms), or negative when unavailable. */
  reportGpuTime(ms: number): void {
    this.gpuMs = ms;
  }

  /** Window/canvas resize: restart the warmup (allocation + recompiles spike the next frames). */
  notifyResize(): void {
    this.dynres.reset();
  }

  detectPreset(): QualityPreset {
    const info = this.collectHardwareInfo();
    const preset = detectPresetFromHardware(info);
    log.info(
      `Hardware: gpu="${info.gpu}" cores=${info.cores} mem=${info.memoryGb}GB ` +
        `pixels=${info.screenPixels} mobile=${info.mobile} → preset "${preset}"`,
    );
    return preset;
  }

  onFrame(realDt: number): void {
    if (this.benchmark) this.stepBenchmark(realDt);
    if (this.dynres.update(realDt, this.gpuMs)) this.emitScale();
  }

  runBenchmark(current: QualityPreset): Promise<QualityPreset | null> {
    if (this.benchmark) return this.benchmark.promise;
    // Nothing to recommend below the lowest preset: do not give up dynamic resolution to measure.
    if (lowerPreset(current) === null) return Promise.resolve(null);
    let resolve!: (p: QualityPreset | null) => void;
    const promise = new Promise<QualityPreset | null>((r) => (resolve = r));
    this.benchmark = { current, elapsed: 0, warmup: 0, time: 0, frames: 0, resolve, promise };
    // Measure the preset honestly: full resolution, no dynamic scaling while benchmarking.
    if (this.dynres.configure({ ...this.lastOptions, enabled: false })) this.emitScale();
    return promise;
  }

  dispose(): void {
    this.benchmark?.resolve(null);
    this.benchmark = null;
  }

  // ---------------------------------------------------------------------------

  private stepBenchmark(dt: number): void {
    const b = this.benchmark!;
    if (!(dt > 0)) return;
    const cfg = AUTO_DETECT;
    const threshold = this.targetFps * cfg.benchmarkDowngradeRatio;
    b.elapsed += dt;
    // Hitches are discarded below, so a device where every frame is one (≤ 5 FPS) would never
    // finish – and keep dynamic resolution off for the whole session, every session.
    if (b.elapsed >= (cfg.benchmarkWarmupSeconds + cfg.benchmarkSeconds) * cfg.benchmarkTimeoutFactor) {
      const fps = b.time > 0 ? b.frames / b.time : 0;
      log.info(`Benchmark timed out after ${b.elapsed.toFixed(1)} s (${b.frames} usable frames)`);
      this.finishBenchmark(b, fps < threshold ? lowerPreset(b.current) : null);
      return;
    }
    if (dt > cfg.benchmarkMaxFrameSeconds) return;
    if (b.warmup < cfg.benchmarkWarmupSeconds) {
      b.warmup += dt;
      return;
    }
    b.time += dt;
    b.frames++;
    if (b.time < cfg.benchmarkSeconds) return;

    const avgFps = b.frames / b.time;
    const result = avgFps < threshold ? lowerPreset(b.current) : null;
    log.info(
      `Benchmark: ${avgFps.toFixed(1)} FPS avg on "${b.current}" (threshold ${threshold.toFixed(1)})` +
        (result ? ` → recommend "${result}"` : ' → keep'),
    );
    this.finishBenchmark(b, result);
  }

  private finishBenchmark(b: BenchmarkState, result: QualityPreset | null): void {
    this.benchmark = null;
    // Restore dynamic resolution as configured by the user.
    this.lastOptions = { ...this.lastOptions, enabled: this.requestedDynres };
    if (this.dynres.configure(this.lastOptions)) this.emitScale();
    b.resolve(result);
  }

  private emitScale(): void {
    this.events.emit('quality:resolutionScale', { scale: this.dynres.scale });
  }

  private collectHardwareInfo(): HardwareInfo {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & NavigatorHints) : null;
    let screenPixels = 0;
    if (typeof window !== 'undefined' && window.screen) {
      const dpr = window.devicePixelRatio || 1;
      screenPixels = Math.round(window.screen.width * window.screen.height * dpr * dpr);
    }
    return {
      gpu: this.gpuName,
      cores: nav?.hardwareConcurrency ?? 0,
      memoryGb: nav?.deviceMemory ?? 0,
      screenPixels,
      mobile: isMobileDevice(),
    };
  }
}
