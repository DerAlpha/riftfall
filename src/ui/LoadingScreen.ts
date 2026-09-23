/**
 * Boot/loading screen. Pure DOM + CSS so it paints before any heavy module or GPU work starts.
 * Rotates German lore tips while visible; show()/hide() fade via CSS.
 */
import { clamp01 } from '../core/math';
import { LOADING } from '../defs/ui';

export class LoadingScreen {
  private readonly el: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly percent: HTMLSpanElement;
  private readonly tip: HTMLParagraphElement;
  private tipIndex: number;
  private tipTimer = 0;
  private hideTimer = 0;
  private shownPercent = -1;
  private _visible = false;

  constructor(private readonly root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'loading';
    this.el.setAttribute('role', 'progressbar');
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
    this.el.setAttribute('aria-label', 'Ladefortschritt');
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="loading__backdrop"></div>
      <div class="loading__center">
        <div class="loading__logo" data-text="RIFTFALL">RIFTFALL</div>
        <div class="loading__sub">Kalibrierungshalle – Initialisierung</div>
        <div class="loading__track"><div class="loading__bar"></div></div>
        <div class="loading__meta"><div class="loading__label"></div><span class="loading__percent"></span></div>
      </div>
      <p class="loading__tip"></p>`;
    this.bar = this.el.querySelector('.loading__bar')!;
    this.label = this.el.querySelector('.loading__label')!;
    this.percent = this.el.querySelector('.loading__percent')!;
    this.tip = this.el.querySelector('.loading__tip')!;
    this.tipIndex = Math.floor(Math.random() * LOADING.tips.length); // cosmetic only
    root.appendChild(this.el);
  }

  get visible(): boolean {
    return this._visible;
  }

  show(): void {
    window.clearTimeout(this.hideTimer);
    this._visible = true;
    this.root.classList.add('is-active');
    // Un-hiding and adding the class in one go shows it instantly (no transition from display:none),
    // so the first paint already has the full loading screen.
    this.el.hidden = false;
    this.el.classList.add('loading--visible');
    this.showTip();
    window.clearInterval(this.tipTimer);
    this.tipTimer = window.setInterval(() => this.nextTip(), LOADING.tipIntervalMs);
  }

  /**
   * accessibility.reduceFlashing: stops the stepped logo glitch (like the start screen's calm mode).
   * Called once the save is loaded; the pre-save part of the boot only has OS reduced motion.
   */
  setReducedFlashing(reduce: boolean): void {
    this.el.classList.toggle('loading--calm', reduce);
  }

  /** `fraction` 0..1; `label` is shown as the current step (German). */
  setProgress(fraction: number, label: string): void {
    const f = clamp01(Number.isFinite(fraction) ? fraction : 0);
    const pct = Math.round(f * 100);
    this.bar.style.transform = `scaleX(${f.toFixed(4)})`;
    if (pct !== this.shownPercent) {
      this.shownPercent = pct;
      this.percent.textContent = `${pct} %`;
      this.el.setAttribute('aria-valuenow', String(pct));
    }
    if (this.label.textContent !== label) this.label.textContent = label;
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    window.clearInterval(this.tipTimer);
    this.tipTimer = 0;
    this.el.classList.remove('loading--visible');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.el.hidden = true;
      this.root.classList.remove('is-active');
    }, LOADING.fadeMs);
  }

  dispose(): void {
    window.clearInterval(this.tipTimer);
    window.clearTimeout(this.hideTimer);
    this.el.remove();
    this.root.classList.remove('is-active');
  }

  private showTip(): void {
    this.tip.textContent = LOADING.tips[this.tipIndex % LOADING.tips.length] ?? '';
    this.tip.classList.remove('loading__tip--in');
    void this.tip.offsetWidth;
    this.tip.classList.add('loading__tip--in');
  }

  private nextTip(): void {
    this.tipIndex = (this.tipIndex + 1) % LOADING.tips.length;
    this.showTip();
  }
}
