/**
 * Colorblind daltonization matrices (pure). The correction is linear in linear-sRGB:
 *   out = rgb + E · (rgb − S · rgb) = (I + E · (I − S)) · rgb
 * S = Machado et al. 2009 dichromacy simulation (severity 1.0), E = error redistribution that
 * shifts the information the viewer cannot see into channels they can (Fidaner et al.).
 * All matrices are row-major 3x3.
 */
import type { AccessibilitySettings } from '../../save/settingsSchema';

export type ColorblindMode = AccessibilitySettings['colorblindMode'];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const SIMULATION: Record<Exclude<ColorblindMode, 'none'>, Mat3> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/** Red/green deficiencies: push the lost red-green contrast into green and blue. */
const SHIFT_RG: Mat3 = [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1];
/** Blue/yellow deficiency: push the lost blue contrast into red and green. */
const SHIFT_BY: Mat3 = [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0];

function mul(a: Mat3, b: Mat3): number[] {
  const o: number[] = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k]! * b[k * 3 + c]!;
      o[r * 3 + c] = s;
    }
  }
  return o;
}

/**
 * Correction matrix for `mode`, blended with identity by `strength` (0..1).
 * 'none' (or strength 0) returns the identity. Rows of the result sum to 1, so greys are preserved.
 */
export function daltonizationMatrix(mode: ColorblindMode, strength = 1): Mat3 {
  if (mode === 'none' || strength <= 0) return IDENTITY_MAT3;
  const sim = SIMULATION[mode];
  const shift = mode === 'tritanopia' ? SHIFT_BY : SHIFT_RG;
  // I − S
  // prettier-ignore
  const err: Mat3 = [
    1 - sim[0], -sim[1], -sim[2],
    -sim[3], 1 - sim[4], -sim[5],
    -sim[6], -sim[7], 1 - sim[8],
  ];
  const corr = mul(shift, err);
  const out = IDENTITY_MAT3.map((v, i) => v + corr[i]! * strength);
  return out as unknown as Mat3;
}

/** Apply a row-major matrix to an RGB triple (tests / CPU-side previews). */
export function applyMat3(m: Mat3, r: number, g: number, b: number): [number, number, number] {
  return [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
}
