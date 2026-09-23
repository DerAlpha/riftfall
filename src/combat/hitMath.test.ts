import { describe, expect, it } from 'vitest';
import {
  capsuleNormal,
  falloffMultiplier,
  pointSegmentDistanceSq,
  rayCapsule,
  raySphere,
  sphereNormal,
  spheresOverlap,
} from './hitMath';

const v = (x: number, y: number, z: number) => ({ x, y, z });
const norm = (x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z);
  return v(x / l, y / l, z / l);
};

describe('raySphere', () => {
  it('hits the near surface, misses beside and behind, returns 0 inside', () => {
    expect(raySphere(v(0, 0, 10), v(0, 0, -1), v(0, 0, 0), 1)).toBeCloseTo(9, 9);
    expect(raySphere(v(0, 1.01, 10), v(0, 0, -1), v(0, 0, 0), 1)).toBe(-1);
    expect(raySphere(v(0, 0, 10), v(0, 0, 1), v(0, 0, 0), 1)).toBe(-1);
    expect(raySphere(v(0.2, 0, 0), v(0, 0, -1), v(0, 0, 0), 1)).toBe(0);
  });

  it('grazing and oblique hits', () => {
    const t = raySphere(v(-5, 0.5, 0), v(1, 0, 0), v(0, 0, 0), 1);
    expect(t).toBeCloseTo(5 - Math.sqrt(0.75), 9);
    const d = norm(1, 1, 0);
    const t2 = raySphere(v(0, 0, 0), d, v(5, 5, 0), 0.5);
    expect(t2).toBeCloseTo(Math.hypot(5, 5) - 0.5, 9);
  });
});

describe('rayCapsule', () => {
  const a = v(0, 0, 0);
  const b = v(0, 2, 0);

  it('hits the cylindrical body at the side', () => {
    expect(rayCapsule(v(5, 1, 0), v(-1, 0, 0), a, b, 0.5)).toBeCloseTo(4.5, 9);
  });

  it('hits the caps from above/below and along the axis', () => {
    expect(rayCapsule(v(0, 10, 0), v(0, -1, 0), a, b, 0.5)).toBeCloseTo(7.5, 9);
    expect(rayCapsule(v(0, -10, 0), v(0, 1, 0), a, b, 0.5)).toBeCloseTo(9.5, 9);
    // Beside the segment end: only the cap sphere can be hit.
    const t = rayCapsule(v(5, 2.3, 0), v(-1, 0, 0), a, b, 0.5);
    expect(t).toBeCloseTo(5 - Math.sqrt(0.25 - 0.09), 9);
  });

  it('misses beside, above and behind; 0 inside', () => {
    expect(rayCapsule(v(5, 2.6, 0), v(-1, 0, 0), a, b, 0.5)).toBe(-1);
    expect(rayCapsule(v(5, 1, 0.6), v(-1, 0, 0), a, b, 0.5)).toBe(-1);
    expect(rayCapsule(v(5, 1, 0), v(1, 0, 0), a, b, 0.5)).toBe(-1);
    expect(rayCapsule(v(0.1, 1, 0), v(1, 0, 0), a, b, 0.5)).toBe(0);
    expect(rayCapsule(v(0, 2.4, 0), v(1, 0, 0), a, b, 0.5)).toBe(0);
    // Inside the infinite cylinder but beyond the cap, moving away.
    expect(rayCapsule(v(0, 3, 0), norm(0.01, 1, 0), a, b, 0.5)).toBe(-1);
  });

  it('matches a brute-force march for random rays', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const ca = v(0.3, 0.2, -0.4);
    const cb = v(-0.5, 1.7, 0.6);
    const r = 0.35;
    for (let i = 0; i < 300; i++) {
      const o = v((rnd() - 0.5) * 8, (rnd() - 0.5) * 8, (rnd() - 0.5) * 8);
      const target = v((rnd() - 0.5) * 2, rnd() * 2, (rnd() - 0.5) * 2);
      const d = norm(target.x - o.x, target.y - o.y, target.z - o.z);
      const t = rayCapsule(o, d, ca, cb, r);
      // March in 1 mm steps.
      let hitT = -1;
      for (let s = 0; s < 12; s += 0.001) {
        const p = v(o.x + d.x * s, o.y + d.y * s, o.z + d.z * s);
        if (pointSegmentDistanceSq(p, ca, cb) <= r * r) {
          hitT = s;
          break;
        }
      }
      if (hitT < 0) expect(t).toBe(-1);
      else expect(Math.abs(t - hitT)).toBeLessThan(0.002);
    }
  });

  it('degenerate capsule is a sphere', () => {
    expect(rayCapsule(v(0, 0, 10), v(0, 0, -1), a, a, 1)).toBeCloseTo(9, 9);
  });
});

describe('normals and overlap', () => {
  it('capsule normal points away from the axis, sphere normal from the center', () => {
    const n = capsuleNormal(v(0.5, 1, 0), v(0, 0, 0), v(0, 2, 0), v(0, 0, 0));
    expect(n).toEqual({ x: 1, y: 0, z: 0 });
    const top = capsuleNormal(v(0, 2.5, 0), v(0, 0, 0), v(0, 2, 0), v(0, 0, 0));
    expect(top.y).toBeCloseTo(1, 9);
    const s = sphereNormal(v(0, 0, 2), v(0, 0, 1), v(0, 0, 0));
    expect(s.z).toBeCloseTo(1, 9);
  });

  it('spheres overlap including touching', () => {
    expect(spheresOverlap(v(0, 0, 0), 1, v(2, 0, 0), 1)).toBe(true);
    expect(spheresOverlap(v(0, 0, 0), 1, v(2.01, 0, 0), 1)).toBe(false);
  });
});

describe('falloffMultiplier', () => {
  it('is 1 before start, linear to min at end, min beyond', () => {
    expect(falloffMultiplier(0, 10, 30, 0.5)).toBe(1);
    expect(falloffMultiplier(10, 10, 30, 0.5)).toBe(1);
    expect(falloffMultiplier(20, 10, 30, 0.5)).toBeCloseTo(0.75, 9);
    expect(falloffMultiplier(30, 10, 30, 0.5)).toBe(0.5);
    expect(falloffMultiplier(300, 10, 30, 0.5)).toBe(0.5);
  });

  it('handles degenerate ranges and NaN', () => {
    expect(falloffMultiplier(11, 10, 10, 0.4)).toBe(0.4);
    expect(falloffMultiplier(Number.NaN, 10, 30, 0.5)).toBe(1);
  });
});
