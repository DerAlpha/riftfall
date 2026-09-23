/**
 * Procedural color-grading LUT.
 *
 * LUT3DEffect (pmndrs/postprocessing) runs with inputColorSpace = sRGB: the EffectPass encodes
 * the tone-mapped linear color to sRGB before the lookup and decodes afterwards. So the LUT is
 * indexed by sRGB-encoded display values and must store sRGB-encoded results. The texture holds
 * raw bytes (NoColorSpace) so the GPU does not decode them on sampling.
 *
 * Layout: RGBA8, index = r + g * size + b * size² (red fastest), identical to three's
 * Data3DTexture and postprocessing's LookupTexture.
 */
import * as THREE from 'three';
import type { ColorGradingDef, RGB } from '../../defs/maps';
import { POSTFX } from '../../defs/postfx';

/** Rec.709 luma weights (linear light). */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
/** Middle grey (linear) – pivot for contrast. */
const MID_GREY = 0.18;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function luma(r: number, g: number, b: number): number {
  return r * LUMA_R + g * LUMA_G + b * LUMA_B;
}

function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface GradingModel {
  temperatureStrength: number;
  tintStrength: number;
  splitToneStrength: number;
}

/** Per-channel multiplier with unit Rec.709 luminance (hue only). Grey/white tints give (1, 1, 1). */
function hueOf(c: RGB, out: [number, number, number]): void {
  const l = luma(c[0], c[1], c[2]);
  if (l <= 1e-6) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return;
  }
  out[0] = c[0] / l;
  out[1] = c[1] / l;
  out[2] = c[2] / l;
}

/**
 * Generate the grading LUT for `def`. Writes into `out` when given (must hold size³ * 4 bytes),
 * so the texture data can be regenerated in place without reallocating/recompiling.
 *
 * Pipeline per texel (input = sRGB-encoded display value):
 * decode → exposure → white balance (temperature/tint, luminance preserving) → contrast around
 * mid-grey in perceptual (sRGB) space → saturation (Rec.709 luma) → split toning (hue-only tints,
 * weighted by perceptual luma + balance) → encode → lift/gamma/gain per channel.
 */
export function generateGradingLUT(
  def: ColorGradingDef,
  size = 32,
  out?: Uint8Array,
  model: GradingModel = POSTFX.grading,
): Uint8Array {
  const n = Math.max(2, Math.floor(size));
  const data = out ?? new Uint8Array(n * n * n * 4);
  if (data.length < n * n * n * 4) throw new Error(`LUT buffer too small for size ${n}`);

  // White balance gains, renormalized to unit luminance so temperature/tint do not change brightness.
  let wbR = 1 + model.temperatureStrength * def.temperature + 0.5 * model.tintStrength * def.tint;
  let wbG = 1 - model.tintStrength * def.tint;
  let wbB = 1 - model.temperatureStrength * def.temperature + 0.5 * model.tintStrength * def.tint;
  const wbL = luma(wbR, wbG, wbB);
  wbR /= wbL;
  wbG /= wbL;
  wbB /= wbL;

  const pivot = linearToSrgb(MID_GREY);
  const shadowHue: [number, number, number] = [1, 1, 1];
  const highlightHue: [number, number, number] = [1, 1, 1];
  hueOf(def.shadowTint, shadowHue);
  hueOf(def.highlightTint, highlightHue);
  const split = model.splitToneStrength;
  // Positive balance moves the split point down (more of the range counts as highlights).
  const splitMid = Math.min(0.9, Math.max(0.1, 0.5 - 0.25 * def.splitBalance));
  const invGamma: [number, number, number] = [
    1 / Math.max(1e-4, def.gamma[0]),
    1 / Math.max(1e-4, def.gamma[1]),
    1 / Math.max(1e-4, def.gamma[2]),
  ];
  const inv = 1 / (n - 1);

  let i = 0;
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        // 1. decode + exposure + white balance (linear light)
        let r = srgbToLinear(ri * inv) * def.exposure * wbR;
        let g = srgbToLinear(gi * inv) * def.exposure * wbG;
        let b = srgbToLinear(bi * inv) * def.exposure * wbB;

        // 2. contrast around mid-grey in perceptual space
        if (def.contrast !== 1) {
          r = srgbToLinear(Math.max(0, pivot + (linearToSrgb(r) - pivot) * def.contrast));
          g = srgbToLinear(Math.max(0, pivot + (linearToSrgb(g) - pivot) * def.contrast));
          b = srgbToLinear(Math.max(0, pivot + (linearToSrgb(b) - pivot) * def.contrast));
        }

        // 3. saturation around Rec.709 luma
        if (def.saturation !== 1) {
          const l = luma(r, g, b);
          r = Math.max(0, l + (r - l) * def.saturation);
          g = Math.max(0, l + (g - l) * def.saturation);
          b = Math.max(0, l + (b - l) * def.saturation);
        }

        // 4. split toning: hue-only multipliers. Shadows fade out towards the balance point,
        //    highlights fade in above it, so midtones stay close to neutral.
        if (split > 0) {
          const lp = linearToSrgb(clamp01(luma(r, g, b)));
          const sA = split * (1 - smoothstep01(lp / splitMid));
          const hA = split * smoothstep01((lp - splitMid) / (1 - splitMid));
          r *= (1 + (shadowHue[0] - 1) * sA) * (1 + (highlightHue[0] - 1) * hA);
          g *= (1 + (shadowHue[1] - 1) * sA) * (1 + (highlightHue[1] - 1) * hA);
          b *= (1 + (shadowHue[2] - 1) * sA) * (1 + (highlightHue[2] - 1) * hA);
        }

        // 5. encode + lift/gamma/gain in display space
        let pr = linearToSrgb(clamp01(r));
        let pg = linearToSrgb(clamp01(g));
        let pb = linearToSrgb(clamp01(b));
        pr = Math.pow(Math.max(0, def.gain[0] * (pr + def.lift[0] * (1 - pr))), invGamma[0]);
        pg = Math.pow(Math.max(0, def.gain[1] * (pg + def.lift[1] * (1 - pg))), invGamma[1]);
        pb = Math.pow(Math.max(0, def.gain[2] * (pb + def.lift[2] * (1 - pb))), invGamma[2]);

        data[i++] = Math.round(clamp01(pr) * 255);
        data[i++] = Math.round(clamp01(pg) * 255);
        data[i++] = Math.round(clamp01(pb) * 255);
        data[i++] = 255;
      }
    }
  }
  return data;
}

/** Neutral grading (identity LUT). */
export const IDENTITY_GRADING: ColorGradingDef = {
  exposure: 1,
  contrast: 1,
  saturation: 1,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  splitBalance: 0,
  temperature: 0,
  tint: 0,
};

/** 3D texture for LUT3DEffect: RGBA8, linear filtering, clamped, raw (sRGB-encoded values, no decode). */
export function createLUTTexture(
  def: ColorGradingDef,
  size: number = POSTFX.grading.lutSize,
): THREE.Data3DTexture {
  const n = Math.max(2, Math.floor(size));
  const data = generateGradingLUT(def, n);
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.name = 'GradingLUT';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Regenerate an existing LUT texture in place (same size => no shader recompile in LUT3DEffect). */
export function updateLUTTexture(tex: THREE.Data3DTexture, def: ColorGradingDef): void {
  const img = tex.image;
  if (!img || !(img.data instanceof Uint8Array)) return;
  generateGradingLUT(def, img.width, img.data);
  tex.needsUpdate = true;
}
