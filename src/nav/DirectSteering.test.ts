import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { NavAgentParams } from '../core/contracts';
import { NAV } from '../defs/nav';
import { DirectSteering } from './DirectSteering';

const DT = 1 / 60;
const AGENT: NavAgentParams = { radius: 0.4, height: 1.8, maxSpeed: 4, maxAcceleration: 16 };

function run(s: DirectSteering, ticks: number, each?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    s.update(DT);
    each?.();
  }
}

describe('DirectSteering', () => {
  it('moves straight to the target within max speed and stops there', () => {
    const s = new DirectSteering(8);
    const id = s.addAgent({ x: 0, y: 0, z: 0 }, AGENT);
    s.setAgentTarget(id, { x: 10, y: 0, z: 0 });
    const vel = new Vector3();
    const pos = new Vector3();
    let top = 0;
    run(s, 300, () => {
      s.getAgentVelocity(id, vel);
      s.getAgentPosition(id, pos);
      top = Math.max(top, vel.length());
      expect(Math.abs(pos.z)).toBeLessThan(1e-6);
    });
    expect(top).toBeLessThanOrEqual(AGENT.maxSpeed + 1e-6);
    expect(top).toBeGreaterThan(AGENT.maxSpeed * 0.95);
    expect(pos.distanceTo(new Vector3(10, 0, 0))).toBeLessThan(NAV.direct.arriveDistance + 0.05);
    expect(s.getAgentVelocity(id, vel).length()).toBeLessThan(0.05);
  });

  it('respects the acceleration limit', () => {
    const s = new DirectSteering(2);
    const id = s.addAgent({ x: 0, y: 0, z: 0 }, AGENT);
    s.setAgentTarget(id, { x: 0, y: 0, z: -20 });
    s.update(DT);
    const vel = s.getAgentVelocity(id, new Vector3());
    expect(vel.length()).toBeCloseTo(AGENT.maxAcceleration * DT, 5);
  });

  it('pushes agents with the same goal apart', () => {
    const s = new DirectSteering(8);
    const a = s.addAgent({ x: -1, y: 0, z: 0 }, AGENT);
    const b = s.addAgent({ x: 1, y: 0, z: 0 }, AGENT);
    const goal = { x: 0, y: 0, z: 0 };
    s.setAgentTarget(a, goal);
    s.setAgentTarget(b, goal);
    run(s, 240);
    const pa = s.getAgentPosition(a, new Vector3());
    const pb = s.getAgentPosition(b, new Vector3());
    expect(pa.distanceTo(pb)).toBeGreaterThan(AGENT.radius * 2 * 0.9);

    // Coincident agents split deterministically.
    const c = s.addAgent({ x: 5, y: 0, z: 5 }, AGENT);
    const d = s.addAgent({ x: 5, y: 0, z: 5 }, AGENT);
    run(s, 60);
    const pc = s.getAgentPosition(c, new Vector3());
    const pd = s.getAgentPosition(d, new Vector3());
    expect(pc.x).toBeLessThan(pd.x);
    expect(pc.distanceTo(pd)).toBeGreaterThan(0.3);
  });

  it('follows the ground probe, or blends to the target height without one', () => {
    const probed = new DirectSteering(2, (x) => x * 0.5);
    const id = probed.addAgent({ x: 0, y: 0, z: 0 }, AGENT);
    probed.setAgentTarget(id, { x: 4, y: 0, z: 0 });
    run(probed, 240);
    const p = probed.getAgentPosition(id, new Vector3());
    expect(p.y).toBeCloseTo(p.x * 0.5, 1);

    const blind = new DirectSteering(2);
    const b = blind.addAgent({ x: 0, y: 0, z: 0 }, AGENT);
    blind.setAgentTarget(b, { x: 6, y: 3, z: 0 });
    run(blind, 30);
    const mid = blind.getAgentPosition(b, new Vector3());
    expect(mid.y).toBeGreaterThan(0);
    expect(mid.y).toBeLessThan(3);
    run(blind, 300);
    // Along the implied 0.5 slope, stopping within the arrive distance of the target.
    const end = blind.getAgentPosition(b, new Vector3());
    expect(end.y).toBeGreaterThan(3 - 0.5 * (NAV.direct.arriveDistance + 0.05));
    expect(end.y).toBeLessThanOrEqual(3 + 1e-6);
  });

  it('stops, re-speeds, teleports, removes and caps capacity', () => {
    const s = new DirectSteering(2);
    const a = s.addAgent({ x: 0, y: 0, z: 0 }, AGENT);
    const b = s.addAgent({ x: 3, y: 0, z: 0 }, AGENT);
    expect(s.addAgent({ x: 0, y: 0, z: 0 }, AGENT)).toBe(-1);
    expect(s.agentCount).toBe(2);

    s.setAgentTarget(a, { x: 0, y: 0, z: 20 });
    run(s, 30);
    s.stopAgent(a);
    run(s, 60);
    expect(s.getAgentVelocity(a, new Vector3()).length()).toBeLessThan(1e-3);

    s.setAgentMaxSpeed(a, 1);
    s.setAgentTarget(a, { x: 0, y: 0, z: 20 });
    run(s, 120);
    expect(s.getAgentVelocity(a, new Vector3()).length()).toBeLessThanOrEqual(1 + 1e-6);

    s.teleportAgent(a, { x: -5, y: 1, z: -5 });
    expect(s.getAgentPosition(a, new Vector3()).toArray()).toEqual([-5, 1, -5]);
    expect(s.getAgentVelocity(a, new Vector3()).length()).toBe(0);

    s.removeAgent(b);
    expect(s.agentCount).toBe(1);
    expect(s.addAgent({ x: 1, y: 0, z: 1 }, AGENT)).toBe(b);
    s.removeAgent(99);
    s.setAgentTarget(-1, { x: 0, y: 0, z: 0 });
    expect(s.agentCount).toBe(2);
    s.dispose();
    expect(s.agentCount).toBe(0);
  });
});
