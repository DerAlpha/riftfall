// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputApi, SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { RUN_MENU } from '../../defs/ui';
import { MenuPadNavigator, type MenuPadInput } from '../../game/MenuPadNavigator';
import { MENU_GAMEPAD } from '../../defs/engine';
import { createDefaultSettings, type Settings, type SettingsSection } from '../../save/settingsSchema';
import type { GameOverStats, MapChoice, MenuDeps, PlayOptions } from './context';
import { formatAccuracy, formatCount, formatRunTime, statsAccuracy } from './GameOverScreen';
import { mountMenus, type MenuController } from './index';
import { initialMapId } from './StartScreen';

const G = RUN_MENU.gameOver;

function makeSettings(events: EventBus<GameEvents>): SettingsStore {
  const current = createDefaultSettings();
  return {
    current,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
      Object.assign(current[section], patch);
      events.emit('settings:changed', { settings: current, sections: [section] });
    },
    replace(): void {},
    resetSection(): void {},
  };
}

function fakeInput(): InputApi {
  return {
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
    captureBinding: () => Promise.resolve(null),
    rumble: () => {},
    dispose: () => {},
  };
}

const MAPS: readonly MapChoice[] = [
  { id: 'testroom', name: 'Kalibrierungshalle (Training)', description: 'Testgelände.' },
  { id: 'lab', name: 'Forschungslabor', description: 'Der Riss.', recommended: true },
];

/** A RunSummary-shaped object (modes/RunFlow) – the controller takes it as is. */
const SUMMARY = {
  mapId: 'lab',
  mode: 'classic',
  wave: 7,
  kills: 1234,
  headshots: 56,
  shotsFired: 400,
  shotsHit: 173,
  timeSurvived: 754.6,
  score: 45678,
  weakpointKills: 3,
  accuracy: 173 / 400,
  damageDealt: 9000,
  damageTaken: 800,
  wavesCompleted: 6,
};

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(text));
  if (!b) throw new Error(`button "${text}" not found`);
  return b;
}

function cards(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.start__map')];
}

describe('run menus', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let onStart: ReturnType<typeof vi.fn<(o?: PlayOptions) => void>>;
  let menus: MenuController;
  let menuEvents: string[];

  function mount(over: Partial<MenuDeps> = {}): void {
    menus = mountMenus(root, {
      settings: makeSettings(events),
      input: fakeInput(),
      events,
      onStart,
      onResume: vi.fn(),
      getInfo: () => ({ gpuName: 'Test GPU', saveBackend: 'memory', version: '0.1.0' }),
      maps: MAPS,
      ...over,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
    events = new EventBus<GameEvents>();
    onStart = vi.fn<(o?: PlayOptions) => void>();
    menuEvents = [];
    events.on('ui:menu', ({ open, menu }) => menuEvents.push(`${menu}:${open ? 'open' : 'close'}`));
  });

  afterEach(() => {
    menus.dispose();
    root.remove();
    vi.useRealTimers();
  });

  describe('start screen map selection', () => {
    it('preselects the recommended map and passes the selection to onStart', () => {
      mount();
      act(() => menus.showStart());
      expect(root.textContent).toContain(RUN_MENU.start.mapsHeading);
      const [training, lab] = cards(root);
      expect(training!.textContent).toContain('Kalibrierungshalle (Training)');
      expect(lab!.getAttribute('aria-checked')).toBe('true');
      expect(lab!.querySelector('.start__mapbadge')!.textContent).toBe(RUN_MENU.start.recommended);
      expect(training!.querySelector('.start__mapbadge')).toBeNull();
      // Roving tab stop: only the selected card is in the tab order.
      expect(lab!.tabIndex).toBe(0);
      expect(training!.tabIndex).toBe(-1);
      act(() => button(root, 'KLICKEN ZUM STARTEN').click());
      expect(onStart).toHaveBeenLastCalledWith({ mapId: 'lab' });
    });

    it('selects with a click (without starting), starts on the selected card, remembers the choice', () => {
      mount();
      act(() => menus.showStart());
      act(() => cards(root)[0]!.click());
      expect(onStart).not.toHaveBeenCalled();
      expect(cards(root)[0]!.getAttribute('aria-checked')).toBe('true');
      expect(cards(root)[1]!.getAttribute('aria-checked')).toBe('false');
      act(() => cards(root)[0]!.click());
      expect(onStart).toHaveBeenLastCalledWith({ mapId: 'testroom' });
      // After a game over → main menu, the start screen keeps the choice.
      act(() => menus.hide());
      act(() => menus.showStart());
      expect(cards(root)[0]!.getAttribute('aria-checked')).toBe('true');
    });

    it('moves the selection with the arrow keys and the gamepad D-pad', () => {
      mount();
      act(() => menus.showStart());
      const group = root.querySelector('[role="radiogroup"]')!;
      cards(root)[1]!.focus();
      act(() => {
        group.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
        );
      });
      expect(cards(root)[0]!.getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(cards(root)[0]);

      // Gamepad: right on a radio card picks the next one, A on the selected card starts.
      const pressed = new Set<number>();
      const pad: MenuPadInput = {
        padButtonDown: (b) => pressed.has(b),
        padButtonPressed: (b) => pressed.has(b),
      };
      const nav = new MenuPadNavigator(root, pad, () => {});
      pressed.add(MENU_GAMEPAD.right);
      act(() => nav.update(1 / 60));
      pressed.clear();
      expect(cards(root)[1]!.getAttribute('aria-checked')).toBe('true');
      expect(onStart).not.toHaveBeenCalled();
      pressed.add(MENU_GAMEPAD.confirm);
      act(() => nav.update(1 / 60));
      expect(onStart).toHaveBeenLastCalledWith({ mapId: 'lab' });
    });

    it('keeps the plain start screen without maps and never passes a map id', () => {
      mount({ maps: undefined });
      act(() => menus.showStart());
      expect(cards(root).length).toBe(0);
      expect(root.textContent).toContain(RUN_MENU.start.subtitle);
      act(() => button(root, 'KLICKEN ZUM STARTEN').click());
      expect(onStart).toHaveBeenLastCalledWith(undefined);
    });

    it('is replaced by the pause menu only after it asked to start (refused pointer lock)', () => {
      mount();
      act(() => menus.showStart());
      act(() => menus.showPause()); // tab switch on the main menu
      expect(menus.view).toBe('start');
      act(() => button(root, 'KLICKEN ZUM STARTEN').click());
      act(() => menus.showPause()); // the lock request was refused: hints + lock-less option
      expect(menus.view).toBe('pause');
      act(() => menus.showStart());
      act(() => menus.showPause());
      expect(menus.view).toBe('start');
    });

    it('picks the initial map: remembered, else recommended, else first', () => {
      expect(initialMapId(MAPS)).toBe('lab');
      expect(initialMapId(MAPS, 'testroom')).toBe('testroom');
      expect(initialMapId(MAPS, 'gone')).toBe('lab');
      expect(initialMapId([MAPS[0]!])).toBe('testroom');
      expect(initialMapId([])).toBeNull();
    });
  });

  describe('game over screen', () => {
    it('shows the run statistics in German formatting', () => {
      mount();
      act(() => menus.showGameOver(SUMMARY));
      expect(menus.isOpen).toBe(true);
      expect(menus.view).toBe('gameover');
      expect(root.querySelector('.gameover__title')!.textContent).toBe('DU BIST GEFALLEN');
      expect(root.querySelector('.gameover__sub')!.textContent).toBe('Forschungslabor · Klassisch');
      expect(root.querySelector('.gameover__wavevalue')!.textContent).toBe('7');
      const stat = (key: string): string | null | undefined =>
        root.querySelector(`.gameover__stat--${key} dd`)?.textContent;
      expect(stat('kills')).toBe('1.234');
      expect(stat('headshots')).toBe('56');
      expect(stat('weakpoints')).toBe('3');
      expect(stat('accuracy')).toBe('43 %');
      expect(stat('time')).toBe('12:34');
      expect(root.querySelector('.gameover__scorevalue')!.textContent).toBe('45.678');
      expect(menuEvents).toEqual(['gameover:open']);
    });

    it('ignores input until the delay, then focuses "Neu starten"', () => {
      const onRestart = vi.fn<(o?: PlayOptions) => void>();
      const onMainMenu = vi.fn();
      mount({ onRestart, onMainMenu });
      act(() => menus.showGameOver(SUMMARY));
      const restart = button(root, G.restart);
      expect(restart.disabled).toBe(true);
      act(() => restart.click());
      expect(onRestart).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(G.inputDelayMs + 1);
      });
      expect(restart.disabled).toBe(false);
      expect(document.activeElement).toBe(restart);
      act(() => button(root, G.mainMenu).click());
      expect(onMainMenu).toHaveBeenCalledTimes(1);
      // "Neu starten" closes the screen first (a refused pointer lock may open the pause menu).
      let viewDuringRestart: string | null = 'unset';
      onRestart.mockImplementation(() => {
        viewDuringRestart = menus.view;
        menus.showPause();
      });
      act(() => restart.click());
      expect(onRestart).toHaveBeenCalledWith(undefined);
      expect(viewDuringRestart).toBeNull();
      expect(menus.view).toBe('pause');
      expect(menuEvents).toEqual(['gameover:open', 'gameover:close', 'pause:open']);
    });

    it('moves between the buttons with the arrow keys and the gamepad', () => {
      const onRestart = vi.fn();
      const onMainMenu = vi.fn();
      mount({ onRestart, onMainMenu });
      act(() => menus.showGameOver(SUMMARY));
      act(() => {
        vi.advanceTimersByTime(G.inputDelayMs + 1);
      });
      const nav = root.querySelector('.gameover__nav')!;
      act(() => {
        nav.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
        );
      });
      expect(document.activeElement).toBe(button(root, G.mainMenu));

      const pressed = new Set<number>();
      const pad: MenuPadInput = {
        padButtonDown: (b) => pressed.has(b),
        padButtonPressed: (b) => pressed.has(b),
      };
      const back = vi.fn();
      const padNav = new MenuPadNavigator(root, pad, back);
      pressed.add(MENU_GAMEPAD.up);
      act(() => padNav.update(1 / 60));
      pressed.clear();
      expect(document.activeElement).toBe(button(root, G.restart));
      // B has no "back" on the game over screen: the game's onBack decides (and does nothing).
      pressed.add(MENU_GAMEPAD.back);
      act(() => padNav.update(1 / 60));
      pressed.clear();
      expect(back).toHaveBeenCalledTimes(1);
      expect(menus.view).toBe('gameover');
      expect(document.activeElement).toBe(button(root, G.restart));
      pressed.add(MENU_GAMEPAD.confirm);
      act(() => padNav.update(1 / 60));
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(menus.view).toBeNull();
    });

    it('falls back to onStart with the run map and to the start screen', () => {
      mount();
      act(() => menus.showGameOver(SUMMARY));
      act(() => {
        vi.advanceTimersByTime(G.inputDelayMs + 1);
      });
      act(() => button(root, G.restart).click());
      expect(onStart).toHaveBeenLastCalledWith({ mapId: 'lab' });
      expect(menus.view).toBeNull();
      act(() => menus.showGameOver(SUMMARY));
      act(() => {
        vi.advanceTimersByTime(G.inputDelayMs + 1);
      });
      act(() => button(root, G.mainMenu).click());
      expect(menus.view).toBe('start');
      expect(menus.current).toBe('start');
      expect(menuEvents).toEqual([
        'gameover:open',
        'gameover:close',
        'gameover:open',
        'gameover:close',
        'start:open',
      ]);
      // Back on the start screen after a run: a tab switch / lost lock must not replace it.
      act(() => menus.showPause());
      expect(menus.view).toBe('start');
      expect(root.querySelector('.pause')).toBeNull();
    });

    it('is not replaced by the pause menu and reports no legacy view', () => {
      mount();
      act(() => menus.showGameOver(SUMMARY));
      expect(menus.current).toBeNull();
      act(() => menus.showPause()); // lost pointer lock / tab switch behind the game over screen
      expect(menus.view).toBe('gameover');
      expect(root.querySelector('.pause')).toBeNull();
      // A new game over replaces the stats (remount) without a close/open pair.
      act(() => menus.showGameOver({ ...SUMMARY, wave: 9 }));
      expect(root.querySelector('.gameover__wavevalue')!.textContent).toBe('9');
      expect(menuEvents).toEqual(['gameover:open']);
      act(() => menus.hide());
      expect(menus.isOpen).toBe(false);
      act(() => menus.showPause());
      expect(menus.current).toBe('pause');
    });

    it('works with minimal stats (no map, no accuracy, no weakpoints)', () => {
      mount({ maps: undefined });
      const stats: GameOverStats = {
        wave: 1,
        kills: 0,
        headshots: 0,
        shotsFired: 0,
        shotsHit: 0,
        timeSurvived: 3,
        score: 0,
      };
      act(() => menus.showGameOver(stats));
      expect(root.querySelector('.gameover__sub')).toBeNull();
      expect(root.querySelector('.gameover__stat--weakpoints')).toBeNull();
      expect(root.querySelector('.gameover__stat--accuracy dd')!.textContent).toBe('0 %');
      expect(root.querySelector('.gameover__stat--time dd')!.textContent).toBe('0:03');
    });
  });

  it('formats times, counts and accuracy', () => {
    expect(formatRunTime(0)).toBe('0:00');
    expect(formatRunTime(59.9)).toBe('0:59');
    expect(formatRunTime(3725)).toBe('1:02:05');
    expect(formatRunTime(Number.NaN)).toBe('0:00');
    expect(formatCount(1234567)).toBe('1.234.567');
    expect(formatCount(-5)).toBe('0');
    expect(formatAccuracy(0.456)).toBe('46 %');
    expect(formatAccuracy(2)).toBe('100 %');
    expect(statsAccuracy({ ...SUMMARY, accuracy: undefined })).toBeCloseTo(173 / 400);
    expect(statsAccuracy({ ...SUMMARY, accuracy: undefined, shotsFired: 0 })).toBe(0);
  });
});
