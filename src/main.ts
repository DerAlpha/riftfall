/**
 * Entry. Kept free of three.js/postprocessing/Rapier: those load with the dynamic Game import, so
 * the loading screen paints immediately, the WebGL2 check needs no engine download, and an engine
 * chunk that fails to load or parse (redeploy, old browser) ends in a caught error screen instead
 * of a page that never boots.
 */
import './ui/styles.css';
import { createLogger } from './core/log';
import { BOOT_PROGRESS } from './defs/engine';
import { PRESET_ORDER } from './defs/graphics';
import { LoadingScreen } from './ui/LoadingScreen';

const log = createLogger('Main');

// The inline boot watchdog in index.html shows "unsupported browser" only if this never runs.
(window as Window & { __riftfallBooted?: boolean }).__riftfallBooted = true;

let loading: LoadingScreen | null = null;

function showFatal(title: string, detail: string): void {
  loading?.dispose();
  loading = null;
  const box = document.createElement('div');
  box.className = 'fatal-error';
  box.setAttribute('role', 'alert');
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  box.append(h, p);
  // The loading layer is the top layer; a non-empty #loading also drops the CSS boot splash.
  const root = document.getElementById('loading') ?? document.body;
  root.replaceChildren(box);
}

function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Last selected map (the start screen switches maps with a reload). */
function readLastMap(): string | null {
  try {
    return localStorage.getItem('riftfall.lastMap');
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  if (!hasWebGL2()) {
    showFatal(
      'WebGL2 nicht verfügbar',
      'RIFTFALL benötigt einen Browser mit WebGL2 und aktivierter Hardwarebeschleunigung (aktuelle Versionen von Chrome, Edge, Firefox oder Safari).',
    );
    return;
  }
  const root = document.getElementById('loading');
  if (root) {
    root.replaceChildren(); // a spurious boot-watchdog message: the entry evidently runs
    loading = new LoadingScreen(root);
    loading.show();
    loading.setProgress(BOOT_PROGRESS.engine, 'Lade Engine…');
  }
  const params = new URLSearchParams(location.search);
  const { Game } = await import('./game/Game');
  if (!loading) throw new Error('Missing #loading in index.html');
  const game = await Game.create(
    {
      autostart: params.has('autostart'),
      noPointerLock: params.has('nolock'),
      exposeHandle: params.has('smoke') || import.meta.env.DEV,
      forcePreset: PRESET_ORDER.find((p) => p === params.get('preset')) ?? null,
      mapId: params.get('map') ?? readLastMap(),
    },
    loading,
  );
  if (game.opts.exposeHandle) {
    (window as unknown as { __RIFTFALL__: unknown }).__RIFTFALL__ = game.createDebugHandle();
  }
}

boot().catch((err: unknown) => {
  log.error('Fatal boot error', err);
  showFatal('Start fehlgeschlagen', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
});
