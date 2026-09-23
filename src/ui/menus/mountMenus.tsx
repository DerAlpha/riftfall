/**
 * Menu layer (#ui): start screen and pause menu with settings, rendered with Preact.
 * The controller is imperative so the composition root stays framework-agnostic.
 */
import { render } from 'preact';
import type { MenuDeps, MenuMemory } from './context';
import { PauseMenu } from './PauseMenu';
import { StartScreen } from './StartScreen';

export type MenuView = 'start' | 'pause';

export interface MenuController {
  showStart(): void;
  showPause(): void;
  hide(): void;
  readonly isOpen: boolean;
  /** Menu currently shown, or null. */
  readonly current: MenuView | null;
  dispose(): void;
}

function MenuRoot({
  view,
  openId,
  deps,
  memory,
}: {
  view: MenuView | null;
  openId: number;
  deps: MenuDeps;
  memory: MenuMemory;
}) {
  if (view === 'start') return <StartScreen key={`start-${openId}`} deps={deps} />;
  if (view === 'pause') return <PauseMenu key={`pause-${openId}`} deps={deps} memory={memory} />;
  return null;
}

export function mountMenus(root: HTMLElement, deps: MenuDeps): MenuController {
  let view: MenuView | null = null;
  let openId = 0;
  let disposed = false;
  const memory: MenuMemory = { tab: 'graphics' };

  const draw = (): void => {
    if (disposed) return;
    render(<MenuRoot view={view} openId={openId} deps={deps} memory={memory} />, root);
  };

  const setView = (next: MenuView | null): void => {
    if (disposed || next === view) return;
    const prev = view;
    view = next;
    if (next) openId++;
    root.classList.toggle('is-active', next !== null);
    draw();
    if (prev) deps.events.emit('ui:menu', { open: false, menu: prev });
    if (next) deps.events.emit('ui:menu', { open: true, menu: next });
  };

  return {
    showStart: () => setView('start'),
    showPause: () => setView('pause'),
    hide: () => setView(null),
    get isOpen() {
      return view !== null;
    },
    get current() {
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
