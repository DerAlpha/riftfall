/**
 * UI entry: styles + all UI building blocks. DOM layers live in index.html
 * (#hud, #ui, #debug, #console, #loading); `getUiLayers` finds them (creating any that are missing).
 */
import './styles.css';
import { createLogger } from '../core/log';

export { Hud } from './hud/Hud';
export { DebugOverlay, type DebugSnapshot } from './debug/DebugOverlay';
export { DevConsole } from './console/DevConsole';
export { LoadingScreen } from './LoadingScreen';
export { mountMenus, type MenuController, type MenuDeps } from './menus';

export interface UiLayers {
  hud: HTMLElement;
  ui: HTMLElement;
  debug: HTMLElement;
  console: HTMLElement;
  loading: HTMLElement;
}

const log = createLogger('UI');

const LAYER_IDS: readonly (keyof UiLayers)[] = ['hud', 'ui', 'debug', 'console', 'loading'];

/** Look up the layer elements; a missing layer is created (never crash on a trimmed index.html). */
export function getUiLayers(doc: Document = document): UiLayers {
  const parent = doc.getElementById('app') ?? doc.body;
  const out = {} as UiLayers;
  for (const id of LAYER_IDS) {
    let el = doc.getElementById(id);
    if (!el) {
      log.warn(`#${id} fehlt in index.html – wird erzeugt`);
      el = doc.createElement('div');
      el.id = id;
      el.className = `layer layer-${id}`;
      parent.appendChild(el);
    }
    out[id] = el;
  }
  return out;
}
