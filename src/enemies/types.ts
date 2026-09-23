/**
 * Contract between enemy AI/logic (EnemyManager) and enemy rendering (EnemyRenderer).
 *
 * Enemies are drawn with one InstancedMesh per type; all animation is procedural in the vertex
 * shader, driven by the per-instance EnemyPose below. The renderer also evaluates the SAME pose on
 * the CPU to produce world-space hitboxes, so bullets hit what the player sees.
 */
import type * as THREE from 'three';
import type { Hitbox } from '../core/contracts';

/** Enemy type ids. Extended in M6 (16 types + 5 bosses) – keep ids stable, they are save/stat keys. */
export type EnemyTypeId = 'swarmer' | 'spitter' | 'tank' | (string & {});

/** Animation drivers written by the AI every tick (renderer interpolates between ticks). */
export interface EnemyPose {
  /** 0 = idle, 1 = walk, 2 = run/charge (continuous blend). */
  locomotion: number;
  /** Gait phase in radians (advance by distance travelled / stride). */
  phase: number;
  /** Attack animation id (index into the type's attack list; -1 = none). */
  attackId: number;
  /** 0..1 progress of the current attack animation (wind-up → strike → recover). */
  attack: number;
  /** 0..1 stagger / flinch blend. */
  stagger: number;
  /** 0..1 death collapse progress. */
  death: number;
  /** 0..1 dissolve (after death; 1 = gone). */
  dissolve: number;
  /** 0..1 spawn emergence from a rift (0 = inside the portal, 1 = fully out). */
  emerge: number;
  /** 0..1 white-hot hit flash (decays quickly). */
  hitFlash: number;
  /** Head/torso aim towards the target relative to the body yaw (radians). */
  lookYaw: number;
  lookPitch: number;
  /** Elite rim-light color (linear RGB) and strength (0 = none). */
  rimColor: THREE.Color;
  rim: number;
  /** Uniform scale multiplier (elites are slightly bigger). */
  scale: number;
}

export function createEnemyPose(color: THREE.Color): EnemyPose {
  return {
    locomotion: 0,
    phase: 0,
    attackId: -1,
    attack: 0,
    stagger: 0,
    death: 0,
    dissolve: 0,
    emerge: 1,
    hitFlash: 0,
    lookYaw: 0,
    lookPitch: 0,
    rimColor: color,
    rim: 0,
    scale: 1,
  };
}

/** Opaque per-type instance slot handed out by the renderer. */
export type EnemyInstanceHandle = number;

export interface EnemyVisualsApi {
  /** Reserve an instance slot for `type`; -1 if the type is unknown or capacity is exhausted. */
  acquire(type: EnemyTypeId): EnemyInstanceHandle;
  release(type: EnemyTypeId, handle: EnemyInstanceHandle): void;
  /** Feet position + body yaw (radians, three.js convention) at the latest tick. */
  setTransform(type: EnemyTypeId, handle: EnemyInstanceHandle, position: THREE.Vector3, yaw: number): void;
  setPose(type: EnemyTypeId, handle: EnemyInstanceHandle, pose: Readonly<EnemyPose>): void;
  /** Called after all transforms/poses of a tick are set: snapshot for interpolation. */
  commitTick(): void;
  /**
   * World-space hitboxes for the latest tick pose (same animation math as the shader). Fills `out`
   * (reusing its Hitbox objects, growing it if needed) and returns the number written.
   */
  computeHitboxes(type: EnemyTypeId, handle: EnemyInstanceHandle, out: Hitbox[]): number;
  /** Broadphase sphere for the latest tick pose. */
  computeBounds(type: EnemyTypeId, handle: EnemyInstanceHandle, outCenter: THREE.Vector3): number;
  /** Aim-assist / look-at point (upper chest). */
  computeAimPoint(type: EnemyTypeId, handle: EnemyInstanceHandle, out: THREE.Vector3): THREE.Vector3;
  /** World position of a named socket (mouth for spit, fists for slam) for the latest tick pose. */
  computeSocket(
    type: EnemyTypeId,
    handle: EnemyInstanceHandle,
    socket: string,
    out: THREE.Vector3,
  ): THREE.Vector3;
  /** Per frame: interpolate between tick snapshots with `alpha` and upload instance buffers once. */
  update(dt: number, alpha: number): void;
  readonly stats: { instances: number; drawCalls: number };
  dispose(): void;
}
