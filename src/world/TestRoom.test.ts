/**
 * Builds the full Calibration Hall against the real Rapier physics world (no GPU needed: the
 * material library is a stub) and probes the collision layout with raycasts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type {
  AssetsApi,
  LevelInstance,
  MaterialLibraryApi,
  RenderApi,
  SettingsStore,
} from '../core/contracts';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import {
  createDefaultSettings,
  type GraphicsSettings,
  type Settings,
  type SettingsSection,
} from '../save/settingsSchema';
import { FLICKER, TEST_ROOM_LAYOUT as L } from '../defs/level';
import { isMaterialId } from '../defs/materials';
import { buildTestRoom, corridorRampBottomZ, southStairs } from './TestRoom';

const down = { x: 0, y: -1, z: 0 };

describe('buildTestRoom', () => {
  let physics: PhysicsWorld;
  let level: LevelInstance;
  const events = new EventBus<GameEvents>();
  const settingsObj: Settings = createDefaultSettings();
  const settings: SettingsStore = {
    current: settingsObj,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>) {
      Object.assign(settingsObj[section], patch);
      events.emit('settings:changed', { settings: settingsObj, sections: [section] });
    },
    replace() {},
    resetSection() {},
  };
  const requested = new Set<string>();
  const preloaded: string[] = [];
  const forwarded: GraphicsSettings[] = [];
  const materials: MaterialLibraryApi & { applyGraphicsSettings(g: GraphicsSettings): void } = {
    applyGraphicsSettings(g) {
      forwarded.push(g);
    },
    get(id: string) {
      requested.add(id);
      return new THREE.MeshStandardMaterial({ name: id });
    },
    async preload(ids, onProgress) {
      preloaded.push(...ids);
      onProgress?.(ids.length, ids.length);
    },
    dispose() {},
  };
  const progress: number[] = [];

  beforeAll(async () => {
    physics = await PhysicsWorld.create();
    level = await buildTestRoom({
      render: {} as RenderApi,
      physics,
      assets: {} as AssetsApi,
      materials,
      settings,
      events,
      onProgress: (_label, f) => progress.push(f),
    });
  });

  afterAll(() => physics.dispose());

  it('reports sane stats within the draw-call budget', () => {
    const s = level.stats;
    const dynamicCrates = L.crates.filter((c) => c.dynamic).length;
    expect(s.dynamicBodies).toBe(dynamicCrates);
    expect(s.lights).toBe(L.lights.spots.length + L.lights.points.length);
    expect(s.colliders).toBeGreaterThan(100);
    expect(s.meshes).toBeLessThan(60);
    expect(physics.stats.dynamicBodies).toBe(dynamicCrates);
    expect(level.atmosphere.id).toBe('testroom');
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  });

  it('preloads and uses only defined materials', () => {
    for (const id of requested) expect(isMaterialId(id)).toBe(true);
    for (const id of requested) expect(preloaded).toContain(id);
  });

  it('spawns the player on the concrete floor', () => {
    const p = level.spawn.position;
    const hit = physics.raycast({ x: p.x, y: p.y + 1, z: p.z }, down, 5);
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0, 3);
    expect(hit!.data?.surface).toBe('concrete');
    expect(level.spawn.yaw).toBe(0);
  });

  it('has solid mantle ledges and double-jump platforms at their heights', () => {
    for (const l of L.mantle.ledges) {
      const hit = physics.raycast(
        { x: (l.minX + l.maxX) / 2, y: 5, z: (L.mantle.minZ + L.mantle.maxZ) / 2 },
        down,
        10,
      );
      expect(hit!.point.y).toBeCloseTo(l.height, 3);
    }
    for (const p of L.doubleJump.platforms) {
      const hit = physics.raycast({ x: p.x, y: 6, z: p.z }, down, 10);
      expect(hit!.point.y).toBeCloseTo(p.height, 3);
    }
  });

  it('has a grate mezzanine deck, the pit floor and walkable ramps', () => {
    const c = (L.mezzanine.outer + L.mezzanine.inner) / 2;
    const deck = physics.raycast({ x: 3, y: 8, z: -c }, down, 10);
    expect(deck!.point.y).toBeCloseTo(L.mezzanine.deckY, 3);
    expect(deck!.data?.surface).toBe('grate');

    const pit = physics.raycast({ x: -27, y: 2, z: -12.5 }, down, 10);
    expect(pit!.point.y).toBeCloseTo(-L.pit.depth, 3);

    // Slide ramp: halfway down the ramp the surface is at half the deck height with an 18° normal.
    const lx = (L.corridor.laneMinX + L.corridor.laneMaxX) / 2;
    const mid = (L.corridor.deckMinZ + corridorRampBottomZ()) / 2;
    const ramp = physics.raycast({ x: lx, y: 8, z: mid }, down, 10);
    expect(ramp!.point.y).toBeCloseTo(L.mezzanine.deckY / 2, 2);
    expect(Math.acos(ramp!.normal.y) * (180 / Math.PI)).toBeCloseTo(L.corridor.rampSlopeDeg, 1);
    expect(ramp!.normal.z).toBeLessThan(0);

    // Stairs: smooth collider along the nosings.
    const s = southStairs();
    const sx = (L.stairs.minX + L.stairs.maxX) / 2;
    const stair = physics.raycast({ x: sx, y: 8, z: L.stairs.topZ + s.totalRun / 2 }, down, 10);
    expect(stair!.point.y).toBeGreaterThan(L.mezzanine.deckY * 0.4);
    expect(stair!.point.y).toBeLessThan(L.mezzanine.deckY * 0.65);
  });

  it('closes the control-block window bay with a glass pane collider', () => {
    const w = L.controlBlock.window;
    const y = (w.bottom + w.top) / 2;
    const hit = physics.raycast({ x: L.corridor.laneMinX - 3, y, z: w.centerZ }, { x: 1, y: 0, z: 0 }, 6);
    expect(hit).not.toBeNull();
    expect(hit!.data?.surface).toBe('glass');
    expect(hit!.point.x).toBeLessThan(L.corridor.laneMinX);
    // Beside the bay the facade itself is solid at the face plane.
    const wall = physics.raycast(
      { x: L.corridor.laneMinX - 3, y, z: w.centerZ + w.width },
      { x: 1, y: 0, z: 0 },
      6,
    );
    expect(wall!.point.x).toBeCloseTo(L.corridor.laneMinX, 3);
  });

  it('merged meshes carry BVH bounds trees for hitscan raycasts', () => {
    const meshes: THREE.Mesh[] = [];
    level.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.startsWith('level:')) meshes.push(m);
    });
    expect(meshes.length).toBeGreaterThan(10);
    for (const m of meshes) expect(m.geometry.boundsTree).toBeDefined();
    level.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 2, 25), new THREE.Vector3(0, -1, 0));
    ray.firstHitOnly = true;
    const hit = ray.intersectObjects(meshes, false)[0];
    expect(hit?.point.y).toBeCloseTo(0, 3);
  });

  it('follows graphics settings: local shadow budget and volumetrics', () => {
    const spots = (): THREE.SpotLight[] => {
      const out: THREE.SpotLight[] = [];
      level.root.traverse((o) => {
        if ((o as THREE.SpotLight).isSpotLight) out.push(o as THREE.SpotLight);
      });
      return out;
    };
    settings.update('graphics', { shadows: 'low' });
    expect(spots().filter((l) => l.castShadow).length).toBe(0);
    settings.update('graphics', { shadows: 'ultra' });
    expect(spots().filter((l) => l.castShadow).length).toBe(6);
    settings.update('graphics', { shadows: 'medium' });
    expect(spots().filter((l) => l.castShadow).length).toBe(2);

    const volumetric = (): THREE.Object3D[] =>
      level.root.children.filter(
        (o) => o.name === 'VolumetricCone' || o.name === 'VolumetricShafts' || o.name === 'DustParticles',
      );
    settings.update('graphics', { volumetrics: 'off' });
    expect(volumetric().every((o) => !o.visible)).toBe(true);
    settings.update('graphics', { volumetrics: 'high' });
    expect(volumetric().every((o) => o.visible)).toBe(true);

    // Graphics changes reach the material library even when it was built without the event bus.
    const before = forwarded.length;
    settings.update('graphics', { anisotropy: 4 });
    expect(forwarded.length).toBe(before + 1);
    expect(forwarded[forwarded.length - 1]!.anisotropy).toBe(4);
  });

  it('animates flickering lights without throwing', () => {
    const flicker = L.lights.spots.findIndex((s) => s.flicker);
    expect(flicker).toBeGreaterThanOrEqual(0);
    const intensities = new Set<number>();
    const spot = (): THREE.SpotLight => {
      const out: THREE.SpotLight[] = [];
      level.root.traverse((o) => {
        if ((o as THREE.SpotLight).isSpotLight) out.push(o as THREE.SpotLight);
      });
      return out[flicker]!;
    };
    for (let i = 0; i < 600; i++) {
      level.update(1 / 60, i / 60);
      intensities.add(Math.round(spot().intensity));
    }
    expect(intensities.size).toBeGreaterThan(3);
  });

  it('only dims flickering lights gently while reduce flashing is on', () => {
    const lights: THREE.Light[] = [];
    const panels: THREE.MeshStandardMaterial[] = [];
    level.root.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
      const mat = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).material : null;
      if (mat instanceof THREE.MeshStandardMaterial && mat.name.endsWith(':flicker')) panels.push(mat);
    });
    expect(panels.length).toBeGreaterThan(0);
    const targets: (() => number)[] = [
      ...lights.map((l) => () => l.intensity),
      ...panels.map((m) => () => m.emissiveIntensity),
    ];
    const min = targets.map(() => Infinity);
    const max = targets.map(() => 0);
    const prev = targets.map(() => NaN);
    let maxStep = 0;
    settings.update('accessibility', { reduceFlashing: true });
    try {
      for (let i = 0; i < 1800; i++) {
        level.update(1 / 60, i / 60);
        targets.forEach((read, j) => {
          const v = read();
          min[j] = Math.min(min[j]!, v);
          max[j] = Math.max(max[j]!, v);
          if (prev[j]! > 0) maxStep = Math.max(maxStep, Math.abs(v - prev[j]!) / prev[j]!);
          prev[j] = v;
        });
      }
    } finally {
      settings.update('accessibility', { reduceFlashing: false });
    }
    for (let j = 0; j < targets.length; j++) {
      if (max[j]! <= 0) continue;
      expect(min[j]! / max[j]!).toBeGreaterThanOrEqual(1 - FLICKER.reduced.depth - 1e-6);
    }
    // Smooth dimming: no frame-to-frame jump anywhere near a strobe.
    expect(maxStep).toBeLessThan(0.01);
    // Turning the option off restores the regular flicker.
    const flicker = L.lights.spots.findIndex((s) => s.flicker);
    const spots = lights.filter((l): l is THREE.SpotLight => (l as THREE.SpotLight).isSpotLight);
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      level.update(1 / 60, i / 60);
      seen.add(Math.round(spots[flicker]!.intensity));
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('removes all physics objects on dispose', async () => {
    const p = await PhysicsWorld.create();
    const lvl = await buildTestRoom({
      render: {} as RenderApi,
      physics: p,
      assets: {} as AssetsApi,
      materials,
      settings,
      events,
      onProgress: () => {},
    });
    expect(p.stats.colliders).toBeGreaterThan(0);
    const listeners = events.listenerCount('settings:changed');
    lvl.dispose();
    p.step(1 / 60);
    expect(p.stats.colliders).toBe(0);
    expect(p.stats.bodies).toBe(0);
    expect(events.listenerCount('settings:changed')).toBe(listeners - 1);
    p.dispose();
  });
});
