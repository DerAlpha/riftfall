/**
 * Achievement tracking (defs/achievements.ts): every achievement is a condition over progress
 * signals; progress (count, best run value, distinct values) persists in
 * ProfileData.achievements and an unlock calls `onUnlock` once (ProgressionSystem grants the
 * tier's reward and emits achievement:unlocked).
 *
 * Signals are dispatched through a metric index: a signal only visits the achievements of its
 * metric. Locked achievements are evaluated; unlocked ones are skipped.
 */
import type { AchievementProgressData, AchievementView } from '../core/contracts';
import { ACHIEVEMENTS, type AchievementDef } from '../defs/achievements';
import type { ProgressCondition } from '../defs/progression';
import {
  MetricIndex,
  applySignal,
  beginRunState,
  beginWaveState,
  createConditionState,
  isComplete,
  type ConditionState,
  type ProgressSignal,
} from './signals';

function lifetimeDistinct(c: ProgressCondition): boolean {
  return c.kind === 'distinct' && (c.scope ?? 'lifetime') === 'lifetime';
}

export interface AchievementHooks {
  onUnlock(def: AchievementDef): void;
}

interface Entry {
  readonly def: AchievementDef;
  readonly condition: ProgressCondition;
  state: ConditionState;
  unlockedAt: number;
}

export class AchievementTracker {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly index = new MetricIndex<Entry>();
  private store: Record<string, AchievementProgressData> = {};
  private _unlocked = 0;

  constructor(
    store: Record<string, AchievementProgressData>,
    private readonly hooks: AchievementHooks,
    private readonly now: () => number = Date.now,
    defs: readonly AchievementDef[] = ACHIEVEMENTS,
  ) {
    for (const def of defs) {
      const e: Entry = { def, condition: def.condition, state: createConditionState(), unlockedAt: 0 };
      this.entries.push(e);
      this.byId.set(def.id, e);
      this.index.add(e);
    }
    this.attach(store);
  }

  /** Bind to (another) profile's achievement data (load, `resetsave`). */
  attach(store: Record<string, AchievementProgressData>): void {
    this.store = store;
    this._unlocked = 0;
    for (const e of this.entries) {
      const saved = store[e.def.id];
      e.state = createConditionState(saved?.progress ?? 0, saved?.seen ?? []);
      // The persisted entry shares the seen list: new values reach the save without copying.
      if (saved && lifetimeDistinct(e.condition)) saved.seen = e.state.seen;
      e.unlockedAt = saved?.unlockedAt ?? 0;
      if (e.unlockedAt > 0) this._unlocked++;
    }
  }

  get unlockedCount(): number {
    return this._unlocked;
  }

  get total(): number {
    return this.entries.length;
  }

  isUnlocked(id: string): boolean {
    return (this.byId.get(id)?.unlockedAt ?? 0) > 0;
  }

  /** Returns true when persisted data changed (progress or an unlock). */
  signal(sig: ProgressSignal): boolean {
    const list = this.index.get(sig.metric);
    let dirty = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.unlockedAt > 0) continue;
      if (!applySignal(e.condition, e.state, sig)) continue;
      this.persist(e);
      dirty = true;
      if (isComplete(e.condition, e.state)) this.unlockEntry(e);
    }
    return dirty;
  }

  /**
   * Unlock achievements whose stored progress already meets the target (a target lowered by a
   * rebalance, a hand-edited save). Call once after construction / attach.
   */
  reconcile(): void {
    for (const e of this.entries) {
      if (e.unlockedAt === 0 && isComplete(e.condition, e.state)) this.unlockEntry(e);
    }
  }

  beginRun(): void {
    for (const e of this.entries) beginRunState(e.state);
  }

  beginWave(): void {
    for (const e of this.entries) beginWaveState(e.state);
  }

  /** Dev console: unlock now (progress set to the target). False when unknown or unlocked. */
  unlock(id: string): boolean {
    const e = this.byId.get(id);
    if (!e || e.unlockedAt > 0) return false;
    e.state.progress = Math.max(e.state.progress, e.condition.target);
    this.persist(e);
    this.unlockEntry(e);
    return true;
  }

  view(id: string): AchievementView | null {
    const e = this.byId.get(id);
    return e ? this.toView(e) : null;
  }

  views(): AchievementView[] {
    return this.entries.map((e) => this.toView(e));
  }

  private toView(e: Entry): AchievementView {
    const d = e.def;
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      tier: d.tier,
      category: d.category,
      hidden: d.hidden === true,
      progress: Math.min(e.state.progress, e.condition.target),
      target: e.condition.target,
      unlockedAt: e.unlockedAt,
    };
  }

  private persist(e: Entry): void {
    let saved = this.store[e.def.id];
    if (!saved) {
      saved = { progress: 0, unlockedAt: e.unlockedAt };
      if (lifetimeDistinct(e.condition)) saved.seen = e.state.seen;
      this.store[e.def.id] = saved;
    }
    saved.progress = e.state.progress;
  }

  private unlockEntry(e: Entry): void {
    e.unlockedAt = Math.max(1, Math.floor(this.now()));
    this.persist(e);
    this.store[e.def.id]!.unlockedAt = e.unlockedAt;
    this._unlocked++;
    this.hooks.onUnlock(e.def);
  }
}
