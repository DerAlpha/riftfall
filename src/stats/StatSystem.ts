/**
 * Named gameplay stats with modifiers (StatsApi). value = clamp((base + Σadd) × Πmul, min, max),
 * integer stats rounded down (defs/stats.ts). Values are recomputed from scratch whenever a stat's
 * modifiers change (never incremental: removing a source restores the exact previous value) and
 * cached, so `value()` is a map lookup.
 *
 * `version` increments once per call that changed at least one value; consumers cache what they
 * derive from stats and compare the version per tick instead of re-reading. Every such call emits
 * one `stats:changed` with the ids whose value changed; `batch()` merges several calls (a perk
 * grant adding five modifiers) into one version step and one event.
 *
 * Modifiers for unknown stat ids or with non-finite values are ignored with a warning (never crash
 * on content).
 */
import type { StatId, StatModifier, StatsApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createLogger } from '../core/log';
import { STAT_DEFS, type StatDef } from '../defs/stats';

const log = createLogger('stats');

/** Modifier as stored (a copy: callers may reuse their objects). */
interface StoredModifier extends StatModifier {
  readonly source: string;
  readonly stat: StatId;
  readonly op: 'add' | 'mul';
  readonly value: number;
}

interface StatEntry {
  readonly id: StatId;
  readonly def: StatDef;
  readonly mods: StoredModifier[];
  value: number;
}

export interface StatSystemDeps {
  /** stats:changed target; optional (pure tests). */
  events?: EventBus<GameEvents> | null;
  /** Stat table override (tests, mods). Default: defs/stats STAT_DEFS. */
  defs?: Readonly<Record<string, StatDef>>;
}

/** Pure stat formula (exported for tests and UI previews). */
export function computeStat(def: StatDef, mods: readonly StatModifier[]): number {
  let add = 0;
  let mul = 1;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i]!;
    if (m.op === 'add') add += m.value;
    else mul *= m.value;
  }
  let v = (def.base + add) * mul;
  if (!Number.isFinite(v)) v = def.base;
  v = Math.min(def.max, Math.max(def.min, v));
  // Float noise (3 × 0.1 …) must not cost an integer stat a whole point.
  return def.integer ? Math.floor(v + 1e-9) : v;
}

/** value / base for absolute stats (1 when the base is 0 or the stat is missing). */
export function statRatio(stats: Pick<StatsApi, 'value' | 'base'>, stat: StatId): number {
  const base = stats.base(stat);
  if (!(base > 0)) return 1;
  const r = stats.value(stat) / base;
  return Number.isFinite(r) ? r : 1;
}

export class StatSystem implements StatsApi {
  private _version = 0;
  private readonly entries = new Map<StatId, StatEntry>();
  private readonly sources = new Map<string, StoredModifier[]>();
  private readonly events: EventBus<GameEvents> | null;
  private readonly changed = new Set<StatId>();
  private readonly warned = new Set<string>();
  private batchDepth = 0;

  constructor(deps: StatSystemDeps = {}) {
    this.events = deps.events ?? null;
    const defs: Readonly<Record<string, StatDef>> = deps.defs ?? STAT_DEFS;
    for (const id of Object.keys(defs)) {
      const def = defs[id]!;
      this.entries.set(id, { id, def, mods: [], value: computeStat(def, []) });
    }
  }

  get version(): number {
    return this._version;
  }

  value(stat: StatId): number {
    const e = this.entries.get(stat);
    if (e) return e.value;
    this.warnOnce(stat, `Unknown stat "${stat}" read as 0`);
    return 0;
  }

  base(stat: StatId): number {
    return this.entries.get(stat)?.def.base ?? 0;
  }

  def(stat: StatId): StatDef | undefined {
    return this.entries.get(stat)?.def;
  }

  /** Stat ids in table order. */
  get ids(): readonly StatId[] {
    return [...this.entries.keys()];
  }

  /** Modifiers currently affecting `stat` (copies as stored; do not mutate). */
  modifiers(stat: StatId): readonly StatModifier[] {
    return this.entries.get(stat)?.mods ?? [];
  }

  /** Stats whose value differs from their base (dev console `stats`, run summary). */
  modified(): StatId[] {
    const out: StatId[] = [];
    for (const e of this.entries.values()) if (e.value !== computeStat(e.def, [])) out.push(e.id);
    return out;
  }

  /** Source ids with at least one modifier. */
  get activeSources(): readonly string[] {
    return [...this.sources.keys()];
  }

  addModifier(mod: StatModifier): void {
    const e = this.entries.get(mod.stat);
    if (!e) {
      this.warnOnce(`mod:${mod.stat}`, `Modifier of "${mod.source}" for unknown stat "${mod.stat}" ignored`);
      return;
    }
    if (!Number.isFinite(mod.value) || (mod.op !== 'add' && mod.op !== 'mul')) {
      log.warn(`Invalid modifier of "${mod.source}" on "${mod.stat}" ignored`, mod);
      return;
    }
    const stored: StoredModifier = { source: mod.source, stat: mod.stat, op: mod.op, value: mod.value };
    e.mods.push(stored);
    let list = this.sources.get(mod.source);
    if (!list) {
      list = [];
      this.sources.set(mod.source, list);
    }
    list.push(stored);
    this.recompute(e);
    this.flush();
  }

  removeSource(source: string): void {
    const list = this.sources.get(source);
    if (!list) return;
    this.sources.delete(source);
    this.batch(() => {
      for (const m of list) {
        const e = this.entries.get(m.stat);
        if (!e) continue;
        const i = e.mods.indexOf(m);
        if (i >= 0) e.mods.splice(i, 1);
        this.recompute(e);
      }
    });
  }

  hasSource(source: string): boolean {
    return this.sources.has(source);
  }

  /** Replace every modifier of `source` in one step (stacking buffs): one version bump, one event. */
  setSource(source: string, mods: readonly Omit<StatModifier, 'source'>[]): void {
    this.batch(() => {
      this.removeSource(source);
      for (const m of mods) this.addModifier({ source, stat: m.stat, op: m.op, value: m.value });
    });
  }

  reset(): void {
    if (this.sources.size === 0) return;
    this.sources.clear();
    this.batch(() => {
      for (const e of this.entries.values()) {
        if (e.mods.length === 0) continue;
        e.mods.length = 0;
        this.recompute(e);
      }
    });
  }

  /** Run `fn` with change notifications merged: one version step and one stats:changed at the end. */
  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      this.flush();
    }
  }

  private recompute(e: StatEntry): void {
    const v = computeStat(e.def, e.mods);
    if (v === e.value) return;
    e.value = v;
    this.changed.add(e.id);
  }

  private flush(): void {
    if (this.batchDepth > 0 || this.changed.size === 0) return;
    this._version++;
    // A fresh array per change (rare: perk grants, buff stacks): a handler that changes stats again
    // must not rewrite the list the remaining handlers of this emit still read.
    const stats = [...this.changed];
    this.changed.clear();
    this.events?.emit('stats:changed', { stats });
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(msg);
  }
}
