/**
 * Grid texture atlas math shared by the sprite atlas (particles, tracers, muzzle flash) and the
 * decal atlas. Cells are row-major from the TOP-left of the image; UVs follow three's convention
 * (v = 0 at the bottom, DataTexture rows are uploaded bottom-up with flipY = false), so the
 * generators write cell rows top-down and the UV math flips the row.
 */
import { DECAL_CELLS, SPRITES, type DecalKind, type SpriteId } from '../defs/vfx';

export interface AtlasGrid {
  readonly cols: number;
  readonly rows: number;
}

/** UV rectangle of a cell: offset (u0, v0) and size (du, dv). */
export interface CellUv {
  u0: number;
  v0: number;
  du: number;
  dv: number;
}

/**
 * UV rect of `cell` (clamped to the grid), shrunk by `insetTexels` texels on every side so
 * bilinear filtering never samples the neighbouring cell. `texelsPerCell` = cell size in pixels.
 */
export function cellUv(
  grid: AtlasGrid,
  cell: number,
  out: CellUv,
  insetTexels = 0,
  texelsPerCell = 1,
): CellUv {
  const n = grid.cols * grid.rows;
  const c = Math.min(n - 1, Math.max(0, Math.floor(Number.isFinite(cell) ? cell : 0)));
  const col = c % grid.cols;
  const rowFromTop = Math.floor(c / grid.cols);
  const du = 1 / grid.cols;
  const dv = 1 / grid.rows;
  const inU = (insetTexels / Math.max(1, texelsPerCell)) * du;
  const inV = (insetTexels / Math.max(1, texelsPerCell)) * dv;
  out.u0 = col * du + inU;
  out.v0 = (grid.rows - 1 - rowFromTop) * dv + inV;
  out.du = du - 2 * inU;
  out.dv = dv - 2 * inV;
  return out;
}

/** Pixel origin (x, y from the top-left) of a cell in an atlas image. */
export function cellPixelOrigin(grid: AtlasGrid, cell: number, cellSize: number): { x: number; y: number } {
  const col = cell % grid.cols;
  const row = Math.floor(cell / grid.cols);
  return { x: col * cellSize, y: row * cellSize };
}

const SPRITE_INDEX = new Map<string, number>(SPRITES.map((s, i) => [s, i]));
const DECAL_INDEX = new Map<string, number>(DECAL_CELLS.map((s, i) => [s, i]));

/** Sprite atlas cell of a sprite id (0 for unknown ids). */
export function spriteCell(id: SpriteId | string): number {
  return SPRITE_INDEX.get(id) ?? 0;
}

/** Decal atlas cell of a decal kind, or -1 for unknown kinds. */
export function decalCell(kind: DecalKind | string): number {
  return DECAL_INDEX.get(kind) ?? -1;
}

export function isDecalKind(kind: string): kind is DecalKind {
  return DECAL_INDEX.has(kind);
}
