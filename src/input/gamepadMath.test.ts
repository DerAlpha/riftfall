import { describe, expect, it } from 'vitest';
import { axisDeflection, clampLength1, shapeStick } from './gamepadMath';
import { MouseSpikeFilter } from './MouseSpikeFilter';

describe('shapeStick', () => {
  const out = { x: 0, y: 0 };

  it('zeros input inside the radial deadzone', () => {
    shapeStick(0.1, 0.1, 0.15, 0.04, 1, out);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('rescales so the output starts at 0 at the deadzone edge and reaches 1 at the outer deadzone', () => {
    shapeStick(0.16, 0, 0.15, 0.04, 1, out);
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(0.02);
    shapeStick(0.97, 0, 0.15, 0.04, 1, out);
    expect(out.x).toBeCloseTo(1, 5);
  });

  it('keeps the direction and applies the response curve', () => {
    shapeStick(0, -0.55, 0.15, 0.05, 2, out);
    expect(out.x).toBe(0);
    expect(out.y).toBeCloseTo(-0.25, 3);
  });

  it('is radial (diagonals are not boosted)', () => {
    shapeStick(0.7071, 0.7071, 0.1, 0, 1, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 3);
  });
});

describe('axisDeflection / clampLength1', () => {
  it('maps a signed axis to 0..1 in the bound direction', () => {
    expect(axisDeflection(-1, -1, 0.15, 0.04)).toBe(1);
    expect(axisDeflection(-1, 1, 0.15, 0.04)).toBe(0);
    expect(axisDeflection(0.1, 1, 0.15, 0.04)).toBe(0);
  });

  it('clamps vectors longer than 1', () => {
    const v = clampLength1({ x: 1, y: 1 });
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
    expect(clampLength1({ x: 0.3, y: 0.4 })).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe('MouseSpikeFilter', () => {
  const cfg = {
    lockSettleMs: 50,
    skipEventsAfterLock: 1,
    spikeMinCounts: 600,
    spikeRatio: 10,
    spikeEmaAlpha: 0.25,
    maxConsecutiveSpikes: 1,
  };

  it('drops the first event(s) after locking', () => {
    const f = new MouseSpikeFilter(cfg);
    f.onLock(1000);
    expect(f.accept(900, 400, 1001)).toBe(false);
    expect(f.accept(2, 1, 1020)).toBe(false); // still inside the settle window
    expect(f.accept(2, 1, 1060)).toBe(true);
  });

  it('drops an isolated spike but accepts a sustained fast movement', () => {
    const f = new MouseSpikeFilter(cfg);
    f.onLock(0);
    f.accept(0, 0, 100);
    for (let i = 0; i < 10; i++) expect(f.accept(5, 2, 200 + i)).toBe(true);
    expect(f.accept(-1400, 30, 300)).toBe(false);
    expect(f.accept(4, 2, 301)).toBe(true);
    // Two large events in a row: the second is accepted.
    expect(f.accept(900, 0, 302)).toBe(false);
    expect(f.accept(900, 0, 303)).toBe(true);
    expect(f.droppedEvents).toBe(3);
  });
});
