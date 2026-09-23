/**
 * Firing-spot scoring for ranged enemies (pure). A candidate spot is good when it has line of sight
 * to the target, has cover next to it (a wall/pillar to step behind), is close to the preferred
 * distance band, needs little walking and is not crowded by other ranged enemies.
 */
export interface SpotWeights {
  readonly los: number;
  readonly cover: number;
  readonly travel: number;
  readonly band: number;
  readonly crowd: number;
}

export interface SpotInput {
  /** Line of sight from the spot (eye height) to the target's eye. */
  los: boolean;
  /** 0..1 cover next to the spot (lateral wall probes). */
  cover: number;
  /** Meters to walk to the spot. */
  travel: number;
  /** Distance from the spot to the target (m). */
  distance: number;
  /** Other ranged enemies' spots within the crowd radius. */
  crowd: number;
}

export function scoreSpot(s: Readonly<SpotInput>, preferred: number, w: SpotWeights): number {
  return (
    (s.los ? w.los : 0) +
    w.cover * s.cover -
    w.travel * s.travel -
    w.band * Math.abs(s.distance - preferred) -
    w.crowd * s.crowd
  );
}

/** Is `d` inside the band (with `slack` m tolerance on both sides)? */
export function inBand(d: number, min: number, max: number, slack = 0): boolean {
  return d >= min - slack && d <= max + slack;
}

/**
 * Candidate bearing i of n spread over ±arc around `bearing` (radians): 0 → the current bearing,
 * then alternating left/right, widening – the cheap spots (little travel) come first.
 */
export function candidateBearing(bearing: number, i: number, n: number, arc: number): number {
  if (i <= 0 || n <= 1) return bearing;
  const steps = Math.ceil((n - 1) / 2);
  const k = Math.ceil(i / 2);
  const side = i % 2 === 1 ? 1 : -1;
  return bearing + side * (k / steps) * arc;
}
