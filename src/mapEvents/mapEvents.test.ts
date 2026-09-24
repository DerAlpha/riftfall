import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { EnemySpawnOptions, Interactable, SpawnPointDef } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { GRAVITY, INVASION, MAP_EVENT_DEFS, POWER, type MapEventDef } from '../defs/mapEvents';
import { GravityZones } from '../maps/kit/GravityZones';
import { PowerGrid } from '../maps/kit/PowerGrid';
import { createEventCommands } from './eventCommands';
import { MapEventDirector } from './MapEventDirector';

const DT = 1 / 60;

const OUTAGE: MapEventDef = {
  id: 'blackout',
  kind: 'powerOutage',
  trigger: { minWave: 3, chance: 0, waves: [4], cooldownWaves: 2, delay: [1, 1] },
};
const INV: MapEventDef = {
  id: 'invasion',
  kind: 'invasion',
  trigger: { minWave: 1, chance: 0, cooldownWaves: 0, delay: [0, 0], questStep: 'defend' },
  count: { base: 4, perWave: 1, max: 6 },
  types: [
    { type: 'swarmer', weight: 1 },
    { type: 'tank', weight: 5, minWave: 50 },
  ],
  spread: 2,
};
const ANOMALY: MapEventDef = {
  id: 'anomaly',
  kind: 'gravityAnomaly',
  trigger: { minWave: 2, chance: 1, cooldownWaves: 5, delay: [0.5, 0.5] },
  points: [
    { position: [30, 0, 0], zone: 'closed' },
    { position: [5, 0, 5], zone: 'open' },
  ],
  radius: 6,
  scale: 0.3,
  duration: 4,
};

function rig(defs: readonly MapEventDef[]) {
  const events = new EventBus<GameEvents>();
  const power = new PowerGrid({ events });
  const gravity = new GravityZones();
  const spawned: { type: string; position: Vec3Like; point: string | undefined }[] = [];
  const registered: Interactable[] = [];
  const waves = { wave: 1, state: 'active', plan: { health: 2, speed: 1.1, damage: 1.3 } };
  const open = new Set(['open']);
  const log: string[] = [];
  events.on('mapEvent:started', (e) => log.push(`start:${e.eventId}`));
  events.on('mapEvent:ended', (e) => log.push(`end:${e.eventId}`));
  const banners: string[] = [];
  const points: SpawnPointDef[] = [
    { id: 'r1', position: new Vector3(10, 0, 0), yaw: 0, zone: 'open', kind: 'rift' },
    { id: 'r2', position: new Vector3(-10, 0, 0), yaw: 0, zone: 'open', kind: 'rift' },
    { id: 'r3', position: new Vector3(0, 0, 90), yaw: 0, zone: 'closed', kind: 'rift' },
  ];
  let full = false;
  const director = new MapEventDirector({
    defs,
    generators: [
      { id: 'gen_open', position: [0, 0, 10], facing: 'nz', zone: 'open' },
      { id: 'gen_closed', position: [0, 0, 80], facing: 'nz', zone: 'closed' },
    ],
    events,
    power,
    gravity,
    enemies: {
      spawn: (type: string, position: Vec3Like, opts?: EnemySpawnOptions) => {
        if (full) return null;
        spawned.push({ type, position: { ...position }, point: opts?.spawnPoint?.id });
        return spawned.length;
      },
    },
    waves,
    spawnPoints: points,
    isZoneActive: (z) => open.has(z),
    zoneName: (z) => z.toUpperCase(),
    player: { position: new Vector3(), eyePosition: new Vector3(), alive: true, damage: () => 0 },
    interaction: { register: (i) => registered.push(i), unregister: () => {} },
    isKnownType: (t) => t === 'swarmer' || t === 'tank',
    banner: (kicker, title, sub) => banners.push(`${kicker}|${title}|${sub}`),
    seed: 'test',
  });
  const tick = (seconds: number): void => {
    for (let t = 0; t < seconds - 1e-9; t += DT) director.fixedUpdate(DT);
  };
  const waveStart = (wave: number): void => {
    waves.wave = wave;
    events.emit('wave:start', { wave, total: 10 });
  };
  return {
    events,
    power,
    gravity,
    spawned,
    registered,
    waves,
    open,
    log,
    banners,
    director,
    tick,
    waveStart,
    setFull: (f: boolean) => {
      full = f;
    },
  };
}

describe('MapEventDirector', () => {
  it('starts a forced-wave power outage after its delay, only with a reachable generator', () => {
    const r = rig([OUTAGE]);
    r.waveStart(3);
    r.tick(2);
    expect(r.log).toEqual([]);
    r.waveStart(4);
    expect(r.director.pendingInfo?.id).toBe('blackout');
    r.tick(0.5);
    expect(r.power.powered).toBe(true);
    r.tick(0.6);
    expect(r.log).toEqual(['start:blackout']);
    expect(r.power.powered).toBe(false);
    expect(r.banners[0]).toContain(POWER.banners.outage.kicker);
    expect(r.banners[0]).toContain('OPEN');
    // The generator in the open zone is the objective; the closed one stays quiet.
    const [open, closed] = r.director.generators;
    expect(open!.alarm).toBe(true);
    expect(closed!.alarm).toBe(false);
    expect(open!.prompt()).toBe(POWER.generator.prompt);
    expect(open!.holdTime()).toBe(POWER.generator.hold);
    expect(closed!.prompt()).toBe('');
    // Restart: hold interact completes → power back, event ended.
    open!.interact();
    r.tick(DT);
    expect(r.power.powered).toBe(true);
    expect(r.log).toEqual(['start:blackout', 'end:blackout']);
    expect(r.director.active).toEqual([]);
  });

  it('never starts an outage when every generator is behind closed doors', () => {
    const r = rig([OUTAGE]);
    r.open.clear();
    expect(r.director.trigger('blackout')).toBe(false);
    r.waveStart(4);
    r.tick(2);
    expect(r.power.powered).toBe(true);
  });

  it('invasion: a quest step starts it; extra enemies over the spread from every open rift', () => {
    const r = rig([INV]);
    r.waves.wave = 1;
    r.events.emit('quest:step', { questId: 'q', stepId: 'defend', step: 3, steps: 4 });
    expect(r.log).toEqual(['start:invasion']);
    r.tick(0.3);
    expect(r.spawned.length).toBeGreaterThan(0);
    expect(r.spawned.length).toBeLessThan(5);
    r.tick(3);
    expect(r.spawned.length).toBe(5); // base 4 + perWave 1 × wave 1
    expect(new Set(r.spawned.map((s) => s.point))).toEqual(new Set(['r1', 'r2']));
    expect(r.spawned.every((s) => s.type === 'swarmer')).toBe(true);
    expect(r.log).toEqual(['start:invasion', 'end:invasion']);
    expect(r.banners[0]).toContain(INVASION.banner.title);
  });

  it('invasion retries while the pool is full, then gives up spawn by spawn', () => {
    const r = rig([INV]);
    r.setFull(true);
    r.director.trigger('invasion');
    r.tick(INVASION.retryDelay * (INVASION.maxRetries + 2) * 6);
    expect(r.spawned.length).toBe(0);
    expect(r.director.active).toEqual([]);
  });

  it('gravity anomaly: a chance roll starts it in an open zone; low g inside, gone after it ends', () => {
    const r = rig([ANOMALY]);
    r.waveStart(1);
    r.tick(1);
    expect(r.log).toEqual([]);
    r.waveStart(2);
    r.tick(0.6);
    expect(r.log).toEqual(['start:anomaly']);
    r.tick(GRAVITY.anomaly.fade + 0.1);
    expect(r.gravity.scaleAt(5, 1, 5)).toBeCloseTo(0.3, 2);
    expect(r.gravity.scaleAt(30, 1, 0)).toBe(1);
    r.tick(4);
    expect(r.log).toEqual(['start:anomaly', 'end:anomaly']);
    expect(r.gravity.size).toBe(0);
    expect(r.gravity.scaleAt(5, 1, 5)).toBe(1);
    // Cooldown: the next waves do not roll it again.
    r.waveStart(3);
    r.tick(1);
    expect(r.log.length).toBe(2);
  });

  it('does not roll during the intermission and never overlaps rolled events', () => {
    const r = rig([ANOMALY, { ...ANOMALY, id: 'anomaly2' }]);
    r.waves.state = 'intermission';
    r.waveStart(2);
    r.tick(1);
    expect(r.log).toEqual([]);
    r.waves.state = 'active';
    r.waveStart(8);
    r.tick(1);
    r.waveStart(9);
    r.tick(1);
    expect(r.log.filter((l) => l.startsWith('start:')).length).toBe(1);
  });

  it('reset ends everything at once: power on, anomalies gone, generators quiet', () => {
    const r = rig([OUTAGE, ANOMALY]);
    r.director.trigger('blackout');
    r.director.trigger('anomaly');
    expect(r.director.active).toEqual(['blackout', 'anomaly']);
    expect(r.power.powered).toBe(false);
    r.director.reset('new-run');
    expect(r.director.active).toEqual([]);
    expect(r.power.powered).toBe(true);
    expect(r.gravity.size).toBe(0);
    expect(r.director.generators.every((g) => !g.alarm)).toBe(true);
  });

  it('dev console: list, trigger, stop', async () => {
    const r = rig([OUTAGE, ANOMALY]);
    const [cmd] = createEventCommands({ director: r.director });
    expect(await cmd!.run(['list'])).toContain('blackout');
    expect(await cmd!.run(['trigger', 'anomaly'])).toContain('gestartet');
    expect(r.director.active).toEqual(['anomaly']);
    expect(await cmd!.run(['stop'])).toContain('1 Event');
    expect(r.director.active).toEqual([]);
    await expect(Promise.resolve().then(() => cmd!.run(['trigger', 'nope']))).rejects.toThrow();
  });

  it('the lab defines all three event kinds', () => {
    expect(MAP_EVENT_DEFS.lab!.map((d) => d.kind).sort()).toEqual([
      'gravityAnomaly',
      'invasion',
      'powerOutage',
    ]);
  });
});
