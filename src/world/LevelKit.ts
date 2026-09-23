/**
 * Level module kit: modules (floors, walls, pillars, ramps, stairs, railings, fixtures, pipes,
 * crates, markings, …) push geometry into per-material buckets; build() merges every bucket into
 * one static mesh (one draw call per material and shadow mode) with a three-mesh-bvh bounds tree
 * for fast hitscan raycasts. Colliders are created immediately through PhysicsApi.
 *
 * UVs: box-projected, in meters (world-continuous for axis-aligned modules), so every material's
 * texture density is identical across modules (textures repeat 1/uvScale per meter). Crates and
 * screens use per-face UVs instead ('face' mode: one repeat per face).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderData, MaterialLibraryApi, PhysicsApi } from '../core/contracts';
import type { SurfaceType, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { QUALITY_LEVELS } from '../defs/graphics';
import { LEVEL_KIT, type Facing } from '../defs/level';
import { getMaterialDef } from '../defs/materials';
import type { QualityLevel } from '../save/settingsSchema';
import { allocateShadowBudget, boxFaceUV, pipeWrapRepeats, staggeredSlot, type UV } from './kitMath';

const log = createLogger('LevelKit');

let bvhPatched = false;
/** Patch three once so every BufferGeometry/Mesh can use three-mesh-bvh (idempotent). */
export function ensureBvhPatched(): void {
  if (bvhPatched) return;
  bvhPatched = true;
  const geoProto = THREE.BufferGeometry.prototype as THREE.BufferGeometry;
  if (geoProto.computeBoundsTree !== computeBoundsTree) geoProto.computeBoundsTree = computeBoundsTree;
  if (geoProto.disposeBoundsTree !== disposeBoundsTree) geoProto.disposeBoundsTree = disposeBoundsTree;
  if (THREE.Mesh.prototype.raycast !== acceleratedRaycast) THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

export type UvMode = 'world' | 'face';

export interface BoxOptions {
  /** World rotation of the box (default identity). */
  rotation?: THREE.Quaternion;
  /** Create a static collider (default true). */
  collider?: boolean;
  /** Defaults to the material def's castShadow. */
  castShadow?: boolean;
  receiveShadow?: boolean;
  uv?: UvMode;
  /** Footstep surface override (default from the material def). */
  surface?: SurfaceType;
}

export interface LightHandle {
  readonly light: THREE.SpotLight | THREE.PointLight;
  readonly baseIntensity: number;
  /** Emissive panel with its own material instance (only for flickering fixtures). */
  readonly panel: THREE.Mesh | null;
  readonly panelBaseIntensity: number;
}

interface Bucket {
  materialId: string;
  castShadow: boolean;
  receiveShadow: boolean;
  geometries: THREE.BufferGeometry[];
}

interface ShadowCandidate {
  light: THREE.SpotLight;
  priority: number;
}

export interface KitStats {
  meshes: number;
  lights: number;
  colliders: number;
  dynamicBodies: number;
  triangles: number;
}

export interface LevelKitOptions {
  physics: PhysicsApi;
  materials: MaterialLibraryApi;
  name?: string;
  /** Registers kit-owned material clones for cascaded shadows (RenderApi.setupMaterial). */
  setupMaterial?: (material: THREE.Material) => void;
}

// Scratch objects (build time and per-frame helpers).
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _uv: UV = { x: 0, y: 0 };
const _up = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();
const DECAL = LEVEL_KIT.decal;

/** Right-hand direction (looking at the face from outside) and outward normal per facing. */
export function facingBasis(f: Facing): { right: Vec3Like; normal: Vec3Like } {
  switch (f) {
    case 'px':
      return { right: { x: 0, y: 0, z: -1 }, normal: { x: 1, y: 0, z: 0 } };
    case 'nx':
      return { right: { x: 0, y: 0, z: 1 }, normal: { x: -1, y: 0, z: 0 } };
    case 'pz':
      return { right: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
    case 'nz':
      return { right: { x: -1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 } };
  }
}

/**
 * Axis-aligned frame on a wall face: r along the face (right), y up, o out of the face.
 * Converts face-local boxes to world centers/sizes without rotations.
 */
export class WallFrame {
  readonly right: Vec3Like;
  readonly normal: Vec3Like;
  constructor(
    readonly origin: Vec3Like,
    facing: Facing,
  ) {
    const b = facingBasis(facing);
    this.right = b.right;
    this.normal = b.normal;
  }
  point(r: number, y: number, o: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(
      this.origin.x + this.right.x * r + this.normal.x * o,
      this.origin.y + y,
      this.origin.z + this.right.z * r + this.normal.z * o,
    );
  }
  size(sr: number, sy: number, so: number, out = new THREE.Vector3()): THREE.Vector3 {
    const alongX = Math.abs(this.right.x) > 0.5;
    return out.set(alongX ? sr : so, sy, alongX ? so : sr);
  }
}

export class LevelKit {
  readonly root: THREE.Group;
  readonly colliders: RAPIER.Collider[] = [];
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly lights: LightHandle[] = [];
  /** Standalone meshes (dynamic props, flicker panels, merged statics after build). */
  readonly meshes: THREE.Mesh[] = [];
  private readonly buckets = new Map<string, Bucket>();
  private readonly shadowCandidates: ShadowCandidate[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly crateGeometries = new Map<string, THREE.BufferGeometry>();
  private shadowLevel: QualityLevel = 'off';
  private frame = 0;
  private built = false;
  private disposed = false;
  private triangleCount = 0;

  constructor(private readonly opts: LevelKitOptions) {
    ensureBvhPatched();
    this.root = new THREE.Group();
    this.root.name = opts.name ?? 'Level';
  }

  get physics(): PhysicsApi {
    return this.opts.physics;
  }

  get stats(): KitStats {
    return {
      meshes: this.meshes.length,
      lights: this.lights.length,
      colliders: this.colliders.length + this.bodies.length,
      dynamicBodies: this.bodies.length,
      triangles: this.triangleCount,
    };
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /** Axis-aligned (or rotated) box with world-meter UVs; optional static collider. */
  box(materialId: string, center: Vec3Like, size: Vec3Like, opts: BoxOptions = {}): void {
    if (!(size.x > 0 && size.y > 0 && size.z > 0)) return;
    const def = getMaterialDef(materialId);
    const rot = opts.rotation ?? IDENTITY;
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    if ((opts.uv ?? 'world') === 'face') {
      applyFaceUV(geo, def?.uvScale ?? 1);
    } else {
      // UV origin = box center expressed in the box frame (world-continuous for axis-aligned boxes).
      _qInv.copy(rot).invert();
      _v.set(center.x, center.y, center.z).applyQuaternion(_qInv);
      applyBoxUV(geo, _v);
    }
    _m4.compose(_v2.set(center.x, center.y, center.z), rot, _one);
    geo.applyMatrix4(_m4);
    this.push(materialId, geo, opts.castShadow ?? def?.castShadow ?? true, opts.receiveShadow ?? true);
    if (opts.collider ?? true) {
      this.staticBox(center, size, opts.rotation, opts.surface ?? def?.surface ?? 'default');
    }
  }

  /** Box from min/max corners (axis-aligned). */
  boxMinMax(materialId: string, min: Vec3Like, max: Vec3Like, opts: BoxOptions = {}): void {
    this.box(
      materialId,
      { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
      { x: Math.abs(max.x - min.x), y: Math.abs(max.y - min.y), z: Math.abs(max.z - min.z) },
      opts,
    );
  }

  /** Invisible static collider. */
  staticBox(
    center: Vec3Like,
    size: Vec3Like,
    rotation?: THREE.Quaternion,
    surface: SurfaceType = 'default',
  ): void {
    const data: ColliderData = { kind: 'world', surface };
    const c = this.opts.physics.addStaticBox(
      center,
      { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
      rotation,
      data,
    );
    this.colliders.push(c);
  }

  /**
   * Convex prism from a 2D profile in the local (z, y) plane – counter-clockwise with z to the right
   * extruded across local x ∈ [-width/2, width/2], rotated by `yaw` and placed at `origin`.
   * Visual + trimesh collider (ramps, stair colliders).
   */
  prism(
    materialId: string | null,
    profile: readonly (readonly [number, number])[],
    width: number,
    origin: Vec3Like,
    yaw: number,
    opts: { collider?: boolean; castShadow?: boolean; surface?: SurfaceType } = {},
  ): void {
    const def = materialId ? getMaterialDef(materialId) : undefined;
    _q.setFromAxisAngle(_up, yaw);
    _m4.compose(_v2.set(origin.x, origin.y, origin.z), _q, _one);
    const hw = width / 2;
    if (materialId) {
      const geo = buildPrismGeometry(profile, hw, origin, _q);
      geo.applyMatrix4(_m4);
      this.push(materialId, geo, opts.castShadow ?? def?.castShadow ?? true, true);
    }
    if (opts.collider ?? true) {
      const n = profile.length;
      const verts = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        const [pz, py] = profile[i]!;
        for (let s = 0; s < 2; s++) {
          _v.set(s === 0 ? -hw : hw, py, pz).applyMatrix4(_m4);
          const k = (i * 2 + s) * 3;
          verts[k] = _v.x;
          verts[k + 1] = _v.y;
          verts[k + 2] = _v.z;
        }
      }
      const idx: number[] = [];
      // Side quads (outward winding).
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = i * 2;
        const b = j * 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
      // Caps (fans): -X cap keeps the profile order, +X cap is mirrored.
      for (let i = 1; i < n - 1; i++) {
        idx.push(0, i * 2, (i + 1) * 2);
        idx.push(1, (i + 1) * 2 + 1, i * 2 + 1);
      }
      const data: ColliderData = { kind: 'world', surface: opts.surface ?? def?.surface ?? 'default' };
      this.colliders.push(this.opts.physics.addStaticTrimesh(verts, new Uint32Array(idx), data));
    }
  }

  /** Cylinder between two points (pipes, rods). No collider unless asked. */
  cylinder(
    materialId: string,
    from: Vec3Like,
    to: Vec3Like,
    radius: number,
    opts: { segments?: number; collider?: boolean; castShadow?: boolean; openEnded?: boolean } = {},
  ): void {
    const def = getMaterialDef(materialId);
    _v.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = _v.length();
    if (length < 1e-4 || radius <= 0) return;
    const segs = opts.segments ?? LEVEL_KIT.pipe.radialSegments;
    const geo = new THREE.CylinderGeometry(radius, radius, length, segs, 1, opts.openEnded ?? false);
    applyCylinderUV(geo, radius, length, def?.uvScale ?? 1);
    _q.setFromUnitVectors(_up, _v.normalize());
    _m4.compose(_v2.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2), _q, _one);
    geo.applyMatrix4(_m4);
    this.push(materialId, geo, opts.castShadow ?? def?.castShadow ?? true, true);
    if (opts.collider) {
      this.staticBox(
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 },
        { x: radius * 2, y: length, z: radius * 2 },
        _q.clone(),
        def?.surface ?? 'metal',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Modules
  // -------------------------------------------------------------------------

  /** Floor slab: top surface at `topY`. */
  floor(
    materialId: string,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    topY: number,
    opts: BoxOptions = {},
  ): void {
    const t = LEVEL_KIT.floorThickness;
    this.boxMinMax(
      materialId,
      { x: minX, y: topY - t, z: minZ },
      { x: maxX, y: topY, z: maxZ },
      {
        castShadow: false,
        ...opts,
      },
    );
  }

  /** Thin decal-like floor marking (hazard stripes, lane lines). No collider, no shadow. */
  marking(materialId: string, minX: number, minZ: number, maxX: number, maxZ: number, y: number): void {
    const t = LEVEL_KIT.markingThickness;
    this.boxMinMax(
      materialId,
      { x: minX, y, z: minZ },
      { x: maxX, y: y + t, z: maxZ },
      {
        collider: false,
        castShadow: false,
      },
    );
  }

  /**
   * Wall along a face line (axis-aligned). The face runs from `a` to `b` (x/z), faces `facing`,
   * the body extends `thickness` behind it. Bands stack from y0: [wainscot, main, upper].
   */
  wall(opts: {
    a: readonly [number, number];
    b: readonly [number, number];
    facing: Facing;
    y0: number;
    height: number;
    thickness: number;
    bands: readonly { material: string; top: number }[];
    baseTrim?: string;
    lightStrip?: { material: string; housing: string; y: number };
    collider?: boolean;
  }): void {
    const len = Math.hypot(opts.b[0] - opts.a[0], opts.b[1] - opts.a[1]);
    if (len < 1e-3) return;
    const mid = { x: (opts.a[0] + opts.b[0]) / 2, y: opts.y0, z: (opts.a[1] + opts.b[1]) / 2 };
    const f = new WallFrame(mid, opts.facing);
    let y = 0;
    for (const band of opts.bands) {
      const top = Math.min(band.top, opts.height);
      if (top <= y) continue;
      this.box(
        band.material,
        f.point(0, (y + top) / 2, -opts.thickness / 2),
        f.size(len, top - y, opts.thickness),
        {
          collider: false,
        },
      );
      y = top;
      if (y >= opts.height) break;
    }
    if (opts.collider ?? true) {
      const firstDef = opts.bands[0] ? getMaterialDef(opts.bands[0].material) : undefined;
      this.staticBox(
        f.point(0, opts.height / 2, -opts.thickness / 2),
        f.size(len, opts.height, opts.thickness),
        undefined,
        firstDef?.surface ?? 'metal',
      );
    }
    const trim = LEVEL_KIT.trim;
    if (opts.baseTrim) {
      this.box(
        opts.baseTrim,
        f.point(0, trim.baseHeight / 2, trim.baseDepth / 2),
        f.size(len, trim.baseHeight, trim.baseDepth),
        {
          collider: false,
        },
      );
    }
    if (opts.lightStrip) {
      const s = opts.lightStrip;
      this.box(
        s.housing,
        f.point(0, s.y, trim.stripHousingDepth / 2),
        f.size(len, trim.stripHousingHeight, trim.stripHousingDepth),
        { collider: false },
      );
      this.box(
        s.material,
        f.point(0, s.y, trim.stripHousingDepth + trim.stripInset / 2),
        f.size(len - trim.stripInset * 4, trim.stripHeight, trim.stripInset),
        { collider: false, castShadow: false },
      );
    }
  }

  /** Square pillar with plinth, cap, corner trims and emissive light bands. */
  pillar(opts: {
    x: number;
    z: number;
    y0: number;
    height: number;
    size: number;
    material: string;
    trim: string;
    band: string;
    bands: readonly number[];
    collider?: boolean;
  }): void {
    const p = LEVEL_KIT.pillar;
    const s = opts.size;
    const h = opts.height;
    this.box(
      opts.material,
      { x: opts.x, y: opts.y0 + h / 2, z: opts.z },
      { x: s, y: h, z: s },
      { collider: false },
    );
    if (opts.collider ?? true)
      this.staticBox({ x: opts.x, y: opts.y0 + h / 2, z: opts.z }, { x: s, y: h, z: s }, undefined, 'metal');
    const ps = s + p.plinthExtra * 2;
    this.box(
      opts.trim,
      { x: opts.x, y: opts.y0 + p.plinthHeight / 2, z: opts.z },
      { x: ps, y: p.plinthHeight, z: ps },
      {
        collider: opts.collider ?? true,
      },
    );
    const cs = s + p.capExtra * 2;
    this.box(
      opts.trim,
      { x: opts.x, y: opts.y0 + h - p.capHeight / 2, z: opts.z },
      { x: cs, y: p.capHeight, z: cs },
      {
        collider: false,
      },
    );
    // Corner edge guards.
    const e = p.edgeTrim;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.box(
          opts.trim,
          {
            x: opts.x + sx * (s / 2 - e / 2 + p.edgeTrimOut),
            y: opts.y0 + h / 2,
            z: opts.z + sz * (s / 2 - e / 2 + p.edgeTrimOut),
          },
          { x: e, y: h - p.plinthHeight, z: e },
          { collider: false },
        );
      }
    }
    for (const by of opts.bands) {
      if (by <= p.plinthHeight || by >= h - p.capHeight) continue;
      const bs = s + p.bandInset * 2;
      this.box(
        opts.band,
        { x: opts.x, y: opts.y0 + by, z: opts.z },
        { x: bs, y: p.bandHeight, z: bs },
        {
          collider: false,
          castShadow: false,
        },
      );
    }
  }

  /**
   * Solid platform / ledge: body in `side` material, a walkable top slab in `topMaterial` and an
   * optional glowing strip just below the top edge on the listed faces.
   */
  platform(opts: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    y0?: number;
    top: number;
    side: string;
    topMaterial: string;
    slab?: number;
    edgeStrip?: { material: string; faces: readonly Facing[]; drop: number; height: number };
  }): void {
    const y0 = opts.y0 ?? 0;
    const slab = Math.min(opts.slab ?? LEVEL_KIT.platformSlab, (opts.top - y0) / 3);
    this.boxMinMax(
      opts.side,
      { x: opts.minX, y: y0, z: opts.minZ },
      { x: opts.maxX, y: opts.top - slab, z: opts.maxZ },
    );
    this.boxMinMax(
      opts.topMaterial,
      { x: opts.minX, y: opts.top - slab, z: opts.minZ },
      { x: opts.maxX, y: opts.top, z: opts.maxZ },
    );
    const e = opts.edgeStrip;
    if (!e) return;
    const t = LEVEL_KIT.trim.stripInset;
    const cx = (opts.minX + opts.maxX) / 2;
    const cz = (opts.minZ + opts.maxZ) / 2;
    const w = opts.maxX - opts.minX;
    const d = opts.maxZ - opts.minZ;
    const y = opts.top - e.drop - e.height / 2;
    for (const face of e.faces) {
      const along = face === 'pz' || face === 'nz';
      const len = (along ? w : d) - LEVEL_KIT.platformStripMargin * 2;
      const x = face === 'px' ? opts.maxX + t / 2 : face === 'nx' ? opts.minX - t / 2 : cx;
      const z = face === 'pz' ? opts.maxZ + t / 2 : face === 'nz' ? opts.minZ - t / 2 : cz;
      this.box(
        e.material,
        { x, y, z },
        { x: along ? len : t, y: e.height, z: along ? t : len },
        {
          collider: false,
          castShadow: false,
        },
      );
    }
  }

  /**
   * Axis-aligned catwalk between two points (x/z) at `deckY`: deck slab with a collider and
   * railings on both long sides (optionally only one side).
   */
  catwalk(opts: {
    from: readonly [number, number];
    to: readonly [number, number];
    width: number;
    deckY: number;
    thickness: number;
    material: string;
    railings?: 'both' | 'left' | 'right' | 'none';
  }): void {
    const alongX = Math.abs(opts.to[0] - opts.from[0]) >= Math.abs(opts.to[1] - opts.from[1]);
    const hw = opts.width / 2;
    const minX = alongX ? Math.min(opts.from[0], opts.to[0]) : opts.from[0] - hw;
    const maxX = alongX ? Math.max(opts.from[0], opts.to[0]) : opts.from[0] + hw;
    const minZ = alongX ? opts.from[1] - hw : Math.min(opts.from[1], opts.to[1]);
    const maxZ = alongX ? opts.from[1] + hw : Math.max(opts.from[1], opts.to[1]);
    this.boxMinMax(
      opts.material,
      { x: minX, y: opts.deckY - opts.thickness, z: minZ },
      { x: maxX, y: opts.deckY, z: maxZ },
    );
    const rails = opts.railings ?? 'both';
    if (rails === 'none') return;
    const inset = LEVEL_KIT.railing.postSize;
    const y = opts.deckY;
    const sideA = (): void =>
      alongX
        ? this.railing({ x: minX, y, z: minZ + inset }, { x: maxX, y, z: minZ + inset })
        : this.railing({ x: minX + inset, y, z: minZ }, { x: minX + inset, y, z: maxZ });
    const sideB = (): void =>
      alongX
        ? this.railing({ x: minX, y, z: maxZ - inset }, { x: maxX, y, z: maxZ - inset })
        : this.railing({ x: maxX - inset, y, z: minZ }, { x: maxX - inset, y, z: maxZ });
    if (rails === 'both' || rails === 'left') sideA();
    if (rails === 'both' || rails === 'right') sideB();
  }

  /**
   * Ramp (wedge) rising towards local -Z. `center` is the footprint center at the base height,
   * yaw rotates around Y (0 = rises towards -Z/north). Visual wedge + exact trimesh collider.
   */
  ramp(opts: {
    material: string;
    center: Vec3Like;
    width: number;
    run: number;
    rise: number;
    yaw: number;
    edgeTrim?: string;
  }): void {
    const r = opts.run / 2;
    // Counter-clockwise in (z, y): low edge → high edge → back bottom.
    const profile: [number, number][] = [
      [r, 0],
      [-r, opts.rise],
      [-r, 0],
    ];
    this.prism(opts.material, profile, opts.width, opts.center, opts.yaw);
    if (opts.edgeTrim) {
      // Hazard strips along both top edges of the slope.
      const len = Math.hypot(opts.run, opts.rise);
      const angle = Math.atan2(opts.rise, opts.run);
      const w = LEVEL_KIT.door.hazardWidth;
      const t = LEVEL_KIT.markingThickness;
      _q.setFromAxisAngle(_up, opts.yaw);
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
      const rot = _q.clone().multiply(tilt);
      for (const side of [-1, 1]) {
        _v.set(side * (opts.width / 2 - w / 2), opts.rise / 2 + t / 2, 0).applyQuaternion(_q);
        this.box(
          opts.edgeTrim,
          { x: opts.center.x + _v.x, y: opts.center.y + _v.y, z: opts.center.z + _v.z },
          { x: w, y: t, z: len },
          { rotation: rot, collider: false, castShadow: false },
        );
      }
    }
  }

  /**
   * Stairs rising towards local -Z from `bottomCenter` (front edge of the first step, floor level).
   * Visual steps + side stringers; one smooth collider through the step nosings (plus the top
   * tread) so the character controller glides instead of stepping.
   */
  stairs(opts: {
    material: string;
    stringer: string;
    bottomCenter: Vec3Like;
    width: number;
    steps: number;
    stepRise: number;
    stepRun: number;
    yaw: number;
  }): void {
    const { steps, stepRise, stepRun, width } = opts;
    _q.setFromAxisAngle(_up, opts.yaw);
    const rot = _q.clone();
    const b = opts.bottomCenter;
    for (let i = 0; i < steps; i++) {
      const top = (i + 1) * stepRise;
      // Each step is a solid block from the floor (no gaps visible from the side).
      _v.set(0, top / 2, -(i + 0.5) * stepRun).applyQuaternion(rot);
      this.box(
        opts.material,
        { x: b.x + _v.x, y: b.y + _v.y, z: b.z + _v.z },
        { x: width, y: top, z: stepRun },
        { rotation: rot, collider: false },
      );
    }
    const total = steps * stepRise;
    const run = steps * stepRun;
    const sw = LEVEL_KIT.stairs.stringerWidth;
    for (const side of [-1, 1]) {
      // Stringer: a prism following the nosing line, slightly above it.
      const lift = LEVEL_KIT.stairs.stringerLift;
      const profile: [number, number][] = [
        [0, 0],
        [0, stepRise * 0.5 + lift],
        [-stepRun, stepRise + lift],
        [-run, total + lift],
        [-run, 0],
      ];
      _v.set(side * (width / 2 + sw / 2), 0, 0).applyQuaternion(rot);
      this.prism(opts.stringer, profile, sw, { x: b.x + _v.x, y: b.y, z: b.z + _v.z }, opts.yaw, {
        collider: false,
      });
    }
    // Collider: nosing plane from one run in front of the first step to the last nosing, then the top tread.
    const colProfile: [number, number][] = [
      [stepRun, 0],
      [-(steps - 1) * stepRun, total],
      [-run, total],
      [-run, 0],
    ];
    const def = getMaterialDef(opts.material);
    this.prism(null, colProfile, width, b, opts.yaw, { surface: def?.surface ?? 'metal' });
  }

  /** Railing between two points (y = walking surface height at each end). */
  railing(
    from: Vec3Like,
    to: Vec3Like,
    opts: { material?: string; collider?: boolean; height?: number } = {},
  ): void {
    const r = LEVEL_KIT.railing;
    const mat = opts.material ?? r.material;
    const h = opts.height ?? r.height;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 1e-3) return;
    const len = Math.hypot(horiz, dy);
    const posts = Math.max(1, Math.ceil(horiz / r.postSpacing));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      this.box(
        mat,
        { x: from.x + dx * t, y: from.y + dy * t + h / 2, z: from.z + dz * t },
        { x: r.postSize, y: h, z: r.postSize },
        { collider: false },
      );
    }
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horiz);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    for (const rh of [h, r.midRailHeight]) {
      this.box(
        mat,
        { x: from.x + dx / 2, y: from.y + dy / 2 + rh, z: from.z + dz / 2 },
        { x: r.railSize, y: r.railSize, z: len },
        { rotation: rot, collider: false },
      );
    }
    if (opts.collider ?? true) {
      this.staticBox(
        { x: from.x + dx / 2, y: from.y + dy / 2 + h / 2, z: from.z + dz / 2 },
        { x: r.colliderThickness, y: h, z: len },
        rot,
        'metal',
      );
    }
  }

  /** Door frame + recessed (sealed) door on a wall face. `position` is the opening's bottom center. */
  door(opts: {
    position: Vec3Like;
    facing: Facing;
    width: number;
    height: number;
    frame: string;
    panel: string;
    hazard: string;
    light: string;
    accent: string;
    blast: boolean;
  }): void {
    const d = LEVEL_KIT.door;
    const f = new WallFrame(opts.position, opts.facing);
    const fw = d.frameWidth;
    const w = opts.width;
    const h = opts.height;
    // Frame posts + lintel protrude from the wall.
    for (const side of [-1, 1]) {
      this.box(
        opts.frame,
        f.point(side * (w / 2 + fw / 2), h / 2, d.frameDepth / 2),
        f.size(fw, h, d.frameDepth),
        {
          collider: true,
        },
      );
      // Hazard edge on the inner side of each post.
      this.box(
        opts.hazard,
        f.point(side * (w / 2 + d.hazardWidth / 2), h / 2, d.frameDepth + DECAL.offset),
        f.size(d.hazardWidth, h, DECAL.thickness),
        { collider: false, castShadow: false },
      );
    }
    this.box(opts.frame, f.point(0, h + fw / 2, d.frameDepth / 2), f.size(w + fw * 2, fw, d.frameDepth), {
      collider: true,
    });
    // Door leaf (flush with the wall face, visually recessed behind the frame).
    this.box(opts.panel, f.point(0, h / 2, d.leafThickness / 2), f.size(w, h, d.leafThickness), {
      collider: false,
    });
    const ao = d.accentOffset;
    const at = d.accentThickness;
    if (opts.blast) {
      // Diagonal hazard band across a blast door and a glowing seam.
      this.box(opts.hazard, f.point(0, h * d.blastBand.y, ao), f.size(w, h * d.blastBand.height, at), {
        collider: false,
        castShadow: false,
      });
      this.box(opts.accent, f.point(0, h / 2, ao), f.size(d.blastSeam.width, h * d.blastSeam.height, at), {
        collider: false,
        castShadow: false,
      });
    } else {
      const ss = d.serviceStrip;
      this.box(opts.accent, f.point(0, h * ss.y, ao), f.size(w * ss.width, ss.height, at), {
        collider: false,
        castShadow: false,
      });
    }
    const s = d.statusLightSize;
    this.box(opts.light, f.point(0, h + fw + s[1], s[2] / 2), f.size(s[0], s[1], s[2]), {
      collider: false,
      castShadow: false,
    });
  }

  /** Screen with bezel on a wall face; position = screen center. */
  screen(opts: {
    position: Vec3Like;
    facing: Facing;
    width: number;
    height: number;
    screen: string;
    bezel: string;
  }): void {
    const s = LEVEL_KIT.screen;
    const f = new WallFrame(opts.position, opts.facing);
    this.box(
      opts.bezel,
      f.point(0, 0, s.depth / 2),
      f.size(opts.width + s.bezel * 2, opts.height + s.bezel * 2, s.depth),
      {
        collider: false,
      },
    );
    this.box(
      opts.screen,
      f.point(0, 0, s.depth + DECAL.offset),
      f.size(opts.width, opts.height, DECAL.thickness),
      {
        collider: false,
        uv: 'face',
      },
    );
  }

  /** Horizontal vent slits: glowing backing behind a louvered frame. `position` = center on the face. */
  ventSlits(opts: {
    position: Vec3Like;
    facing: Facing;
    width: number;
    slits: number;
    slitHeight: number;
    spacing: number;
    frame: string;
    glow: string;
  }): void {
    const v = LEVEL_KIT.vent;
    const f = new WallFrame(opts.position, opts.facing);
    const total = opts.slits * opts.spacing;
    // Glow backing (recessed), louvers in front.
    this.box(opts.glow, f.point(0, 0, v.glowThickness / 2), f.size(opts.width, total, v.glowThickness), {
      collider: false,
      castShadow: false,
    });
    const louver = opts.spacing - opts.slitHeight;
    for (let i = 0; i <= opts.slits; i++) {
      const y = -total / 2 + i * opts.spacing;
      this.box(
        opts.frame,
        f.point(0, y, v.frameDepth / 2 + v.glowInset / 2),
        f.size(opts.width, louver, v.frameDepth + v.glowInset),
        {
          collider: false,
        },
      );
    }
    for (const side of [-1, 1]) {
      this.box(
        opts.frame,
        f.point(side * (opts.width / 2 + louver / 2), 0, (v.frameDepth + v.glowInset) / 2),
        f.size(louver, total + louver, v.frameDepth + v.glowInset),
        { collider: false },
      );
    }
  }

  /** Pipe run with flanges and wall brackets. */
  pipe(opts: {
    from: Vec3Like;
    to: Vec3Like;
    radius: number;
    material: string;
    bracket: string;
    supportSpacing: number;
    wall: Facing | null;
    flangeSpacing: number;
  }): void {
    const p = LEVEL_KIT.pipe;
    this.cylinder(opts.material, opts.from, opts.to, opts.radius, { castShadow: true });
    const dx = opts.to.x - opts.from.x;
    const dy = opts.to.y - opts.from.y;
    const dz = opts.to.z - opts.from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const fr = opts.radius * p.flangeRadiusScale;
    const flange = (t: number): void => {
      const cx = opts.from.x + dx * t;
      const cy = opts.from.y + dy * t;
      const cz = opts.from.z + dz * t;
      const hl = p.flangeLength / 2;
      this.cylinder(
        opts.material,
        { x: cx - ux * hl, y: cy - uy * hl, z: cz - uz * hl },
        { x: cx + ux * hl, y: cy + uy * hl, z: cz + uz * hl },
        fr,
      );
    };
    if (opts.flangeSpacing > 0) {
      const n = Math.floor(len / opts.flangeSpacing);
      for (let i = 1; i <= n; i++) {
        const t = (i * opts.flangeSpacing) / len;
        if (t < 0.999) flange(t);
      }
    }
    if (opts.supportSpacing > 0 && opts.wall) {
      const nrm = facingBasis(opts.wall).normal;
      const n = Math.floor(len / opts.supportSpacing);
      const s = p.supportSize;
      const reach = p.bracketReach;
      const alongX = Math.abs(nrm.x) > 0.5;
      for (let i = 0; i < n; i++) {
        const t = (i * opts.supportSpacing + opts.supportSpacing / 2) / len;
        if (t >= 1) break;
        const cx = opts.from.x + dx * t;
        const cy = opts.from.y + dy * t;
        const cz = opts.from.z + dz * t;
        // Arm from the pipe back into the wall (the part inside the wall is hidden) + clamp ring.
        this.box(
          opts.bracket,
          { x: cx - nrm.x * (reach / 2), y: cy - opts.radius - s / 2, z: cz - nrm.z * (reach / 2) },
          { x: alongX ? reach : s, y: s, z: alongX ? s : reach },
          { collider: false },
        );
        const hl = p.clampLength / 2;
        this.cylinder(
          opts.bracket,
          { x: cx - ux * hl, y: cy - uy * hl, z: cz - uz * hl },
          { x: cx + ux * hl, y: cy + uy * hl, z: cz + uz * hl },
          opts.radius * p.clampRadiusScale,
        );
      }
    }
  }

  /** Crate: static (merged, face UVs) or dynamic (own mesh + rigid body). */
  crate(opts: {
    material: string;
    center: Vec3Like;
    size: number;
    yaw: number;
    dynamic: boolean;
  }): THREE.Mesh | null {
    const def = getMaterialDef(opts.material);
    const rot = new THREE.Quaternion().setFromAxisAngle(_up, opts.yaw);
    if (!opts.dynamic) {
      this.box(
        opts.material,
        opts.center,
        { x: opts.size, y: opts.size, z: opts.size },
        { rotation: rot, uv: 'face' },
      );
      return null;
    }
    const key = opts.size.toFixed(3);
    let geo = this.crateGeometries.get(key);
    if (!geo) {
      geo = new THREE.BoxGeometry(opts.size, opts.size, opts.size);
      applyFaceUV(geo, def?.uvScale ?? 1);
      geo.computeBoundsTree();
      this.crateGeometries.set(key, geo);
      this.ownedGeometries.push(geo);
    }
    const mesh = new THREE.Mesh(geo, this.opts.materials.get(opts.material));
    mesh.name = `crate:${opts.material}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.meshes.push(mesh);
    const h = opts.size / 2;
    const body = this.opts.physics.addDynamicBox(opts.center, { x: h, y: h, z: h }, mesh, {
      rotation: rot,
      data: { kind: 'prop', surface: def?.surface ?? 'metal', penetrable: def?.penetrable },
    });
    this.bodies.push(body);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Lights
  // -------------------------------------------------------------------------

  /**
   * Spot light with a hanging housing + emissive panel. `shadowPriority` null = never shadows;
   * otherwise the budget (applyShadowQuality) decides.
   */
  spotFixture(opts: {
    position: Vec3Like;
    target: Vec3Like;
    color: THREE.Color;
    intensity: number;
    distance: number;
    angle: number;
    penumbra: number;
    shadowPriority: number | null;
    housing: string;
    panel: string;
    rodTop: number | null;
    flicker: boolean;
  }): LightHandle {
    const fx = LEVEL_KIT.fixture;
    const hs = fx.housingSize;
    const p = opts.position;
    this.box(
      opts.housing,
      { x: p.x, y: p.y + hs[1] / 2, z: p.z },
      { x: hs[0], y: hs[1], z: hs[2] },
      { collider: false },
    );
    if (opts.rodTop !== null && opts.rodTop > p.y + hs[1]) {
      const rodH = opts.rodTop - (p.y + hs[1]);
      this.box(
        opts.housing,
        { x: p.x, y: p.y + hs[1] + rodH / 2, z: p.z },
        { x: fx.rodSize, y: rodH, z: fx.rodSize },
        {
          collider: false,
        },
      );
    }
    const panelSize = { x: hs[0] - fx.panelInset * 2, y: fx.panelThickness, z: hs[2] - fx.panelInset * 2 };
    const panelCenter = { x: p.x, y: p.y - fx.panelThickness / 2 + fx.panelGap, z: p.z };
    const panel = opts.flicker ? this.ownedPanel(opts.panel, panelCenter, panelSize) : null;
    if (!panel) this.box(opts.panel, panelCenter, panelSize, { collider: false, castShadow: false });

    const light = new THREE.SpotLight(
      opts.color,
      opts.intensity,
      opts.distance,
      opts.angle,
      opts.penumbra,
      2,
    );
    light.name = 'SpotFixture';
    light.position.set(p.x, p.y - fx.panelThickness, p.z);
    light.target.position.set(opts.target.x, opts.target.y, opts.target.z);
    light.castShadow = false;
    light.shadow.bias = LEVEL_KIT.localShadowBias;
    light.shadow.normalBias = LEVEL_KIT.localShadowNormalBias;
    light.shadow.autoUpdate = false;
    this.root.add(light, light.target);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    if (opts.shadowPriority !== null) this.shadowCandidates.push({ light, priority: opts.shadowPriority });
    const handle: LightHandle = {
      light,
      baseIntensity: opts.intensity,
      panel,
      panelBaseIntensity: panel ? (panel.material as THREE.MeshStandardMaterial).emissiveIntensity : 0,
    };
    this.lights.push(handle);
    return handle;
  }

  /** Point light with a small emissive bulb box (never shadowed: cube shadows are too expensive). */
  pointLight(opts: {
    position: Vec3Like;
    color: THREE.Color;
    intensity: number;
    distance: number;
    bulb: string | null;
    flicker: boolean;
  }): LightHandle {
    const light = new THREE.PointLight(opts.color, opts.intensity, opts.distance, 2);
    light.name = 'PointLight';
    light.position.set(opts.position.x, opts.position.y, opts.position.z);
    light.castShadow = false;
    this.root.add(light);
    let panel: THREE.Mesh | null = null;
    if (opts.bulb) {
      const b = LEVEL_KIT.fixture.bulbSize;
      if (opts.flicker) panel = this.ownedPanel(opts.bulb, opts.position, { x: b, y: b, z: b });
      else this.box(opts.bulb, opts.position, { x: b, y: b, z: b }, { collider: false, castShadow: false });
    }
    const handle: LightHandle = {
      light,
      baseIntensity: opts.intensity,
      panel,
      panelBaseIntensity: panel ? (panel.material as THREE.MeshStandardMaterial).emissiveIntensity : 0,
    };
    this.lights.push(handle);
    return handle;
  }

  /** Enable shadows on the highest-priority spot lights within the quality budget. */
  applyShadowQuality(level: QualityLevel): void {
    this.shadowLevel = level;
    const params = QUALITY_LEVELS.shadows[level];
    const max = params ? params.maxLocalShadows : 0;
    const flags = allocateShadowBudget(
      this.shadowCandidates.map((c) => c.priority),
      max,
    );
    this.shadowCandidates.forEach((c, i) => {
      const on = flags[i]!;
      const light = c.light;
      if (params && on) {
        const size = params.localShadowMapSize;
        if (light.shadow.mapSize.x !== size) {
          light.shadow.mapSize.set(size, size);
          light.shadow.map?.dispose();
          light.shadow.map = null;
        }
        light.shadow.radius = params.radius;
        light.shadow.needsUpdate = true;
      }
      // Toggling castShadow changes the shader light setup (recompile) – settings changes only.
      if (light.castShadow !== on) light.castShadow = on;
    });
  }

  get shadowQuality(): QualityLevel {
    return this.shadowLevel;
  }

  /** Staggered refresh of local shadow maps (static world; props still move). Per frame, no allocation. */
  updateShadows(): void {
    const interval = LEVEL_KIT.shadowUpdateInterval;
    const list = this.shadowCandidates;
    for (let i = 0; i < list.length; i++) {
      const l = list[i]!.light;
      if (l.castShadow && staggeredSlot(i, this.frame, interval)) l.shadow.needsUpdate = true;
    }
    this.frame++;
  }

  // -------------------------------------------------------------------------
  // Build / dispose
  // -------------------------------------------------------------------------

  /** Merge buckets into static meshes with BVH bounds trees and add them to the root. */
  build(): void {
    if (this.built) {
      log.warn('LevelKit.build() called twice – ignoring');
      return;
    }
    this.built = true;
    for (const bucket of this.buckets.values()) {
      if (bucket.geometries.length === 0) continue;
      let merged: THREE.BufferGeometry | null = null;
      try {
        merged =
          bucket.geometries.length === 1 ? bucket.geometries[0]! : mergeGeometries(bucket.geometries, false);
      } catch (err) {
        log.error(`Merging bucket "${bucket.materialId}" failed`, err);
      }
      if (!merged) {
        log.warn(
          `Bucket "${bucket.materialId}" could not be merged; skipping ${bucket.geometries.length} parts`,
        );
        for (const g of bucket.geometries) g.dispose();
        continue;
      }
      if (merged !== bucket.geometries[0]) for (const g of bucket.geometries) g.dispose();
      bucket.geometries.length = 0;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      merged.computeBoundsTree();
      this.ownedGeometries.push(merged);
      const mesh = new THREE.Mesh(merged, this.opts.materials.get(bucket.materialId));
      mesh.name = `level:${bucket.materialId}${bucket.castShadow ? '' : ':noshadow'}`;
      mesh.castShadow = bucket.castShadow;
      mesh.receiveShadow = bucket.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.meshes.push(mesh);
      this.triangleCount += (merged.index ? merged.index.count : merged.attributes.position!.count) / 3;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const physics = this.opts.physics;
    for (const b of this.bodies) physics.removeBody(b);
    for (const c of this.colliders) physics.removeCollider(c);
    this.bodies.length = 0;
    this.colliders.length = 0;
    for (const bucket of this.buckets.values()) for (const g of bucket.geometries) g.dispose();
    this.buckets.clear();
    for (const g of this.ownedGeometries) {
      if (g.boundsTree) g.disposeBoundsTree();
      g.dispose();
    }
    this.ownedGeometries.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    for (const h of this.lights) {
      h.light.removeFromParent();
      if (h.light instanceof THREE.SpotLight) h.light.target.removeFromParent();
      h.light.dispose();
    }
    this.lights.length = 0;
    this.meshes.length = 0;
    this.root.removeFromParent();
    this.root.clear();
  }

  // -------------------------------------------------------------------------

  private push(
    materialId: string,
    geo: THREE.BufferGeometry,
    castShadow: boolean,
    receiveShadow: boolean,
  ): void {
    if (this.built) {
      log.warn(`Geometry for "${materialId}" added after build() – ignored`);
      geo.dispose();
      return;
    }
    const key = `${materialId}|${castShadow ? 1 : 0}|${receiveShadow ? 1 : 0}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { materialId, castShadow, receiveShadow, geometries: [] };
      this.buckets.set(key, bucket);
    }
    // mergeGeometries needs identical attribute sets: keep position/normal/uv only.
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    geo.clearGroups();
    bucket.geometries.push(geo);
  }

  /** Standalone emissive mesh with its own material clone (animated intensity). */
  private ownedPanel(materialId: string, center: Vec3Like, size: Vec3Like): THREE.Mesh {
    const base = this.opts.materials.get(materialId);
    const mat = base.clone();
    mat.name = `${base.name}:flicker`;
    // clone() drops the CSM hooks/defines of the shared material: register the copy too.
    this.opts.setupMaterial?.(mat);
    this.ownedMaterials.push(mat);
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    this.ownedGeometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `panel:${materialId}`;
    mesh.position.set(center.x, center.y, center.z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Rewrite a (frame-local) box's UVs as box-projected meters; `offset` shifts into world-continuous space. */
export function applyBoxUV(geo: THREE.BufferGeometry, offset: Vec3Like): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    boxFaceUV(
      pos.getX(i) + offset.x,
      pos.getY(i) + offset.y,
      pos.getZ(i) + offset.z,
      nor.getX(i),
      nor.getY(i),
      nor.getZ(i),
      _uv,
    );
    uv.setXY(i, _uv.x, _uv.y);
  }
  uv.needsUpdate = true;
}

/** Per-face 0..1 UVs scaled to one texture repeat (uvScale meters). */
export function applyFaceUV(geo: THREE.BufferGeometry, uvScale: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
  uv.needsUpdate = true;
}

/** Cylinder UVs in meters: U around (rounded to whole repeats), V along the axis. Caps: planar. */
export function applyCylinderUV(
  geo: THREE.BufferGeometry,
  radius: number,
  length: number,
  uvScale: number,
): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const around = pipeWrapRepeats(radius, uvScale) * uvScale;
  for (let i = 0; i < uv.count; i++) {
    const cap = Math.abs(nor.getY(i)) > 0.5;
    if (cap) uv.setXY(i, uv.getX(i) * radius * 2, uv.getY(i) * radius * 2);
    else uv.setXY(i, uv.getX(i) * around, uv.getY(i) * length);
  }
  uv.needsUpdate = true;
}

/**
 * Flat-shaded indexed prism: `profile` (z, y) counter-clockwise (z right, y up), extruded over x ∈ [-hw, hw].
 * UVs: caps projected (z, y); side faces use the along-edge distance so slopes are not stretched.
 * `worldOrigin`/`rot` place the UVs in world-continuous space.
 */
export function buildPrismGeometry(
  profile: readonly (readonly [number, number])[],
  hw: number,
  worldOrigin: Vec3Like,
  rot: THREE.Quaternion,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  _qInv.copy(rot).invert();
  const off = _v2.set(worldOrigin.x, worldOrigin.y, worldOrigin.z).applyQuaternion(_qInv);
  const n = profile.length;
  // Caps.
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const [z, y] = profile[i]!;
      positions.push(side * hw, y, z);
      normals.push(side, 0, 0);
      boxFaceUV(side * hw + off.x, y + off.y, z + off.z, side, 0, 0, _uv);
      uvs.push(_uv.x, _uv.y);
    }
    for (let i = 1; i < n - 1; i++) {
      // Viewed from -X the (z, y) profile keeps its CCW order; from +X it is mirrored.
      if (side < 0) indices.push(base, base + i, base + i + 1);
      else indices.push(base, base + i + 1, base + i);
    }
  }
  // Sides.
  let along = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [z0, y0] = profile[i]!;
    const [z1, y1] = profile[j]!;
    const ez = z1 - z0;
    const ey = y1 - y0;
    const el = Math.hypot(ez, ey);
    if (el < 1e-6) continue;
    // Outward normal of a CCW polygon edge in the (z, y) plane: edge rotated clockwise.
    const nz = ey / el;
    const ny = -ez / el;
    const base = positions.length / 3;
    const steep = Math.abs(ny) < 0.5;
    const quad: [number, number, number][] = [
      [-hw, y0, z0],
      [hw, y0, z0],
      [hw, y1, z1],
      [-hw, y1, z1],
    ];
    for (let k = 0; k < 4; k++) {
      const q = quad[k]!;
      positions.push(q[0], q[1], q[2]);
      normals.push(0, ny, nz);
      if (steep) {
        boxFaceUV(q[0] + off.x, q[1] + off.y, q[2] + off.z, 0, ny, nz, _uv);
        uvs.push(_uv.x, _uv.y);
      } else {
        // Along the slope: V = distance along the profile edge (meters), U = across.
        const t = k === 0 || k === 1 ? 0 : el;
        uvs.push(q[0] + off.x, along + t);
      }
    }
    along += el;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
