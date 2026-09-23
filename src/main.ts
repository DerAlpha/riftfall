import './ui/styles.css';
import { RenderSystem } from './render/RenderSystem';
import { createLogger } from './core/log';

const log = createLogger('Main');

function showFatal(title: string, detail: string): void {
  const root = document.getElementById('ui') ?? document.body;
  document.getElementById('loading')?.replaceChildren();
  const box = document.createElement('div');
  box.className = 'fatal-error';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  box.append(h, p);
  root.replaceChildren(box);
}

async function boot(): Promise<void> {
  if (!RenderSystem.isWebGL2Available()) {
    showFatal(
      'WebGL2 nicht verfügbar',
      'RIFTFALL benötigt einen Browser mit WebGL2 und aktivierter Hardwarebeschleunigung (aktuelle Versionen von Chrome, Edge, Firefox oder Safari).',
    );
    return;
  }
  const params = new URLSearchParams(location.search);
  const { Game } = await import('./game/Game');
  const game = await Game.create({
    autostart: params.has('autostart'),
    noPointerLock: params.has('nolock'),
    exposeHandle: params.has('smoke') || import.meta.env.DEV,
  });
  if (game.opts.exposeHandle) {
    (window as unknown as { __RIFTFALL__: unknown }).__RIFTFALL__ = game.createDebugHandle();
  }
}

boot().catch((err: unknown) => {
  log.error('Fatal boot error', err);
  showFatal('Start fehlgeschlagen', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
});
