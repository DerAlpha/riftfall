import { describe, expect, it } from 'vitest';
import { DEG2RAD } from '../core/math';
import { GAMEPAD } from '../defs/input';
import { aimError, applyAimAssist, inAssistWindow, type AimError } from './aimAssist';

const rules = GAMEPAD.aimAssist;
const eye = { x: 0, y: 0, z: 0 };

function errorTo(x: number, y: number, z: number, yaw = 0, pitch = 0): AimError {
  const e: AimError = { yaw: 0, pitch: 0, angle: 0, distance: 0 };
  expect(aimError(eye, yaw, pitch, { x, y, z }, e)).toBe(true);
  return e;
}

describe('aimError', () => {
  it('computes signed yaw/pitch errors in three.js conventions', () => {
    const ahead = errorTo(0, 0, -10);
    expect(ahead.angle).toBeCloseTo(0, 9);
    expect(ahead.distance).toBeCloseTo(10, 9);
    // Target to the left (-X) needs a positive yaw turn.
    const left = errorTo(-1, 0, -10);
    expect(left.yaw).toBeGreaterThan(0);
    const above = errorTo(0, 1, -10);
    expect(above.pitch).toBeGreaterThan(0);
    expect(above.angle).toBeCloseTo(Math.atan(0.1), 9);
    const e: AimError = { yaw: 0, pitch: 0, angle: 0, distance: 0 };
    expect(aimError(eye, 0, 0, eye, e)).toBe(false);
  });
});

describe('applyAimAssist', () => {
  it('does nothing outside the window or beyond max range', () => {
    const far = errorTo(0, 0, -(rules.maxRange + 5));
    const look = { yaw: 0.01, pitch: 0 };
    expect(inAssistWindow(far, rules)).toBe(false);
    expect(applyAimAssist(look, far, rules)).toBe(1);
    expect(look.yaw).toBe(0.01);
    const wide = errorTo(-10, 0, -10);
    expect(inAssistWindow(wide, rules)).toBe(false);
  });

  it('slows the look near the target, strongest at the center', () => {
    const center = errorTo(0, 0, -10);
    const look = { yaw: 0.01, pitch: 0 };
    const scale = applyAimAssist(look, center, rules);
    expect(scale).toBeCloseTo(rules.slowdownFactor, 6);
    const edgeAngle = rules.slowdownRadiusDeg * 0.9 * DEG2RAD;
    const edge = errorTo(-Math.tan(edgeAngle) * 10, 0, -10);
    const look2 = { yaw: 0.01, pitch: 0 };
    expect(applyAimAssist(look2, edge, rules)).toBeGreaterThan(scale);
  });

  it('magnetism pulls towards the target only while the stick moves, never past it', () => {
    const angle = rules.magnetismDeg * 0.5 * DEG2RAD;
    const err = errorTo(-Math.tan(angle) * 10, 0, -10); // target slightly left
    const still = { yaw: 0, pitch: 0 };
    applyAimAssist(still, err, rules);
    expect(still.yaw).toBe(0);
    expect(still.pitch).toBe(0);
    // Turning right (away): the pull reduces the turn (look yaw becomes smaller).
    const away = { yaw: 0.02, pitch: 0 };
    applyAimAssist(away, err, rules);
    expect(away.yaw).toBeLessThan(0.02);
    // Turning up while the target is left: gets a leftward (negative) component.
    const up = { yaw: 0, pitch: 0.02 };
    applyAimAssist(up, err, rules);
    expect(up.yaw).toBeLessThan(0);
    // A huge stick input cannot overshoot: the pull is capped by the error.
    const big = { yaw: 0, pitch: 10 };
    applyAimAssist(big, err, rules);
    const scale = big.pitch / 10;
    expect(-big.yaw).toBeLessThanOrEqual(Math.abs(err.yaw) + 1e-9);
    expect(scale).toBeGreaterThan(0);
  });
});
