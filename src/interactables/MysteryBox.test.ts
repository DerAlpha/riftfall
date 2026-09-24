import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { Rng } from '../core/Rng';
import { MYSTERY_BOX, type BoxPoolEntry } from '../defs/interactables';
import { WEAPONS, type WeaponDef } from '../defs/weapons';
import { MysteryBox, resolveBoxPool, rollRate, type BoxLocation } from './MysteryBox';
import { FakeEconomy, FakeWeapons } from './testFakes';

const DT = 1 / 60;
const B = MYSTERY_BOX;

class FakeBlocker {
  blocked = false;
  history: boolean[] = [];
  setBlocked(b: boolean): void {
    this.blocked = b;
    this.history.push(b);
  }
}

function location(id: string, x: number): BoxLocation & { blocker: FakeBlocker } {
  return {
    id,
    zone: id,
    position: new Vector3(x, 0, 0),
    yaw: 0,
    anchor: new Vector3(x, 1, 0.7),
    halfX: 0.75,
    halfZ: 0.39,
    blocker: new FakeBlocker(),
  };
}

function setup(opts: { points?: number; locations?: number; carried?: string[]; seed?: string } = {}) {
  const events = new EventBus<GameEvents>();
  const log: string[] = [];
  let resolved: string | null | undefined;
  let moved: { from: string; to: string } | null = null;
  events.on('box:opened', () => log.push('opened'));
  events.on('box:resolved', (p) => {
    resolved = p.weaponId;
    log.push(`resolved:${p.weaponId}`);
  });
  events.on('box:moved', (p) => {
    moved = { from: p.from, to: p.to };
    log.push('moved');
  });
  const economy = new FakeEconomy(opts.points ?? 5000);
  const weapons = new FakeWeapons(opts.carried ?? ['pistol']);
  const locations = Array.from({ length: opts.locations ?? 3 }, (_, i) => location(`loc${i}`, i * 10));
  const player = { position: new Vector3(0, 0, 5), radius: 0.4 };
  const box = new MysteryBox({
    events,
    economy,
    weapons,
    price: 950,
    rng: new Rng(opts.seed ?? 'box-test'),
    locations,
    startLocations: [0],
    pool: resolveBoxPool(),
    weaponName: (id) => WEAPONS[id as keyof typeof WEAPONS]?.name ?? id,
    player,
  });
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds - 1e-9; t += DT) box.fixedUpdate(DT);
  };
  return {
    box,
    economy,
    weapons,
    locations,
    player,
    log,
    run,
    resolved: () => resolved,
    moved: () => moved,
  };
}

describe('mystery box roll curve and pool', () => {
  it('accelerates, peaks, then slows onto the result', () => {
    const r = B.roll;
    expect(rollRate(0)).toBeCloseTo(r.startRate);
    expect(rollRate(r.peakAt)).toBeCloseTo(r.peakRate);
    expect(rollRate(1)).toBeCloseTo(r.endRate);
    expect(rollRate(r.peakAt / 2)).toBeGreaterThan(r.startRate);
    expect(rollRate(0.8)).toBeLessThan(rollRate(0.5));
  });

  it('keeps known, implemented weapons and adds box-only weapons', () => {
    const base = resolveBoxPool();
    expect(base.map((e) => e.weapon).sort()).toEqual(['pistol', 'rifle', 'shotgun']);
    const wonder = { ...WEAPONS.rifle, id: 'riftcannon', boxOnly: true } as WeaponDef;
    const launcher = { ...WEAPONS.rifle, id: 'launcher', kind: 'projectile' } as WeaponDef;
    const defs: Record<string, WeaponDef> = { ...WEAPONS, riftcannon: wonder, launcher };
    const entries: BoxPoolEntry[] = [
      { weapon: 'rifle', weight: 2 },
      { weapon: 'ghost', weight: 5 },
      { weapon: 'launcher', weight: 1 },
      { weapon: 'shotgun', weight: 0 },
    ];
    const pool = resolveBoxPool(entries, (id) => defs[id], Object.keys(defs), 4);
    expect(pool).toEqual([
      { weapon: 'rifle', weight: 2 },
      { weapon: 'riftcannon', weight: 4 },
    ]);
  });
});

describe('MysteryBox', () => {
  it('starts idle at a start location with its collider in place', () => {
    const t = setup();
    expect(t.box.state).toBe('idle');
    expect(t.box.location.id).toBe('loc0');
    expect(t.locations[0]!.blocker.blocked).toBe(true);
    expect(t.locations[1]!.blocker.blocked).toBe(false);
    expect(t.box.prompt()).toBe(B.prompts.open);
    expect(t.box.cost()).toBe(950);
    expect(t.box.position).toBe(t.locations[0]!.anchor);
  });

  it('refuses without points', () => {
    const t = setup({ points: 100 });
    t.box.interact();
    expect(t.box.state).toBe('idle');
    expect(t.log).toEqual([]);
  });

  it('rolls, cycles the display, resolves and hands out the weapon', () => {
    const t = setup();
    t.box.interact();
    expect(t.economy.spent).toEqual([{ cost: 950, item: 'rift_box', kind: 'box' }]);
    expect(t.box.state).toBe('rolling');
    expect(t.box.prompt()).toBe('');
    expect(t.box.canInteract()).toBe(false);
    const seen = new Set<string | null>();
    for (let i = 0; i < 60; i++) {
      t.box.fixedUpdate(DT);
      seen.add(t.box.displayWeapon);
    }
    expect(seen.size).toBeGreaterThan(1);
    t.run(B.rollDuration);
    expect(t.box.state).toBe('offering');
    const w = t.resolved();
    expect(typeof w).toBe('string');
    // Carried weapons are excluded.
    expect(w).not.toBe('pistol');
    expect(t.box.displayWeapon).toBe(w);
    expect(t.box.offeredWeapon).toBe(w);
    expect(t.box.cost()).toBeNull();
    expect(t.box.prompt()).toContain(WEAPONS[w as keyof typeof WEAPONS].name);
    t.box.interact();
    expect(t.weapons.given).toEqual([w]);
    expect(t.box.state).toBe('closing');
    t.run(B.closeDuration + 0.05);
    expect(t.box.state).toBe('idle');
  });

  it('the offer lapses after offerDuration: the weapon sinks back', () => {
    const t = setup();
    t.box.purchase();
    t.run(B.rollDuration + 0.05);
    expect(t.box.state).toBe('offering');
    t.run(B.offerDuration + 0.05);
    expect(t.box.state).toBe('closing');
    expect(t.box.displayWeapon).toBeNull();
    t.run(B.closeDuration + 0.05);
    expect(t.box.state).toBe('idle');
    expect(t.weapons.given).toEqual([]);
  });

  it('reveals the anomaly after the use threshold, refunds and relocates', () => {
    const t = setup({ points: 100000 });
    let moves = 0;
    let rolls = 0;
    // Keep rolling until the anomaly appears (threshold in [min, max], then anomalyChance per roll).
    while (t.moved() === null && rolls < 60) {
      rolls++;
      expect(t.box.purchase()).toBe(true);
      t.run(B.rollDuration + 0.05);
      if (t.box.state === 'anomaly') {
        expect(t.resolved()).toBeNull();
        expect(rolls).toBeGreaterThanOrEqual(B.moveAfterUses.min);
        expect(t.economy.earned.at(-1)).toEqual({ amount: 950, reason: 'refund' });
        expect(t.box.prompt()).toBe('');
        t.run(B.anomalyDuration + 0.05);
        expect(t.box.state).toBe('leaving');
        t.run(B.leaveDuration + 0.05);
        moves++;
        break;
      }
      t.box.take();
      t.run(B.closeDuration + 0.05);
    }
    expect(moves).toBe(1);
    const m = t.moved()!;
    expect(m.from).toBe('loc0');
    expect(m.to).not.toBe('loc0');
    expect(t.box.state).toBe('arriving');
    expect(t.box.location.id).toBe(m.to);
    expect(t.box.usesHere).toBe(0);
    expect(t.box.moveThreshold).toBeGreaterThanOrEqual(B.moveAfterUses.min);
    expect(t.box.moveThreshold).toBeLessThanOrEqual(B.moveAfterUses.max);
    // Colliders follow the box.
    expect(t.locations[0]!.blocker.blocked).toBe(false);
    expect(t.locations.find((l) => l.id === m.to)!.blocker.blocked).toBe(true);
    t.run(B.arriveDuration + 0.05);
    expect(t.box.state).toBe('idle');
    expect(t.box.prompt()).toBe(B.prompts.open);
  });

  it('forced anomaly (dev) moves at once; a single location never shows the anomaly', () => {
    const t = setup();
    t.box.roll(true);
    t.run(B.rollDuration + 0.05);
    expect(t.box.state).toBe('anomaly');
    expect(t.economy.earned).toEqual([{ amount: 950, reason: 'refund' }]);

    const single = setup({ locations: 1 });
    for (let i = 0; i < 12; i++) {
      single.box.roll(true);
      single.run(B.rollDuration + 0.05);
      expect(single.box.state).toBe('offering');
      single.box.take();
      single.run(B.closeDuration + 0.05);
    }
    expect(single.box.move()).toBe(false);
  });

  it('waits with the collider while the player stands on the new location', () => {
    const t = setup({ locations: 2 });
    // Player on location 1.
    t.player.position.set(10, 0, 0.2);
    expect(t.box.move()).toBe(true);
    t.run(B.leaveDuration + 0.05);
    expect(t.box.location.id).toBe('loc1');
    expect(t.locations[1]!.blocker.blocked).toBe(false);
    t.run(0.5);
    expect(t.locations[1]!.blocker.blocked).toBe(false);
    t.player.position.set(10, 0, 3);
    t.box.fixedUpdate(DT);
    expect(t.locations[1]!.blocker.blocked).toBe(true);
  });

  it('is deterministic for a seed and resets to a start location', () => {
    const results = (seed: string): (string | null)[] => {
      const t = setup({ seed, points: 1e6 });
      const out: (string | null)[] = [];
      for (let i = 0; i < 6; i++) {
        t.box.purchase();
        t.run(B.rollDuration + 0.05);
        out.push(t.box.offeredWeapon);
        if (t.box.state === 'offering') t.box.take();
        t.run(10);
      }
      return out;
    };
    expect(results('seed-a')).toEqual(results('seed-a'));

    // reset(seed) replays a run.
    const replay = setup({ points: 1e6 });
    const run = (): (string | null)[] => {
      const out: (string | null)[] = [];
      for (let i = 0; i < 5; i++) {
        replay.box.purchase();
        replay.run(B.rollDuration + 0.05);
        out.push(replay.box.offeredWeapon);
        if (replay.box.state === 'offering') replay.box.take();
        replay.run(10);
      }
      return out;
    };
    replay.box.reset('run-1');
    const first = run();
    replay.weapons.carried.splice(1);
    replay.box.reset('run-1');
    expect(run()).toEqual(first);

    const t = setup();
    t.box.move();
    t.run(B.leaveDuration + B.arriveDuration + 0.1);
    expect(t.box.location.id).not.toBe('loc0');
    t.box.reset();
    expect(t.box.location.id).toBe('loc0');
    expect(t.box.state).toBe('idle');
    expect(t.locations.filter((l) => l.blocker.blocked).map((l) => l.id)).toEqual(['loc0']);
  });
});
