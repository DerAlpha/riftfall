import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ColorGradingDef } from '../../defs/maps';
import { TEST_ROOM } from '../../defs/maps';
import {
  createLUTTexture,
  generateGradingLUT,
  IDENTITY_GRADING,
  linearToSrgb,
  srgbToLinear,
  updateLUTTexture,
} from './lut';

function texel(
  data: Uint8Array,
  size: number,
  r: number,
  g: number,
  b: number,
): [number, number, number, number] {
  const i = (r + g * size + b * size * size) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function lumaOf(t: [number, number, number, number]): number {
  return (
    0.2126 * srgbToLinear(t[0] / 255) + 0.7152 * srgbToLinear(t[1] / 255) + 0.0722 * srgbToLinear(t[2] / 255)
  );
}

const grade = (patch: Partial<ColorGradingDef>): ColorGradingDef => ({ ...IDENTITY_GRADING, ...patch });

describe('sRGB transfer', () => {
  it('round-trips', () => {
    for (let i = 0; i <= 20; i++) {
      const v = i / 20;
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });
});

describe('generateGradingLUT', () => {
  it('produces an identity LUT for the neutral grading (red fastest, then green, then blue)', () => {
    const size = 17;
    const data = generateGradingLUT(IDENTITY_GRADING, size);
    expect(data.length).toBe(size * size * size * 4);
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const t = texel(data, size, r, g, b);
          expect(t[0]).toBe(Math.round((r / (size - 1)) * 255));
          expect(t[1]).toBe(Math.round((g / (size - 1)) * 255));
          expect(t[2]).toBe(Math.round((b / (size - 1)) * 255));
          expect(t[3]).toBe(255);
        }
      }
    }
  });

  it('defaults to 32³ and can write into an existing buffer', () => {
    const data = generateGradingLUT(IDENTITY_GRADING);
    expect(data.length).toBe(32 * 32 * 32 * 4);
    const out = new Uint8Array(8 * 8 * 8 * 4);
    const res = generateGradingLUT(grade({ exposure: 2 }), 8, out);
    expect(res).toBe(out);
    expect(() => generateGradingLUT(IDENTITY_GRADING, 16, new Uint8Array(4))).toThrow();
  });

  it('exposure brightens mid-grey', () => {
    const size = 9;
    const base = texel(generateGradingLUT(IDENTITY_GRADING, size), size, 4, 4, 4);
    const bright = texel(generateGradingLUT(grade({ exposure: 1.5 }), size), size, 4, 4, 4);
    expect(bright[0]).toBeGreaterThan(base[0]);
  });

  it('contrast pivots around mid-grey: darks darker, brights brighter', () => {
    const size = 33;
    const flat = generateGradingLUT(IDENTITY_GRADING, size);
    const contrasty = generateGradingLUT(grade({ contrast: 1.3 }), size);
    const dark = 6;
    const bright = 28;
    expect(texel(contrasty, size, dark, dark, dark)[0]).toBeLessThan(texel(flat, size, dark, dark, dark)[0]);
    expect(texel(contrasty, size, bright, bright, bright)[0]).toBeGreaterThan(
      texel(flat, size, bright, bright, bright)[0],
    );
  });

  it('saturation 0 produces greys that keep luminance', () => {
    const size = 9;
    const data = generateGradingLUT(grade({ saturation: 0 }), size);
    const t = texel(data, size, 8, 2, 5);
    expect(Math.abs(t[0] - t[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(t[1] - t[2])).toBeLessThanOrEqual(1);
    const src = texel(generateGradingLUT(IDENTITY_GRADING, size), size, 8, 2, 5);
    expect(lumaOf(t)).toBeCloseTo(lumaOf(src), 2);
  });

  it('temperature shifts warm without changing grey luminance much', () => {
    const size = 9;
    const warm = texel(generateGradingLUT(grade({ temperature: 1 }), size), size, 5, 5, 5);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const neutral = texel(generateGradingLUT(IDENTITY_GRADING, size), size, 5, 5, 5);
    expect(lumaOf(warm)).toBeCloseTo(lumaOf(neutral), 2);
  });

  it('grey split-tone tints are neutral, colored tints shift hue', () => {
    const size = 9;
    const neutral = generateGradingLUT(IDENTITY_GRADING, size);
    const greyTints = generateGradingLUT(
      grade({ shadowTint: [0.3, 0.3, 0.3], highlightTint: [2, 2, 2] }),
      size,
    );
    expect(Array.from(greyTints)).toEqual(Array.from(neutral));
    const teal = texel(generateGradingLUT(grade({ shadowTint: [0.1, 0.35, 0.55] }), size), size, 2, 2, 2);
    expect(teal[2]).toBeGreaterThan(teal[0]);
  });

  it('lift raises black, gain scales white', () => {
    const size = 9;
    const lifted = texel(generateGradingLUT(grade({ lift: [0.1, 0.1, 0.1] }), size), size, 0, 0, 0);
    expect(lifted[0]).toBeGreaterThan(0);
    const gained = texel(generateGradingLUT(grade({ gain: [0.8, 0.8, 0.8] }), size), size, 8, 8, 8);
    expect(gained[0]).toBe(Math.round(0.8 * 255));
  });

  it('the test room grading stays in range and changes the image', () => {
    const size = 16;
    const data = generateGradingLUT(TEST_ROOM.grading, size);
    const identity = generateGradingLUT(IDENTITY_GRADING, size);
    expect(Array.from(data)).not.toEqual(Array.from(identity));
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
  });
});

describe('createLUTTexture', () => {
  it('creates a raw RGBA8 Data3DTexture suited for LUT3DEffect', () => {
    const tex = createLUTTexture(IDENTITY_GRADING, 16);
    expect(tex).toBeInstanceOf(THREE.Data3DTexture);
    expect(tex.image.width).toBe(16);
    expect(tex.image.height).toBe(16);
    expect(tex.image.depth).toBe(16);
    expect(tex.format).toBe(THREE.RGBAFormat);
    expect(tex.type).toBe(THREE.UnsignedByteType);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.minFilter).toBe(THREE.LinearFilter);
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect(tex.wrapR).toBe(THREE.ClampToEdgeWrapping);
    const before = tex.version;
    updateLUTTexture(tex, grade({ exposure: 2 }));
    expect(tex.version).toBeGreaterThan(before);
    tex.dispose();
  });
});
