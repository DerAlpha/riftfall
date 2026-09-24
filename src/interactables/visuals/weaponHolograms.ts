/**
 * Weapon silhouettes for holograms (wall buys, the Rift-Kiste): the procedural viewmodel of a
 * weapon (weapons/viewmodels registry) collapsed into ONE position + normal geometry, centered,
 * unit length, barrel along +X, up +Y (the model's right side faces +Z). Built once per weapon id
 * and shared; the viewmodel and its materials are disposed right after. Unknown ids / failing
 * builders fall back to a blocky rifle silhouette – never a crash.
 */
import type { BufferAttribute, Mesh } from 'three';
import { Box3, BoxGeometry, BufferGeometry, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createLogger } from '../../core/log';
import { getWeaponDef } from '../../defs/weapons';
import { WeaponMaterialKit, createWeaponViewmodel } from '../../weapons/viewmodels';

const log = createLogger('interactables');

/** Fallback silhouette boxes: [centerX, centerY, sizeX, sizeY] in unit-length model space. */
const FALLBACK_SILHOUETTE: readonly (readonly [number, number, number, number])[] = [
  [0, 0.02, 0.62, 0.1],
  [0.38, 0.04, 0.26, 0.035],
  [-0.38, -0.01, 0.2, 0.13],
  [-0.04, -0.11, 0.05, 0.16],
  [0.12, -0.1, 0.05, 0.14],
  [0.03, 0.11, 0.18, 0.04],
];
const FALLBACK_THICKNESS = 0.05;

const _m = new Matrix4();
const _box = new Box3();
const _size = new Vector3();
const _center = new Vector3();

/** Position + normal only, non-indexed, transformed by `matrix`. */
function strip(src: BufferGeometry, matrix: Matrix4): BufferGeometry | null {
  const pos = src.getAttribute('position');
  if (!pos || pos.itemSize !== 3 || pos.count < 3) return null;
  const flat = src.index ? src.toNonIndexed() : src;
  const out = new BufferGeometry();
  out.setAttribute('position', (flat.getAttribute('position') as BufferAttribute).clone());
  const n = flat.getAttribute('normal');
  if (n && n.itemSize === 3) out.setAttribute('normal', (n as BufferAttribute).clone());
  if (flat !== src) flat.dispose();
  out.applyMatrix4(matrix);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

/** Center on the bounds, scale to unit length (longest side), barrel along +X; returns the real length. */
function normalize(geo: BufferGeometry, fromViewmodel: boolean): number {
  // Viewmodels point their barrel down −Z: turn it to +X.
  if (fromViewmodel) geo.rotateY(-Math.PI / 2);
  geo.computeBoundingBox();
  _box.copy(geo.boundingBox!);
  _box.getSize(_size);
  _box.getCenter(_center);
  const len = Math.max(_size.x, _size.y, _size.z, 1e-3);
  geo.translate(-_center.x, -_center.y, -_center.z);
  geo.scale(1 / len, 1 / len, 1 / len);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return len;
}

function fallbackGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const [x, y, sx, sy] of FALLBACK_SILHOUETTE) {
    const g = new BoxGeometry(sx, sy, FALLBACK_THICKNESS).toNonIndexed();
    g.deleteAttribute('uv');
    g.translate(x, y, 0);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  normalize(merged, false);
  return merged;
}

export class WeaponHologramLibrary {
  private readonly cache = new Map<string, BufferGeometry>();
  /** Real model length (m) per weapon id (unknown / fallback: 0). */
  private readonly lengths = new Map<string, number>();
  private fallback: BufferGeometry | null = null;
  private kit: WeaponMaterialKit | null = null;

  /** Unit-length hologram geometry of a weapon (shared: do not dispose). */
  get(weaponId: string): BufferGeometry {
    const hit = this.cache.get(weaponId);
    if (hit) return hit;
    const geo = this.build(weaponId) ?? this.getFallback();
    this.cache.set(weaponId, geo);
    return geo;
  }

  /**
   * Display length (m) of a weapon's hologram: its real length × `scale`, clamped – a pistol stays
   * readable, a long gun fits its board. Unknown sizes use the maximum.
   */
  displayLength(weaponId: string, scale: number, min: number, max: number): number {
    this.get(weaponId);
    const real = this.lengths.get(weaponId) ?? 0;
    return real > 0 ? Math.min(max, Math.max(min, real * scale)) : max;
  }

  /** Build every id now (load time instead of the first roll). */
  prewarm(ids: readonly string[]): void {
    for (const id of ids) this.get(id);
    this.releaseKit();
  }

  dispose(): void {
    const seen = new Set<BufferGeometry>();
    for (const g of this.cache.values()) seen.add(g);
    if (this.fallback) seen.add(this.fallback);
    for (const g of seen) g.dispose();
    this.cache.clear();
    this.fallback = null;
    this.releaseKit();
  }

  private getFallback(): BufferGeometry {
    this.fallback ??= fallbackGeometry();
    return this.fallback;
  }

  private build(weaponId: string): BufferGeometry | null {
    const modelId = getWeaponDef(weaponId)?.model ?? weaponId;
    this.kit ??= new WeaponMaterialKit();
    const model = createWeaponViewmodel(modelId, this.kit);
    if (!model) return null;
    try {
      const root = model.root;
      root.updateMatrixWorld(true);
      _m.copy(root.matrixWorld).invert();
      const pieces: BufferGeometry[] = [];
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        const local = new Matrix4().multiplyMatrices(_m, mesh.matrixWorld);
        const g = strip(mesh.geometry, local);
        if (g) pieces.push(g);
      });
      if (pieces.length === 0) return null;
      const merged = mergeGeometries(pieces, false);
      for (const g of pieces) g.dispose();
      if (!merged) return null;
      this.lengths.set(weaponId, normalize(merged, true));
      return merged;
    } catch (err) {
      log.warn(`Hologram of "${weaponId}" failed – fallback silhouette`, err);
      return null;
    } finally {
      model.dispose();
    }
  }

  private releaseKit(): void {
    this.kit?.dispose();
    this.kit = null;
  }
}
