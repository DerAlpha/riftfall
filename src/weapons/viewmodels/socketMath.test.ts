import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { adsOffsetFromSight, mapViewPointBetweenProjections } from './socketMath';

function cams(fovA: number, fovB: number, aspect = 16 / 9): [PerspectiveCamera, PerspectiveCamera] {
  const a = new PerspectiveCamera(fovA, aspect, 0.01, 10);
  const b = new PerspectiveCamera(fovB, aspect, 0.05, 400);
  a.updateProjectionMatrix();
  b.updateProjectionMatrix();
  return [a, b];
}

describe('mapViewPointBetweenProjections', () => {
  it('is the identity for identical projections', () => {
    const [a] = cams(62, 62);
    const p = new Vector3(0.12, -0.08, -0.45);
    const out = mapViewPointBetweenProjections(
      p,
      a.projectionMatrix,
      a.projectionMatrixInverse,
      new Vector3(),
    );
    expect(out.distanceTo(p)).toBeLessThan(1e-9);
  });

  it('keeps the NDC position and the view depth across different FOVs', () => {
    const [vm, world] = cams(62, 74);
    for (const p of [
      new Vector3(0.12, -0.08, -0.45),
      new Vector3(-0.3, 0.2, -1.2),
      new Vector3(0, 0, -0.2),
    ]) {
      const out = mapViewPointBetweenProjections(
        p,
        vm.projectionMatrix,
        world.projectionMatrixInverse,
        new Vector3(),
      );
      expect(out.z).toBeCloseTo(p.z, 9);
      const ndcA = p.clone().applyMatrix4(vm.projectionMatrix);
      const ndcB = out.clone().applyMatrix4(world.projectionMatrix);
      expect(ndcB.x).toBeCloseTo(ndcA.x, 6);
      expect(ndcB.y).toBeCloseTo(ndcA.y, 6);
      // A wider world FOV needs a larger lateral offset for the same pixel.
      if (p.x !== 0) expect(Math.abs(out.x)).toBeGreaterThan(Math.abs(p.x));
    }
  });

  it('supports aliasing and leaves points behind the eye untouched', () => {
    const [vm, world] = cams(62, 90, 21 / 9);
    const p = new Vector3(0.1, 0.1, -0.5);
    const expected = mapViewPointBetweenProjections(
      p,
      vm.projectionMatrix,
      world.projectionMatrixInverse,
      new Vector3(),
    );
    mapViewPointBetweenProjections(p, vm.projectionMatrix, world.projectionMatrixInverse, p);
    expect(p.distanceTo(expected)).toBeLessThan(1e-12);
    const behind = new Vector3(0.1, 0.1, 0.2);
    const out = mapViewPointBetweenProjections(
      behind,
      vm.projectionMatrix,
      world.projectionMatrixInverse,
      new Vector3(),
    );
    expect(out.equals(behind)).toBe(true);
  });
});

describe('adsOffsetFromSight', () => {
  it('puts the sight socket on the view axis at the eye distance', () => {
    const sight = { x: 0.001, y: 0.108, z: -0.011 };
    const off = adsOffsetFromSight(sight, 0.2, { x: 0, y: 0, z: 0 });
    expect(off.x + sight.x).toBeCloseTo(0, 12);
    expect(off.y + sight.y).toBeCloseTo(0, 12);
    expect(off.z + sight.z).toBeCloseTo(-0.2, 12);
    const nudged = adsOffsetFromSight(sight, 0.2, { x: 0, y: 0, z: 0 }, { x: 0, y: -0.001, z: 0 });
    expect(nudged.y).toBeCloseTo(off.y - 0.001, 12);
  });
});
