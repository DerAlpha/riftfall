import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { SpawnPointDef } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { ECONOMY } from '../defs/economy';
import { SEALS } from '../defs/seals';
import { EconomySystem } from '../economy/EconomySystem';
import { PointsRules } from '../economy/PointsRules';
import { InteractionSystem } from '../interactables/InteractionSystem';
import { SealSystem } from './SealSystem';

const DT = 1 / 60;

function spawnPoints(): SpawnPointDef[] {
  return [
    { id: 'rift_a', position: new Vector3(0, 0, -20), yaw: 0, zone: 'hall', kind: 'rift' },
    { id: 'vent_b', position: new Vector3(15, 0, 0), yaw: -Math.PI / 2, zone: 'hall', kind: 'vent' },
  ];
}

const { perPlank, capPerWave } = ECONOMY.repair;

function setup() {
  const events = new EventBus<GameEvents>();
  const economy = new EconomySystem({ events }, 0);
  // The game's repair rule (per-bar points, per-wave cap).
  const rewards = new PointsRules({ events, economy });
  const vfx: { effect: string }[] = [];
  const seals = new SealSystem({
    events,
    spawnPoints: spawnPoints(),
    rewards,
    vfx: { spawn: (effect) => void vfx.push({ effect }) },
  });
  const broken: GameEvents['seal:broken'][] = [];
  const repaired: GameEvents['seal:repaired'][] = [];
  events.on('seal:broken', (e) => broken.push({ ...e, position: { ...e.position } }));
  events.on('seal:repaired', (e) => repaired.push({ ...e, position: { ...e.position } }));
  return { events, economy, rewards, seals, broken, repaired, vfx };
}

describe('SealSystem', () => {
  it('builds one intact seal per spawn point; intact seals offer nothing', () => {
    const t = setup();
    expect(t.seals.seals).toHaveLength(2);
    const s = t.seals.seal('rift_a')!;
    expect(s.id).toBe(`${SEALS.idPrefix}rift_a`);
    expect(t.seals.seal(s.id)).toBe(s);
    expect(t.seals.segmentsLeft('rift_a')).toBe(SEALS.segments);
    expect(s.prompt()).toBe('');
    expect(s.canInteract()).toBe(false);
    expect(s.cost()).toBeNull();
    expect(s.holdTime()).toBe(SEALS.repair.holdTime);
    // Unknown spawn points are open and never in the way.
    expect(t.seals.segmentsLeft('nope')).toBe(0);
    expect(t.seals.frontDistance('nope', { x: 0, y: 0, z: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(t.seals.confine('nope', new Vector3(), 0.4)).toBe(false);
  });

  it('enemy strikes break bars from the top (seal:broken each); flashes break nothing', () => {
    const t = setup();
    const from = { x: 0, y: 0, z: -20 };
    expect(t.seals.strike('rift_a', 0, from)).toBe(5);
    expect(t.broken).toHaveLength(0);
    expect(t.vfx.map((v) => v.effect)).toContain(SEALS.vfx.hit);
    expect(t.seals.strike('rift_a', 2, from)).toBe(3);
    expect(t.broken).toHaveLength(2);
    expect(t.broken[0]!.sealId).toBe('seal:rift_a');
    // Top bar first: the first event is higher than the second.
    expect(t.broken[0]!.position.y).toBeGreaterThan(t.broken[1]!.position.y);
    expect(t.seals.strike('rift_a', 9, from)).toBe(0);
    expect(t.broken).toHaveLength(5);
    expect(t.seals.brokenSegments).toBe(5);
    expect(t.seals.seal('rift_a')!.prompt()).toBe(SEALS.prompts.repair);
  });

  it('holding interact repairs bar after bar and pays points up to the per-wave cap', () => {
    const t = setup();
    const seal = t.seals.seal('rift_a')!;
    t.seals.breakSeal('rift_a');
    expect(seal.up).toBe(0);
    let held = false;
    const f = seal.frame;
    const viewer = {
      eyePosition: new Vector3(seal.position.x + f.fx * 1.4, seal.position.y, seal.position.z + f.fz * 1.4),
      // Looking back at the plane (PlayerApi yaw: forward = (−sin yaw, −cos yaw)).
      yaw: Math.atan2(f.fx, f.fz),
      pitch: 0,
    };
    const interaction = new InteractionSystem({
      events: t.events,
      input: { isDown: () => held, pressed: () => false },
      viewer,
      economy: t.economy,
      lineOfSight: () => true,
    });
    t.seals.attach(interaction);
    const tick = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        interaction.fixedUpdate(DT);
        t.seals.update(DT);
      }
    };
    tick(0.1);
    expect(interaction.focused).toBe(seal);

    // Not held long enough: nothing (the ghost of the next bar shows the progress).
    held = true;
    tick(SEALS.repair.holdTime * 0.5);
    expect(seal.up).toBe(0);
    expect(seal.preview).toBeGreaterThan(0.3);
    tick(SEALS.repair.holdTime * 0.6);
    expect(seal.up).toBe(1);
    expect(t.repaired).toHaveLength(1);
    expect(t.repaired[0]).toMatchObject({ sealId: 'seal:rift_a', planks: 1 });
    expect(t.economy.points).toBe(perPlank);

    // Keeping the button held repairs the next bar every holdTime (CoD style).
    tick(SEALS.repair.holdTime * 2 + 0.05);
    expect(seal.up).toBe(3);
    held = false;
    tick(0.05);
    t.seals.breakSeal('rift_a', 2);
    expect(seal.up).toBe(1);
    const repairOnce = (): void => {
      held = false;
      tick(0.05);
      held = true;
      tick(SEALS.repair.holdTime + 0.05);
    };
    repairOnce();
    repairOnce();
    expect(seal.up).toBe(3);
    // 3 bars while held, 2 more after the strike.
    expect(t.economy.points).toBe(5 * perPlank);

    // The swarm keeps tearing, the player keeps repairing: points stop at the per-wave cap.
    const farm = Math.ceil(capPerWave / perPlank);
    for (let i = 0; i < farm; i++) {
      t.seals.strike('rift_a', 1, seal.position);
      repairOnce();
    }
    expect(seal.up).toBe(3);
    expect(t.economy.points).toBe(capPerWave);
    // Cap reached: repairs go on, points do not; the prompt says so.
    expect(seal.prompt()).toBe(SEALS.prompts.repairNoPoints);
    repairOnce();
    expect(seal.up).toBe(4);
    expect(t.economy.points).toBe(capPerWave);
    // A new wave resets the cap.
    t.events.emit('wave:start', { wave: 2, total: 10 });
    expect(seal.prompt()).toBe(SEALS.prompts.repair);
    repairOnce();
    expect(seal.up).toBe(5);
    expect(t.economy.points).toBe(capPerWave + perPlank);
    // Intact again: nothing to focus.
    tick(0.1);
    expect(interaction.focused).toBeNull();
    expect(t.rewards.stats.repair).toBe(capPerWave + perPlank);
    t.seals.dispose();
    expect(interaction.all).toHaveLength(0);
  });

  it('pays nothing while the player is dead (the interaction system is disabled)', () => {
    const t = setup();
    const seal = t.seals.seal('rift_a')!;
    t.seals.breakSeal('rift_a', 2);
    const f = seal.frame;
    let alive = false;
    const interaction = new InteractionSystem({
      events: t.events,
      input: { isDown: () => true, pressed: () => false },
      viewer: {
        eyePosition: new Vector3(seal.position.x + f.fx, seal.position.y, seal.position.z + f.fz),
        yaw: Math.atan2(f.fx, f.fz),
        pitch: 0,
      },
      economy: t.economy,
      lineOfSight: () => true,
      enabled: () => alive,
    });
    t.seals.attach(interaction);
    for (let i = 0; i < 60; i++) interaction.fixedUpdate(DT);
    expect(seal.up).toBe(SEALS.segments - 2);
    expect(t.economy.points).toBe(0);
    alive = true;
    for (let i = 0; i < 60; i++) interaction.fixedUpdate(DT);
    expect(seal.up).toBe(SEALS.segments - 1);
    expect(t.economy.points).toBe(perPlank);
  });

  it('repairAll (carpenter) restores every seal without repair points; reset() is silent', () => {
    const t = setup();
    t.seals.breakSeal('rift_a', 3);
    t.seals.breakSeal('vent_b', 5);
    expect(t.seals.brokenSegments).toBe(8);
    t.repaired.length = 0;
    expect(t.seals.repairAll()).toBe(8);
    expect(t.seals.brokenSegments).toBe(0);
    expect(t.repaired.map((r) => r.planks).sort()).toEqual([3, 5]);
    expect(t.economy.points).toBe(0);

    t.seals.breakAll();
    t.repaired.length = 0;
    t.broken.length = 0;
    t.seals.reset();
    expect(t.seals.brokenSegments).toBe(0);
    expect(t.repaired).toHaveLength(0);
    expect(t.broken).toHaveLength(0);
    for (const s of t.seals.seals) expect(Array.from(s.grow)).toEqual([1, 1, 1, 1, 1]);
  });

  it('bars shatter and re-form over time (view state)', () => {
    const t = setup();
    const s = t.seals.seal('rift_a')!;
    t.seals.strike('rift_a', 1, { x: 0, y: 0, z: -20 });
    const top = s.segments - 1;
    t.seals.update(SEALS.visual.breakTime * 0.5);
    expect(s.shatter[top]).toBeGreaterThan(0);
    expect(s.grow[top]).toBe(1);
    t.seals.update(SEALS.visual.breakTime);
    expect(s.grow[top]).toBe(0);
    t.seals.repair('rift_a', 1);
    expect(s.grow[top]).toBe(0);
    t.seals.update(SEALS.visual.formTime * 0.5);
    expect(s.grow[top]).toBeGreaterThan(0.3);
    expect(s.grow[top]).toBeLessThan(1);
    t.seals.update(SEALS.visual.formTime);
    expect(s.grow[top]).toBe(1);
  });
});
