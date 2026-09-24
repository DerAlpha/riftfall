/**
 * 'beam' attack executor (M6): a visible beam from a socket (EnemyAttackDef.beam), two flavours
 * chosen by data:
 *
 *   heal   the strike is a channel (up to `strike` s): a tether from the socket to the most injured
 *          ally in range heals it every tick. It ends when the ally is dead, healed up, out of range
 *          or out of sight (re-checked every losInterval), when the target comes close
 *          (breakDistance – the healer flees) or when the healer took interruptDamage since the
 *          wind-up started. The support brain asks healTargetReady() before it starts the attack.
 *   laser  the wind-up is the telegraph: an aim line from the socket tracks the target's chest at
 *          trackSpeed (holding still while the target is out of sight, aborting after lostAbort),
 *          locks lockTime s before the strike (restyled + glint) and the strike fires one instant
 *          ray at the locked point. The ray stops at the first wall / body / prop; the target is hit
 *          when the ray passes within hitRadius of its capsule (strafe after the lock or duck).
 *
 * Per-enemy state: one pooled BeamState per record (WeakMap – records are pooled, so nothing is
 * allocated per attack or tick). Beam visuals go through the host's EnemyBeams (AiHost.beams).
 */
import { Vector3 } from 'three';
import type { EnemyTargetApi } from '../../../core/contracts';
import type { Vec3Like } from '../../../core/events';
import { DEG2RAD } from '../../../core/math';
import {
  ENEMY_AI,
  type BeamHealParams,
  type BeamLaserParams,
  type BeamParams,
  type EnemyAttackDef,
} from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import { distXZ, segmentSegment, turnTowards, yawTo, type SegmentClosest } from '../attackMath';
import type { AiHost } from '../types';
import type { AttackExecutor } from './types';

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const TAU = Math.PI * 2;

class BeamState {
  /** Heal: the tethered (or chosen) ally and its id at the time (records are pooled). */
  ally: Enemy | null = null;
  allyId = 0;
  /** Heal: next candidate search / line-of-sight re-check / pulse (host time). */
  nextSearch = 0;
  nextLos = 0;
  nextPulse = 0;
  /** Health when the wind-up started (interrupt by damage). */
  startHealth = 0;
  /** Laser: the aim point, whether it is locked, when the target was last seen. */
  readonly aim = new Vector3();
  locked = false;
  lastSeen = 0;
}

const states = new WeakMap<Enemy, BeamState>();
const _from = new Vector3();
const _dir = new Vector3();
const _end = new Vector3();
const _chest = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();
const _seg: SegmentClosest = { distSq: 0, s: 0 };

function stateOf(e: Enemy): BeamState {
  let s = states.get(e);
  if (!s) {
    s = new BeamState();
    states.set(e, s);
  }
  return s;
}

/** The beam socket's world position (fallback: the eye on the body axis). */
function socketPoint(e: Enemy, host: AiHost, socket: string, out: Vector3): Vector3 {
  if (!host.socket(e, socket, out)) {
    out.set(e.position.x, e.position.y + e.def.perception.eyeHeight * e.pose.scale, e.position.z);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heal
// ---------------------------------------------------------------------------

/** The cached ally if it is still the same living, healable record in reach. */
function validAlly(e: Enemy, st: BeamState, H: BeamHealParams): Enemy | null {
  const o = st.ally;
  if (!o || o.id !== st.allyId || !o.alive || o === e) return null;
  if (o.state === 'emerge' || o.state === 'free') return null;
  if (o.def.boss === true && !H.bosses) return null;
  const dx = o.position.x - e.position.x;
  const dy = o.position.y - e.position.y;
  const dz = o.position.z - e.position.z;
  return dx * dx + dy * dy + dz * dz <= H.range * H.range ? o : null;
}

/**
 * Heal candidate search: the most injured allies (health fraction below `below`) in reach, best
 * first, the first one the socket sees (static line of sight, spot-ray budget) is cached. Returns
 * false while nobody qualifies (or the ray budget ran out – retried next tick).
 */
function searchAlly(e: Enemy, host: AiHost, B: BeamParams, H: BeamHealParams, st: BeamState): boolean {
  st.ally = null;
  st.allyId = 0;
  // Up to three candidates by score (1 − health fraction), no allocation.
  let c0: Enemy | null = null;
  let c1: Enemy | null = null;
  let c2: Enemy | null = null;
  let s0 = -1;
  let s1 = -1;
  let s2 = -1;
  const r2 = H.range * H.range;
  const list = host.enemies;
  for (let i = 0; i < list.length; i++) {
    const o = list[i]!;
    if (o === e || !o.alive || o.state === 'emerge' || o.state === 'free') continue;
    if (o.def.boss === true && !H.bosses) continue;
    const frac = o.healthFraction;
    if (frac >= H.below) continue;
    const dx = o.position.x - e.position.x;
    const dy = o.position.y - e.position.y;
    const dz = o.position.z - e.position.z;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    const score = 1 - frac;
    if (score > s0) {
      c2 = c1;
      s2 = s1;
      c1 = c0;
      s1 = s0;
      c0 = o;
      s0 = score;
    } else if (score > s1) {
      c2 = c1;
      s2 = s1;
      c1 = o;
      s1 = score;
    } else if (score > s2) {
      c2 = o;
      s2 = score;
    }
  }
  if (!c0) return true;
  socketPoint(e, host, B.socket, _from);
  for (let k = 0; k < 3; k++) {
    const o = k === 0 ? c0 : k === 1 ? c1 : c2;
    if (!o) break;
    if (!host.takeSpotRays(1)) return false;
    if (host.combat.lineOfSight(_from, o.aimPoint)) {
      st.ally = o;
      st.allyId = o.id;
      return true;
    }
  }
  return true;
}

/**
 * Support brain query: is there an ally to heal with attack `a` (heal beam) right now? Searches
 * at most every `searchInterval` s (spot-ray budget for the line of sight) and caches the ally for
 * the wind-up and strike.
 */
export function healTargetReady(e: Enemy, host: AiHost, a: EnemyAttackDef): boolean {
  const B = a.beam;
  const H = B?.heal;
  if (!B || !H) return false;
  const st = stateOf(e);
  if (validAlly(e, st, H) && st.ally!.healthFraction < H.below) return true;
  if (host.time < st.nextSearch) return false;
  if (!searchAlly(e, host, B, H, st)) return false;
  st.nextSearch = host.time + H.searchInterval;
  return st.ally !== null;
}

/** The ally the enemy's heal beam is tethered to / aimed at (null: none). */
export function healTargetOf(e: Enemy): Enemy | null {
  const st = states.get(e);
  return st && st.ally && st.ally.id === st.allyId ? st.ally : null;
}

function faceAlly(e: Enemy, ally: Enemy, H: BeamHealParams, dt: number): void {
  const want = yawTo(ally.position.x - e.position.x, ally.position.z - e.position.z);
  e.yaw = turnTowards(e.yaw, want, H.turnRateDeg * DEG2RAD * dt);
}

function healWindup(e: Enemy, H: BeamHealParams, dt: number, first: boolean): boolean {
  const st = stateOf(e);
  if (first) st.startHealth = e.health;
  const ally = validAlly(e, st, H);
  if (!ally) return true;
  faceAlly(e, ally, H, dt);
  return false;
}

function healBegin(e: Enemy, host: AiHost, B: BeamParams, H: BeamHealParams): boolean {
  const st = stateOf(e);
  const ally = validAlly(e, st, H);
  if (!ally) return false;
  host.beams?.open(e, B.visual, B.socket);
  host.beams?.toEnemy(e, ally);
  st.nextLos = host.time + H.losInterval;
  st.nextPulse = host.time;
  return true;
}

function endHeal(e: Enemy, host: AiHost, st: BeamState): boolean {
  host.beams?.close(e);
  st.ally = null;
  st.allyId = 0;
  return true;
}

function healUpdate(
  e: Enemy,
  host: AiHost,
  a: EnemyAttackDef,
  B: BeamParams,
  H: BeamHealParams,
  target: EnemyTargetApi | null,
  dt: number,
): boolean {
  const st = stateOf(e);
  const ally = validAlly(e, st, H);
  if (!ally || e.phaseTime >= a.strike || ally.health >= ally.maxHealth) return endHeal(e, host, st);
  if (target && target.alive && distXZ(e.position, target.position) < H.breakDistance) {
    return endHeal(e, host, st);
  }
  if (st.startHealth - e.health >= H.interruptDamage) {
    // Interrupted: the tether snaps and the healer reels.
    endHeal(e, host, st);
    host.staggerSelf(e, H.interruptStagger);
    return true;
  }
  const now = host.time;
  // Budget exhausted: re-check next tick.
  if (now >= st.nextLos && host.takeSpotRays(1)) {
    st.nextLos = now + H.losInterval;
    if (!host.combat.lineOfSight(socketPoint(e, host, B.socket, _from), ally.aimPoint)) {
      return endHeal(e, host, st);
    }
  }
  faceAlly(e, ally, H, dt);
  // Flat part scales with the healer's wave toughness (spawn health multiplier).
  const toughness = e.def.health > 0 ? e.maxHealth / e.def.health : 1;
  const amount = (H.perSecond * toughness + H.fractionPerSecond * ally.maxHealth) * dt;
  ally.health = Math.min(ally.maxHealth, ally.health + amount);
  if (now >= st.nextPulse) {
    st.nextPulse = now + H.pulseInterval;
    host.vfx?.spawn(H.pulseEffect, ally.boundsCenter, UP, H.pulseScale * ally.pose.scale);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Laser
// ---------------------------------------------------------------------------

/** The target's chest (aim point) into `out`. */
function chestOf(target: EnemyTargetApi, L: BeamLaserParams, out: Vector3): Vector3 {
  return out.set(target.eyePosition.x, target.eyePosition.y - L.aimDrop, target.eyePosition.z);
}

/**
 * The shown aim line: socket → aim point, ending `endShort` m before it and at the first thing the
 * ray meets (walls, bodies, props) – the line never passes through cover.
 */
function aimLine(e: Enemy, host: AiHost, B: BeamParams, L: BeamLaserParams, st: BeamState): void {
  const beams = host.beams;
  if (!beams) return;
  socketPoint(e, host, B.socket, _from);
  _dir.subVectors(st.aim, _from);
  const len = _dir.length();
  if (len < 1e-3) {
    beams.toPoint(e, st.aim);
    return;
  }
  _dir.multiplyScalar(1 / len);
  const reach = Math.max(0, len - L.endShort);
  const hit = host.combat.raycast(_from, _dir, reach, { ignore: e });
  if (hit) _end.copy(hit.point);
  else _end.copy(_from).addScaledVector(_dir, reach);
  beams.toPoint(e, _end);
}

function laserWindup(
  e: Enemy,
  host: AiHost,
  a: EnemyAttackDef,
  B: BeamParams,
  L: BeamLaserParams,
  target: EnemyTargetApi | null,
  dt: number,
  first: boolean,
): boolean {
  const st = stateOf(e);
  const now = host.time;
  if (first) {
    st.locked = false;
    st.lastSeen = now;
    st.startHealth = e.health;
    if (target) {
      // Acquiring: the line starts off the target and converges on it.
      chestOf(target, L, st.aim);
      const ang = host.rng.next() * TAU;
      st.aim.x += Math.cos(ang) * L.startError;
      st.aim.z += Math.sin(ang) * L.startError;
    } else {
      socketPoint(e, host, B.socket, st.aim);
      st.aim.x += Math.sin(e.yaw) * L.maxRange;
      st.aim.z += Math.cos(e.yaw) * L.maxRange;
    }
    host.beams?.open(e, B.visual, B.socket);
    socketPoint(e, host, B.socket, _from);
    _dir.subVectors(st.aim, _from).normalize();
    host.vfx?.spawn(L.glintEffect, _from, _dir, L.effectScale * e.pose.scale);
  }
  if (!st.locked) {
    if (target && target.alive && host.refreshLos(e, ENEMY_AI.perception.losMaxAge)) {
      st.lastSeen = now;
      chestOf(target, L, _chest);
      _dir.subVectors(_chest, st.aim);
      const d = _dir.length();
      const step = L.trackSpeed * dt;
      if (d <= step) st.aim.copy(_chest);
      else st.aim.addScaledVector(_dir, step / d);
    } else if (now - st.lastSeen > L.lostAbort) {
      host.beams?.close(e);
      return true;
    }
    if (e.phaseTime >= a.windup - L.lockTime) {
      st.locked = true;
      host.beams?.setVisual(e, L.lockVisual);
      socketPoint(e, host, B.socket, _from);
      _dir.subVectors(st.aim, _from).normalize();
      host.vfx?.spawn(L.lockEffect, _from, _dir, L.effectScale * e.pose.scale);
    }
  }
  aimLine(e, host, B, L, st);
  return false;
}

/** Fire: one instant ray at the locked aim point. */
function laserBegin(
  e: Enemy,
  host: AiHost,
  a: EnemyAttackDef,
  B: BeamParams,
  L: BeamLaserParams,
  target: EnemyTargetApi | null,
): boolean {
  const st = stateOf(e);
  host.beams?.close(e);
  socketPoint(e, host, B.socket, _from);
  _dir.subVectors(st.aim, _from);
  if (_dir.lengthSq() < 1e-8) return false;
  _dir.normalize();
  const hit = host.combat.raycast(_from, _dir, L.maxRange, { ignore: e });
  let wall = false;
  if (hit) {
    _end.copy(hit.point);
    _chest.copy(hit.normal);
    wall = true;
  } else {
    _end.copy(_from).addScaledVector(_dir, L.maxRange);
  }
  if (target && target.alive) {
    const r = ENEMY_AI.player.radius;
    _capA.set(target.position.x, target.position.y + r, target.position.z);
    _capB.set(target.eyePosition.x, Math.max(_capA.y, target.eyePosition.y), target.eyePosition.z);
    segmentSegment(_from, _end, _capA, _capB, _seg);
    if (Math.sqrt(_seg.distSq) - r <= L.hitRadius) {
      host.hitTarget(e, a, target, a.damage, a.shake);
      // The ray ends in the target (short of the eye: no flare in the player's face).
      const len = _from.distanceTo(_end) * _seg.s;
      _end.copy(_from).addScaledVector(_dir, Math.max(0, len - L.endShort));
      wall = false;
    }
  }
  host.vfx?.spawn(L.fireEffect, _from, _dir, L.effectScale * e.pose.scale);
  if (wall) host.vfx?.spawn(L.impactEffect, _end, _chest, L.effectScale);
  host.beams?.shot(L.shotVisual, _from, _end);
  return true;
}

// ---------------------------------------------------------------------------

export const beamAttack: AttackExecutor = {
  windup(e, host, a, target, dt, first) {
    const B = a.beam;
    if (!B) return true;
    if (B.heal) return healWindup(e, B.heal, dt, first);
    if (B.laser) return laserWindup(e, host, a, B, B.laser, target, dt, first);
    return true;
  },

  begin(e, host, a, target) {
    const B = a.beam;
    if (!B) return false;
    if (B.heal) return healBegin(e, host, B, B.heal);
    if (B.laser) return laserBegin(e, host, a, B, B.laser, target);
    return false;
  },

  update(e, host, a, target, dt) {
    const B = a.beam;
    if (B?.heal) return healUpdate(e, host, a, B, B.heal, target, dt);
    return false;
  },

  cancel(e, host) {
    host.beams?.close(e);
    const st = states.get(e);
    if (st) st.locked = false;
  },
};
