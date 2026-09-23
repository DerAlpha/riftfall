/**
 * Perf smoke: 60 active enemies (40 swarmers, 14 spitters, 6 tanks) × 600 ticks chasing a moving
 * player – AI + perception rays + projectiles (+ the real detour crowd in the second case). Logs the
 * measured ms/tick; the assertion is a generous regression guard for CI machines (the budget on a
 * mid-range desktop is 2.5 ms/tick incl. nav, see ENEMY_AI.budget).
 */
import { describe, expect, it } from 'vitest';
import { Group, type Mesh } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { NavSystem } from '../nav/NavSystem';
import { buildTestLevelMeshes, disposeMeshes } from '../nav/testLevel';
import { ensureBvhPatched } from '../world/LevelKit';
import { EnemyManager } from './EnemyManager';
import { DT, FakePlayer, FakeVisuals, createEnemyHarness } from './testFakes';

const MIX: readonly [string, number][] = [
  ['swarmer', 40],
  ['spitter', 14],
  ['tank', 6],
];
const TICKS = 600;
const WARMUP = 60;
/** CI guard (ms/tick, average) – far above the real budget so slow runners do not flake. */
const GUARD_MS = 8;

function report(label: string, times: number[]): { avg: number; p95: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const max = sorted[sorted.length - 1]!;
  console.info(
    `[perf] ${label}: avg ${avg.toFixed(3)} ms/tick, p95 ${p95.toFixed(3)}, max ${max.toFixed(3)}`,
  );
  return { avg, p95, max };
}

describe('EnemyManager perf smoke', () => {
  it('60 enemies × 600 ticks (fake nav, real combat rays)', () => {
    const boxes = [
      { center: { x: -8, y: 2, z: -6 }, size: { x: 6, y: 4, z: 0.6 } },
      { center: { x: 8, y: 2, z: 6 }, size: { x: 0.6, y: 4, z: 6 } },
      { center: { x: 0, y: 1, z: 12 }, size: { x: 10, y: 2, z: 0.6 } },
      { center: { x: 14, y: 2, z: -12 }, size: { x: 2, y: 4, z: 2 } },
    ];
    const h = createEnemyHarness({ boxes });
    let n = 0;
    for (const [type, count] of MIX) {
      for (let i = 0; i < count; i++) {
        const a = (n++ / 60) * Math.PI * 2;
        const r = 14 + (n % 5) * 3;
        expect(h.manager.spawn(type, { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r })).not.toBeNull();
      }
    }
    expect(h.manager.alive).toBe(60);
    const times: number[] = [];
    for (let i = 0; i < TICKS + WARMUP; i++) {
      const t = i * DT;
      h.player.setPosition(Math.cos(t * 0.4) * 6, 0, Math.sin(t * 0.4) * 6);
      h.player.velocity.set(-Math.sin(t * 0.4) * 2.4, 0, Math.cos(t * 0.4) * 2.4);
      h.player.yaw = t;
      const t0 = performance.now();
      h.manager.fixedUpdate(DT);
      if (i >= WARMUP) times.push(performance.now() - t0);
    }
    const r = report('fake nav', times);
    expect(h.manager.alive).toBe(60);
    expect(h.player.totalDamage).toBeGreaterThan(0);
    expect(r.avg).toBeLessThan(GUARD_MS);
  });

  it('60 enemies × 600 ticks on the recast crowd (nav test level)', async () => {
    ensureBvhPatched();
    const meshes: Mesh[] = buildTestLevelMeshes();
    for (const m of meshes) {
      m.geometry.computeBoundsTree();
      m.name = 'level:concrete_wall'; // a known material (bullet/LOS surface)
    }
    const nav = new NavSystem({ createWorker: null });
    expect(await nav.build(meshes)).toBe(true);
    const events = new EventBus<GameEvents>();
    const combat = new CombatWorld({ events });
    const root = new Group();
    for (const m of meshes) root.add(m);
    combat.setLevel(root);
    const player = new FakePlayer(0, 0, 5);
    const visuals = new FakeVisuals();
    const manager = new EnemyManager({ events, combat, nav, visuals, target: player, seed: 'perf' });
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
    const navTimes: number[] = [];
    for (let i = 0; i < TICKS + WARMUP; i++) {
      const t = i * DT;
      player.setPosition(Math.cos(t * 0.5) * 4, 0, 5 + Math.sin(t * 0.5) * 2);
      player.velocity.set(-Math.sin(t * 0.5) * 2, 0, Math.cos(t * 0.5) * 1);
      const t0 = performance.now();
      manager.fixedUpdate(DT);
      if (i >= WARMUP) {
        times.push(performance.now() - t0);
        navTimes.push(nav.stats.updateMs);
      }
    }
    const r = report('recast crowd (AI + nav)', times);
    report('  of which nav.update', navTimes);
    expect(manager.alive).toBe(60);
    expect(r.avg).toBeLessThan(GUARD_MS);
    manager.dispose();
    nav.dispose();
    disposeMeshes(meshes);
  });
});
