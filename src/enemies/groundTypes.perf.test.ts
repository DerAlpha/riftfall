/**
 * Perf smoke for the M6 ground types: 60 enemies (24 mites, 14 leapers, 14 berserkers, 8 exploders)
 * × 600 ticks on the real detour crowd with the real EnemyRenderer's CPU pose / hitboxes, chasing a
 * moving player. Same generous CI guard as EnemyManager.perf.test.ts (the budget on a mid-range
 * desktop is 2.5 ms/tick incl. nav). Exploders blow up near the player on the way: the count drops.
 */
import { describe, expect, it } from 'vitest';
import { Group, Scene, type Mesh } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { NavSystem } from '../nav/NavSystem';
import { buildTestLevelMeshes, disposeMeshes } from '../nav/testLevel';
import { ensureBvhPatched } from '../world/LevelKit';
import { EnemyManager } from './EnemyManager';
import { EnemyRenderer } from './render/EnemyRenderer';
import { DT, FakePlayer } from './testFakes';

const MIX: readonly [string, number][] = [
  ['mite', 24],
  ['leaper', 14],
  ['berserker', 14],
  ['exploder', 8],
];
const TICKS = 600;
const WARMUP = 60;
const GUARD_MS = 8;

describe('M6 ground types perf smoke', () => {
  it('60 ground enemies × 600 ticks on the recast crowd with the real renderer rig', async () => {
    ensureBvhPatched();
    const meshes: Mesh[] = buildTestLevelMeshes();
    for (const m of meshes) {
      m.geometry.computeBoundsTree();
      m.name = 'level:concrete_wall';
    }
    const nav = new NavSystem({ createWorker: null });
    expect(await nav.build(meshes)).toBe(true);
    const events = new EventBus<GameEvents>();
    const combat = new CombatWorld({ events });
    const root = new Group();
    for (const m of meshes) root.add(m);
    combat.setLevel(root);
    const player = new FakePlayer(0, 0, 5);
    const visuals = new EnemyRenderer({
      scene: new Scene(),
      render: { setupMaterial() {} },
      surfaceTexture: false,
    });
    const manager = new EnemyManager({ events, combat, nav, visuals, target: player, seed: 'perf-ground' });
    let spawned = 0;
    for (const [type, count] of MIX) {
      for (let i = 0; i < count; i++) {
        const a = (spawned / 60) * Math.PI * 2;
        const r = 3 + (spawned % 4) * 1.8;
        const z = spawned % 2 === 0 ? -5 : 5;
        if (manager.spawn(type, { x: Math.cos(a) * r, y: 0, z: z + Math.sin(a) * 2 }) !== null) spawned++;
      }
    }
    expect(spawned).toBe(60);
    const times: number[] = [];
    for (let i = 0; i < TICKS + WARMUP; i++) {
      const t = i * DT;
      player.setPosition(Math.cos(t * 0.5) * 4, 0, 5 + Math.sin(t * 0.5) * 2);
      player.velocity.set(-Math.sin(t * 0.5) * 2, 0, Math.cos(t * 0.5) * 1);
      const t0 = performance.now();
      manager.fixedUpdate(DT);
      if (i >= WARMUP) times.push(performance.now() - t0);
    }
    const sorted = [...times].sort((x, y) => x - y);
    const avg = times.reduce((s, v) => s + v, 0) / times.length;
    console.info(
      `[perf] ground mix: avg ${avg.toFixed(3)} ms/tick, p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(3)}, ` +
        `alive ${manager.alive}`,
    );
    expect(player.totalDamage).toBeGreaterThan(0);
    expect(avg).toBeLessThan(GUARD_MS);
    manager.dispose();
    visuals.dispose();
    nav.dispose();
    disposeMeshes(meshes);
  });
});
