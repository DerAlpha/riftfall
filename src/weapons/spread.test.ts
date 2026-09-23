import { describe, expect, it } from 'vitest';
import { WEAPON_RULES, WEAPONS } from '../defs/weapons';
import {
  addBloom,
  aimBasis,
  coneDirection,
  crosshairSpread,
  diskSample,
  pelletOffset,
  recoverBloom,
  spreadDeg,
  type SpreadContext,
} from './spread';

const R = WEAPONS.rifle.spread;
const still: SpreadContext = { ads: 0, speedFactor: 0, airborne: false, crouched: false };

describe('spread', () => {
  it('hip vs ADS, crouch, movement and air modifiers', () => {
    expect(spreadDeg(R, still, 0)).toBeCloseTo(R.hip, 9);
    expect(spreadDeg(R, { ...still, ads: 1 }, 0)).toBeCloseTo(R.ads, 9);
    expect(spreadDeg(R, { ...still, crouched: true }, 0)).toBeCloseTo(R.hip * R.crouchMultiplier, 9);
    expect(spreadDeg(R, { ...still, speedFactor: 1 }, 0)).toBeCloseTo(R.hip + R.moveAdd, 9);
    // Movement spread saturates.
    expect(spreadDeg(R, { ...still, speedFactor: 99 }, 0)).toBeCloseTo(
      R.hip + R.moveAdd * WEAPON_RULES.maxMoveSpreadFactor,
      9,
    );
    expect(spreadDeg(R, { ...still, airborne: true }, 0)).toBeCloseTo(R.hip + R.airAdd, 9);
    // Aiming dampens the state penalties.
    const adsAir = spreadDeg(R, { ...still, ads: 1, airborne: true }, 0);
    expect(adsAir).toBeCloseTo(R.ads + R.airAdd * WEAPON_RULES.adsStateSpreadMultiplier, 9);
    expect(spreadDeg(R, { ...still, speedFactor: Number.NaN }, 0)).toBeCloseTo(R.hip, 9);
  });

  it('bloom grows per shot up to the cap, counts less while aiming and recovers linearly', () => {
    let b = 0;
    b = addBloom(b, R);
    expect(b).toBeCloseTo(R.perShotBloom, 9);
    for (let i = 0; i < 100; i++) b = addBloom(b, R);
    expect(b).toBe(R.bloomMax);
    b = recoverBloom(b, R, 0.1);
    expect(b).toBeCloseTo(R.bloomMax - R.recoveryPerSec * 0.1, 9);
    expect(recoverBloom(b, R, 100)).toBe(0);
    expect(spreadDeg(R, still, 1)).toBeCloseTo(R.hip + 1, 9);
    // Aiming scales the accumulated bloom when it is read.
    expect(spreadDeg(R, { ...still, ads: 1 }, 1)).toBeCloseTo(R.ads + WEAPON_RULES.adsBloomMultiplier, 9);
  });

  it('bloom waits for the recovery delay, so sustained fire accumulates it', () => {
    // Inside the delay: nothing recovers; a step crossing it only recovers the part after it.
    expect(recoverBloom(1, R, 0.01, R.recoveryDelay * 0.5)).toBe(1);
    expect(recoverBloom(1, R, 0.05, R.recoveryDelay + 0.02)).toBeCloseTo(1 - R.recoveryPerSec * 0.02, 9);
    expect(recoverBloom(1, R, Number.NaN, 5)).toBe(1);
    // Full auto at the weapon's rate: bloom climbs to the cap, then returns to 0 after the burst.
    const interval = 60 / WEAPONS.rifle.rpm;
    const dt = 1 / 60;
    let b = 0;
    let since = 0;
    let next = 0;
    let shots = 0;
    for (let t = 0; t < 3; t += dt) {
      if (t >= next && shots < 20) {
        b = addBloom(b, R);
        since = 0;
        next += interval;
        shots++;
      }
      since += dt;
      b = recoverBloom(b, R, dt, since);
      if (shots === 20 && since < dt * 1.5) expect(b).toBeGreaterThan(R.bloomMax * 0.9);
    }
    expect(b).toBe(0);
  });

  it('crosshair spread is normalized and clamped', () => {
    expect(crosshairSpread(4, 8)).toBe(0.5);
    expect(crosshairSpread(40, 8)).toBe(1);
    expect(crosshairSpread(4, 0)).toBe(0);
  });

  it('disk samples stay in the unit disk', () => {
    const out = { x: 0, y: 0 };
    for (let i = 0; i < 50; i++) {
      diskSample(i / 50, (i * 7) / 50, out);
      expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('pellet pattern: center pellet, even outer ring, inner ring beyond, never outside the cone', () => {
    const rules = WEAPON_RULES.pellets;
    const out = { x: 0, y: 0 };
    expect(pelletOffset(0, 9, 0, 0, 0, rules, out)).toEqual({ x: 0, y: 0 });
    const angles: number[] = [];
    for (let i = 1; i < 9; i++) {
      pelletOffset(i, 9, 0, 0, 0, rules, out);
      expect(Math.hypot(out.x, out.y)).toBeCloseTo(rules.ringRadius, 9);
      angles.push(Math.atan2(out.y, out.x));
    }
    angles.sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) expect(angles[i]! - angles[i - 1]!).toBeCloseTo(Math.PI / 4, 9);
    // More pellets than the outer ring holds: the rest sit on the inner ring.
    pelletOffset(10, 12, 0, 0, 0, rules, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(rules.innerRingRadius, 9);
    // Maximum jitter never leaves the unit disk.
    for (let i = 0; i < 9; i++) {
      pelletOffset(i, 9, 1.3, 1, 1, rules, out);
      expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('cone direction deviates by exactly the spread angle at the disk edge', () => {
    const f = { x: 0, y: 0, z: 0 };
    const r = { x: 0, y: 0, z: 0 };
    const u = { x: 0, y: 0, z: 0 };
    aimBasis(0.7, -0.3, f, r, u);
    expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1, 12);
    expect(f.x * r.x + f.y * r.y + f.z * r.z).toBeCloseTo(0, 12);
    expect(f.x * u.x + f.y * u.y + f.z * u.z).toBeCloseTo(0, 12);
    const d = coneDirection(f, r, u, 0, 1, 0.1, { x: 0, y: 0, z: 0 });
    const angle = Math.acos(f.x * d.x + f.y * d.y + f.z * d.z);
    expect(angle).toBeCloseTo(0.1, 9);
    const center = coneDirection(f, r, u, 0, 0, 0.1, { x: 0, y: 0, z: 0 });
    expect(center.x).toBeCloseTo(f.x, 12);
  });

  it('aim basis matches three.js yaw/pitch conventions', () => {
    const f = { x: 0, y: 0, z: 0 };
    const r = { x: 0, y: 0, z: 0 };
    const u = { x: 0, y: 0, z: 0 };
    aimBasis(0, 0, f, r, u);
    expect(f.z).toBeCloseTo(-1, 12);
    expect(r.x).toBeCloseTo(1, 12);
    expect(u.y).toBeCloseTo(1, 12);
    // Positive yaw turns left (towards -X).
    aimBasis(Math.PI / 2, 0, f, r, u);
    expect(f.x).toBeCloseTo(-1, 12);
  });
});
