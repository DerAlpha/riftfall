/**
 * Rapier wrapper: world lifetime, collider metadata, static/dynamic helpers, scene
 * queries and interpolation of dynamic prop visuals between fixed steps.
 *
 * Notes on Rapier 0.20 behaviour this class relies on:
 * - Scene queries (rays, shape tests, the character controller) only see colliders that
 *   were added before the last `world.step()`. New colliders mark the query structure
 *   dirty; `ensureQueries()` flushes it with a zero-length step (no simulation advance).
 * - Collider handles are plain numbers and are used as keys for ColliderData.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ColliderData, PhysicsApi, RaycastHit, RaycastOptions } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { COLLISION_FILTER, COLLISION_GROUP, PHYSICS, interactionGroups } from '../defs/physics';

const log = createLogger('physics');

const IDENTITY_ROTATION: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 };
const ZERO: RAPIER.Vector = { x: 0, y: 0, z: 0 };
/** Radius of the inert placeholder collider returned for invalid shape input (never collides). */
const INERT_RADIUS = 0.01;
const DEFAULT_WORLD_DATA: Readonly<ColliderData> = { kind: 'world', surface: 'default' };
const DEFAULT_PROP_DATA: Readonly<ColliderData> = { kind: 'prop', surface: 'metal' };

interface DynamicEntry {
  body: RAPIER.RigidBody;
  object: Object3D | null;
  prevPos: Vector3;
  currPos: Vector3;
  prevRot: Quaternion;
  currRot: Quaternion;
  spawnPos: Vector3;
  spawnRot: Quaternion;
  /** The visual was written in its resting pose; skip until the body moves again. */
  restSynced: boolean;
}

function finiteVec(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Rapier panics inside WASM (leaving the module unusable) on out-of-range indices and throws on
 * empty meshes, so trimesh input is validated up front. Returns an error message or null.
 */
export function validateTrimesh(vertices: Float32Array, indices: Uint32Array): string | null {
  if (vertices.length < 9 || vertices.length % 3 !== 0) return `bad vertex array length ${vertices.length}`;
  if (indices.length < 3 || indices.length % 3 !== 0) return `bad index array length ${indices.length}`;
  const count = vertices.length / 3;
  for (let i = 0; i < indices.length; i++)
    if (indices[i]! >= count) return `index ${indices[i]} out of range (${count} vertices)`;
  for (let i = 0; i < vertices.length; i++)
    if (!Number.isFinite(vertices[i])) return `non-finite vertex component at ${i}`;
  return null;
}

/** Membership group + default filter for a collider kind (used for collision AND solver groups). */
export function groupsForKind(kind: ColliderData['kind']): number {
  switch (kind) {
    case 'world':
      return interactionGroups(COLLISION_GROUP.WORLD, COLLISION_FILTER.world);
    case 'prop':
      return interactionGroups(COLLISION_GROUP.PROP, COLLISION_FILTER.prop);
    case 'player':
      return interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_FILTER.player);
    case 'enemy':
      return interactionGroups(COLLISION_GROUP.ENEMY, COLLISION_FILTER.enemy);
    case 'trigger':
      return interactionGroups(COLLISION_GROUP.TRIGGER, COLLISION_FILTER.trigger);
  }
}

export class PhysicsWorld implements PhysicsApi {
  readonly rapier: typeof RAPIER = RAPIER;
  readonly world: RAPIER.World;
  readonly stats = { bodies: 0, colliders: 0, dynamicBodies: 0, stepMs: 0 };

  private readonly colliderData = new Map<number, ColliderData>();
  private readonly dynamics: DynamicEntry[] = [];
  private readonly dynamicByHandle = new Map<number, DynamicEntry>();
  private queriesDirty = true;
  private _disposed = false;

  // Scratch objects reused by queries. The returned RaycastHit is shared (see raycast()).
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly hit: RaycastHit;
  private readonly castVel: RAPIER.Vector = { x: 0, y: 0, z: 0 };

  /** Initialise the Rapier WASM module (idempotent) and create a world. */
  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  /** Prefer `PhysicsWorld.create()`; the constructor requires `RAPIER.init()` to have resolved. */
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.integrationParameters.numSolverIterations = PHYSICS.solverIterations;
    this.hit = {
      point: new Vector3(),
      normal: new Vector3(),
      distance: 0,
      // Placeholder until the first hit; never exposed while null-ish (raycast returns null on miss).
      collider: undefined as unknown as RAPIER.Collider,
      data: undefined,
    };
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  step(dt: number): void {
    if (this._disposed) return;
    const t0 = performance.now();
    if (this.world.timestep !== dt) this.world.timestep = dt;
    this.world.step();
    this.queriesDirty = false;
    this.afterStep();
    this.stats.stepMs = performance.now() - t0;
    this.refreshCounts();
  }

  /**
   * Make scene queries see colliders added since the last step. Cheap no-op when nothing
   * changed. Called automatically by this class' query helpers; call it before using the
   * raw `world` query API or a character controller.
   */
  ensureQueries(): void {
    if (!this.queriesDirty || this._disposed) return;
    const dt = this.world.timestep;
    // A zero-length step rebuilds the broad phase without integrating anything.
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = dt;
    this.queriesDirty = false;
  }

  /** Mark the query structure stale (e.g. after creating colliders through the raw `world`). */
  markQueriesDirty(): void {
    this.queriesDirty = true;
  }

  private afterStep(): void {
    const killY = PHYSICS.killPlaneY;
    for (let i = 0; i < this.dynamics.length; i++) {
      const e = this.dynamics[i]!;
      if (e.body.isSleeping()) {
        if (!e.restSynced) {
          // Collapse the interpolation window so the resting pose is exact.
          e.prevPos.copy(e.currPos);
          e.prevRot.copy(e.currRot);
        }
        continue;
      }
      e.restSynced = false;
      e.prevPos.copy(e.currPos);
      e.prevRot.copy(e.currRot);
      e.body.translation(e.currPos);
      e.body.rotation(e.currRot);
      if (e.currPos.y < killY) this.resetToSpawn(e);
    }
  }

  private resetToSpawn(e: DynamicEntry): void {
    log.debug(`dynamic body ${e.body.handle} fell below kill plane, resetting`);
    e.body.setTranslation(e.spawnPos, true);
    e.body.setRotation(e.spawnRot, true);
    e.body.setLinvel(ZERO, true);
    e.body.setAngvel(ZERO, true);
    e.currPos.copy(e.spawnPos);
    e.prevPos.copy(e.spawnPos);
    e.currRot.copy(e.spawnRot);
    e.prevRot.copy(e.spawnRot);
  }

  /**
   * Interpolate registered dynamic visuals between the last two fixed steps.
   * Visual objects are assumed to live in world space (scene child or untransformed parent).
   */
  syncVisuals(alpha: number): void {
    for (let i = 0; i < this.dynamics.length; i++) {
      const e = this.dynamics[i]!;
      const obj = e.object;
      if (!obj || e.restSynced) continue;
      obj.position.lerpVectors(e.prevPos, e.currPos, alpha);
      obj.quaternion.slerpQuaternions(e.prevRot, e.currRot, alpha);
      if (e.body.isSleeping()) e.restSynced = e.prevPos.equals(e.currPos);
    }
  }

  // -------------------------------------------------------------------------
  // Bodies & colliders
  // -------------------------------------------------------------------------

  addStaticBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    rotation?: RAPIER.Rotation,
    data: ColliderData = DEFAULT_WORLD_DATA,
  ): RAPIER.Collider {
    if (!finiteVec(center) || !finiteVec(halfExtents)) {
      log.warn('addStaticBox: non-finite center/half extents, using an inert placeholder collider');
      return this.inertCollider(data);
    }
    const groups = groupsForKind(data.kind);
    const desc = RAPIER.ColliderDesc.cuboid(
      Math.abs(halfExtents.x),
      Math.abs(halfExtents.y),
      Math.abs(halfExtents.z),
    )
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(groups)
      .setSolverGroups(groups);
    if (rotation) desc.setRotation(rotation);
    if (data.kind === 'trigger') {
      // Fixed sensors ignore kinematic bodies (the player) unless KINEMATIC_FIXED is active;
      // poll with world.intersectionPair(trigger, player.collider) / intersectionPairsWith.
      desc
        .setSensor(true)
        .setActiveCollisionTypes(
          RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED,
        );
    }
    return this.registerNewCollider(desc, null, data);
  }

  addStaticTrimesh(
    vertices: Float32Array,
    indices: Uint32Array,
    data: ColliderData = DEFAULT_WORLD_DATA,
  ): RAPIER.Collider {
    const problem = validateTrimesh(vertices, indices);
    if (problem) {
      log.warn(`addStaticTrimesh: ${problem}; using an inert placeholder collider`);
      return this.inertCollider(data);
    }
    // FIX_INTERNAL_EDGES avoids the character snagging on internal triangle edges of ramps/floors.
    const groups = groupsForKind(data.kind);
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setCollisionGroups(groups)
      .setSolverGroups(groups);
    return this.registerNewCollider(desc, null, data);
  }

  addDynamicBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    object: Object3D | null,
    opts?: { rotation?: RAPIER.Rotation; density?: number; data?: ColliderData },
  ): RAPIER.RigidBody {
    const rot = opts?.rotation ?? IDENTITY_ROTATION;
    const data = opts?.data ?? DEFAULT_PROP_DATA;
    if (!finiteVec(center) || !finiteVec(halfExtents)) {
      // A body must be returned; park a tiny one at the origin rather than feeding NaN to Rapier.
      log.warn('addDynamicBox: non-finite center/half extents, creating a minimal body at the origin');
      center = ZERO;
      halfExtents = { x: INERT_RADIUS, y: INERT_RADIUS, z: INERT_RADIUS };
    }
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(center.x, center.y, center.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(PHYSICS.propLinearDamping)
      .setAngularDamping(PHYSICS.propAngularDamping);
    const body = this.world.createRigidBody(bodyDesc);
    const groups = groupsForKind(data.kind);
    const colDesc = RAPIER.ColliderDesc.cuboid(
      Math.abs(halfExtents.x),
      Math.abs(halfExtents.y),
      Math.abs(halfExtents.z),
    )
      .setDensity(opts?.density ?? PHYSICS.propDensity)
      .setFriction(PHYSICS.propFriction)
      .setRestitution(PHYSICS.propRestitution)
      .setCollisionGroups(groups)
      .setSolverGroups(groups);
    this.registerNewCollider(colDesc, body, data);

    const entry: DynamicEntry = {
      body,
      object,
      prevPos: new Vector3(center.x, center.y, center.z),
      currPos: new Vector3(center.x, center.y, center.z),
      prevRot: new Quaternion(rot.x, rot.y, rot.z, rot.w),
      currRot: new Quaternion(rot.x, rot.y, rot.z, rot.w),
      spawnPos: new Vector3(center.x, center.y, center.z),
      spawnRot: new Quaternion(rot.x, rot.y, rot.z, rot.w),
      restSynced: false,
    };
    this.dynamics.push(entry);
    this.dynamicByHandle.set(body.handle, entry);
    if (object) {
      object.position.copy(entry.currPos);
      object.quaternion.copy(entry.currRot);
    }
    this.refreshCounts();
    return body;
  }

  /**
   * Create a collider from a descriptor (optionally attached to a body) and register its
   * metadata. Used by the helpers above and by systems that build custom shapes (player capsule).
   */
  createCollider(
    desc: RAPIER.ColliderDesc,
    parent: RAPIER.RigidBody | null,
    data: ColliderData,
  ): RAPIER.Collider {
    return this.registerNewCollider(desc, parent, data);
  }

  /** Attach/replace metadata of a collider created elsewhere. */
  setColliderData(collider: RAPIER.Collider, data: ColliderData): void {
    this.colliderData.set(collider.handle, data);
  }

  getColliderData(collider: RAPIER.Collider): ColliderData | undefined {
    return this.colliderData.get(collider.handle);
  }

  removeBody(body: RAPIER.RigidBody): void {
    if (this._disposed || !this.world.bodies.contains(body.handle)) return;
    for (let i = 0; i < body.numColliders(); i++) this.colliderData.delete(body.collider(i).handle);
    const entry = this.dynamicByHandle.get(body.handle);
    if (entry) {
      this.dynamicByHandle.delete(body.handle);
      const idx = this.dynamics.indexOf(entry);
      if (idx >= 0) {
        // Swap-remove: order of dynamics is irrelevant.
        this.dynamics[idx] = this.dynamics[this.dynamics.length - 1]!;
        this.dynamics.pop();
      }
    }
    this.world.removeRigidBody(body);
    this.queriesDirty = true;
    this.refreshCounts();
  }

  removeCollider(collider: RAPIER.Collider): void {
    if (this._disposed || !this.world.colliders.contains(collider.handle)) return;
    this.colliderData.delete(collider.handle);
    this.world.removeCollider(collider, true);
    this.queriesDirty = true;
    this.refreshCounts();
  }

  /** Sensor with no collision groups: invisible to queries, contacts and the character controller. */
  private inertCollider(data: ColliderData): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.ball(INERT_RADIUS)
      .setSensor(true)
      .setCollisionGroups(0)
      .setSolverGroups(0);
    return this.registerNewCollider(desc, null, data);
  }

  private registerNewCollider(
    desc: RAPIER.ColliderDesc,
    parent: RAPIER.RigidBody | null,
    data: ColliderData,
  ): RAPIER.Collider {
    const collider = parent ? this.world.createCollider(desc, parent) : this.world.createCollider(desc);
    this.colliderData.set(collider.handle, data);
    this.queriesDirty = true;
    this.refreshCounts();
    return collider;
  }

  private refreshCounts(): void {
    if (this._disposed) return;
    this.stats.bodies = this.world.bodies.len();
    this.stats.colliders = this.world.colliders.len();
    this.stats.dynamicBodies = this.dynamics.length;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Closest hit along a ray (sensors are ignored). `direction` need not be normalised.
   *
   * IMPORTANT: the returned object (and its `point`/`normal` vectors) is shared and only
   * valid until the next `raycast()` call – copy what you need to keep. This keeps hot
   * paths (weapons, AI, camera focus) allocation-free on our side.
   */
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: RaycastOptions,
  ): RaycastHit | null {
    if (this._disposed) return null;
    const len = Math.hypot(direction.x, direction.y, direction.z);
    // NaN input would otherwise produce a bogus hit at distance 0.
    if (!(len > 1e-9) || !(maxDistance > 0) || !finiteVec(origin) || !Number.isFinite(len)) return null;
    this.ensureQueries();
    const inv = 1 / len;
    const ray = this.ray;
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = direction.x * inv;
    ray.dir.y = direction.y * inv;
    ray.dir.z = direction.z * inv;
    const res = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      opts?.solid ?? true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      opts?.groups,
      opts?.excludeCollider,
      opts?.excludeRigidBody,
    );
    if (!res) return null;
    const hit = this.hit;
    const t = res.timeOfImpact;
    hit.point.set(ray.origin.x + ray.dir.x * t, ray.origin.y + ray.dir.y * t, ray.origin.z + ray.dir.z * t);
    hit.normal.set(res.normal.x, res.normal.y, res.normal.z);
    hit.distance = t;
    hit.collider = res.collider;
    hit.data = this.colliderData.get(res.collider.handle);
    return hit;
  }

  /**
   * First collider (non-sensor) intersecting `shape` at the given pose, or null.
   * Used for crouch headroom and mantle clearance tests.
   */
  intersectShape(
    shape: RAPIER.Shape,
    position: Vec3Like,
    rotation: RAPIER.Rotation | null,
    groups?: number,
    excludeCollider?: RAPIER.Collider,
    excludeRigidBody?: RAPIER.RigidBody,
  ): RAPIER.Collider | null {
    if (this._disposed) return null;
    this.ensureQueries();
    return this.world.intersectionWithShape(
      position,
      rotation ?? IDENTITY_ROTATION,
      shape,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      excludeCollider,
      excludeRigidBody,
    );
  }

  /**
   * Sweep `shape` from `position` along the unit `direction`; returns the travelled distance
   * until the first (non-sensor) hit, or -1 if nothing is hit within `maxDistance`.
   */
  castShape(
    shape: RAPIER.Shape,
    position: Vec3Like,
    rotation: RAPIER.Rotation | null,
    direction: Vec3Like,
    maxDistance: number,
    groups?: number,
    excludeCollider?: RAPIER.Collider,
    excludeRigidBody?: RAPIER.RigidBody,
  ): number {
    if (this._disposed) return -1;
    this.ensureQueries();
    this.castVel.x = direction.x;
    this.castVel.y = direction.y;
    this.castVel.z = direction.z;
    const res = this.world.castShape(
      position,
      rotation ?? IDENTITY_ROTATION,
      this.castVel,
      shape,
      0,
      maxDistance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups,
      excludeCollider,
      excludeRigidBody,
    );
    return res ? res.time_of_impact : -1;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.colliderData.clear();
    this.dynamics.length = 0;
    this.dynamicByHandle.clear();
    this.world.free();
  }
}
