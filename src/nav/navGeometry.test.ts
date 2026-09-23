import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { collectNavSources, gatherNavGeometry } from './navGeometry';

function tri(): THREE.BufferGeometry {
  // One up-facing triangle (CCW seen from above) in the XZ plane.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1, 1, 0, 0], 3));
  return g;
}

function normalY(pos: Float32Array, idx: Uint32Array, t: number): number {
  const p = (i: number) =>
    new THREE.Vector3(pos[idx[t * 3 + i]! * 3], pos[idx[t * 3 + i]! * 3 + 1], pos[idx[t * 3 + i]! * 3 + 2]);
  const a = p(0);
  const e1 = p(1).sub(a);
  const e2 = p(2).sub(a);
  return e1.cross(e2).y;
}

describe('gatherNavGeometry', () => {
  it('applies world matrices and offsets indices per mesh', () => {
    const root = new THREE.Group();
    root.position.set(0, 2, 0);
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    a.position.set(10, 0, 0);
    const b = new THREE.Mesh(tri());
    root.add(a, b);
    root.updateMatrixWorld(true);
    const geo = gatherNavGeometry([a, b]);
    expect(geo.meshes).toBe(2);
    expect(geo.triangles).toBe(12 + 1);
    expect(geo.positions.length).toBe((24 + 3) * 3);
    // Box vertex x ∈ 10 ± 0.5, y ∈ 2 ± 0.5.
    expect(Math.min(...geo.positions.filter((_, i) => i % 3 === 0).slice(0, 24))).toBeCloseTo(9.5);
    expect(geo.positions[1]).toBeCloseTo(2.5);
    // Triangle indices start after the 24 box vertices; its vertices sit at y = 2.
    expect(Array.from(geo.indices.slice(36))).toEqual([24, 25, 26]);
    expect(geo.positions[24 * 3 + 1]).toBeCloseTo(2);
    expect(normalY(geo.positions, geo.indices, 12)).toBeGreaterThan(0);
  });

  it('keeps floors facing up under mirrored transforms', () => {
    const m = new THREE.Mesh(tri());
    m.scale.set(-1, 1, 1);
    m.updateMatrixWorld(true);
    const geo = gatherNavGeometry([m]);
    expect(normalY(geo.positions, geo.indices, 0)).toBeGreaterThan(0);
  });

  it('skips navIgnore, broken and non-finite meshes', () => {
    const ok = new THREE.Mesh(tri());
    const ignored = new THREE.Mesh(tri());
    ignored.userData.navIgnore = true;
    const empty = new THREE.Mesh(new THREE.BufferGeometry());
    const nan = new THREE.Mesh(tri());
    nan.position.set(Number.NaN, 0, 0);
    for (const m of [ok, ignored, empty, nan]) m.updateMatrixWorld(true);
    const geo = gatherNavGeometry([ok, ignored, empty, nan]);
    expect(geo.meshes).toBe(1);
    expect(geo.triangles).toBe(1);
    expect(geo.positions.length).toBe(9);
    expect(Array.from(geo.indices)).toEqual([0, 1, 2]);
  });

  it('drops triangles with out-of-range indices', () => {
    const g = tri();
    g.setIndex([0, 1, 2, 0, 1, 7]);
    const geo = gatherNavGeometry([new THREE.Mesh(g)]);
    expect(geo.triangles).toBe(1);
  });

  it('expands instanced meshes', () => {
    const inst = new THREE.InstancedMesh(tri(), new THREE.MeshBasicMaterial(), 3);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 3; i++) inst.setMatrixAt(i, m.makeTranslation(i * 5, 0, 0));
    inst.updateMatrixWorld(true);
    const geo = gatherNavGeometry([inst]);
    expect(geo.triangles).toBe(3);
    expect(geo.positions[2 * 9]).toBeCloseTo(10);
  });
});

describe('collectNavSources', () => {
  it('collects static level meshes and skips everything else', () => {
    const root = new THREE.Group();
    const floor = new THREE.Mesh(tri());
    floor.name = 'level:concrete';
    const panel = new THREE.Mesh(tri());
    panel.name = 'panel:light_panel';
    const crate = new THREE.Mesh(tri());
    crate.name = 'crate:metal';
    const cone = new THREE.Mesh(tri());
    cone.name = 'VolumetricCone';
    const deco = new THREE.Mesh(tri());
    deco.name = 'level:pipe';
    deco.userData.navIgnore = true;
    const group = new THREE.Group();
    group.add(panel);
    root.add(floor, group, crate, cone, deco);
    expect(collectNavSources(root)).toEqual([floor, panel]);
  });
});
