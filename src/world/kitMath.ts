/**
 * Pure helpers for the level kit and layout validation (no three.js scene objects, no GPU):
 * UV projection, rectangle subtraction, stair/ramp math, light budgets and jump reachability.
 */

export interface UV {
  x: number;
  y: number;
}

/**
 * Box-projected UVs in meters from a (frame-local) position and face normal. The dominant normal
 * axis picks the projection plane; orientation is chosen so textures read un-mirrored and upright
 * when the face is viewed from outside (walls: V = +Y; floors: V = -Z, i.e. "north").
 */
export function boxFaceUV(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  out: UV,
): UV {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ay >= ax && ay >= az) {
    if (ny >= 0) {
      out.x = px;
      out.y = -pz;
    } else {
      out.x = -px;
      out.y = -pz;
    }
  } else if (ax >= az) {
    out.x = nx >= 0 ? -pz : pz;
    out.y = py;
  } else {
    out.x = nz >= 0 ? px : -px;
    out.y = py;
  }
  return out;
}

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxZ - r.minZ);
}

export function rectsOverlap(a: Rect, b: Rect, eps = 1e-6): boolean {
  return a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minZ < b.maxZ - eps && b.minZ < a.maxZ - eps;
}

export function rectContainsPoint(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/**
 * Cover `outer` minus `holes` with non-overlapping axis-aligned rectangles (band sweep along Z,
 * then free X intervals per band; adjacent bands with identical intervals are merged).
 */
export function subtractRects(outer: Rect, holes: readonly Rect[]): Rect[] {
  const clipped: Rect[] = [];
  for (const h of holes) {
    const c = {
      minX: Math.max(outer.minX, h.minX),
      maxX: Math.min(outer.maxX, h.maxX),
      minZ: Math.max(outer.minZ, h.minZ),
      maxZ: Math.min(outer.maxZ, h.maxZ),
    };
    if (c.maxX > c.minX && c.maxZ > c.minZ) clipped.push(c);
  }
  const zs = new Set<number>([outer.minZ, outer.maxZ]);
  for (const h of clipped) {
    zs.add(h.minZ);
    zs.add(h.maxZ);
  }
  const zList = [...zs].sort((a, b) => a - b);
  const out: Rect[] = [];
  let prev: Rect[] = [];
  for (let i = 0; i < zList.length - 1; i++) {
    const z0 = zList[i]!;
    const z1 = zList[i + 1]!;
    if (z1 - z0 <= 1e-9) continue;
    const zm = (z0 + z1) * 0.5;
    const blocked = clipped
      .filter((h) => h.minZ < zm && h.maxZ > zm)
      .map((h) => [h.minX, h.maxX] as const)
      .sort((a, b) => a[0] - b[0]);
    const free: [number, number][] = [];
    let x = outer.minX;
    for (const [bx0, bx1] of blocked) {
      if (bx0 > x) free.push([x, bx0]);
      x = Math.max(x, bx1);
    }
    if (x < outer.maxX) free.push([x, outer.maxX]);
    const band: Rect[] = [];
    for (const [fx0, fx1] of free) {
      if (fx1 - fx0 <= 1e-9) continue;
      // Merge with the rectangle directly above if it spans exactly the same X interval.
      const above = prev.find(
        (r) => Math.abs(r.minX - fx0) < 1e-9 && Math.abs(r.maxX - fx1) < 1e-9 && Math.abs(r.maxZ - z0) < 1e-9,
      );
      if (above) {
        above.maxZ = z1;
        band.push(above);
      } else {
        const r = { minX: fx0, maxX: fx1, minZ: z0, maxZ: z1 };
        out.push(r);
        band.push(r);
      }
    }
    prev = band;
  }
  return out;
}

/** Remove `holes` ([start, end] pairs) from [a0, a1]; returns the remaining intervals in order. */
export function subtractIntervals(
  a0: number,
  a1: number,
  holes: readonly (readonly [number, number])[],
): [number, number][] {
  const sorted = holes
    .map(([h0, h1]) => [Math.min(h0, h1), Math.max(h0, h1)] as const)
    .filter(([h0, h1]) => h1 > a0 && h0 < a1)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let x = a0;
  for (const [h0, h1] of sorted) {
    if (h0 > x) out.push([x, Math.min(h0, a1)]);
    x = Math.max(x, h1);
    if (x >= a1) break;
  }
  if (x < a1) out.push([x, a1]);
  return out.filter(([s, e]) => e - s > 1e-6);
}

export interface FlickerParams {
  rate: number;
  threshold: number;
  dropLevel: number;
  humAmount: number;
  humRate: number;
  burstPeriod: number;
  burstLength: number;
}

/**
 * Faulty-light intensity multiplier (0..1): noise dropouts, a subtle hum and a periodic short
 * blackout. Deterministic in (time, seed); `noise` is a smooth 1D noise in [-1, 1].
 */
export function flickerFactor(
  time: number,
  seed: number,
  p: FlickerParams,
  noise: (x: number, seed: number) => number,
): number {
  let k = noise(time * p.rate, seed) < p.threshold ? p.dropLevel : 1;
  k *= 1 - p.humAmount * (0.5 + 0.5 * Math.sin(time * p.humRate * Math.PI * 2));
  const period = Math.max(1e-3, p.burstPeriod);
  const phase = (((time + seed * 1.37) % period) + period) % period;
  if (phase < p.burstLength) k *= p.dropLevel;
  return k;
}

export interface ReducedFlickerParams {
  rate: number;
  depth: number;
}

/**
 * Photosensitivity-safe variant of {@link flickerFactor} (accessibility "reduce flashing"): no hard
 * dropouts, hum or blackouts, only a smooth noise-driven dimming in [1 - depth, 1]. Deterministic in
 * (time, seed); `noise` is a smooth 1D noise in [-1, 1].
 */
export function reducedFlickerFactor(
  time: number,
  seed: number,
  p: ReducedFlickerParams,
  noise: (x: number, seed: number) => number,
): number {
  const depth = Math.min(1, Math.max(0, p.depth));
  return 1 - depth * (0.5 + 0.5 * noise(time * p.rate, seed));
}

export interface StairsLayout {
  steps: number;
  stepRise: number;
  stepRun: number;
  totalRun: number;
  slopeDeg: number;
}

/** Evenly divided stairs: the step count is chosen so no step exceeds `maxStepRise`. */
export function stairsLayout(totalRise: number, maxStepRise: number, stepRun: number): StairsLayout {
  const steps = Math.max(1, Math.ceil(totalRise / maxStepRise - 1e-9));
  const stepRise = totalRise / steps;
  return {
    steps,
    stepRise,
    stepRun,
    totalRun: steps * stepRun,
    slopeDeg: (Math.atan2(stepRise, stepRun) * 180) / Math.PI,
  };
}

export function slopeDeg(rise: number, run: number): number {
  return (Math.atan2(rise, run) * 180) / Math.PI;
}

/** Run needed to climb `rise` at `deg` degrees. */
export function runForSlope(rise: number, deg: number): number {
  return rise / Math.tan((deg * Math.PI) / 180);
}

/** Round the circumference to a whole number of texture repeats so a pipe's UV seam is invisible. */
export function pipeWrapRepeats(radius: number, uvScale: number): number {
  return Math.max(1, Math.round((2 * Math.PI * radius) / uvScale));
}

/**
 * Pick which lights get shadows: the `max` lowest priority values win (ties keep declaration
 * order). Returns a flag per input index.
 */
export function allocateShadowBudget(priorities: readonly number[], max: number): boolean[] {
  const order = priorities.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const result = priorities.map(() => false);
  for (let k = 0; k < Math.min(Math.max(0, Math.floor(max)), order.length); k++) result[order[k]!.i] = true;
  return result;
}

/** Round-robin window: which of `count` items update this frame when each updates every `interval` frames. */
export function staggeredSlot(index: number, frame: number, interval: number): boolean {
  const n = Math.max(1, Math.floor(interval));
  return (((index + frame) % n) + n) % n === 0;
}

// ---------------------------------------------------------------------------
// Jump / movement reachability (layout validation)
// ---------------------------------------------------------------------------

export interface JumpPhysics {
  gravity: number;
  /** Gravity multiplier while falling. */
  fallGravityMultiplier: number;
}

/** Launch speed that reaches `height` under `gravity`. */
export function jumpSpeedForHeight(height: number, gravity: number): number {
  return Math.sqrt(2 * gravity * Math.max(0, height));
}

/**
 * Time in the air for a jump of apex `apexHeight` that lands `landingDelta` meters higher (>0)
 * or lower (<0) than the takeoff. Returns NaN if the landing is above the apex.
 */
export function airTime(apexHeight: number, landingDelta: number, p: JumpPhysics): number {
  if (landingDelta > apexHeight) return Number.NaN;
  const up = Math.sqrt((2 * apexHeight) / p.gravity);
  const fallHeight = apexHeight - landingDelta;
  const down = Math.sqrt((2 * fallHeight) / (p.gravity * p.fallGravityMultiplier));
  return up + down;
}

/** Horizontal distance of a jump at constant horizontal speed. */
export function jumpDistance(
  speed: number,
  apexHeight: number,
  landingDelta: number,
  p: JumpPhysics,
): number {
  const t = airTime(apexHeight, landingDelta, p);
  return Number.isFinite(t) ? speed * t : 0;
}
