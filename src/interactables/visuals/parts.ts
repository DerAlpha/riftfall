/**
 * Merged procedural geometry for interactable props: boxes / cylinders collected per material key
 * and merged into one BufferGeometry each (one draw call per material per prop). Box UVs are
 * box-projected meters like the level kit (library materials repeat per meter), so props share the
 * level's textures without stretching.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyBoxUV } from '../../world/LevelKit';

const ORIGIN = { x: 0, y: 0, z: 0 };

export class PartBuilder {
  private readonly parts = new Map<string, BufferGeometry[]>();

  /** Axis-aligned box centered at (x, y, z) with size (sx, sy, sz), local space of the prop. */
  box(key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number): this {
    if (!(sx > 0 && sy > 0 && sz > 0)) return this;
    const g = new BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    applyBoxUV(g, ORIGIN);
    this.add(key, g);
    return this;
  }

  /** Box given by min / max corners. */
  boxMinMax(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): this {
    return this.box(key, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0);
  }

  /** Cylinder along `axis` centered at (x, y, z). */
  cylinder(
    key: string,
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    axis: 'x' | 'y' | 'z',
    segments: number,
  ): this {
    if (!(radius > 0 && length > 0)) return this;
    const g = new CylinderGeometry(radius, radius, length, segments, 1, false);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(key, g);
    return this;
  }

  has(key: string): boolean {
    return (this.parts.get(key)?.length ?? 0) > 0;
  }

  /** Merge the parts of `key` (null when there are none); the source pieces are disposed. */
  merge(key: string): BufferGeometry | null {
    const list = this.parts.get(key);
    if (!list || list.length === 0) return null;
    this.parts.delete(key);
    const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    if (merged) merged.computeBoundingSphere();
    return merged;
  }

  /**
   * Merge `key` into a mesh under `parent` (null when empty). `castShadow`: lit bodies cast,
   * emissive trims usually not.
   */
  mesh(key: string, material: Material, parent: Object3D, castShadow = true, name = key): Mesh | null {
    const geo = this.merge(key);
    if (!geo) return null;
    const m = new Mesh(geo, material);
    m.name = `prop:${name}`;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    // Props are not level geometry: never in the navmesh (their nav areas handle enemies).
    m.userData.navIgnore = true;
    parent.add(m);
    return m;
  }

  /** Drop unmerged pieces. */
  dispose(): void {
    for (const list of this.parts.values()) for (const g of list) g.dispose();
    this.parts.clear();
  }

  private add(key: string, g: BufferGeometry): void {
    let list = this.parts.get(key);
    if (!list) {
      list = [];
      this.parts.set(key, list);
    }
    // CylinderGeometry has no groups issue; BoxGeometry groups are dropped by the merge.
    g.clearGroups();
    list.push(g);
  }
}
