/**
 * Points balance (EconomyApi). Earnings are scaled by the pointsMultiplier stat (perks, Double
 * Points) and rounded to whole points; spending is all-or-nothing (the balance never goes below 0);
 * refunds and dev grants are never scaled (ECONOMY.unscaledReasons). A refund (reason 'refund')
 * undoes its purchase in the run totals instead of counting as earnings.
 *
 * Events: `economy:points` for every balance change (delta 0 on reset: the HUD shows the new total
 * without a popup) and `economy:purchase` for every spend attempt (ok=false when unaffordable). The
 * economy:points payload is reused (hit points arrive several times per tick): copy what you keep.
 */
import type { EconomyApi, StatsApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, PointsReason, PurchaseKind, Vec3Like } from '../core/events';
import { ECONOMY } from '../defs/economy';

export interface EconomyDeps {
  events: EventBus<GameEvents>;
  /** pointsMultiplier source; null = ×1. Also settable later (setStats). */
  stats?: Pick<StatsApi, 'value'> | null;
}

export interface EconomyTotals {
  /** Points credited this run (after multipliers, without the start points). */
  earned: number;
  spent: number;
  purchases: number;
}

/** Round an earning to whole points (ECONOMY.roundTo steps). */
export function roundPoints(v: number, step: number = ECONOMY.roundTo): number {
  if (!Number.isFinite(v)) return 0;
  return step > 0 ? Math.round(v / step) * step : Math.round(v);
}

export class EconomySystem implements EconomyApi {
  private readonly events: EventBus<GameEvents>;
  private stats: Pick<StatsApi, 'value'> | null;
  private _points: number;
  private readonly _totals: EconomyTotals = { earned: 0, spent: 0, purchases: 0 };
  private readonly pointsPayload: GameEvents['economy:points'] = { delta: 0, total: 0, reason: 'dev' };
  private readonly positionScratch: Vec3Like = { x: 0, y: 0, z: 0 };

  constructor(deps: EconomyDeps, startPoints: number = ECONOMY.startPoints) {
    this.events = deps.events;
    this.stats = deps.stats ?? null;
    this._points = sanitizeStart(startPoints);
  }

  get points(): number {
    return this._points;
  }

  /** Run totals (reused object). */
  get totals(): Readonly<EconomyTotals> {
    return this._totals;
  }

  setStats(stats: Pick<StatsApi, 'value'> | null): void {
    this.stats = stats;
  }

  /** Current earnings multiplier (pointsMultiplier stat). */
  get multiplier(): number {
    const m = this.stats ? this.stats.value('pointsMultiplier') : 1;
    return m >= 0 && Number.isFinite(m) ? m : 1;
  }

  earn(amount: number, reason: PointsReason, position?: Vec3Like): number {
    if (!(amount > 0) || !Number.isFinite(amount)) return 0;
    const scaled = ECONOMY.unscaledReasons.includes(reason) ? amount : amount * this.multiplier;
    const credited = roundPoints(scaled);
    if (credited <= 0) return 0;
    this._points += credited;
    if (reason === 'refund') this.undoSpend(credited);
    else this._totals.earned += credited;
    this.emitPoints(credited, reason, position);
    return credited;
  }

  spend(cost: number, item: string, kind: PurchaseKind): boolean {
    const valid = cost >= 0 && Number.isFinite(cost);
    const price = valid ? Math.round(cost) : 0;
    const ok = valid && this._points >= price;
    if (ok && price > 0) {
      this._points -= price;
      this._totals.spent += price;
      this.emitPoints(-price, 'purchase');
    }
    if (ok) this._totals.purchases++;
    this.events.emit('economy:purchase', { item, kind, cost: price, ok });
    return ok;
  }

  canAfford(cost: number): boolean {
    return cost >= 0 && Number.isFinite(cost) && this._points >= Math.round(cost);
  }

  /**
   * Unscaled balance change that may go negative (dev console `points -500`); the balance is
   * clamped at 0. Returns the applied delta.
   */
  adjust(delta: number, reason: PointsReason = 'dev'): number {
    if (!Number.isFinite(delta)) return 0;
    const next = Math.max(0, this._points + Math.round(delta));
    const applied = next - this._points;
    if (applied === 0) return 0;
    this._points = next;
    if (applied > 0) this._totals.earned += applied;
    this.emitPoints(applied, reason);
    return applied;
  }

  reset(startPoints: number = ECONOMY.startPoints): void {
    this._points = sanitizeStart(startPoints);
    this._totals.earned = 0;
    this._totals.spent = 0;
    this._totals.purchases = 0;
    this.emitPoints(0, 'dev');
  }

  /** Emit the current total (HUD init). */
  announce(): void {
    this.emitPoints(0, 'dev');
  }

  /** A refund takes its purchase back out of the run totals (a moved box is no purchase). */
  private undoSpend(amount: number): void {
    const t = this._totals;
    const undo = Math.min(amount, t.spent);
    t.spent -= undo;
    t.earned += amount - undo;
    if (undo > 0 && t.purchases > 0) t.purchases--;
  }

  private emitPoints(delta: number, reason: PointsReason, position?: Vec3Like): void {
    const p = this.pointsPayload;
    p.delta = delta;
    p.total = this._points;
    p.reason = reason;
    if (position) {
      const s = this.positionScratch;
      s.x = position.x;
      s.y = position.y;
      s.z = position.z;
      p.position = s;
    } else p.position = undefined;
    this.events.emit('economy:points', p);
  }
}

function sanitizeStart(v: number): number {
  return v >= 0 && Number.isFinite(v) ? Math.round(v) : ECONOMY.startPoints;
}
