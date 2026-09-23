/**
 * Pure audio helpers (no Web Audio objects): noise tables, loop crossfades, trimming,
 * normalization, variant/voice selection. Unit-tested in Node.
 */
import type { Rng } from '../core/Rng';

/** Uniform white noise in [-1, 1). */
export function fillWhite<T extends Float32Array>(out: T, rng: Rng): T {
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/**
 * Pink (1/f) noise via Paul Kellet's refined filter bank, scaled to roughly [-1, 1].
 * Pink noise sounds natural for friction/air textures (less hissy than white).
 */
export function fillPink<T extends Float32Array>(out: T, rng: Rng): T {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return normalizePeak(out, 1);
}

/** Brown (1/f²) noise: leaky integrated white noise – deep rumble. */
export function fillBrown<T extends Float32Array>(out: T, rng: Rng): T {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last;
  }
  return normalizePeak(out, 1);
}

export function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i] as number);
    if (a > peak) peak = a;
  }
  return peak;
}

/** Scale in place so the absolute peak equals `target` (silence stays silent). */
export function normalizePeak<T extends Float32Array>(data: T, target: number): T {
  const peak = peakOf(data);
  if (peak <= 0) return data;
  const k = target / peak;
  for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) * k;
  return data;
}

export function rmsOf(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] as number) ** 2;
  return data.length > 0 ? Math.sqrt(sum / data.length) : 0;
}

/** Scale in place to the given RMS level – noise colors then have equal energy, not equal peaks. */
export function normalizeRms<T extends Float32Array>(data: T, target: number): T {
  const rms = rmsOf(data);
  if (rms <= 0) return data;
  const k = target / rms;
  for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) * k;
  return data;
}

/** Scale several channels together (keeps the stereo balance). */
export function normalizeChannels(channels: readonly Float32Array[], target: number): void {
  let peak = 0;
  for (const ch of channels) peak = Math.max(peak, peakOf(ch));
  if (peak <= 0) return;
  const k = target / peak;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] as number) * k;
}

/** Index after the last sample above `threshold` in any channel (at least 1). */
export function audibleLength(channels: readonly Float32Array[], threshold: number): number {
  let last = 0;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= last; i--) {
      if (Math.abs(ch[i] as number) > threshold) {
        last = i + 1;
        break;
      }
    }
  }
  return Math.max(1, last);
}

/** Linear fade-out over the last `samples` samples of every channel (in place). */
export function fadeOutTail(channels: readonly Float32Array[], samples: number): void {
  for (const ch of channels) {
    const n = Math.min(samples, ch.length);
    for (let i = 0; i < n; i++) {
      const idx = ch.length - n + i;
      ch[idx] = (ch[idx] as number) * (1 - (i + 1) / n);
    }
  }
}

/**
 * Seamless loop: the last `crossfade` samples are folded onto the start with an equal-power
 * crossfade (uncorrelated noise textures keep constant loudness). The result is `crossfade`
 * samples shorter; its last sample flows directly into its first.
 */
export function makeLoopable(
  channels: readonly Float32Array[],
  crossfade: number,
): Float32Array<ArrayBuffer>[] {
  return channels.map((ch) => {
    const x = Math.max(0, Math.min(Math.floor(crossfade), Math.floor(ch.length / 2)));
    const len = ch.length - x;
    const out = new Float32Array(len);
    out.set(ch.subarray(0, len));
    for (let i = 0; i < x; i++) {
      const t = (i + 0.5) / x;
      const fadeIn = Math.sin(t * Math.PI * 0.5);
      const fadeOut = Math.cos(t * Math.PI * 0.5);
      out[i] = (ch[i] as number) * fadeIn + (ch[len + i] as number) * fadeOut;
    }
    return out;
  });
}

/** Random variant index that differs from `last` whenever more than one variant exists. `r` in [0, 1). */
export function pickVariant(count: number, last: number, r: number): number {
  if (count <= 1) return 0;
  if (last < 0 || last >= count) return Math.min(count - 1, Math.floor(r * count));
  const idx = Math.min(count - 2, Math.floor(r * (count - 1)));
  return idx >= last ? idx + 1 : idx;
}

export interface StealCandidate {
  readonly volume: number;
  readonly startTime: number;
  readonly loop: boolean;
}

/**
 * Voice to steal when the voice limit is reached: one-shots before loops, then the quietest,
 * then the oldest. Returns -1 for an empty list.
 */
export function pickStealIndex(voices: readonly StealCandidate[], volumeEpsilon: number): number {
  let best = -1;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i] as StealCandidate;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = voices[best] as StealCandidate;
    if (v.loop !== b.loop) {
      if (!v.loop) best = i;
      continue;
    }
    if (v.volume < b.volume - volumeEpsilon) best = i;
    else if (Math.abs(v.volume - b.volume) <= volumeEpsilon && v.startTime < b.startTime) best = i;
  }
  return best;
}

/** Linear map of `v` from [inMin, inMax] onto [outMin, outMax], clamped. */
export function remapClamped(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMax;
  const t = Math.min(1, Math.max(0, (v - inMin) / (inMax - inMin)));
  return outMin + (outMax - outMin) * t;
}
