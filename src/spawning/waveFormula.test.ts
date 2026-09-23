import { describe, expect, it } from 'vitest';
import { Rng } from '../core/Rng';
import { ENEMIES } from '../defs/enemies';
import { WAVES, type WaveModeDef } from '../defs/waves';
import {
  baseWaveTotal,
  buildSpawnOrder,
  burstMax,
  createWavePlan,
  isSwarmWave,
  maxOrderLength,
  planWave,
  spawnInterval,
  specialCount,
  typeWeight,
  waveMaxAlive,
  waveMultiplier,
  waveTotal,
  waveTypes,
} from './waveFormula';

const M: WaveModeDef = WAVES.classic;
const WAVES_TESTED = 60;

describe('wave formula', () => {
  it('grows the enemy count monotonically up to the cap', () => {
    let prev = 0;
    for (let w = 1; w <= WAVES_TESTED; w++) {
      const t = baseWaveTotal(M, w);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(M.total.max);
      prev = t;
    }
    expect(baseWaveTotal(M, 1)).toBe(M.total.base);
    expect(baseWaveTotal(M, 2)).toBeGreaterThan(baseWaveTotal(M, 1));
    expect(baseWaveTotal(M, 500)).toBe(M.total.max);
    // Garbage in: wave 1.
    expect(baseWaveTotal(M, Number.NaN)).toBe(M.total.base);
    expect(baseWaveTotal(M, -3)).toBe(M.total.base);
  });

  it('keeps multipliers monotonic, starting at 1 and capped', () => {
    for (const def of [M.health, M.speed, M.damage]) {
      expect(waveMultiplier(def, 1)).toBe(1);
      let prev = 0;
      for (let w = 1; w <= WAVES_TESTED * 2; w++) {
        const v = waveMultiplier(def, w);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v).toBeLessThanOrEqual(def.max);
        prev = v;
      }
    }
    expect(waveMultiplier(M.health, 1000)).toBe(M.health.max);
    // Past the knee the growth compounds.
    const knee = M.health.knee;
    expect(waveMultiplier(M.health, knee + 1)).toBeCloseTo(waveMultiplier(M.health, knee) * M.health.growth);
  });

  it('raises max alive from 24 to the 60 enemy budget, never above capacity', () => {
    expect(waveMaxAlive(M, 1, 64)).toBe(24);
    let prev = 0;
    for (let w = 1; w <= WAVES_TESTED; w++) {
      const v = waveMaxAlive(M, w, 64);
      if (!isSwarmWave(M, w)) {
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
      expect(v).toBeLessThanOrEqual(60);
    }
    expect(waveMaxAlive(M, 40, 64)).toBe(60);
    expect(waveMaxAlive(M, 40, 32)).toBe(32);
  });

  it('spawns faster and in bigger bursts later, within the caps', () => {
    expect(spawnInterval(M, 1)).toBeCloseTo(M.cadence.interval.base);
    expect(spawnInterval(M, 10)).toBeLessThan(spawnInterval(M, 2));
    expect(spawnInterval(M, 100)).toBeCloseTo(M.cadence.interval.min);
    expect(burstMax(M, 1)).toBe(M.cadence.burst.max);
    expect(burstMax(M, 100)).toBe(M.cadence.burst.cap);
    // Swarm waves: faster cadence, bigger groups.
    const sw = M.swarm!.firstWave;
    expect(spawnInterval(M, sw)).toBeLessThan(spawnInterval(M, sw - 1));
    expect(burstMax(M, sw)).toBeGreaterThan(burstMax(M, sw - 1));
  });

  it('unlocks swarmers from wave 1, spitters from wave 3 and the first tank on wave 5', () => {
    expect(waveTypes(M, 1)).toEqual(['swarmer']);
    expect(waveTypes(M, 2)).toEqual(['swarmer']);
    expect(waveTypes(M, 3)).toEqual(['swarmer', 'spitter']);
    expect(waveTypes(M, 4)).toEqual(['swarmer', 'spitter']);
    expect(waveTypes(M, 5)).toEqual(['swarmer', 'spitter', 'tank']);
    const spitter = M.types.find((t) => t.id === 'spitter')!;
    expect(typeWeight(spitter, 2)).toBe(0);
    expect(typeWeight(spitter, 3)).toBeCloseTo(spitter.weight.base);
    expect(typeWeight(spitter, 200)).toBe(spitter.weight.max);
  });

  it('schedules tanks every few waves with a growing, capped count', () => {
    const tank = M.specials.find((s) => s.id === 'tank')!;
    const tankWaves: number[] = [];
    for (let w = 1; w <= 30; w++) if (specialCount(tank, w) > 0) tankWaves.push(w);
    expect(tankWaves[0]).toBe(5);
    for (let i = 1; i < tankWaves.length; i++) expect(tankWaves[i]! - tankWaves[i - 1]!).toBe(tank.every);
    expect(specialCount(tank, 5)).toBe(1);
    let prev = 0;
    for (const w of tankWaves) {
      expect(specialCount(tank, w)).toBeGreaterThanOrEqual(prev);
      prev = specialCount(tank, w);
    }
    expect(specialCount(tank, 5 + tank.every * 100)).toBe(tank.count.max);
  });

  it('makes every Nth wave a swarm wave: swarmers only, more of them, no tanks', () => {
    const s = M.swarm!;
    expect(isSwarmWave(M, s.firstWave)).toBe(true);
    expect(isSwarmWave(M, s.firstWave + s.every)).toBe(true);
    expect(isSwarmWave(M, s.firstWave + 1)).toBe(false);
    expect(isSwarmWave(M, s.firstWave - 1)).toBe(false);
    const w = s.firstWave;
    expect(waveTypes(M, w)).toEqual(['swarmer']);
    expect(waveTotal(M, w)).toBe(Math.round(baseWaveTotal(M, w) * s.totalMultiplier));
    const plan = planWave(M, w, 64, createWavePlan(M));
    expect(plan.kind).toBe('swarm');
    expect(plan.counts[plan.typeIds.indexOf('swarmer')]).toBe(plan.total);
    expect(plan.health).toBeCloseTo(waveMultiplier(M.health, w) * s.healthMultiplier);
  });
});

describe('wave plan', () => {
  it('splits the total between the unlocked types (largest remainder), tanks on top', () => {
    const plan = createWavePlan(M);
    for (let w = 1; w <= WAVES_TESTED; w++) {
      planWave(M, w, 64, plan);
      const sum = plan.counts.reduce((a, b) => a + b, 0);
      expect(sum).toBe(plan.total);
      expect(plan.total).toBe(Math.max(waveTotal(M, w), plan.counts[plan.typeIds.indexOf('tank')]!));
      for (let i = 0; i < plan.typeIds.length; i++) {
        if (!waveTypes(M, w).includes(plan.typeIds[i]!)) expect(plan.counts[i], `${w}`).toBe(0);
      }
    }
    planWave(M, 5, 64, plan);
    expect(plan.kind).toBe('tank');
    expect(plan.counts[plan.typeIds.indexOf('tank')]).toBe(1);
    const spit = plan.counts[plan.typeIds.indexOf('spitter')]!;
    const swarm = plan.counts[plan.typeIds.indexOf('swarmer')]!;
    expect(spit).toBeGreaterThan(0);
    expect(swarm).toBeGreaterThan(spit);
    planWave(M, 4, 64, plan);
    expect(plan.kind).toBe('normal');
  });

  it('never queues types without an enemy def', () => {
    const plan = createWavePlan(M);
    planWave(M, 5, 64, plan, (t) => t !== 'tank' && t !== 'spitter');
    expect(plan.counts[plan.typeIds.indexOf('tank')]).toBe(0);
    expect(plan.counts[plan.typeIds.indexOf('spitter')]).toBe(0);
    expect(plan.kind).toBe('normal');
    expect(plan.total).toBe(waveTotal(M, 5));
    planWave(M, 5, 64, plan, () => false);
    expect(plan.total).toBe(0);
  });

  it('references only enemy types that exist', () => {
    for (const id of createWavePlan(M).typeIds) expect(Object.keys(ENEMIES)).toContain(id);
  });
});

describe('spawn order', () => {
  it('contains exactly the planned counts, deterministic per seed', () => {
    const plan = planWave(M, 11, 64, createWavePlan(M));
    const len = maxOrderLength(M);
    const a = new Uint8Array(len);
    const b = new Uint8Array(len);
    const scratch = new Uint8Array(len);
    const n = buildSpawnOrder(plan, new Rng('order'), a, scratch);
    expect(n).toBe(plan.total);
    const counts = plan.typeIds.map(() => 0);
    for (let i = 0; i < n; i++) counts[a[i]!]!++;
    expect(counts).toEqual(plan.counts);
    buildSpawnOrder(plan, new Rng('order'), b, scratch);
    expect([...b.subarray(0, n)]).toEqual([...a.subarray(0, n)]);
    buildSpawnOrder(plan, new Rng('other'), b, scratch);
    expect([...b.subarray(0, n)]).not.toEqual([...a.subarray(0, n)]);
  });

  it('spreads tanks over their placement range, never first', () => {
    const plan = planWave(M, 17, 64, createWavePlan(M));
    const tank = plan.typeIds.indexOf('tank');
    const tanks = plan.counts[tank]!;
    expect(tanks).toBeGreaterThan(1);
    const len = maxOrderLength(M);
    const out = new Uint8Array(len);
    const n = buildSpawnOrder(plan, new Rng('tanks'), out, new Uint8Array(len));
    const positions: number[] = [];
    for (let i = 0; i < n; i++) if (out[i] === tank) positions.push(i / (n - 1));
    expect(positions.length).toBe(tanks);
    const [from, to] = M.specials[0]!.placement;
    for (const p of positions) {
      expect(p).toBeGreaterThanOrEqual(from - 0.02);
      expect(p).toBeLessThanOrEqual(to + 0.02);
    }
  });

  it('fits the largest wave into the preallocated buffers', () => {
    const len = maxOrderLength(M);
    const plan = createWavePlan(M);
    for (let w = 1; w <= 200; w++) expect(planWave(M, w, 64, plan).total).toBeLessThanOrEqual(len);
  });
});
