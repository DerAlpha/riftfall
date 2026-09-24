/**
 * Menu layer (#ui): start screen (with the M3 map selection), pause menu with settings and the
 * game over screen, rendered with Preact. The controller is imperative so the composition root
 * stays framework-agnostic.
 *
 * API (backward compatible with M1/M2):
 * - showStart() / showPause() / hide(), isOpen, dispose() – unchanged.
 * - showGameOver(stats): the game over screen (RunSummary from modes/RunFlow fits).
 * - showPause() is ignored while the game over screen is open, and on the start screen until it
 *   asked to start: a lost pointer lock or a tab switch must not replace them (after "Hauptmenü"
 *   the game still counts as started, so PauseController.openMenu may fire on the start screen).
 *   Once the start screen called onStart, a refused pointer lock does open the pause menu (its
 *   hints and the lock-less option).
 * - "Neu starten" closes the game over screen BEFORE it calls onRestart (default: onStart with the
 *   run's map): if the pointer lock request is refused, the pause flow (showPause) takes over
 *   with its hints and the lock-less option instead of leaving the player on a stale game over.
 * - current: 'start' | 'pause' | null – the game over screen reports null, so pause-menu logic
 *   (PauseController resume on the pause binding, gamepad B → resume) never fires behind it.
 * - view: every view incl. 'gameover' (ui:menu events use the same names).
 * - MenuDeps.maps / onRestart / onMainMenu and PlayOptions.mapId: see context.ts.
 */
import { render } from 'preact';
import type { GameOverStats, MenuDeps, MenuMemory, PlayOptions } from './context';
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
  onRestart,
  onMainMenu,
}: {
  view: MenuView | null;
  openId: number;
  deps: MenuDeps;
  memory: MenuMemory;
  stats: GameOverStats | null;
  onRestart: (opts?: PlayOptions) => void;
  onMainMenu: () => void;
}) {
  if (view === 'start') return <StartScreen key={`start-${openId}`} deps={deps} memory={memory} />;
  if (view === 'pause') return <PauseMenu key={`pause-${openId}`} deps={deps} memory={memory} />;
  if (view === 'gameover' && stats) {
    return (
      <GameOverScreen
        key={`gameover-${openId}`}
        deps={deps}
        stats={stats}
        onRestart={onRestart}
        onMainMenu={onMainMenu}
      />
    );
  }
  return null;
}

export function mountMenus(root: HTMLElement, deps: MenuDeps): MenuController {
  let view: MenuView | null = null;
  let openId = 0;
  let disposed = false;
  let stats: GameOverStats | null = null;
  /** The shown start screen called onStart (the pointer lock request may still be refused). */
  let startRequested = false;
  const memory: MenuMemory = { tab: 'graphics' };
  // Everything else reads through to `deps` (live, incl. getters); only onStart is wrapped.
  const menuDeps = Object.create(deps) as MenuDeps;
  menuDeps.onStart = (opts) => {
    startRequested = true;
    deps.onStart(opts);
  };

  const draw = (): void => {
    if (disposed) return;
    render(
      <MenuRoot
        view={view}
        openId={openId}
        deps={menuDeps}
        memory={memory}
        stats={stats}
        onRestart={restart}
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
    if (next === 'start') startRequested = false;
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

  function restart(opts?: PlayOptions): void {
    const mapId = stats?.mapId;
    setView(null);
    if (deps.onRestart) deps.onRestart(opts);
    else deps.onStart(mapId ? { ...opts, mapId } : opts);
  }

  return {
    showStart: () => setView('start'),
    showPause: () => {
      if (view === 'gameover' || (view === 'start' && !startRequested)) return;
      setView('pause');
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
