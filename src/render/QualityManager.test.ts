import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { AUTO_DETECT } from '../defs/graphics';
import { createDefaultSettings, type GraphicsSettings } from '../save/settingsSchema';
import { QualityManager } from './QualityManager';

/** No WebGL in tests: the GPU name query fails and falls back to 'unknown'. */
const NO_GL = {
  getContext: () => {
    throw new Error('no WebGL in tests');
  },
} as unknown as THREE.WebGLRenderer;

function setup(patch: Partial<GraphicsSettings> = {}): { q: QualityManager; scales: number[] } {
  const events = new EventBus<GameEvents>();
  const scales: number[] = [];
  events.on('quality:resolutionScale', ({ scale }) => scales.push(scale));
  const q = new QualityManager(NO_GL, events);
  q.configure({ ...createDefaultSettings().graphics, dynamicResolution: true, targetFps: 60, ...patch });
  return { q, scales };
}

/** Feed frames of `dt` until the promise settles or `maxSeconds` pass. */
async function feedUntilSettled<T>(
  q: QualityManager,
  promise: Promise<T>,
  dt: number,
  maxSeconds: number,
): Promise<{ settled: boolean; value: T | undefined }> {
  let settled = false;
  let value: T | undefined;
  void promise.then((v) => {
    settled = true;
    value = v;
  });
  for (let t = 0; t < maxSeconds && !settled; t += dt) {
    q.onFrame(dt);
    await Promise.resolve();
  }
  await Promise.resolve();
  return { settled, value };
}

/** True if slow frames make dynamic resolution step down (i.e. the controller is enabled). */
function dynresReacts(q: QualityManager, scales: number[], seconds = 10): boolean {
  scales.length = 0;
  for (let t = 0; t < seconds; t += 0.05) q.onFrame(0.05);
  return scales.some((s) => s < 1);
}

describe('QualityManager benchmark', () => {
  it('recommends one preset lower when the average frame rate is below the threshold', async () => {
    const { q } = setup();
    const r = await feedUntilSettled(q, q.runBenchmark('high'), 1 / 30, 30);
    expect(r).toEqual({ settled: true, value: 'medium' });
  });

  it('keeps the preset at the target frame rate', async () => {
    const { q } = setup();
    const r = await feedUntilSettled(q, q.runBenchmark('high'), 1 / 60, 30);
    expect(r).toEqual({ settled: true, value: null });
  });

  it('finishes on devices where every frame is a hitch (≤ 5 FPS) and re-enables dynamic resolution', async () => {
    const { q, scales } = setup();
    const limit =
      (AUTO_DETECT.benchmarkWarmupSeconds + AUTO_DETECT.benchmarkSeconds) *
      AUTO_DETECT.benchmarkTimeoutFactor;
    // GameLoop clamps frame deltas to 0.25 s: longer than benchmarkMaxFrameSeconds, never counted.
    const r = await feedUntilSettled(q, q.runBenchmark('high'), 0.25, limit + 1);
    expect(r).toEqual({ settled: true, value: 'medium' });
    expect(dynresReacts(q, scales)).toBe(true);
  });

  it('dynamic resolution is off while measuring', () => {
    const { q, scales } = setup();
    void q.runBenchmark('high');
    // Shorter than warmup + measurement, long enough for the controller to act if it were enabled.
    const window = AUTO_DETECT.benchmarkWarmupSeconds + AUTO_DETECT.benchmarkSeconds - 0.5;
    expect(dynresReacts(q, scales, window)).toBe(false);
  });

  it('on the lowest preset resolves immediately without disabling dynamic resolution', async () => {
    const { q, scales } = setup({ renderScale: 0.75 });
    await expect(q.runBenchmark('low')).resolves.toBeNull();
    expect(dynresReacts(q, scales)).toBe(true);
  });

  it('a later configure() keeps the user setting after the benchmark', async () => {
    const { q, scales } = setup();
    await feedUntilSettled(q, q.runBenchmark('ultra'), 0.25, 60);
    q.configure({ ...createDefaultSettings().graphics, dynamicResolution: true });
    expect(dynresReacts(q, scales)).toBe(true);
  });
});
