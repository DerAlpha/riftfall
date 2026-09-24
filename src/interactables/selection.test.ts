import { describe, expect, it } from 'vitest';
import { INTERACTION } from '../defs/interactables';
import { createSelectionConfig, pickBest, scoreAnchor, viewForward } from './selection';

const cfg = createSelectionConfig();
const F = { x: 0, y: 0, z: -1 };

function score(dx: number, dy: number, dz: number, range = 2.5): number {
  return scoreAnchor(dx, dy, dz, range, F.x, F.y, F.z, cfg);
}

describe('interaction selection', () => {
  it('derives the view direction from PlayerApi yaw / pitch', () => {
    const f = { x: 0, y: 0, z: 0 };
    viewForward(0, 0, f);
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-1);
    // Positive yaw turns left (towards −X).
    viewForward(Math.PI / 2, 0, f);
    expect(f.x).toBeCloseTo(-1);
    viewForward(0, Math.PI / 4, f);
    expect(f.y).toBeCloseTo(Math.SQRT1_2);
  });

  it('rejects anchors out of range or outside the view cone', () => {
    expect(score(0, 0, -2)).toBeGreaterThanOrEqual(0);
    expect(score(0, 0, -2.6)).toBe(-1);
    // Behind the player.
    expect(score(0, 0, 2)).toBe(-1);
    // 60° off axis at 2 m: outside the normal cone, beyond the close range.
    const a = (60 * Math.PI) / 180;
    expect(score(Math.sin(a) * 2, 0, -Math.cos(a) * 2)).toBe(-1);
    // Same angle up close: the wide close-range cone applies.
    expect(score(Math.sin(a), 0, -Math.cos(a))).toBeGreaterThanOrEqual(0);
    expect(score(0, 0, -1, 0)).toBe(-1);
  });

  it('prefers anchors near the crosshair, then near the player', () => {
    const centered = score(0, 0, -2);
    const offAxis = score(0.8, 0, -2);
    expect(centered).toBeLessThan(offAxis);
    expect(score(0, 0, -1)).toBeLessThan(score(0, 0, -2));
  });

  it('picks the best candidate with line of sight, checking at most maxLosChecks', () => {
    const scores = new Float64Array([0.9, 0.2, -1, 0.5, 0.3]);
    const order = new Int32Array(8);
    const checked: number[] = [];
    const best = pickBest(scores, 5, order, -1, cfg, (i) => {
      checked.push(i);
      return i !== 1;
    });
    // 1 is best but blocked, 4 is next.
    expect(best).toBe(4);
    expect(checked).toEqual([1, 4]);

    const blockedAll = pickBest(new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]), 5, order, -1, cfg, () => false);
    expect(blockedAll).toBe(-1);
  });

  it('keeps the current focus unless another one is clearly better', () => {
    const order = new Int32Array(4);
    const s = (): Float64Array => new Float64Array([0.5, 0.5 - INTERACTION.stickiness / 2]);
    expect(pickBest(s(), 2, order, -1, cfg, () => true)).toBe(1);
    expect(pickBest(s(), 2, order, 0, cfg, () => true)).toBe(0);
    const clearly = new Float64Array([0.5, 0.5 - INTERACTION.stickiness * 2]);
    expect(pickBest(clearly, 2, order, 0, cfg, () => true)).toBe(1);
  });

  it('returns -1 without candidates', () => {
    expect(pickBest(new Float64Array([-1, -1]), 2, new Int32Array(2), -1, cfg, () => true)).toBe(-1);
  });
});
