/**
 * Low-health heartbeat pulse (pure): two gaussian beats per period ("lub-dub") instead of a
 * sine, which reads as breathing rather than a heartbeat. Output 0..1 (1 = peak of the first beat).
 */
export interface HeartbeatShape {
  /** Gaussian width of one beat, as a fraction of the period. */
  beatWidth: number;
  /** Delay of the second beat after the first, as a fraction of the period. */
  secondBeatDelay: number;
  /** Peak of the second beat relative to the first (0..1). */
  secondBeatStrength: number;
}

export function heartbeatPulse(time: number, frequency: number, shape: HeartbeatShape): number {
  if (!(frequency > 0) || !Number.isFinite(time)) return 0;
  const cycles = time * frequency;
  const phase = cycles - Math.floor(cycles);
  const w = Math.max(1e-3, shape.beatWidth);
  // First beat sits on the period boundary: measure the wrapped distance.
  const d1 = Math.min(phase, 1 - phase) / w;
  const d2 = (phase - shape.secondBeatDelay) / w;
  const b1 = Math.exp(-d1 * d1);
  const b2 = shape.secondBeatStrength * Math.exp(-d2 * d2);
  return b1 > b2 ? b1 : b2;
}
