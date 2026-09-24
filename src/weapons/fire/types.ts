/**
 * Shared types of the fire-kinds engine (M5): how damage dealt by projectiles, explosions, fields,
 * beams and chain arcs reaches the weapon specials interpreter (WeaponSpecials).
 */
import { Vector3 } from 'three';
import type { DamageInfo, DamageResult, Damageable } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import type { WeaponSpecialDef } from '../../defs/weapons';

/**
 * How a damage event was delivered: a bullet/projectile hit (`direct`), a beam or field tick
 * (`tick`), an explosion (`blast`) or a chain arc (`arc`). Specials react by delivery: arcs never
 * arc again, explosions never set off explosive rounds (no feedback loops).
 */
export type HitVia = 'direct' | 'tick' | 'blast' | 'arc';

/** One damage event of a special-carrying source (reused object – read it before emitting). */
export interface SpecialHit {
  special: WeaponSpecialDef | null;
  via: HitVia;
  weaponId: string;
  source: DamageInfo['source'];
  target: Damageable;
  point: Vec3Like;
  /** Damage actually applied and whether it killed. */
  applied: number;
  killed: boolean;
  /**
   * The event may roll procs (chain arcs, explosive rounds, element procs): the first damage event
   * of a target per shot/tick, the first target of an explosion.
   */
  primary: boolean;
}

/** Receiver of damage events for weapon specials (WeaponSpecials). */
export interface SpecialsHook {
  onHit(hit: SpecialHit): void;
}

const NOTHING: DamageResult = Object.freeze({ applied: 0, killed: false });

/** Inert placeholder target of a SpecialHit record before its first use. */
export const NO_TARGET: Damageable = {
  id: -1,
  alive: false,
  team: 'neutral',
  surface: 'flesh',
  boundsCenter: new Vector3(),
  boundsRadius: 0,
  hitboxes: [],
  aimPoint: new Vector3(),
  applyDamage: () => NOTHING,
};

/** Creates the reused SpecialHit record of a damage source. */
export function createSpecialHit(): SpecialHit {
  return {
    special: null,
    via: 'direct',
    weaponId: '',
    source: 'player',
    target: NO_TARGET,
    point: { x: 0, y: 0, z: 0 },
    applied: 0,
    killed: false,
    primary: false,
  };
}
