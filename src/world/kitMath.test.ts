import { describe, expect, it } from 'vitest';
import { noise1D } from '../core/math';
import { FLICKER } from '../defs/level';
import {
  airTime,
  allocateShadowBudget,
  boxFaceUV,
  flickerFactor,
  jumpDistance,
  pipeWrapRepeats,
  rectArea,
  rectsOverlap,
  staggeredSlot,
  stairsLayout,
  subtractIntervals,
  subtractRects,
  type Rect,
  type UV,
} from './kitMath';

const uv = (): UV => ({ x: 0, y: 0 });

describe('boxFaceUV', () => {
  it('projects walls with V = world up and U to the right when viewed from outside', () => {
    // +Z face: right is +X.
    expect(boxFaceUV(2, 3, 5, 0, 0, 1, uv())).toEqual({ x: 2, y: 3 });
    // -Z face: right is -X.
    expect(boxFaceUV(2, 3, 5, 0, 0, -1, uv())).toEqual({ x: -2, y: 3 });
    // +X face: right is -Z.
    expect(boxFaceUV(1, 4, 7, 1, 0, 0, uv())).toEqual({ x: -7, y: 4 });
    // -X face: right is +Z.
    expect(boxFaceUV(1, 4, 7, -1, 0, 0, uv())).toEqual({ x: 7, y: 4 });
  });

  it('projects floors in meters with V pointing north (-Z)', () => {
    const a = boxFaceUV(3, 0, -2, 0, 1, 0, uv());
    expect(a.x).toBe(3);
    expect(a.y).toBe(2);
    // One meter along X moves U by exactly one meter: consistent texel density.
    const b = boxFaceUV(4, 0, -2, 0, 1, 0, uv());
    expect(b.x - a.x).toBe(1);
  });

  it('picks the dominant axis for sloped faces', () => {
    const r = boxFaceUV(1, 2, 3, 0.2, 0.9, 0.1, uv());
    expect(r).toEqual({ x: 1, y: -3 });
  });
});

describe('subtractRects', () => {
  const outer: Rect = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

  it('covers exactly the outer area minus the holes without overlaps', () => {
    const holes: Rect[] = [
      { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
      { minX: 6, maxX: 12, minZ: -2, maxZ: 2 },
      { minX: -10, maxX: -8, minZ: 8, maxZ: 10 },
    ];
    const parts = subtractRects(outer, holes);
    const holeArea = 100 + 4 * 4 + 4;
    const total = parts.reduce((s, r) => s + rectArea(r), 0);
    expect(total).toBeCloseTo(rectArea(outer) - holeArea, 6);
    for (let i = 0; i < parts.length; i++) {
      for (const h of holes) expect(rectsOverlap(parts[i]!, h)).toBe(false);
      for (let j = i + 1; j < parts.length; j++) expect(rectsOverlap(parts[i]!, parts[j]!)).toBe(false);
    }
  });

  it('returns the outer rect when there are no holes and merges bands', () => {
    expect(subtractRects(outer, [])).toEqual([outer]);
    const parts = subtractRects(outer, [{ minX: -2, maxX: 2, minZ: -2, maxZ: 2 }]);
    // Full-width bands above and below the hole plus the pieces left and right of it.
    expect(parts.length).toBe(4);
  });
});

describe('subtractIntervals', () => {
  it('removes holes, clips and sorts', () => {
    expect(
      subtractIntervals(0, 10, [
        [2, 3],
        [7, 12],
      ]),
    ).toEqual([
      [0, 2],
      [3, 7],
    ]);
    expect(subtractIntervals(0, 10, [])).toEqual([[0, 10]]);
    expect(subtractIntervals(0, 10, [[-5, 15]])).toEqual([]);
    expect(subtractIntervals(0, 10, [[6, 4]])).toEqual([
      [0, 4],
      [6, 10],
    ]);
  });
});

describe('stairsLayout', () => {
  it('never exceeds the max step rise and divides the rise evenly', () => {
    const s = stairsLayout(4.5, 0.2, 0.3);
    expect(s.steps).toBe(23);
    expect(s.stepRise).toBeLessThanOrEqual(0.2);
    expect(s.stepRise * s.steps).toBeCloseTo(4.5, 9);
    expect(s.totalRun).toBeCloseTo(6.9, 9);
    expect(s.slopeDeg).toBeGreaterThan(30);
    expect(stairsLayout(1, 0.25, 0.3).steps).toBe(4);
  });
});

describe('light budget helpers', () => {
  it('gives shadows to the most important lights', () => {
    expect(allocateShadowBudget([3, 1, 2, 5], 2)).toEqual([false, true, true, false]);
    expect(allocateShadowBudget([1, 1, 1], 2)).toEqual([true, true, false]);
    expect(allocateShadowBudget([1, 2], 0)).toEqual([false, false]);
    expect(allocateShadowBudget([1, 2], 10)).toEqual([true, true]);
  });

  it('staggers updates so every item refreshes exactly once per interval', () => {
    const interval = 3;
    for (let index = 0; index < 5; index++) {
      let hits = 0;
      for (let frame = 0; frame < interval; frame++) if (staggeredSlot(index, frame, interval)) hits++;
      expect(hits).toBe(1);
    }
    expect(staggeredSlot(4, 17, 1)).toBe(true);
  });
});

describe('flickerFactor', () => {
  it('stays within [0, 1], is deterministic and actually flickers', () => {
    let min = 1;
    let max = 0;
    for (let t = 0; t < 30; t += 1 / 60) {
      const k = flickerFactor(t, 2, FLICKER, noise1D);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
      min = Math.min(min, k);
      max = Math.max(max, k);
    }
    expect(max).toBeGreaterThan(0.9);
    expect(min).toBeLessThan(0.2);
    expect(flickerFactor(12.34, 5, FLICKER, noise1D)).toBe(flickerFactor(12.34, 5, FLICKER, noise1D));
  });
});

describe('jump helpers', () => {
  const p = { gravity: 20, fallGravityMultiplier: 1 };

  it('matches the symmetric ballistic air time', () => {
    const h = 1.2;
    expect(airTime(h, 0, p)).toBeCloseTo(2 * Math.sqrt((2 * h) / p.gravity), 9);
    expect(jumpDistance(10, h, 0, p)).toBeCloseTo(10 * airTime(h, 0, p), 9);
  });

  it('lands later when landing lower and cannot land above the apex', () => {
    expect(airTime(1, -2, p)).toBeGreaterThan(airTime(1, 0, p));
    expect(Number.isNaN(airTime(1, 2, p))).toBe(true);
    expect(jumpDistance(10, 1, 2, p)).toBe(0);
  });

  it('rounds pipe circumference to whole texture repeats', () => {
    expect(pipeWrapRepeats(0.3, 1)).toBe(2);
    expect(pipeWrapRepeats(0.01, 1)).toBe(1);
  });
});
