/**
 * 'summon' attack executor (M6): the wind-up is the channel. On its first tick a rift point is
 * picked `forward` m towards the target (snapped to the navmesh); a beam runs from the summoner's
 * socket to it and the channel effect pulses there. Damage (interruptDamage since the channel
 * started) aborts it; a stagger cancels it like any wind-up. At the strike, the missing minions
 * (up to `count`, at most `maxAlive` of this summoner alive) emerge around the point through
 * AiHost.spawnMinion (ENEMY_AI.minions caps; the fallback type while the minion type has no def).
 *
 * Per-enemy state: one pooled SummonState per record (WeakMap), nothing allocated per tick.
 */
import { Vector3 } from 'three';
import type { Vec3Like } from '../../../core/events';
import { getEnemyDef, type EnemyAttackDef } from '../../../defs/enemies';
import type { Enemy } from '../../Enemy';
import type { AiHost } from '../types';
import type { AttackExecutor } from './types';

const UP: Vec3Like = { x: 0, y: 1, z: 0 };

class SummonState {
  readonly point = new Vector3();
  startHealth = 0;
  nextFx = 0;
}

const states = new WeakMap<Enemy, SummonState>();
const _p = new Vector3();

function stateOf(e: Enemy): SummonState {
  let s = states.get(e);
  if (!s) {
    s = new SummonState();
    states.set(e, s);
  }
  return s;
}

/** Living minions of `parent` (EnemyManager.spawnMinion sets Enemy.parentId). */
export function minionsOf(parent: Enemy, host: AiHost): number {
  let n = 0;
  const list = host.enemies;
  for (let i = 0; i < list.length; i++) {
    const o = list[i]!;
    if (o.alive && o.parentId === parent.id) n++;
  }
  return n;
}

/** Support brain query: may attack `a` (summon) start – a host that summons and room for minions? */
export function summonReady(e: Enemy, host: AiHost, a: EnemyAttackDef): boolean {
  const S = a.summon;
  if (!S || !host.spawnMinion || S.count <= 0) return false;
  return minionsOf(e, host) < S.maxAlive;
}

/** The channel point of the running (or last) summon. */
export function summonPointOf(e: Enemy): Vector3 | null {
  return states.get(e)?.point ?? null;
}

/** The minion type that can spawn now (the fallback while the summon type is not built). */
export function summonType(a: EnemyAttackDef): string | null {
  const S = a.summon;
  if (!S) return null;
  if (getEnemyDef(S.type)) return S.type;
  return getEnemyDef(S.fallbackType) ? S.fallbackType : null;
}

export const summonAttack: AttackExecutor = {
  windup(e, host, a, target, _dt, first) {
    const S = a.summon;
    if (!S) return true;
    const st = stateOf(e);
    const now = host.time;
    if (first) {
      st.startHealth = e.health;
      st.nextFx = now;
      // Towards the target (else straight ahead), snapped to the floor the summoner stands on.
      let dx = Math.sin(e.yaw);
      let dz = Math.cos(e.yaw);
      if (target) {
        const tx = target.position.x - e.position.x;
        const tz = target.position.z - e.position.z;
        const len = Math.hypot(tx, tz);
        if (len > 1e-3) {
          dx = tx / len;
          dz = tz / len;
        }
      }
      _p.set(e.position.x + dx * S.forward, e.position.y, e.position.z + dz * S.forward);
      if (!host.nav.walkable(e.position, _p) || !host.nav.closestPoint(_p, st.point)) {
        st.point.copy(e.position);
      }
      if (S.visual !== '' && host.beams?.open(e, S.visual, S.socket)) host.beams.toPoint(e, st.point);
    }
    if (st.startHealth - e.health >= S.interruptDamage) {
      host.beams?.close(e);
      return true;
    }
    if (now >= st.nextFx) {
      st.nextFx = now + S.channelInterval;
      host.vfx?.spawn(S.channelEffect, st.point, UP, S.effectScale * e.pose.scale);
    }
    return false;
  },

  begin(e, host, a) {
    const S = a.summon;
    host.beams?.close(e);
    if (!S || !host.spawnMinion) return false;
    const type = summonType(a);
    if (!type) return false;
    const st = stateOf(e);
    const n = Math.min(S.count, S.maxAlive - minionsOf(e, host));
    let spawned = 0;
    for (let i = 0; i < n; i++) if (host.spawnMinion(type, st.point, S.radius, e) !== null) spawned++;
    if (spawned > 0) host.vfx?.spawn(S.burstEffect, st.point, UP, S.effectScale * e.pose.scale);
    return spawned > 0;
  },

  cancel(e, host) {
    host.beams?.close(e);
  },
};
