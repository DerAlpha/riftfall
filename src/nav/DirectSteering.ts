/**
 * Fallback steering without a navmesh (recast failed / not built yet): agents accelerate
 * straight towards their target, slow down on arrival and push each other apart. No pathing and
 * no walls – the game keeps running, enemies just take the direct line.
 *
 * Heights: with a GroundProbe (a physics ray) agents follow the floor, re-probed round-robin every
 * NAV.direct.probeInterval ticks; without one they blend towards the target height as they
 * close in. State lives in typed arrays; update() allocates nothing.
 */
import type { Vector3 } from 'three';
import type { NavAgentParams } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { NAV } from '../defs/nav';
import type { GroundProbe, SteeringBackend } from './types';

const D = NAV.direct;
/** Coincident agents are pushed apart along a fixed axis (deterministic). */
const MIN_SEPARATION_DIST = 1e-4;

export class DirectSteering implements SteeringBackend {
  readonly kind = 'direct' as const;
  readonly capacity: number;

  private readonly active: Uint8Array;
  private readonly hasTarget: Uint8Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly target: Float32Array;
  private readonly radius: Float32Array;
  private readonly maxSpeed: Float32Array;
  private readonly maxAccel: Float32Array;
  private readonly separation: Float32Array;
  /** Scratch: desired velocity (x, z) per agent. */
  private readonly desired: Float32Array;
  private count = 0;
  private tick = 0;

  constructor(
    capacity: number = NAV.crowd.maxAgents,
    private readonly groundProbe: GroundProbe | null = null,
  ) {
    this.capacity = capacity;
    this.active = new Uint8Array(capacity);
    this.hasTarget = new Uint8Array(capacity);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.target = new Float32Array(capacity * 3);
    this.radius = new Float32Array(capacity);
    this.maxSpeed = new Float32Array(capacity);
    this.maxAccel = new Float32Array(capacity);
    this.separation = new Float32Array(capacity);
    this.desired = new Float32Array(capacity * 2);
  }

  get agentCount(): number {
    return this.count;
  }

  addAgent(position: Vec3Like, params: NavAgentParams): number {
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.hasTarget[i] = 0;
      const o = i * 3;
      this.pos[o] = position.x;
      this.pos[o + 1] = position.y;
      this.pos[o + 2] = position.z;
      this.vel[o] = 0;
      this.vel[o + 1] = 0;
      this.vel[o + 2] = 0;
      this.radius[i] = Math.max(0, params.radius);
      this.maxSpeed[i] = Math.max(0, params.maxSpeed);
      this.maxAccel[i] = Math.max(0, params.maxAcceleration);
      this.separation[i] = params.separationWeight ?? NAV.crowd.defaultSeparation;
      this.count++;
      return i;
    }
    return -1;
  }

  removeAgent(index: number): void {
    if (!this.isActive(index)) return;
    this.active[index] = 0;
    this.hasTarget[index] = 0;
    this.count--;
  }

  setAgentTarget(index: number, target: Vec3Like): void {
    if (!this.isActive(index)) return;
    const o = index * 3;
    this.target[o] = target.x;
    this.target[o + 1] = target.y;
    this.target[o + 2] = target.z;
    this.hasTarget[index] = 1;
  }

  stopAgent(index: number): void {
    if (this.isActive(index)) this.hasTarget[index] = 0;
  }

  setAgentMaxSpeed(index: number, speed: number): void {
    if (this.isActive(index)) this.maxSpeed[index] = Math.max(0, speed);
  }

  teleportAgent(index: number, position: Vec3Like): void {
    if (!this.isActive(index)) return;
    const o = index * 3;
    this.pos[o] = position.x;
    this.pos[o + 1] = position.y;
    this.pos[o + 2] = position.z;
    this.vel[o] = 0;
    this.vel[o + 1] = 0;
    this.vel[o + 2] = 0;
  }

  getAgentPosition(index: number, out: Vector3): Vector3 {
    if (index < 0 || index >= this.capacity) return out;
    const o = index * 3;
    return out.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
  }

  getAgentVelocity(index: number, out: Vector3): Vector3 {
    if (index < 0 || index >= this.capacity) return out;
    const o = index * 3;
    return out.set(this.vel[o]!, this.vel[o + 1]!, this.vel[o + 2]!);
  }

  update(dt: number): void {
    if (dt <= 0 || this.count === 0) return;
    const n = this.capacity;
    const { pos, vel, target, desired } = this;

    // 1. Desired velocity: arrive at the target + separation (read-only pass over positions).
    for (let i = 0; i < n; i++) {
      if (!this.active[i]) continue;
      const o = i * 3;
      const speed = this.maxSpeed[i]!;
      let dx = 0;
      let dz = 0;
      if (this.hasTarget[i]) {
        const tx = target[o]! - pos[o]!;
        const tz = target[o + 2]! - pos[o + 2]!;
        const dist = Math.hypot(tx, tz);
        if (dist > D.arriveDistance) {
          const s = (speed * Math.min(1, dist / D.slowdownDistance)) / dist;
          dx = tx * s;
          dz = tz * s;
        }
      }
      const sepWeight = this.separation[i]!;
      if (sepWeight > 0) {
        for (let j = 0; j < n; j++) {
          if (j === i || !this.active[j]) continue;
          const p = j * 3;
          let ox = pos[o]! - pos[p]!;
          let oz = pos[o + 2]! - pos[p + 2]!;
          const range = (this.radius[i]! + this.radius[j]!) * D.separationRangeFactor;
          const d2 = ox * ox + oz * oz;
          if (d2 >= range * range) continue;
          let d = Math.sqrt(d2);
          if (d < MIN_SEPARATION_DIST) {
            // Deterministic split: lower index goes -X, higher +X.
            ox = i < j ? -1 : 1;
            oz = 0;
            d = 1;
          }
          const push = (1 - Math.min(1, Math.sqrt(d2) / range)) * sepWeight * D.separationStrength * speed;
          dx += (ox / d) * push;
          dz += (oz / d) * push;
        }
      }
      const len = Math.hypot(dx, dz);
      if (len > speed && len > 0) {
        dx *= speed / len;
        dz *= speed / len;
      }
      desired[i * 2] = dx;
      desired[i * 2 + 1] = dz;
    }

    // 2. Accelerate towards the desired velocity and integrate.
    const probe = this.groundProbe;
    const interval = Math.max(1, D.probeInterval);
    for (let i = 0; i < n; i++) {
      if (!this.active[i]) continue;
      const o = i * 3;
      let ax = desired[i * 2]! - vel[o]!;
      let az = desired[i * 2 + 1]! - vel[o + 2]!;
      const aLen = Math.hypot(ax, az);
      const maxDv = this.maxAccel[i]! * dt;
      if (aLen > maxDv && aLen > 0) {
        ax *= maxDv / aLen;
        az *= maxDv / aLen;
      }
      vel[o] = vel[o]! + ax;
      vel[o + 2] = vel[o + 2]! + az;
      const stepX = vel[o]! * dt;
      const stepZ = vel[o + 2]! * dt;
      pos[o] = pos[o]! + stepX;
      pos[o + 2] = pos[o + 2]! + stepZ;
      const y0 = pos[o + 1]!;
      let y = y0;
      if (probe) {
        if ((i + this.tick) % interval === 0) {
          const ground = probe(pos[o]!, y0 + D.probeUp, pos[o + 2]!);
          if (ground !== null && Number.isFinite(ground)) y = ground;
        }
      } else if (this.hasTarget[i]) {
        // No ground info: close the height gap in proportion to the horizontal progress.
        const remaining = Math.hypot(target[o]! - pos[o]!, target[o + 2]! - pos[o + 2]!);
        const step = Math.hypot(stepX, stepZ);
        const t = remaining + step > 0 ? step / (remaining + step) : 1;
        y = y0 + (target[o + 1]! - y0) * t;
      }
      pos[o + 1] = y;
      vel[o + 1] = (y - y0) / dt;
    }
    this.tick++;
  }

  dispose(): void {
    this.active.fill(0);
    this.hasTarget.fill(0);
    this.count = 0;
  }

  private isActive(index: number): boolean {
    return index >= 0 && index < this.capacity && this.active[index] === 1;
  }
}
