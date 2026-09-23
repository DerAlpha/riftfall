// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputApi, SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { GRAPHICS_PRESETS } from '../../defs/graphics';
import type { Binding } from '../../defs/input';
import { createDefaultSettings, type Settings, type SettingsSection } from '../../save/settingsSchema';
import { mountMenus, type MenuController } from './index';

function makeSettings(events: EventBus<GameEvents>): SettingsStore {
  const current = createDefaultSettings();
  return {
    current,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
      Object.assign(current[section], patch);
      events.emit('settings:changed', { settings: current, sections: [section] });
    },
    replace(): void {},
    resetSection<S extends SettingsSection>(section: S): void {
      Object.assign(current[section], createDefaultSettings()[section]);
      events.emit('settings:changed', { settings: current, sections: [section] });
    },
  };
}

function fakeInput(): InputApi & { resolveCapture(b: Binding | null): void; cancelCapture: () => void } {
  let resolver: ((b: Binding | null) => void) | null = null;
  const self = {
    device: 'kbm',
    pointerLocked: false,
    enabled: false,
    beginFrame: () => {},
    endFrame: () => {},
    isDown: () => false,
    pressed: () => false,
    released: () => false,
    value: () => 0,
    getMove: (o) => o,
    getLook: (o) => o,
    requestPointerLock: () => {},
    exitPointerLock: () => {},
    captureBinding: () => new Promise<Binding | null>((r) => (resolver = r)),
    rumble: vi.fn(),
    dispose: () => {},
    resolveCapture(b: Binding | null) {
      resolver?.(b);
      resolver = null;
    },
    cancelCapture: vi.fn(() => self.resolveCapture(null)),
  } satisfies InputApi & { resolveCapture(b: Binding | null): void; cancelCapture: () => void };
  return self;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(text));
  if (!b) throw new Error(`button "${text}" not found`);
  return b;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('menus', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let input: ReturnType<typeof fakeInput>;
  let onStart: ReturnType<typeof vi.fn<() => void>>;
  let onResume: ReturnType<typeof vi.fn<() => void>>;
  let menus: MenuController;
  let menuEvents: string[];

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    events = new EventBus<GameEvents>();
    settings = makeSettings(events);
    input = fakeInput();
    onStart = vi.fn<() => void>();
    onResume = vi.fn<() => void>();
    menuEvents = [];
    events.on('ui:menu', ({ open, menu }) => menuEvents.push(`${menu}:${open ? 'open' : 'close'}`));
    menus = mountMenus(root, {
      settings,
      input,
      events,
      onStart,
      onResume,
      getInfo: () => ({ gpuName: 'Test GPU', saveBackend: 'memory', version: '0.1.0' }),
    });
  });

  afterEach(() => {
    menus.dispose();
    root.remove();
  });

  it('shows the start screen and starts on click', () => {
    act(() => menus.showStart());
    expect(menus.isOpen).toBe(true);
    expect(root.classList.contains('is-active')).toBe(true);
    expect(root.querySelector('.rf-title')!.textContent).toBe('RIFTFALL');
    expect(root.textContent).toContain('Kalibrierungshalle – Meilenstein 1');
    expect(root.querySelector('.start__keys')!.textContent).toBe('W A S D');
    act(() => button(root, 'KLICKEN ZUM STARTEN').click());
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => menus.hide());
    expect(menus.isOpen).toBe(false);
    expect(root.childElementCount).toBe(0);
    expect(menuEvents).toEqual(['start:open', 'start:close']);
  });

  it('pause menu: resume, settings tabs, presets and custom detection', async () => {
    act(() => menus.showPause());
    act(() => button(root, 'Fortsetzen').click());
    expect(onResume).toHaveBeenCalledTimes(1);

    act(() => button(root, 'Einstellungen').click());
    expect(root.textContent).toContain('Test GPU');
    act(() => button(root, 'Niedrig').click());
    await flush();
    expect(settings.current.graphics.preset).toBe('low');
    expect(settings.current.graphics.shadows).toBe(GRAPHICS_PRESETS.low.shadows);

    // Individual change → custom (the Schatten row has its own "Ultra" option).
    const shadowRow = [...root.querySelectorAll('.menu-row')].find((r) =>
      r.textContent?.startsWith('Schatten'),
    )!;
    act(() => button(shadowRow as HTMLElement, 'Ultra').click());
    await flush();
    expect(settings.current.graphics.shadows).toBe('ultra');
    expect(settings.current.graphics.preset).toBe('custom');
    expect(root.querySelector('.menu-preset--custom.is-active')).not.toBeNull();

    // Escape goes back to the main pause view.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(root.textContent).toContain('Fortsetzen');
  });

  it('rebinds a key with swap semantics and shows the conflict', async () => {
    act(() => menus.showPause());
    act(() => button(root, 'Einstellungen').click());
    act(() => button(root, 'Steuerung').click());
    await flush();
    const row = [...root.querySelectorAll('.keybinds__row')].find((r) =>
      r.querySelector('.keybinds__action')?.textContent?.startsWith('Springen'),
    )!;
    const primary = row.querySelectorAll('.keybinds__slot')[0] as HTMLButtonElement;
    expect(primary.textContent).toBe('Leertaste');
    act(() => primary.click());
    await flush();
    expect(primary.textContent).toContain('Taste drücken');
    await act(async () => {
      input.resolveCapture({ device: 'key', code: 'KeyQ' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(settings.current.controls.bindings.jump[0]).toEqual({ device: 'key', code: 'KeyQ' });
    expect(settings.current.controls.bindings.dash[0]).toEqual({ device: 'key', code: 'Space' });
    expect(root.querySelector('.keybinds__notice')!.textContent).toContain('„Dash“');

    // Wrong family for the gamepad column is rejected with a hint.
    const padSlot = row.querySelectorAll('.keybinds__slot')[2] as HTMLButtonElement;
    act(() => padSlot.click());
    await act(async () => {
      input.resolveCapture({ device: 'key', code: 'KeyZ' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(settings.current.controls.bindings.jump).toContainEqual({ device: 'pad', button: 0 });
    expect(root.querySelector('.keybinds__notice')!.textContent).toContain('Gamepad');
  });

  it('applies audio and accessibility changes live', async () => {
    act(() => menus.showPause());
    act(() => button(root, 'Einstellungen').click());
    act(() => button(root, 'Audio').click());
    await flush();
    const slider = root.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => {
      slider.value = '0.25';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(settings.current.audio.master).toBeCloseTo(0.25, 5);

    act(() => button(root, 'Barrierefreiheit').click());
    await flush();
    const flashRow = [...root.querySelectorAll('.menu-row')].find((r) =>
      r.textContent?.startsWith('Blitzeffekte'),
    )!;
    act(() => (flashRow.querySelector('button') as HTMLButtonElement).click());
    expect(settings.current.accessibility.reduceFlashing).toBe(true);
  });

  it('cancels a running key capture when the menu closes', async () => {
    act(() => menus.showPause());
    act(() => button(root, 'Einstellungen').click());
    act(() => button(root, 'Steuerung').click());
    await flush();
    const slot = root.querySelector('.keybinds__slot') as HTMLButtonElement;
    act(() => slot.click());
    await flush();
    expect(slot.textContent).toContain('Taste drücken');
    act(() => menus.hide());
    await flush();
    expect(input.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it('switches the start screen cheat sheet to gamepad labels when the pad is used', async () => {
    act(() => menus.showStart());
    expect(root.querySelector('.start__keys')!.textContent).toBe('W A S D');
    (input as { device: 'kbm' | 'gamepad' }).device = 'gamepad';
    act(() => events.emit('input:deviceChanged', { device: 'gamepad' }));
    await flush();
    const rows = [...root.querySelectorAll('.start__sheetrow')];
    const jump = rows.find((r) => r.textContent?.startsWith('Springen'))!;
    expect(jump.querySelector('.start__keys')!.textContent).toBe('Pad A');
  });
});
