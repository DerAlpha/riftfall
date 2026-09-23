/**
 * Pure recoil logic. Angles in DEGREES in "recoil space": yaw + = right, pitch + = up.
 *
 * Every shot kicks the aim by the next pattern entry (+ seeded randomness, × stance multipliers)
 * and adds it to the UNRECOVERED offset. After `recoveryDelay` the aim drifts back towards the
 * origin at `recoveryPerSec` – but only by what is still unrecovered: when the player pulls
 * against the recoil, that pull is subtracted from the offset first (compensateRecoil), so
 * recovery never drags an already-corrected aim further down.
 */
import type { Rng } from '../core/Rng';
import type { WeaponRecoilDef } from '../defs/weapons';

export interface RecoilState {
  /** Index of the next pattern entry. */
  shotIndex: number;
  /** Unrecovered aim offset (deg). */
  pitch: number;
  yaw: number;
  /** Seconds since the last shot. */
  sinceShot: number;
}

export interface RecoilKick {
  yaw: number;
  pitch: number;
}

export function createRecoilState(): RecoilState {
  return { shotIndex: 0, pitch: 0, yaw: 0, sinceShot: Number.POSITIVE_INFINITY };
}

export function resetRecoil(s: RecoilState): void {
  s.shotIndex = 0;
  s.pitch = 0;
  s.yaw = 0;
  s.sinceShot = Number.POSITIVE_INFINITY;
}

/** Pattern index used for shot number `shot` (0-based), looping from `patternRepeatFrom`. */
export function patternIndex(def: WeaponRecoilDef, shot: number): number {
  const n = def.pattern.length;
  if (n === 0) return -1;
  if (shot < n) return shot;
  const from = Math.min(Math.max(0, def.patternRepeatFrom), n - 1);
  const loop = n - from;
  return from + ((shot - n) % loop);
}

/** Index of the next shot within its burst: 0 once the pattern resets after `resetTime`. */
export function burstShotIndex(def: WeaponRecoilDef, s: RecoilState): number {
  return s.sinceShot > def.resetTime ? 0 : s.shotIndex;
}

/**
 * Next kick: pattern step + uniform randomness (seeded) × `multiplier` (ADS/crouch/mods).
 * Advances the pattern, accumulates the unrecovered offset and restarts the recovery delay.
 */
export function recoilKick(
  def: WeaponRecoilDef,
  s: RecoilState,
  rng: Rng,
  multiplier: number,
  out: RecoilKick,
): RecoilKick {
  s.shotIndex = burstShotIndex(def, s);
  const i = patternIndex(def, s.shotIndex);
  const entry = i >= 0 ? def.pattern[i]! : null;
  const yaw = (entry ? entry[0] : 0) + rng.range(-def.randomYaw, def.randomYaw);
  const pitch = (entry ? entry[1] : 0) + rng.range(-def.randomPitch, def.randomPitch);
  out.yaw = yaw * multiplier;
  out.pitch = pitch * multiplier;
  s.yaw += out.yaw;
  s.pitch += out.pitch;
  s.shotIndex++;
  s.sinceShot = 0;
  return out;
}

/** Stance multiplier: ADS blend and crouch. */
export function recoilMultiplier(def: WeaponRecoilDef, ads: number, crouched: boolean): number {
  const a = ads < 0 ? 0 : ads > 1 ? 1 : ads;
  return (1 + (def.adsMultiplier - 1) * a) * (crouched ? def.crouchMultiplier : 1);
}

/**
 * The player moved the aim by (lookYaw, lookPitch) deg this frame. Movement against the
 * unrecovered offset consumes it (never past zero); movement with it changes nothing.
 */
export function compensateRecoil(s: RecoilState, lookYaw: number, lookPitch: number): void {
  s.pitch = consume(s.pitch, lookPitch);
  s.yaw = consume(s.yaw, lookYaw);
}

function consume(offset: number, look: number): number {
  if (offset > 0 && look < 0) return Math.max(0, offset + look);
  if (offset < 0 && look > 0) return Math.min(0, offset + look);
  return offset;
}

/**
 * Advance time. Once the recovery delay passed, move the unrecovered offset straight back
 * towards zero at `recoveryPerSec`; writes the aim change to apply (deg) into `out`.
 */
export function recoverRecoil(def: WeaponRecoilDef, s: RecoilState, dt: number, out: RecoilKick): RecoilKick {
  out.yaw = 0;
  out.pitch = 0;
  s.sinceShot += dt;
  if (s.sinceShot < def.recoveryDelay) return out;
  const mag = Math.hypot(s.yaw, s.pitch);
  if (mag <= 0) return out;
  // Only the part of this tick after the delay counts.
  const active = Math.min(dt, s.sinceShot - def.recoveryDelay);
  const step = Math.min(mag, def.recoveryPerSec * active);
  const k = step / mag;
  out.yaw = -s.yaw * k;
  out.pitch = -s.pitch * k;
  s.yaw += out.yaw;
  s.pitch += out.pitch;
  if (step === mag) {
    s.yaw = 0;
    s.pitch = 0;
  }
  return out;
}
