import { describe, expect, it } from 'vitest';
import { NAV } from '../defs/nav';
import { alignForVoxels, createGeneratorConfig, generateNavMesh } from './navBuild';
import { ensureRecast } from './recast';

describe('createGeneratorConfig', () => {
  it('converts world units into recast voxels', () => {
    const { mode, recast } = createGeneratorConfig();
    expect(mode).toBe(NAV.build.mode);
    expect(recast.cs).toBe(NAV.build.cellSize);
    expect(recast.ch).toBe(NAV.build.cellHeight);
    expect(recast.walkableRadius).toBe(2); // 0.4 m / 0.2 m – no rounding slack
    expect(recast.walkableHeight).toBe(36); // 1.8 m / 0.05 m
    expect(recast.walkableClimb).toBe(7); // floor(0.35 / 0.05): the 0.2 m stairs fit, 0.5 m crates do not
    expect(recast.walkableClimb * recast.ch).toBeGreaterThanOrEqual(0.2);
    expect(recast.walkableClimb * recast.ch).toBeLessThan(0.5);
    expect(recast.tileSize).toBe(48);
    expect(recast.maxEdgeLen).toBe(30);
    expect(recast.walkableSlopeAngle).toBe(NAV.build.walkableSlopeDeg);
    expect(Number.isInteger(recast.walkableRadius + recast.walkableHeight + recast.walkableClimb)).toBe(true);
  });

  it('uses no tiles in solo mode and rounds radii up', () => {
    const { recast } = createGeneratorConfig({ ...NAV.build, mode: 'solo', agentRadius: 0.45 });
    expect(recast.tileSize).toBe(0);
    expect(recast.walkableRadius).toBe(3);
  });

  it('is serializable for the worker', () => {
    const cfg = createGeneratorConfig();
    expect(structuredClone(cfg)).toEqual(cfg);
  });
});

describe('alignForVoxels', () => {
  it('puts the bounds floor on the voxel grid below the geometry and lowers vertices a hair', () => {
    const ch = 0.05;
    const src = new Float32Array([0, -0.2, 0, 4, 1.37, 2, -3, 0, 5]);
    const { positions, bounds } = alignForVoxels(src, ch);
    expect(src[1]).toBeCloseTo(-0.2, 6); // input untouched
    expect(positions[1]!).toBeLessThan(-0.2);
    expect(positions[1]!).toBeGreaterThan(-0.2 - ch * 0.05);
    const floorCells = bounds[0][1] / ch;
    expect(Math.abs(floorCells - Math.round(floorCells))).toBeLessThan(1e-6);
    expect(bounds[0][1]).toBeLessThan(positions[1]!);
    expect(bounds[0][0]).toBe(-3);
    expect(bounds[1][0]).toBe(4);
    expect(bounds[1][1]).toBeGreaterThan(1.37);
    expect(bounds[0][2]).toBe(0);
    expect(bounds[1][2]).toBe(5);
  });
});

describe('generateNavMesh', () => {
  it('reports errors instead of throwing', async () => {
    await ensureRecast();
    const cfg = createGeneratorConfig();
    const empty = generateNavMesh(new Float32Array(0), new Uint32Array(0), cfg);
    expect(empty.navMesh).toBeNull();
    // A vertical wall only: nothing walkable.
    const wall = generateNavMesh(
      new Float32Array([0, 0, 0, 0, 3, 0, 3, 0, 0, 3, 3, 0]),
      new Uint32Array([0, 1, 2, 2, 1, 3]),
      cfg,
    );
    expect(wall.navMesh).toBeNull();
    if (!wall.navMesh) expect(wall.error).toMatch(/empty/);
  });

  it('builds a solo navmesh for a floor', async () => {
    await ensureRecast();
    const s = 5;
    const floor = new Float32Array([-s, 0, -s, -s, 0, s, s, 0, s, s, 0, -s]);
    const res = generateNavMesh(
      floor,
      new Uint32Array([0, 1, 2, 0, 2, 3]),
      createGeneratorConfig({ ...NAV.build, mode: 'solo' }),
    );
    expect(res.navMesh).not.toBeNull();
    if (res.navMesh) {
      expect(res.polys).toBeGreaterThan(0);
      res.navMesh.destroy();
    }
  });
});
