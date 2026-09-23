/**
 * Assembles a procedural weapon model: geometry pieces are placed in model space, grouped by
 * (part, material) and merged into one mesh each – few draw calls, while named parts (slide,
 * magazine, pump, ...) stay separately transformable Object3Ds.
 *
 * Model space: origin = grip pivot (where the hand holds it), +Y up, barrel along −Z, meters.
 * Every piece gets box-projected UVs at a fixed texel density (so the tiny tiling wear/knurl
 * maps look uniform across merged pieces) and an edge-wear vertex color: `paint` on flat faces,
 * 1 on worn bevels (the material color is the bare-metal/raw color).
 */
import {
  BufferAttribute,
  Euler,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createLogger } from '../../core/log';
import { DEG2RAD } from '../../core/math';
import type { Vec3Def } from '../../defs/viewmodels';

const log = createLogger('viewmodel');

export type SocketName = 'muzzle' | 'ejectPort' | 'sight';
export const SOCKET_NAMES: readonly SocketName[] = ['muzzle', 'ejectPort', 'sight'];

/** The static body of the model (not a movable part). */
export const BODY = 'body';

export type Vec3Tuple = readonly [number, number, number];

export interface PieceOptions {
  /** Position in model space (m). */
  pos?: Vec3Tuple;
  /** Rotation (XYZ Euler, DEGREES) in model space. */
  rot?: Vec3Tuple;
  scale?: Vec3Tuple;
  /** Vertex color on flat faces (0..1); worn edges get 1. Default 1 (no darkening). */
  paint?: number;
  /** UV mode: box projection (default), keep the geometry's UVs, or a constant texel [u, v]. */
  uv?: 'box' | 'keep' | readonly [number, number];
  /** Texture repeats per meter for box projection (default: builder density). */
  uvDensity?: number;
  /** `pos`/`rot` are relative to the target part's rest frame instead of model space. */
  local?: boolean;
}

interface Piece {
  target: string;
  mat: string;
  geo: BufferGeometry;
}

interface PartSpec {
  name: string;
  parent: string;
  /** Model-space rest transform of the part origin. */
  matrix: Matrix4;
  hidden: boolean;
}

interface SocketSpec {
  name: SocketName;
  parent: string;
  matrix: Matrix4;
}

export interface BuiltModel {
  root: Group;
  parts: Record<string, Object3D>;
  sockets: Record<SocketName, Object3D>;
  /** Merged geometries owned by the model (dispose with it). */
  geometries: BufferGeometry[];
  meshes: Mesh[];
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();

function composeMatrix(out: Matrix4, pos?: Vec3Tuple, rotDeg?: Vec3Tuple, scale?: Vec3Tuple): Matrix4 {
  _p.set(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0);
  _e.set((rotDeg?.[0] ?? 0) * DEG2RAD, (rotDeg?.[1] ?? 0) * DEG2RAD, (rotDeg?.[2] ?? 0) * DEG2RAD);
  _q.setFromEuler(_e);
  _s.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  return out.compose(_p, _q, _s);
}

/** Box-projected UVs from model-space positions (dominant normal axis picks the plane). */
export function boxProjectUVs(geo: BufferGeometry, density: number): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else if (ay >= az) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = u * density;
    uv[i * 2 + 1] = v * density;
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
}

/** Edge-wear vertex colors from the optional `wear` attribute (removed afterwards). */
export function applyWearColors(geo: BufferGeometry, paint: number): void {
  const pos = geo.getAttribute('position');
  if (!pos) return;
  const wear = geo.getAttribute('wear');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const w = wear ? wear.getX(i) : 0;
    const c = paint + (1 - paint) * w;
    col[i * 3] = c;
    col[i * 3 + 1] = c;
    col[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  if (wear) geo.deleteAttribute('wear');
}

/** Keep exactly position/normal/uv/color so every piece can be merged with every other. */
function normalizeAttributes(geo: BufferGeometry): BufferGeometry {
  let g = geo;
  if (g.index) {
    const ni = g.toNonIndexed();
    g.dispose();
    g = ni;
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color')
      g.deleteAttribute(name);
  }
  g.clearGroups();
  return g;
}

export class ModelBuilder {
  private readonly pieces: Piece[] = [];
  private readonly partSpecs = new Map<string, PartSpec>();
  private readonly socketSpecs: SocketSpec[] = [];

  constructor(
    readonly name: string,
    /** Default texture repeats per meter for box-projected UVs. */
    private readonly uvDensity: number,
  ) {}

  /**
   * Declare a movable part whose origin (pivot) sits at `pivot` in model space. `rotDeg`
   * orients the part's local axes (motions are expressed in them); `parent` nests it.
   */
  part(
    name: string,
    pivot: Vec3Tuple,
    opts: { rot?: Vec3Tuple; parent?: string; hidden?: boolean } = {},
  ): this {
    if (name === BODY || this.partSpecs.has(name)) {
      log.warn(`${this.name}: duplicate part "${name}"`);
      return this;
    }
    this.partSpecs.set(name, {
      name,
      parent: opts.parent ?? BODY,
      matrix: composeMatrix(new Matrix4(), pivot, opts.rot),
      hidden: opts.hidden ?? false,
    });
    return this;
  }

  /** Add a geometry piece (placed in MODEL space) to the body or a part. Takes ownership of `geo`. */
  add(target: string, mat: string, geo: BufferGeometry, opts: PieceOptions = {}): this {
    let g = normalizeAttributesKeepWear(geo);
    composeMatrix(_m, opts.pos, opts.rot, opts.scale);
    if (opts.local) _m.premultiply(this.modelMatrixOf(target));
    g.applyMatrix4(_m);
    const uvMode = opts.uv ?? 'box';
    if (uvMode === 'box') boxProjectUVs(g, opts.uvDensity ?? this.uvDensity);
    else if (uvMode !== 'keep') {
      const count = g.getAttribute('position').count;
      const uv = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        uv[i * 2] = uvMode[0];
        uv[i * 2 + 1] = uvMode[1];
      }
      g.setAttribute('uv', new BufferAttribute(uv, 2));
    }
    if (!g.getAttribute('uv')) boxProjectUVs(g, opts.uvDensity ?? this.uvDensity);
    applyWearColors(g, opts.paint ?? 1);
    g = normalizeAttributes(g);
    this.pieces.push({ target, mat, geo: g });
    return this;
  }

  /** Attach a socket (muzzle / ejectPort / sight). Its local −Z is the effect direction. */
  socket(name: SocketName, pos: Vec3Tuple, rotDeg?: Vec3Tuple, parent: string = BODY): this {
    this.socketSpecs.push({ name, parent, matrix: composeMatrix(new Matrix4(), pos, rotDeg) });
    return this;
  }

  /** Model-space rest matrix of a part (identity for the body). */
  private modelMatrixOf(target: string): Matrix4 {
    return this.partSpecs.get(target)?.matrix ?? new Matrix4();
  }

  build(materials: Readonly<Record<string, Material>>): BuiltModel {
    const root = new Group();
    root.name = `vm-${this.name}`;
    const parts: Record<string, Object3D> = {};
    const nodes = new Map<string, Object3D>([[BODY, root]]);

    // Parts in declaration order; parents must be declared first.
    for (const spec of this.partSpecs.values()) {
      const obj = new Group();
      obj.name = `part-${spec.name}`;
      obj.visible = !spec.hidden;
      const parentNode = nodes.get(spec.parent) ?? root;
      const parentMatrix = this.modelMatrixOf(spec.parent);
      _m.copy(parentMatrix).invert().multiply(spec.matrix);
      _m.decompose(obj.position, obj.quaternion, obj.scale);
      parentNode.add(obj);
      nodes.set(spec.name, obj);
      parts[spec.name] = obj;
    }

    const sockets = {} as Record<SocketName, Object3D>;
    for (const spec of this.socketSpecs) {
      const obj = new Object3D();
      obj.name = `socket-${spec.name}`;
      const parentNode = nodes.get(spec.parent) ?? root;
      _m.copy(this.modelMatrixOf(spec.parent)).invert().multiply(spec.matrix);
      _m.decompose(obj.position, obj.quaternion, obj.scale);
      parentNode.add(obj);
      sockets[spec.name] = obj;
    }
    for (const name of SOCKET_NAMES) {
      if (!sockets[name]) {
        log.warn(`${this.name}: missing socket "${name}", using the model origin`);
        const obj = new Object3D();
        obj.name = `socket-${name}`;
        root.add(obj);
        sockets[name] = obj;
      }
    }

    // Group pieces by target + material and merge each group into one mesh.
    const groups = new Map<string, Piece[]>();
    for (const p of this.pieces) {
      const key = `${p.target}\u0000${p.mat}`;
      const list = groups.get(key);
      if (list) list.push(p);
      else groups.set(key, [p]);
    }
    const geometries: BufferGeometry[] = [];
    const meshes: Mesh[] = [];
    for (const list of groups.values()) {
      const { target, mat } = list[0]!;
      const material = materials[mat];
      const node = nodes.get(target);
      if (!material || !node) {
        log.warn(`${this.name}: unknown ${material ? 'part' : 'material'} "${material ? target : mat}"`);
        for (const p of list) p.geo.dispose();
        continue;
      }
      // Model space → the part's local space.
      const toLocal = this.modelMatrixOf(target).clone().invert();
      for (const p of list) p.geo.applyMatrix4(toLocal);
      const merged = list.length === 1 ? list[0]!.geo : mergeGeometries(list.map((p) => p.geo));
      if (list.length > 1) for (const p of list) p.geo.dispose();
      if (!merged) {
        log.warn(`${this.name}: could not merge "${target}/${mat}"`);
        continue;
      }
      merged.computeBoundingSphere();
      geometries.push(merged);
      const mesh = new Mesh(merged, material);
      mesh.name = `${target}-${mat}`;
      node.add(mesh);
      meshes.push(mesh);
    }
    this.pieces.length = 0;
    return { root, parts, sockets, geometries, meshes };
  }
}

/** Indexed → non-indexed while keeping the `wear` helper attribute (it is converted later). */
function normalizeAttributesKeepWear(geo: BufferGeometry): BufferGeometry {
  if (!geo.index) return geo;
  const ni = geo.toNonIndexed();
  geo.dispose();
  return ni;
}

/** Convenience for defs → builder tuples. */
export function tuple(v: Vec3Def): Vec3Tuple {
  return [v.x, v.y, v.z];
}
