/** Test helpers for the progression package (not part of the game build graph). */
import type { ProfileData } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { createDefaultProfile } from '../save/defaults';
import { ProgressionSystem, type ProgressionDeps, type ProgressionScheduler } from './ProgressionSystem';

/** Manual scheduler: `run()` fires every pending callback. */
export class ManualScheduler implements ProgressionScheduler {
  readonly pending = new Map<number, () => void>();
  private next = 1;

  schedule(fn: () => void): unknown {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  run(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

export interface Harness {
  events: EventBus<GameEvents>;
  profile: ProfileData;
  system: ProgressionSystem;
  scheduler: ManualScheduler;
  saves: { count: number };
  clock: { t: number };
  now: { t: number };
  refunds: number[];
}

/** 2026-09-24 12:00 UTC (a Thursday). */
export const TEST_NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

export function createHarness(opts: Partial<ProgressionDeps> & { profile?: ProfileData } = {}): Harness {
  const events = new EventBus<GameEvents>();
  const profile = opts.profile ?? createDefaultProfile(TEST_NOW);
  const scheduler = new ManualScheduler();
  const saves = { count: 0 };
  const clock = { t: 100 };
  const now = { t: TEST_NOW };
  const refunds: number[] = [];
  const system = new ProgressionSystem({
    events,
    profile,
    save: () => {
      saves.count++;
    },
    scheduler,
    now: () => now.t,
    clock: () => clock.t,
    refund: (n) => refunds.push(n),
    ...opts,
  });
  return { events, profile, system, scheduler, saves, clock, now, refunds };
}

let nextEnemyId = 1;

/** Emit a player kill the way the game does: combat:damage (killed) → combat:kill → enemy:died. */
export function killEnemy(
  events: EventBus<GameEvents>,
  opts: {
    type?: string;
    weaponId?: string | null;
    zone?: HitZone | null;
    elite?: boolean;
    element?: GameEvents['combat:damage']['element'];
    kind?: GameEvents['combat:damage']['kind'];
    id?: number;
  } = {},
): number {
  const id = opts.id ?? nextEnemyId++;
  const weaponId = opts.weaponId === undefined ? 'rifle' : opts.weaponId;
  const zone = opts.zone === undefined ? 'body' : opts.zone;
  const p = { x: 0, y: 0, z: 0 };
  events.emit('combat:damage', {
    targetId: id,
    amount: 50,
    zone: zone ?? 'body',
    point: p,
    killed: true,
    weaponId: weaponId ?? 'nuke',
    element: opts.element ?? 'physical',
    source: 'player',
    kind: opts.kind ?? 'bullet',
  });
  events.emit('enemy:died', {
    id,
    type: opts.type ?? 'swarmer',
    position: p,
    weaponId,
    zone,
    elite: opts.elite ?? false,
    source: 'player',
  });
  return id;
}

export function fire(events: EventBus<GameEvents>, weaponId = 'rifle'): void {
  const v = { x: 0, y: 0, z: 0 };
  events.emit('weapon:fired', {
    weaponId,
    origin: v,
    direction: v,
    muzzle: v,
    shotIndex: 0,
    ammoInMag: 10,
    ads: false,
  });
}

export function hit(events: EventBus<GameEvents>, weaponId = 'rifle', targetId = 999): void {
  events.emit('combat:damage', {
    targetId,
    amount: 10,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    killed: false,
    weaponId,
    element: 'physical',
    source: 'player',
    kind: 'bullet',
  });
}

export function runOver(events: EventBus<GameEvents>, over: Partial<GameEvents['run:over']> = {}): void {
  events.emit('run:over', {
    mapId: 'lab',
    mode: 'classic',
    wave: 5,
    kills: 10,
    headshots: 2,
    shotsFired: 20,
    shotsHit: 10,
    timeSurvived: 300,
    score: 1000,
    ...over,
  });
}

export function beginLabRun(system: ProgressionSystem, ranked = true): void {
  system.beginRun({ mapId: 'lab', mode: 'classic', seed: null, ranked });
}
