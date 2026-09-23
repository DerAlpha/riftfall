/**
 * Data-driven motion of one named weapon part (slide, bolt, magazine, pump, trigger, ...).
 *
 * Each part has two layers, both expressed as offsets in the part's own local frame:
 * - base: a persistent offset tweened between poses (slide locked back, magazine out, dust
 *   cover open, shell travelling into the tube). It stays where the last tween ended.
 * - pulse: a transient attack–hold–release offset on top (slide/bolt cycling, trigger pull,
 *   pump rack). Restarting a running pulse continues from its current value (no pops).
 * Pure numeric state – the animator applies the resulting offset to the Object3D.
 */
import {
  createPose,
  ease,
  poseAddScaled,
  poseCopy,
  poseFromDef,
  poseLerp,
  poseZero,
  pulseValue,
  type Pose,
} from './animMath';
import type { PartMotionDef } from '../../defs/viewmodels';

export type { PartMotionDef };

export interface PartMotionState {
  /** Current persistent offset. */
  readonly base: Pose;
  readonly baseFrom: Pose;
  readonly baseTo: Pose;
  baseDef: PartMotionDef | null;
  baseT: number;
  readonly pulseAmount: Pose;
  pulseDef: PartMotionDef | null;
  pulseT: number;
  pulseFrom: number;
  pulseValue: number;
  visible: boolean;
  /** Visibility of the part at rest (restored by reset). */
  readonly restVisible: boolean;
}

export function createPartMotionState(restVisible = true): PartMotionState {
  return {
    base: createPose(),
    baseFrom: createPose(),
    baseTo: createPose(),
    baseDef: null,
    baseT: 0,
    pulseAmount: createPose(),
    pulseDef: null,
    pulseT: 0,
    pulseFrom: 0,
    pulseValue: 0,
    visible: restVisible,
    restVisible,
  };
}

/** Back to rest immediately (model swap, cancelled reload). */
export function resetPartMotion(s: PartMotionState): void {
  poseZero(s.base);
  poseZero(s.baseFrom);
  poseZero(s.baseTo);
  s.baseDef = null;
  s.baseT = 0;
  poseZero(s.pulseAmount);
  s.pulseDef = null;
  s.pulseT = 0;
  s.pulseFrom = 0;
  s.pulseValue = 0;
  s.visible = s.restVisible;
}

export function startPartMotion(s: PartMotionState, def: PartMotionDef): void {
  const delay = Math.max(0, def.delay ?? 0);
  if (def.type === 'tween') {
    if (def.from) poseFromDef(s.baseFrom, def.from);
    else poseCopy(s.baseFrom, s.base);
    poseFromDef(s.baseTo, def.pose);
    s.baseDef = def;
    s.baseT = -delay;
    // A snapped start is visible right away only once the motion begins (after the delay).
    if (delay === 0) applyStart(s, def);
  } else {
    // Continue from the current value when the same pulse restarts (fast fire): no pop.
    s.pulseFrom = s.pulseDef === def ? s.pulseValue : 0;
    poseFromDef(s.pulseAmount, def.pose);
    s.pulseDef = def;
    s.pulseT = -delay;
    if (delay === 0) applyStart(s, def);
  }
}

function applyStart(s: PartMotionState, def: PartMotionDef): void {
  if (def.show) s.visible = true;
  if (def.type === 'tween' && def.from) poseCopy(s.base, s.baseFrom);
}

/** Advance both layers by `dt` seconds. Returns true while anything is still moving. */
export function stepPartMotion(s: PartMotionState, dt: number): boolean {
  let active = false;
  const bd = s.baseDef;
  if (bd) {
    const before = s.baseT;
    s.baseT += dt;
    if (before < 0 && s.baseT >= 0) {
      applyStart(s, bd);
      // The delayed tween starts from wherever the base is now (or its explicit `from`).
      if (!bd.from) poseCopy(s.baseFrom, s.base);
    }
    if (s.baseT >= 0) {
      const u = bd.duration > 0 ? s.baseT / bd.duration : 1;
      poseLerp(s.base, s.baseFrom, s.baseTo, ease(bd.ease ?? 'inOut', u));
      if (u >= 1) {
        poseCopy(s.base, s.baseTo);
        if (bd.hideAtEnd) s.visible = false;
        s.baseDef = null;
      } else active = true;
    } else active = true;
  }
  const pd = s.pulseDef;
  if (pd) {
    const before = s.pulseT;
    s.pulseT += dt;
    if (before < 0 && s.pulseT >= 0) applyStart(s, pd);
    const hold = pd.hold ?? 0;
    const release = pd.release ?? pd.duration;
    s.pulseValue = pulseValue(
      s.pulseT,
      pd.duration,
      hold,
      release,
      s.pulseFrom,
      pd.ease ?? 'snap',
      pd.releaseEase ?? 'inOut',
    );
    if (s.pulseT >= pd.duration + hold + release) {
      s.pulseValue = 0;
      if (pd.hideAtEnd) s.visible = false;
      s.pulseDef = null;
    } else active = true;
  }
  return active;
}

/** Current total offset (base + pulse) in the part's local frame. */
export function partOffset(s: PartMotionState, out: Pose): Pose {
  poseCopy(out, s.base);
  if (s.pulseValue !== 0) poseAddScaled(out, s.pulseAmount, s.pulseValue);
  return out;
}
