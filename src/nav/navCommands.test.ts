import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NavStats } from './NavSystem';
import { createNavCommands } from './navCommands';

function fakeNav() {
  const calls: boolean[] = [];
  const stats: NavStats = {
    agents: 3,
    polys: 120,
    buildMs: 42,
    tiles: 9,
    mode: 'navmesh',
    builtIn: 'worker',
    updateMs: 0.2,
    pendingTargets: 1,
  };
  let builds = 0;
  return {
    calls,
    get builds() {
      return builds;
    },
    nav: {
      ready: true,
      stats,
      setDebugVisible(v: boolean) {
        calls.push(v);
      },
      async build() {
        builds++;
        return true;
      },
    },
  };
}

describe('nav console command', () => {
  it('toggles the debug view, prints stats and rebuilds', async () => {
    const f = fakeNav();
    const [cmd] = createNavCommands({ nav: f.nav, scene: new THREE.Scene(), sources: () => [] });
    expect(cmd!.name).toBe('nav');
    expect(await cmd!.run([])).toMatch(/an/);
    expect(await cmd!.run([])).toMatch(/aus/);
    expect(await cmd!.run(['on'])).toMatch(/an/);
    expect(f.calls).toEqual([true, false, true]);
    expect(await cmd!.run(['stats'])).toMatch(/120 Polygone/);
    expect(await cmd!.run(['rebuild'])).toMatch(/Navmesh/);
    expect(f.builds).toBe(1);
    // The view stays on across the rebuild.
    expect(f.calls[f.calls.length - 1]).toBe(true);
    await expect(Promise.resolve().then(() => cmd!.run(['bogus']))).rejects.toThrow(/Unbekannte/);
    expect(cmd!.complete?.(['s'])).toEqual(['stats']);
  });
});
