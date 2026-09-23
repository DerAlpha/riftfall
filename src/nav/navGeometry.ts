/**
 * Level meshes → one world-space triangle soup for recast (build time only; allocates freely).
 *
 * - matrixWorld is applied (InstancedMesh: × every instance matrix); mirrored transforms get their
 *   winding flipped back, so floors stay up-facing (recast marks walkable faces by their normal).
 * - `mesh.userData.navIgnore` (NAV.sources.ignoreFlag) skips decoration.
 * - Meshes with missing / non-3D positions or non-finite vertices are skipped with a warning.
 */
import { InstancedMesh, Matrix4, Vector3, type Mesh, type Object3D } from 'three';
import { createLogger } from '../core/log';
import { NAV } from '../defs/nav';

const log = createLogger('nav');

export interface NavGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  /** Source meshes that contributed triangles. */
  meshes: number;
  triangles: number;
}

const _m = new Matrix4();
const _v = new Vector3();

function isIgnored(mesh: Mesh): boolean {
  return mesh.userData?.[NAV.sources.ignoreFlag] === true;
}

/** Default nav sources under `root`: static level meshes (NAV.sources.prefixes), minus navIgnore. */
export function collectNavSources(root: Object3D, out: Mesh[] = []): Mesh[] {
  const prefixes = NAV.sources.prefixes;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || isIgnored(mesh)) return;
    for (const p of prefixes) {
      if (mesh.name.startsWith(p)) {
        out.push(mesh);
        return;
      }
    }
  });
  return out;
}

interface Part {
  mesh: Mesh;
  vertexCount: number;
  indexCount: number;
}

function usable(mesh: Mesh): Part | null {
  if (!mesh || !mesh.isMesh || isIgnored(mesh)) return null;
  const geo = mesh.geometry;
  const pos = geo?.getAttribute('position');
  if (!pos || pos.itemSize !== 3 || pos.count < 3) return null;
  const index = geo.getIndex();
  const indexCount = index ? index.count - (index.count % 3) : pos.count - (pos.count % 3);
  if (indexCount === 0) return null;
  return { mesh, vertexCount: pos.count, indexCount };
}

/** Gather world-space positions + indices of `sources`. */
export function gatherNavGeometry(sources: readonly Mesh[]): NavGeometry {
  const parts: Part[] = [];
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const mesh of sources) {
    const part = usable(mesh);
    if (!part) continue;
    const instances = mesh instanceof InstancedMesh ? mesh.count : 1;
    parts.push(part);
    vertexTotal += part.vertexCount * instances;
    indexTotal += part.indexCount * instances;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let vBase = 0;
  let iOut = 0;
  let used = 0;
  for (const { mesh, vertexCount, indexCount } of parts) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const instances = mesh instanceof InstancedMesh ? mesh.count : 1;
    let meshOk = true;
    const vStart = vBase;
    const iStart = iOut;
    for (let inst = 0; inst < instances && meshOk; inst++) {
      if (mesh instanceof InstancedMesh) {
        mesh.getMatrixAt(inst, _m);
        _m.premultiply(mesh.matrixWorld);
      } else {
        _m.copy(mesh.matrixWorld);
      }
      const flip = _m.determinant() < 0;
      for (let i = 0; i < vertexCount; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
        if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || !Number.isFinite(_v.z)) {
          meshOk = false;
          break;
        }
        const o = (vBase + i) * 3;
        positions[o] = _v.x;
        positions[o + 1] = _v.y;
        positions[o + 2] = _v.z;
      }
      if (!meshOk) break;
      for (let i = 0; i < indexCount; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i + 1) : i + 1;
        const c = index ? index.getX(i + 2) : i + 2;
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
        indices[iOut] = vBase + a;
        indices[iOut + 1] = vBase + (flip ? c : b);
        indices[iOut + 2] = vBase + (flip ? b : c);
        iOut += 3;
      }
      vBase += vertexCount;
    }
    if (!meshOk) {
      log.warn(`Nav source "${mesh.name || mesh.uuid}" has non-finite vertices – skipped`);
      vBase = vStart;
      iOut = iStart;
      continue;
    }
    used++;
  }

  return {
    positions: vBase * 3 === positions.length ? positions : positions.slice(0, vBase * 3),
    indices: iOut === indices.length ? indices : indices.slice(0, iOut),
    meshes: used,
    triangles: iOut / 3,
  };
}
