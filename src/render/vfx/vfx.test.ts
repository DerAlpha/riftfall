import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DUST, TEST_ROOM_LAYOUT } from '../../defs/level';
import {
  DustParticles,
  coneDustRegion,
  coneVolumeM3,
  distributeCount,
  dustRegionsWithCones,
} from './DustParticles';
import { VolumetricCone, VolumetricShafts, type ConeVolume, type ShaftSegment } from './VolumetricCone';

describe('distributeCount', () => {
  it('splits a budget by share and sums exactly', () => {
    const out = distributeCount(1000, [0.5, 0.3, 0.2]);
    expect(out).toEqual([500, 300, 200]);
    const odd = distributeCount(7, [1, 1, 1]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(7);
    expect(distributeCount(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('VolumetricShafts', () => {
  const time = { value: 0 };
  const seg = (edgeA: THREE.Vector3): ShaftSegment => ({
    origin: { x: 1, y: 10, z: 2 },
    edgeA,
    edgeB: { x: 0, y: -0.1, z: 1 },
    extrude: { x: -4, y: -9, z: -3 },
    fadeU0: true,
    fadeU1: false,
  });

  it('maps the parallelepiped to the unit cube (inverse basis per volume)', () => {
    const shafts = new VolumetricShafts([seg(new THREE.Vector3(3, 0, 0))], new THREE.Color(1, 1, 1), 1, time);
    const vol = shafts.volumes[0]!;
    const p = new THREE.Vector3(1 + 3 - 4, 10 - 0.1 - 9, 2 + 1 - 3); // far corner (1,1,1)
    const local = p.sub(vol.origin).applyMatrix3(vol.inverse);
    expect(local.x).toBeCloseTo(1, 6);
    expect(local.y).toBeCloseTo(1, 6);
    expect(local.z).toBeCloseTo(1, 6);
    expect(shafts.mesh.geometry.index!.count).toBe(36);
    shafts.dispose();
  });

  it('keeps faces outward for mirrored bases (same volume, u reversed, fade flags swapped)', () => {
    const shafts = new VolumetricShafts(
      [seg(new THREE.Vector3(-3, 0, 0))],
      new THREE.Color(1, 1, 1),
      1,
      time,
    );
    const vol = shafts.volumes[0]!;
    // Basis was right-handed after the fix-up.
    expect(vol.inverse.determinant()).toBeGreaterThan(0);
    const fade = shafts.mesh.geometry.attributes.aFadeU!;
    expect(fade.getX(0)).toBe(0);
    expect(fade.getY(0)).toBe(1);
    // The original origin corner is now at u = 1.
    const o = new THREE.Vector3(1, 10, 2).sub(vol.origin).applyMatrix3(vol.inverse);
    expect(o.x).toBeCloseTo(1, 6);
    expect(o.y).toBeCloseTo(0, 6);
    shafts.dispose();
  });
});

describe('VolumetricCone', () => {
  it('orients the cone along the light and scales its dust volume color on flicker', () => {
    const cone = new VolumetricCone({
      apex: { x: 0, y: 10, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
      angle: 0.4,
      length: 9,
      color: new THREE.Color(1, 0.5, 0.25),
      intensity: 0.3,
      floorY: 0,
      time: { value: 0 },
    });
    cone.mesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(cone.mesh);
    expect(box.max.y).toBeCloseTo(10, 4);
    expect(box.min.y).toBeCloseTo(1, 4);
    cone.setIntensityScale(0.5);
    expect(cone.volume.color.r).toBeCloseTo(0.5, 6);
    cone.dispose();
  });
});

describe('DustParticles', () => {
  it('allocates once and only moves the draw range', () => {
    const dust = new DustParticles({ regions: TEST_ROOM_LAYOUT.dust, maxCount: 1000, time: { value: 0 } });
    expect(dust.maxCount).toBe(1000);
    dust.setCount(400.7);
    expect(dust.visibleCount).toBe(400);
    expect(dust.points.geometry.drawRange.count).toBe(400);
    dust.setCount(5000);
    expect(dust.visibleCount).toBe(1000);
    dust.setCount(0);
    expect(dust.points.visible).toBe(false);
    // Positions stay inside their regions (union bounds).
    const pos = dust.points.geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getX(i)).toBeGreaterThanOrEqual(-30);
      expect(pos.getX(i)).toBeLessThanOrEqual(30);
    }
    const cones = Array.from({ length: DUST.maxCones + 3 }, () => ({
      apex: new THREE.Vector3(),
      axis: new THREE.Vector3(0, -1, 0),
      tanAngle: 0.4,
      apexRadius: 0.3,
      length: 5,
      color: new THREE.Color(1, 1, 1),
    }));
    dust.setVolumes(cones, []);
    const u = (dust.points.material as THREE.ShaderMaterial).uniforms;
    expect(u.uConeCount!.value).toBe(DUST.maxCones);
    expect(u.uBoxCount!.value).toBe(0);
    dust.dispose();
  });
});

describe('dust regions around light cones', () => {
  const cone = (x: number): ConeVolume => ({
    apex: new THREE.Vector3(x, 10, 0),
    axis: new THREE.Vector3(0, -1, 0),
    tanAngle: Math.tan(0.3),
    apexRadius: 0.35,
    length: 10,
    color: new THREE.Color(1, 1, 1),
  });

  it('bounds a vertical cone by its end discs and stops above the landing surface', () => {
    const r = coneDustRegion(cone(2), 0.5, 0.1)!;
    const r1 = 0.35 + 10 * Math.tan(0.3);
    expect(r.min[0]).toBeCloseTo(2 - r1, 6);
    expect(r.max[0]).toBeCloseTo(2 + r1, 6);
    expect(r.min[2]).toBeCloseTo(-r1, 6);
    expect(r.max[1]).toBeCloseTo(10, 6);
    expect(r.min[1]).toBeCloseTo(0.1, 6);
    expect(r.share).toBe(0.5);
    expect(coneDustRegion(cone(0), 0, 0.1)).toBeNull();
  });

  it('keeps the total share and gives cones the configured fraction', () => {
    const ambient = TEST_ROOM_LAYOUT.dust;
    const regions = dustRegionsWithCones(ambient, [cone(0), cone(5)], 0.4, 0.1);
    expect(regions.length).toBe(ambient.length + 2);
    // Ambient shares are rescaled to 1 - coneShare, so the shares always sum to 1.
    const total = regions.reduce((s, r) => s + r.share, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(regions[ambient.length]!.share + regions[ambient.length + 1]!.share).toBeCloseTo(0.4, 6);
    expect(coneVolumeM3(cone(0))).toBeGreaterThan(0);
    // No cones: ambient regions unchanged.
    expect(dustRegionsWithCones(ambient, [], 0.4, 0.1)).toEqual([...ambient]);
  });
});
