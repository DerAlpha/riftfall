import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Hitbox } from '../../core/contracts';
import {
  beamAmmoStep,
  blastFalloff,
  bounceVelocity,
  chargeDamageFactor,
  chargeStep,
  coneReach,
  convergeWeight,
  distanceToBody,
  distanceToHitboxes,
  homingScore,
  linearFade,
  spinRateFactor,
  spinStep,
  splitYawOffset,
  turnTowards,
  yawAround,
} from './fireMath';

const DT = 1 / 60;

describe('charge curve', () => {
  it('fills linearly over the charge time and clamps at full', () => {
    let a = 0;
    for (let i = 0; i < 33; i++) a = chargeStep(a, DT, 1.1);
    expect(a).toBeCloseTo(33 / 60 / 1.1, 9);
    for (let i = 0; i < 60; i++) a = chargeStep(a, DT, 1.1);
    expect(a).toBe(1);
    expect(chargeStep(0.2, DT, 0)).toBe(1);
  });

  it('fizzles below minCharge, scales from damageAtMin to 1 above it', () => {
    const def = { minCharge: 0.35, damageAtMin: 0.35 };
    expect(chargeDamageFactor(0.34, def)).toBe(0);
    expect(chargeDamageFactor(0, def)).toBe(0);
    expect(chargeDamageFactor(0.35, def)).toBeCloseTo(0.35, 9);
    expect(chargeDamageFactor(1, def)).toBeCloseTo(1, 9);
    // Halfway between threshold and full: halfway between damageAtMin and 1.
    expect(chargeDamageFactor(0.675, def)).toBeCloseTo(0.675, 9);
    expect(chargeDamageFactor(Number.NaN, def)).toBe(0);
  });
});

describe('spin-up curve', () => {
  const def = { time: 0.75, startFraction: 0.35, spinDown: 1.2 };
  it('spins up over `time`, down over `spinDown`', () => {
    let s = 0;
    for (let i = 0; i < 45; i++) s = spinStep(s, true, DT, def);
    expect(s).toBeCloseTo(1, 9);
    for (let i = 0; i < 36; i++) s = spinStep(s, false, DT, def);
    expect(s).toBeCloseTo(1 - 0.6 / 1.2, 6);
    for (let i = 0; i < 200; i++) s = spinStep(s, false, DT, def);
    expect(s).toBe(0);
  });

  it('fires nothing below startFraction, then at the spin fraction of the rate', () => {
    expect(spinRateFactor(0.34, def)).toBe(0);
    expect(spinRateFactor(0.35, def)).toBeCloseTo(0.35, 9);
    expect(spinRateFactor(0.8, def)).toBeCloseTo(0.8, 9);
    expect(spinRateFactor(1, def)).toBe(1);
  });
});

describe('area damage math', () => {
  it('blast falloff is linear from 1 to the minimum at the radius, 0 outside', () => {
    expect(blastFalloff(0, 4, 0.25)).toBe(1);
    expect(blastFalloff(2, 4, 0.25)).toBeCloseTo(0.625, 9);
    expect(blastFalloff(4, 4, 0.25)).toBeCloseTo(0.25, 9);
    expect(blastFalloff(4.01, 4, 0.25)).toBe(0);
    expect(blastFalloff(1, 0, 0.5)).toBe(0);
    expect(linearFade(3, 12)).toBeCloseTo(0.75, 9);
    expect(linearFade(13, 12)).toBe(0);
  });

  it('distance to the nearest hitbox surface and the closest point', () => {
    const boxes: Hitbox[] = [
      { shape: 'sphere', zone: 'head', a: new Vector3(0, 2, 0), b: new Vector3(), radius: 0.2 },
      { shape: 'capsule', zone: 'body', a: new Vector3(0, 0.5, 0), b: new Vector3(0, 1.5, 0), radius: 0.3 },
    ];
    const out = new Vector3();
    expect(distanceToHitboxes({ x: 2, y: 1, z: 0 }, boxes, out)).toBeCloseTo(1.7, 9);
    expect(out.x).toBeCloseTo(0.3, 9);
    expect(out.y).toBeCloseTo(1, 9);
    expect(distanceToHitboxes({ x: 0, y: 3, z: 0 }, boxes, out)).toBeCloseTo(0.8, 9);
    expect(out.y).toBeCloseTo(2.2, 9);
    expect(distanceToHitboxes({ x: 0.1, y: 1, z: 0 }, boxes, out)).toBe(0);
    expect(distanceToHitboxes({ x: 0, y: 0, z: 0 }, [], out)).toBe(Number.POSITIVE_INFINITY);
    // The player's body: a vertical capsule from the feet (+radius) to the eye.
    expect(
      distanceToBody({ x: 3, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1.6, z: 0 }, 0.4),
    ).toBeCloseTo(2.6, 9);
  });
});

describe('beam math', () => {
  const eye = { x: 0, y: 0, z: 0 };
  const fwd = { x: 0, y: 0, z: -1 };
  const tan = Math.tan((12 * Math.PI) / 180);
  it('cone reach: inside the widened cone within range, else -1', () => {
    expect(coneReach(eye, fwd, tan, 9, { x: 0, y: 0, z: -5 }, 0.5, 0.6)).toBeCloseTo(5, 9);
    // 1.2 m off axis at 5 m: cone 1.06 + 0.3 of the bounds → inside.
    expect(coneReach(eye, fwd, tan, 9, { x: 1.3, y: 0, z: -5 }, 0.5, 0.6)).toBeGreaterThan(0);
    expect(coneReach(eye, fwd, tan, 9, { x: 1.5, y: 0, z: -5 }, 0.5, 0.6)).toBe(-1);
    expect(coneReach(eye, fwd, tan, 9, { x: 0, y: 0, z: 5 }, 0.5, 0.6)).toBe(-1);
    expect(coneReach(eye, fwd, tan, 9, { x: 0, y: 0, z: -9.6 }, 0.5, 0.6)).toBe(-1);
  });

  it('ammo drain carries the fraction between ticks', () => {
    const s = { acc: 0 };
    let taken = 0;
    for (let i = 0; i < 60; i++) taken += beamAmmoStep(s, 15, DT);
    expect(taken).toBe(15);
    expect(s.acc).toBeLessThan(1e-9 + 1);
    const t = { acc: 0 };
    expect(beamAmmoStep(t, 10, DT)).toBe(0);
    expect(t.acc).toBeCloseTo(10 / 60, 9);
  });
});

describe('split shots, bounces, homing', () => {
  it('split fans alternate right/left, one step further every second ray', () => {
    const a = 0.1;
    expect([1, 2, 3, 4, 5].map((k) => splitYawOffset(k, a))).toEqual([
      0.1, -0.1, 0.2, -0.2, 0.30000000000000004,
    ]);
    const out = new Vector3();
    yawAround({ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, Math.PI / 2, out);
    expect(out.x).toBeCloseTo(-1, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('bounce reflects the normal part × restitution and keeps more of the skid', () => {
    const v = new Vector3(4, -3, 0);
    const out = new Vector3();
    bounceVelocity(v, { x: 0, y: 1, z: 0 }, 0.5, 0.5, out);
    expect(out.y).toBeCloseTo(1.5, 9);
    expect(out.x).toBeCloseTo(4 * 0.75, 9);
    // Head-on into a wall: straight back at restitution.
    bounceVelocity(new Vector3(0, 0, -10), { x: 0, y: 0, z: 1 }, 0.45, 0.5, out);
    expect(out.z).toBeCloseTo(4.5, 9);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(0, 9);
  });

  it('homing turns by at most the turn step and keeps the speed', () => {
    const v = new Vector3(0, 0, -30);
    const out = new Vector3();
    const turned = turnTowards(v, { x: 1, y: 0, z: 0 }, 0.1, out);
    expect(turned).toBeCloseTo(0.1, 9);
    expect(out.length()).toBeCloseTo(30, 9);
    expect(Math.atan2(out.x, -out.z)).toBeCloseTo(0.1, 9);
    // Within the step: points straight at the target.
    turnTowards(v, { x: 0, y: Math.sin(0.05), z: -Math.cos(0.05) }, 0.1, out);
    expect(out.y / 30).toBeCloseTo(Math.sin(0.05), 9);
  });

  it('homing score: distance from the flight line, -1 behind / outside the cone / out of range', () => {
    const p = { x: 0, y: 0, z: 0 };
    const d = { x: 0, y: 0, z: -1 };
    const cos = Math.cos((75 * Math.PI) / 180);
    expect(homingScore(p, d, { x: 1, y: 0, z: -10 }, 30, cos)).toBeCloseTo(1, 9);
    expect(homingScore(p, d, { x: 0, y: 0, z: 10 }, 30, cos)).toBe(-1);
    expect(homingScore(p, d, { x: 0, y: 0, z: -40 }, 30, cos)).toBe(-1);
    expect(homingScore(p, d, { x: 10, y: 0, z: -1 }, 30, cos)).toBe(-1);
  });

  it('the drawn projectile converges from the muzzle onto the path', () => {
    expect(convergeWeight(0, 0.1)).toBe(1);
    expect(convergeWeight(0.05, 0.1)).toBeCloseTo(0.5, 9);
    expect(convergeWeight(0.1, 0.1)).toBe(0);
    expect(convergeWeight(1, 0.1)).toBe(0);
  });
});
