/**
 * Menu layer (#ui): start screen (with the M3 map selection), pause menu with settings and the
 * game over screen, rendered with Preact. The controller is imperative so the composition root
 * stays framework-agnostic.
 *
 * API (backward compatible with M1/M2):
 * - showStart() / showPause() / hide(), isOpen, dispose() – unchanged.
 * - showGameOver(stats): the game over screen (RunSummary from modes/RunFlow fits). While it is
 *   open, showPause() is ignored – a lost pointer lock or a tab switch must not replace it; only
 *   showStart(), hide() or another showGameOver() leave it.
 * - current: 'start' | 'pause' | null – the game over screen reports null, so pause-menu logic
 *   (PauseController resume on the pause binding, gamepad B → resume) never fires behind it.
 * - view: every view incl. 'gameover' (ui:menu events use the same names).
 * - MenuDeps.maps / onRestart / onMainMenu and PlayOptions.mapId: see context.ts.
 */
import { render } from 'preact';
import type { GameOverStats, MenuDeps, MenuMemory } from './context';
import { GameOverScreen } from './GameOverScreen';
import { PauseMenu } from './PauseMenu';
import { StartScreen } from './StartScreen';

export type MenuView = 'start' | 'pause' | 'gameover';

export interface MenuController {
  showStart(): void;
  showPause(): void;
  /** Game over screen with the finished run's statistics (ignored after dispose). */
  showGameOver(stats: GameOverStats): void;
  hide(): void;
  readonly isOpen: boolean;
  /** Start screen or pause menu currently shown, else null (also while the game over screen is open). */
  readonly current: 'start' | 'pause' | null;
  /** Any view currently shown, incl. 'gameover'. */
  readonly view: MenuView | null;
  dispose(): void;
}

function MenuRoot({
  view,
  openId,
  deps,
  memory,
  stats,
  onMainMenu,
}: {
  view: MenuView | null;
  openId: number;
  deps: MenuDeps;
  memory: MenuMemory;
  stats: GameOverStats | null;
  onMainMenu: () => void;
}) {
  if (view === 'start') return <StartScreen key={`start-${openId}`} deps={deps} memory={memory} />;
  if (view === 'pause') return <PauseMenu key={`pause-${openId}`} deps={deps} memory={memory} />;
  if (view === 'gameover' && stats) {
    return <GameOverScreen key={`gameover-${openId}`} deps={deps} stats={stats} onMainMenu={onMainMenu} />;
  }
  return null;
}

export function mountMenus(root: HTMLElement, deps: MenuDeps): MenuController {
  let view: MenuView | null = null;
  let openId = 0;
  let disposed = false;
  let stats: GameOverStats | null = null;
  const memory: MenuMemory = { tab: 'graphics' };

  const draw = (): void => {
    if (disposed) return;
    render(
      <MenuRoot
        view={view}
        openId={openId}
        deps={deps}
        memory={memory}
        stats={stats}
        onMainMenu={mainMenu}
      />,
      root,
    );
  };

  /** `force`: re-open the same view (a new game over replaces the old one). */
  const setView = (next: MenuView | null, force = false): void => {
    if (disposed || (next === view && !force)) return;
    const prev = view;
    view = next;
    if (next) openId++;
    root.classList.toggle('is-active', next !== null);
    draw();
    if (prev === next) return;
    if (prev) deps.events.emit('ui:menu', { open: false, menu: prev });
    if (next) deps.events.emit('ui:menu', { open: true, menu: next });
  };

  function mainMenu(): void {
    if (deps.onMainMenu) deps.onMainMenu();
    else setView('start');
  }

  return {
    showStart: () => setView('start'),
    showPause: () => {
      if (view !== 'gameover') setView('pause');
    },
    showGameOver: (s) => {
      if (disposed) return;
      stats = s;
      setView('gameover', true);
    },
    hide: () => setView(null),
    get isOpen() {
      return view !== null;
    },
    get current() {
      return view === 'gameover' ? null : view;
    },
    get view() {
      return view;
    },
    dispose: () => {
      if (disposed) return;
      render(null, root);
      disposed = true;
      root.classList.remove('is-active');
    },
  };
}
