/**
 * Combat-module extensions of the CombatWorldApi contract used by the weapon system:
 * penetration-aware raycasts and prop impulses.
 */
import type { CombatHit, CombatWorldApi, Damageable } from '../core/contracts';
import type { Vec3Like } from '../core/events';

export interface CombatRaycastOptions {
  /** Skip this damageable (the shooter, a target the bullet already passed). */
  ignore?: Damageable | null;
  /** Skip several damageables (penetration through bodies). */
  ignoreMany?: readonly Damageable[];
  /**
   * Skip the dynamic prop hit by the previous raycast (penetration continuation: the new ray
   * starts inside that prop).
   */
  skipLastProp?: boolean;
  /** Test dynamic props (default true). */
  props?: boolean;
}

export interface WeaponCombatApi extends CombatWorldApi {
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: CombatRaycastOptions,
  ): CombatHit | null;
  /**
   * Push the dynamic prop behind `hit` (must be the hit returned by the latest raycast) along
   * `direction` with `impulse` N·s at the hit point. No-op for anything else.
   */
  pushProp(hit: CombatHit, direction: Vec3Like, impulse: number): boolean;
  /**
   * Is `hit` (the latest raycast result) on a dynamic prop? Such hits get no world-space decal:
   * the prop moves away from it.
   */
  hitsDynamicProp(hit: CombatHit): boolean;
}
