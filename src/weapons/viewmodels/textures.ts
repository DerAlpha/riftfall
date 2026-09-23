/**
 * Tiny procedural textures for the weapon viewmodels (generated once, a few KB each):
 * - wear map: roughness variation with polished scratches (G) – roughness/metalness convention,
 * - knurl normal map: diamond knurling for grips and pump ribs,
 * - LED strip / seven-segment readouts: emissive maps rewritten when the ammo count changes.
 * Pixel generators are pure (Uint8Array) and unit-tested; DataTexture wrappers live below.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { Rng } from '../../core/Rng';

// ---------------------------------------------------------------------------
// Pixel generators (pure)
// ---------------------------------------------------------------------------

/** Tileable value noise (lattice wraps at `period`). */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number): number => {
    const a = ((i % period) + period) % period;
    const b = ((j % period) + period) % period;
    const s = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * Roughness/metalness wear map (RGBA): R = 255 (unused AO), G = roughness factor (0.55..1 with
 * darker polished scratch lines), B = metalness factor 255. Tileable.
 */
export function generateWearPixels(size: number, seed = 'vm-wear'): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const octaves = [
    { f: 4, a: 0.5 },
    { f: 8, a: 0.3 },
    { f: 16, a: 0.2 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const o of octaves) n += tileNoise((x / size) * o.f, (y / size) * o.f, o.f, o.f) * o.a;
      rough[y * size + x] = 0.72 + n * 0.28;
    }
  }
  // Fine scratches: short polished (low roughness) lines at random angles, wrapped.
  const rng = new Rng(seed);
  const scratches = Math.round(size * 0.35);
  for (let i = 0; i < scratches; i++) {
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    const ang = rng.range(0, Math.PI);
    const len = rng.range(size * 0.05, size * 0.25);
    const depth = rng.range(0.12, 0.3);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let s = 0; s < len; s++) {
      const px = ((Math.floor(x) % size) + size) % size;
      const py = ((Math.floor(y) % size) + size) % size;
      const k = py * size + px;
      rough[k] = Math.max(0.5, rough[k]! - depth);
      x += dx;
      y += dy;
    }
  }
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    data[o] = 255;
    data[o + 1] = Math.round(Math.min(1, Math.max(0, rough[i]!)) * 255);
    data[o + 2] = 255;
    data[o + 3] = 255;
  }
  return data;
}

/**
 * Diamond knurling normal map (tangent space, RGBA). `cells` diamonds per tile; `strength`
 * scales the slopes. Tileable because the height field is periodic in both axes.
 */
export function generateKnurlPixels(size: number, cells: number, strength: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const height = (x: number, y: number): number => {
    const u = (x / size) * cells;
    const v = (y / size) * cells;
    // Two crossing sets of grooves → raised pyramids (diamonds).
    const a = Math.abs(((u + v) % 1) - 0.5) * 2;
    const b = Math.abs(((u - v + cells) % 1) - 0.5) * 2;
    return Math.min(a, b);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = height((x + 1) % size, y) - height((x - 1 + size) % size, y);
      const hy = height(x, (y + 1) % size) - height(x, (y - 1 + size) % size);
      let nx = -hx * strength;
      let ny = -hy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * size + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

export type Rgb = readonly [number, number, number];

/**
 * LED strip (count × 1 texels): the first `lit` LEDs use `on`, the rest `off`. Returns true
 * when any texel changed (so the caller only re-uploads on change).
 */
export function writeLedPixels(data: Uint8Array, count: number, lit: number, on: Rgb, off: Rgb): boolean {
  let changed = false;
  for (let i = 0; i < count; i++) {
    const c = i < lit ? on : off;
    const o = i * 4;
    if (data[o] !== c[0] || data[o + 1] !== c[1] || data[o + 2] !== c[2] || data[o + 3] !== 255) {
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
      changed = true;
    }
  }
  return changed;
}

/** Number of lit LEDs for an ammo fraction (any round left keeps at least one LED lit). */
export function ledsLit(mag: number, magSize: number, count: number): number {
  if (mag <= 0 || magSize <= 0) return 0;
  return Math.max(1, Math.min(count, Math.ceil((mag / magSize) * count)));
}

/**
 * Seven-segment bitmasks for 0–9 (bit order a b c d e f g = top, top-right, bottom-right,
 * bottom, bottom-left, top-left, middle).
 */
export const SEVEN_SEGMENT_DIGITS: readonly number[] = [
  0b1111110, 0b0110000, 0b1101101, 0b1111001, 0b0110011, 0b1011011, 0b1011111, 0b1110000, 0b1111111,
  0b1111011,
];

/** Seven-segment glyph cell: 5 px wide, 9 px tall incl. a 1 px frame; 2 digits + gap → 12×9 texels. */
export const SEGMENT_DISPLAY = { digitW: 5, digitH: 9, gap: 1, digits: 2 } as const;

export function segmentDisplaySize(): { w: number; h: number } {
  const d = SEGMENT_DISPLAY;
  return { w: d.digits * d.digitW + (d.digits - 1) * d.gap + 2, h: d.digitH + 2 };
}

/**
 * Render a 0..99 value as two seven-segment digits (leading zero kept – reads as a counter).
 * Texture rows go bottom-up (DataTexture flipY = false → row 0 is the bottom of the UV space).
 */
export function writeSegmentPixels(data: Uint8Array, value: number, on: Rgb, off: Rgb, bg: Rgb): void {
  const { w, h } = segmentDisplaySize();
  const d = SEGMENT_DISPLAY;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = bg[0];
    data[o + 1] = bg[1];
    data[o + 2] = bg[2];
    data[o + 3] = 255;
  }
  const v = Math.max(0, Math.min(99, Math.round(value)));
  const digits = [Math.floor(v / 10), v % 10];
  const put = (x: number, yTop: number, c: Rgb): void => {
    const y = h - 1 - yTop;
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
  };
  for (let k = 0; k < digits.length; k++) {
    const mask = SEVEN_SEGMENT_DIGITS[digits[k]!]!;
    const x0 = 1 + k * (d.digitW + d.gap);
    const y0 = 1;
    const seg = (bit: number): Rgb => ((mask >> (6 - bit)) & 1 ? on : off);
    // a (top), d (bottom), g (middle): horizontal bars
    for (let x = 1; x < d.digitW - 1; x++) {
      put(x0 + x, y0, seg(0));
      put(x0 + x, y0 + d.digitH - 1, seg(3));
      put(x0 + x, y0 + (d.digitH >> 1), seg(6));
    }
    // f/b (upper verticals), e/c (lower verticals)
    const mid = d.digitH >> 1;
    for (let y = 1; y < mid; y++) {
      put(x0, y0 + y, seg(5));
      put(x0 + d.digitW - 1, y0 + y, seg(1));
    }
    for (let y = mid + 1; y < d.digitH - 1; y++) {
      put(x0, y0 + y, seg(4));
      put(x0 + d.digitW - 1, y0 + y, seg(2));
    }
  }
}

// ---------------------------------------------------------------------------
// DataTexture wrappers
// ---------------------------------------------------------------------------

/** Mipmapped, repeating linear-data texture (roughness/normal maps). */
export function createDataTexture(data: Uint8Array, size: number, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, size, size);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Small sRGB emissive readout (LEDs, digits): nearest filtering keeps segments crisp. */
export function createReadoutTexture(data: Uint8Array, w: number, h: number): DataTexture {
  const tex = new DataTexture(data, w, h);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
