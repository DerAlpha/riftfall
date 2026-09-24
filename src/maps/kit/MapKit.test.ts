/**
 * The map kit on the real research lab (built in node with stub materials, like the placement
 * tests): traps, generators, quest objects and the anomaly build with their visuals (no renderer),
 * the traps' panels are reachable interactables in their zones, every trap / event / quest step runs
 * a few seconds of ticks and frames without throwing, and a run reset brings everything back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  AssetsApi,
  DamageInfo,
  Damageable,
  Interactable,
  LevelInstance,
  MaterialLibraryApi,
  RenderApi,
  SettingsStore,
} from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { TRAP_SLOTS } from '../../defs/traps';
import { GENERATORS } from '../../defs/mapEvents';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { createDefaultSettings } from '../../save/settingsSchema';
import { buildResearchLab } from '../lab/ResearchLab';
import { isMapLevel } from '../types';
import type { KitCombat } from './kitTypes';
import { MapKit, createPowerGrid } from './MapKit';

const DT = 1 / 60;

class Combat implements KitCombat {
  readonly targets: Damageable[] = [];
  register(t: Damageable): void {
    this.targets.push(t);
  }
  unregister(t: Damageable): void {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }
  raycast(): null {
    return null;
  }
  queryRadius(_c: unknown, _r: number, out: Damageable[]): Damageable[] {
    out.length = 0;
    return out;
  }
  dealDamage(t: Damageable, info: DamageInfo) {
    return t.applyDamage(info);
  }
  lineOfSight(): boolean {
    return true;
  }
}

describe('MapKit on the research lab', () => {
  let physics: PhysicsWorld;
  let level: LevelInstance;
  let kit: MapKit;
  const scene = new THREE.Scene();
  const events = new EventBus<GameEvents>();
  const registered: Interactable[] = [];
  const spawned: string[] = [];
  const player = {
    position: new THREE.Vector3(0, 0, 24),
    eyePosition: new THREE.Vector3(0, 1.6, 24),
    alive: true,
    damage: () => 0,
  };

  beforeAll(async () => {
    physics = await PhysicsWorld.create();
    const settings = {
      current: createDefaultSettings(),
      update() {},
      replace() {},
      resetSection() {},
    } as unknown as SettingsStore;
    const materials: MaterialLibraryApi = {
      get: (id: string) => new THREE.MeshStandardMaterial({ name: id }),
      async preload() {},
      dispose() {},
    };
    level = await buildResearchLab({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events,
      onProgress() {},
    });
    scene.add(level.root);
    const power = createPowerGrid(level, events, false);
    kit = new MapKit({
      level,
      mapId: 'lab',
      events,
      power,
      combat: new Combat(),
      economy: { spend: () => true, earn: (a) => a },
      interaction: { register: (i) => registered.push(i), unregister: () => {}, focused: null, holdProgress: 0 },
      zones: { isActive: () => true },
      enemies: { spawn: (type) => (spawned.push(type), spawned.length) },
      enemyType: () => null,
      isKnownEnemyType: () => true,
      waves: { wave: 8, state: 'active', plan: { health: 1, speed: 1, damage: 1 } },
      player,
      weapons: { give: () => {} },
      perks: null,
      visuals: { scene, materials, setupMaterial: () => {}, reduceFlashing: false },
      seed: 'kit-test',
    });
  });

  afterAll(() => {
    kit.dispose();
    level.dispose();
    physics.dispose();
  });

  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += DT) {
      kit.fixedUpdate(DT);
      kit.update(DT, player.eyePosition);
    }
  };

  it('builds the lab traps, generators and quest objects with their visuals', () => {
    expect(kit.traps.list.map((t) => t.id)).toEqual(TRAP_SLOTS.lab!.map((s) => s.id));
    expect(kit.director.generators.length).toBe(GENERATORS.lab!.length);
    expect(kit.quest.questId).toBe('kepler');
    expect(kit.bossArena?.zone).toBe('atrium');
    expect(kit.musicTheme).toBe('lab');
    expect(kit.hasVolumetricContent).toBe(true);
    // Panels + generators + the quest socket are interactables.
    expect(registered.length).toBe(TRAP_SLOTS.lab!.length + GENERATORS.lab!.length + 1);
    // Trap bodies are merged props: not `level:` meshes (bullets pass), never nav sources.
    const props: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith('prop:')) props.push(o as THREE.Mesh);
    });
    expect(props.length).toBeGreaterThan(5);
    expect(props.every((m) => m.userData.navIgnore === true)).toBe(true);
  });

  it('trap panels sit on a wall face inside their zone', () => {
    if (!isMapLevel(level)) throw new Error('lab is a wave map');
    for (const slot of TRAP_SLOTS.lab!) {
      const [x, , z] = slot.panel.position;
      const n = slot.panel.facing;
      const dx = n === 'px' ? 0.5 : n === 'nx' ? -0.5 : 0;
      const dz = n === 'pz' ? 0.5 : n === 'nz' ? -0.5 : 0;
      expect(level.zoneAt(x + dx, z + dz), slot.id).not.toBeNull();
    }
  });

  it('runs every trap, event and quest step without errors; a reset restores the start state', () => {
    for (const t of kit.traps.list) expect(t.activate()).toBe(true);
    run(1);
    expect(kit.director.trigger('lab_blackout')).toBe(true);
    expect(kit.power.powered).toBe(false);
    expect(kit.director.trigger('lab_gravity')).toBe(true);
    expect(kit.director.trigger('lab_invasion')).toBe(true);
    run(3);
    expect(spawned.length).toBeGreaterThan(0);
    expect(kit.gravity.size).toBe(1);
    for (let i = 0; i < 4; i++) {
      kit.quest.advance();
      run(0.3);
    }
    expect(kit.quest.completed).toBe(true);
    kit.reset('next-run');
    expect(kit.power.powered).toBe(true);
    expect(kit.gravity.size).toBe(0);
    expect(kit.director.active).toEqual([]);
    expect(kit.traps.list.every((t) => t.state === 'ready')).toBe(true);
    expect(kit.quest.step).toBe(0);
    run(0.5);
  });
});
