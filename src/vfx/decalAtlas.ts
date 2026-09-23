/**
 * Procedural decal atlas (DECAL_CELLS × DECAL_ATLAS cells): three RGBA8 textures sharing one layout
 * - albedo (sRGB) + coverage alpha,
 * - tangent-space normal map (from a per-cell height field, so holes read as embedded),
 * - "ORM" in glTF channel order but with R = emissive mask (afterglow), G = roughness, B = metalness.
 *
 * Generation is pure (Uint8Arrays, deterministic) and unit-testable; createDecalAtlas() wraps the
 * result in mipmapped DataTextures. Every cell fades to zero alpha before its border.
 */
import * as THREE from 'three';
import { DECAL_ATLAS, DECAL_CELLS, type DecalKind } from '../defs/vfx';
import { clamp01, fbm, mulberry32, smooth, valueNoise } from './noise';

/** Surface sample written by a cell generator (all 0..1 except height, which is relative). */
export interface DecalSample {
  r: number;
  g: number;
  b: number;
  a: number;
  height: number;
  emissive: number;
  roughness: number;
  metalness: number;
}

type DecalFn = (u: number, v: number, s: DecalSample, seed: number) => void;

const TAU = Math.PI * 2;

function radial(u: number, v: number): number {
  return Math.sqrt(u * u + v * v);
}

function angle01(u: number, v: number): number {
  return (Math.atan2(v, u) + Math.PI) / TAU;
}

function grey(s: DecalSample, value: number): void {
  s.r = s.g = s.b = clamp01(value);
}

/** Random droplet layout (x, y, radius) for splats, cached per seed. */
const dropCache = new Map<number, Float32Array>();
function droplets(seed: number, count: number, minR: number, maxR: number, reach: number): Float32Array {
  const key = seed * 131 + count;
  let d = dropCache.get(key);
  if (!d) {
    const rand = mulberry32(seed);
    d = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const ang = rand() * TAU;
      const dist = 0.3 + rand() * reach;
      d[i * 3] = Math.cos(ang) * dist;
      d[i * 3 + 1] = Math.sin(ang) * dist;
      d[i * 3 + 2] = minR + rand() * (maxR - minR);
    }
    dropCache.set(key, d);
  }
  return d;
}

/** Liquid splat coverage (central blob + spikes + droplets), 0..1. */
function splat(u: number, v: number, seed: number): number {
  const r = radial(u, v);
  const a01 = angle01(u, v);
  const n = fbm(u * 3 + 1.3, v * 3 - 4.1, 4, seed);
  const blob = 1 - smooth(0.26, 0.34, r + (n - 0.5) * 0.28);
  const spikeNoise = valueNoise(a01 * 22, 0.5, seed + 9);
  const spikeLen = 0.35 + 0.5 * Math.pow(spikeNoise, 3);
  const spikes = (1 - smooth(spikeLen - 0.05, spikeLen, r)) * smooth(0.55, 0.8, spikeNoise);
  let drops = 0;
  const d = droplets(seed, 14, 0.02, 0.06, 0.55);
  for (let i = 0; i < d.length; i += 3) {
    const dx = u - d[i]!;
    const dy = v - d[i + 1]!;
    const rr = d[i + 2]!;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) continue;
    drops = Math.max(drops, 1 - smooth(rr * 0.8, rr, Math.sqrt(d2)));
  }
  return clamp01(Math.max(blob, spikes, drops)) * (1 - smooth(0.9, 0.98, r));
}

const GENERATORS: Record<DecalKind, DecalFn> = {
  'bullet.metal'(u, v, s, seed) {
    const r = radial(u, v);
    const a01 = angle01(u, v);
    const streak = valueNoise(a01 * 28, r * 2.5, seed);
    const hole = 1 - smooth(0.1, 0.13, r);
    const lip = Math.exp(-(((r - 0.19) / 0.06) ** 2));
    const scrape = (1 - smooth(0.25, 0.55 + 0.1 * streak, r)) * (0.5 + 0.5 * streak);
    const soot = 1 - smooth(0.3, 0.75, r + (fbm(u * 4, v * 4, 3, seed) - 0.5) * 0.3);
    s.height = -hole * 1.2 + lip * 0.55 - (1 - hole) * (1 - smooth(0.1, 0.3, r)) * 0.25;
    grey(s, hole > 0.5 ? 0.02 : 0.08 + lip * 0.55 + scrape * 0.3);
    s.a = clamp01(Math.max(hole, lip, scrape * 0.85, soot * 0.45));
    s.roughness = hole > 0.5 ? 0.9 : 0.25 + (1 - lip) * 0.35;
    s.metalness = hole > 0.5 ? 0.2 : 0.35 + 0.65 * Math.max(lip, scrape);
    s.emissive = clamp01(Math.exp(-(((r - 0.14) / 0.07) ** 2)) + hole * 0.35);
  },
  'bullet.concrete'(u, v, s, seed) {
    const r = radial(u, v);
    const a01 = angle01(u, v);
    const n = fbm(u * 5, v * 5, 4, seed);
    const holeR = 0.15 + (valueNoise(a01 * 9, 0.2, seed) - 0.5) * 0.08;
    const hole = 1 - smooth(holeR - 0.02, holeR + 0.01, r);
    const spallR = 0.36 + (valueNoise(a01 * 7, 1.7, seed + 5) - 0.5) * 0.2;
    const spall = 1 - smooth(spallR - 0.05, spallR + 0.02, r);
    const crackLine = Math.pow(1 - Math.abs(valueNoise(a01 * 11, r * 1.5, seed + 13) * 2 - 1), 18);
    const cracks = crackLine * (1 - smooth(0.3, 0.65, r)) * (r > holeR ? 1 : 0);
    s.height = -hole * 1.1 - spall * 0.45 * (0.6 + 0.4 * n) - cracks * 0.3;
    grey(s, hole > 0.5 ? 0.035 : spall > 0.5 ? 0.24 + 0.14 * n : 0.12);
    s.a = clamp01(
      Math.max(hole, spall * (0.75 + 0.25 * n), cracks * 0.9, (1 - smooth(0.3, 0.7, r)) * 0.35 * n),
    );
    s.roughness = 0.95;
    s.metalness = 0;
    s.emissive = 0;
  },
  'glass.crack'(u, v, s, seed) {
    const r = radial(u, v);
    const a01 = angle01(u, v);
    const rays = 9;
    const wobble = (valueNoise(r * 6, a01 * 3, seed) - 0.5) * 0.06;
    const k = a01 * rays + wobble * rays;
    const rayDist = Math.abs(k - Math.round(k)) / rays; // angular distance to the nearest ray (turns)
    const rayLen = 0.45 + 0.45 * hashRay(Math.round(k) % rays, seed);
    const ray =
      Math.exp(-(((rayDist * TAU * Math.max(r, 0.05)) / 0.006) ** 2)) * (1 - smooth(rayLen - 0.1, rayLen, r));
    const ring1 =
      Math.exp(-(((r - 0.22) / 0.008) ** 2)) * smooth(0.35, 0.6, valueNoise(a01 * 14, 2, seed + 3));
    const ring2 = Math.exp(-(((r - 0.4) / 0.008) ** 2)) * smooth(0.5, 0.7, valueNoise(a01 * 18, 4, seed + 7));
    const frost = 1 - smooth(0.04, 0.08, r);
    const line = clamp01(ray + ring1 + ring2);
    s.height = line * 0.6 + frost * 0.4;
    grey(s, 0.85);
    s.a = clamp01(Math.max(line * 0.85, frost * 0.9));
    s.roughness = 0.12 + frost * 0.5;
    s.metalness = 0;
    s.emissive = 0;
  },
  scorch(u, v, s, seed) {
    const r = radial(u, v);
    const n = fbm(u * 2.5 + 3, v * 2.5 - 1, 5, seed);
    const body = 1 - smooth(0.15, 0.92, r + (n - 0.5) * 0.55);
    const embers = smooth(0.66, 0.8, fbm(u * 9, v * 9, 3, seed + 21)) * (1 - smooth(0.05, 0.5, r));
    s.height = -body * 0.15 + (n - 0.5) * 0.2 * body;
    grey(s, 0.015 + 0.05 * n);
    s.a = clamp01(body * (0.75 + 0.35 * n));
    s.roughness = 0.95;
    s.metalness = 0;
    s.emissive = clamp01(embers * 1.2);
  },
  blood(u, v, s, seed) {
    const cover = splat(u, v, seed);
    const n = fbm(u * 6, v * 6, 3, seed + 2);
    s.height = cover * (0.35 + 0.2 * n);
    s.r = 0.2 + 0.08 * n;
    s.g = 0.008;
    s.b = 0.006;
    s.a = clamp01(cover * 0.96);
    s.roughness = 0.22 + 0.2 * (1 - cover);
    s.metalness = 0;
    s.emissive = 0;
  },
  slime(u, v, s, seed) {
    const cover = splat(u, v, seed + 77);
    const n = fbm(u * 5, v * 5, 3, seed + 4);
    s.height = cover * (0.45 + 0.25 * n);
    s.r = 0.05 + 0.04 * n;
    s.g = 0.26 + 0.12 * n;
    s.b = 0.05;
    s.a = clamp01(cover * 0.94);
    s.roughness = 0.18;
    s.metalness = 0;
    s.emissive = clamp01(cover * (0.35 + 0.65 * n));
  },
  scuff(u, v, s, seed) {
    // Elongated ricochet scrape along u.
    const e = Math.sqrt((u * u) / 0.36 + (v * v) / 0.02);
    const streak = valueNoise(v * 40, u * 3, seed);
    const body = (1 - smooth(0.6, 1, e)) * (0.55 + 0.45 * streak);
    s.height = -body * 0.4;
    grey(s, 0.55 + 0.25 * streak);
    s.a = clamp01(body);
    s.roughness = 0.3;
    s.metalness = 1;
    s.emissive = clamp01((1 - smooth(0.1, 0.6, e)) * 0.8);
  },
  'bullet.generic'(u, v, s, seed) {
    const r = radial(u, v);
    const n = fbm(u * 5, v * 5, 3, seed);
    const hole = 1 - smooth(0.11, 0.14, r);
    const rim = Math.exp(-(((r - 0.17) / 0.05) ** 2));
    const soot = 1 - smooth(0.2, 0.6, r + (n - 0.5) * 0.3);
    s.height = -hole * 1.1 + rim * 0.35;
    grey(s, hole > 0.5 ? 0.03 : 0.1 + 0.1 * n);
    s.a = clamp01(Math.max(hole, rim * 0.9, soot * 0.55));
    s.roughness = 0.8;
    s.metalness = 0;
    s.emissive = 0;
  },
};

function hashRay(i: number, seed: number): number {
  return valueNoise(i * 3.7 + 0.5, 9.1, seed);
}

export interface DecalAtlasPixels {
  width: number;
  height: number;
  cellSize: number;
  seed: number;
  /** RGBA8, rows bottom-up (DataTexture layout). */
  albedo: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
  /** Scratch height field of one cell. */
  heights: Float32Array;
}

/** Tangent-space normal from a height field by central differences (clamped at the borders). */
export function heightToNormal(
  heights: Float32Array,
  size: number,
  strength: number,
  x: number,
  y: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const x0 = Math.max(0, x - 1);
  const x1 = Math.min(size - 1, x + 1);
  const y0 = Math.max(0, y - 1);
  const y1 = Math.min(size - 1, y + 1);
  // y grows downwards in the image; tangent-space +Y is up (v), so the y slope is flipped.
  const dx = (heights[y * size + x1]! - heights[y * size + x0]!) * 0.5 * strength;
  const dy = (heights[y0 * size + x]! - heights[y1 * size + x]!) * 0.5 * strength;
  const len = Math.sqrt(dx * dx + dy * dy + 1);
  out.x = -dx / len;
  out.y = -dy / len;
  out.z = 1 / len;
  return out;
}

function allocDecalAtlas(cellSize: number, seed: number): DecalAtlasPixels {
  const width = DECAL_ATLAS.cols * cellSize;
  const height = DECAL_ATLAS.rows * cellSize;
  const n = width * height * 4;
  return {
    width,
    height,
    cellSize,
    seed,
    albedo: new Uint8Array(n),
    normal: new Uint8Array(n),
    orm: new Uint8Array(n),
    heights: new Float32Array(cellSize * cellSize),
  };
}

const _s: DecalSample = { r: 0, g: 0, b: 0, a: 0, height: 0, emissive: 0, roughness: 1, metalness: 0 };
const _nrm = { x: 0, y: 0, z: 1 };

/** Render one decal cell (albedo, ORM, then normals from its height field). */
function writeDecalCell(p: DecalAtlasPixels, cell: number): void {
  const { cols, normalStrength } = DECAL_ATLAS;
  const { width, height, cellSize, albedo, normal, orm, heights } = p;
  const gen = GENERATORS[DECAL_CELLS[cell]!];
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  const cellSeed = p.seed + cell * 131;
  // Height gradients are per texel: scale so the look does not depend on the cell resolution.
  const strength = normalStrength * (cellSize / 64);
  const s = _s;
  for (let y = 0; y < cellSize; y++) {
    const v = 1 - ((y + 0.5) / cellSize) * 2;
    const dataRow = height - 1 - (row * cellSize + y);
    for (let x = 0; x < cellSize; x++) {
      const u = ((x + 0.5) / cellSize) * 2 - 1;
      s.r = s.g = s.b = s.a = s.height = s.emissive = s.metalness = 0;
      s.roughness = 1;
      gen(u, v, s, cellSeed);
      // Edge guard: nothing reaches the cell border (mip bleeding, quad edges).
      const edge = 1 - smooth(0.9, 0.99, Math.max(Math.abs(u), Math.abs(v)));
      const a = clamp01(s.a) * edge;
      heights[y * cellSize + x] = s.height * edge;
      const i = (dataRow * width + col * cellSize + x) * 4;
      albedo[i] = Math.round(clamp01(s.r) * 255);
      albedo[i + 1] = Math.round(clamp01(s.g) * 255);
      albedo[i + 2] = Math.round(clamp01(s.b) * 255);
      albedo[i + 3] = Math.round(a * 255);
      orm[i] = Math.round(clamp01(s.emissive) * 255);
      orm[i + 1] = Math.round(clamp01(s.roughness) * 255);
      orm[i + 2] = Math.round(clamp01(s.metalness) * 255);
      orm[i + 3] = 255;
    }
  }
  const n = _nrm;
  for (let y = 0; y < cellSize; y++) {
    const dataRow = height - 1 - (row * cellSize + y);
    for (let x = 0; x < cellSize; x++) {
      heightToNormal(heights, cellSize, strength, x, y, n);
      const i = (dataRow * width + col * cellSize + x) * 4;
      normal[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
}

export function generateDecalAtlasPixels(
  cellSize: number = DECAL_ATLAS.cellSize,
  seed: number = DECAL_ATLAS.seed,
): DecalAtlasPixels {
  const p = allocDecalAtlas(cellSize, seed);
  for (let cell = 0; cell < DECAL_CELLS.length; cell++) writeDecalCell(p, cell);
  return p;
}

/** Same pixels, yielding between cells (keeps a loading screen responsive). */
export async function generateDecalAtlasPixelsAsync(
  yieldFn: () => Promise<void>,
  cellSize: number = DECAL_ATLAS.cellSize,
  seed: number = DECAL_ATLAS.seed,
): Promise<DecalAtlasPixels> {
  const p = allocDecalAtlas(cellSize, seed);
  for (let cell = 0; cell < DECAL_CELLS.length; cell++) {
    writeDecalCell(p, cell);
    await yieldFn();
  }
  return p;
}

export interface DecalAtlasTextures {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  orm: THREE.DataTexture;
  dispose(): void;
}

function texture(data: Uint8Array, w: number, h: number, name: string, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = name;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = DECAL_ATLAS.anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Mipmapped DataTextures (albedo sRGB, normal + ORM linear) from generated pixels. */
export function decalAtlasTextures(p: DecalAtlasPixels): DecalAtlasTextures {
  const albedo = texture(p.albedo, p.width, p.height, 'vfx-decal-albedo', true);
  const normal = texture(p.normal, p.width, p.height, 'vfx-decal-normal', false);
  const orm = texture(p.orm, p.width, p.height, 'vfx-decal-orm', false);
  return {
    albedo,
    normal,
    orm,
    dispose() {
      albedo.dispose();
      normal.dispose();
      orm.dispose();
    },
  };
}

export function createDecalAtlas(): DecalAtlasTextures {
  return decalAtlasTextures(generateDecalAtlasPixels());
}
