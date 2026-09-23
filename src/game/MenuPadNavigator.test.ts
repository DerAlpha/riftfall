// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU_GAMEPAD } from '../defs/engine';
import { MenuPadNavigator, type MenuPadInput } from './MenuPadNavigator';

class FakePad implements MenuPadInput {
  readonly down = new Set<number>();
  readonly edges = new Set<number>();
  padButtonDown(b: number): boolean {
    return this.down.has(b);
  }
  padButtonPressed(b: number): boolean {
    return this.edges.has(b);
  }
  /** Press (and hold) a button for one frame of the navigator. */
  press(nav: MenuPadNavigator, b: number, dt = 1 / 60): void {
    this.down.add(b);
    this.edges.add(b);
    nav.update(dt);
    this.edges.clear();
  }
  release(b: number): void {
    this.down.delete(b);
  }
}

describe('MenuPadNavigator', () => {
  let root: HTMLElement;
  let pad: FakePad;
  let onBack: ReturnType<typeof vi.fn<() => void>>;
  let nav: MenuPadNavigator;

  beforeEach(() => {
    root = document.createElement('div');
    root.innerHTML = `
      <button id="resume">Fortsetzen</button>
      <button id="skip" tabindex="-1">roving tab</button>
      <button id="off" disabled>aus</button>
      <div hidden><button id="hidden">versteckt</button></div>
      <input id="range" type="range" min="0.1" max="8" step="0.05" value="1" />
      <div role="radiogroup"><button id="r1" role="radio">A</button><button id="r2" role="radio">B</button></div>
      <select id="sel"><option>x</option><option>y</option></select>
      <button id="settings">Einstellungen</button>`;
    document.body.appendChild(root);
    pad = new FakePad();
    onBack = vi.fn<() => void>();
    nav = new MenuPadNavigator(root, pad, onBack);
  });

  afterEach(() => root.remove());

  const focused = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';

  it('moves focus over reachable controls only and wraps around', () => {
    pad.press(nav, MENU_GAMEPAD.down);
    expect(focused()).toBe('resume');
    pad.release(MENU_GAMEPAD.down);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      pad.press(nav, MENU_GAMEPAD.down);
      pad.release(MENU_GAMEPAD.down);
      order.push(focused());
    }
    expect(order).toEqual(['range', 'r1', 'r2', 'sel', 'settings', 'resume']);
    pad.press(nav, MENU_GAMEPAD.up);
    expect(focused()).toBe('settings');
  });

  it('A clicks the focused control and flags the activation as a gamepad one', () => {
    const btn = root.querySelector<HTMLButtonElement>('#resume')!;
    let during = false;
    btn.addEventListener('click', () => (during = nav.activating));
    btn.focus();
    pad.press(nav, MENU_GAMEPAD.confirm);
    expect(during).toBe(true);
    expect(nav.activating).toBe(false);
  });

  it('left/right step a range input on its grid and fire input events', () => {
    const range = root.querySelector<HTMLInputElement>('#range')!;
    const values: string[] = [];
    range.addEventListener('input', () => values.push(range.value));
    range.focus();
    pad.press(nav, MENU_GAMEPAD.right);
    pad.release(MENU_GAMEPAD.right);
    pad.press(nav, MENU_GAMEPAD.left);
    pad.release(MENU_GAMEPAD.left);
    pad.press(nav, MENU_GAMEPAD.left);
    expect(values).toEqual(['1.05', '1', '0.95']);
  });

  it('holding a direction repeats after the delay', () => {
    const range = root.querySelector<HTMLInputElement>('#range')!;
    range.focus();
    pad.press(nav, MENU_GAMEPAD.right);
    // Held: nothing until repeatDelay, then one step per repeatInterval.
    nav.update(MENU_GAMEPAD.repeatDelay * 0.5);
    expect(range.value).toBe('1.05');
    nav.update(MENU_GAMEPAD.repeatDelay * 0.5);
    expect(range.value).toBe('1.1');
    nav.update(MENU_GAMEPAD.repeatInterval);
    expect(range.value).toBe('1.15');
    pad.release(MENU_GAMEPAD.right);
    nav.update(1);
    expect(range.value).toBe('1.15');
  });

  it('left/right move within a radio group and select', () => {
    const r2 = root.querySelector<HTMLButtonElement>('#r2')!;
    const clicked = vi.fn();
    r2.addEventListener('click', clicked);
    root.querySelector<HTMLButtonElement>('#r1')!.focus();
    pad.press(nav, MENU_GAMEPAD.right);
    expect(focused()).toBe('r2');
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('left/right on other widgets send the arrow key (tab lists)', () => {
    const keys: string[] = [];
    root.addEventListener('keydown', (e) => keys.push(`${e.key}|${e.code}`));
    root.querySelector<HTMLButtonElement>('#settings')!.focus();
    pad.press(nav, MENU_GAMEPAD.left);
    expect(keys).toEqual(['ArrowLeft|']); // no `code`: InputSystem ignores synthetic keys
  });

  it('B sends Escape to the menu; unhandled it calls onBack', () => {
    root.querySelector<HTMLButtonElement>('#resume')!.focus();
    pad.press(nav, MENU_GAMEPAD.back);
    expect(onBack).toHaveBeenCalledTimes(1);
    pad.release(MENU_GAMEPAD.back);
    // A sub-view that handles Escape (cancels it) consumes the back press.
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    pad.press(nav, MENU_GAMEPAD.back);
    window.removeEventListener('keydown', handler);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
