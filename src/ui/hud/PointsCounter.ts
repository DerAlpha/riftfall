/**
 * Points counter (bottom right, above the weapon block): big rolling number, pooled "+N" / "−N"
 * popups floating up beside it (colour by reason), a multiplier badge while Double Points runs and
 * a red flash when spending or when a purchase is refused. Text is written only when the shown
 * integer changes; popups write transform/opacity only while they live.
 */
import type { PointsReason } from '../../core/events';
import { ECONOMY_HUD } from '../../defs/ui';
import { h, restartAnim, setText } from './dom';
import {
  PointsPopupModel,
  PointsRoll,
  formatPoints,
  formatPopup,
  popupMotion,
  type PopupMotion,
} from './economyModel';

const PT = ECONOMY_HUD.points;
const PO = ECONOMY_HUD.popups;

interface PopupView {
  el: HTMLSpanElement;
  version: number;
  tone: string;
  y: number;
  x: number;
  scale: number;
  opacity: number;
}

const _motion: PopupMotion = { rise: 0, scale: 1, opacity: 1 };

export class PointsCounter {
  readonly roll = new PointsRoll();
  readonly popups = new PointsPopupModel();
  readonly el: HTMLDivElement;
  private readonly valueEl: HTMLSpanElement;
  private readonly multEl: HTMLSpanElement;
  private readonly views: PopupView[] = [];
  private shownValue = Number.NaN;
  private placeholder = true;
  private bumpPhase = false;
  private spendLeft = 0;
  private shownMult = 1;
  private reduced = false;

  /** `corner`: the bottom-right HUD corner (the counter goes on top of the weapon block). */
  constructor(corner: HTMLElement) {
    this.el = h('div', 'hud-points hud-placeholder');
    const head = h('div', 'hud-points__head', this.el);
    this.multEl = h('span', 'hud-points__mult', head);
    this.multEl.hidden = true;
    h('span', 'hud-label', head).textContent = PT.label;
    const row = h('div', 'hud-points__row', this.el);
    const pops = h('div', 'hud-pops', row);
    this.valueEl = h('span', 'hud-points__value', row);
    this.valueEl.textContent = PT.placeholder;
    for (let i = 0; i < this.popups.items.length; i++) {
      const el = h('span', 'hud-pop', pops);
      el.style.opacity = '0';
      this.views.push({
        el,
        version: -1,
        tone: '',
        y: Number.NaN,
        x: Number.NaN,
        scale: Number.NaN,
        opacity: 0,
      });
    }
    corner.prepend(this.el);
  }

  /** Balance shown right now (whole points, mid-roll value while rolling). */
  get shown(): number {
    return this.roll.shown;
  }

  configure(reduceFlashing: boolean): void {
    this.reduced = reduceFlashing;
  }

  /** economy:points (reused payload – read synchronously). delta 0 sets the total without a popup. */
  onPoints(delta: number, total: number, reason: PointsReason): void {
    const d = Number.isFinite(delta) ? Math.round(delta) : 0;
    this.setPlaceholder(false);
    this.roll.set(total, d !== 0);
    if (d === 0) {
      this.writeValue();
      return;
    }
    this.popups.push(d, reason);
    if (d < 0) this.flashSpend();
    else if (d >= PT.bumpMinDelta && !this.reduced)
      this.bumpPhase = restartAnim(this.valueEl, 'is-bump', this.bumpPhase);
  }

  /** Total without animation; null shows the placeholder. */
  setTotal(total: number | null): void {
    if (total === null || !Number.isFinite(total)) {
      this.setPlaceholder(true);
      return;
    }
    this.setPlaceholder(false);
    this.roll.set(total, false);
    this.writeValue();
  }

  /** Points multiplier badge (×2 while Double Points runs); ≤ 1 hides it. */
  setMultiplier(m: number): void {
    const v = Number.isFinite(m) ? m : 1;
    if (v === this.shownMult) return;
    this.shownMult = v;
    this.multEl.hidden = !(v > 1);
    if (v > 1) setText(this.multEl, PT.multiplier.replace('{n}', formatMultiplier(v)));
  }

  /** A purchase was refused: the number flashes red. */
  onDenied(): void {
    this.flashSpend();
  }

  update(dt: number): void {
    this.roll.update(dt);
    this.writeValue();
    if (this.spendLeft > 0) {
      this.spendLeft -= dt;
      if (this.spendLeft <= 0) this.el.classList.remove('is-spending');
    }
    this.popups.update(dt);
    const items = this.popups.items;
    for (let i = 0; i < items.length; i++) this.renderPopup(items[i]!, this.views[i]!);
  }

  /** New run: popups and flashes gone, the roll snaps to the current balance. */
  reset(): void {
    this.popups.clear();
    for (let i = 0; i < this.views.length; i++) this.renderPopup(this.popups.items[i]!, this.views[i]!);
    this.roll.set(this.roll.target, false);
    this.writeValue();
    this.spendLeft = 0;
    this.el.classList.remove('is-spending');
    this.valueEl.classList.remove('is-bump-a', 'is-bump-b');
    this.setMultiplier(1);
  }

  // -------------------------------------------------------------------------

  private setPlaceholder(on: boolean): void {
    if (on === this.placeholder) return;
    this.placeholder = on;
    this.el.classList.toggle('hud-placeholder', on);
    if (on) {
      this.shownValue = Number.NaN;
      setText(this.valueEl, PT.placeholder);
    }
  }

  private writeValue(): void {
    if (this.placeholder) return;
    const v = this.roll.shown;
    if (v === this.shownValue) return;
    this.shownValue = v;
    this.valueEl.textContent = formatPoints(v);
  }

  private flashSpend(): void {
    this.spendLeft = PT.spendFlashSeconds;
    this.el.classList.add('is-spending');
  }

  private renderPopup(p: PointsPopupModel['items'][number], v: PopupView): void {
    if (!p.active) {
      if (v.opacity !== 0) {
        v.opacity = 0;
        v.el.style.opacity = '0';
      }
      return;
    }
    if (p.version !== v.version) {
      v.version = p.version;
      v.el.textContent = formatPopup(p.amount);
      const tone = `hud-pop hud-pop--${p.tone}`;
      if (tone !== v.tone) {
        v.tone = tone;
        v.el.className = tone;
      }
    }
    const m = popupMotion(p.age, _motion);
    const y = -m.rise;
    const x = p.lane;
    const scale = this.reduced ? 1 : m.scale;
    const eps = PO.pxEpsilon;
    if (
      Math.abs(y - v.y) >= eps ||
      Math.abs(x - v.x) >= eps ||
      Math.abs(scale - v.scale) >= PO.scaleEpsilon
    ) {
      v.x = x;
      v.y = y;
      v.scale = scale;
      v.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
    const op = m.opacity;
    if (Math.abs(op - v.opacity) >= PO.opacityEpsilon || (op === 0) !== (v.opacity === 0)) {
      v.opacity = op;
      v.el.style.opacity = op.toFixed(3);
    }
  }
}

function formatMultiplier(m: number): string {
  return Number.isInteger(m) ? String(m) : m.toFixed(1).replace('.', ',');
}
