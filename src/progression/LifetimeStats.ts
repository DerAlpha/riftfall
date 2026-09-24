/**
 * Lifetime statistics (ProfileData.lifetimeStats): a per-run record fed by progress signals while
 * a run is recorded, committed into the lifetime totals when the run ends (run:over) – or when a
 * new run starts before the old one ended (restart from the console: counted, no death).
 *
 * Counters follow defs/progression LIFETIME_COUNTERS (metric + filter); kills are also broken
 * down per enemy type and per weapon (favourite weapon = most kills); the highest wave and best
 * score are kept per `${mapId}:${modeId}`. Queries: accuracy, favourite weapon, highest wave.
 */
import type { LifetimeStatsData, LifetimeStatsView } from '../core/contracts';
import {
  LIFETIME_COUNTERS,
  LIFETIME_COUNTER_IDS,
  PROGRESSION_LIMITS,
  TIME_PLAYED_COUNTER,
  boardKey,
  type LifetimeCounterId,
} from '../defs/progression';
import { matchesFilter, type ProgressSignal } from './signals';

/** What the run end adds besides the counted signals. */
export interface RunCommitInfo {
  mapId: string;
  mode: string;
  wave: number;
  score: number;
  timeSurvived: number;
  /** The player died (run:over), false for a run replaced before it ended. */
  died: boolean;
}

const COUNTER_INDEX: ReadonlyMap<string, readonly number[]> = (() => {
  const m = new Map<string, number[]>();
  LIFETIME_COUNTER_IDS.forEach((id, i) => {
    const metric = LIFETIME_COUNTERS[id].metric;
    let list = m.get(metric);
    if (!list) {
      list = [];
      m.set(metric, list);
    }
    list.push(i);
  });
  return m;
})();

const NONE: readonly number[] = [];

function bump(map: Record<string, number>, key: string, amount: number): void {
  if (!(key in map) && Object.keys(map).length >= PROGRESSION_LIMITS.maxMapKeys) return;
  map[key] = Math.min(PROGRESSION_LIMITS.maxCounter, (map[key] ?? 0) + amount);
}

export class LifetimeStats implements LifetimeStatsView {
  private data!: LifetimeStatsData;
  /** Run record (index = LIFETIME_COUNTER_IDS order). */
  private readonly run = new Float64Array(LIFETIME_COUNTER_IDS.length);
  private readonly runKillsByEnemy = new Map<string, number>();
  private readonly runKillsByWeapon = new Map<string, number>();
  private _recording = false;

  constructor(data: LifetimeStatsData) {
    this.attach(data);
  }

  attach(data: LifetimeStatsData): void {
    this.data = data;
  }

  get recording(): boolean {
    return this._recording;
  }

  /** Start a fresh run record. */
  beginRun(): void {
    this.run.fill(0);
    this.runKillsByEnemy.clear();
    this.runKillsByWeapon.clear();
    this._recording = true;
  }

  signal(sig: ProgressSignal): void {
    if (!this._recording) return;
    const list = COUNTER_INDEX.get(sig.metric) ?? NONE;
    for (let i = 0; i < list.length; i++) {
      const idx = list[i]!;
      const def = LIFETIME_COUNTERS[LIFETIME_COUNTER_IDS[idx]!];
      if ('filter' in def && !matchesFilter(def.filter, sig.tags)) continue;
      this.run[idx] = this.run[idx]! + sig.amount;
    }
    if (sig.metric === 'kill') {
      const t = sig.tags;
      if (t.enemy) this.runKillsByEnemy.set(t.enemy, (this.runKillsByEnemy.get(t.enemy) ?? 0) + sig.amount);
      if (t.weapon)
        this.runKillsByWeapon.set(t.weapon, (this.runKillsByWeapon.get(t.weapon) ?? 0) + sig.amount);
    }
  }

  /** Current run's value of a counter (run summary, tests). */
  runValue(id: LifetimeCounterId): number {
    const i = LIFETIME_COUNTER_IDS.indexOf(id);
    return i >= 0 ? this.run[i]! : 0;
  }

  /** Merge the run record into the lifetime totals and stop recording. */
  commit(info: RunCommitInfo): void {
    if (!this._recording) return;
    this._recording = false;
    const c = this.data.counters;
    for (let i = 0; i < LIFETIME_COUNTER_IDS.length; i++) {
      const v = this.run[i]!;
      if (v > 0) bump(c, LIFETIME_COUNTER_IDS[i]!, v);
    }
    // runEnd / death arrive as signals from the run end; a replaced run adds neither.
    if (info.timeSurvived > 0 && Number.isFinite(info.timeSurvived))
      bump(c, TIME_PLAYED_COUNTER, info.timeSurvived);
    for (const [k, v] of this.runKillsByEnemy) bump(this.data.killsByEnemy, k, v);
    for (const [k, v] of this.runKillsByWeapon) bump(this.data.killsByWeapon, k, v);
    const key = boardKey(info.mapId, info.mode);
    if (info.wave > 0) setMax(this.data.highestWave, key, Math.floor(info.wave));
    if (info.score > 0) setMax(this.data.bestScore, key, Math.floor(info.score));
  }

  // --- LifetimeStatsView ---

  get counters(): Readonly<Record<string, number>> {
    return this.data.counters;
  }

  get killsByEnemy(): Readonly<Record<string, number>> {
    return this.data.killsByEnemy;
  }

  get killsByWeapon(): Readonly<Record<string, number>> {
    return this.data.killsByWeapon;
  }

  /** Highest wave per `${mapId}:${modeId}`. */
  get highestWaves(): Readonly<Record<string, number>> {
    return this.data.highestWave;
  }

  get accuracy(): number {
    return accuracy(this.data.counters.shotsFired ?? 0, this.data.counters.shotsHit ?? 0);
  }

  get favouriteWeapon(): string | null {
    return favourite(this.data.killsByWeapon);
  }

  highestWave(mapId: string, mode?: string): number {
    return this.data.highestWave[boardKey(mapId, mode)] ?? 0;
  }

  bestScore(mapId: string, mode?: string): number {
    return this.data.bestScore[boardKey(mapId, mode)] ?? 0;
  }
}

function setMax(map: Record<string, number>, key: string, value: number): void {
  if (!(key in map) && Object.keys(map).length >= PROGRESSION_LIMITS.maxBoards) return;
  if (value > (map[key] ?? 0)) map[key] = value;
}

/** Shots that hit / shots fired (0..1, 0 without shots). */
export function accuracy(fired: number, hit: number): number {
  if (!(fired > 0)) return 0;
  return Math.min(1, Math.max(0, hit / fired));
}

/** Key with the highest count (ties: the first in key order), null when empty. */
export function favourite(counts: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const k of Object.keys(counts)) {
    const n = counts[k]!;
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}
