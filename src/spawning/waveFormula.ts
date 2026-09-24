/**
 * Pure wave math (defs/waves.ts curves → one WavePlan per wave) and the spawn order of a wave.
 * No allocation per wave: plans and order buffers are created once per mode and refilled.
 */
import type { Rng } from '../core/Rng';
import type {
  WaveKind,
  WaveLinearDef,
  WaveModeDef,
  WaveMultiplierDef,
  WaveSpecialDef,
  WaveTypeDef,
} from '../defs/waves';

/** Marks an unfilled slot while building the spawn order (type indices stay below it). */
const EMPTY_SLOT = 255;
export const MAX_WAVE_TYPES = EMPTY_SLOT;

function waveNumber(wave: number): number {
  return Number.isFinite(wave) ? Math.max(1, Math.floor(wave)) : 1;
}

/** Swarm wave: every `every` waves from `firstWave`. */
export function isSwarmWave(mode: WaveModeDef, wave: number): boolean {
  const s = mode.swarm;
  if (!s) return false;
  const w = waveNumber(wave);
  return w >= s.firstWave && s.every > 0 && (w - s.firstWave) % s.every === 0;
}

/** Enemies of a regular wave: base + linear·(w−1) + quadratic·(w−1)², capped (monotonic). */
export function baseWaveTotal(mode: WaveModeDef, wave: number): number {
  const n = waveNumber(wave) - 1;
  const t = mode.total;
  return Math.max(1, Math.min(t.max, Math.round(t.base + t.linear * n + t.quadratic * n * n)));
}

/** Enemies of wave `wave` including the swarm multiplier (specials are part of it). */
export function waveTotal(mode: WaveModeDef, wave: number): number {
  const base = baseWaveTotal(mode, wave);
  return isSwarmWave(mode, wave) ? Math.max(1, Math.round(base * mode.swarm!.totalMultiplier)) : base;
}

export function linearCapped(def: WaveLinearDef, steps: number): number {
  return Math.min(def.max, def.base + def.perWave * Math.max(0, steps));
}

/** Simultaneous enemies (never above `capacity` or the def cap, the performance budget). */
export function waveMaxAlive(mode: WaveModeDef, wave: number, capacity: number): number {
  const w = waveNumber(wave);
  let v = linearCapped(mode.maxAlive, w - 1);
  if (isSwarmWave(mode, w)) v *= mode.swarm!.maxAliveMultiplier;
  const cap = Math.min(mode.maxAlive.max, Number.isFinite(capacity) ? capacity : mode.maxAlive.max);
  return Math.max(1, Math.min(cap, Math.round(v)));
}

/** 1 + perWave·(min(w, knee) − 1), then ×growth per wave beyond the knee, capped. Monotonic. */
export function waveMultiplier(def: WaveMultiplierDef, wave: number): number {
  const w = waveNumber(wave);
  const knee = Math.max(1, def.knee);
  const linear = 1 + Math.max(0, def.perWave) * (Math.min(w, knee) - 1);
  const beyond = Math.max(0, w - knee);
  const v = linear * Math.pow(Math.max(1, def.growth), beyond);
  return Math.min(def.max, v);
}

/** Seconds between bursts. */
export function spawnInterval(mode: WaveModeDef, wave: number): number {
  const w = waveNumber(wave);
  const I = mode.cadence.interval;
  const v = Math.max(I.min, I.base * Math.pow(I.decay, w - 1));
  return isSwarmWave(mode, w) ? v * mode.swarm!.intervalMultiplier : v;
}

/** Largest burst of wave `wave`. */
export function burstMax(mode: WaveModeDef, wave: number): number {
  const w = waveNumber(wave);
  const B = mode.cadence.burst;
  let v = Math.min(B.cap, B.max + Math.floor(B.perWave * (w - 1)));
  if (isSwarmWave(mode, w)) v = Math.round(v * mode.swarm!.burstMultiplier);
  return Math.max(B.min, v);
}

/** Weight of a filler type in wave `wave` (0 while locked). */
export function typeWeight(t: WaveTypeDef, wave: number): number {
  const w = waveNumber(wave);
  if (w < t.unlockWave) return 0;
  return Math.max(0, linearCapped(t.weight, w - t.unlockWave));
}

/** Count of a special type in wave `wave` (0 when it is not scheduled). */
export function specialCount(s: WaveSpecialDef, wave: number): number {
  const w = waveNumber(wave);
  if (w < s.firstWave || s.every <= 0 || (w - s.firstWave) % s.every !== 0) return 0;
  const c = s.count;
  const growth = c.growthEvery > 0 ? Math.floor((w - s.firstWave) / c.growthEvery) : 0;
  return Math.max(0, Math.min(c.max, c.base + growth));
}

/** Types that can appear in wave `wave` (unlocked fillers + scheduled specials), for tests/debug. */
export function waveTypes(mode: WaveModeDef, wave: number): string[] {
  const out: string[] = [];
  const swarm = isSwarmWave(mode, wave);
  for (const t of mode.types) {
    const on = swarm ? mode.swarm!.types.includes(t.id) : typeWeight(t, wave) > 0;
    if (on && !out.includes(t.id)) out.push(t.id);
  }
  if (!swarm) {
    for (const s of mode.specials) if (specialCount(s, wave) > 0 && !out.includes(s.id)) out.push(s.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface WavePlan {
  wave: number;
  kind: WaveKind;
  /** Spawns queued this wave (sum of counts). */
  total: number;
  maxAlive: number;
  health: number;
  speed: number;
  damage: number;
  /** Seconds between bursts and the burst size range. */
  interval: number;
  burstMin: number;
  burstMax: number;
  /** Every type id the mode can spawn (stable indices into counts / the spawn order). */
  readonly typeIds: readonly string[];
  readonly counts: number[];
  /** Per type: placement range of a special (fraction of the order), -1 for fillers. */
  readonly placeFrom: readonly number[];
  readonly placeTo: readonly number[];
  /** Scratch weights (largest-remainder distribution). */
  readonly weights: number[];
}

/** Every type id a mode references, in a stable order (fillers, specials, swarm types). */
export function modeTypeIds(mode: WaveModeDef): string[] {
  const ids: string[] = [];
  for (const t of mode.types) if (!ids.includes(t.id)) ids.push(t.id);
  for (const s of mode.specials) if (!ids.includes(s.id)) ids.push(s.id);
  for (const id of mode.swarm?.types ?? []) if (!ids.includes(id)) ids.push(id);
  if (ids.length >= MAX_WAVE_TYPES) throw new Error(`Wave mode "${mode.id}": too many enemy types`);
  return ids;
}

export function createWavePlan(mode: WaveModeDef): WavePlan {
  const typeIds = modeTypeIds(mode);
  const placeFrom = typeIds.map(() => -1);
  const placeTo = typeIds.map(() => -1);
  for (const s of mode.specials) {
    const i = typeIds.indexOf(s.id);
    placeFrom[i] = Math.min(1, Math.max(0, s.placement[0]));
    placeTo[i] = Math.min(1, Math.max(placeFrom[i]!, s.placement[1]));
  }
  return {
    wave: 0,
    kind: 'normal',
    total: 0,
    maxAlive: 0,
    health: 1,
    speed: 1,
    damage: 1,
    interval: 1,
    burstMin: 1,
    burstMax: 1,
    typeIds,
    counts: typeIds.map(() => 0),
    placeFrom,
    placeTo,
    weights: typeIds.map(() => 0),
  };
}

/** Largest bound of a mode's spawn order (sizes the order buffers once). */
export function maxOrderLength(mode: WaveModeDef): number {
  let specials = 0;
  for (const s of mode.specials) specials += Math.max(0, s.count.max);
  const swarm = mode.swarm ? Math.ceil(mode.total.max * mode.swarm.totalMultiplier) : 0;
  return Math.max(1, mode.total.max + specials, swarm);
}

function filterWeight(mode: WaveModeDef, t: WaveTypeDef, wave: number, swarm: boolean): number {
  if (!swarm) return typeWeight(t, wave);
  // Swarm waves: the listed types regardless of unlock waves.
  return mode.swarm!.types.includes(t.id) ? typeWeight(t, Math.max(wave, t.unlockWave)) : 0;
}

/**
 * Fill `out` for wave `wave`: counts per type (specials first, fillers by weight with a
 * largest-remainder split), multipliers, cadence. `isKnown` filters types without an enemy def
 * (never queued, so a wave cannot hang on content that does not exist).
 */
export function planWave(
  mode: WaveModeDef,
  wave: number,
  capacity: number,
  out: WavePlan,
  isKnown: (type: string) => boolean = () => true,
): WavePlan {
  const w = waveNumber(wave);
  const swarm = isSwarmWave(mode, w);
  const ids = out.typeIds;
  const counts = out.counts;
  const weights = out.weights;
  for (let i = 0; i < counts.length; i++) {
    counts[i] = 0;
    weights[i] = 0;
  }
  out.wave = w;
  out.kind = swarm ? 'swarm' : 'normal';

  let specials = 0;
  if (!swarm) {
    for (const s of mode.specials) {
      const n = specialCount(s, w);
      if (n <= 0 || !isKnown(s.id)) continue;
      counts[ids.indexOf(s.id)]! += n;
      specials += n;
      if (s.announce && out.kind === 'normal') out.kind = s.id;
    }
  }

  let weightSum = 0;
  for (const t of mode.types) {
    if (!isKnown(t.id)) continue;
    const wt = filterWeight(mode, t, w, swarm);
    if (!(wt > 0)) continue;
    weights[ids.indexOf(t.id)]! += wt;
    weightSum += wt;
  }
  if (swarm) {
    // Swarm types without a filler entry weigh 1.
    for (const id of mode.swarm!.types) {
      const i = ids.indexOf(id);
      if (weights[i] === 0 && isKnown(id) && !mode.types.some((t) => t.id === id)) {
        weights[i] = 1;
        weightSum += 1;
      }
    }
  }

  const total = Math.max(waveTotal(mode, w), specials);
  const filler = weightSum > 0 ? total - specials : 0;
  let assigned = 0;
  if (filler > 0) {
    for (let i = 0; i < ids.length; i++) {
      const share = (filler * weights[i]!) / weightSum;
      const whole = Math.floor(share);
      counts[i]! += whole;
      assigned += whole;
      // Keep the fractional part for the remainder pass (-1 = not a filler this wave).
      weights[i] = weights[i]! > 0 ? share - whole : -1;
    }
    for (let r = filler - assigned; r > 0; r--) {
      let best = -1;
      for (let i = 0; i < ids.length; i++)
        if (weights[i]! >= 0 && (best < 0 || weights[i]! > weights[best]!)) best = i;
      if (best < 0) break;
      counts[best]!++;
      weights[best] = -1;
      assigned++;
    }
  }
  out.total = specials + assigned;

  out.health = waveMultiplier(mode.health, w) * (swarm ? mode.swarm!.healthMultiplier : 1);
  out.speed = waveMultiplier(mode.speed, w) * (swarm ? mode.swarm!.speedMultiplier : 1);
  out.damage = waveMultiplier(mode.damage, w);
  out.maxAlive = waveMaxAlive(mode, w, capacity);
  out.interval = spawnInterval(mode, w);
  out.burstMin = Math.max(1, mode.cadence.burst.min);
  out.burstMax = Math.max(out.burstMin, burstMax(mode, w));
  return out;
}

/**
 * Spawn order of a planned wave into `out` (type indices of plan.typeIds): fillers shuffled with
 * the seeded rng, specials spread evenly over their placement range. `scratch` must be at least as
 * long as `out`. Returns the order length.
 */
export function buildSpawnOrder(plan: WavePlan, rng: Rng, out: Uint8Array, scratch: Uint8Array): number {
  const n = Math.min(plan.total, out.length, scratch.length);
  let fillers = 0;
  for (let i = 0; i < plan.counts.length; i++) {
    if (plan.placeFrom[i]! >= 0) continue;
    for (let c = plan.counts[i]!; c > 0 && fillers < n; c--) scratch[fillers++] = i;
  }
  for (let i = fillers - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = scratch[i]!;
    scratch[i] = scratch[j]!;
    scratch[j] = tmp;
  }
  out.fill(EMPTY_SLOT, 0, n);
  for (let i = 0; i < plan.counts.length; i++) {
    const from = plan.placeFrom[i]!;
    if (from < 0) continue;
    const count = plan.counts[i]!;
    const to = plan.placeTo[i]!;
    for (let k = 0; k < count; k++) {
      const f = from + (to - from) * ((k + 0.5) / count);
      placeNear(out, n, Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))), i);
    }
  }
  let next = 0;
  for (let i = 0; i < n; i++) if (out[i] === EMPTY_SLOT) out[i] = next < fillers ? scratch[next++]! : 0;
  return n;
}

/** Put `type` into the first free slot at or after `at` (else the last free one before it). */
function placeNear(out: Uint8Array, n: number, at: number, type: number): void {
  for (let i = at; i < n; i++) {
    if (out[i] === EMPTY_SLOT) {
      out[i] = type;
      return;
    }
  }
  for (let i = at - 1; i >= 0; i--) {
    if (out[i] === EMPTY_SLOT) {
      out[i] = type;
      return;
    }
  }
}
