import { describe, expect, it } from 'vitest';
import { ENEMY_RENDER } from '../../defs/enemyVisuals';
import { generateEnemySurface } from './enemyTextures';
import { tearOpen } from './RiftTears';

const SIZE = 64;

/** Mean absolute difference across each vertical column boundary x → x+1 (last one wraps). */
function columnDiffs(px: Uint8Array, size: number, c: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let y = 0; y < size; y++) {
      sum += Math.abs(px[(y * size + x) * 4 + c]! - px[(y * size + ((x + 1) % size)) * 4 + c]!);
    }
    out.push(sum / size);
  }
  return out;
}

describe('enemy surface texture', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = generateEnemySurface(SIZE, 5);
    const b = generateEnemySurface(SIZE, 5);
    const c = generateEnemySurface(SIZE, 6);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(a.length).toBe(SIZE * SIZE * 4);
  });

  it('tiles seamlessly: the wrap seam is no rougher than the texture itself', () => {
    const px = generateEnemySurface(SIZE, ENEMY_RENDER.texture.seed);
    for (let c = 0; c < 4; c++) {
      const diffs = columnDiffs(px, SIZE, c);
      const seam = diffs[SIZE - 1]!;
      const interiorMax = Math.max(...diffs.slice(0, SIZE - 1));
      expect(seam, `channel ${c}`).toBeLessThanOrEqual(interiorMax * 1.1);
    }
  });

  it('uses the channel ranges (cells have seams, veins are sparse lines)', () => {
    const px = generateEnemySurface(SIZE, ENEMY_RENDER.texture.seed);
    let seams = 0;
    let veins = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (px[i * 4 + 1]! < 40) seams++;
      if (px[i * 4 + 2]! > 128) veins++;
    }
    const n = SIZE * SIZE;
    expect(seams / n).toBeGreaterThan(0.03);
    expect(seams / n).toBeLessThan(0.5);
    expect(veins / n).toBeGreaterThan(0.02);
    expect(veins / n).toBeLessThan(0.4);
  });
});

describe('rift tear opening', () => {
  it('opens as the enemy starts to rise and closes behind it', () => {
    expect(tearOpen(0)).toBe(0);
    expect(tearOpen(1)).toBe(0);
    expect(tearOpen(Number.NaN)).toBe(0);
    expect(tearOpen(ENEMY_RENDER.tears.openUntil)).toBeCloseTo(1, 6);
    expect(tearOpen((ENEMY_RENDER.tears.openUntil + ENEMY_RENDER.tears.closeFrom) / 2)).toBeCloseTo(1, 6);
    expect(tearOpen(0.99)).toBeLessThan(0.05);
  });
});
