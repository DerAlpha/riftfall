/**
 * Pure focus selection of the InteractionSystem (allocation-free, unit-tested):
 * - an anchor is a candidate when it lies within its range from the eye and inside the view cone
 *   (a wider cone applies up close: a price plate at the feet, the box below the eye),
 * - score = angle / cone + distanceWeight × distance / range (lower wins); the current focus gets a
 *   stickiness bonus so two neighbours in view do not flicker,
 * - candidates are sorted by score and the first with line of sight wins (at most `maxLos` rays).
 */
import { DEG2RAD, clamp } from '../core/math';
import { INTERACTION } from '../defs/interactables';

export interface SelectionConfig {
  readonly coneHalfRad: number;
  readonly coneCos: number;
  readonly closeRange: number;
  readonly closeConeCos: number;
  readonly distanceWeight: number;
  readonly maxLosChecks: number;
  readonly stickiness: number;
}

export function createSelectionConfig(d: typeof INTERACTION = INTERACTION): SelectionConfig {
  const cone = d.coneHalfAngleDeg * DEG2RAD;
  return {
    coneHalfRad: cone,
    coneCos: Math.cos(cone),
    closeRange: d.closeRange,
    closeConeCos: Math.cos(d.closeConeHalfAngleDeg * DEG2RAD),
    distanceWeight: d.distanceWeight,
    maxLosChecks: d.maxLosChecks,
    stickiness: d.stickiness,
  };
}

/** View direction for PlayerApi yaw/pitch (yaw 0 looks down −Z, positive yaw turns left, pitch up). */
export function viewForward(yaw: number, pitch: number, out: { x: number; y: number; z: number }): void {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
}

/**
 * Score of an anchor offset (dx, dy, dz) from the eye for the unit view direction f; -1 when it is
 * out of range or outside the cone.
 */
export function scoreAnchor(
  dx: number,
  dy: number,
  dz: number,
  range: number,
  fx: number,
  fy: number,
  fz: number,
  cfg: SelectionConfig,
): number {
  if (!(range > 0)) return -1;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (!(d2 <= range * range)) return -1;
  const d = Math.sqrt(d2);
  if (d < 1e-4) return 0;
  const cos = (dx * fx + dy * fy + dz * fz) / d;
  const inCone = cos >= cfg.coneCos || (d <= cfg.closeRange && cos >= cfg.closeConeCos);
  if (!inCone) return -1;
  const angle = Math.acos(clamp(cos, -1, 1));
  return angle / cfg.coneHalfRad + (cfg.distanceWeight * d) / range;
}

/**
 * Best candidate index or -1. `scores[i] < 0` = not a candidate. `order` is scratch (≥ count).
 * `current` (or -1) gets the stickiness bonus. `los(i)` is only called for the best few.
 */
export function pickBest(
  scores: Float64Array,
  count: number,
  order: Int32Array,
  current: number,
  cfg: SelectionConfig,
  los: (index: number) => boolean,
): number {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const s0 = scores[i]!;
    if (!(s0 >= 0)) continue;
    const s = i === current ? Math.max(0, s0 - cfg.stickiness) : s0;
    scores[i] = s;
    // Insertion sort (a handful of candidates at most).
    let j = n++;
    while (j > 0 && scores[order[j - 1]!]! > s) {
      order[j] = order[j - 1]!;
      j--;
    }
    order[j] = i;
  }
  const checks = Math.min(n, Math.max(1, cfg.maxLosChecks));
  for (let k = 0; k < checks; k++) {
    const i = order[k]!;
    if (los(i)) return i;
  }
  return -1;
}
