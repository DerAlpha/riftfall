/**
 * Power-up glyph atlas: every POWERUP_GLYPHS path stroked white on a transparent canvas (one cell
 * each, row-major in POWERUP_GLYPH_IDS order) – a soft blurred glow pass under a crisp stroke, so
 * the hologram shader reads the alpha as "glow" (low) and "core" (high). Without a 2D canvas or
 * Path2D (node tests, workers) it returns null and the shader draws a plain fallback sigil.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter } from 'three';
import { POWERUP_GLYPHS, POWERUP_GLYPH_IDS, POWERUPS } from '../defs/powerups';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface GlyphAtlas {
  readonly texture: CanvasTexture;
  readonly cols: number;
  readonly rows: number;
}

/** Glyph units of the path data (24 × 24 box, the POWERUP_GLYPHS format). */
const GLYPH_BOX = 24;

/** Atlas cell of a glyph id (-1 if unknown). */
export function glyphCell(glyph: string): number {
  return POWERUP_GLYPH_IDS.indexOf(glyph as (typeof POWERUP_GLYPH_IDS)[number]);
}

export function atlasRows(
  count: number = POWERUP_GLYPH_IDS.length,
  cols: number = POWERUPS.visual.atlas.cols,
): number {
  return Math.max(1, Math.ceil(count / Math.max(1, cols)));
}

export function createGlyphAtlas(): GlyphAtlas | null {
  const A = POWERUPS.visual.atlas;
  const cols = A.cols;
  const rows = atlasRows();
  const w = A.cell * cols;
  const h = A.cell * rows;
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  try {
    if (typeof Path2D === 'undefined') return null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      canvas = c;
    } else if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    }
    const ctx = canvas ? (canvas.getContext('2d') as Ctx | null) : null;
    if (!canvas || !ctx) return null;
    ctx.clearRect(0, 0, w, h);
    const k = (A.cell * A.fill) / GLYPH_BOX;
    const pad = (A.cell * (1 - A.fill)) / 2;
    POWERUP_GLYPH_IDS.forEach((id, i) => {
      const path = new Path2D(POWERUP_GLYPHS[id]);
      const cx = (i % cols) * A.cell + pad;
      const cy = Math.floor(i / cols) * A.cell + pad;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = A.glowBlur;
      ctx.globalAlpha = A.glowAlpha;
      ctx.lineWidth = A.stroke * A.glowWidth;
      ctx.stroke(path);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.lineWidth = A.stroke;
      ctx.stroke(path);
      ctx.restore();
    });
    const texture = new CanvasTexture(canvas as HTMLCanvasElement);
    texture.name = 'powerup-glyphs';
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return { texture, cols, rows };
  } catch {
    return null;
  }
}
