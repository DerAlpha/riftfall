import { describe, expect, it } from 'vitest';
import {
  SEGMENT_DISPLAY,
  SEVEN_SEGMENT_DIGITS,
  generateKnurlPixels,
  generateWearPixels,
  ledsLit,
  segmentDisplaySize,
  writeLedPixels,
  writeSegmentPixels,
  type Rgb,
} from './textures';

const ON: Rgb = [10, 200, 250];
const OFF: Rgb = [1, 2, 3];
const BG: Rgb = [0, 0, 0];

describe('ammo readouts', () => {
  it('maps ammo fractions to lit LEDs (any round keeps one lit)', () => {
    expect(ledsLit(0, 12, 3)).toBe(0);
    expect(ledsLit(1, 12, 3)).toBe(1);
    expect(ledsLit(4, 12, 3)).toBe(1);
    expect(ledsLit(5, 12, 3)).toBe(2);
    expect(ledsLit(12, 12, 3)).toBe(3);
    expect(ledsLit(40, 12, 3)).toBe(3);
    expect(ledsLit(3, 0, 3)).toBe(0);
    expect(ledsLit(5, 8, 8)).toBe(5);
  });

  it('writes LED texels and reports changes only', () => {
    const data = new Uint8Array(4 * 4);
    expect(writeLedPixels(data, 4, 2, ON, OFF)).toBe(true);
    expect([...data.slice(0, 4)]).toEqual([...ON, 255]);
    expect([...data.slice(8, 12)]).toEqual([...OFF, 255]);
    expect(writeLedPixels(data, 4, 2, ON, OFF)).toBe(false);
    expect(writeLedPixels(data, 4, 3, ON, OFF)).toBe(true);
  });

  it('renders seven-segment digits (8 lights every segment, 1 only the right side)', () => {
    const { w, h } = segmentDisplaySize();
    expect(w).toBe(SEGMENT_DISPLAY.digits * SEGMENT_DISPLAY.digitW + SEGMENT_DISPLAY.gap + 2);
    const count = (value: number): number => {
      const data = new Uint8Array(w * h * 4);
      writeSegmentPixels(data, value, ON, OFF, BG);
      let lit = 0;
      for (let i = 0; i < w * h; i++) if (data[i * 4 + 1] === ON[1]) lit++;
      return lit;
    };
    const perDigit = (v: number): number => count(v * 11) / 2;
    expect(perDigit(8)).toBeGreaterThan(perDigit(0));
    expect(perDigit(1)).toBeLessThan(perDigit(7));
    expect(perDigit(8)).toBeGreaterThan(perDigit(9));
    // Clamped to 0..99, never throws on odd input.
    expect(count(-5)).toBe(count(0));
    expect(count(250)).toBe(count(99));
    expect(count(Number.NaN)).toBeGreaterThanOrEqual(0);
    // Bitmasks: 8 = all seven segments, 1 = b + c.
    expect(SEVEN_SEGMENT_DIGITS[8]).toBe(0b1111111);
    expect(SEVEN_SEGMENT_DIGITS[1]).toBe(0b0110000);
  });

  it('draws the top segment of the leading digit at the top of the texture', () => {
    const { w, h } = segmentDisplaySize();
    const data = new Uint8Array(w * h * 4);
    writeSegmentPixels(data, 70, ON, OFF, BG);
    // Row h-2 (one below the top frame, DataTexture rows go bottom-up) holds segment a of "7".
    const top = (h - 2) * w + 3;
    expect(data[top * 4 + 1]).toBe(ON[1]);
  });
});

describe('procedural maps', () => {
  it('wear map: roughness factor in range, AO/metal channels untouched', () => {
    const size = 32;
    const data = generateWearPixels(size, 'test');
    let min = 255;
    for (let i = 0; i < size * size; i++) {
      expect(data[i * 4]).toBe(255);
      expect(data[i * 4 + 2]).toBe(255);
      min = Math.min(min, data[i * 4 + 1]!);
    }
    expect(min).toBeGreaterThanOrEqual(Math.floor(0.5 * 255));
    // Deterministic for the same seed.
    expect(generateWearPixels(size, 'test')).toEqual(data);
  });

  it('knurl normal map is normalized and tiles seamlessly', () => {
    const size = 32;
    const data = generateKnurlPixels(size, 4, 2);
    for (let i = 0; i < size * size; i++) {
      const x = data[i * 4]! / 127.5 - 1;
      const y = data[i * 4 + 1]! / 127.5 - 1;
      const z = data[i * 4 + 2]! / 127.5 - 1;
      expect(Math.hypot(x, y, z)).toBeGreaterThan(0.97);
      expect(Math.hypot(x, y, z)).toBeLessThan(1.03);
      expect(z).toBeGreaterThan(0);
    }
    // Opposite edges continue the pattern (periodic height field).
    const px = (x: number, y: number): number => data[(y * size + x) * 4]!;
    let diff = 0;
    for (let y = 0; y < size; y++) diff += Math.abs(px(0, y) - px(size - 1, y));
    expect(diff / size).toBeLessThan(60);
  });
});
