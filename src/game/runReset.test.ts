/**
 * Run reset (Game.resetRunSystems → resetRunSystems) against the real run systems: enemies +
 * wave director (enemies/testFakes harness), stats, economy, points rules, perks, power-ups, rift
 * seals, zones, interaction focus and player health. A run that touched all of them must leave
 * nothing behind – including the order-dependent results (health after the stat table, the enemy
 * effects of timed power-ups).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { SpawnPointDef } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { ECONOMY } from '../defs/economy';
import { PLAYER } from '../defs/player';
import { getLoadout } from '../defs/weapons';
import { EconomySystem } from '../economy/EconomySystem';
import { PerkSystem } from '../economy/PerkSystem';
import { PointsRules } from '../economy/PointsRules';
import { DT, createEnemyHarness } from '../enemies/testFakes';
import { InteractionSystem } from '../interactables/InteractionSystem';
import { ZoneSystem } from '../interactables/ZoneSystem';
import { PlayerHealth } from '../player/PlayerHealth';
import { PowerUpSystem } from '../powerups/PowerUpSystem';
import { SealSystem } from '../seals/SealSystem';
import { WaveDirector } from '../spawning/WaveDirector';
import { StatSystem } from '../stats/StatSystem';
import { resetRunSystems, type RunResetSystems } from './runReset';

const START_POINTS = 500;
const SPAWN = { position: new Vector3(2, 0, 9), yaw: 1.25 };

function rift(id: string, x: number, z: number, zone: string): SpawnPointDef {
  return { id, position: new Vector3(x, 0, z), yaw: 0, zone, kind: 'rift' };
}

function setup() {
  const h = createEnemyHarness();
  const { events, manager } = h;
  const stats = new StatSystem({ events });
  const economy = new EconomySystem({ events, stats }, START_POINTS);
  const pointsRules = new PointsRules({
    events,
    economy,
    rewardOf: (id) => manager.getEnemy(id)?.def.points ?? null,
  });
  const perks = new PerkSystem({ events, stats, seed: 'perks:test' });
  const health = new PlayerHealth({ events });
  health.setStats(stats);
  const zones = new ZoneSystem({ events, zones: ['hall', 'lab'], startZones: ['hall'] });
  const spawnPoints = [rift('a', 18, 0, 'hall'), rift('b', -18, 4, 'hall'), rift('c', 0, 20, 'lab')];
  const seals = new SealSystem({ events, spawnPoints, rewards: pointsRules });
  manager.setBreach(seals);
  const powerUps = new PowerUpSystem({
    events,
    player: { position: h.player.position },
    stats,
    economy,
    enemies: manager,
    weapons: { refillAmmo: () => {} },
    seals,
    armor: health,
    seed: 'powerups:test',
  });
  const interaction = new InteractionSystem({
    events,
    input: { isDown: () => false, pressed: () => false },
    viewer: { eyePosition: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0 },
    economy,
    lineOfSight: () => true,
  });
  const waves = new WaveDirector({
    events,
    enemies: manager,
    spawnPoints,
    target: h.player,
    camera: null,
    rng: new Rng('waves:test'),
    isZoneActive: (z) => zones.isActive(z),
  });
  const calls: string[] = [];
  const view = { pitch: -0.9, teleports: [] as number[][] };
  const sys: RunResetSystems = {
    enemies: manager,
    waves,
    vfx: { clear: () => calls.push('vfx') },
    powerUps,
    perks,
    stats,
    economy,
    pointsRules,
    health,
    player: {
      get pitch() {
        return view.pitch;
      },
      set pitch(v: number) {
        view.pitch = v;
      },
      teleport: (p: Vec3Like, yaw?: number) => view.teleports.push([p.x, p.y, p.z, yaw ?? NaN]),
    },
    level: { id: 'lab', spawn: SPAWN },
    map: { waves: true },
    nav: { setRandomSeed: (seed) => calls.push(`nav ${seed}`) },
    zones,
    interactables: { reset: (seed) => calls.push(`interactables ${seed}`) },
    interaction,
    seals,
    weapons: {
      setLoadout: (ids, slots) => calls.push(`loadout ${ids.join(',')} ${slots}`),
      refillAmmo: (fill) => calls.push(`refill ${fill}`),
    },
    viewmodel: { setVisible: (v) => calls.push(`viewmodel ${v}`) },
    hud: { resetRun: () => calls.push('hud') },
    audioBridge: { resetRun: () => calls.push('audio') },
    loop: { timeScale: 1 },
  };
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      waves.fixedUpdate(DT);
      h.tick(1);
      powerUps.fixedUpdate(DT);
      perks.fixedUpdate(DT);
      health.fixedUpdate(DT);
    }
  };
  /** Through the intermission until the wave's first enemies are up. */
  const untilWave = (): void => {
    for (let guard = 0; (waves.state !== 'active' || manager.alive === 0) && guard < 60 * 90; guard++)
      tick(1);
  };
  return {
    ...h,
    sys,
    waves,
    stats,
    economy,
    pointsRules,
    perks,
    health,
    zones,
    seals,
    powerUps,
    interaction,
    calls,
    view,
    tick,
    untilWave,
  };
}

describe('resetRunSystems', () => {
  it('leaves nothing of a run that touched every economy system behind', () => {
    const s = setup();
    const { sys, manager, waves, economy, pointsRules, perks, health, zones, seals, powerUps, stats } = s;

    // --- a run: wave 1 underway, perks, timed power-ups, a pickup, a zone, broken seals, points ---
    waves.start(1);
    s.untilWave();
    expect(manager.alive).toBeGreaterThan(0);
    economy.adjust(10_000);
    expect(perks.grant('titan')).toBe(true);
    expect(perks.grant('phoenix')).toBe(true);
    expect(economy.spend(2000, 'perk:sprinter', 'perk')).toBe(true);
    for (const t of ['doublePoints', 'instakill', 'slowmo']) powerUps.activate(t);
    powerUps.spawn('maxAmmo', { x: 30, y: 0, z: 30 });
    zones.activate('lab');
    seals.breakAll();
    const cap = ECONOMY.repair.capPerWave;
    pointsRules.awardRepair(Math.ceil(cap / ECONOMY.repair.perPlank) + 5);
    health.damage(60);
    s.tick(30);
    expect(manager.timeScale).toBeLessThan(1);
    expect(manager.instakill).toBe(true);
    expect(stats.modified().length).toBeGreaterThan(0);
    expect(economy.multiplier).toBeGreaterThan(1);
    expect(health.maxHealth).toBeGreaterThan(PLAYER.health.maxHealth);
    expect(health.reviveCharges).toBe(1);
    expect(powerUps.activeTimed.length).toBe(3);
    expect(powerUps.pickupCount).toBe(1);
    expect(seals.brokenSegments).toBeGreaterThan(0);
    expect(pointsRules.repairAllowance).toBe(0);
    expect(zones.active).toContain('lab');
    sys.loop.timeScale = 0.12; // the death slow motion
    const order: string[] = [];
    for (const t of ['perk:lost', 'powerup:expired'] as const) s.events.on(t, () => order.push(t));
    s.events.on('player:healthChanged', (e) => order.push(e.health > 0 ? 'alive' : 'dead'));

    resetRunSystems(sys, { seed: 'run:lab:7:123', startWaves: true });

    // The perks and power-ups end before the health reset announces the living player (the economy
    // audio stays silent after a death until then: no loss / expiry sounds on a restart).
    expect(order.filter((o) => o !== 'alive' && o !== 'dead')).toEqual([
      'powerup:expired',
      'powerup:expired',
      'powerup:expired',
      'perk:lost',
      'perk:lost',
    ]);
    expect(order.indexOf('alive')).toBeGreaterThan(order.lastIndexOf('perk:lost'));

    // Enemies, their power-up effects, the director (a fresh intermission).
    expect(manager.alive).toBe(0);
    expect(manager.timeScale).toBe(1);
    expect(manager.instakill).toBe(false);
    expect(waves.state).toBe('intermission');
    expect(waves.wave).toBe(0);
    // Stats / perks / power-ups: no source of any kind survives.
    expect(perks.owned).toEqual([]);
    expect(stats.modified()).toEqual([]);
    expect(powerUps.activeTimed).toEqual([]);
    expect(powerUps.pickupCount).toBe(0);
    expect(economy.multiplier).toBe(1);
    // Health after the stat table: start values at the base max, no revive charge.
    expect(health.maxHealth).toBe(PLAYER.health.maxHealth);
    expect(health.health).toBe(PLAYER.health.startHealth);
    expect(health.armor).toBe(PLAYER.health.startArmor);
    expect(health.reviveCharges).toBe(0);
    // Economy: start balance, empty totals, a fresh repair cap.
    expect(economy.points).toBe(START_POINTS);
    expect(economy.totals).toEqual({ earned: 0, spent: 0, purchases: 0 });
    expect(pointsRules.repairAllowance).toBe(cap);
    expect(Object.values(pointsRules.stats).every((v) => v === 0)).toBe(true);
    // World: start zones, every seal intact, no focus.
    expect(zones.active).toEqual(['hall']);
    expect(seals.brokenSegments).toBe(0);
    expect(s.interaction.focused).toBeNull();
    // Player at the spawn, looking level; per-run seeds; loadout, HUD, audio; real-time speed.
    expect(s.view.teleports).toEqual([[SPAWN.position.x, SPAWN.position.y, SPAWN.position.z, SPAWN.yaw]]);
    expect(s.view.pitch).toBe(0);
    const loadout = getLoadout('lab');
    expect(s.calls).toEqual([
      'vfx',
      'interactables box:run:lab:7:123',
      'nav run:lab:7:123',
      `loadout ${loadout.weapons.join(',')} ${loadout.slots}`,
      'refill true',
      'viewmodel true',
      'hud',
      'audio',
    ]);
    expect(sys.loop.timeScale).toBe(1);

    // The new run earns at ×1 and its first wave comes.
    expect(economy.earn(100, 'kill')).toBe(100);
    s.untilWave();
    expect(waves.wave).toBe(1);
    expect(manager.alive).toBeGreaterThan(0);
  });

  it('main menu: everything reset, the director stays idle', () => {
    const s = setup();
    s.waves.start(1);
    s.untilWave();
    s.economy.adjust(1000);
    resetRunSystems(s.sys, { seed: 'menu', startWaves: false });
    expect(s.waves.state).toBe('idle');
    expect(s.manager.alive).toBe(0);
    expect(s.economy.points).toBe(START_POINTS);
  });

  it('a map without waves never starts the director', () => {
    const s = setup();
    s.sys.map = { waves: false };
    resetRunSystems(s.sys, { seed: 'hall', startWaves: true });
    expect(s.waves.state).toBe('idle');
  });
});
