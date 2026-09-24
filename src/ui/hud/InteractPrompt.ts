/**
 * Interaction prompt (center, below the crosshair and the ammo prompt): key cap of the interact
 * binding for the active device, the interactable's German prompt and its price (red when
 * unaffordable), a hold ring around the key cap for hold interactions (seal repairs) and a
 * "Nicht genug Punkte" line + shake after a refused purchase. Fed by interact:focus (on change
 * only), setHold() per frame (quantized) and economy:purchase ok=false.
 */
import { ECONOMY_HUD } from '../../defs/ui';
import { h, restartAnim, setText, svgEl } from './dom';
import { costState, formatPoints, type CostState, type KeyCap } from './economyModel';

const PR = ECONOMY_HUD.prompt;
/** Hold ring radius in its 40×40 view box. */
const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;

export class InteractPrompt {
  readonly el: HTMLDivElement;
  private readonly rowEl: HTMLDivElement;
  private readonly keyEl: HTMLSpanElement;
  private readonly keyLabel: HTMLSpanElement;
  private readonly ringFill: SVGCircleElement;
  private readonly textEl: HTMLSpanElement;
  private readonly costEl: HTMLSpanElement;
  private readonly costValue: HTMLSpanElement;
  private readonly denyEl: HTMLDivElement;

  private focusId: string | null = null;
  private visible = false;
  private inPhase = false;
  private shakePhase = false;
  private cost: CostState = 'free';
  private capClass = '';
  private hold = false;
  private shownProgress = -1;
  private denyLeft = 0;

  constructor(layer: HTMLElement) {
    this.el = h('div', 'hud-interact', layer);
    const row = h('div', 'hud-interact__row', this.el);
    this.rowEl = row;
    this.keyEl = h('span', 'hud-key', row);
    const ring = svgEl('svg', { class: 'hud-key__ring', viewBox: '0 0 40 40', 'aria-hidden': 'true' }, this.keyEl);
    svgEl('circle', { class: 'hud-key__track', cx: 20, cy: 20, r: RING_R }, ring);
    this.ringFill = svgEl(
      'circle',
      {
        class: 'hud-key__fill',
        cx: 20,
        cy: 20,
        r: RING_R,
        'stroke-dasharray': RING_C.toFixed(2),
        'stroke-dashoffset': RING_C.toFixed(2),
      },
      ring,
    );
    this.keyLabel = h('span', 'hud-key__label', this.keyEl);
    this.textEl = h('span', 'hud-interact__text', row);
    this.costEl = h('span', 'hud-interact__cost', row);
    h('span', 'hud-interact__coin', this.costEl);
    this.costValue = h('span', 'hud-interact__price', this.costEl);
    this.costEl.hidden = true;
    this.denyEl = h('div', 'hud-interact__deny', this.el);
    this.denyEl.textContent = PR.deny;
    this.denyEl.hidden = true;
    this.el.hidden = true;
  }

  /** Focused interactable shown right now (null = none). */
  get focus(): string | null {
    return this.visible ? this.focusId : null;
  }

  get costStateShown(): CostState {
    return this.cost;
  }

  /** interact:focus (on change only). An empty prompt hides the widget. */
  setFocus(id: string | null, prompt: string | null, cost: number | null, affordable: boolean): void {
    const show = id !== null && prompt !== null && prompt !== '';
    if (!show) {
      this.focusId = null;
      this.setVisible(false);
      this.setDeny(0);
      return;
    }
    if (id !== this.focusId || !this.visible) {
      // A new focus slides in; the denial belongs to the previous one.
      this.inPhase = restartAnim(this.el, 'is-in', this.inPhase);
      this.setDeny(0);
    }
    this.focusId = id;
    setText(this.textEl, prompt);
    const state = costState(cost, affordable);
    if (state !== this.cost) {
      this.cost = state;
      this.costEl.hidden = state === 'free';
      this.costEl.classList.toggle('is-short', state === 'short');
    }
    if (state !== 'free' && cost !== null) setText(this.costValue, formatPoints(cost));
    this.setVisible(true);
  }

  /** Key cap of the interact binding for the active device. */
  setKeyCap(cap: KeyCap): void {
    setText(this.keyLabel, cap.label);
    const cls = `hud-key${cap.pad ? ' is-pad' : ''}${cap.face ? ` hud-key--${cap.face}` : ''}${
      cap.label.length > 2 ? ' is-wide' : ''
    }${this.hold ? ' is-hold' : ''}`;
    if (cls !== this.capClass) {
      this.capClass = cls;
      this.keyEl.className = cls;
    }
  }

  /** Per frame: hold progress 0..1 of the focus; `hold` = it is a hold interaction (ring track). */
  setHold(progress: number, hold: boolean): void {
    if (hold !== this.hold) {
      this.hold = hold;
      this.keyEl.classList.toggle('is-hold', hold);
      if (this.capClass) this.capClass = this.keyEl.className;
    }
    const q = PR.holdQuantum;
    const p = hold && Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) / q) * q : 0;
    if (p === this.shownProgress) return;
    this.shownProgress = p;
    this.ringFill.setAttribute('stroke-dashoffset', (RING_C * (1 - p)).toFixed(2));
  }

  /** A purchase was refused: "Nicht genug Punkte" + shake. */
  onDenied(): void {
    if (!this.visible) return;
    this.setDeny(PR.denySeconds);
    this.shakePhase = restartAnim(this.rowEl, 'is-deny', this.shakePhase);
  }

  update(dt: number): void {
    if (this.denyLeft > 0) {
      this.denyLeft -= dt;
      if (this.denyLeft <= 0) this.setDeny(0);
    }
  }

  reset(): void {
    this.focusId = null;
    this.setVisible(false);
    this.setDeny(0);
    this.setHold(0, false);
  }

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.hidden = !v;
  }

  private setDeny(seconds: number): void {
    this.denyLeft = seconds;
    const on = seconds > 0;
    this.denyEl.hidden = !on;
    if (!on) this.rowEl.classList.remove('is-deny-a', 'is-deny-b');
  }
}
