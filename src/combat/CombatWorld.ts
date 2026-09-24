/**
 * Hit resolution for shots, blasts and melee (CombatWorldApi).
 *
 * One raycast tests three sets and returns the nearest hit:
 * - static level meshes via three-mesh-bvh (`level:<materialId>[:noshadow]`, `panel:<id>`; first
 *   hit only), so hits land exactly on the rendered surface; material id → surface/penetrable,
 * - registered damageables: bounds-sphere broadphase, then analytic ray vs sphere/capsule
 *   hitboxes (hitMath.ts),
 * - dynamic props through Rapier (the collider is authoritative, the mesh is interpolated);
 *   they stop bullets and can be pushed (pushProp).
 *
 * The returned CombatHit is reused (copy what you keep). Event payloads are reused too – the
 * EventBus contract says handlers copy.
 */
import { Box3, Matrix3, Mesh, Raycaster, Vector3, type Intersection, type Object3D } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type {
  CombatHit,
  DamageInfo,
  DamageResult,
  Damageable,
  Hitbox,
  PhysicsApi,
  RaycastOptions,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, SurfaceType, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { COMBAT } from '../defs/combat';
import { getMaterialDef } from '../defs/materials';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { ensureBvhPatched } from '../world/LevelKit';
import { capsuleNormal, rayCapsule, raySphere, sphereNormal, spheresOverlap } from './hitMath';
import type { CombatRaycastOptions, WeaponCombatApi } from './types';

const log = createLogger('combat');

/** Bullets are PROJECTILE members that only look for props in Rapier (static world uses the BVH). */
const PROP_RAY_GROUPS = interactionGroups(COLLISION_GROUP.PROJECTILE, COLLISION_GROUP.PROP);

interface StaticEntry {
  mesh: Mesh;
  /** World-space bounds: rays that miss them skip the mesh (static geometry never moves). */
  box: Box3;
  surface: SurfaceType;
  penetrable: boolean;
}

export interface CombatWorldDeps {
  events: EventBus<GameEvents>;
  /** Dynamic props (optional: without physics only the BVH world and damageables are hit). */
  physics?: PhysicsApi | null;
}

const _o = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _normalMatrix = new Matrix3();
const _boxHit = new Vector3();
const _impulse = { x: 0, y: 0, z: 0 };
const NO_DAMAGE: DamageResult = Object.freeze({ applied: 0, killed: false });
const NONE: readonly Damageable[] = [];

export class CombatWorld implements WeaponCombatApi {
  readonly stats = { raycasts: 0, staticMeshes: 0, targets: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly physics: PhysicsApi | null;
  private readonly statics: StaticEntry[] = [];
  private readonly _targets: Damageable[] = [];
  private readonly raycaster = new Raycaster();
  private readonly intersections: Intersection[] = [];
  private readonly propOpts: RaycastOptions = { groups: PROP_RAY_GROUPS, solid: true };
  private readonly hit: CombatHit = {
    point: new Vector3(),
    normal: new Vector3(),
    distance: 0,
    target: null,
    zone: null,
    surface: 'default',
    penetrable: false,
  };
  /** Dynamic body behind the latest returned hit (pushProp), and its collider (skipLastProp). */
  private hitBody: RAPIER.RigidBody | null = null;
  private lastPropCollider: RAPIER.Collider | null = null;
  // Static-mesh hit scratch.
  private readonly staticPoint = new Vector3();
  private readonly staticNormal = new Vector3();
  private staticEntry: StaticEntry | null = null;

  private readonly damagePayload: GameEvents['combat:damage'] = {
    targetId: 0,
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    killed: false,
    weaponId: '',
    element: 'physical',
    source: 'player',
  };
  private readonly killPayload: GameEvents['combat:kill'] = {
    targetId: 0,
    zone: 'body',
    weaponId: '',
    position: { x: 0, y: 0, z: 0 },
    source: 'player',
  };

  constructor(deps: CombatWorldDeps) {
    ensureBvhPatched();
    this.events = deps.events;
    this.physics = deps.physics ?? null;
    this.raycaster.firstHitOnly = true;
  }

  get targets(): readonly Damageable[] {
    return this._targets;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(target: Damageable): void {
    if (this._targets.includes(target)) return;
    this._targets.push(target);
    this.stats.targets = this._targets.length;
  }

  unregister(target: Damageable): void {
    const i = this._targets.indexOf(target);
    if (i < 0) return;
    // Swap-remove: order is irrelevant for hit resolution.
    this._targets[i] = this._targets[this._targets.length - 1]!;
    this._targets.pop();
    this.stats.targets = this._targets.length;
  }

  /**
   * Replace the static geometry with the bullet-stopping meshes under `root` (see
   * COMBAT.staticMeshPrefixes); null clears it. Call after the level was built and added.
   */
  setLevel(root: Object3D | null): void {
    this.statics.length = 0;
    if (root) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const materialId = staticMaterialId(o.name);
        if (materialId !== null) this.addStaticMesh(o, materialId);
      });
    }
    this.stats.staticMeshes = this.statics.length;
    log.info(`Combat world: ${this.statics.length} static meshes`);
  }

  /** Add one static bullet-stopping mesh (world transform must be current). */
  addStaticMesh(mesh: Mesh, materialId: string): void {
    const def = getMaterialDef(materialId);
    if (!def) log.warn(`Static mesh "${mesh.name}": unknown material "${materialId}" – default surface`);
    mesh.updateWorldMatrix(true, false);
    const box = new Box3().setFromObject(mesh);
    this.statics.push({
      mesh,
      box,
      surface: def?.surface ?? 'default',
      penetrable: def?.penetrable === true,
    });
    this.stats.staticMeshes = this.statics.length;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: CombatRaycastOptions,
  ): CombatHit | null {
    const skipProp = opts?.skipLastProp === true ? this.lastPropCollider : null;
    this.hitBody = null;
    this.lastPropCollider = null;
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (!(len > COMBAT.minRayLength) || !(maxDistance > 0) || !finite(origin)) return null;
    this.stats.raycasts++;
    const o = _o.set(origin.x, origin.y, origin.z);
    const d = _d.set(direction.x / len, direction.y / len, direction.z / len);
    let best = maxDistance;
    let kind: 'none' | 'static' | 'target' | 'prop' = 'none';

    // --- static world (BVH) ---
    const ts = this.raycastStatic(o, d, best);
    if (ts >= 0) {
      best = ts;
      kind = 'static';
    }

    // --- damageables ---
    const ignore = opts?.ignore ?? null;
    const ignoreMany = opts?.ignoreMany ?? NONE;
    let bestTarget: Damageable | null = null;
    let bestBox: Hitbox | null = null;
    for (let i = 0; i < this._targets.length; i++) {
      const t = this._targets[i]!;
      if (!t.alive || t === ignore || ignoreMany.includes(t)) continue;
      const tb = raySphere(o, d, t.boundsCenter, t.boundsRadius);
      if (tb < 0 || tb >= best) continue;
      const boxes = t.hitboxes;
      for (let j = 0; j < boxes.length; j++) {
        const hb = boxes[j]!;
        const th =
          hb.shape === 'sphere' ? raySphere(o, d, hb.a, hb.radius) : rayCapsule(o, d, hb.a, hb.b, hb.radius);
        if (th < 0 || th >= best) continue;
        best = th;
        bestTarget = t;
        bestBox = hb;
        kind = 'target';
      }
    }

    // --- dynamic props (Rapier) ---
    let propCollider: RAPIER.Collider | null = null;
    let propSurface: SurfaceType = 'default';
    let propPenetrable = false;
    if (this.physics && opts?.props !== false) {
      this.propOpts.excludeCollider = skipProp ?? undefined;
      const ph = this.physics.raycast(o, d, best, this.propOpts);
      if (ph && ph.distance < best) {
        best = ph.distance;
        kind = 'prop';
        propCollider = ph.collider;
        propSurface = ph.data?.surface ?? 'default';
        propPenetrable = ph.data?.penetrable === true;
        _p.copy(ph.point);
        _n.copy(ph.normal);
        // Rapier reports a zero normal for rays starting inside a collider: face the shooter.
        if (!(_n.lengthSq() > COMBAT.minNormalLengthSq)) _n.copy(d).negate();
      }
    }

    const hit = this.hit;
    hit.distance = best;
    hit.target = null;
    hit.zone = null;
    switch (kind) {
      case 'none':
        return null;
      case 'static': {
        const e = this.staticEntry!;
        hit.point.copy(this.staticPoint);
        hit.normal.copy(this.staticNormal);
        hit.surface = e.surface;
        hit.penetrable = e.penetrable;
        break;
      }
      case 'target': {
        const t = bestTarget!;
        const hb = bestBox!;
        hit.point.copy(o).addScaledVector(d, best);
        if (best <= 0) hit.normal.copy(d).negate();
        else if (hb.shape === 'sphere') sphereNormal(hit.point, hb.a, hit.normal);
        else capsuleNormal(hit.point, hb.a, hb.b, hit.normal);
        hit.target = t;
        hit.zone = hb.zone;
        hit.surface = t.surfaceAt?.(hb.zone) ?? t.surface;
        hit.penetrable = false;
        break;
      }
      case 'prop': {
        hit.point.copy(_p);
        hit.normal.copy(_n);
        hit.surface = propSurface;
        hit.penetrable = propPenetrable;
        this.lastPropCollider = propCollider;
        const body = propCollider!.parent();
        this.hitBody = body && body.isDynamic() ? body : null;
        break;
      }
    }
    return hit;
  }

  pushProp(hit: CombatHit, direction: Vec3Like, impulse: number): boolean {
    const body = this.hitBody;
    if (hit !== this.hit || !body || !(impulse > 0)) return false;
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (!(len > COMBAT.minRayLength)) return false;
    const k = impulse / len;
    _impulse.x = direction.x * k;
    _impulse.y = direction.y * k;
    _impulse.z = direction.z * k;
    body.applyImpulseAtPoint(_impulse, hit.point, true);
    return true;
  }

  hitsDynamicProp(hit: CombatHit): boolean {
    return hit === this.hit && this.hitBody !== null;
  }

  queryRadius(center: Vec3Like, radius: number, out: Damageable[]): Damageable[] {
    out.length = 0;
    if (!(radius >= 0) || !finite(center)) return out;
    for (let i = 0; i < this._targets.length; i++) {
      const t = this._targets[i]!;
      if (t.alive && spheresOverlap(center, radius, t.boundsCenter, t.boundsRadius)) out.push(t);
    }
    return out;
  }

  dealDamage(target: Damageable, info: DamageInfo): DamageResult {
    if (!target.alive || !(info.amount >= 0)) return NO_DAMAGE;
    const res = target.applyDamage(info);
    const p = this.damagePayload;
    p.targetId = target.id;
    p.amount = res.applied;
    p.zone = info.zone;
    copyVec(info.point, p.point);
    p.killed = res.killed;
    p.weaponId = info.weaponId;
    p.element = info.element;
    p.source = info.source;
    this.events.emit('combat:damage', p);
    if (res.killed) {
      const k = this.killPayload;
      k.targetId = target.id;
      k.zone = info.zone;
      k.weaponId = info.weaponId;
      copyVec(target.boundsCenter, k.position);
      k.source = info.source;
      this.events.emit('combat:kill', k);
    }
    return res;
  }

  lineOfSight(from: Vec3Like, to: Vec3Like): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(dist) || !finite(from)) return false;
    const reach = dist - COMBAT.lineOfSightEpsilon;
    if (reach <= 0) return true;
    _o.set(from.x, from.y, from.z);
    _d.set(dx / dist, dy / dist, dz / dist);
    this.stats.raycasts++;
    return this.raycastStatic(_o, _d, reach) < 0;
  }

  dispose(): void {
    this.statics.length = 0;
    this._targets.length = 0;
    this.intersections.length = 0;
    this.hitBody = null;
    this.lastPropCollider = null;
    this.stats.targets = 0;
    this.stats.staticMeshes = 0;
  }

  /** Nearest static-mesh hit within maxDistance → distance (fills staticPoint/Normal/Entry) or -1. */
  private raycastStatic(o: Vector3, d: Vector3, maxDistance: number): number {
    const rc = this.raycaster;
    rc.ray.origin.copy(o);
    rc.ray.direction.copy(d);
    rc.near = 0;
    rc.far = maxDistance;
    let best = -1;
    const hits = this.intersections;
    for (let i = 0; i < this.statics.length; i++) {
      const e = this.statics[i]!;
      // Cheap reject before the BVH (which inverts the world matrix per call).
      if (!rc.ray.intersectBox(e.box, _boxHit)) continue;
      // Ray.intersectBox returns the EXIT point when the origin is inside the box – merged level
      // meshes span the whole hall, so only distance-reject when the origin is outside.
      if (!e.box.containsPoint(o) && _boxHit.distanceTo(o) > (best >= 0 ? best : maxDistance)) continue;
      hits.length = 0;
      e.mesh.raycast(rc, hits);
      for (let j = 0; j < hits.length; j++) {
        const h = hits[j]!;
        if (h.distance > rc.far || (best >= 0 && h.distance >= best)) continue;
        best = h.distance;
        // Later meshes only need to beat this hit (the BVH prunes against far).
        rc.far = best;
        this.staticEntry = e;
        this.staticPoint.copy(h.point);
        if (h.face) {
          _normalMatrix.getNormalMatrix(e.mesh.matrixWorld);
          this.staticNormal.copy(h.face.normal).applyMatrix3(_normalMatrix).normalize();
          // Back faces (double-sided materials): the impact normal faces the shooter.
          if (this.staticNormal.dot(d) > 0) this.staticNormal.negate();
        } else {
          this.staticNormal.copy(d).negate();
        }
      }
    }
    hits.length = 0;
    return best;
  }
}

/** `level:<id>[:noshadow]` / `panel:<id>` → material id; null for meshes that do not stop bullets. */
export function staticMaterialId(name: string): string | null {
  for (const prefix of COMBAT.staticMeshPrefixes) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const colon = rest.indexOf(':');
    const id = colon < 0 ? rest : rest.slice(0, colon);
    return id.length > 0 ? id : null;
  }
  return null;
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
