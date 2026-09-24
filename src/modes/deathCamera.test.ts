import { describe, expect, it } from 'vitest';
import { RUN } from '../defs/waves';
import { deathCameraOffset, deathCollapse } from './deathCamera';

const C = RUN.death.camera;
const D = RUN.death.cameraDropSeconds;

describe('death camera', () => {
  it('falls with acceleration, bounces on impact and rests fully down', () => {
    expect(deathCollapse(0, D)).toBe(0);
    const early = deathCollapse(D * 0.2, D);
    const mid = deathCollapse(D * 0.4, D);
    expect(mid - early).toBeGreaterThan(early); // accelerating
    expect(deathCollapse(D * C.fallFraction, D)).toBeCloseTo(1);
    const bounce = deathCollapse(D * (C.fallFraction + (1 - C.fallFraction) / 2), D);
    expect(bounce).toBeCloseTo(1 - C.bounce);
    expect(deathCollapse(D, D)).toBeCloseTo(1);
    expect(deathCollapse(D * 5, D)).toBeCloseTo(1);
    expect(deathCollapse(Number.NaN, D)).toBe(0);
    expect(deathCollapse(1, 0)).toBe(0);
  });

  it('scales drop, roll and pitch by the collapse', () => {
    const o = { drop: 0, roll: 0, pitch: 0 };
    expect(deathCameraOffset(D * 2, D, o)).toBe(o);
    expect(o.drop).toBeCloseTo(C.drop);
    expect(o.roll).toBeCloseTo((C.rollDeg * Math.PI) / 180);
    expect(o.pitch).toBeCloseTo((C.pitchDeg * Math.PI) / 180);
    deathCameraOffset(0, D, o);
    expect(o).toEqual({ drop: 0, roll: 0, pitch: 0 });
  });
});
