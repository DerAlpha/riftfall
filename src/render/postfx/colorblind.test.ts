import { describe, expect, it } from 'vitest';
import { applyMat3, daltonizationMatrix, IDENTITY_MAT3 } from './colorblind';

describe('daltonizationMatrix', () => {
  it('is the identity for "none" and zero strength', () => {
    expect(daltonizationMatrix('none')).toEqual(IDENTITY_MAT3);
    expect(daltonizationMatrix('protanopia', 0)).toEqual(IDENTITY_MAT3);
  });

  it.each(['protanopia', 'deuteranopia', 'tritanopia'] as const)('%s preserves greys', (mode) => {
    const m = daltonizationMatrix(mode);
    for (const v of [0, 0.18, 0.5, 1]) {
      const [r, g, b] = applyMat3(m, v, v, v);
      expect(r).toBeCloseTo(v, 4);
      expect(g).toBeCloseTo(v, 4);
      expect(b).toBeCloseTo(v, 4);
    }
  });

  it('shifts red/green differences into blue for protanopia', () => {
    const m = daltonizationMatrix('protanopia');
    const red = applyMat3(m, 0.8, 0.2, 0.2);
    const green = applyMat3(m, 0.2, 0.8, 0.2);
    // Blue channel now separates red from green.
    expect(Math.abs(red[2] - green[2])).toBeGreaterThan(0.1);
  });

  it('blends with identity by strength', () => {
    const full = daltonizationMatrix('deuteranopia', 1);
    const half = daltonizationMatrix('deuteranopia', 0.5);
    for (let i = 0; i < 9; i++) expect(half[i]).toBeCloseTo((full[i]! + IDENTITY_MAT3[i]!) / 2, 6);
  });
});
