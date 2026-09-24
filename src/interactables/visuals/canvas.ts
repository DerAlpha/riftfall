/**
 * Canvas-drawn textures of the interactables: door price panels, wall-buy plates, perk machine
 * logos (the perk's SVG glyph as a neon stroke), the box emblem and the anomaly glyph.
 * Holo panels only use the brightness as a mask (white on transparent); the perk logo is an
 * emissive map and is drawn in color. Without a canvas (node tests, a worker) every factory
 * returns null and the materials fall back to their frame / plain glow – never a crash.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import { HOLOGRAM } from '../../defs/interactables';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const CANVAS_OPTIONS: CanvasRenderingContext2DSettings = { willReadFrequently: true };

export interface CanvasSurface {
  readonly texture: CanvasTexture;
  readonly ctx: Ctx;
  readonly width: number;
  readonly height: number;
}

/** A canvas + texture, or null when no 2D canvas exists. */
export function createCanvasSurface(width: number, height: number, srgb = false): CanvasSurface | null {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      canvas = c;
    } else if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
    }
  } catch {
    canvas = null;
  }
  // CPU-backed canvas: drawn a few times, uploaded once – a GPU 2D context would add a GPU-process
  // round trip per draw call (seconds on software GL while the game renders).
  const ctx = canvas ? (canvas.getContext('2d', CANVAS_OPTIONS) as Ctx | null) : null;
  if (!canvas || !ctx) return null;
  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  return { texture, ctx, width, height };
}

/** Redraw a surface (clears first) and flag the texture for upload. */
export function redraw(s: CanvasSurface | null, draw: (ctx: Ctx, w: number, h: number) => void): void {
  if (!s) return;
  s.ctx.clearRect(0, 0, s.width, s.height);
  s.ctx.save();
  draw(s.ctx, s.width, s.height);
  s.ctx.restore();
  s.texture.needsUpdate = true;
}

function font(weight: number, px: number, family: string): string {
  return `${weight} ${Math.round(px)}px ${family}`;
}

/** Fit text into `maxWidth` by shrinking the font size. */
function fitText(ctx: Ctx, text: string, px: number, maxWidth: number, family: string, weight = 700): void {
  let size = px;
  ctx.font = font(weight, size, family);
  while (size > 8 && ctx.measureText(text).width > maxWidth) {
    size *= 0.92;
    ctx.font = font(weight, size, family);
  }
}

function formatPoints(n: number): string {
  // German thousands separator (1.250).
  return Math.round(n).toLocaleString('de-DE');
}

// ---------------------------------------------------------------------------
// Door panel: lock icon, price, caption
// ---------------------------------------------------------------------------

export function drawDoorPanel(ctx: Ctx, w: number, h: number, price: number, caption: string): void {
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = h * 0.035;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Lock (left third).
  const cx = w * 0.17;
  const cy = h * 0.52;
  const s = h * 0.34;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(cx - s * 0.5, cy - s * 0.1, s, s * 0.72);
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.1, s * 0.3, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.2, s * 0.07, 0, Math.PI * 2);
  ctx.fill();
  // Divider.
  ctx.globalAlpha = 0.45;
  ctx.fillRect(w * 0.31, h * 0.2, Math.max(2, w * 0.006), h * 0.6);
  // Price.
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  fitText(ctx, formatPoints(price), h * 0.4, w * 0.6, HOLOGRAM.fontDisplay);
  ctx.fillText(formatPoints(price), w * 0.36, h * 0.6);
  ctx.globalAlpha = 0.75;
  fitText(ctx, caption, h * 0.13, w * 0.6, HOLOGRAM.fontMono, 600);
  ctx.fillText(caption, w * 0.36, h * 0.8);
  // Corner ticks.
  ctx.globalAlpha = 0.6;
  const t = h * 0.08;
  const m = h * 0.07;
  for (const [x, y, dx, dy] of [
    [m, m, 1, 1],
    [w - m, m, -1, 1],
    [m, h - m, 1, -1],
    [w - m, h - m, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * t);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * t, y);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Wall-buy price plate
// ---------------------------------------------------------------------------

export function drawPricePlate(ctx: Ctx, w: number, h: number, label: string, price: number | null): void {
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  fitText(ctx, label, h * 0.46, w * 0.58, HOLOGRAM.fontDisplay);
  ctx.fillText(label, w * 0.05, h * 0.52);
  if (price !== null) {
    ctx.textAlign = 'right';
    fitText(ctx, formatPoints(price), h * 0.62, w * 0.32, HOLOGRAM.fontDisplay);
    ctx.fillText(formatPoints(price), w * 0.95, h * 0.54);
  }
  ctx.globalAlpha = 0.5;
  ctx.fillRect(w * 0.05, h * 0.86, w * 0.9, Math.max(1, h * 0.03));
}

// ---------------------------------------------------------------------------
// Perk logo (emissive map, in color)
// ---------------------------------------------------------------------------

export interface PerkLogoInfo {
  name: string;
  tagline: string;
  /** sRGB hex. */
  color: number;
  /** SVG path data (24 × 24 box, stroke only). */
  glyph: string;
}

function css(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Backlit logo: dark glass, a ring with the perk glyph as neon strokes, name, tagline and the
 * price (or the state line: "AKTIV" / the limit text).
 */
export function drawPerkLogo(
  ctx: Ctx,
  w: number,
  h: number,
  perk: PerkLogoInfo,
  priceLine: string,
  dim: boolean,
): void {
  const col = perk.color;
  // Opaque dark glass (the emissive map reads RGB only) with a faint glow of the perk color
  // behind the emblem.
  ctx.fillStyle = '#04060a';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, h * 0.36, 0, w / 2, h * 0.36, w * 0.7);
  glow.addColorStop(0, css(col, 0.16));
  glow.addColorStop(1, css(col, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  const a = dim ? 0.45 : 1;
  // Emblem ring.
  const cx = w / 2;
  const cy = h * 0.36;
  const r = w * 0.33;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = css(col, a);
  ctx.shadowBlur = w * 0.05;
  ctx.strokeStyle = css(col, 0.9 * a);
  ctx.lineWidth = w * 0.022;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = w * 0.008;
  ctx.strokeStyle = css(col, 0.55 * a);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.12, -Math.PI * 0.8, -Math.PI * 0.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.12, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
  // Glyph (24 × 24 SVG path) as a neon stroke with a white-hot core.
  if (perk.glyph && typeof Path2D !== 'undefined') {
    try {
      const path = new Path2D(perk.glyph);
      const scale = (r * 1.25) / 24;
      ctx.save();
      ctx.translate(cx - 12 * scale, cy - 12 * scale);
      ctx.scale(scale, scale);
      ctx.strokeStyle = css(col, a);
      ctx.lineWidth = 2.2;
      ctx.stroke(path);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255,255,255,${0.85 * a})`;
      ctx.lineWidth = 0.8;
      ctx.stroke(path);
      ctx.restore();
    } catch {
      /* malformed path data: the ring alone */
    }
  }
  ctx.shadowBlur = w * 0.03;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(255,255,255,${0.95 * a})`;
  fitText(ctx, perk.name.toUpperCase(), h * 0.085, w * 0.88, HOLOGRAM.fontDisplay);
  ctx.fillText(perk.name.toUpperCase(), cx, h * 0.68);
  ctx.shadowBlur = 0;
  ctx.fillStyle = css(col, 0.8 * a);
  fitText(ctx, perk.tagline, h * 0.038, w * 0.86, HOLOGRAM.fontMono, 500);
  ctx.fillText(perk.tagline, cx, h * 0.76);
  // Price bar.
  ctx.fillStyle = css(col, 0.9 * a);
  ctx.fillRect(w * 0.12, h * 0.82, w * 0.76, Math.max(2, h * 0.006));
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.shadowColor = css(col, a);
  ctx.shadowBlur = w * 0.03;
  fitText(ctx, priceLine, h * 0.075, w * 0.8, HOLOGRAM.fontDisplay);
  ctx.fillText(priceLine, cx, h * 0.9);
}

export function formatPerkPrice(price: number): string {
  return formatPoints(price);
}

// ---------------------------------------------------------------------------
// Box emblem and the anomaly glyph (masks)
// ---------------------------------------------------------------------------

/** "?" inside a torn rift ring (box front). */
export function drawBoxEmblem(ctx: Ctx, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.4;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineWidth = w * 0.035;
  // Ring broken by two tears.
  for (const [a0, a1] of [
    [-0.42, 0.78],
    [0.98, 2.5],
    [2.72, 5.62],
  ] as const) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = w * 0.012;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(800, h * 0.52, HOLOGRAM.fontDisplay);
  ctx.fillText('?', cx, cy + h * 0.03);
}

/** Torn eye of the "Riss-Anomalie". */
export function drawAnomaly(ctx: Ctx, w: number, h: number, label: string): void {
  const cx = w / 2;
  const cy = h * 0.42;
  const rx = w * 0.4;
  const ry = h * 0.2;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = w * 0.03;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - rx, cy);
  ctx.quadraticCurveTo(cx, cy - ry * 2, cx + rx, cy);
  ctx.quadraticCurveTo(cx, cy + ry * 2, cx - rx, cy);
  ctx.stroke();
  // Slit pupil, jagged like a tear.
  ctx.beginPath();
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const y = cy - ry * 0.95 + (i / steps) * ry * 1.9;
    const x = cx + (i % 2 === 0 ? -1 : 1) * w * 0.03;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = w * 0.045;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, label.toUpperCase(), h * 0.11, w * 0.9, HOLOGRAM.fontDisplay);
  ctx.fillText(label.toUpperCase(), cx, h * 0.84);
}
