// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOADING } from '../defs/ui';
import { LoadingScreen } from './LoadingScreen';

describe('LoadingScreen', () => {
  afterEach(() => vi.useRealTimers());

  it('shows progress, rotates tips and hides after the fade', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const ls = new LoadingScreen(root);
    ls.show();
    expect(root.classList.contains('is-active')).toBe(true);
    ls.setProgress(0.456, 'Lade Assets…');
    expect(root.querySelector('.loading__percent')!.textContent).toBe('46 %');
    expect(root.querySelector('.loading__label')!.textContent).toBe('Lade Assets…');
    const tip = root.querySelector('.loading__tip')!;
    const first = tip.textContent;
    expect(LOADING.tips as readonly string[]).toContain(first);
    vi.advanceTimersByTime(LOADING.tipIntervalMs);
    expect(tip.textContent).not.toBe(first);

    ls.hide();
    expect(ls.visible).toBe(false);
    vi.advanceTimersByTime(LOADING.fadeMs);
    expect((root.firstElementChild as HTMLElement).hidden).toBe(true);
    expect(root.classList.contains('is-active')).toBe(false);
    ls.dispose();
  });

  it('stops the logo glitch when flashing effects are reduced', () => {
    const root = document.createElement('div');
    const ls = new LoadingScreen(root);
    const el = root.firstElementChild as HTMLElement;
    expect(el.classList.contains('loading--calm')).toBe(false);
    ls.setReducedFlashing(true);
    expect(el.classList.contains('loading--calm')).toBe(true);
    ls.setReducedFlashing(false);
    expect(el.classList.contains('loading--calm')).toBe(false);
    ls.dispose();
  });
});
