import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './EventBus';
import { GameLoop } from './GameLoop';
import { Rng, dailySeed } from './Rng';
import { Pool } from './Pool';
import { RingBuffer, angleDelta, clamp, damp, springStep, wrapAngle } from './math';

describe('EventBus', () => {
  interface Ev {
    a: { n: number };
    b: Record<string, never>;
  }
  it('delivers payloads and unsubscribes', () => {
    const bus = new EventBus<Ev>();
    const seen: number[] = [];
    const off = bus.on('a', (p) => seen.push(p.n));
    bus.emit('a', { n: 1 });
    off();
    bus.emit('a', { n: 2 });
    expect(seen).toEqual([1]);
    expect(bus.listenerCount('a')).toBe(0);
  });
  it('once fires a single time', () => {
    const bus = new EventBus<Ev>();
    const fn = vi.fn();
    bus.once('b', fn);
    bus.emit('b', {});
    bus.emit('b', {});
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('isolates throwing handlers', () => {
    const bus = new EventBus<Ev>();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = vi.fn();
    bus.on('a', () => {
      throw new Error('boom');
    });
    bus.on('a', fn);
    bus.emit('a', { n: 1 });
    expect(fn).toHaveBeenCalled();
    err.mockRestore();
  });
  it('tolerates unsubscribe during emit', () => {
    const bus = new EventBus<Ev>();
    const calls: string[] = [];
    const offA = bus.on('a', () => {
      calls.push('first');
      offA();
    });
    bus.on('a', () => calls.push('second'));
    bus.emit('a', { n: 0 });
    bus.emit('a', { n: 0 });
    expect(calls).toEqual(['first', 'second', 'second']);
  });
});

describe('GameLoop', () => {
  const make = () => {
    const ticks: number[] = [];
    const alphas: number[] = [];
    const loop = new GameLoop(
      {
        fixedUpdate: (dt) => ticks.push(dt),
        update: (_dt, alpha) => alphas.push(alpha),
        render: () => {},
      },
      { tickRate: 60, maxSubSteps: 5, maxFrameDelta: 0.25 },
    );
    return { loop, ticks, alphas };
  };

  it('runs fixed ticks proportional to elapsed time', () => {
    const { loop, ticks } = make();
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(ticks.length).toBeGreaterThanOrEqual(59);
    expect(ticks.length).toBeLessThanOrEqual(60);
    expect(ticks.every((dt) => Math.abs(dt - 1 / 60) < 1e-12)).toBe(true);
  });

  it('interpolation alpha stays in [0,1)', () => {
    const { loop, alphas } = make();
    for (let i = 0; i < 100; i++) loop.advance(0.007 + (i % 3) * 0.004);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  });

  it('clamps sub steps and records dropped ticks', () => {
    const { loop, ticks } = make();
    loop.advance(10); // clamped to 0.25s => 15 ticks wanted, 5 allowed
    expect(ticks.length).toBe(5);
    expect(loop.stats.droppedTicks).toBe(10);
  });

  it('respects timeScale and pause', () => {
    const { loop, ticks } = make();
    loop.timeScale = 0.5;
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(ticks.length).toBeGreaterThanOrEqual(29);
    expect(ticks.length).toBeLessThanOrEqual(30);
    loop.paused = true;
    const before = ticks.length;
    loop.advance(0.1);
    expect(ticks.length).toBe(before);
  });
});

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng('seed');
    const b = new Rng('seed');
    const c = new Rng('other');
    const sa = Array.from({ length: 16 }, () => a.nextUint32());
    const sb = Array.from({ length: 16 }, () => b.nextUint32());
    const sc = Array.from({ length: 16 }, () => c.nextUint32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });
  it('produces values in range with a sane distribution', () => {
    const r = new Rng(42);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) expect(Math.abs(b - 2000)).toBeLessThan(250);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });
  it('state can be saved and restored', () => {
    const r = new Rng('x');
    r.next();
    const s = r.getState();
    const v1 = [r.next(), r.next()];
    r.setState(s);
    expect([r.next(), r.next()]).toEqual(v1);
  });
  it('daily seed is stable per UTC day', () => {
    expect(dailySeed(new Date(Date.UTC(2026, 8, 23, 23, 59)))).toBe('riftfall-daily-2026-09-23');
  });
  it('weighted respects zero weights', () => {
    const r = new Rng(1);
    for (let i = 0; i < 200; i++) expect(r.weighted(['a', 'b'], (x) => (x === 'a' ? 0 : 1))).toBe('b');
  });
});

describe('Pool', () => {
  it('reuses released objects', () => {
    let created = 0;
    const pool = new Pool({ create: () => ({ id: created++ }) });
    const a = pool.acquire()!;
    pool.release(a);
    const b = pool.acquire()!;
    expect(b).toBe(a);
    expect(created).toBe(1);
  });
  it('recycles the oldest when full', () => {
    let created = 0;
    const released: number[] = [];
    const pool = new Pool({
      create: () => ({ id: created++ }),
      maxSize: 2,
      recycleOldest: true,
      onRelease: (o) => released.push(o.id),
    });
    const a = pool.acquire()!;
    pool.acquire();
    const c = pool.acquire()!;
    expect(c).toBe(a);
    expect(released).toEqual([0]);
    expect(pool.activeCount).toBe(2);
  });
  it('returns null when full without recycling', () => {
    const pool = new Pool({ create: () => ({}), maxSize: 1 });
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).toBeNull();
  });
  it('forEachActive can release items', () => {
    const pool = new Pool({ create: () => ({ dead: false }), initialSize: 3 });
    const items = [pool.acquire()!, pool.acquire()!, pool.acquire()!];
    items[1]!.dead = true;
    pool.forEachActive((o) => o.dead);
    expect(pool.activeCount).toBe(2);
    expect(pool.freeCount).toBe(1);
  });
});

describe('math', () => {
  it('clamp/wrap/angleDelta', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });
  it('damp is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 1, 5, 1 / 60);
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 1, 5, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
  });
  it('spring settles at target', () => {
    const s = { value: 0, velocity: 0 };
    for (let i = 0; i < 600; i++) springStep(s, 1, 180, 18, 1 / 120);
    expect(s.value).toBeCloseTo(1, 3);
  });
  it('ring buffer order and stats', () => {
    const r = new RingBuffer(3);
    [1, 2, 3, 4].forEach((v) => r.push(v));
    expect([r.get(0), r.get(1), r.get(2)]).toEqual([2, 3, 4]);
    expect(r.average()).toBe(3);
    expect(r.max()).toBe(4);
  });
});
