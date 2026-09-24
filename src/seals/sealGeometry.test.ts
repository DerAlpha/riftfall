import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SEALS } from '../defs/seals';
import {
  alongPlane,
  barHeight,
  buildSealFrame,
  confineToPen,
  frontDistance,
  type SealProbe,
} from './sealGeometry';

const GATE = SEALS.gates.rift;

describe('seal frame', () => {
  it('stands `offset` in front of the spawn point, across its yaw', () => {
    // yaw 0: enemies emerge towards +Z.
    const f = buildSealFrame({ position: new Vector3(4, 0, -10), yaw: 0 }, GATE);
    expect(f.cx).toBeCloseTo(4);
    expect(f.cz).toBeCloseTo(-10 + GATE.offset);
    expect(f.fx).toBeCloseTo(0);
    expect(f.fz).toBeCloseTo(1);
    // The plane axis is perpendicular to forward.
    expect(f.sx * f.fx + f.sz * f.fz).toBeCloseTo(0);
    expect(f.left).toBeCloseTo(GATE.width / 2);
    expect(f.right).toBeCloseTo(GATE.width / 2);
    // The spawn point lies behind the plane, the player side in front.
    expect(frontDistance(f, { x: 4, y: 0, z: -10 })).toBeCloseTo(-GATE.offset);
    expect(frontDistance(f, { x: 4, y: 0, z: 5 })).toBeGreaterThan(0);
  });

  it('bars sit in the middle of equal bands between bottom and top', () => {
    const f = buildSealFrame({ position: new Vector3(), yaw: 1.2 }, GATE);
    const n = 5;
    const band = (GATE.height - GATE.bottom) / n;
    expect(barHeight(f, 0, n)).toBeCloseTo(GATE.bottom + band / 2);
    expect(barHeight(f, n - 1, n)).toBeCloseTo(GATE.height - band / 2);
  });

  it('is fitted into the room with a static probe (walls, ceiling, wall behind)', () => {
    // A corridor 2 m wide (walls at x = ±1), ceiling at 2.2 m, back wall 1.5 m behind the plane.
    const probe: SealProbe = (o, d, max) => {
      let t = max;
      if (d.x > 0.5) t = Math.min(t, 1 - o.x);
      if (d.x < -0.5) t = Math.min(t, o.x + 1);
      if (d.y > 0.5) t = Math.min(t, 2.2 - o.y);
      if (d.z < -0.5) t = Math.min(t, o.z + 1.5);
      return Math.max(0, t);
    };
    const f = buildSealFrame({ position: new Vector3(0, 0, -1.05), yaw: 0 }, GATE, probe);
    const F = SEALS.fit;
    expect(f.right).toBeCloseTo(Math.max(F.minHalfWidth, 1 - F.wallMargin));
    expect(f.left).toBeCloseTo(Math.max(F.minHalfWidth, 1 - F.wallMargin));
    expect(f.height).toBeCloseTo(2.2 - F.ceilingMargin);
    expect(f.penDepth).toBeCloseTo(1.5);
  });

  it('confines positions to the pen behind the plane', () => {
    const f = buildSealFrame({ position: new Vector3(0, 0, 0), yaw: Math.PI / 2 }, GATE);
    const r = 0.4;
    const P = SEALS.pen;
    // In front of the plane and far to the side → pulled behind it, between the pylons.
    const p = { x: f.cx + 3, y: 0, z: f.cz + 9 };
    confineToPen(f, p, r);
    const w = frontDistance(f, p);
    const u = alongPlane(f, p);
    expect(w).toBeLessThanOrEqual(-(P.standOff + r) + 1e-9);
    expect(w).toBeGreaterThanOrEqual(-(f.penDepth - r) - 1e-9);
    expect(Math.abs(u)).toBeLessThanOrEqual(GATE.width / 2 - r - P.sideMargin + 1e-9);
    // A position already inside the pen stays put.
    const inside = { x: f.cx - f.fx * 1.2, y: 3, z: f.cz - f.fz * 1.2 };
    const before = { ...inside };
    confineToPen(f, inside, r);
    expect(inside).toEqual(before);
  });
});
