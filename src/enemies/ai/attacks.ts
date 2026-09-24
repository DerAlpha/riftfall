/**
 * Attack selection and execution, data-driven by EnemyAttackDef.kind (no per-type code):
 *
 *   melee       strike: reach + facing cone + height check at the strike moment (dodge by dashing)
 *   projectile  strike: lobbed projectile from a socket with lead prediction (ProjectileSystem)
 *   slam        strike: radial AoE with falloff around a socket, near-miss shake, ground VFX
 *   leap        strike: ballistic hop to a nav-snapped landing point in front of the (predicted)
 *               target; hits once when the body passes the target capsule
 *   charge      strike: straight dash (nav steering override, slight homing); ends on a hit, at max
 *               distance, on overshoot, or on a wall (the attacker staggers itself)
 *
 * Every contact hit (melee, slam, leap, charge) also needs a static line of sight from the
 * attacker's eye to the target's eye at that moment: no damage through walls or decks.
 *
 * Phases: wind-up (telegraph, target tracking) → strike → recover. Leap/charge move the enemy
 * themselves during the strike (MoveOverride); the host teleports the parked nav agent afterwards.
 *
 * M6 (ground package): `combo` chains a follow-up attack while the target stays in reach (the host
 * asks comboFollowUp when an attack ends), `scripted` attacks are never picked by brains,
 * `selfDestruct` ends the strike in the attacker's own death burst, and leaps with
 * `arcSegments` check their lane along the arc (over / onto low cover).
 */
import { getAttackExecutor } from './attackKinds';
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../core/contracts';
import { DEG2RAD } from '../../core/math';
import { ENEMY_AI, type EnemyAttackDef, type LeapParams } from '../../defs/enemies';
import { PHASE_RECOVER, PHASE_STRIKE, PHASE_WINDUP, type Enemy } from '../Enemy';
import { aoeFactor, distXZ, meleeHits, turnTowards, yawTo } from './attackMath';
import type { AiHost } from './types';

const _v = new Vector3();
const _w = new Vector3();
const _aim = new Vector3();
const _strike = new Vector3();
const UP = { x: 0, y: 1, z: 0 } as const;
const TAU = Math.PI * 2;

/** Optional per-brain filter for attack selection (module-level functions, no closures). */
export type AttackFilter = (e: Enemy, attack: EnemyAttackDef, index: number, host: AiHost) => boolean;

/** Is attack `index` usable now against `target` at horizontal distance `dist`? */
export function attackUsable(
  e: Enemy,
  host: AiHost,
  index: number,
  dist: number,
  target: EnemyTargetApi,
): boolean {
  const a = e.def.attacks[index];
  if (!a || !target.alive) return false;
  if (host.time < e.attackReady[index]!) return false;
  if (dist < a.minRange || dist > a.range) return false;
  // Close-range blows whiff on a target standing on the deck above / the floor below.
  const reachY = a.melee?.height ?? a.slam?.height;
  if (reachY !== undefined && Math.abs(target.position.y - e.position.y) > reachY) return false;
  if (a.usesSlot) {
    const coord = host.coordinator(e);
    if (!coord.holds(e.id) || !coord.canStartAttack(host.time)) return false;
  }
  if (a.requiresLos && !host.refreshLos(e, ENEMY_AI.perception.losMaxAge)) return false;
  // Last: it queues the enemy for the next spacing slot (only ready attackers may queue).
  return host.spacingAllows(e, a.kind);
}

/** Highest-priority usable attack (-1 = none). Cheap checks first; LOS only for candidates. */
export function pickAttack(
  e: Enemy,
  host: AiHost,
  dist: number,
  target: EnemyTargetApi,
  filter: AttackFilter | null = null,
): number {
  const attacks = e.def.attacks;
  let best = -1;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < attacks.length; i++) {
    const a = attacks[i]!;
    if (a.priority <= bestPriority || a.scripted === true) continue;
    if (filter && !filter(e, a, i, host)) continue;
    if (!attackUsable(e, host, i, dist, target)) continue;
    best = i;
    bestPriority = a.priority;
  }
  return best;
}

/**
 * M6 combo: index of the follow-up (EnemyAttackDef.combo) of the attack that just ended when the
 * target is still in its reach (range, height, fresh sight), else -1. Cooldowns and tokens do not
 * apply – the chain is one attack for the token pool (mark follow-ups `usesSlot: false`).
 */
export function comboFollowUp(e: Enemy, host: AiHost, target: EnemyTargetApi | null): number {
  const id = e.def.attacks[e.attackIndex]?.combo;
  if (!id || !target || !target.alive || !e.alive) return -1;
  const attacks = e.def.attacks;
  for (let i = 0; i < attacks.length; i++) {
    const a = attacks[i]!;
    if (a.id !== id) continue;
    const dist = distXZ(e.position, target.position);
    if (dist < a.minRange || dist > a.range) return -1;
    const reachY = a.melee?.height ?? a.slam?.height;
    if (reachY !== undefined && Math.abs(target.position.y - e.position.y) > reachY) return -1;
    if (a.requiresLos && !host.refreshLos(e, ENEMY_AI.perception.losMaxAge)) return -1;
    return i;
  }
  return -1;
}

/** Phase duration of the current attack. */
export function phaseDuration(a: EnemyAttackDef, phase: number): number {
  return phase === PHASE_WINDUP ? a.windup : phase === PHASE_STRIKE ? a.strike : a.recover;
}

/**
 * Advance the enemy's current attack by dt. Returns true when the attack is over (the host puts the
 * enemy back to 'active'). `target` may be dead: strikes then hit nothing.
 */
export function updateAttack(e: Enemy, host: AiHost, target: EnemyTargetApi | null, dt: number): boolean {
  const a = e.def.attacks[e.attackIndex];
  if (!a) return true;
  const first = e.phase === PHASE_WINDUP && e.phaseTime === 0;
  e.phaseTime += dt;
  if (e.phase === PHASE_WINDUP) {
    if (target && a.trackTurnRateDeg > 0) {
      const want = yawTo(target.position.x - e.position.x, target.position.z - e.position.z);
      e.yaw = turnTowards(e.yaw, want, a.trackTurnRateDeg * DEG2RAD * dt);
    }
    // M6 executors telegraph / channel during the wind-up and may abort it (no strike).
    if (getAttackExecutor(a.kind)?.windup?.(e, host, a, target, dt, first)) {
      e.phase = PHASE_RECOVER;
      e.phaseTime = 0;
      return false;
    }
    if (e.phaseTime < a.windup) return false;
    e.phase = PHASE_STRIKE;
    e.phaseTime = 0;
    const struck = beginStrike(e, host, a, target);
    // M6 exploder: the blow is its own death burst.
    if (a.selfDestruct === true) host.selfDestruct(e);
    if (!struck) {
      e.phase = PHASE_RECOVER;
      e.phaseTime = 0;
    }
    return false;
  }
  if (e.phase === PHASE_STRIKE) {
    const done = updateStrike(e, host, a, target, dt) || e.phaseTime >= a.strike;
    if (!done) return false;
    // A strike that ended in a self-stagger left the attack state already.
    if (e.state !== 'attack') return true;
    finishOverride(e, host);
    e.phase = PHASE_RECOVER;
    e.phaseTime = 0;
    return false;
  }
  return e.phaseTime >= a.recover;
}

/** Cancel the running attack (stagger, death): stop any movement override. */
export function cancelAttack(e: Enemy, host: AiHost): void {
  const a = e.def.attacks[e.attackIndex];
  if (a) getAttackExecutor(a.kind)?.cancel?.(e, host, a);
  finishOverride(e, host);
  e.attackIndex = -1;
  e.phase = PHASE_WINDUP;
  e.phaseTime = 0;
  e.pose.attackId = -1;
  e.pose.attack = 0;
}

function finishOverride(e: Enemy, host: AiHost): void {
  if (e.override === 'leap' || e.override === 'charge') host.endOverride(e);
}

/** Strike start. False: the strike is void (no landing spot, blocked lane) → straight to recovery. */
function beginStrike(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null): boolean {
  switch (a.kind) {
    case 'melee': {
      const m = a.melee;
      if (target && target.alive && m) {
        const hit = meleeHits(
          e.position,
          e.yaw,
          target.position,
          ENEMY_AI.player.radius,
          m.reach * e.pose.scale,
          m.coneDeg * DEG2RAD,
          m.height,
        );
        if (hit && strikeReaches(e, host, target)) host.hitTarget(e, a, target, a.damage, a.shake);
      }
      return true;
    }
    case 'projectile': {
      const p = a.projectile;
      const proj = host.projectiles;
      if (!p || !proj || !target || !target.alive) return true;
      if (!host.socket(e, p.socket, _v)) {
        _v.copy(e.position);
        _v.y += e.def.perception.eyeHeight * e.pose.scale;
      } else {
        // The socket sticks out past the body and may poke through a thin wall the attacker
        // stands at: then the glob leaves from the body axis (and splats on that wall).
        _w.set(e.position.x, _v.y, e.position.z);
        if (!host.combat.lineOfSight(_w, _v)) _v.copy(_w);
      }
      _aim.copy(target.eyePosition);
      _aim.y -= p.aimDrop;
      if (p.aimError > 0) {
        // Uniform in the disk: a steady target still sees near misses (splash) now and then.
        const ang = host.rng.next() * TAU;
        const r = p.aimError * Math.sqrt(host.rng.next());
        _aim.x += Math.cos(ang) * r;
        _aim.z += Math.sin(ang) * r;
      }
      proj.lob(p.projectile, _v, _aim, target.velocity, p.leadFactor, {
        owner: e,
        source: 'enemy',
        damageScale: e.damageMult,
      });
      return true;
    }
    case 'slam': {
      const s = a.slam;
      if (!s) return true;
      if (!host.socket(e, s.socket, _v)) {
        _v.set(
          e.position.x + Math.sin(e.yaw) * s.forward,
          e.position.y,
          e.position.z + Math.cos(e.yaw) * s.forward,
        );
      }
      // The shockwave runs along the floor the attacker stands on.
      _v.y = e.position.y;
      host.vfx?.spawn(s.effect, _v, UP, s.effectScale * e.pose.scale);
      if (!target || !target.alive) return true;
      const radius = s.radius * e.pose.scale;
      const dist = Math.max(0, distXZ(_v, target.position) - ENEMY_AI.player.radius);
      const dy = target.position.y - _v.y;
      const f = dy <= s.height && dy >= -s.height ? aoeFactor(dist, s.innerRadius, radius, s.minFactor) : 0;
      if (f > 0 && strikeReaches(e, host, target)) {
        host.hitTarget(e, a, target, a.damage * f, a.shake * f);
      } else {
        const near = 1 - distXZ(_v, target.position) / s.shakeRadius;
        if (near > 0) host.shake(s.nearShake * near);
      }
      return true;
    }
    case 'leap':
      return beginLeap(e, host, a, target);
    case 'charge':
      return beginCharge(e, host, a, target);
    default:
      return getAttackExecutor(a.kind)?.begin(e, host, a, target) ?? false;
  }
}

function updateStrike(
  e: Enemy,
  host: AiHost,
  a: EnemyAttackDef,
  target: EnemyTargetApi | null,
  dt: number,
): boolean {
  if (a.kind === 'leap' && e.override === 'leap') return updateLeap(e, host, a, target);
  if (a.kind === 'charge' && e.override === 'charge') return updateCharge(e, host, a, target, dt);
  const x = getAttackExecutor(a.kind);
  return x?.update ? x.update(e, host, a, target, dt) : false;
}

// ---------------------------------------------------------------------------
// Leap
// ---------------------------------------------------------------------------

function beginLeap(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null): boolean {
  const L = a.leap;
  if (!L || !target || !target.alive || !(a.strike > 0)) return false;
  const nav = host.nav;
  // Predicted target position at landing, stopping short in front of it.
  _v.set(
    target.position.x + target.velocity.x * a.strike * L.leadFactor,
    target.position.y,
    target.position.z + target.velocity.z * a.strike * L.leadFactor,
  );
  _w.subVectors(_v, e.position).setY(0);
  const d = _w.length();
  if (d < 1e-3) return false;
  const travel = Math.min(L.maxDistance, Math.max(0, d - L.stopShort));
  _w.multiplyScalar(travel / d).add(e.position);
  _w.y = target.position.y;
  if (!nav.closestPoint(_w, _aim)) return false;
  const clear =
    (L.arcSegments ?? 0) > 0
      ? arcClear(host, e.position, _aim, L, e.pose.scale)
      : laneClear(host, e.position, _aim, L.bodyHeight * e.pose.scale);
  if (!clear) return false;
  e.overrideFrom.copy(e.position);
  e.overrideTo.copy(_aim);
  e.overrideDir.subVectors(_aim, e.position).setY(0);
  const len = e.overrideDir.length();
  if (len > 1e-6) e.overrideDir.multiplyScalar(1 / len);
  e.yaw = yawTo(e.overrideDir.x, e.overrideDir.z);
  e.override = 'leap';
  e.overrideTime = 0;
  e.attackHit = false;
  host.stopMoving(e);
  return true;
}

function updateLeap(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null): boolean {
  const L = a.leap!;
  const s = Math.min(1, e.phaseTime / a.strike);
  e.position.lerpVectors(e.overrideFrom, e.overrideTo, s);
  e.position.y += L.arcHeight * 4 * s * (1 - s);
  if (!e.attackHit && target && target.alive) {
    _v.set(e.position.x, e.position.y + L.bodyHeight * e.pose.scale, e.position.z);
    const d = capsuleDistance(_v, target);
    if (d <= L.hitRadius * e.pose.scale && strikeReaches(e, host, target)) {
      e.attackHit = true;
      host.hitTarget(e, a, target, a.damage, a.shake);
    }
  }
  if (s >= 1) {
    e.position.copy(e.overrideTo);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Charge
// ---------------------------------------------------------------------------

function beginCharge(e: Enemy, host: AiHost, a: EnemyAttackDef, target: EnemyTargetApi | null): boolean {
  const C = a.charge;
  if (!C || !target || !target.alive) return false;
  // Lock the lane towards the (slightly predicted) target.
  const lead = C.leadFactor * (distXZ(e.position, target.position) / Math.max(1e-3, C.speed));
  _v.set(
    target.position.x + target.velocity.x * lead - e.position.x,
    0,
    target.position.z + target.velocity.z * lead - e.position.z,
  );
  const len = _v.length();
  if (len < 1e-3) return false;
  _v.multiplyScalar(1 / len);
  // The first meters must be free, else the charge fizzles (cancel).
  _w.copy(e.position).addScaledVector(_v, C.startClearance);
  if (!laneClear(host, e.position, _w, C.probeHeight * e.pose.scale)) return false;
  e.overrideDir.copy(_v);
  e.yaw = yawTo(_v.x, _v.z);
  e.override = 'charge';
  e.overrideTime = 0;
  e.overrideDist = 0;
  e.attackHit = false;
  host.stopMoving(e);
  return true;
}

function updateCharge(
  e: Enemy,
  host: AiHost,
  a: EnemyAttackDef,
  target: EnemyTargetApi | null,
  dt: number,
): boolean {
  const C = a.charge!;
  const dir = e.overrideDir;
  if (target && target.alive) {
    // Slight homing.
    const want = yawTo(target.position.x - e.position.x, target.position.z - e.position.z);
    e.yaw = turnTowards(e.yaw, want, C.turnRateDeg * DEG2RAD * dt);
    dir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
  }
  const step = C.speed * e.speedMult * dt;
  // Wall ahead (look beyond the step by the body's extra radius)?
  _v.copy(e.position).addScaledVector(dir, step + C.wallProbe);
  if (!laneClear(host, e.position, _v, C.probeHeight * e.pose.scale)) {
    _w.copy(e.position).addScaledVector(dir, C.wallProbe);
    host.vfx?.spawn(C.wallEffect, _w, UP, C.wallEffectScale * e.pose.scale);
    if (target && target.alive) {
      const near = 1 - distXZ(e.position, target.position) / (C.shakeRadius * 2);
      if (near > 0) host.shake(C.wallShake * Math.min(1, near * 2));
    }
    host.staggerSelf(e, C.wallStagger);
    return true;
  }
  _v.copy(e.position).addScaledVector(dir, step);
  if (host.nav.closestPoint(_v, _w)) _v.y = _w.y;
  e.position.copy(_v);
  e.overrideDist += step;
  if (target && target.alive) {
    if (!e.attackHit) {
      const d = distXZ(e.position, target.position) - ENEMY_AI.player.radius;
      const dy = Math.abs(target.position.y - e.position.y);
      if (d <= C.hitRadius * e.pose.scale && dy <= e.def.nav.height && strikeReaches(e, host, target)) {
        e.attackHit = true;
        host.hitTarget(e, a, target, a.damage, a.shake);
        return true;
      }
    }
    // Overshoot: the target is behind and far enough – brake.
    const tx = target.position.x - e.position.x;
    const tz = target.position.z - e.position.z;
    if (tx * dir.x + tz * dir.z < 0 && Math.hypot(tx, tz) > C.overshoot) return true;
  }
  return e.overrideDist >= C.maxDistance;
}

const _la = new Vector3();
const _lb = new Vector3();

/**
 * A contact blow (melee, slam, leap, charge) lands only with a static line of sight from the
 * attacker's eye height to the target's eye: reach tests are horizontal, walls and floors are not
 * (no damage through a thin wall or a deck). Checked at the hit moment only (one ray).
 */
function strikeReaches(e: Enemy, host: AiHost, target: EnemyTargetApi): boolean {
  _strike.set(e.position.x, e.position.y + e.def.perception.eyeHeight * e.pose.scale, e.position.z);
  return host.combat.lineOfSight(_strike, target.eyePosition);
}

/**
 * Straight lane from → to: walkable on the navmesh AND no static wall at `height` above the feet.
 * The ray keeps charges and leaps honest while the navmesh is not ready (the fallback steering
 * reports every line walkable).
 */
function laneClear(host: AiHost, from: Vector3, to: Vector3, height: number): boolean {
  if (!host.nav.walkable(from, to)) return false;
  _la.set(from.x, from.y + height, from.z);
  _lb.set(to.x, to.y + height, to.z);
  return host.combat.lineOfSight(_la, _lb);
}

/**
 * M6 arc lane (LeapParams.arcSegments): static rays along the leap arc at body height – the
 * pounce may clear low cover or land on it (no nav walkability needed between the ends).
 */
function arcClear(host: AiHost, from: Vector3, to: Vector3, L: LeapParams, scale: number): boolean {
  const n = Math.max(1, Math.floor(L.arcSegments ?? 1));
  const h = L.bodyHeight * scale;
  _la.set(from.x, from.y + h, from.z);
  for (let i = 1; i <= n; i++) {
    const s = i / n;
    _lb.set(
      from.x + (to.x - from.x) * s,
      from.y + (to.y - from.y) * s + L.arcHeight * 4 * s * (1 - s) + h,
      from.z + (to.z - from.z) * s,
    );
    if (!host.combat.lineOfSight(_la, _lb)) return false;
    _la.copy(_lb);
  }
  return true;
}

/** Distance from a point to the target's capsule surface. */
function capsuleDistance(p: Vector3, target: EnemyTargetApi): number {
  const r = ENEMY_AI.player.radius;
  const ay = target.position.y + r;
  const by = Math.max(ay, target.eyePosition.y);
  const y = p.y < ay ? ay : p.y > by ? by : p.y;
  return Math.hypot(p.x - target.position.x, p.y - y, p.z - target.position.z) - r;
}
