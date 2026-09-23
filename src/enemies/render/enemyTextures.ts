/**
 * Procedural surface texture shared by every enemy type (tileable RGBA8, generated once at load):
 *   R  blotches  – fractal value noise (albedo variation, wetness)
 *   G  cells     – cellular plates/scales: 0 on the seams, 1 inside (chitin, armor panels)
 *   B  veins     – domain-warped ridged noise: bright thin branching lines (emissive veins)
 *   A  pores     – fine high-frequency bumps (skin pores, pitting)
 * The shader samples it triplanar in rest-pose object space, so patterns stick to the animated
 * body. Pure data generation (no three.js) + a thin DataTexture wrapper.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';
import { ENEMY_RENDER } from '../../defs/enemyVisuals';
import { hash2, mulberry32 } from '../../vfx/noise';

/** Value noise with a lattice period of `period` cells (tileable). */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Tileable fbm over the unit square (u, v in 0..1), base frequency `freq` cells. */
function periodicFbm(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u * f, v * f, f, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

interface CellGrid {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

/** One jittered feature point per grid cell (wrapped: the pattern tiles). */
function cellGrid(n: number, seed: number): CellGrid {
  const rand = mulberry32(seed);
  const x = new Float32Array(n * n);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      x[j * n + i] = (i + 0.1 + rand() * 0.8) / n;
      y[j * n + i] = (j + 0.1 + rand() * 0.8) / n;
    }
  }
  return { n, x, y };
}

/** Periodic Worley F2 - F1 at (u, v) in cell units (0 on the borders between cells). */
function cellEdge(g: CellGrid, u: number, v: number): number {
  const n = g.n;
  const gi = Math.floor(u * n);
  const gj = Math.floor(v * n);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ci = gi + di;
      const cj = gj + dj;
      const ii = ((ci % n) + n) % n;
      const jj = ((cj % n) + n) % n;
      // The wrapped feature point, moved into the neighbour's tile position.
      const px = g.x[jj * n + ii]! + Math.floor(ci / n);
      const py = g.y[jj * n + ii]! + Math.floor(cj / n);
      const d = Math.hypot(px - u, py - v);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return (f2 - f1) * n;
}

/**
 * Generate the RGBA8 pixels (size × size). Deterministic for a given seed; every channel tiles
 * seamlessly (periodic lattices, wrapped cell search).
 */
export function generateEnemySurface(
  size: number = ENEMY_RENDER.texture.size,
  seed: number = ENEMY_RENDER.texture.seed,
  cells: number = ENEMY_RENDER.texture.cells,
): Uint8Array {
  const T = ENEMY_RENDER.texture;
  const out = new Uint8Array(size * size * 4);
  const plates = cellGrid(cells, seed);
  const veinsCoarse = cellGrid(T.veinCells[0], seed + 3);
  const veinsFine = cellGrid(T.veinCells[1], seed + 7);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      // R: blotches.
      const blot = periodicFbm(u, v, 3, 5, seed + 1);
      // G: plates/scales – 0 on the seams, 1 inside.
      const edge = cellEdge(plates, u, v);
      const cellsV = smooth(0.03, 0.3, edge) * (0.8 + 0.2 * periodicNoise(u * 16, v * 16, 16, seed + 5));
      // B: vein network – borders of domain-warped cells, a coarse and a finer branching layer.
      const wu = u + (periodicFbm(u, v, 4, 3, seed + 11) - 0.5) * T.veinWarp;
      const wv = v + (periodicFbm(u, v, 4, 3, seed + 17) - 0.5) * T.veinWarp;
      const coarse = 1 - smooth(0, T.veinWidth, cellEdge(veinsCoarse, wu, wv));
      const fine = 1 - smooth(0, T.veinWidth * 0.7, cellEdge(veinsFine, wu * 1.0 + 0.37, wv + 0.21));
      const vein = Math.max(coarse, fine * 0.6);
      // A: pores / pitting.
      const pore =
        periodicNoise(u * 16, v * 16, 16, seed + 29) * 0.6 +
        periodicNoise(u * 32, v * 32, 32, seed + 31) * 0.4;
      const o = (y * size + x) * 4;
      out[o] = Math.round(blot * 255);
      out[o + 1] = Math.round(cellsV * 255);
      out[o + 2] = Math.round(vein * 255);
      out[o + 3] = Math.round(pore * 255);
    }
  }
  return out;
}

/** The surface texture as a repeating, mipmapped data texture (linear data, not color). */
export function createEnemySurfaceTexture(): DataTexture {
  const size = ENEMY_RENDER.texture.size;
  const tex = new DataTexture(generateEnemySurface(size), size, size, RGBAFormat, UnsignedByteType);
  tex.name = 'enemy-surface';
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
