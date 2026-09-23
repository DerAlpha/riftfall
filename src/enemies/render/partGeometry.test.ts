import { describe, expect, it } from 'vitest';
import { ENEMY_VISUALS, type EnemyPartDef } from '../../defs/enemyVisuals';
import { buildPartMesh, buildTypeGeometry, type PartMesh } from './partGeometry';
import { compileRig } from './poseMath';

/** Every edge shared by exactly two triangles, in opposite directions (closed, consistently wound). */
function isClosedManifold(m: PartMesh): boolean {
  const edges = new Map<string, number>();
  const idx = m.indices;
  for (let i = 0; i < idx.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[i + k]!;
      const b = idx[i + ((k + 1) % 3)]!;
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const [a, b] = key.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

/** Signed volume of a closed mesh: positive when the triangles wind counter-clockwise from outside. */
function signedVolume(m: PartMesh): number {
  const p = m.positions;
  const idx = m.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
}

/** Fraction of triangles whose vertex normals agree with the face winding. */
function normalAgreement(m: PartMesh): number {
  const p = m.positions;
  const n = m.normals;
  const idx = m.indices;
  let ok = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const f = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const d =
      f[0]! * (n[a]! + n[b]! + n[c]!) +
      f[1]! * (n[a + 1]! + n[b + 1]! + n[c + 1]!) +
      f[2]! * (n[a + 2]! + n[b + 2]! + n[c + 2]!);
    if (d > 0) ok++;
  }
  return ok / (idx.length / 3);
}

const SHAPES: EnemyPartDef[] = [
  {
    shape: 'ellipsoid',
    bone: 'b',
    zone: 'z',
    center: [0.3, 1, 0.1],
    radii: [0.2, 0.1, 0.3],
    rot: [20, 30, -10],
  },
  { shape: 'ellipsoid', bone: 'b', zone: 'z', center: [0, 1, 0], radii: [0.3, 0.04, 0.2], bend: -0.08 },
  { shape: 'capsule', bone: 'b', zone: 'z', a: [0, 0, 0], b: [0.2, 0.8, 0.1], radius: 0.1, radiusB: 0.06 },
  {
    shape: 'spike',
    bone: 'b',
    zone: 'z',
    a: [0, 0, 0],
    b: [0.1, 0.5, -0.2],
    radius: 0.05,
    curve: [0.05, 0, 0],
  },
  {
    shape: 'lathe',
    bone: 'b',
    zone: 'z',
    a: [0, 0, 0],
    b: [0, 0.5, 0.4],
    profile: [
      [0, 0],
      [0.3, 0.2],
      [0.7, 0.15],
      [1, 0],
    ],
    ellipse: [1, 0.8],
  },
  {
    shape: 'lathe',
    bone: 'b',
    zone: 'z',
    a: [0, 0, 0],
    b: [0, 0.5, 0],
    profile: [
      [0, 0.1],
      [1, 0.1],
    ],
  },
  {
    shape: 'tube',
    bone: 'b',
    zone: 'z',
    points: [
      [0, 0, 0],
      [0.2, 0.2, 0],
      [0.2, 0.5, 0.2],
    ],
    radius: 0.03,
    radiusB: 0.02,
  },
];

describe('part geometry', () => {
  it('builds closed, outward-facing meshes for every shape (and their mirrored twins)', () => {
    for (const def of SHAPES) {
      const mirrored = compileRig('t', {
        ...ENEMY_VISUALS.swarmer,
        bones: [{ name: 'b', parent: null, pivot: [0, 0, 0] }],
        parts: [{ ...def, mirror: true }],
        zones: { z: ENEMY_VISUALS.swarmer.zones.chitin },
        hitboxes: [],
        sockets: {},
      }).parts;
      for (const p of mirrored) {
        const m = buildPartMesh(p.def);
        expect(isClosedManifold(m), def.shape).toBe(true);
        expect(signedVolume(m), def.shape).toBeGreaterThan(0);
        expect(normalAgreement(m), def.shape).toBeGreaterThan(0.97);
        expect(m.positions.every(Number.isFinite)).toBe(true);
        expect(m.normals.every(Number.isFinite)).toBe(true);
        expect(Math.min(...m.axis)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...m.axis)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('lumps displace deterministically', () => {
    const def: EnemyPartDef = { ...SHAPES[0]!, lumpy: 0.02 } as EnemyPartDef;
    const a = buildPartMesh(def, 5);
    const b = buildPartMesh(def, 5);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.positions)).not.toEqual(Array.from(buildPartMesh(SHAPES[0]!).positions));
  });

  it('merges each type into one geometry with valid partId / partAxis and a sane vertex budget', () => {
    const budget: Record<string, number> = { swarmer: 7000, spitter: 9000, tank: 12000 };
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      const rig = compileRig(id, def);
      const geo = buildTypeGeometry(rig.parts);
      const pos = geo.getAttribute('position');
      const partId = geo.getAttribute('partId');
      const axis = geo.getAttribute('partAxis');
      expect(partId.count).toBe(pos.count);
      expect(axis.count).toBe(pos.count);
      const seen = new Set<number>();
      for (let i = 0; i < partId.count; i++) {
        const v = partId.getX(i);
        expect(Number.isInteger(v)).toBe(true);
        seen.add(v);
      }
      expect(seen.size, id).toBe(rig.parts.length);
      const index = geo.getIndex()!;
      for (let i = 0; i < index.count; i++) expect(index.getX(i)).toBeLessThan(pos.count);
      expect(pos.count, id).toBeLessThan(budget[id]!);
      geo.dispose();
    }
  });
});
