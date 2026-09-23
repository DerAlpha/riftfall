import { describe, expect, it } from 'vitest';
import { POSTFX } from '../../defs/postfx';
import { heartbeatPulse } from './heartbeat';

const SHAPE = POSTFX.lowHealth;
const F = 1.5;

describe('heartbeatPulse', () => {
  it('peaks at the start of each period and has a weaker second beat', () => {
    expect(heartbeatPulse(0, F, SHAPE)).toBeCloseTo(1, 6);
    expect(heartbeatPulse(2 / F, F, SHAPE)).toBeCloseTo(1, 6);
    const second = heartbeatPulse(SHAPE.secondBeatDelay / F, F, SHAPE);
    expect(second).toBeGreaterThan(SHAPE.secondBeatStrength * 0.95);
    expect(second).toBeLessThan(1);
  });

  it('rests between beats and stays within 0..1', () => {
    expect(heartbeatPulse(0.6 / F, F, SHAPE)).toBeLessThan(0.05);
    for (let i = 0; i <= 200; i++) {
      const v = heartbeatPulse(i * 0.013, F, SHAPE);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is continuous across the period boundary', () => {
    const eps = 1e-4;
    expect(
      Math.abs(heartbeatPulse(1 / F - eps, F, SHAPE) - heartbeatPulse(1 / F + eps, F, SHAPE)),
    ).toBeLessThan(1e-2);
  });

  it('degrades gracefully on invalid input', () => {
    expect(heartbeatPulse(Number.NaN, F, SHAPE)).toBe(0);
    expect(heartbeatPulse(1, 0, SHAPE)).toBe(0);
  });
});
