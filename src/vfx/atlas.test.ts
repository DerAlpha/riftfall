import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { POSTFX } from '../defs/postfx';
import { DECAL_ATLAS, DECAL_CELLS, SPRITE_ATLAS, SPRITES } from '../defs/vfx';
import { cellUv, decalCell, isDecalKind, spriteCell, type CellUv } from './atlas';
import { generateDecalAtlasPixels, heightToNormal } from './decalAtlas';
import { fbm, hash2, valueNoise } from './noise';
import {
  distanceFalloff,
  ringThickness,
  screenRadius,
  shockwaveEnvelope,
  shockwaveRadius,
} from './shockwaveMath';
import { generateSpriteAtlasPixels } from './spriteAtlas';

const uv = (): CellUv => ({ u0: 0, v0: 0, du: 0, dv: 0 });

describe('atlas UV math', () => {
  it('maps row-major cells from the top-left with v up', () => {
    const grid = { cols: 4, rows: 2 };
    const a = cellUv(grid, 0, uv());
    expect(a).toEqual({ u0: 0, v0: 0.5, du: 0.25, dv: 0.5 });
    const b = cellUv(grid, 6, uv());
    expect(b.u0).toBeCloseTo(0.5, 9);
    expect(b.v0).toBe(0);
  });

  it('insets by texels and clamps bad cell indices', () => {
    const grid = { cols: 4, rows: 4 };
    const c = cellUv(grid, 5, uv(), 0.5, 128);
    expect(c.u0).toBeCloseTo(0.25 + 0.5 / 512, 9);
    expect(c.du).toBeCloseTo(0.25 - 1 / 512, 9);
    expect(cellUv(grid, -3, uv()).u0).toBe(0);
    expect(cellUv(grid, 99, uv())).toEqual(cellUv(grid, 15, uv()));
    expect(cellUv(grid, Number.NaN, uv()).u0).toBe(0);
  });

  it('matches the shader formula (origin = (cell mod cols, rows-1-floor(cell/cols)) / grid)', () => {
    const { cols, rows } = SPRITE_ATLAS;
    for (let cell = 0; cell < cols * rows; cell++) {
      const c = cellUv(SPRITE_ATLAS, cell, uv());
      expect(c.u0).toBeCloseTo((cell % cols) / cols, 9);
      expect(c.v0).toBeCloseTo((rows - 1 - Math.floor(cell / cols)) / rows, 9);
    }
  });

  it('resolves sprite and decal ids', () => {
    expect(spriteCell('spark')).toBe(0);
    expect(spriteCell('star')).toBe(SPRITES.length - 1);
    expect(spriteCell('nope')).toBe(0);
    expect(decalCell('scorch')).toBe(DECAL_CELLS.indexOf('scorch'));
    expect(decalCell('nope')).toBe(-1);
    expect(isDecalKind('blood')).toBe(true);
    expect(isDecalKind('paint')).toBe(false);
    expect(SPRITES.length).toBeLessThanOrEqual(SPRITE_ATLAS.cols * SPRITE_ATLAS.rows);
    expect(DECAL_CELLS.length).toBeLessThanOrEqual(DECAL_ATLAS.cols * DECAL_ATLAS.rows);
  });
});

describe('procedural noise', () => {
  it('is deterministic and bounded', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    expect(hash2(3, 4, 5)).not.toBe(hash2(4, 3, 5));
    for (let i = 0; i < 200; i++) {
      const v = valueNoise(i * 0.37, i * 0.11, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      const f = fbm(i * 0.1, -i * 0.3, 4, 2);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // Continuous: tiny steps change little.
    expect(Math.abs(valueNoise(1.5, 2.5, 1) - valueNoise(1.5001, 2.5, 1))).toBeLessThan(1e-3);
  });
});

/** Alpha of a pixel given in image coordinates (y from the top) of a bottom-up RGBA buffer. */
function alphaAt(data: Uint8Array, width: number, height: number, x: number, yTop: number): number {
  return data[((height - 1 - yTop) * width + x) * 4 + 3]!;
}

describe('sprite atlas', () => {
  const size = 32;
  const px = generateSpriteAtlasPixels(size);

  it('has the grid size and is deterministic', () => {
    expect(px.width).toBe(SPRITE_ATLAS.cols * size);
    expect(px.height).toBe(SPRITE_ATLAS.rows * size);
    expect(generateSpriteAtlasPixels(size).data).toEqual(px.data);
  });

  it('draws every sprite and keeps the cell borders transparent', () => {
    SPRITES.forEach((id, cell) => {
      const ox = (cell % SPRITE_ATLAS.cols) * size;
      const oy = Math.floor(cell / SPRITE_ATLAS.cols) * size;
      let sum = 0;
      let border = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = alphaAt(px.data, px.width, px.height, ox + x, oy + y);
          sum += a;
          if (x === 0 || y === 0 || x === size - 1 || y === size - 1) border = Math.max(border, a);
        }
      }
      expect(sum, id).toBeGreaterThan(0);
      expect(border, id).toBeLessThanOrEqual(8);
    });
  });

  it('places the flame tongue base at the bottom of its cell (v = 0 at the muzzle)', () => {
    const cell = spriteCell('petal');
    const ox = (cell % SPRITE_ATLAS.cols) * size;
    const oy = Math.floor(cell / SPRITE_ATLAS.cols) * size;
    const row = (yTop: number): number => {
      let s = 0;
      for (let x = 0; x < size; x++) s += alphaAt(px.data, px.width, px.height, ox + x, oy + yTop);
      return s;
    };
    expect(row(size - 4)).toBeGreaterThan(row(4));
  });
});

describe('decal atlas', () => {
  const size = 32;
  const px = generateDecalAtlasPixels(size);

  it('produces albedo, normal and ORM layers of the grid size', () => {
    const n = DECAL_ATLAS.cols * size * DECAL_ATLAS.rows * size * 4;
    expect(px.albedo.length).toBe(n);
    expect(px.normal.length).toBe(n);
    expect(px.orm.length).toBe(n);
  });

  it('has content in every cell, a transparent border and flat normals there', () => {
    DECAL_CELLS.forEach((kind, cell) => {
      const ox = (cell % DECAL_ATLAS.cols) * size;
      const oy = Math.floor(cell / DECAL_ATLAS.cols) * size;
      let sum = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) sum += alphaAt(px.albedo, px.width, px.height, ox + x, oy + y);
      expect(sum, kind).toBeGreaterThan(0);
      expect(alphaAt(px.albedo, px.width, px.height, ox, oy), kind).toBe(0);
      const i = ((px.height - 1 - oy) * px.width + ox) * 4;
      expect(px.normal[i + 2], kind).toBeGreaterThan(250);
    });
  });

  it('marks hot metal holes as emissive and blood as non-emissive', () => {
    const center = (kind: (typeof DECAL_CELLS)[number]): number => {
      const cell = DECAL_CELLS.indexOf(kind);
      const x = (cell % DECAL_ATLAS.cols) * size + size / 2;
      const yTop = Math.floor(cell / DECAL_ATLAS.cols) * size + size / 2;
      return px.orm[((px.height - 1 - yTop) * px.width + x) * 4]!;
    };
    expect(center('bullet.metal')).toBeGreaterThan(50);
    expect(center('blood')).toBe(0);
  });

  it('derives tangent-space normals from height slopes', () => {
    const s = 4;
    const flat = new Float32Array(s * s);
    const out = { x: 0, y: 0, z: 0 };
    heightToNormal(flat, s, 1, 1, 1, out);
    expect(out).toEqual({ x: -0, y: -0, z: 1 });
    // Height rising towards +x (right): the normal leans towards −x.
    const ramp = new Float32Array(s * s).map((_, i) => i % s);
    heightToNormal(ramp, s, 1, 1, 1, out);
    expect(out.x).toBeLessThan(0);
    expect(Math.abs(out.y)).toBeLessThan(1e-6);
    // Height rising towards the top of the image (+v): the normal leans towards −y.
    const up = new Float32Array(s * s).map((_, i) => s - Math.floor(i / s));
    heightToNormal(up, s, 1, 1, 1, out);
    expect(out.y).toBeLessThan(0);
  });
});

describe('shockwave math', () => {
  const cfg = POSTFX.shockwave;

  it('grows to the max radius while the envelope fades', () => {
    expect(shockwaveRadius(0, 1, 10)).toBe(0);
    expect(shockwaveRadius(0.5, 1, 10)).toBeCloseTo(10 * (1 - 0.125), 6);
    expect(shockwaveRadius(2, 1, 10)).toBe(10);
    expect(shockwaveEnvelope(0, 1)).toBe(1);
    expect(shockwaveEnvelope(1, 1)).toBe(0);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const r = shockwaveRadius(t, 1, 5);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('projects a world radius like the camera does', () => {
    const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);
    cam.updateMatrixWorld();
    const depth = 8;
    const radius = 2;
    const center = new THREE.Vector3(0, 0, -depth).project(cam);
    const edge = new THREE.Vector3(0, radius, -depth).project(cam);
    const expected = (edge.y - center.y) * 0.5; // NDC → UV height units
    expect(screenRadius(radius, depth, cam.projectionMatrix.elements[5]!)).toBeCloseTo(expected, 6);
    expect(screenRadius(radius, 0, 1)).toBe(0);
  });

  it('clamps the ring thickness and attenuates with distance', () => {
    expect(ringThickness(0, cfg)).toBe(cfg.minThickness);
    expect(ringThickness(100, cfg)).toBe(cfg.maxThickness);
    expect(distanceFalloff(1, 6)).toBe(1);
    expect(distanceFalloff(12, 6)).toBe(0.5);
  });
});
