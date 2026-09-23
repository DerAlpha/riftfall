/**
 * Gamepad navigation for the DOM menus (#ui): D-pad up/down moves focus, left/right adjusts the
 * focused control (range, select, radio group, tabs), A activates, B goes back.
 *
 * The menus stay plain DOM/Preact: this only moves focus, clicks and nudges controls the way a
 * keyboard user would, so every menu control works without menu-specific code. Back is a
 * synthetic Escape keydown (the menus' own "back" key); when no menu handles it (it is not
 * cancelled), `onBack` runs – the pause menu resumes the game. Synthetic keys carry no `code`,
 * so InputSystem and the rebinding capture ignore them.
 */
import { MENU_GAMEPAD } from '../defs/engine';

export interface MenuPadInput {
  padButtonDown(button: number): boolean;
  padButtonPressed(button: number): boolean;
}

export type MenuNavCommand = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';
type Direction = 'up' | 'down' | 'left' | 'right';

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
/** HTML defaults of input[type=range] when an attribute is missing. */
const RANGE_DEFAULTS = { min: 0, max: 100, step: 1 } as const;

function attrNumber(value: string, fallback: number): number {
  const n = value === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Decimal places of a step value; exponent notation (tiny steps) keeps full precision. */
const MAX_DECIMALS = 12;
function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes('e')) return MAX_DECIMALS;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(MAX_DECIMALS, s.length - dot - 1);
}

export class MenuPadNavigator {
  private held: Direction | null = null;
  private holdTime = 0;
  private nextRepeat = 0;
  private _activating = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: MenuPadInput,
    private readonly onBack: () => void,
  ) {}

  /** Poll once per frame while a menu is open (after input.beginFrame). `dt` in seconds. */
  update(dt: number): void {
    const input = this.input;
    if (input.padButtonPressed(MENU_GAMEPAD.confirm)) this.command('confirm');
    if (input.padButtonPressed(MENU_GAMEPAD.back)) this.command('back');

    for (const d of DIRECTIONS) {
      if (!input.padButtonPressed(MENU_GAMEPAD[d])) continue;
      this.held = d;
      this.holdTime = 0;
      this.nextRepeat = MENU_GAMEPAD.repeatDelay;
      this.command(d);
      return;
    }
    // Holding a direction repeats it (long lists, sliders).
    if (this.held && input.padButtonDown(MENU_GAMEPAD[this.held])) {
      this.holdTime += dt;
      if (this.holdTime >= this.nextRepeat) {
        this.nextRepeat += MENU_GAMEPAD.repeatInterval;
        this.command(this.held);
      }
    } else {
      this.held = null;
    }
  }

  /**
   * True while a gamepad press is clicking a menu control. Click handlers run synchronously inside
   * it, so the game can tell a pad "Fortsetzen" (no pointer lock possible) from a mouse click.
   */
  get activating(): boolean {
    return this._activating;
  }

  /** Forget a held direction (menu closed). */
  reset(): void {
    this.held = null;
  }

  command(cmd: MenuNavCommand): void {
    switch (cmd) {
      case 'up':
        this.moveFocus(-1);
        return;
      case 'down':
        this.moveFocus(1);
        return;
      case 'left':
        this.adjust(-1);
        return;
      case 'right':
        this.adjust(1);
        return;
      case 'confirm': {
        const el = this.current();
        if (el) this.click(el);
        else this.moveFocus(1);
        return;
      }
      case 'back': {
        const target = this.current() ?? this.root;
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        // dispatchEvent returns false when a menu handled (cancelled) the Escape.
        if (target.dispatchEvent(ev)) this.onBack();
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** Focusable, visible, tab-reachable controls of the open menu in DOM order. */
  private focusables(): HTMLElement[] {
    const list: HTMLElement[] = [];
    for (const el of this.root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled) continue;
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
      if (el.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      list.push(el);
    }
    return list;
  }

  private current(): HTMLElement | null {
    const a = this.root.ownerDocument.activeElement;
    return a instanceof HTMLElement && a !== this.root && this.root.contains(a) ? a : null;
  }

  private focus(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    // Not implemented by every environment (jsdom).
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  private click(el: HTMLElement): void {
    this._activating = true;
    try {
      el.click();
    } finally {
      this._activating = false;
    }
  }

  private moveFocus(delta: 1 | -1): void {
    const list = this.focusables();
    if (list.length === 0) return;
    const cur = this.current();
    const i = cur ? list.indexOf(cur) : -1;
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    this.focus(list[next]!);
  }

  private adjust(delta: 1 | -1): void {
    const el = this.current();
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      this.stepRange(el, delta);
      return;
    }
    if (el instanceof HTMLSelectElement) {
      const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + delta));
      if (i === el.selectedIndex) return;
      el.selectedIndex = i;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el.getAttribute('role') === 'radio') {
      const group = el.closest('[role="radiogroup"]');
      const radios = group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
      const i = radios.indexOf(el);
      const next = radios[i + delta];
      if (i >= 0 && next) {
        this.focus(next);
        this.click(next);
      }
      return;
    }
    // Tabs and other widgets: the arrow key a keyboard user would press.
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: delta > 0 ? 'ArrowRight' : 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  private stepRange(el: HTMLInputElement, delta: 1 | -1): void {
    const min = attrNumber(el.min, RANGE_DEFAULTS.min);
    const max = attrNumber(el.max, RANGE_DEFAULTS.max);
    const stepAttr = attrNumber(el.step, RANGE_DEFAULTS.step);
    const step = stepAttr > 0 ? stepAttr : RANGE_DEFAULTS.step;
    const cur = attrNumber(el.value, min);
    const raw = Math.min(max, Math.max(min, cur + delta * step));
    // Snap to the step grid and strip float noise (0.1 + 0.05 → 0.15, not 0.15000000000000002).
    const snapped = Math.min(max, min + Math.round((raw - min) / step) * step);
    const value = String(Number(snapped.toFixed(decimalsOf(step))));
    if (value === el.value) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
