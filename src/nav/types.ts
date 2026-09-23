/**
 * Internal steering backend: the agent half of NavApi, implemented by the detour crowd
 * (NavCrowd) and the no-navmesh fallback (DirectSteering). NavSystem maps its stable agent ids
 * onto the active backend's indices, so agents survive a backend swap (navmesh ready / lost).
 */
import type { Vector3 } from 'three';
import type { NavAgentParams } from '../core/contracts';
import type { Vec3Like } from '../core/events';

export interface SteeringBackend {
  readonly kind: 'crowd' | 'direct';
  /** Live agents. */
  readonly agentCount: number;
  /**
   * Returns the backend index, -1 when full (or, for the crowd, when `position` is off the navmesh
   * unless `force`: then the agent is parked in detour's invalid state until teleported).
   */
  addAgent(position: Vec3Like, params: NavAgentParams, force?: boolean): number;
  removeAgent(index: number): void;
  setAgentTarget(index: number, target: Vec3Like): void;
  stopAgent(index: number): void;
  setAgentMaxSpeed(index: number, speed: number): void;
  teleportAgent(index: number, position: Vec3Like): void;
  getAgentPosition(index: number, out: Vector3): Vector3;
  getAgentVelocity(index: number, out: Vector3): Vector3;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Ground height below (x, y, z) or null (DirectSteering / fallback queries). Game can back it
 * with a downward physics ray against the static world.
 */
export type GroundProbe = (x: number, y: number, z: number) => number | null;
