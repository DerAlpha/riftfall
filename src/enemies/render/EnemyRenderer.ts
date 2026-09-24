/**
 * EnemyRenderer (EnemyVisualsApi): one InstancedMesh per enemy type, animated entirely in the
 * vertex shader from per-instance pose attributes, plus the CPU pose mirror for hitboxes/sockets.
 *
 * Tick / frame flow:
 *   fixed tick  AI: acquire → setTransform / setPose (writes the `latest` state) → computeHitboxes
 *               / computeBounds / sockets (the latest pose is evaluated on the CPU once, only the
 *               bones hitboxes and sockets need; world hitboxes + bounds are cached per slot until
 *               the next setPose / setTransform, so repeated queries are cheap)
 *               → commitTick() snapshots latest → curr, curr → prev.
 *   per frame   update(dt, alpha) interpolates prev → curr, packs the visible instances densely
 *               (stable handles, dense GPU order), uploads only the used range of each instance
 *               buffer once, and sets a per-type bounding sphere around the active instances
 *               (frustum culling works for the camera AND the shadow cascades).
 *
 * Draw calls: 1 per type with visible instances (+ shadow cascades) and 1 shared rift-tear draw
 * while enemies emerge. One shader program for all types; warmup() compiles the color and shadow
 * variants up front. Nothing allocates per frame/tick (computeHitboxes may grow `out` once).
 */
import {
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { Hitbox, RenderApi } from '../../core/contracts';
import { createLogger } from '../../core/log';
import { ENEMY_RENDER, ENEMY_VISUALS, getEnemyVisualDef, type EnemyVisualDef } from '../../defs/enemyVisuals';
import { setUpdateRange, type UpdateRange } from '../../vfx/gpuUpload';
import type { EnemyInstanceHandle, EnemyPose, EnemyTypeId, EnemyVisualsApi } from '../types';
import {
  createEnemyMaterials,
  createSharedUniforms,
  setFlashScale,
  type EnemyMaterialSet,
  type EnemySharedUniforms,
} from './enemyShader';
import { createEnemySurfaceTexture } from './enemyTextures';
import { buildTypeGeometry } from './partGeometry';
import {
  BONE_STRIDE,
  SLOT,
  SLOT_STRIDE,
  HITBOX_STRIDE,
  boneScale,
  boneTransformPoint,
  boundsOfPacked,
  compileRig,
  evaluateRig,
  slotModelToWorld,
  type CompiledRig,
  type CompiledSocket,
} from './poseMath';
import { RiftTears, tearOpen } from './RiftTears';

const log = createLogger('EnemyRenderer');

const TAU = Math.PI * 2;
/** Golden-ratio sequence for per-instance seeds (deterministic, well spread). */
const SEED_STEP = 0.6180339887;

export interface EnemyRendererDeps {
  /** World scene: the renderer adds its root group; warmup() renders it once. */
  scene: Scene;
  render: Pick<RenderApi, 'setupMaterial'>;
  /** Types to build (default: every ENEMY_VISUALS entry). */
  types?: readonly string[];
  /** Instance capacity overrides (default: the def's capacity). */
  capacities?: Readonly<Record<string, number>>;
  reduceFlashing?: boolean;
  /** Build GPU-side resources (procedural surface texture). Tests may pass false. */
  surfaceTexture?: boolean;
}

interface TypeState {
  readonly id: string;
  readonly def: EnemyVisualDef;
  readonly rig: CompiledRig;
  readonly capacity: number;
  readonly geometry: BufferGeometry;
  readonly rigTexture: DataTexture;
  readonly mats: EnemyMaterialSet;
  readonly mesh: InstancedMesh;
  readonly pose0: InstancedBufferAttribute;
  readonly pose1: InstancedBufferAttribute;
  readonly pose2: InstancedBufferAttribute;
  readonly rim: InstancedBufferAttribute;
  /** instanceMatrix + the pose attributes (upload order), with one reused update range each. */
  readonly attrs: readonly InstancedBufferAttribute[];
  readonly ranges: UpdateRange[];
  /** Slot state (SLOT layout): set by the AI, snapshot at commitTick, previous snapshot. */
  readonly latest: Float32Array;
  readonly curr: Float32Array;
  readonly prev: Float32Array;
  readonly seeds: Float32Array;
  readonly alive: Uint8Array;
  /** Slot has been through commitTick at least once since acquire (drawable). */
  readonly committed: Uint8Array;
  /** Next commit copies the snapshot into `prev` too (fresh slot: no interpolation from stale data). */
  readonly snap: Uint8Array;
  readonly free: Int32Array;
  freeTop: number;
  readonly active: Int32Array;
  readonly activeIndex: Int32Array;
  activeCount: number;
  /** CPU bone matrices of the latest pose, per slot (BONE_STRIDE × bones). */
  readonly bones: Float32Array;
  readonly boneValid: Uint8Array;
  readonly boneStride: number;
  /**
   * World hitboxes of the latest pose per slot (HITBOX_STRIDE floats each: a, b, radius) and their
   * bounds (center, radius): computed once per pose/transform change, shared by every query.
   */
  readonly world: Float32Array;
  readonly worldBounds: Float32Array;
  readonly worldValid: Uint8Array;
  readonly worldStride: number;
  /** Rest-pose reach around the feet + cull margin (m at scale 1). */
  readonly reach: number;
  readonly sphere: Sphere;
  drawn: number;
}

const _p = new Vector3();
const _acc = new Vector3();

/**
 * Frustum-culling reach of a type around its instance origin (m at scale 1): the farthest rest-pose
 * bounding-box corner plus the def's margin for animated poses (leaps, raised arms, death sprawl).
 */
export function cullReach(geometry: BufferGeometry, cullMargin: number): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  let rest = 0;
  for (const x of [bb.min.x, bb.max.x])
    for (const y of [bb.min.y, bb.max.y])
      for (const z of [bb.min.z, bb.max.z]) rest = Math.max(rest, Math.hypot(x, y, z));
  return rest + cullMargin;
}

function makeHitbox(): Hitbox {
  return { shape: 'sphere', zone: 'body', a: new Vector3(), b: new Vector3(), radius: 0 };
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** prev → curr blend of one slot field. */
function lerpAt(prev: Float32Array, curr: Float32Array, i: number, t: number): number {
  return prev[i]! + (curr[i]! - prev[i]!) * t;
}

function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export class EnemyRenderer implements EnemyVisualsApi {
  readonly root = new Group();
  readonly stats = { instances: 0, drawCalls: 0 };

  private readonly scene: Scene;
  private readonly typeList: TypeState[] = [];
  private readonly types = new Map<string, TypeState>();
  private readonly shared: EnemySharedUniforms;
  private readonly surface: DataTexture | null;
  private readonly tears: RiftTears;
  private readonly warnedTypes = new Set<string>();
  private readonly warnedSockets = new Set<string>();
  private time = 0;
  private seedCounter = 0;
  private disposed = false;

  constructor(deps: EnemyRendererDeps) {
    this.scene = deps.scene;
    this.root.name = 'Enemies';
    this.root.matrixAutoUpdate = false;
    this.surface = deps.surfaceTexture === false ? null : createEnemySurfaceTexture();
    this.shared = createSharedUniforms(this.surface);
    if (deps.reduceFlashing) this.setReducedFlashing(true);
    const ids = deps.types ?? Object.keys(ENEMY_VISUALS);
    for (const id of ids) {
      const def = getEnemyVisualDef(id);
      if (!def) {
        log.warn(`Unknown enemy visual type "${id}" – skipped`);
        continue;
      }
      const capacity = Math.max(0, Math.floor(deps.capacities?.[id] ?? def.capacity));
      const ts = this.createType(id, def, capacity, deps.render);
      this.typeList.push(ts);
      this.types.set(id, ts);
    }
    this.tears = new RiftTears(this.root, this.surface, this.shared.rfTime);
    const riftColor = this.typeList[0]?.def.rift.color ?? [1, 1, 1];
    this.tears.setColor(riftColor[0], riftColor[1], riftColor[2]);
    this.scene.add(this.root);
  }

  // -------------------------------------------------------------------------
  // EnemyVisualsApi
  // -------------------------------------------------------------------------

  acquire(type: EnemyTypeId): EnemyInstanceHandle {
    const ts = this.typeState(type);
    if (!ts || ts.freeTop === 0) return -1;
    const slot = ts.free[--ts.freeTop]!;
    ts.alive[slot] = 1;
    ts.committed[slot] = 0;
    ts.snap[slot] = 1;
    ts.boneValid[slot] = 0;
    ts.worldValid[slot] = 0;
    this.seedCounter++;
    ts.seeds[slot] = (this.seedCounter * SEED_STEP) % 1;
    const o = slot * SLOT_STRIDE;
    const s = ts.latest;
    s.fill(0, o, o + SLOT_STRIDE);
    s[o + SLOT.scale] = 1;
    s[o + SLOT.attackId] = -1;
    s[o + SLOT.emerge] = 1;
    const rc = ENEMY_RENDER.defaultRimColor;
    s[o + SLOT.rimR] = rc[0];
    s[o + SLOT.rimG] = rc[1];
    s[o + SLOT.rimB] = rc[2];
    ts.activeIndex[slot] = ts.activeCount;
    ts.active[ts.activeCount++] = slot;
    return slot;
  }

  release(type: EnemyTypeId, handle: EnemyInstanceHandle): void {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return;
    ts.alive[handle] = 0;
    ts.committed[handle] = 0;
    const i = ts.activeIndex[handle]!;
    const last = ts.active[--ts.activeCount]!;
    ts.active[i] = last;
    ts.activeIndex[last] = i;
    ts.activeIndex[handle] = -1;
    ts.free[ts.freeTop++] = handle;
  }

  setTransform(type: EnemyTypeId, handle: EnemyInstanceHandle, position: Vector3, yaw: number): void {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return;
    const o = handle * SLOT_STRIDE;
    const s = ts.latest;
    s[o + SLOT.x] = finiteOr(position.x, s[o + SLOT.x]!);
    s[o + SLOT.y] = finiteOr(position.y, s[o + SLOT.y]!);
    s[o + SLOT.z] = finiteOr(position.z, s[o + SLOT.z]!);
    s[o + SLOT.yaw] = finiteOr(yaw, s[o + SLOT.yaw]!);
    ts.worldValid[handle] = 0;
  }

  setPose(type: EnemyTypeId, handle: EnemyInstanceHandle, pose: Readonly<EnemyPose>): void {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return;
    const o = handle * SLOT_STRIDE;
    const s = ts.latest;
    s[o + SLOT.scale] = Math.max(ENEMY_RENDER.minInstanceScale, finiteOr(pose.scale, 1));
    s[o + SLOT.locomotion] = finiteOr(pose.locomotion, 0);
    s[o + SLOT.phase] = finiteOr(pose.phase, 0);
    s[o + SLOT.attackId] = finiteOr(pose.attackId, -1);
    s[o + SLOT.attack] = finiteOr(pose.attack, 0);
    s[o + SLOT.stagger] = finiteOr(pose.stagger, 0);
    s[o + SLOT.death] = finiteOr(pose.death, 0);
    s[o + SLOT.dissolve] = finiteOr(pose.dissolve, 0);
    s[o + SLOT.emerge] = finiteOr(pose.emerge, 1);
    s[o + SLOT.hitFlash] = finiteOr(pose.hitFlash, 0);
    s[o + SLOT.lookYaw] = finiteOr(pose.lookYaw, 0);
    s[o + SLOT.lookPitch] = finiteOr(pose.lookPitch, 0);
    s[o + SLOT.rim] = finiteOr(pose.rim, 0);
    const c = pose.rimColor;
    if (c) {
      s[o + SLOT.rimR] = finiteOr(c.r, 0);
      s[o + SLOT.rimG] = finiteOr(c.g, 0);
      s[o + SLOT.rimB] = finiteOr(c.b, 0);
    }
    ts.boneValid[handle] = 0;
    ts.worldValid[handle] = 0;
  }

  commitTick(): void {
    const snapSq = ENEMY_RENDER.snapDistance * ENEMY_RENDER.snapDistance;
    for (let t = 0; t < this.typeList.length; t++) {
      const ts = this.typeList[t]!;
      ts.prev.set(ts.curr);
      ts.curr.set(ts.latest);
      for (let i = 0; i < ts.activeCount; i++) {
        const slot = ts.active[i]!;
        const o = slot * SLOT_STRIDE;
        let snap = ts.snap[slot] === 1 || ts.committed[slot] === 0;
        if (!snap) {
          const dx = ts.curr[o + SLOT.x]! - ts.prev[o + SLOT.x]!;
          const dy = ts.curr[o + SLOT.y]! - ts.prev[o + SLOT.y]!;
          const dz = ts.curr[o + SLOT.z]! - ts.prev[o + SLOT.z]!;
          snap = dx * dx + dy * dy + dz * dz > snapSq;
        }
        if (snap) {
          for (let k = 0; k < SLOT_STRIDE; k++) ts.prev[o + k] = ts.curr[o + k]!;
        }
        ts.snap[slot] = 0;
        ts.committed[slot] = 1;
      }
    }
  }

  computeHitboxes(type: EnemyTypeId, handle: EnemyInstanceHandle, out: Hitbox[]): number {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return 0;
    return this.fillHitboxes(ts, handle, out);
  }

  computeBounds(type: EnemyTypeId, handle: EnemyInstanceHandle, outCenter: Vector3): number {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return 0;
    this.ensureWorld(ts, handle);
    const b = handle * 4;
    outCenter.set(ts.worldBounds[b]!, ts.worldBounds[b + 1]!, ts.worldBounds[b + 2]!);
    return ts.worldBounds[b + 3]!;
  }

  computeAimPoint(type: EnemyTypeId, handle: EnemyInstanceHandle, out: Vector3): Vector3 {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return out;
    return this.socketWorld(ts, handle, ts.rig.aim, out);
  }

  computeSocket(type: EnemyTypeId, handle: EnemyInstanceHandle, socket: string, out: Vector3): Vector3 {
    const ts = this.types.get(type);
    if (!ts || !this.valid(ts, handle)) return out;
    let s = ts.rig.sockets.get(socket);
    if (!s) {
      const key = `${type}:${socket}`;
      if (!this.warnedSockets.has(key)) {
        this.warnedSockets.add(key);
        log.warn(`Enemy "${type}" has no socket "${socket}" – using the aim point`);
      }
      s = ts.rig.aim;
    }
    return this.socketWorld(ts, handle, s, out);
  }

  update(dt: number, alpha: number): void {
    if (this.disposed) return;
    if (dt > 0 && Number.isFinite(dt)) this.time = (this.time + dt) % ENEMY_RENDER.timeWrap;
    this.shared.rfTime.value = this.time;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : Number.isFinite(alpha) ? alpha : 1;
    let instances = 0;
    let draws = 0;
    this.tears.begin();
    for (let t = 0; t < this.typeList.length; t++) {
      const n = this.packType(this.typeList[t]!, a);
      instances += n;
      if (n > 0) draws++;
    }
    this.tears.end();
    if (this.tears.visible) draws++;
    this.stats.instances = instances;
    this.stats.drawCalls = draws;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const ts of this.typeList) {
      ts.mesh.removeFromParent();
      ts.mesh.dispose();
      ts.geometry.dispose();
      ts.mats.dispose();
      ts.rigTexture.dispose();
    }
    this.tears.dispose();
    this.surface?.dispose();
    this.typeList.length = 0;
    this.types.clear();
  }

  // -------------------------------------------------------------------------
  // Extras (Game integration)
  // -------------------------------------------------------------------------

  /** Rift tears are drawing (volumetric layer): feed into render.setVolumetricContentProbe. */
  get hasVolumetricContent(): boolean {
    return this.tears.visible;
  }

  /** Accessibility "reduce flashing": dims the white-hot hit flash. */
  setReducedFlashing(on: boolean): void {
    setFlashScale(this.shared, on ? ENEMY_RENDER.hitFlash.reducedFlashingScale : 1);
  }

  /** Enemies cast sun shadows (default on). */
  setShadows(cast: boolean): void {
    for (const ts of this.typeList) ts.mesh.castShadow = cast;
  }

  /** Types built by this renderer. */
  get typeIds(): readonly string[] {
    return this.typeList.map((t) => t.id);
  }

  /** Free instance slots of a type (0 for unknown types). */
  available(type: EnemyTypeId): number {
    return this.types.get(type)?.freeTop ?? 0;
  }

  /**
   * Compile every enemy program (color + shadow depth) before the first spawn: one fully
   * dissolved instance per type in front of the camera, compiled and rendered once into a 1×1
   * target with the world's lights (programs key on the output color space and the light setup,
   * see Game.compileForPostChain). Call after the atmosphere (final light count) is applied.
   */
  warmup(renderer: WebGLRenderer, camera: Camera): void {
    if (this.disposed) return;
    camera.updateMatrixWorld();
    camera.getWorldDirection(_acc);
    _p.setFromMatrixPosition(camera.matrixWorld).addScaledVector(_acc, ENEMY_RENDER.warmupDistance);
    for (const ts of this.typeList) {
      if (ts.capacity === 0) continue;
      const m = ts.mesh.instanceMatrix.array as Float32Array;
      m.fill(0, 0, 16);
      m[0] = 1;
      m[5] = 1;
      m[10] = 1;
      m[12] = _p.x;
      m[13] = _p.y;
      m[14] = _p.z;
      m[15] = 1;
      (ts.pose0.array as Float32Array).set([0, 0, -1, 0], 0);
      (ts.pose1.array as Float32Array).set([0, 0, 1, 1], 0);
      (ts.pose2.array as Float32Array).set([0, 0, 0, 0], 0);
      (ts.rim.array as Float32Array).set([0, 0, 0, 0], 0);
      for (const attr of ts.attrs) {
        attr.clearUpdateRanges();
        attr.needsUpdate = true;
      }
      ts.mesh.count = 1;
      ts.mesh.visible = true;
      ts.mesh.frustumCulled = false;
    }
    this.tears.begin();
    this.tears.push(_p.x, _p.y, _p.z, 0, 1, 0, 0);
    this.tears.end();
    const target = new WebGLRenderTarget(1, 1);
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.compile(this.scene, camera);
      renderer.render(this.scene, camera);
    } catch (err) {
      log.warn('Enemy shader warm-up failed', err);
    } finally {
      renderer.setRenderTarget(previous);
      target.dispose();
      for (const ts of this.typeList) {
        ts.mesh.count = 0;
        ts.mesh.visible = false;
        ts.mesh.frustumCulled = true;
        ts.drawn = 0;
      }
      this.tears.begin();
      this.tears.end();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private typeState(type: string): TypeState | undefined {
    const ts = this.types.get(type);
    if (!ts && !this.warnedTypes.has(type)) {
      this.warnedTypes.add(type);
      log.warn(`No visuals for enemy type "${type}"`);
    }
    return ts;
  }

  private valid(ts: TypeState, handle: number): boolean {
    return Number.isInteger(handle) && handle >= 0 && handle < ts.capacity && ts.alive[handle] === 1;
  }

  private createType(
    id: string,
    def: EnemyVisualDef,
    capacity: number,
    render: EnemyRendererDeps['render'],
  ): TypeState {
    const rig = compileRig(id, def);
    const geometry = buildTypeGeometry(rig.parts);
    const L = rig.layout;
    const rigTexture = new DataTexture(rig.data, L.width, L.height, RGBAFormat, FloatType);
    rigTexture.name = `enemy-rig:${id}`;
    rigTexture.magFilter = NearestFilter;
    rigTexture.minFilter = NearestFilter;
    rigTexture.generateMipmaps = false;
    rigTexture.needsUpdate = true;
    const mats = createEnemyMaterials(id, rig, def, rigTexture, this.shared);
    render.setupMaterial(mats.material);

    const slots = Math.max(1, capacity);
    const mesh = new InstancedMesh(geometry, mats.material, slots);
    mesh.name = `enemies:${id}`;
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.customDepthMaterial = mats.depth;
    mesh.customDistanceMaterial = mats.distance;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const attr = (name: string): InstancedBufferAttribute => {
      const a = new InstancedBufferAttribute(new Float32Array(slots * 4), 4);
      a.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    const pose0 = attr('rfPose0');
    const pose1 = attr('rfPose1');
    const pose2 = attr('rfPose2');
    const rim = attr('rfRimAttr');
    // Frustum culling uses this sphere (camera and shadow cascades); update() keeps it around the
    // active instances.
    const sphere = new Sphere(new Vector3(), 0);
    mesh.boundingSphere = sphere;
    this.root.add(mesh);

    const free = new Int32Array(slots);
    for (let i = 0; i < capacity; i++) free[i] = capacity - 1 - i;
    const boneStride = rig.bones.length * BONE_STRIDE;
    return {
      id,
      def,
      rig,
      capacity,
      geometry,
      rigTexture,
      mats,
      mesh,
      pose0,
      pose1,
      pose2,
      rim,
      attrs: [mesh.instanceMatrix, pose0, pose1, pose2, rim],
      ranges: [0, 1, 2, 3, 4].map(() => ({ start: 0, count: 0 })),
      latest: new Float32Array(slots * SLOT_STRIDE),
      curr: new Float32Array(slots * SLOT_STRIDE),
      prev: new Float32Array(slots * SLOT_STRIDE),
      seeds: new Float32Array(slots),
      alive: new Uint8Array(slots),
      committed: new Uint8Array(slots),
      snap: new Uint8Array(slots),
      free,
      freeTop: capacity,
      active: new Int32Array(slots),
      activeIndex: new Int32Array(slots).fill(-1),
      activeCount: 0,
      bones: new Float32Array(slots * boneStride),
      boneValid: new Uint8Array(slots),
      boneStride,
      world: new Float32Array(slots * rig.hitboxes.length * HITBOX_STRIDE),
      worldBounds: new Float32Array(slots * 4),
      worldValid: new Uint8Array(slots),
      worldStride: rig.hitboxes.length * HITBOX_STRIDE,
      reach: cullReach(geometry, def.cullMargin),
      sphere,
      drawn: 0,
    };
  }

  private ensureBones(ts: TypeState, slot: number): void {
    if (ts.boneValid[slot] === 1) return;
    evaluateRig(
      ts.rig,
      ts.latest,
      slot * SLOT_STRIDE,
      this.time,
      ts.seeds[slot]!,
      ts.bones,
      slot * ts.boneStride,
      true,
    );
    ts.boneValid[slot] = 1;
  }

  /** World hitboxes + bounds of the latest pose (cached until the next setPose / setTransform). */
  private ensureWorld(ts: TypeState, slot: number): void {
    if (ts.worldValid[slot] === 1) return;
    this.ensureBones(ts, slot);
    const s = ts.latest;
    const o = slot * SLOT_STRIDE;
    const k = s[o + SLOT.scale]!;
    const yaw = s[o + SLOT.yaw]!;
    const c = Math.cos(yaw) * k;
    const sn = Math.sin(yaw) * k;
    const px = s[o + SLOT.x]!;
    const py = s[o + SLOT.y]!;
    const pz = s[o + SLOT.z]!;
    const mats = ts.bones;
    const bo = slot * ts.boneStride;
    const w = ts.world;
    const boxes = ts.rig.hitboxes;
    let q = slot * ts.worldStride;
    for (let i = 0; i < boxes.length; i++) {
      const def = boxes[i]!;
      const m = bo + def.bone * BONE_STRIDE;
      for (let e = 0; e < 2; e++) {
        const p = e === 0 ? def.a : def.b;
        const x = mats[m]! * p[0] + mats[m + 1]! * p[1] + mats[m + 2]! * p[2] + mats[m + 3]!;
        const y = mats[m + 4]! * p[0] + mats[m + 5]! * p[1] + mats[m + 6]! * p[2] + mats[m + 7]!;
        const z = mats[m + 8]! * p[0] + mats[m + 9]! * p[1] + mats[m + 10]! * p[2] + mats[m + 11]!;
        w[q++] = c * x + sn * z + px;
        w[q++] = y * k + py;
        w[q++] = -sn * x + c * z + pz;
      }
      w[q++] = def.radius * k * boneScale(mats, bo, def.bone);
    }
    boundsOfPacked(w, slot * ts.worldStride, boxes.length, ts.worldBounds, slot * 4);
    ts.worldValid[slot] = 1;
  }

  private fillHitboxes(ts: TypeState, slot: number, out: Hitbox[]): number {
    this.ensureWorld(ts, slot);
    const boxes = ts.rig.hitboxes;
    const n = boxes.length;
    while (out.length < n) out.push(makeHitbox());
    const w = ts.world;
    let q = slot * ts.worldStride;
    for (let i = 0; i < n; i++) {
      const def = boxes[i]!;
      const h = out[i]!;
      h.shape = def.shape;
      h.zone = def.zone;
      h.a.set(w[q]!, w[q + 1]!, w[q + 2]!);
      h.b.set(w[q + 3]!, w[q + 4]!, w[q + 5]!);
      h.radius = w[q + 6]!;
      q += HITBOX_STRIDE;
    }
    return n;
  }

  private socketWorld(ts: TypeState, slot: number, socket: CompiledSocket, out: Vector3): Vector3 {
    this.ensureBones(ts, slot);
    const bo = slot * ts.boneStride;
    const count = socket.bones.length;
    _acc.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      boneTransformPoint(ts.bones, bo, socket.bones[i]!, socket.points[i]!, _p);
      _acc.add(_p);
    }
    out.copy(_acc).multiplyScalar(1 / Math.max(1, count));
    return slotModelToWorld(ts.latest, slot * SLOT_STRIDE, out);
  }

  /** Interpolate + pack the drawable instances of one type; returns the drawn count. */
  private packType(ts: TypeState, alpha: number): number {
    const mArr = ts.mesh.instanceMatrix.array as Float32Array;
    const p0 = ts.pose0.array as Float32Array;
    const p1 = ts.pose1.array as Float32Array;
    const p2 = ts.pose2.array as Float32Array;
    const rim = ts.rim.array as Float32Array;
    const prev = ts.prev;
    const curr = ts.curr;
    let k = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let maxScale = 0;
    for (let i = 0; i < ts.activeCount; i++) {
      const slot = ts.active[i]!;
      if (ts.committed[slot] !== 1) continue;
      const o = slot * SLOT_STRIDE;
      if (curr[o + SLOT.dissolve]! >= 1 && prev[o + SLOT.dissolve]! >= 1) continue;
      const x = lerpAt(prev, curr, o + SLOT.x, alpha);
      const y = lerpAt(prev, curr, o + SLOT.y, alpha);
      const z = lerpAt(prev, curr, o + SLOT.z, alpha);
      const yaw = prev[o + SLOT.yaw]! + wrapPi(curr[o + SLOT.yaw]! - prev[o + SLOT.yaw]!) * alpha;
      const scale = lerpAt(prev, curr, o + SLOT.scale, alpha);
      const c = Math.cos(yaw) * scale;
      const s = Math.sin(yaw) * scale;
      const m = k * 16;
      mArr[m] = c;
      mArr[m + 1] = 0;
      mArr[m + 2] = -s;
      mArr[m + 3] = 0;
      mArr[m + 4] = 0;
      mArr[m + 5] = scale;
      mArr[m + 6] = 0;
      mArr[m + 7] = 0;
      mArr[m + 8] = s;
      mArr[m + 9] = 0;
      mArr[m + 10] = c;
      mArr[m + 11] = 0;
      mArr[m + 12] = x;
      mArr[m + 13] = y;
      mArr[m + 14] = z;
      mArr[m + 15] = 1;
      let phase = prev[o + SLOT.phase]! + wrapPi(curr[o + SLOT.phase]! - prev[o + SLOT.phase]!) * alpha;
      phase -= Math.floor(phase / TAU) * TAU;
      // Attack progress only runs forward: a new attack (other id, or the same one restarted)
      // starts at its current progress instead of sweeping back through the previous strike.
      const attackId = curr[o + SLOT.attackId]!;
      const attackNow = curr[o + SLOT.attack]!;
      const attack =
        prev[o + SLOT.attackId] === attackId && attackNow >= prev[o + SLOT.attack]!
          ? lerpAt(prev, curr, o + SLOT.attack, alpha)
          : attackNow;
      const q = k * 4;
      p0[q] = lerpAt(prev, curr, o + SLOT.locomotion, alpha);
      p0[q + 1] = phase;
      p0[q + 2] = attackId;
      p0[q + 3] = attack;
      p1[q] = lerpAt(prev, curr, o + SLOT.stagger, alpha);
      p1[q + 1] = lerpAt(prev, curr, o + SLOT.death, alpha);
      p1[q + 2] = lerpAt(prev, curr, o + SLOT.dissolve, alpha);
      const emerge = lerpAt(prev, curr, o + SLOT.emerge, alpha);
      p1[q + 3] = emerge;
      p2[q] = lerpAt(prev, curr, o + SLOT.hitFlash, alpha);
      p2[q + 1] = lerpAt(prev, curr, o + SLOT.lookYaw, alpha);
      p2[q + 2] = lerpAt(prev, curr, o + SLOT.lookPitch, alpha);
      p2[q + 3] = ts.seeds[slot]!;
      rim[q] = curr[o + SLOT.rimR]!;
      rim[q + 1] = curr[o + SLOT.rimG]!;
      rim[q + 2] = curr[o + SLOT.rimB]!;
      rim[q + 3] = lerpAt(prev, curr, o + SLOT.rim, alpha);
      if (emerge < 1 && curr[o + SLOT.death]! <= 0) {
        this.tears.push(
          x,
          y,
          z,
          ts.def.rift.tearRadius * scale,
          tearOpen(emerge),
          ts.seeds[slot]!,
          ts.seeds[slot]! * TAU,
        );
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      maxScale = Math.max(maxScale, scale);
      k++;
    }
    ts.drawn = k;
    ts.mesh.count = k;
    ts.mesh.visible = k > 0;
    if (k === 0) return 0;
    const attrs = ts.attrs;
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i]!;
      setUpdateRange(attr, ts.ranges[i]!, 0, k * attr.itemSize);
      attr.needsUpdate = true;
    }
    const sphere = ts.sphere;
    sphere.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const ex = maxX - minX;
    const ey = maxY - minY;
    const ez = maxZ - minZ;
    sphere.radius = Math.sqrt(ex * ex + ey * ey + ez * ez) * 0.5 + ts.reach * maxScale;
    return k;
  }
}
