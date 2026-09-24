/**
 * Progress signals and the condition evaluator shared by achievements, challenges, lifetime
 * counters and weapon camo counters (defs/progression ProgressCondition).
 *
 * A signal is a metric id + amount + tags. Conditions keep a small state:
 * - count/lifetime: progress += amount
 * - count/run, count/wave: an accumulator reset at the run / wave start; progress = best value
 * - max: progress = highest amount
 * - distinct: the set of tag values seen (lifetime: persisted; run: reset per run)
 * A condition is complete once progress ≥ target. Evaluation is allocation-free except for
 * recording a new distinct value.
 */
import type { DamageElement, HitZone, ImpactKind } from '../core/events';
import { PROGRESSION_LIMITS, type MetricId, type ProgressCondition, type SignalFilter } from '../defs/progression';

export interface SignalTags {
  map: string;
  mode: string;
  enemy: string | null;
  weapon: string | null;
  /** Weapon category, or 'grenade' / 'ability' for their blasts. */
  category: string | null;
  zone: HitZone | null;
  elite: boolean;
  element: DamageElement | null;
  kind: ImpactKind | null;
  grenade: string | null;
  ability: string | null;
  combo: string | null;
  perk: string | null;
  powerup: string | null;
  period: string | null;
  branch: string | null;
  camo: string | null;
  tier: number;
  wave: number;
}

export interface ProgressSignal {
  metric: MetricId;
  amount: number;
  tags: SignalTags;
}

export function createTags(): SignalTags {
  return {
    map: '',
    mode: '',
    enemy: null,
    weapon: null,
    category: null,
    zone: null,
    elite: false,
    element: null,
    kind: null,
    grenade: null,
    ability: null,
    combo: null,
    perk: null,
    powerup: null,
    period: null,
    branch: null,
    camo: null,
    tier: 0,
    wave: 0,
  };
}

/** Reset every per-signal tag (map, mode and wave stay: they describe the run). */
export function clearTags(t: SignalTags): SignalTags {
  t.enemy = null;
  t.weapon = null;
  t.category = null;
  t.zone = null;
  t.elite = false;
  t.element = null;
  t.kind = null;
  t.grenade = null;
  t.ability = null;
  t.combo = null;
  t.perk = null;
  t.powerup = null;
  t.period = null;
  t.branch = null;
  t.camo = null;
  t.tier = 0;
  return t;
}

export function createSignal(): ProgressSignal {
  return { metric: 'kill', amount: 0, tags: createTags() };
}

/** Independent copy (signals queued while another one is being dispatched). */
export function copySignal(s: ProgressSignal): ProgressSignal {
  return { metric: s.metric, amount: s.amount, tags: { ...s.tags } };
}

/** Every given filter field matches the signal's tags. */
export function matchesFilter(f: SignalFilter | undefined, t: SignalTags): boolean {
  if (!f) return true;
  if (f.enemy !== undefined && f.enemy !== t.enemy) return false;
  if (f.weapon !== undefined && f.weapon !== t.weapon) return false;
  if (f.category !== undefined && f.category !== t.category) return false;
  if (f.zone !== undefined && f.zone !== t.zone) return false;
  if (f.elite !== undefined && f.elite !== t.elite) return false;
  if (f.element !== undefined && f.element !== t.element) return false;
  if (f.kind !== undefined && f.kind !== t.kind) return false;
  if (f.grenade !== undefined && f.grenade !== t.grenade) return false;
  if (f.ability !== undefined && f.ability !== t.ability) return false;
  if (f.combo !== undefined && f.combo !== t.combo) return false;
  if (f.perk !== undefined && f.perk !== t.perk) return false;
  if (f.powerup !== undefined && f.powerup !== t.powerup) return false;
  if (f.map !== undefined && f.map !== t.map) return false;
  if (f.mode !== undefined && f.mode !== t.mode) return false;
  if (f.period !== undefined && f.period !== t.period) return false;
  if (f.branch !== undefined && f.branch !== t.branch) return false;
  if (f.minTier !== undefined && t.tier < f.minTier) return false;
  if (f.minWave !== undefined && t.wave < f.minWave) return false;
  return true;
}

export interface ConditionState {
  /** Persisted: lifetime count, best run/wave value, highest level, distinct count. */
  progress: number;
  run: number;
  wave: number;
  /** Distinct values (lifetime scope: persisted). */
  seen: string[];
  runSeen: string[];
}

export function createConditionState(progress = 0, seen: readonly string[] = []): ConditionState {
  return { progress, run: 0, wave: 0, seen: [...seen], runSeen: [] };
}

export function beginRunState(s: ConditionState): void {
  s.run = 0;
  s.wave = 0;
  s.runSeen.length = 0;
}

export function beginWaveState(s: ConditionState): void {
  s.wave = 0;
}

function tagValue(t: SignalTags, tag: string): string | null {
  const v = (t as unknown as Record<string, unknown>)[tag];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Apply a signal (its metric already matched `c.metric`). Returns true when the persisted
 * progress changed.
 */
export function applySignal(c: ProgressCondition, s: ConditionState, sig: ProgressSignal): boolean {
  if (!matchesFilter(c.filter, sig.tags)) return false;
  const amount = sig.amount;
  if (!(amount > 0) || !Number.isFinite(amount)) return false;
  const before = s.progress;
  switch (c.kind) {
    case 'count': {
      const scope = c.scope ?? 'lifetime';
      if (scope === 'lifetime') s.progress = Math.min(PROGRESSION_LIMITS.maxCounter, s.progress + amount);
      else if (scope === 'run') {
        s.run += amount;
        if (s.run > s.progress) s.progress = s.run;
      } else {
        s.wave += amount;
        if (s.wave > s.progress) s.progress = s.wave;
      }
      break;
    }
    case 'max':
      if (amount > s.progress) s.progress = amount;
      break;
    case 'distinct': {
      const v = tagValue(sig.tags, c.tag);
      if (v === null || (c.values && !c.values.includes(v))) return false;
      const list = (c.scope ?? 'lifetime') === 'lifetime' ? s.seen : s.runSeen;
      if (list.includes(v) || list.length >= PROGRESSION_LIMITS.maxSeen) return false;
      list.push(v);
      if (list.length > s.progress) s.progress = list.length;
      break;
    }
  }
  return s.progress !== before;
}

export function isComplete(c: ProgressCondition, s: ConditionState): boolean {
  return s.progress >= c.target;
}

/** Conditions indexed by metric (one array per metric, built once). */
export class MetricIndex<T extends { readonly condition: ProgressCondition }> {
  private readonly byMetric = new Map<string, T[]>();
  private static readonly EMPTY: readonly never[] = [];

  add(entry: T): void {
    let list = this.byMetric.get(entry.condition.metric);
    if (!list) {
      list = [];
      this.byMetric.set(entry.condition.metric, list);
    }
    list.push(entry);
  }

  get(metric: string): readonly T[] {
    return this.byMetric.get(metric) ?? MetricIndex.EMPTY;
  }

  clear(): void {
    this.byMetric.clear();
  }
}
