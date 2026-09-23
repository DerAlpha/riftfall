/**
 * Dev console command for the navigation (register next to registerDevCommands):
 *   nav                 toggle the navmesh debug view
 *   nav on|off          show / hide it
 *   nav stats           navmesh + crowd statistics
 *   nav rebuild         rebuild the navmesh from the level's nav sources
 */
import type { Mesh, Object3D } from 'three';
import type { ConsoleCommand } from '../core/contracts';
import type { NavStats } from './NavSystem';

export interface NavCommandDeps {
  nav: {
    readonly ready: boolean;
    readonly stats: Readonly<NavStats>;
    setDebugVisible(visible: boolean, scene: Object3D): void;
    build(sources: readonly Mesh[]): Promise<boolean>;
  };
  scene: Object3D;
  /** Current level's nav sources (LevelInstance.navSources ?? collectNavSources(level.root)). */
  sources: () => readonly Mesh[];
}

const MODES = ['on', 'off', 'stats', 'rebuild'];

function formatStats(s: Readonly<NavStats>): string {
  const mode = s.mode === 'navmesh' ? `Navmesh (${s.builtIn})` : 'Direktsteuerung (kein Navmesh)';
  return (
    `${mode}: ${s.polys} Polygone, ${s.tiles} Kacheln, Bauzeit ${s.buildMs.toFixed(0)} ms\n` +
    `Agenten: ${s.agents}, wartende Ziele: ${s.pendingTargets}, Update ${s.updateMs.toFixed(3)} ms`
  );
}

export function createNavCommands(deps: NavCommandDeps): ConsoleCommand[] {
  let visible = false;
  return [
    {
      name: 'nav',
      description: 'Navmesh anzeigen / Statistik / neu bauen',
      usage: 'nav [on|off|stats|rebuild]',
      run: async ([mode]) => {
        if (mode === 'stats') return formatStats(deps.nav.stats);
        if (mode === 'rebuild') {
          const ok = await deps.nav.build(deps.sources());
          if (visible) deps.nav.setDebugVisible(true, deps.scene);
          return ok ? formatStats(deps.nav.stats) : 'Navmesh-Bau fehlgeschlagen – Gegner steuern direkt';
        }
        if (mode !== undefined && mode !== 'on' && mode !== 'off') {
          throw new Error(`Unbekannte Option "${mode}" (${MODES.join(', ')})`);
        }
        visible = mode === undefined ? !visible : mode === 'on';
        deps.nav.setDebugVisible(visible, deps.scene);
        if (!visible) return 'Navmesh-Ansicht aus';
        return deps.nav.ready
          ? 'Navmesh-Ansicht an'
          : 'Navmesh-Ansicht an (erscheint, sobald das Navmesh steht)';
      },
      complete: ([prefix = '']) => MODES.filter((m) => m.startsWith(prefix)),
    },
  ];
}
