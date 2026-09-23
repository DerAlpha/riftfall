import { describe, expect, it } from 'vitest';
import { QUALITY_LEVELS } from '../defs/graphics';
import { VFX, casingCapacity, decalCapacity } from '../defs/vfx';
import { CasingSim, createCasingSpawn, flatRestQuat, integrateQuat } from './CasingSim';
import { DecalRing, type DecalAllocation } from './DecalRing';
import { LightSlots, flashEnvelope } from './LightPool';
import { tracerSegment, tracerTravelTime, type TracerSegment } from './TracerSystem';

const alloc = (): DecalAllocation => ({ slot: -1, fadeSlot: -1 });

describe('DecalRing', () => {
  it('fills slots in order, then overwrites the oldest', () => {
    const ring = new DecalRing(4);
    const a = alloc();
    const slots: number[] = [];
    for (let i = 0; i < 6; i++) slots.push(ring.allocate(a)!.slot);
    expect(slots).toEqual([0, 1, 2, 3, 0, 1]);
    expect(ring.count).toBe(4);
    expect(ring.drawCount).toBe(4);
  });

  it('starts fading the decal that will be overwritten fadeAhead spawns later', () => {
    const ring = new DecalRing(10, 10, 3);
    const a = alloc();
    const fades: number[] = [];
    for (let i = 0; i < 14; i++) fades.push(ring.allocate(a)!.fadeSlot);
    // Before slot 7 the slot 3 ahead is still empty.
    expect(fades.slice(0, 7)).toEqual([-1, -1, -1, -1, -1, -1, -1]);
    // Slot 7 fades slot 0 (overwritten by the 11th allocation), and so on around the ring.
    expect(fades.slice(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('clamps and clears on capacity changes', () => {
    const ring = new DecalRing(8, 20);
    expect(ring.capacity).toBe(8);
    const a = alloc();
    ring.allocate(a);
    ring.setCapacity(3);
    expect(ring.count).toBe(0);
    ring.setCapacity(0);
    expect(ring.allocate(a)).toBeNull();
  });

  it('capacity follows the particle quality with a floor', () => {
    expect(decalCapacity('high')).toBe(
      Math.round(VFX.decals.capacity * QUALITY_LEVELS.particles.high.budgetMultiplier),
    );
    expect(decalCapacity('off')).toBe(Math.round(VFX.decals.capacity * VFX.decals.minScale));
    expect(decalCapacity('ultra')).toBeGreaterThan(decalCapacity('low'));
    expect(casingCapacity('off')).toBeGreaterThan(0);
  });
});

describe('LightSlots', () => {
  it('decays with a quadratic envelope', () => {
    expect(flashEnvelope(0)).toBe(1);
    expect(flashEnvelope(0.5)).toBeCloseTo(0.25, 6);
    expect(flashEnvelope(1)).toBe(0);
    expect(flashEnvelope(Number.NaN)).toBe(0);
  });

  it('shows a new flash at full peak for its first frame, then decays to dark', () => {
    // Started in a tick (before the frame's update).
    const s = new LightSlots(2, 1);
    const slot = s.acquire(1, 100);
    s.start(slot, 100, 0.05, 1, 0, 0);
    s.update(0.016, 30);
    s.endFrame();
    expect(s.intensity[slot]).toBe(100);
    s.update(0.016, 30);
    s.endFrame();
    expect(s.intensity[slot]).toBeLessThan(100);
    for (let i = 0; i < 5; i++) {
      s.update(0.016, 30);
      s.endFrame();
    }
    expect(s.intensity[slot]).toBe(0);
    expect(s.active).toBe(0);
  });

  it('holds a flash started after the update (muzzle) for exactly one frame too', () => {
    const s = new LightSlots(2, 1);
    s.update(0.016, 30);
    const slot = s.acquire(1, 100);
    s.start(slot, 100, 0.05, 1, 0, 0);
    s.endFrame();
    expect(s.intensity[slot]).toBe(100); // this frame: peak
    s.update(0.016, 30);
    s.endFrame();
    expect(s.intensity[slot]).toBeCloseTo(100 * (1 - 0.016 / 0.05) ** 2, 3); // next frame: decaying
  });

  it('never steals from higher priorities and caps low-priority flashes per frame', () => {
    const s = new LightSlots(2, 1);
    s.start(s.acquire(2, 500), 500, 1, 2, 0, 0);
    s.start(s.acquire(2, 500), 500, 1, 2, 0, 0);
    expect(s.acquire(1, 1000)).toBe(-1); // both taken by explosions
    const t = new LightSlots(3, 1);
    expect(t.acquire(0, 5)).toBeGreaterThanOrEqual(0);
    expect(t.acquire(0, 5)).toBe(-1); // one impact light per frame
    t.endFrame();
    t.update(0.016, 30);
    expect(t.acquire(0, 5)).toBeGreaterThanOrEqual(0);
  });

  it('steals the dimmest light of lower or equal priority', () => {
    const s = new LightSlots(2, 1);
    const a = s.acquire(1, 50);
    s.start(a, 50, 1, 1, 0, 0);
    const b = s.acquire(1, 80);
    s.start(b, 80, 1, 1, 0, 0);
    expect(s.acquire(1, 100)).toBe(a);
    expect(s.acquire(1, 10)).toBe(-1); // brighter lights are kept
  });
});

describe('CasingSim', () => {
  const params = {
    gravity: 16,
    life: 1,
    fadeTime: 0.25,
    settleSpeed: 0.3,
    settleTime: 0.1,
    spinDamping: 0.5,
    maxFlightTime: 3,
  };

  function eject(sim: CasingSim, floorY = 0): number {
    const s = createCasingSpawn();
    s.y = 1.2;
    s.vx = 2;
    s.vy = 1;
    s.wx = 20;
    s.floorY = floorY;
    s.radius = 0.005;
    s.bounce = 0.4;
    s.friction = 0.5;
    return sim.spawn(s);
  }

  it('falls, bounces with clinks, settles flat and disappears after its life', () => {
    const sim = new CasingSim(4, params);
    const i = eject(sim);
    const bounces: number[] = [];
    let t = 0;
    while (sim.rest[i]! < 0 && t < 3) {
      sim.update(1 / 60, (b) => bounces.push(b.impactSpeed));
      t += 1 / 60;
      expect(sim.py[i]).toBeGreaterThanOrEqual(0.005 - 1e-6);
    }
    expect(sim.rest[i]).toBeGreaterThanOrEqual(0);
    expect(bounces.length).toBeGreaterThan(0);
    expect(bounces[0]).toBeGreaterThan(3);
    // Settles flat: local +Y (long axis) ends horizontal.
    for (let k = 0; k < 10; k++) sim.update(1 / 60);
    const q = sim.q;
    const ay = 1 - 2 * (q[i * 4]! ** 2 + q[i * 4 + 2]! ** 2);
    expect(Math.abs(ay)).toBeLessThan(1e-3);
    expect(sim.scaleOf(i)).toBe(1);
    for (let k = 0; k < 60; k++) sim.update(1 / 60);
    expect(sim.alive[i]).toBe(0);
    expect(sim.count).toBe(0);
  });

  it('bounces off a probed wall plane', () => {
    const sim = new CasingSim(2, params);
    const i = eject(sim, -10);
    sim.setWall(i, 1, 0, 0, -1, 0, 0); // wall at x = 1 facing −X
    for (let k = 0; k < 60; k++) sim.update(1 / 60);
    expect(sim.px[i]).toBeLessThanOrEqual(1 - 0.005 + 1e-6);
  });

  it('reuses the oldest casing when full and honours the limit', () => {
    const sim = new CasingSim(3, params);
    const a = eject(sim);
    eject(sim);
    eject(sim);
    expect(sim.count).toBe(3);
    expect(eject(sim)).toBe(a);
    expect(sim.count).toBe(3);
    sim.setLimit(1);
    expect(sim.count).toBeLessThanOrEqual(1);
    sim.setLimit(0);
    expect(eject(sim)).toBe(-1);
  });

  it('removes casings that never land', () => {
    const sim = new CasingSim(1, params);
    const i = eject(sim, Number.NEGATIVE_INFINITY);
    for (let k = 0; k < 60 * 4; k++) sim.update(1 / 60);
    expect(sim.alive[i]).toBe(0);
  });

  it('keeps orientation quaternions normalized', () => {
    const q = new Float32Array([0, 0, 0, 1]);
    for (let k = 0; k < 500; k++) integrateQuat(q, 0, 13, -7, 21, 1 / 60);
    expect(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)).toBeCloseTo(1, 5);
    const flat = new Float32Array(4);
    flatRestQuat(q, 0, flat);
    const ay = 1 - 2 * (flat[0]! ** 2 + flat[2]! ** 2);
    expect(Math.abs(ay)).toBeLessThan(1e-6);
  });
});

describe('tracers', () => {
  const seg: TracerSegment = { head: 0, tail: 0, alpha: 0 };

  it('clamps travel time', () => {
    expect(tracerTravelTime(1)).toBe(VFX.tracers.minTravel);
    expect(tracerTravelTime(10_000)).toBe(VFX.tracers.maxTravel);
  });

  it('moves the head to the target, then the tail catches up', () => {
    const travel = 0.05;
    const fade = 0.03;
    expect(tracerSegment(0.025, travel, fade, 20, 4, seg)).toBe(true);
    expect(seg.head).toBeCloseTo(10, 5);
    expect(seg.tail).toBeCloseTo(6, 5);
    expect(tracerSegment(0.05, travel, fade, 20, 4, seg)).toBe(true);
    expect(seg.head).toBeCloseTo(20, 5);
    expect(tracerSegment(0.065, travel, fade, 20, 4, seg)).toBe(true);
    expect(seg.tail).toBeGreaterThan(16);
    expect(seg.alpha).toBeLessThan(1);
    expect(tracerSegment(0.09, travel, fade, 20, 4, seg)).toBe(false);
    // Short shots: the tail never starts behind the muzzle.
    tracerSegment(0.01, travel, fade, 2, 4, seg);
    expect(seg.tail).toBe(0);
  });
});
