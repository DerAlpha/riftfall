import { describe, expect, it } from 'vitest';
import { DynamicResolutionController, type DynamicResolutionConfig } from './dynamicResolution';

const CONFIG: DynamicResolutionConfig = {
  minScale: 0.5,
  step: 0.05,
  adjustInterval: 0.5,
  downThreshold: 1.08,
  upThreshold: 0.82,
  emaAlpha: 0.5,
  warmupSeconds: 1,
  probeSeconds: 4,
  probeBackoffMax: 4,
  maxSampleBudgetRatio: 3,
  spikeToleranceFrames: 2,
};

const TARGET = 60;
const BUDGET = 1 / TARGET;

function make(maxScale = 1, enabled = true): DynamicResolutionController {
  const c = new DynamicResolutionController(CONFIG);
  c.configure({ enabled, targetFps: TARGET, maxScale });
  return c;
}

/** Feed `seconds` worth of frames of duration `dt`; returns number of scale changes. */
function run(c: DynamicResolutionController, dt: number, seconds: number, gpuMs = -1): number {
  let changes = 0;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) if (c.update(dt, gpuMs)) changes++;
  return changes;
}

/** Feed frames until the scale changes (or `maxSeconds` pass); returns the elapsed time. */
function runUntilChange(c: DynamicResolutionController, dt: number, maxSeconds: number, gpuMs = -1): number {
  let t = 0;
  while (t < maxSeconds) {
    t += dt;
    if (c.update(dt, gpuMs)) break;
  }
  return t;
}

describe('DynamicResolutionController', () => {
  it('starts at max scale and ignores frames during warmup', () => {
    const c = make(1);
    expect(c.scale).toBe(1);
    expect(run(c, BUDGET * 3, 0.9)).toBe(0);
    expect(c.scale).toBe(1);
  });

  it('scales down under load, one step per interval, clamped to minScale', () => {
    const c = make(1);
    run(c, BUDGET * 2, CONFIG.warmupSeconds);
    run(c, BUDGET * 2, CONFIG.adjustInterval + 0.05);
    expect(c.scale).toBeCloseTo(0.95, 5);
    run(c, BUDGET * 2, 30);
    expect(c.scale).toBe(CONFIG.minScale);
  });

  it('holds the scale inside the hysteresis band', () => {
    const c = make(1);
    run(c, BUDGET * 2, 3);
    const s = c.scale;
    // Exactly on budget: neither above down threshold nor below up threshold.
    run(c, BUDGET, 3);
    expect(c.scale).toBe(s);
  });

  it('scales back up when there is headroom, never above maxScale', () => {
    const c = make(0.8);
    run(c, BUDGET * 2, 10);
    expect(c.scale).toBe(CONFIG.minScale);
    run(c, BUDGET * 0.5, 30);
    expect(c.scale).toBeCloseTo(0.8, 5);
  });

  it('prefers GPU time: vsync-pinned frame time with a cheap GPU still scales up', () => {
    const c = make(1);
    run(c, BUDGET * 2, 10);
    const low = c.scale;
    expect(low).toBeLessThan(1);
    run(c, BUDGET, 5, BUDGET * 1000 * 0.5);
    expect(c.scale).toBeGreaterThan(low);
  });

  it('GPU overload scales down even at on-budget frame time', () => {
    const c = make(1);
    run(c, BUDGET, 3, BUDGET * 1000 * 1.5);
    expect(c.scale).toBeLessThan(1);
  });

  it('probes upwards when frame time is pinned to the budget without GPU timing', () => {
    const c = make(1);
    run(c, BUDGET * 2, 5);
    const low = c.scale;
    run(c, BUDGET, CONFIG.probeSeconds + CONFIG.adjustInterval * 2 + 0.2);
    expect(c.scale).toBeGreaterThan(low);
  });

  it('backs off after a failed probe', () => {
    const c = make(1);
    run(c, BUDGET * 2, 5);
    const low = c.scale;
    // Stable → probe up after ~probeSeconds.
    const t1 = runUntilChange(c, BUDGET, 30);
    expect(c.scale).toBeGreaterThan(low);
    // (the first stable evaluation may include up to one interval of the preceding frames)
    expect(t1).toBeGreaterThanOrEqual(CONFIG.probeSeconds - CONFIG.adjustInterval);
    // The probe immediately overloads → back down and double the wait.
    runUntilChange(c, BUDGET * 2, 5);
    expect(c.scale).toBeCloseTo(low, 5);
    const t2 = runUntilChange(c, BUDGET, 60);
    expect(c.scale).toBeGreaterThan(low);
    expect(t2).toBeGreaterThanOrEqual(CONFIG.probeSeconds * 2 - CONFIG.adjustInterval);
    expect(t2).toBeGreaterThan(t1 * 1.5);
  });

  it('disabled: fixed at maxScale and never changes', () => {
    const c = make(0.75, false);
    expect(c.scale).toBe(0.75);
    expect(run(c, BUDGET * 3, 10)).toBe(0);
    expect(c.scale).toBe(0.75);
    expect(c.isEnabled).toBe(false);
  });

  it('configure clamps the current scale and reports changes', () => {
    const c = make(1);
    run(c, BUDGET * 2, 10);
    expect(c.scale).toBe(0.5);
    expect(c.configure({ enabled: false, targetFps: TARGET, maxScale: 0.9 })).toBe(true);
    expect(c.scale).toBe(0.9);
    expect(c.configure({ enabled: true, targetFps: TARGET, maxScale: 0.6 })).toBe(true);
    expect(c.scale).toBe(0.6);
    expect(c.configure({ enabled: true, targetFps: TARGET, maxScale: 0.6 })).toBe(false);
  });

  it('reset restarts the warmup', () => {
    const c = make(1);
    run(c, BUDGET, 2);
    c.reset();
    expect(run(c, BUDGET * 3, 0.9)).toBe(0);
    expect(c.scale).toBe(1);
  });

  it('a single long hitch does not cost resolution, sustained overload still does', () => {
    const c = make(1);
    run(c, BUDGET, CONFIG.warmupSeconds + 0.1);
    // A 5 s frame (tab switch) and a short double hitch, each followed by normal frames.
    expect(c.update(5, -1)).toBe(false);
    run(c, BUDGET, 1);
    c.update(0.2, -1);
    c.update(0.2, -1);
    run(c, BUDGET, 3);
    expect(c.scale).toBe(1);
    // Sustained 10 FPS (far above the sample cap) must still scale down.
    run(c, 0.1, 3);
    expect(c.scale).toBeLessThan(1);
  });

  it('ignores zero / invalid frame deltas', () => {
    const c = make(1);
    expect(c.update(0)).toBe(false);
    expect(c.update(Number.NaN)).toBe(false);
    expect(c.update(-1)).toBe(false);
  });

  it('keeps scales on a clean grid (no float drift)', () => {
    const c = make(1);
    run(c, BUDGET * 2, 4);
    const s = c.scale;
    expect(Math.round(s * 1000) / 1000).toBe(s);
  });
});
