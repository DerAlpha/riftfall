import { describe, expect, it } from 'vitest';
import { DEG2RAD } from '../core/math';
import { GRENADE_RULES, GRENADES } from '../defs/grenades';
import { arcPoint, arcRange, handPosition, throwLaunch, throwStrength } from './grenadeMath';

const R = GRENADE_RULES;

/** Flat-ground range of a throw from eye height `eyeY` looking at `pitchDeg`. */
function range(strength: number, pitchDeg: number, eyeY = 1.6, inheritZ = 0): number {
  const dir = { x: 0, y: 0, z: 0 };
  const g = GRENADES.frag.projectile;
  const scale = throwLaunch(0, pitchDeg * DEG2RAD, strength, R, dir);
  const v = { x: dir.x * g.speed * scale, y: dir.y * g.speed * scale, z: dir.z * g.speed * scale + inheritZ };
  return arcRange({ x: 0, y: eyeY, z: 0 }, v, g.gravity, 0);
}

describe('throwStrength', () => {
  it('ramps from a lob (tap) to a full throw over the windup, eased out and clamped', () => {
    expect(throwStrength(0, R.windup)).toBe(0);
    expect(throwStrength(R.windup, R.windup)).toBe(1);
    expect(throwStrength(R.windup * 5, R.windup)).toBe(1);
    const half = throwStrength(R.windup / 2, R.windup);
    expect(half).toBeGreaterThan(0.5);
    expect(half).toBeLessThan(1);
    expect(throwStrength(NaN, R.windup)).toBe(0);
    expect(throwStrength(0.1, 0)).toBe(1);
  });
});

describe('throwLaunch', () => {
  it('throws along the view, pitched up, with the lob at a fraction of the speed', () => {
    const dir = { x: 0, y: 0, z: 0 };
    const full = throwLaunch(0, 0, 1, R, dir);
    expect(full).toBe(1);
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 6);
    // yaw 0 looks down −Z; the launch is pitched up by throwPitchDeg.
    expect(dir.z).toBeLessThan(0);
    expect(Math.asin(dir.y) / DEG2RAD).toBeCloseTo(R.throwPitchDeg, 4);
    const lob = throwLaunch(0, 0, 0, R, dir);
    expect(lob).toBe(R.lobSpeedScale);
    expect(Math.asin(dir.y) / DEG2RAD).toBeCloseTo(R.lobPitchDeg, 4);
  });

  it('turns with the yaw (positive yaw turns left)', () => {
    const dir = { x: 0, y: 0, z: 0 };
    throwLaunch(Math.PI / 2, 0, 1, R, dir);
    expect(dir.x).toBeLessThan(-0.9);
    expect(Math.abs(dir.z)).toBeLessThan(1e-9);
  });

  it('never throws backwards when looking straight up', () => {
    const dir = { x: 0, y: 0, z: 0 };
    throwLaunch(0, 89 * DEG2RAD, 0, R, dir);
    expect(Math.asin(dir.y) / DEG2RAD).toBeCloseTo(R.maxPitchDeg, 4);
    expect(dir.z).toBeLessThan(0);
  });

  it('a held throw flies much farther than a tap; looking up throws farther still', () => {
    const lob = range(0, 0);
    const full = range(1, 0);
    expect(full).toBeGreaterThan(lob * 1.8);
    expect(lob).toBeGreaterThan(3);
    expect(lob).toBeLessThan(9);
    expect(full).toBeGreaterThan(10);
    expect(range(1, 25)).toBeGreaterThan(full * 1.5);
  });

  it("adds the thrower's velocity (a sprint throw lands farther)", () => {
    const standing = range(1, 0);
    const running = range(1, 0, 1.6, -8);
    expect(running).toBeGreaterThan(standing + 3);
  });
});

describe('handPosition', () => {
  it('maps the camera-space offset along the view', () => {
    const out = { x: 0, y: 0, z: 0 };
    handPosition({ x: 1, y: 2, z: 3 }, 0, 0, { right: 0.2, up: -0.1, forward: 0.3 }, out);
    expect(out.x).toBeCloseTo(1.2, 6);
    expect(out.y).toBeCloseTo(1.9, 6);
    expect(out.z).toBeCloseTo(2.7, 6);
  });
});

describe('arc', () => {
  it('arcPoint follows constant gravity and arcRange finds the floor crossing', () => {
    const o = { x: 0, y: 2, z: 0 };
    const v = { x: 3, y: 4, z: 0 };
    const p = { x: 0, y: 0, z: 0 };
    arcPoint(o, v, 10, 1, p);
    expect(p.x).toBeCloseTo(3, 9);
    expect(p.y).toBeCloseTo(1, 9);
    const r = arcRange(o, v, 10, 0);
    const t = r / 3;
    arcPoint(o, v, 10, t, p);
    expect(p.y).toBeCloseTo(0, 6);
    expect(arcRange({ x: 0, y: -1, z: 0 }, v, 10, 0)).toBe(0);
  });
});
