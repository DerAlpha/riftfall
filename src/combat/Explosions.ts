/**
 * Area damage (ExplosionApi, M5): projectile detonations, grenades, field collapses, forge specials.
 *
 * - Damageables inside `def.radius`: damage falls off linearly from the center to
 *   `minFalloffMultiplier` at the radius, measured to the nearest HITBOX surface (a tank's long
 *   bounds sphere does not shield it, a limb in the blast counts); line of sight from the blast to
 *   that surface point or the aim point (static world only – bodies do not shield each other).
 *   The source's own team is spared ('player' blasts never hit team 'player').
 * - The player (optional `player` hook): player blasts hurt the shooter by `selfDamageScale`,
 *   everything else fully; damage kind 'explosion' (PlayerHealth's explosion stat).
 * - Dynamic props within the radius are pushed (Rapier shape query, linear fade, LOS).
 * - Emits combat:explosion (VFX / audio bridges draw and sound it: `vfx`/`audio` from the def) and
 *   camera:shake faded over ARSENAL.explosions.shakeReach radii from the player's eye.
 * - Weapon specials see every damaged target (`specials` hook, via 'blast'; the first is primary).
 *
 * Nested calls (a blast kill setting off another blast) use their own scratch lists up to
 * ARSENAL.explosions.maxDepth. Payloads are reused (EventBus contract).
 */
import { Vector3 } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type {
  AreaDamageSource,
  CombatWorldApi,
  DamageInfo,
  Damageable,
  ExplosionApi,
  PhysicsApi,
  PlayerDamageKind,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { ARSENAL, COMBAT } from '../defs/combat';
import { MOVEMENT } from '../defs/movement';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import type { ExplosionDef } from '../defs/weapons';
import { blastFalloff, distanceToBody, distanceToHitboxes, linearFade } from '../weapons/fire/fireMath';
import { createSpecialHit, type SpecialsHook } from '../weapons/fire/types';

const log = createLogger('explosions');

/** What explosions need of the player (EnemyTargetApi satisfies it). */
export interface ExplosionPlayer {
  readonly position: Vec3Like;
  readonly eyePosition: Vec3Like;
  readonly alive: boolean;
  damage(amount: number, direction?: Vec3Like, kind?: PlayerDamageKind): number;
}

/** Prop pushes: the Rapier world (PhysicsWorld; `ensureQueries` makes new colliders visible). */
export type ExplosionPhysics = Pick<PhysicsApi, 'world' | 'rapier'> & { ensureQueries?(): void };

export interface ExplosionsDeps {
  events: EventBus<GameEvents>;
  combat: Pick<CombatWorldApi, 'queryRadius' | 'dealDamage' | 'lineOfSight'>;
  physics?: ExplosionPhysics | null;
  player?: ExplosionPlayer | null;
  specials?: SpecialsHook | null;
  /** Player body radius (default MOVEMENT.collider.radius). */
  playerRadius?: number;
}

/** Query shapes only look at props. */
const PROP_QUERY_GROUPS = interactionGroups(COLLISION_GROUP.PROJECTILE, COLLISION_GROUP.PROP);
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

const _dir = new Vector3();
const _chest = new Vector3();
const _impulse = { x: 0, y: 0, z: 0 };
const _toBlast = { x: 0, y: 0, z: 0 };

export class Explosions implements ExplosionApi {
  readonly stats = { explosions: 0, hits: 0, props: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly combat: ExplosionsDeps['combat'];
  private readonly physics: ExplosionPhysics | null;
  private player: ExplosionPlayer | null;
  private specials: SpecialsHook | null;
  private readonly playerRadius: number;

  /** One candidate list, center and closest point per nesting depth (re-entrant explode()). */
  private readonly lists: Damageable[][] = [];
  private readonly centers: Vector3[] = [];
  private readonly closests: Vector3[] = [];
  private depth = 0;
  private readonly balls = new Map<number, RAPIER.Ball>();
  private readonly info: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
    weaponId: '',
    element: 'physical',
    source: 'player',
    kind: 'explosion',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly hit = createSpecialHit();
  private readonly payload: GameEvents['combat:explosion'] = {
    position: { x: 0, y: 0, z: 0 },
    radius: 0,
    element: 'physical',
  };
  private readonly shakePayload: GameEvents['camera:shake'] = { trauma: 0 };
  // Prop query state (the Rapier callback is a bound method: no closure per blast).
  private propRadius = 0;
  private propImpulse = 0;
  private readonly propCenter = new Vector3();
  /** Bodies found by the query: Rapier forbids changing bodies inside its query callback. */
  private readonly propBodies: RAPIER.RigidBody[] = [];
  private readonly visitProp = (collider: RAPIER.Collider): boolean => {
    const body = collider.parent();
    if (body && body.isDynamic() && !this.propBodies.includes(body)) this.propBodies.push(body);
    return true;
  };

  constructor(deps: ExplosionsDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.physics = deps.physics ?? null;
    this.player = deps.player ?? null;
    this.specials = deps.specials ?? null;
    this.playerRadius = deps.playerRadius ?? MOVEMENT.collider.radius;
    for (let i = 0; i <= ARSENAL.explosions.maxDepth; i++) {
      this.lists.push([]);
      this.centers.push(new Vector3());
      this.closests.push(new Vector3());
    }
  }

  setPlayer(player: ExplosionPlayer | null): void {
    this.player = player;
  }

  setSpecials(specials: SpecialsHook | null): void {
    this.specials = specials;
  }

  explode(position: Vec3Like, def: ExplosionDef, from: AreaDamageSource): number {
    const r = def.radius;
    if (!finite(position) || !(r > 0)) return 0;
    if (this.depth >= ARSENAL.explosions.maxDepth) {
      log.warn('Explosion nesting limit reached – blast skipped');
      return 0;
    }
    const list = this.lists[this.depth]!;
    const center = this.centers[this.depth]!.set(position.x, position.y, position.z);
    const closest = this.closests[this.depth]!;
    this.depth++;
    this.stats.explosions++;
    const scale = from.areaScale !== undefined && from.areaScale >= 0 ? from.areaScale : 1;
    const damage = def.damage * scale;
    const spareTeam = from.source === 'player' ? 'player' : from.source === 'enemy' ? 'enemy' : null;
    let hits = 0;

    if (damage > 0) {
      this.combat.queryRadius(center, r, list);
      const n = Math.min(list.length, ARSENAL.explosions.maxTargets);
      let primary = true;
      for (let i = 0; i < n; i++) {
        const t = list[i]!;
        if (!t.alive || t.team === spareTeam) continue;
        let d: number;
        if (t.hitboxes.length > 0) d = distanceToHitboxes(center, t.hitboxes, closest);
        else {
          d = Math.max(0, t.boundsCenter.distanceTo(center) - t.boundsRadius);
          closest.copy(t.boundsCenter);
        }
        if (d > r) continue;
        if (!this.combat.lineOfSight(center, closest) && !this.combat.lineOfSight(center, t.aimPoint))
          continue;
        const f = blastFalloff(d, r, def.minFalloffMultiplier);
        if (!(f > 0)) continue;
        const info = this.info;
        info.amount = damage * f;
        info.zone = 'body';
        copyVec(closest, info.point);
        _dir.subVectors(closest, center);
        const len = _dir.length();
        if (len > 1e-6) _dir.multiplyScalar(1 / len);
        else _dir.set(0, 1, 0);
        copyVec(_dir, info.direction);
        info.weaponId = from.weaponId;
        info.element = def.element;
        info.source = from.source;
        info.kind = 'explosion';
        info.impulse = def.impulse * f;
        info.statusBuildup = from.statusBuildup;
        // Read the (ring-buffered) result at once.
        const res = this.combat.dealDamage(t, info);
        const applied = res.applied;
        const killed = res.killed;
        hits++;
        this.stats.hits++;
        const special = from.special ?? null;
        if (special && this.specials) {
          const h = this.hit;
          h.special = special;
          h.via = 'blast';
          h.weaponId = from.weaponId;
          h.source = from.source;
          h.target = t;
          copyVec(closest, h.point);
          h.applied = applied;
          h.killed = killed;
          h.primary = primary;
          this.specials.onHit(h);
        }
        primary = false;
      }
      list.length = 0;
      this.damagePlayer(center, def, from, damage);
    }

    if (def.propImpulse > 0) this.pushProps(center, r, def.propImpulse);

    const e = this.payload;
    copyVec(center, e.position);
    e.radius = r;
    e.element = def.element;
    e.vfx = def.vfx;
    e.audio = def.audio;
    this.events.emit('combat:explosion', e);
    this.shake(center, def);
    this.depth--;
    return hits;
  }

  dispose(): void {
    this.balls.clear();
    for (const l of this.lists) l.length = 0;
    this.player = null;
    this.specials = null;
  }

  // -------------------------------------------------------------------------

  private damagePlayer(center: Vector3, def: ExplosionDef, from: AreaDamageSource, damage: number): void {
    const p = this.player;
    if (!p || !p.alive) return;
    const selfScale = from.source === 'player' ? def.selfDamageScale : 1;
    if (!(selfScale > 0)) return;
    const d = distanceToBody(center, p.position, p.eyePosition, this.playerRadius);
    if (d > def.radius) return;
    // Head or chest must be visible from the blast.
    _chest.set(p.position.x, (p.position.y + p.eyePosition.y) * 0.5, p.position.z);
    if (!this.combat.lineOfSight(center, p.eyePosition) && !this.combat.lineOfSight(center, _chest)) return;
    const f = blastFalloff(d, def.radius, def.minFalloffMultiplier);
    if (!(f > 0)) return;
    // player:damaged convention: from the player TOWARDS the source.
    const dx = center.x - p.eyePosition.x;
    const dy = center.y - p.eyePosition.y;
    const dz = center.z - p.eyePosition.z;
    const len = Math.hypot(dx, dy, dz);
    _toBlast.x = len > 1e-6 ? dx / len : 0;
    _toBlast.y = len > 1e-6 ? dy / len : -1;
    _toBlast.z = len > 1e-6 ? dz / len : 0;
    p.damage(damage * f * selfScale, _toBlast, 'explosion');
  }

  private shake(center: Vector3, def: ExplosionDef): void {
    const p = this.player;
    if (!p || !(def.shake > 0)) return;
    const eye = p.eyePosition;
    const d = Math.hypot(eye.x - center.x, eye.y - center.y, eye.z - center.z);
    const trauma = def.shake * linearFade(d, def.radius * ARSENAL.explosions.shakeReach);
    if (!(trauma > 0)) return;
    this.shakePayload.trauma = trauma;
    this.events.emit('camera:shake', this.shakePayload);
  }

  private pushProps(center: Vector3, radius: number, impulse: number): void {
    const physics = this.physics;
    if (!physics) return;
    let ball = this.balls.get(radius);
    if (!ball) {
      ball = new physics.rapier.Ball(radius);
      this.balls.set(radius, ball);
    }
    this.propRadius = radius;
    this.propImpulse = impulse;
    this.propCenter.copy(center);
    const bodies = this.propBodies;
    bodies.length = 0;
    try {
      physics.ensureQueries?.();
      physics.world.intersectionsWithShape(
        center,
        IDENTITY,
        ball,
        this.visitProp,
        physics.rapier.QueryFilterFlags.ONLY_DYNAMIC,
        PROP_QUERY_GROUPS,
      );
      for (let i = 0; i < bodies.length; i++) this.pushProp(bodies[i]!);
    } catch (err) {
      log.warn('Prop push failed', err);
    }
    bodies.length = 0;
  }

  private pushProp(body: RAPIER.RigidBody): void {
    const t = body.translation();
    const c = this.propCenter;
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const dz = t.z - c.z;
    const d = Math.hypot(dx, dy, dz);
    const f = linearFade(d, this.propRadius);
    if (!(f > 0)) return;
    if (!this.combat.lineOfSight(c, t)) return;
    const k = (this.propImpulse * f) / Math.max(d, COMBAT.minRayLength);
    // Blasts lift what they push (reads better than a flat shove).
    _impulse.x = dx * k;
    _impulse.y = Math.max(dy * k, this.propImpulse * f * ARSENAL.explosions.propLift);
    _impulse.z = dz * k;
    body.applyImpulse(_impulse, true);
    this.stats.props++;
  }
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
