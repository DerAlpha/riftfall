/**
 * Algorithmic reverb impulse responses (pure – returns sample data; the engine wraps it in an
 * AudioBuffer for a ConvolverNode). Structure: silent pre-delay, a handful of discrete early
 * reflections, then a diffuse tail of decorrelated stereo noise with an exponential decay that
 * hits -60 dB after `decay` seconds (RT60), low-passed progressively so highs die first.
 */
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';

export interface ReverbParams {
  /** RT60 in seconds. */
  readonly decay: number;
  readonly preDelay: number;
}

export type IrShape = typeof AUDIO.reverbIr;

/** ln(1000): amplitude factor for -60 dB. */
const LN_1000 = Math.log(1000);

export function impulseLength(p: ReverbParams, sampleRate: number): number {
  return Math.max(1, Math.ceil((p.preDelay + p.decay) * sampleRate));
}

export function generateImpulseResponse(
  p: ReverbParams,
  sampleRate: number,
  seed: string,
  shape: IrShape = AUDIO.reverbIr,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = impulseLength(p, sampleRate);
  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const start = Math.min(length - 1, Math.round(p.preDelay * sampleRate));
  const tailFade = Math.max(1, Math.round(shape.tailFadeIn * sampleRate));
  const decaySamples = Math.max(1, p.decay * sampleRate);

  for (let c = 0; c < 2; c++) {
    // Independent streams per channel = decorrelated left/right (wide, enveloping tail).
    const rng = new Rng(`${seed}:${c}`);
    const out = channels[c] as Float32Array;

    let lp = 0;
    for (let i = start; i < length; i++) {
      const n = i - start;
      const env = Math.exp((-LN_1000 * n) / decaySamples);
      const fadeIn = n < tailFade ? n / tailFade : 1;
      const k =
        shape.brightnessStart + (shape.brightnessEnd - shape.brightnessStart) * Math.min(1, n / decaySamples);
      lp += k * (rng.next() * 2 - 1 - lp);
      out[i] = lp * env * fadeIn;
    }

    const earlyEnd = Math.min(length - 1, start + Math.round(shape.earlyWindow * sampleRate));
    for (let r = 0; r < shape.earlyReflections; r++) {
      const idx = Math.round(start + rng.next() * (earlyEnd - start));
      const gain = shape.earlyGain * (1 - r / (shape.earlyReflections + 1)) * (rng.chance(0.5) ? 1 : -1);
      out[idx] = (out[idx] as number) + gain;
    }
  }
  return channels;
}
