import { describe, expect, it } from 'vitest';
import { DEG2RAD } from '../../core/math';
import { CAMERA } from '../../defs/camera';
import { springImpulseForPeak } from '../../player/cameraMath';
import {
  addPoseImpulse,
  createPose,
  createPoseSpring,
  ease,
  envelope,
  poseAddDef,
  poseFromDef,
  poseLerp,
  pulseValue,
  samplePoseTrack,
  stepPoseSpring,
  createTimeWarp,
  timeWarpAdd,
  timeWarpApply,
  timeWarpReset,
  type EaseName,
  type PoseKeyDef,
} from './animMath';

const EASES: readonly EaseName[] = ['linear', 'in', 'out', 'inOut', 'outBack', 'snap'];
const TUNING = { posStiffness: 400, posDamping: 26, rotStiffness: 300, rotDamping: 22 } as const;

describe('ease', () => {
  it('maps 0 → 0 and 1 → 1 and clamps outside the unit range', () => {
    for (const e of EASES) {
      expect(ease(e, 0)).toBeCloseTo(0, 9);
      expect(ease(e, 1)).toBeCloseTo(1, 9);
      expect(ease(e, -3)).toBeCloseTo(0, 9);
      expect(ease(e, 7)).toBeCloseTo(1, 9);
    }
  });

  it('is monotonic except for the overshooting outBack', () => {
    for (const e of EASES) {
      let prev = -Infinity;
      let max = 0;
      for (let i = 0; i <= 100; i++) {
        const v = ease(e, i / 100);
        max = Math.max(max, v);
        if (e !== 'outBack') expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
      if (e === 'outBack') expect(max).toBeGreaterThan(1.05);
    }
  });

  it('snap front-loads the motion, in back-loads it', () => {
    expect(ease('snap', 0.3)).toBeGreaterThan(0.85);
    expect(ease('in', 0.3)).toBeLessThan(0.05);
    expect(ease('inOut', 0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('pulseValue', () => {
  it('rises over attack, holds, then returns to zero', () => {
    const a = 0.02;
    const h = 0.01;
    const r = 0.05;
    expect(pulseValue(-0.1, a, h, r)).toBe(0);
    expect(pulseValue(a, a, h, r)).toBe(1);
    expect(pulseValue(a + h * 0.5, a, h, r)).toBe(1);
    expect(pulseValue(a + h + r * 0.5, a, h, r, 0, 'snap', 'linear')).toBeCloseTo(0.5, 9);
    expect(pulseValue(a + h + r, a, h, r)).toBe(0);
    expect(pulseValue(10, a, h, r)).toBe(0);
  });

  it('continues from a start value (restart without a pop)', () => {
    expect(pulseValue(0, 0.02, 0, 0.05, 0.6)).toBeCloseTo(0.6, 9);
    expect(pulseValue(-1, 0.02, 0, 0.05, 0.6)).toBeCloseTo(0.6, 9);
    expect(pulseValue(0.02, 0.02, 0, 0.05, 0.6)).toBe(1);
  });

  it('handles zero-length phases', () => {
    expect(pulseValue(0, 0, 0, 0)).toBe(0);
    expect(pulseValue(0, 0, 0.1, 0)).toBe(1);
  });
});

describe('envelope', () => {
  it('fades in and out and is zero outside 0..1', () => {
    expect(envelope(0, 0.2, 0.2)).toBe(0);
    expect(envelope(1, 0.2, 0.2)).toBe(0);
    expect(envelope(0.5, 0.2, 0.2)).toBe(1);
    expect(envelope(0.1, 0.2, 0.2)).toBeCloseTo(0.5, 9);
    expect(envelope(0.95, 0.2, 0.2)).toBeLessThan(0.5);
  });
});

describe('poses', () => {
  it('converts def degrees to radians and scales', () => {
    const p = poseFromDef(createPose(), { pos: { x: 0.1, y: 0, z: -0.2 }, rot: { x: 90, y: 0, z: -45 } }, 2);
    expect(p.px).toBeCloseTo(0.2, 9);
    expect(p.pz).toBeCloseTo(-0.4, 9);
    expect(p.rx).toBeCloseTo(Math.PI, 9);
    expect(p.rz).toBeCloseTo(-90 * DEG2RAD, 9);
    const q = poseAddDef(createPose(), { rot: { x: 10, y: 0, z: 0 } }, 0.5);
    expect(q.rx).toBeCloseTo(5 * DEG2RAD, 9);
    expect(q.px).toBe(0);
    const l = poseLerp(createPose(), createPose(), p, 0.25);
    expect(l.px).toBeCloseTo(0.05, 9);
  });

  it('samples pose tracks: rest outside, exact at keys, smooth between', () => {
    const keys: PoseKeyDef[] = [
      { t: 0.2, pos: { x: 0.1, y: 0, z: 0 }, rot: { x: 10, y: 0, z: 0 } },
      { t: 0.6, pos: { x: -0.1, y: 0, z: 0 } },
    ];
    const out = createPose();
    expect(samplePoseTrack(out, keys, 0).px).toBe(0);
    expect(samplePoseTrack(out, keys, 0.2).px).toBeCloseTo(0.1, 9);
    expect(samplePoseTrack(out, keys, 0.2).rx).toBeCloseTo(10 * DEG2RAD, 9);
    expect(samplePoseTrack(out, keys, 0.4).px).toBeCloseTo(0, 9);
    expect(samplePoseTrack(out, keys, 0.6).px).toBeCloseTo(-0.1, 9);
    expect(samplePoseTrack(out, keys, 0.6).rx).toBeCloseTo(0, 9);
    expect(samplePoseTrack(out, keys, 1).px).toBeCloseTo(0, 9);
    // Blending in before the first key is smooth (half-way → half the pose).
    expect(samplePoseTrack(out, keys, 0.1).px).toBeCloseTo(0.05, 9);
    expect(samplePoseTrack(out, [], 0.5).px).toBe(0);
  });
});

describe('pose springs', () => {
  it('an impulse for peak p peaks near p and returns to rest', () => {
    const s = createPoseSpring();
    const peak = createPose();
    peak.pz = 0.04;
    peak.rx = 8 * DEG2RAD;
    addPoseImpulse(
      s,
      peak,
      springImpulseForPeak(1, TUNING.posStiffness, TUNING.posDamping),
      springImpulseForPeak(1, TUNING.rotStiffness, TUNING.rotDamping),
    );
    const out = createPose();
    let maxZ = 0;
    let maxX = 0;
    for (let t = 0; t < 2; t += 1 / 240) {
      stepPoseSpring(s, null, TUNING, 1 / 240, CAMERA.maxSpringStep, out);
      maxZ = Math.max(maxZ, out.pz);
      maxX = Math.max(maxX, out.rx);
    }
    expect(maxZ).toBeGreaterThan(0.04 * 0.9);
    expect(maxZ).toBeLessThan(0.04 * 1.05);
    expect(maxX).toBeGreaterThan(8 * DEG2RAD * 0.9);
    expect(Math.abs(out.pz)).toBeLessThan(1e-4);
  });

  it('is frame-rate independent (sub-stepped)', () => {
    const run = (fps: number): number => {
      const s = createPoseSpring();
      const target = createPose();
      target.py = 0.1;
      const out = createPose();
      const n = Math.round(0.1 * fps);
      for (let i = 0; i < n; i++) stepPoseSpring(s, target, TUNING, 0.1 / n, CAMERA.maxSpringStep, out);
      return out.py;
    };
    const ref = run(240);
    for (const fps of [20, 30, 60, 144]) expect(Math.abs(run(fps) - ref)).toBeLessThan(0.1 * 0.03);
  });
});

describe('time warp', () => {
  it('is the identity without anchors and outside 0..1', () => {
    const w = createTimeWarp();
    for (const t of [-0.5, 0, 0.3, 1, 1.4]) expect(timeWarpApply(w, t)).toBe(t);
    timeWarpAdd(w, 0.2, 0.4);
    expect(timeWarpApply(w, -0.1)).toBe(-0.1);
    expect(timeWarpApply(w, 1.2)).toBe(1.2);
  });

  it('maps each anchor exactly and interpolates linearly between them', () => {
    const w = createTimeWarp();
    expect(timeWarpAdd(w, 0.25, 0.2)).toBe(true);
    expect(timeWarpAdd(w, 0.5, 0.7)).toBe(true);
    expect(timeWarpApply(w, 0.25)).toBeCloseTo(0.2, 12);
    expect(timeWarpApply(w, 0.5)).toBeCloseTo(0.7, 12);
    expect(timeWarpApply(w, 0.125)).toBeCloseTo(0.1, 12);
    expect(timeWarpApply(w, 0.375)).toBeCloseTo(0.45, 12);
    expect(timeWarpApply(w, 0.75)).toBeCloseTo(0.85, 12);
    // Monotonic over the whole range.
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = timeWarpApply(w, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('skips anchors that would break monotonicity, fall outside (0, 1) or overflow', () => {
    const w = createTimeWarp(2);
    expect(timeWarpAdd(w, 0.5, 0.5)).toBe(true);
    expect(timeWarpAdd(w, 0.4, 0.6)).toBe(false);
    expect(timeWarpAdd(w, 0.6, 0.45)).toBe(false);
    expect(timeWarpAdd(w, 0, 0.1)).toBe(false);
    expect(timeWarpAdd(w, 0.7, 1)).toBe(false);
    expect(timeWarpAdd(w, 0.7, 0.8)).toBe(true);
    expect(timeWarpAdd(w, 0.9, 0.95)).toBe(false);
    expect(w.n).toBe(2);
    timeWarpReset(w);
    expect(w.n).toBe(0);
    expect(timeWarpApply(w, 0.3)).toBe(0.3);
  });

  it('lands an authored key on a moved marker (reload retimed in defs/weapons)', () => {
    // Keys authored with the magazine seated at 0.6; the weapon now seats it at 0.45.
    const keys: PoseKeyDef[] = [{ t: 0.6, pos: { x: 0, y: 0.1, z: 0 } }];
    const w = createTimeWarp();
    timeWarpAdd(w, 0.45, 0.6);
    const out = createPose();
    samplePoseTrack(out, keys, timeWarpApply(w, 0.45));
    expect(out.py).toBeCloseTo(0.1, 12);
  });
});
