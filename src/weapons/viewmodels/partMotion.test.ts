import { describe, expect, it } from 'vitest';
import { DEG2RAD } from '../../core/math';
import type { PartMotionDef } from '../../defs/viewmodels';
import { createPose } from './animMath';
import {
  createPartMotionState,
  partOffset,
  resetPartMotion,
  startPartMotion,
  stepPartMotion,
} from './partMotion';

const SLIDE: PartMotionDef = {
  part: 'slide',
  type: 'pulse',
  pose: { pos: { x: 0, y: 0, z: 0.03 } },
  duration: 0.02,
  hold: 0.01,
  release: 0.05,
};
const LOCK: PartMotionDef = {
  part: 'slide',
  type: 'tween',
  pose: { pos: { x: 0, y: 0, z: 0.03 } },
  duration: 0.02,
};
const HOME: PartMotionDef = { part: 'slide', type: 'tween', pose: {}, duration: 0.04, ease: 'linear' };

/** Advance exactly `seconds` in steps of about `dt`. */
function run(s: ReturnType<typeof createPartMotionState>, seconds: number, dt = 1 / 240): void {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) stepPartMotion(s, seconds / n);
}

describe('partMotion', () => {
  it('pulses out and back to rest', () => {
    const s = createPartMotionState();
    const out = createPose();
    startPartMotion(s, SLIDE);
    run(s, 0.02);
    expect(partOffset(s, out).pz).toBeCloseTo(0.03, 4);
    run(s, 0.1);
    expect(partOffset(s, out).pz).toBe(0);
    expect(s.pulseDef).toBeNull();
    expect(stepPartMotion(s, 0.01)).toBe(false);
  });

  it('restarting the same pulse continues from its current value (no pop)', () => {
    const s = createPartMotionState();
    const out = createPose();
    startPartMotion(s, SLIDE);
    run(s, 0.045); // part-way through the release
    const before = partOffset(s, out).pz;
    expect(before).toBeGreaterThan(0.001);
    startPartMotion(s, SLIDE);
    stepPartMotion(s, 1e-6);
    expect(Math.abs(partOffset(s, out).pz - before)).toBeLessThan(1e-3);
  });

  it('tweens latch and can be released', () => {
    const s = createPartMotionState();
    const out = createPose();
    startPartMotion(s, LOCK);
    run(s, 0.05);
    expect(partOffset(s, out).pz).toBeCloseTo(0.03, 9);
    run(s, 1);
    expect(partOffset(s, out).pz).toBeCloseTo(0.03, 9);
    startPartMotion(s, HOME);
    run(s, 0.02);
    expect(partOffset(s, out).pz).toBeCloseTo(0.015, 3);
    run(s, 0.05);
    expect(partOffset(s, out).pz).toBe(0);
  });

  it('pulses add on top of a latched base', () => {
    const s = createPartMotionState();
    const out = createPose();
    startPartMotion(s, LOCK);
    run(s, 0.05);
    startPartMotion(s, SLIDE);
    run(s, 0.025);
    expect(partOffset(s, out).pz).toBeCloseTo(0.06, 3);
  });

  it('honours delays, `from`, show and hideAtEnd', () => {
    const s = createPartMotionState(false);
    const out = createPose();
    const shell: PartMotionDef = {
      part: 'shell',
      type: 'tween',
      from: { pos: { x: 0, y: -0.07, z: 0 }, rot: { x: 30, y: 0, z: 0 } },
      pose: { pos: { x: 0, y: 0, z: -0.05 } },
      delay: 0.05,
      duration: 0.2,
      show: true,
      hideAtEnd: true,
    };
    startPartMotion(s, shell);
    run(s, 0.04);
    expect(s.visible).toBe(false);
    expect(partOffset(s, out).py).toBe(0);
    run(s, 0.02);
    expect(s.visible).toBe(true);
    expect(partOffset(s, out).py).toBeLessThan(-0.06);
    expect(partOffset(s, out).rx).toBeGreaterThan(25 * DEG2RAD);
    run(s, 0.25);
    expect(s.visible).toBe(false);
    expect(partOffset(s, out).pz).toBeCloseTo(-0.05, 9);
    resetPartMotion(s);
    expect(partOffset(s, out).pz).toBe(0);
    expect(s.visible).toBe(false);
  });

  it('is frame-rate independent', () => {
    const at = (dt: number): number => {
      const s = createPartMotionState();
      startPartMotion(s, { ...LOCK, duration: 0.1, ease: 'inOut' });
      run(s, 0.05, dt);
      return partOffset(s, createPose()).pz;
    };
    const ref = at(1 / 1000);
    for (const fps of [30, 60, 144]) expect(Math.abs(at(1 / fps) - ref)).toBeLessThan(0.03 * 0.25);
  });
});
