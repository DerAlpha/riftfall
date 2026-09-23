/**
 * Navmesh generation shared by the Web Worker (navWorker.ts) and the main-thread fallback:
 * world-unit defs → recast voxel config, the generator call and the worker message protocol.
 * No three.js imports (keeps the worker bundle small).
 */
import type { NavMesh, RecastConfig } from 'recast-navigation';
import { generateSoloNavMesh, generateTiledNavMesh } from 'recast-navigation/generators';
import { NAV, type NavBuildDefs } from '../defs/nav';

/** Serializable generator input (plain numbers – crosses the worker boundary). */
export interface NavGeneratorConfig {
  mode: 'tiled' | 'solo';
  recast: RecastConfig;
}

export interface NavBuildRequest {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  config: NavGeneratorConfig;
}

export type NavBuildResponse =
  { id: number; ok: true; data: Uint8Array; ms: number } | { id: number; ok: false; error: string };

/** Guards float noise in world→cell conversions (0.4 / 0.2 must stay 2 cells). */
const CELL_EPSILON = 1e-6;
/**
 * Geometry is lowered by this fraction of a voxel height before rasterization: recast rounds span
 * tops UP (ceil), so a floor lying exactly on a voxel boundary lands on either side depending on
 * float noise – one full voxel too high. Lowered a hair below the boundary it rounds to it.
 */
const SNAP_BELOW_CELL = 0.01;

/** Convert the world-unit build defs into recast's voxel-unit config. Pure. */
export function createGeneratorConfig(b: NavBuildDefs = NAV.build): NavGeneratorConfig {
  const cs = b.cellSize;
  const ch = b.cellHeight;
  return {
    mode: b.mode,
    recast: {
      borderSize: 0,
      tileSize: b.mode === 'tiled' ? Math.max(1, Math.round(b.tileSize / cs)) : 0,
      cs,
      ch,
      walkableSlopeAngle: b.walkableSlopeDeg,
      walkableHeight: Math.ceil(b.agentHeight / ch - CELL_EPSILON),
      walkableClimb: Math.floor(b.agentClimb / ch + CELL_EPSILON),
      walkableRadius: Math.ceil(b.agentRadius / cs - CELL_EPSILON),
      maxEdgeLen: Math.floor(b.maxEdgeLength / cs + CELL_EPSILON),
      maxSimplificationError: b.maxSimplificationError,
      minRegionArea: b.minRegionSize,
      mergeRegionArea: b.mergeRegionSize,
      maxVertsPerPoly: b.maxVertsPerPoly,
      detailSampleDist: b.detailSampleDist,
      detailSampleMaxError: b.detailSampleMaxError,
    },
  };
}

/**
 * Generator input with voxel-aligned heights: bounds whose min Y lies on the world voxel grid (one
 * voxel below the lowest vertex), and positions lowered by SNAP_BELOW_CELL voxels. Floors at
 * multiples of the voxel height (0, 4.5 m decks, ...) then come out exact instead of one voxel
 * high. Returns a new positions array (the input is left untouched).
 */
export function alignForVoxels(
  positions: Float32Array,
  cellHeight: number,
): { positions: Float32Array; bounds: [[number, number, number], [number, number, number]] } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const shifted = new Float32Array(positions.length);
  const dy = cellHeight * SNAP_BELOW_CELL;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]! - dy;
    const z = positions[i + 2]!;
    shifted[i] = x;
    shifted[i + 1] = y;
    shifted[i + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const floorY = (Math.floor(minY / cellHeight) - 1) * cellHeight;
  return {
    positions: shifted,
    bounds: [
      [minX, floorY, minZ],
      [maxX, maxY + cellHeight, maxZ],
    ],
  };
}

export type NavGenerateResult = { navMesh: NavMesh; polys: number } | { navMesh: null; error: string };

/** Total polygon count over all tiles (build-time helper; allocates wrappers). */
export function countNavMeshPolys(navMesh: NavMesh): { polys: number; tiles: number } {
  let polys = 0;
  let tiles = 0;
  const max = navMesh.getMaxTiles();
  for (let i = 0; i < max; i++) {
    const header = navMesh.getTile(i).header();
    if (!header) continue;
    const n = header.polyCount();
    if (n > 0) {
      polys += n;
      tiles++;
    }
  }
  return { polys, tiles };
}

/**
 * Generate a navmesh from world-space triangles. Recast must be initialized (`init()`).
 * Never throws: failures (including an empty result) come back as `error`.
 */
export function generateNavMesh(
  positions: Float32Array,
  indices: Uint32Array,
  config: NavGeneratorConfig,
): NavGenerateResult {
  try {
    if (positions.length < 9 || indices.length < 3) return { navMesh: null, error: 'no triangles' };
    const aligned = alignForVoxels(positions, config.recast.ch);
    const cfg = { ...config.recast, bounds: aligned.bounds };
    const result =
      config.mode === 'solo'
        ? generateSoloNavMesh(aligned.positions, indices, cfg)
        : generateTiledNavMesh(aligned.positions, indices, cfg);
    if (!result.success) return { navMesh: null, error: result.error };
    const { polys } = countNavMeshPolys(result.navMesh);
    if (polys === 0) {
      result.navMesh.destroy();
      return { navMesh: null, error: 'navmesh is empty (no walkable surface)' };
    }
    return { navMesh: result.navMesh, polys };
  } catch (err) {
    return { navMesh: null, error: err instanceof Error ? err.message : String(err) };
  }
}
