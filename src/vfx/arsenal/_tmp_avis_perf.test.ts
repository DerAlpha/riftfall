import * as THREE from 'three';
import { describe, it } from 'vitest';
import { LightPool } from '../LightPool';
import { ParticleSystem } from '../ParticleSystem';
import { createSpriteAtlas } from '../spriteAtlas';
import { FakePhysics, FakeSockets, fakeRender, seeded } from '../testFakes';
import { ArsenalVfx } from './ArsenalVfx';

describe('tmp perf', () => {
  it('arsenal update cost', () => {
    const render = fakeRender();
    const particles = new ParticleSystem(createSpriteAtlas(), seeded(3));
    const lights = new LightPool(render.scene, seeded(4));
    const sockets = new FakeSockets(render.viewmodelScene);
    const a = new ArsenalVfx({ render, particles, lights, spawn: () => {}, physics: new FakePhysics().asApi(), sockets: () => sockets, random: seeded(7) });
    const ids = ['projectile.plasma', 'projectile.grenade', 'projectile.voidorb', 'projectile.shockorb', 'projectile.cryoorb', 'projectile.singularity'];
    const trails = ['trail.plasma', 'trail.smoke', 'trail.void', 'trail.shock', 'trail.frost', null];
    const hs: number[] = [];
    for (let i = 0; i < 64; i++) hs.push(a.projectileStart(ids[i % 6]!, trails[i % 6] as string | null, { x: i * 0.3, y: 1, z: -5 }, { x: 0, y: 0, z: -20 }));
    const fields = ['field.pull.void', 'field.damage.fire', 'field.damage.poison', 'field.slow.ice'];
    for (let i = 0; i < 20; i++) a.fieldStart(fields[i % 4]!, { x: i * 2, y: 0, z: -8 }, 3, 60);
    const cam = new THREE.PerspectiveCamera();
    const pos = { x: 0, y: 1, z: 0 };
    const vel = { x: 0, y: 0, z: -20 };
    const frame = (i: number) => {
      for (let k = 0; k < hs.length; k++) { pos.x = k * 0.3; pos.z = -5 - (i % 60) * 0.3; a.projectileMove(hs[k]!, pos, vel); }
      a.beam('beam.flame', { x: 0, y: 1.4, z: -0.5 }, { x: 0, y: 1.2, z: -9 }, [], 0);
      a.beam('beam.lightning', { x: 0.2, y: 1.4, z: -0.5 }, { x: 2, y: 1, z: -9 }, [], 0);
      lights.update(1 / 60); lights.endFrame();
      a.update(1 / 60);
      particles.update(1 / 60, cam);
    };
    for (let i = 0; i < 60; i++) frame(i);
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) frame(i);
    const ms = (performance.now() - t0) / 300;
    console.log('frame ms (arsenal+particles):', ms.toFixed(3), JSON.stringify(a.stats), 'particles', particles.count);
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) { lights.update(1 / 60); lights.endFrame(); particles.update(1 / 60, cam); }
    console.log('particles only ms:', ((performance.now() - t1) / 300).toFixed(3));
  });
});
