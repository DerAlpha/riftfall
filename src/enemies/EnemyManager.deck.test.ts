/**
 * Enemies chase a player up onto a deck (real navmesh + detour crowd, like the lab's atrium ring):
 * ring / stand-off points around a player on a narrow deck hang in the air beside it – they snap to
 * nothing (or to the hall below), and enemies sent there must not wait below or freeze on the ramp.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { NavSystem } from '../nav/NavSystem';
import { ensureBvhPatched } from '../world/LevelKit';
import { EnemyManager } from './EnemyManager';
import { DT, FakePlayer, FakeVisuals } from './testFakes';

/** Hall floor, a 12 × 3 m deck 5 m up (the floor below stays walkable) and a ramp up to it. */
const DECK = { minX: -6, maxX: 6, minZ: -11, maxZ: -8, top: 5, thickness: 0.3 };
const RAMP_RUN = 12;

function box(w: number, h: number, d: number, x: number, y: number, z: number, rotZ = 0): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d));
  m.name = 'level:concrete_wall';
  m.position.set(x, y, z);
  m.rotation.z = rotZ;
  m.updateMatrixWorld(true);
  m.geometry.computeBoundsTree();
  return m;
}

function buildDeckLevel(): Mesh[] {
  const d = DECK;
  const w = d.maxX - d.minX;
  const depth = d.maxZ - d.minZ;
  const cz = (d.minZ + d.maxZ) / 2;
  const angle = Math.atan2(d.top, RAMP_RUN);
  const len = Math.hypot(d.top, RAMP_RUN);
  const t = 0.2;
  return [
    box(60, 0.2, 60, 0, -0.1, 0),
    box(w, d.thickness, depth, (d.minX + d.maxX) / 2, d.top - d.thickness / 2, cz),
    // Ramp: top face from (maxX + RAMP_RUN, 0) up to (maxX, top), rising towards −X.
    box(
      len,
      t,
      depth,
      d.maxX + RAMP_RUN / 2 + (t / 2) * Math.sin(angle),
      d.top / 2 - (t / 2) * Math.cos(angle),
      cz,
      -angle,
    ),
  ];
}

describe('EnemyManager: a player on a deck', () => {
  ensureBvhPatched();
  const meshes = buildDeckLevel();
  let nav: NavSystem;

  beforeAll(async () => {
    nav = new NavSystem({ createWorker: null });
    expect(await nav.build(meshes)).toBe(true);
  });

  afterAll(() => {
    nav.dispose();
    for (const m of meshes) m.geometry.dispose();
  });

  it('swarmers and tanks from the hall below take the ramp up to it', () => {
    const events = new EventBus<GameEvents>();
    const combat = new CombatWorld({ events });
    const root = new Group();
    for (const m of meshes) root.add(m);
    combat.setLevel(root);
    const player = new FakePlayer(0, DECK.top, (DECK.minZ + DECK.maxZ) / 2);
    const manager = new EnemyManager({
      events,
      combat,
      nav,
      visuals: new FakeVisuals(),
      target: player,
      seed: 'deck',
    });
    // Below and in front of the deck.
    for (let i = 0; i < 10; i++) {
      const x = -8 + (i % 5) * 4;
      const z = i < 5 ? -4 : -9.5;
      expect(manager.spawn(i % 5 === 2 ? 'tank' : 'swarmer', { x, y: 0, z })).not.toBeNull();
    }
    for (let t = 0; t < Math.round(25 / DT); t++) {
      player.clock = t * DT;
      manager.fixedUpdate(DT);
    }
    const below = manager.enemies.filter((e) => e.position.y < DECK.top - 0.5);
    expect(below.map((e) => `${e.type} ${e.position.toArray().map((v) => v.toFixed(1))}`)).toEqual([]);
    expect(player.hits.length).toBeGreaterThan(0);
    manager.dispose();
  }, 30000);
});
