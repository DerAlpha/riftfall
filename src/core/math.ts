/** Small, allocation-free math helpers shared by all systems. */
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));
}

/**
 * Frame-rate independent exponential smoothing. `lambda` is the decay rate (1/s):
 * after 1/lambda seconds ~63% of the distance is covered.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference b - a between two angles. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/**
 * Critically damped spring (semi-implicit). State is passed in/out through `s` to
 * avoid allocations. Used for camera landing dip, viewmodel sway, recoil recovery.
 */
export interface SpringState {
  value: number;
  velocity: number;
}

export function springStep(
  s: SpringState,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): void {
  const force = (target - s.value) * stiffness - s.velocity * damping;
  s.velocity += force * dt;
  s.value += s.velocity * dt;
}

/** 1D value noise in [-1, 1], smooth, deterministic. Cheap enough for per-frame camera shake. */
export function noise1D(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i + seed * 1013), hash1(i + 1 + seed * 1013), u) * 2 - 1;
}

function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Exponential moving average helper for stats (FPS, frame time). */
export class Ema {
  value: number;
  private initialized = false;
  constructor(
    private readonly alpha: number,
    initial = 0,
  ) {
    this.value = initial;
  }
  push(sample: number): number {
    if (!this.initialized) {
      this.value = sample;
      this.initialized = true;
    } else {
      this.value += this.alpha * (sample - this.value);
    }
    return this.value;
  }
  reset(v = 0): void {
    this.value = v;
    this.initialized = false;
  }
}

/** Fixed-size ring buffer of numbers (frame time graph, rolling averages). */
export class RingBuffer {
  readonly data: Float32Array;
  private head = 0;
  private count = 0;
  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }
  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  get length(): number {
    return this.count;
  }
  /** i = 0 is the oldest sample. */
  get(i: number): number {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity] ?? 0;
  }
  average(): number {
    if (this.count === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.get(i);
    return s / this.count;
  }
  max(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.get(i));
    return m;
  }
  /** Percentile in [0,1] (allocates; debug use only). */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const arr: number[] = [];
    for (let i = 0; i < this.count; i++) arr.push(this.get(i));
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] ?? 0;
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
