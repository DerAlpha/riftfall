/**
 * Detour crowd on the raw bindings (allocation-free per tick): agents, move targets, avoidance.
 *
 * Move targets are throttled and staggered: `setAgentTarget` only marks a request pending when
 * the goal moved noticeably (NAV.crowd.retarget*), and `update` sends at most
 * NAV.crowd.maxTargetRequestsPerTick requests round-robin before stepping the crowd – AI may call
 * setAgentTarget every tick for every enemy without an A* search per call. A goal whose request
 * detour reported as failed is not throttled (the next setAgentTarget resends it).
 */
import { Crowd, Raw, type NavMesh, type RawModule } from 'recast-navigation';
import type { Vector3 } from 'three';
import type { NavAgentParams } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { NAV } from '../defs/nav';
import type { NavQuery } from './NavQuery';
import type { SteeringBackend } from './types';

const C = NAV.crowd;

function set3(arr: number[], x: number, y: number, z: number): number[] {
  arr[0] = x;
  arr[1] = y;
  arr[2] = z;
  return arr;
}

export class NavCrowd implements SteeringBackend {
  readonly kind = 'crowd' as const;
  readonly capacity: number;

  private readonly crowd: Crowd;
  private readonly raw: RawModule.dtCrowd;
  private readonly agents: RawModule.dtCrowdAgent[] = [];
  private readonly params: RawModule.dtCrowdAgentParams[] = [];
  private readonly addParams: RawModule.dtCrowdAgentParams;
  private readonly active: Uint8Array;
  /** A new goal waits to be sent to detour. */
  private readonly pending: Uint8Array;
  /** The AI wants the agent to move (cleared by stopAgent). */
  private readonly hasGoal: Uint8Array;
  /** A goal was sent (the throttle compares against it). */
  private readonly sent: Uint8Array;
  private readonly goal: Float32Array;
  private readonly sentGoal: Float32Array;
  private readonly bias = NAV.query.heightBias;
  /** dtCrowdAgent.targetState after a path request detour could not serve. */
  private readonly targetFailed: number = Raw.Module.DT_CROWDAGENT_TARGET_FAILED;
  private cursor = 0;
  private count = 0;
  private disposed = false;
  private readonly _p: number[] = [0, 0, 0];
  private readonly _ext: number[] = [0, 0, 0];

  /** Move requests sent to detour since creation (tests / debug). */
  requestsSent = 0;

  constructor(
    navMesh: NavMesh,
    private readonly query: NavQuery,
    capacity: number = C.maxAgents,
  ) {
    this.capacity = capacity;
    this.crowd = new Crowd(navMesh, { maxAgents: capacity, maxAgentRadius: C.maxAgentRadius });
    this.raw = this.crowd.raw;
    const presets = C.avoidance;
    const oa = new Raw.Module.dtObstacleAvoidanceParams();
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i]!;
      oa.velBias = p.velBias;
      oa.weightDesVel = p.weightDesVel;
      oa.weightCurVel = p.weightCurVel;
      oa.weightSide = p.weightSide;
      oa.weightToi = p.weightToi;
      oa.horizTime = p.horizTime;
      oa.gridSize = p.gridSize;
      oa.adaptiveDivs = p.adaptiveDivs;
      oa.adaptiveRings = p.adaptiveRings;
      oa.adaptiveDepth = p.adaptiveDepth;
      this.raw.setObstacleAvoidanceParams(i, oa);
    }
    Raw.destroy(oa);
    // Agents never path through blocked areas (closed doors, machines – NavSystem.setAreaBlocked).
    this.raw.getEditableFilter(0).setExcludeFlags(NAV.areas.disabledFlag);
    this.addParams = new Raw.Module.dtCrowdAgentParams();
    for (let i = 0; i < capacity; i++) {
      const agent = this.raw.getEditableAgent(i);
      this.agents.push(agent);
      this.params.push(agent.params);
    }
    this.active = new Uint8Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.hasGoal = new Uint8Array(capacity);
    this.sent = new Uint8Array(capacity);
    this.goal = new Float32Array(capacity * 3);
    this.sentGoal = new Float32Array(capacity * 3);
  }

  get agentCount(): number {
    return this.count;
  }

  /** Move requests waiting for their slot (debug overlay). */
  get pendingCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) n += this.pending[i]!;
    return n;
  }

  addAgent(position: Vec3Like, params: NavAgentParams, force = false): number {
    if (this.disposed || this.count >= this.capacity) return -1;
    const q = this.query;
    const onMesh = q.nearest(position) !== 0;
    if (!onMesh && !force) return -1;
    const radius = Math.min(Math.max(params.radius, 0), C.maxAgentRadius);
    const p = this.addParams;
    p.radius = radius;
    p.height = params.height;
    p.maxAcceleration = params.maxAcceleration;
    p.maxSpeed = params.maxSpeed;
    p.collisionQueryRange = radius * C.collisionQueryRangeFactor;
    p.pathOptimizationRange = radius * C.pathOptimizationRangeFactor;
    p.separationWeight = (params.separationWeight ?? C.defaultSeparation) * C.separationWeightScale;
    p.updateFlags = C.updateFlags;
    p.obstacleAvoidanceType = radius > C.qualityRadius ? C.qualityAvoidance : C.swarmAvoidance;
    p.queryFilterType = 0;
    const idx = this.raw.addAgent(
      onMesh
        ? set3(this._p, q.nx, q.ny, q.nz)
        : set3(this._p, position.x, position.y + this.bias, position.z),
      p,
    );
    if (idx < 0 || idx >= this.capacity) return -1;
    this.active[idx] = 1;
    this.pending[idx] = 0;
    this.hasGoal[idx] = 0;
    this.sent[idx] = 0;
    this.count++;
    return idx;
  }

  removeAgent(index: number): void {
    if (!this.isActive(index)) return;
    this.raw.removeAgent(index);
    this.active[index] = 0;
    this.pending[index] = 0;
    this.hasGoal[index] = 0;
    this.sent[index] = 0;
    this.count--;
  }

  setAgentTarget(index: number, target: Vec3Like): void {
    if (!this.isActive(index)) return;
    const o = index * 3;
    this.goal[o] = target.x;
    this.goal[o + 1] = target.y;
    this.goal[o + 2] = target.z;
    this.hasGoal[index] = 1;
    const agent = this.agents[index]!;
    // A request detour failed (no path from a stale corridor) is resent even for the same goal.
    if (this.sent[index] && agent.targetState !== this.targetFailed) {
      const dx = target.x - this.sentGoal[o]!;
      const dy = target.y - this.sentGoal[o + 1]!;
      const dz = target.z - this.sentGoal[o + 2]!;
      const dist = Math.hypot(
        target.x - agent.get_npos(0),
        target.y - agent.get_npos(1),
        target.z - agent.get_npos(2),
      );
      const threshold = Math.max(C.retargetMinDistance, dist * C.retargetDistanceFraction);
      if (dx * dx + dy * dy + dz * dz <= threshold * threshold) {
        this.pending[index] = 0;
        return;
      }
    }
    this.pending[index] = 1;
  }

  stopAgent(index: number): void {
    if (!this.isActive(index)) return;
    this.raw.resetMoveTarget(index);
    this.pending[index] = 0;
    this.hasGoal[index] = 0;
    this.sent[index] = 0;
  }

  setAgentMaxSpeed(index: number, speed: number): void {
    if (!this.isActive(index)) return;
    this.params[index]!.maxSpeed = Math.max(0, speed);
  }

  teleportAgent(index: number, position: Vec3Like): void {
    if (!this.isActive(index)) return;
    const e = NAV.query.halfExtents;
    // agentTeleport keeps the destination as given (a point inside a wall stays there, walking):
    // hand it the snapped point. Nothing in reach: the agent parks off-mesh (invalid) until the
    // next teleport, like a forced add.
    const q = this.query;
    const onMesh = q.nearest(position) !== 0;
    Raw.CrowdUtils.agentTeleport(
      this.raw,
      index,
      onMesh
        ? set3(this._p, q.nx, q.ny, q.nz)
        : set3(this._p, position.x, position.y + this.bias, position.z),
      set3(this._ext, e.x, e.y, e.z),
      this.query.filter,
    );
    // Teleport clears detour's move target: re-send the current goal.
    this.sent[index] = 0;
    this.pending[index] = this.hasGoal[index]!;
  }

  getAgentPosition(index: number, out: Vector3): Vector3 {
    const a = this.agents[index];
    if (!a) return out;
    return out.set(a.get_npos(0), a.get_npos(1) - this.bias, a.get_npos(2));
  }

  getAgentVelocity(index: number, out: Vector3): Vector3 {
    const a = this.agents[index];
    if (!a) return out;
    return out.set(a.get_vel(0), a.get_vel(1), a.get_vel(2));
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.flushRequests();
    this.raw.update(dt, undefined as unknown as RawModule.dtCrowdAgentDebugInfo);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Crowd.destroy frees the dtCrowd (and its query) but not the filter its wrapper allocated.
    const wrapperFilter = this.crowd.navMeshQuery.defaultFilter.raw;
    this.crowd.destroy();
    Raw.destroy(wrapperFilter);
    Raw.destroy(this.addParams);
    this.count = 0;
    this.active.fill(0);
  }

  private isActive(index: number): boolean {
    return !this.disposed && index >= 0 && index < this.capacity && this.active[index] === 1;
  }

  private flushRequests(): void {
    const n = this.capacity;
    let budget = C.maxTargetRequestsPerTick;
    for (let scanned = 0; scanned < n && budget > 0; scanned++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % n;
      if (!this.active[i] || !this.pending[i]) continue;
      this.pending[i] = 0;
      this.sendGoal(i);
      budget--;
    }
  }

  private sendGoal(i: number): void {
    const o = i * 3;
    const q = this.query;
    // Remember the goal even if it is off the mesh: no retry spam until it moves.
    this.sentGoal[o] = this.goal[o]!;
    this.sentGoal[o + 1] = this.goal[o + 1]!;
    this.sentGoal[o + 2] = this.goal[o + 2]!;
    this.sent[i] = 1;
    const ref = q.nearestXYZ(
      this.goal[o]!,
      this.goal[o + 1]!,
      this.goal[o + 2]!,
      NAV.query.targetHalfExtents,
    );
    if (ref === 0) return;
    this.raw.requestMoveTarget(i, ref, set3(this._p, q.nx, q.ny, q.nz));
    this.requestsSent++;
  }
}
