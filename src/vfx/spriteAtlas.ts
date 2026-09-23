/**
 * Procedural particle sprite atlas (SPRITES × SPRITE_ATLAS cells, RGBA8). RGB is a grey detail /
 * shading term (1 = white), A the coverage. Particle shaders multiply both with the particle
 * color; additive particles use rgb · a. Every sprite fades to zero alpha before the cell border
 * so mipmaps never bleed into neighbours.
 *
 * Generation is pure (Uint8Array) so it is deterministic and unit-testable; createSpriteAtlas()
 * wraps it in a mipmapped DataTexture.
 */
import * as THREE from 'three';
import { SPRITE_ATLAS, SPRITES, type SpriteId } from '../defs/vfx';
import { clamp01, fbm, mulberry32, smooth, valueNoise } from './noise';

/** Shader of one sprite: u, v in [-1, 1] (v up), writes rgb (grey) + a into `out`. */
type SpriteFn = (u: number, v: number, out: Float32Array, seed: number) => void;

const TAU = Math.PI * 2;

function radial(u: number, v: number): number {
  return Math.sqrt(u * u + v * v);
}

function puff(u: number, v: number, out: Float32Array, seed: number, freq: number, density: number): void {
  const r = radial(u, v);
  const n = fbm(u * freq + 7.3, v * freq - 2.1, 4, seed);
  const edge = 1 - smooth(0.35, 0.98, r + (n - 0.5) * 0.45);
  const body = clamp01(edge * (0.45 + 0.9 * n) * density);
  // Lit from above: brighter top, darker core bottom (reads as volume in a dark scene).
  const shade = 0.62 + 0.3 * clamp01(v * 0.5 + 0.5) + 0.18 * (n - 0.5);
  out[0] = out[1] = out[2] = clamp01(shade);
  out[3] = body;
}

const MIST_BLOBS = 9;
const mistCache = new Map<number, Float32Array>();

/** Blob layout (x, y, radius²) of the mist sprite, cached per seed. */
function mistBlobs(seed: number): Float32Array {
  let blobs = mistCache.get(seed);
  if (!blobs) {
    const rand = mulberry32(seed);
    blobs = new Float32Array(MIST_BLOBS * 3);
    for (let i = 0; i < MIST_BLOBS; i++) {
      const r = 0.12 + rand() * 0.28;
      blobs[i * 3] = (rand() - 0.5) * 1.1;
      blobs[i * 3 + 1] = (rand() - 0.5) * 1.1;
      blobs[i * 3 + 2] = r * r;
    }
    mistCache.set(seed, blobs);
  }
  return blobs;
}

const GENERATORS: Record<SpriteId, SpriteFn> = {
  spark(u, v, out) {
    const r2 = u * u + v * v;
    const a = Math.exp(-r2 * 38) + 0.35 * Math.exp(-r2 * 7);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(a) * (1 - smooth(0.85, 1, Math.sqrt(r2)));
  },
  smoke(u, v, out, seed) {
    puff(u, v, out, seed, 2.4, 1.15);
  },
  smokeB(u, v, out, seed) {
    puff(u, v, out, seed + 17, 3.1, 1.05);
  },
  dust(u, v, out, seed) {
    const r = radial(u, v);
    const n = fbm(u * 1.8 + 3.1, v * 1.8 + 9.2, 3, seed);
    const edge = 1 - smooth(0.2, 1, r + (n - 0.5) * 0.3);
    out[0] = out[1] = out[2] = clamp01(0.78 + 0.22 * n);
    out[3] = clamp01(edge * edge * (0.35 + 0.65 * n));
  },
  flash(u, v, out, seed) {
    const r = radial(u, v);
    const ang = Math.atan2(v, u);
    const rays = 6;
    const jitter = valueNoise(((ang + Math.PI) / TAU) * rays * 2, 0.5, seed) * 0.6 + 0.4;
    const spike = Math.pow(Math.abs(Math.cos((ang * rays) / 2)), 24) * jitter;
    const core = Math.exp(-r * r * 22);
    const halo = Math.exp(-r * r * 4) * 0.35;
    const rayLen = 1 - smooth(0.1, 0.95 * jitter + 0.05, r);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(core + halo + spike * rayLen) * (1 - smooth(0.9, 1, r));
  },
  droplet(u, v, out) {
    const r = radial(u, v);
    const body = 1 - smooth(0.55, 0.75, r);
    const hl = Math.exp(-((u + 0.2) ** 2 + (v - 0.25) ** 2) * 30);
    out[0] = out[1] = out[2] = clamp01(0.7 + 0.3 * hl + 0.15 * (1 - r));
    out[3] = body;
  },
  ember(u, v, out) {
    const r2 = u * u + v * v;
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(Math.exp(-r2 * 30) + 0.25 * Math.exp(-r2 * 6)) * (1 - smooth(0.85, 1, Math.sqrt(r2)));
  },
  ring(u, v, out, seed) {
    const r = radial(u, v);
    const ang = Math.atan2(v, u);
    const breakup = 0.65 + 0.35 * valueNoise(((ang + Math.PI) / TAU) * 12, 1.5, seed);
    const band = Math.exp(-(((r - 0.72) / 0.1) ** 2)) + 0.3 * Math.exp(-(((r - 0.6) / 0.2) ** 2));
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(band * breakup) * (1 - smooth(0.92, 1, r));
  },
  flame(u, v, out, seed) {
    const r = radial(u, v);
    const n = fbm(u * 2.8 + 1.7, v * 2.8 - 5.3, 4, seed);
    const d = r + (n - 0.5) * 0.7;
    const a = 1 - smooth(0.25, 0.9, d);
    out[0] = out[1] = out[2] = clamp01(0.55 + 0.6 * n + 0.3 * (1 - r));
    out[3] = clamp01(a * (0.6 + 0.6 * n)) * (1 - smooth(0.9, 1, r));
  },
  chip(u, v, out, seed) {
    const ang = Math.atan2(v, u);
    const r = radial(u, v);
    const edge = 0.42 + 0.22 * valueNoise(((ang + Math.PI) / TAU) * 5, 0.3, seed);
    const a = 1 - smooth(edge - 0.04, edge + 0.02, r);
    out[0] = out[1] = out[2] = clamp01(0.7 + 0.35 * (v - u) * 0.5 + 0.2 * fbm(u * 6, v * 6, 2, seed));
    out[3] = a;
  },
  glow(u, v, out) {
    const r = radial(u, v);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(Math.exp(-r * r * 5.5) - 0.004) * (1 - smooth(0.9, 1, r));
  },
  petal(u, v, out, seed) {
    // Flame tongue along +v: wide at the base (v = -1), tapering to the tip, noisy edges.
    const t = clamp01((v + 1) * 0.5);
    const width = 0.55 * Math.sqrt(Math.max(0, 1 - t)) * (0.8 + 0.4 * valueNoise(t * 6, 3.3, seed)) + 0.02;
    const across = Math.abs(u) / width;
    const n = fbm(u * 4 + 11, v * 3, 3, seed);
    const a = (1 - smooth(0.4, 1, across)) * (1 - smooth(0.75, 1, t)) * smooth(0, 0.08, t);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(a * (0.6 + 0.6 * n));
  },
  mist(u, v, out, seed) {
    const blobs = mistBlobs(seed);
    let a = 0;
    for (let i = 0; i < blobs.length; i += 3) {
      const d2 = ((u - blobs[i]!) ** 2 + (v - blobs[i + 1]!) ** 2) / blobs[i + 2]!;
      a += Math.exp(-d2 * 2);
    }
    const n = fbm(u * 3, v * 3, 3, seed + 3);
    out[0] = out[1] = out[2] = clamp01(0.75 + 0.3 * n);
    out[3] = clamp01(a * 0.55 * (0.5 + n)) * (1 - smooth(0.75, 1, radial(u, v)));
  },
  shard(u, v, out) {
    // Sharp sliver: a thin triangle (wide base at the bottom) with a bright centre line.
    const half = Math.max(0, (0.75 - v) * 0.3);
    const inside = 1 - smooth(-0.02, 0.02, Math.abs(u) - half);
    const ends = smooth(-0.75, -0.68, v) * (1 - smooth(0.7, 0.75, v));
    out[0] = out[1] = out[2] = clamp01(0.6 + 0.4 * (1 - Math.abs(u) * 4));
    out[3] = 0.85 * inside * ends;
  },
  streak(u, v, out) {
    // Tracer / trail: gaussian across u, bright head at +v fading to the tail at -v.
    const across = Math.exp(-u * u * 28);
    const along = clamp01((v + 1) * 0.5);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(across * (0.25 + 0.75 * along)) * (1 - smooth(0.92, 1, Math.abs(v)));
  },
  star(u, v, out) {
    const r = radial(u, v);
    const cross =
      Math.exp(-Math.abs(u) * 26) * (1 - Math.abs(v)) + Math.exp(-Math.abs(v) * 26) * (1 - Math.abs(u));
    const core = Math.exp(-r * r * 18);
    out[0] = out[1] = out[2] = 1;
    out[3] = clamp01(core + cross * 0.8) * (1 - smooth(0.9, 1, r));
  },
};

export interface SpriteAtlasPixels {
  /** RGBA8, rows bottom-up (DataTexture layout, flipY false), so atlas.ts cellUv() (row 0 = top of the image) addresses the right cells. */
  data: Uint8Array;
  width: number;
  height: number;
  cellSize: number;
  seed: number;
}

function allocSpriteAtlas(cellSize: number, seed: number): SpriteAtlasPixels {
  const width = SPRITE_ATLAS.cols * cellSize;
  const height = SPRITE_ATLAS.rows * cellSize;
  return { data: new Uint8Array(width * height * 4), width, height, cellSize, seed };
}

const _px = new Float32Array(4);

/** Render one sprite cell into the atlas pixels. */
function writeSpriteCell(p: SpriteAtlasPixels, cell: number): void {
  const { cols } = SPRITE_ATLAS;
  const { data, width, height, cellSize } = p;
  const gen = GENERATORS[SPRITES[cell]!];
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  const seed = p.seed + cell * 97;
  const px = _px;
  for (let y = 0; y < cellSize; y++) {
    // Image y (top-down) → v up.
    const v = 1 - ((y + 0.5) / cellSize) * 2;
    const dataRow = height - 1 - (row * cellSize + y);
    for (let x = 0; x < cellSize; x++) {
      const u = ((x + 0.5) / cellSize) * 2 - 1;
      px[0] = px[1] = px[2] = px[3] = 0;
      gen(u, v, px, seed);
      // Edge guard: nothing reaches the cell border (mip bleeding into neighbours).
      px[3] = px[3]! * (1 - smooth(0.88, 0.98, Math.max(Math.abs(u), Math.abs(v))));
      const i = (dataRow * width + col * cellSize + x) * 4;
      data[i] = Math.round(clamp01(px[0]!) * 255);
      data[i + 1] = Math.round(clamp01(px[1]!) * 255);
      data[i + 2] = Math.round(clamp01(px[2]!) * 255);
      data[i + 3] = Math.round(clamp01(px[3]!) * 255);
    }
  }
}

export function generateSpriteAtlasPixels(
  cellSize: number = SPRITE_ATLAS.cellSize,
  seed: number = SPRITE_ATLAS.seed,
): SpriteAtlasPixels {
  const p = allocSpriteAtlas(cellSize, seed);
  for (let cell = 0; cell < SPRITES.length; cell++) writeSpriteCell(p, cell);
  return p;
}

/** Same pixels, yielding between cells (keeps a loading screen responsive). */
export async function generateSpriteAtlasPixelsAsync(
  yieldFn: () => Promise<void>,
  cellSize: number = SPRITE_ATLAS.cellSize,
  seed: number = SPRITE_ATLAS.seed,
): Promise<SpriteAtlasPixels> {
  const p = allocSpriteAtlas(cellSize, seed);
  for (let cell = 0; cell < SPRITES.length; cell++) {
    writeSpriteCell(p, cell);
    await yieldFn();
  }
  return p;
}

/** Mipmapped, linear (non-color) RGBA8 atlas texture from generated pixels. */
export function spriteAtlasTexture(p: SpriteAtlasPixels): THREE.DataTexture {
  const tex = new THREE.DataTexture(p.data, p.width, p.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'vfx-sprite-atlas';
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createSpriteAtlas(): THREE.DataTexture {
  return spriteAtlasTexture(generateSpriteAtlasPixels());
}
