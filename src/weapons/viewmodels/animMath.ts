/**
 * Pure, allocation-free helpers for procedural viewmodel animation: easing curves, pulse
 * envelopes, 6-DOF pose arithmetic, pose-key tracks and spring followers. No three.js
 * objects, so everything here is unit-testable in Node.
 */
import { DEG2RAD, clamp01, springStep, type SpringState } from '../../core/math';
import type { EaseName, PoseDef, PoseKeyDef, PoseSpringDef } from '../../defs/viewmodels';

export type { EaseName, PoseDef, PoseKeyDef, PoseSpringDef };

/** Overshoot of the `outBack` curve (Penner's constant ≈ 10 % overshoot). */
const BACK_OVERSHOOT = 1.70158;
/** Exponent of the `snap` curve: reaches ~99.9 % of the way after the first third. */
const SNAP_EXPONENT = 10;

/** Evaluate an easing curve at `t` (clamped to 0..1). Every curve maps 0 → 0 and 1 → 1. */
export function ease(name: EaseName, t: number): number {
  const x = clamp01(t);
  switch (name) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out': {
      const u = 1 - x;
      return 1 - u * u * u;
    }
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'outBack': {
      const c3 = BACK_OVERSHOOT + 1;
      const u = x - 1;
      return 1 + c3 * u * u * u + BACK_OVERSHOOT * u * u;
    }
    case 'snap':
      return x >= 1 ? 1 : 1 - Math.pow(2, -SNAP_EXPONENT * x);
  }
}

/**
 * Attack–hold–release envelope: `from` → 1 over `attack`, holds, then 1 → 0 over `release`.
 * `t` is the time since the pulse started (negative = not started yet → `from`).
 */
export function pulseValue(
  t: number,
  attack: number,
  hold: number,
  release: number,
  from = 0,
  attackEase: EaseName = 'snap',
  releaseEase: EaseName = 'inOut',
): number {
  if (t < 0) return from;
  if (t < attack) return from + (1 - from) * ease(attackEase, attack > 0 ? t / attack : 1);
  const r = t - attack - hold;
  if (r < 0) return 1;
  if (r >= release) return 0;
  return 1 - ease(releaseEase, release > 0 ? r / release : 1);
}

/** Fade in over `fadeIn`, out over `fadeOut` (fractions of the normalized 0..1 time `t`). */
export function envelope(t: number, fadeIn: number, fadeOut: number): number {
  if (t <= 0 || t >= 1) return 0;
  const a = fadeIn > 0 ? clamp01(t / fadeIn) : 1;
  const b = fadeOut > 0 ? clamp01((1 - t) / fadeOut) : 1;
  const e = Math.min(a, b);
  return e * e * (3 - 2 * e);
}

// ---------------------------------------------------------------------------
// 6-DOF poses (position in meters, rotation as XYZ Euler radians)
// ---------------------------------------------------------------------------

export interface Pose {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
}

export function createPose(): Pose {
  return { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
}

export function poseZero(out: Pose): Pose {
  out.px = out.py = out.pz = out.rx = out.ry = out.rz = 0;
  return out;
}

export function poseCopy(out: Pose, p: Readonly<Pose>): Pose {
  out.px = p.px;
  out.py = p.py;
  out.pz = p.pz;
  out.rx = p.rx;
  out.ry = p.ry;
  out.rz = p.rz;
  return out;
}

/** Convert a data pose (degrees) into a runtime pose (radians). */
export function poseFromDef(out: Pose, def: PoseDef | undefined, scale = 1): Pose {
  const p = def?.pos;
  const r = def?.rot;
  out.px = (p?.x ?? 0) * scale;
  out.py = (p?.y ?? 0) * scale;
  out.pz = (p?.z ?? 0) * scale;
  out.rx = (r?.x ?? 0) * DEG2RAD * scale;
  out.ry = (r?.y ?? 0) * DEG2RAD * scale;
  out.rz = (r?.z ?? 0) * DEG2RAD * scale;
  return out;
}

/** out += p * s */
export function poseAddScaled(out: Pose, p: Readonly<Pose>, s: number): Pose {
  out.px += p.px * s;
  out.py += p.py * s;
  out.pz += p.pz * s;
  out.rx += p.rx * s;
  out.ry += p.ry * s;
  out.rz += p.rz * s;
  return out;
}

/** out += def * s (def in degrees). */
export function poseAddDef(out: Pose, def: PoseDef | undefined, s: number): Pose {
  if (!def || s === 0) return out;
  const p = def.pos;
  const r = def.rot;
  if (p) {
    out.px += p.x * s;
    out.py += p.y * s;
    out.pz += p.z * s;
  }
  if (r) {
    out.rx += r.x * DEG2RAD * s;
    out.ry += r.y * DEG2RAD * s;
    out.rz += r.z * DEG2RAD * s;
  }
  return out;
}

export function poseLerp(out: Pose, a: Readonly<Pose>, b: Readonly<Pose>, t: number): Pose {
  out.px = a.px + (b.px - a.px) * t;
  out.py = a.py + (b.py - a.py) * t;
  out.pz = a.pz + (b.pz - a.pz) * t;
  out.rx = a.rx + (b.rx - a.rx) * t;
  out.ry = a.ry + (b.ry - a.ry) * t;
  out.rz = a.rz + (b.rz - a.rz) * t;
  return out;
}

/** Largest absolute component (meters and radians mixed – only used for "is it at rest?"). */
export function poseMagnitude(p: Readonly<Pose>): number {
  return Math.max(
    Math.abs(p.px),
    Math.abs(p.py),
    Math.abs(p.pz),
    Math.abs(p.rx),
    Math.abs(p.ry),
    Math.abs(p.rz),
  );
}

/**
 * Sample a pose-key track at normalized time `t`. Keys must be sorted by `t`; before the first
 * key / after the last key the rest pose (zero) is blended in, so tracks always start and end
 * at rest unless they place keys at 0 and 1. Segments use smoothstep (zero velocity at keys):
 * the spring follower downstream turns the holds into organic motion.
 */
export function samplePoseTrack(out: Pose, keys: readonly PoseKeyDef[], t: number): Pose {
  poseZero(out);
  const n = keys.length;
  if (n === 0) return out;
  const first = keys[0]!;
  const last = keys[n - 1]!;
  if (t <= first.t) {
    const w = first.t > 0 ? smooth(clamp01(t / first.t)) : 1;
    return poseAddDef(out, first, w);
  }
  if (t >= last.t) {
    const w = last.t < 1 ? 1 - smooth(clamp01((t - last.t) / (1 - last.t))) : 1;
    return poseAddDef(out, last, w);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const u = span > 0 ? smooth((t - a.t) / span) : 1;
      poseAddDef(out, a, 1 - u);
      poseAddDef(out, b, u);
      return out;
    }
  }
  return out;
}

function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Time warps (align authored tracks with the real gameplay markers)
// ---------------------------------------------------------------------------

/**
 * Piecewise-linear remap of normalized time through anchor pairs `src[i] → dst[i]`, with 0 → 0
 * and 1 → 1 implied. Used to make an authored pose track hit its keys exactly when the weapon's
 * real markers fire (reload steps, the melee blow), whatever their timing in defs/weapons.
 */
export interface TimeWarp {
  readonly src: Float64Array;
  readonly dst: Float64Array;
  n: number;
}

export function createTimeWarp(capacity = 8): TimeWarp {
  return { src: new Float64Array(capacity), dst: new Float64Array(capacity), n: 0 };
}

export function timeWarpReset(w: TimeWarp): TimeWarp {
  w.n = 0;
  return w;
}

/**
 * Append an anchor. Pairs must come in increasing order in BOTH spaces and lie strictly inside
 * (0, 1); anything else (a def and a weapon that disagree on the marker order, a full table) is
 * skipped, so the warp always stays monotonic. Returns whether the pair was used.
 */
export function timeWarpAdd(w: TimeWarp, src: number, dst: number): boolean {
  if (w.n >= w.src.length) return false;
  if (!(src > 0 && src < 1 && dst > 0 && dst < 1)) return false;
  if (w.n > 0 && (src <= w.src[w.n - 1]! || dst <= w.dst[w.n - 1]!)) return false;
  w.src[w.n] = src;
  w.dst[w.n] = dst;
  w.n++;
  return true;
}

/** Warp `t` (identity outside 0..1 and for an empty warp). */
export function timeWarpApply(w: TimeWarp, t: number): number {
  if (w.n === 0 || t <= 0 || t >= 1) return t;
  let s0 = 0;
  let d0 = 0;
  for (let i = 0; i <= w.n; i++) {
    const s1 = i < w.n ? w.src[i]! : 1;
    const d1 = i < w.n ? w.dst[i]! : 1;
    if (t <= s1) return d0 + ((t - s0) / (s1 - s0)) * (d1 - d0);
    s0 = s1;
    d0 = d1;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

/** Six independent 1D springs (position xyz + rotation xyz). */
export interface PoseSpring {
  readonly px: SpringState;
  readonly py: SpringState;
  readonly pz: SpringState;
  readonly rx: SpringState;
  readonly ry: SpringState;
  readonly rz: SpringState;
}

export function createPoseSpring(): PoseSpring {
  const s = (): SpringState => ({ value: 0, velocity: 0 });
  return { px: s(), py: s(), pz: s(), rx: s(), ry: s(), rz: s() };
}

export function resetPoseSpring(s: PoseSpring): void {
  for (const k of POSE_KEYS) {
    s[k].value = 0;
    s[k].velocity = 0;
  }
}

const POSE_KEYS = ['px', 'py', 'pz', 'rx', 'ry', 'rz'] as const;

/**
 * Step every axis towards `target` (null = rest) with sub-steps of at most `maxStep` seconds,
 * then write the values into `out`. Frame-rate independent for stiff springs.
 */
export function stepPoseSpring(
  s: PoseSpring,
  target: Readonly<Pose> | null,
  tuning: PoseSpringDef,
  dt: number,
  maxStep: number,
  out: Pose,
): Pose {
  if (dt > 0) {
    const n = Math.max(1, Math.ceil(dt / maxStep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      springStep(s.px, target ? target.px : 0, tuning.posStiffness, tuning.posDamping, h);
      springStep(s.py, target ? target.py : 0, tuning.posStiffness, tuning.posDamping, h);
      springStep(s.pz, target ? target.pz : 0, tuning.posStiffness, tuning.posDamping, h);
      springStep(s.rx, target ? target.rx : 0, tuning.rotStiffness, tuning.rotDamping, h);
      springStep(s.ry, target ? target.ry : 0, tuning.rotStiffness, tuning.rotDamping, h);
      springStep(s.rz, target ? target.rz : 0, tuning.rotStiffness, tuning.rotDamping, h);
    }
  }
  out.px = s.px.value;
  out.py = s.py.value;
  out.pz = s.pz.value;
  out.rx = s.rx.value;
  out.ry = s.ry.value;
  out.rz = s.rz.value;
  return out;
}

/**
 * Add a velocity impulse so that each axis (starting at rest) peaks at the matching component
 * of `peak`. `impulseForPeak(1, k, c)` is the per-unit velocity (linear in the peak).
 */
export function addPoseImpulse(
  s: PoseSpring,
  peak: Readonly<Pose>,
  posImpulsePerUnit: number,
  rotImpulsePerUnit: number,
): void {
  s.px.velocity += peak.px * posImpulsePerUnit;
  s.py.velocity += peak.py * posImpulsePerUnit;
  s.pz.velocity += peak.pz * posImpulsePerUnit;
  s.rx.velocity += peak.rx * rotImpulsePerUnit;
  s.ry.velocity += peak.ry * rotImpulsePerUnit;
  s.rz.velocity += peak.rz * rotImpulsePerUnit;
}
