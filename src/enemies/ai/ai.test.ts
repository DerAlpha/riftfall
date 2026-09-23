import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AttackSlotCoordinator, type SlotConfig } from './AttackSlotCoordinator';
import {
  aoeFactor,
  attackAnimProgress,
  distanceToCapsule,
  inFov,
  locomotionBlend,
  meleeHits,
  segmentSegment,
  turnTowards,
  wrapPi,
  yawTo,
} from './attackMath';
import { candidateBearing, inBand, scoreSpot } from './rangedPositioning';
import {
  STUCK_NONE,
  STUCK_REPATH,
  STUCK_TELEPORT,
  resetStuck,
  updateStuck,
  type StuckState,
} from './StuckMonitor';
import { SurroundSlots, slotCost, yawToBearing } from './SurroundSlots';
import { ThreatTable } from './ThreatTable';
import { FakePlayer } from '../testFakes';

const SLOTS: SlotConfig = {
  maxTokens: 3,
  holdTime: 4,
  attacksPerToken: 2,
  minAttackSpacing: 0.3,
  requestTimeout: 0.5,
  rerequestDelay: 1,
};

describe('AttackSlotCoordinator', () => {
  it('grants at most maxTokens units, first come first served', () => {
    const c = new AttackSlotCoordinator(SLOTS, 16);
    const granted = [1, 2, 3, 4, 5].map((id, i) => c.request(id, 1, i * 0.01));
    expect(granted).toEqual([true, true, true, false, false]);
    expect(c.inUse).toBe(3);
    // Waiters keep asking (heartbeat); 4 asked first, so 4 gets the next free token, not 5.
    expect(c.request(4, 1, 0.8)).toBe(false);
    expect(c.request(5, 1, 0.8)).toBe(false);
    c.release(2, 1);
    expect(c.request(5, 1, 1.01)).toBe(false);
    expect(c.request(4, 1, 1.02)).toBe(true);
    expect(c.request(5, 1, 1.03)).toBe(false);
    expect(c.inUse).toBe(3);
  });

  it('big enemies take several units and are not starved by small ones', () => {
    const c = new AttackSlotCoordinator(SLOTS, 16);
    expect(c.request(1, 1, 0)).toBe(true);
    expect(c.request(2, 1, 0)).toBe(true);
    expect(c.request(10, 2, 0.1)).toBe(false); // tank waits: only 1 unit free
    expect(c.request(3, 1, 0.2)).toBe(false); // FIFO: the tank is first in line
    c.release(1, 0.3);
    expect(c.request(10, 2, 0.31)).toBe(true);
    expect(c.inUse).toBe(3);
  });

  it('rotates tokens: hold time and attack count expire them, then a re-request delay', () => {
    const c = new AttackSlotCoordinator(SLOTS, 16);
    expect(c.request(1, 1, 0)).toBe(true);
    c.noteAttack(1, 0.1);
    c.noteAttack(1, 1.1);
    expect(c.request(1, 1, 1.2)).toBe(false); // spent its attacks
    expect(c.holds(1)).toBe(false);
    expect(c.request(1, 1, 1.5)).toBe(false); // must wait rerequestDelay
    expect(c.request(1, 1, 2.3)).toBe(true);
    expect(c.request(1, 1, 2.3 + SLOTS.holdTime + 0.01)).toBe(false); // held too long
  });

  it('spaces attack starts, drops stale waiters and holders, cancel frees immediately', () => {
    const c = new AttackSlotCoordinator(SLOTS, 16);
    c.noteAttack(1, 1);
    expect(c.canStartAttack(1.1)).toBe(false);
    expect(c.canStartAttack(1.31)).toBe(true);
    for (let id = 1; id <= 3; id++) c.request(id, 1, 0);
    expect(c.request(9, 1, 0)).toBe(false);
    expect(c.waiting).toBe(1);
    c.update(SLOTS.requestTimeout + 0.1);
    expect(c.waiting).toBe(0);
    c.update(SLOTS.holdTime * 2 + 1); // holders stopped asking
    expect(c.inUse).toBe(0);
    expect(c.request(5, 1, 20)).toBe(true);
    c.cancel(5);
    expect(c.inUse).toBe(0);
    expect(c.request(5, 1, 20)).toBe(true); // no re-request delay after cancel
  });
});

describe('SurroundSlots', () => {
  const cfg = { slotCount: 8, frontPenalty: 6, occupancyPenalty: 4, distanceWeight: 0.1, hysteresis: 1 };

  it('prefers the back of the target, then spreads over free slots', () => {
    const s = new SurroundSlots(cfg);
    // Enemy yaw convention: yaw 0 faces +Z = bearing π/2.
    expect(yawToBearing(0)).toBeCloseTo(Math.PI / 2, 6);
    // Target at origin facing +Z (bearing π/2): the back is bearing −π/2.
    const best = s.rank(0, -5, -1, 0, 0, Math.PI / 2, 4);
    expect(Math.sin(s.angle(best))).toBeLessThan(-0.9);
    s.claim(best);
    const second = s.rank(0, -5, -1, 0, 0, Math.PI / 2, 4);
    expect(second).not.toBe(best);
    expect(Math.sin(s.angle(second))).toBeLessThan(0);
  });

  it('slot cost: front > side > back, occupants and distance add, hysteresis subtracts', () => {
    const front = slotCost(0, 0, 0, 0, false, cfg);
    const side = slotCost(Math.PI / 2, 0, 0, 0, false, cfg);
    const back = slotCost(Math.PI, 0, 0, 0, false, cfg);
    expect(front).toBeGreaterThan(side);
    expect(side).toBeGreaterThan(back);
    expect(slotCost(Math.PI, 0, 2, 0, false, cfg)).toBeCloseTo(back + 8);
    expect(slotCost(Math.PI, 0, 0, 10, true, cfg)).toBeCloseTo(back + 1 - 1);
  });
});

describe('StuckMonitor', () => {
  const cfg = { interval: 1, minProgress: 0.35, repathAfter: 2, teleportAfter: 4 };
  it('repaths, then teleports when an enemy that wants to move makes no progress', () => {
    const s: StuckState = { ax: 0, az: 0, next: 0, fails: 0 };
    resetStuck(s, 0, 0, 0, cfg);
    const acts: number[] = [];
    for (let t = 1; t <= 4; t++) acts.push(updateStuck(s, 0.05 * t, 0, t, true, cfg));
    expect(acts).toEqual([STUCK_NONE, STUCK_REPATH, STUCK_NONE, STUCK_TELEPORT]);
    expect(updateStuck(s, 5, 0, 5, true, cfg)).toBe(STUCK_NONE);
    expect(s.fails).toBe(0);
  });

  it('ignores idle enemies and checks only once per interval', () => {
    const s: StuckState = { ax: 0, az: 0, next: 0, fails: 0 };
    resetStuck(s, 0, 0, 0, cfg);
    expect(updateStuck(s, 0, 0, 0.5, true, cfg)).toBe(STUCK_NONE);
    for (let t = 1; t <= 6; t++) expect(updateStuck(s, 0, 0, t, false, cfg)).toBe(STUCK_NONE);
  });
});

describe('attackMath', () => {
  const at = new Vector3(0, 0, 0);
  it('melee: reach + cone + height at the strike moment', () => {
    const cone = (120 * Math.PI) / 180;
    // Facing +Z (yaw 0): target 1.5 m ahead.
    expect(meleeHits(at, 0, new Vector3(0, 0, 1.5), 0.38, 1.5, cone, 1)).toBe(true);
    // Out of reach (dashed away).
    expect(meleeHits(at, 0, new Vector3(0, 0, 3), 0.38, 1.5, cone, 1)).toBe(false);
    // Behind.
    expect(meleeHits(at, 0, new Vector3(0, 0, -1.2), 0.38, 1.5, cone, 1)).toBe(false);
    // Above (jumped onto a crate).
    expect(meleeHits(at, 0, new Vector3(0, 1.6, 1.2), 0.38, 1.5, cone, 1)).toBe(false);
    // Overlapping always hits.
    expect(meleeHits(at, 0, new Vector3(0.1, 0, -0.1), 0.38, 1.5, cone, 1)).toBe(true);
  });

  it('AoE falloff, anim progress mapping, yaw helpers', () => {
    expect(aoeFactor(0.5, 1, 4, 0.25)).toBe(1);
    expect(aoeFactor(2.5, 1, 4, 0.25)).toBeCloseTo(0.625);
    expect(aoeFactor(4, 1, 4, 0.25)).toBeCloseTo(0.25);
    expect(aoeFactor(4.01, 1, 4, 0.25)).toBe(0);
    expect(attackAnimProgress(0, 0.5, 1, 0.4, 0.6)).toBeCloseTo(0.2);
    expect(attackAnimProgress(1, 0.1, 0.2, 0.4, 0.6)).toBeCloseTo(0.5);
    expect(attackAnimProgress(2, 1, 1, 0.4, 0.6)).toBeCloseTo(1);
    expect(yawTo(0, 1)).toBeCloseTo(0);
    expect(yawTo(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(turnTowards(0, 1, 0.25)).toBeCloseTo(0.25);
    // Shortest way across ±π.
    expect(turnTowards(3, -3, 0.5)).toBeCloseTo(-3);
    expect(turnTowards(3, -2.5, 0.5)).toBeCloseTo(3.5 - 2 * Math.PI);
    expect(inFov(at, 0, new Vector3(0, 0, 5), Math.PI / 2)).toBe(true);
    expect(inFov(at, 0, new Vector3(5, 0, 0.1), Math.PI / 2)).toBe(false);
    expect(locomotionBlend(0, 2, 6)).toBe(0);
    expect(locomotionBlend(1, 2, 6)).toBeCloseTo(0.5);
    expect(locomotionBlend(4, 2, 6)).toBeCloseTo(1.5);
    expect(locomotionBlend(9, 2, 6)).toBe(2);
  });

  it('segment distances and capsule distance', () => {
    const out = { distSq: 0, s: 0 };
    segmentSegment(
      new Vector3(-1, 1, 0),
      new Vector3(1, 1, 0),
      new Vector3(0, 0, -1),
      new Vector3(0, 0, 1),
      out,
    );
    expect(out.distSq).toBeCloseTo(1);
    expect(out.s).toBeCloseTo(0.5);
    const feet = new Vector3(0, 0, 0);
    const eye = new Vector3(0, 1.62, 0);
    expect(distanceToCapsule(new Vector3(1, 1, 0), feet, eye, 0.4)).toBeCloseTo(0.6);
    // Above the head: 3 − 1.62 − 0.4.
    expect(distanceToCapsule(new Vector3(0, 3, 0), feet, eye, 0.4)).toBeCloseTo(0.98);
  });
});

describe('ThreatTable', () => {
  const cfg = { maxTargets: 3, damageThreat: 1, decay: 0.5, distanceWeight: 0.5 };
  it('picks the living target with the best threat + bias − distance', () => {
    const t = new ThreatTable(cfg);
    const player = new FakePlayer(0, 0, 0);
    const decoy = new FakePlayer(10, 0, 0);
    const ps = t.register(player, 10);
    const ds = t.register(decoy, 0);
    const row = t.createRow();
    const from = new Vector3(8, 0, 0);
    expect(t.select(row, from)).toBe(ps); // bias wins over distance
    t.addDamageThreat(row, ds, 20);
    expect(t.select(row, from)).toBe(ds);
    t.decay(row, 10);
    expect(t.select(row, from)).toBe(ps);
    player.alive = false;
    expect(t.select(row, from)).toBe(ds);
    t.unregister(decoy);
    expect(t.select(row, from)).toBe(-1);
    t.makeNoise({ x: 1, y: 2, z: 3 }, 5, ps);
    expect(t.noise).toMatchObject({ x: 1, y: 2, z: 3, time: 5, target: ps });
  });
});

describe('rangedPositioning', () => {
  const w = { los: 10, cover: 2, travel: 0.25, band: 0.5, crowd: 1 };
  it('sight dominates, then cover, band and travel', () => {
    const base = { los: true, cover: 0, travel: 4, distance: 13, crowd: 0 };
    expect(scoreSpot(base, 13, w)).toBeGreaterThan(scoreSpot({ ...base, los: false }, 13, w));
    expect(scoreSpot({ ...base, cover: 1 }, 13, w)).toBeGreaterThan(scoreSpot(base, 13, w));
    expect(scoreSpot({ ...base, distance: 20 }, 13, w)).toBeLessThan(scoreSpot(base, 13, w));
    expect(scoreSpot({ ...base, travel: 20 }, 13, w)).toBeLessThan(scoreSpot(base, 13, w));
    expect(scoreSpot({ ...base, crowd: 2 }, 13, w)).toBeLessThan(scoreSpot(base, 13, w));
    expect(inBand(10, 8, 21)).toBe(true);
    expect(inBand(7, 8, 21)).toBe(false);
    expect(inBand(7, 8, 21, 1)).toBe(true);
  });

  it('candidate bearings: current first, then alternating and widening', () => {
    const arc = 1;
    const b = [0, 1, 2, 3, 4].map((i) => candidateBearing(0, i, 5, arc));
    expect(b[0]).toBe(0);
    expect(b[1]).toBeCloseTo(0.5);
    expect(b[2]).toBeCloseTo(-0.5);
    expect(b[3]).toBeCloseTo(1);
    expect(b[4]).toBeCloseTo(-1);
  });
});
