import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SpawnPointDef } from '../core/contracts';
import { Rng } from '../core/Rng';
import { SPAWN_POINTS, type SpawnPointRules } from '../defs/waves';
import { bandMiss, selectSpawnPoint, spawnPointScore, type SpawnSelectContext } from './spawnPoints';

const R: SpawnPointRules = { ...SPAWN_POINTS, jitter: 0 };

function point(id: string, x: number, z: number, zone = 'main'): SpawnPointDef {
  return { id, position: new Vector3(x, 0, z), yaw: 0, zone, kind: 'rift' };
}

function ctx(over: Partial<SpawnSelectContext> & { visible?: readonly string[]; inactive?: readonly string[] }) {
  const visible = over.visible ?? [];
  const inactive = over.inactive ?? [];
  return {
    target: over.target ?? { x: 0, y: 0, z: 0 },
    lastIndex: over.lastIndex ?? -1,
    isZoneActive: (zone: string) => !inactive.includes(zone),
    isVisible: (p: SpawnPointDef) => visible.includes(p.id),
  } satisfies SpawnSelectContext;
}

describe('spawn point scoring', () => {
  it('scores the preferred distance best, nothing outside the band', () => {
    expect(spawnPointScore(R.preferredDistance, false, R, 0)).toBe(0);
    expect(spawnPointScore(R.preferredDistance + 5, false, R, 0)).toBeCloseTo(-5 * R.distanceWeight);
    expect(spawnPointScore(R.minDistance - 0.1, false, R, 0)).toBe(Number.NEGATIVE_INFINITY);
    expect(spawnPointScore(R.maxDistance + 0.1, false, R, 0)).toBe(Number.NEGATIVE_INFINITY);
    expect(spawnPointScore(R.preferredDistance, true, R, 0)).toBe(-R.visiblePenalty);
    expect(spawnPointScore(R.preferredDistance, false, SPAWN_POINTS, 0.5)).toBeCloseTo(SPAWN_POINTS.jitter / 2);
  });

  it('weighs "too close" more than "too far" outside the band', () => {
    expect(bandMiss(R.preferredDistance, R)).toBe(0);
    expect(bandMiss(R.minDistance - 2, R)).toBeGreaterThan(bandMiss(R.maxDistance + 2, R));
  });
});

describe('spawn point selection', () => {
  const rng = (): Rng => new Rng('spawn-test');

  it('prefers a point out of view over a slightly better placed visible one', () => {
    const pts = [point('seen', 0, -R.preferredDistance), point('hidden', R.preferredDistance + 4, 0)];
    expect(selectSpawnPoint(pts, ctx({ visible: ['seen'] }), R, rng())).toBe(1);
    expect(selectSpawnPoint(pts, ctx({}), R, rng())).toBe(0);
  });

  it('keeps the distance band: never too close or absurdly far while a point in the band exists', () => {
    const pts = [point('close', 2, 0), point('far', 200, 0), point('ok', 0, R.maxDistance - 1)];
    expect(selectSpawnPoint(pts, ctx({}), R, rng())).toBe(2);
  });

  it('never uses the same point twice in a row when another qualifies', () => {
    const pts = [point('a', R.preferredDistance, 0), point('b', 0, R.maxDistance - 2)];
    expect(selectSpawnPoint(pts, ctx({}), R, rng())).toBe(0);
    expect(selectSpawnPoint(pts, ctx({ lastIndex: 0 }), R, rng())).toBe(1);
    // The only point in the band may repeat.
    const single = [point('a', R.preferredDistance, 0), point('near', 1, 0)];
    expect(selectSpawnPoint(single, ctx({ lastIndex: 0 }), R, rng())).toBe(0);
  });

  it('only uses points in active zones', () => {
    const pts = [point('locked', R.preferredDistance, 0, 'lab'), point('open', 0, R.maxDistance - 2)];
    expect(selectSpawnPoint(pts, ctx({ inactive: ['lab'] }), R, rng())).toBe(1);
    expect(selectSpawnPoint(pts, ctx({ inactive: ['lab', 'main'] }), R, rng())).toBe(-1);
    expect(selectSpawnPoint([], ctx({}), R, rng())).toBe(-1);
  });

  it('falls back to the point closest to the band (far beats too close)', () => {
    const pts = [point('close', 3, 0), point('far', R.maxDistance + 10, 0)];
    expect(selectSpawnPoint(pts, ctx({}), R, rng())).toBe(1);
    const pts2 = [point('close', R.minDistance - 1, 0), point('far', R.maxDistance + 30, 0)];
    expect(selectSpawnPoint(pts2, ctx({}), R, rng())).toBe(0);
  });

  it('spreads equally good points with the seeded jitter, reproducibly', () => {
    const pts = [0, 1, 2, 3].map((i) => {
      const a = (i * Math.PI) / 2;
      return point(`p${i}`, Math.cos(a) * R.preferredDistance, Math.sin(a) * R.preferredDistance);
    });
    const pick = (seed: string): number[] => {
      const r = new Rng(seed);
      const out: number[] = [];
      let last = -1;
      for (let i = 0; i < 40; i++) {
        last = selectSpawnPoint(pts, ctx({ lastIndex: last }), SPAWN_POINTS, r);
        out.push(last);
      }
      return out;
    };
    const a = pick('jitter');
    expect(pick('jitter')).toEqual(a);
    expect(new Set(a).size).toBe(4);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
  });
});
