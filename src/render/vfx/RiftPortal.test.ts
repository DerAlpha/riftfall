import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RENDER } from '../../defs/graphics';
import { RIFT_PORTAL } from '../../defs/labLayout';
import {
  RiftPortal,
  RiftPortalField,
  addPulse,
  decayPulse,
  tearMatrix,
  type RiftTearPlacement,
} from './RiftPortal';

const time = { value: 0 };

function tear(x: number, z: number, extra: Partial<RiftTearPlacement> = {}): RiftTearPlacement {
  return {
    position: { x, y: 1, z },
    normal: { x: 0, y: 0, z: 1 },
    width: 1,
    height: 2,
    seed: x + z,
    ...extra,
  };
}

describe('rift pulses', () => {
  it('decays exponentially and snaps tiny values to zero', () => {
    const rate = RIFT_PORTAL.pulse.decay;
    expect(decayPulse(1, 1)).toBeCloseTo(Math.exp(-rate), 6);
    expect(decayPulse(1, 0)).toBe(1);
    expect(decayPulse(1, -1)).toBe(1);
    expect(decayPulse(1e-4, 0)).toBe(0);
    expect(decayPulse(0, 1 / 60)).toBe(0);
  });

  it('keeps the strongest pulse, clamped, and ignores invalid strengths', () => {
    expect(addPulse(0.5, 1)).toBe(1);
    expect(addPulse(1, 0.5)).toBe(1);
    expect(addPulse(0, 100)).toBe(RIFT_PORTAL.pulse.max);
    expect(addPulse(0.3, -1)).toBe(0.3);
    expect(addPulse(0.3, Number.NaN)).toBe(0.3);
  });
});

describe('tearMatrix', () => {
  it('builds an orthogonal basis scaled to the half extents, +Z along the normal', () => {
    const m = tearMatrix(
      tear(2, 3, { normal: { x: 1, y: 0, z: 0 }, width: 1.2, height: 2.6 }),
      new THREE.Matrix4(),
    );
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    m.extractBasis(x, y, z);
    expect(x.length()).toBeCloseTo(0.6, 6);
    expect(y.length()).toBeCloseTo(1.3, 6);
    expect(z.x).toBeCloseTo(1, 6);
    // The long axis stays upright on a wall.
    expect(y.y).toBeCloseTo(1.3, 6);
    expect(x.dot(y)).toBeCloseTo(0, 6);
    expect(x.dot(z)).toBeCloseTo(0, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([2, 1, 3]);
  });

  it('lays floor tears flat with the requested long axis', () => {
    const m = tearMatrix(
      tear(0, 0, { normal: { x: 0, y: 1, z: 0 }, up: { x: 1, y: 0, z: 0 } }),
      new THREE.Matrix4(),
    );
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    m.extractBasis(x, y, z);
    expect(z.y).toBeCloseTo(1, 6);
    expect(y.x).toBeCloseTo(1, 6);
    expect(Math.abs(x.y)).toBeLessThan(1e-6);
  });

  it('survives degenerate input (zero normal, up parallel to the normal)', () => {
    const m = tearMatrix(
      tear(0, 0, { normal: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } }),
      new THREE.Matrix4(),
    );
    for (const v of m.elements) expect(Number.isFinite(v)).toBe(true);
    expect(m.determinant()).not.toBe(0);
  });
});

describe('RiftPortalField', () => {
  it('draws every tear in one instanced call on the volumetric layer', () => {
    const f = new RiftPortalField([tear(0, 0), tear(5, 0), tear(0, 9)], { time });
    expect(f.mesh.count).toBe(3);
    expect(f.mesh.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
    expect(f.mesh.layers.isEnabled(0)).toBe(false);
    const m = f.mesh.material as THREE.ShaderMaterial;
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    f.dispose();
  });

  it('finds the nearest tear within range', () => {
    const f = new RiftPortalField([tear(0, 0), tear(5, 0), tear(0, 9)], { time });
    expect(f.nearest({ x: 4, y: 1, z: 0 }, 2)).toBe(1);
    expect(f.nearest({ x: 0, y: 1, z: 7.5 }, 2)).toBe(2);
    expect(f.nearest({ x: 20, y: 1, z: 20 }, 2)).toBe(-1);
    f.dispose();
  });

  it('uploads pulses to the instance attribute and decays them back to idle', () => {
    const f = new RiftPortalField([tear(0, 0), tear(5, 0)], { time });
    const attr = f.mesh.geometry.getAttribute('aTear') as THREE.InstancedBufferAttribute;
    f.pulse(1, 1);
    f.pulse(7, 1); // out of range: ignored
    f.update(0);
    expect(attr.getY(1)).toBeCloseTo(1, 6);
    expect(attr.getY(0)).toBe(0);
    f.update(0.5);
    expect(attr.getY(1)).toBeCloseTo(Math.exp(-RIFT_PORTAL.pulse.decay * 0.5), 6);
    f.pulseAll(0.5);
    f.update(0);
    expect(attr.getY(0)).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 600; i++) f.update(1 / 60);
    expect(f.pulseOf(0)).toBe(0);
    expect(f.pulseOf(1)).toBe(0);
    expect(attr.getY(1)).toBe(0);
    f.dispose();
  });

  it('handles an empty field', () => {
    const f = new RiftPortalField([], { time });
    expect(f.mesh.visible).toBe(false);
    expect(f.nearest({ x: 0, y: 0, z: 0 }, 10)).toBe(-1);
    f.pulseAll(1);
    f.update(1);
    f.dispose();
  });
});

describe('RiftPortal (large anomaly)', () => {
  it('builds the vortex, the tear cluster, particles and a light on the volumetric layer', () => {
    const r = new RiftPortal({ position: { x: 0, y: 7.5, z: -1 }, time, light: true });
    const drawables: THREE.Object3D[] = [];
    r.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) drawables.push(o);
    });
    expect(drawables.length).toBe(3);
    for (const d of drawables) expect(d.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
    expect(r.tears.count).toBe(RIFT_PORTAL.large.tearCount);
    expect(r.light).not.toBeNull();
    expect(r.root.position.toArray()).toEqual([0, 7.5, -1]);
    r.dispose();
    expect(r.root.children.length).toBe(0);
  });

  it('pulses the light and the cluster, less with reduced flashing, then settles', () => {
    const r = new RiftPortal({ position: { x: 0, y: 0, z: 0 }, time, light: true });
    const L = RIFT_PORTAL.large.light;
    r.update(0);
    const idle = r.light!.intensity;
    expect(idle).toBeGreaterThan(0);
    r.pulse(1);
    r.update(0);
    const flare = r.light!.intensity / idle;
    expect(flare).toBeCloseTo(1 + L.pulseBoost, 3);
    expect(r.tears.pulseOf(0)).toBeCloseTo(1, 6);
    r.setReducedFlashing(true);
    r.update(0);
    expect(r.light!.intensity / idle).toBeCloseTo(1 + L.pulseBoost * L.reducedPulseBoost, 3);
    for (let i = 0; i < 1200; i++) r.update(1 / 60);
    expect(r.pulseLevel).toBe(0);
    // Breathing stays within its band.
    expect(r.light!.intensity).toBeLessThanOrEqual(L.intensity * (1 + L.breathe) + 1e-6);
    expect(r.light!.intensity).toBeGreaterThanOrEqual(L.intensity * (1 - L.breathe) - 1e-6);
    r.dispose();
  });

  it('scales the visible flare of the vortex, particles and tears with reduced flashing', () => {
    const r = new RiftPortal({ position: { x: 0, y: 0, z: 0 }, time, light: false });
    const uniform = (name: string, u: string): number => {
      let v = Number.NaN;
      r.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (o.name === name && m?.uniforms) v = (m.uniforms[u] as THREE.IUniform<number>).value;
      });
      return v;
    };
    r.pulse(1);
    r.update(0);
    expect(uniform('RiftVortex', 'uPulse')).toBeCloseTo(1, 6);
    expect(uniform('RiftParticles', 'uPulse')).toBeCloseTo(1, 6);
    expect(uniform('RiftCluster', 'uPulseScale')).toBe(1);
    r.setReducedFlashing(true);
    r.update(0);
    const k = RIFT_PORTAL.pulse.reducedScale;
    expect(k).toBeLessThan(1);
    expect(uniform('RiftVortex', 'uPulse')).toBeCloseTo(k, 6);
    expect(uniform('RiftParticles', 'uPulse')).toBeCloseTo(k, 6);
    expect(uniform('RiftCluster', 'uPulseScale')).toBeCloseTo(k, 6);
    r.setReducedFlashing(false);
    expect(uniform('RiftCluster', 'uPulseScale')).toBe(1);
    r.dispose();

    const f = new RiftPortalField([tear(0, 0)], { time });
    const m = f.mesh.material as THREE.ShaderMaterial;
    f.setReducedFlashing(true);
    expect((m.uniforms.uPulseScale as THREE.IUniform<number>).value).toBeCloseTo(k, 6);
    f.dispose();
  });

  it('culls the billboard and the particles by bounds that cover them', () => {
    const r = new RiftPortal({ position: { x: 3, y: 7.5, z: -1 }, time, light: false });
    r.root.updateMatrixWorld(true);
    const L = RIFT_PORTAL.large;
    const byName = (n: string): THREE.Mesh | THREE.Points =>
      r.root.getObjectByName(n) as THREE.Mesh | THREE.Points;
    const vortex = byName('RiftVortex');
    const particles = byName('RiftParticles');
    for (const o of [vortex, particles]) expect(o.frustumCulled).toBe(true);
    expect(vortex.geometry.boundingSphere!.radius).toBeGreaterThanOrEqual(L.haloRadius * Math.SQRT2 - 1e-9);
    expect(particles.geometry.boundingSphere!.radius).toBeGreaterThanOrEqual(L.particles.radiusMax);
    // Bounds are centered on the anomaly in world space.
    const c = vortex.geometry.boundingSphere!.center.clone().applyMatrix4(vortex.matrixWorld);
    expect(c.toArray()).toEqual([3, 7.5, -1]);
    r.dispose();
  });

  it('thins out or hides the particles and can skip the light', () => {
    const r = new RiftPortal({ position: { x: 0, y: 0, z: 0 }, time, light: false });
    expect(r.light).toBeNull();
    r.setParticleFraction(0.5);
    expect(r.particles.geometry.drawRange.count).toBe(Math.floor(RIFT_PORTAL.large.particles.count * 0.5));
    expect(r.particles.visible).toBe(true);
    r.setParticleFraction(0);
    expect(r.particles.visible).toBe(false);
    r.setParticleFraction(5);
    expect(r.particles.geometry.drawRange.count).toBe(RIFT_PORTAL.large.particles.count);
    r.update(1 / 60);
    r.dispose();
  });
});
