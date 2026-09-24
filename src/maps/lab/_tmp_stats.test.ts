import { it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import type { AssetsApi, MaterialLibraryApi, RenderApi, SettingsStore } from '../../core/contracts';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { NavSystem } from '../../nav/NavSystem';
import { createDefaultSettings } from '../../save/settingsSchema';
import { buildResearchLab } from './ResearchLab';

it('stats', async () => {
  const physics = await PhysicsWorld.create();
  const settings = { current: createDefaultSettings(), update() {}, replace() {}, resetSection() {} } as unknown as SettingsStore;
  const materials: MaterialLibraryApi = { get: (id) => new THREE.MeshStandardMaterial({ name: id }), async preload() {}, dispose() {} };
  const level = await buildResearchLab({ render: {} as RenderApi, physics, assets: {} as AssetsApi, materials, settings, events: new EventBus<GameEvents>(), onProgress() {} });
  const names: string[] = [];
  level.root.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) names.push(o.name); });
  console.log('stats', JSON.stringify(level.stats), 'drawables', names.length, 'navSources', level.navSources?.length);
  console.log(names.join('\n'));
  const nav = new NavSystem({ createWorker: null });
  const t0 = performance.now();
  await nav.build(level.navSources ?? []);
  console.log('nav', JSON.stringify(nav.stats), (performance.now() - t0).toFixed(0), 'ms');
  let tris = 0; level.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry.index) tris += m.geometry.index.count / 3; });
  console.log('tris', tris);
}, 120000);
