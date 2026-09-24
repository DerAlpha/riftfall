/**
 * Pure pickup animation curves (unit-tested): materialize, the blink before despawning (its rate
 * ramps up towards the end; with reduced flashing a slow soft pulse instead), the collect implode.
 */
import { POWERUPS } from '../defs/powerups';

const P = POWERUPS.pickup;

/** 0 → 1 over the materialize time (ease-out). */
export function spawnProgress(age: number): number {
  if (!(P.spawnTime > 0)) return 1;
  const t = Math.min(1, Math.max(0, age / P.spawnTime));
  return 1 - (1 - t) * (1 - t);
}

/** 0 → 1 over the collect animation (`since` = seconds since collected, < 0 = not collected). */
export function collectProgress(since: number): number {
  if (since < 0) return 0;
  return P.collectTime > 0 ? Math.min(1, since / P.collectTime) : 1;
}

/**
 * Visibility 0..1: 1 until the last `blinkTime` s of `lifetime`, then a blink whose frequency ramps
 * from blinkHz[0] to blinkHz[1] (phase = ∫f dt, so the ramp never jumps).
 */
export function blinkVisibility(age: number, lifetime: number, reduced = false): number {
  const T = Math.min(P.blinkTime, lifetime);
  const start = lifetime - T;
  if (!(age > start) || !(T > 0)) return 1;
  const t = Math.min(T, age - start);
  const [f0, f1] = P.blinkHz;
  if (reduced) return 0.55 + 0.45 * Math.cos(2 * Math.PI * f0 * t);
  const phase = f0 * t + ((f1 - f0) * t * t) / (2 * T);
  return phase - Math.floor(phase) < P.blinkDuty ? 1 : 0;
}
