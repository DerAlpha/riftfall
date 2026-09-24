/**
 * World-space prop geometry for the map kit (traps, generators, quest objects – and map builders'
 * own props): boxes and cylinders placed in a movable local frame (position + yaw, or a full
 * matrix), collected per material key and merged into ONE mesh per key for everything built with
 * the builder – all static trap bodies of a map cost one draw call per material. Box UVs are
 * box-projected meters in world space (like LevelKit / PartBuilder), so library materials tile
 * exactly like the level's.
 *
 * Meshes are named `prop:<key>`: not `level:` – bullets, decals and line of sight pass (props that
 * must stop bullets belong in the LevelKit), and they are never navmesh sources (navIgnore).
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyBoxUV } from '../../world/LevelKit';

const ORIGIN = { x: 0, y: 0, z: 0 };
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
const _m = new Matrix4();

export class PropBuilder {
  private readonly parts = new Map<string, BufferGeometry[]>();
  /** Local frame → world. */
  private readonly frame = new Matrix4();

  /** Local frame at `position`, turned by `yaw` about Y (local +Z = (sin yaw, 0, cos yaw)). */
  setFrame(x: number, y: number, z: number, yaw = 0): this {
    _q.setFromAxisAngle(_up, yaw);
    _p.set(x, y, z);
    this.frame.compose(_p, _q, _s);
    return this;
  }

  /** Arbitrary local frame (e.g. a rotated fan housing). */
  setMatrix(m: Matrix4): this {
    this.frame.copy(m);
    return this;
  }

  /** Box centered at local (x, y, z), size (sx, sy, sz). */
  box(key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number): this {
    if (!(sx > 0 && sy > 0 && sz > 0)) return this;
    const g = new BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    g.applyMatrix4(this.frame);
    applyBoxUV(g, ORIGIN);
    return this.add(key, g);
  }

  /** Cylinder along a local axis centered at (x, y, z). */
  cylinder(
    key: string,
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    axis: 'x' | 'y' | 'z',
    segments: number,
    radiusTop = radius,
  ): this {
    if (!(radius > 0 && length > 0)) return this;
    const g = new CylinderGeometry(radiusTop, radius, length, segments, 1, false);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    g.applyMatrix4(this.frame);
    return this.add(key, g);
  }

  /** Box between two local points (a strut), `thickness` square. */
  strut(key: string, a: Vector3, b: Vector3, thickness: number): this {
    const len = a.distanceTo(b);
    if (!(len > 1e-4)) return this;
    const g = new BoxGeometry(thickness, len, thickness);
    _p.subVectors(b, a).normalize();
    _q.setFromUnitVectors(_up, _p);
    _m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s);
    g.applyMatrix4(_m);
    g.applyMatrix4(this.frame);
    applyBoxUV(g, ORIGIN);
    return this.add(key, g);
  }

  has(key: string): boolean {
    return (this.parts.get(key)?.length ?? 0) > 0;
  }

  /** Merge one key into a mesh under `parent` (null when empty). */
  mesh(key: string, material: Material, parent: Object3D, castShadow = true): Mesh | null {
    const list = this.parts.get(key);
    if (!list || list.length === 0) return null;
    this.parts.delete(key);
    for (const g of list) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      }
      g.clearGroups();
    }
    const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    if (!merged) return null;
    merged.computeBoundingSphere();
    const m = new Mesh(merged, material);
    m.name = `prop:${key}`;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.userData.navIgnore = true;
    parent.add(m);
    return m;
  }

  /** Every remaining key into meshes (materials by key). */
  meshes(materialOf: (key: string) => Material, parent: Object3D, castShadow = true): Mesh[] {
    const out: Mesh[] = [];
    for (const key of [...this.parts.keys()]) {
      const m = this.mesh(key, materialOf(key), parent, castShadow);
      if (m) out.push(m);
    }
    return out;
  }

  dispose(): void {
    for (const list of this.parts.values()) for (const g of list) g.dispose();
    this.parts.clear();
  }

  private add(key: string, g: BufferGeometry): this {
    let list = this.parts.get(key);
    if (!list) {
      list = [];
      this.parts.set(key, list);
    }
    list.push(g);
    return this;
  }
}
