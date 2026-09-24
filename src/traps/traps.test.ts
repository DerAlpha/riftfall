import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { CombatHit, DamageInfo, DamageResult, Damageable, Hitbox, Interactable } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { TRAPS, TRAP_SLOTS, trapTiming, type TrapSlotDef } from '../defs/traps';
import { FakeEconomy } from '../interactables/testFakes';
import type { KitCombat, KitPlayer } from '../maps/kit/kitTypes';
import { TrapSystem } from './TrapSystem';
import {
  TrapTimer,
  aimAt,
  aimDirection,
  fanSample,
  flamePhase,
  segmentDistanceXZ,
  slewAngle,
  type FanSample,
  type SegmentHit,
} from './trapMath';

const DT = 1 / 60;
let nextId = 1;

class Enemy implements Damageable {
  readonly id = nextId++;
  readonly team = 'enemy' as const;
  readonly surface = 'flesh' as const;
  readonly boundsCenter: Vector3;
  readonly boundsRadius = 0.6;
  readonly aimPoint: Vector3;
  readonly hitboxes: Hitbox[];
  readonly received: DamageInfo[] = [];
  constructor(
    x: number,
    z: number,
    public health = 100,
  ) {
    this.boundsCenter = new Vector3(x, 0.9, z);
    this.aimPoint = new Vector3(x, 1.25, z);
    this.hitboxes = [{ shape: 'sphere', zone: 'body', a: this.aimPoint, b: this.aimPoint, radius: 0.4 }];
  }
  get alive(): boolean {
    return this.health > 0;
  }
  applyDamage(info: DamageInfo): DamageResult {
    this.received.push({ ...info, point: { ...info.point }, direction: { ...info.direction } });
    const applied = Math.min(this.health, info.amount);
    this.health -= applied;
    return { applied, killed: this.health <= 0 };
  }
}

class Combat implements KitCombat {
  readonly targets: Damageable[] = [];
  losBlocked = false;
  readonly dealt: DamageInfo[] = [];
  private readonly hit: CombatHit = {
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    distance: 0,
    target: null,
    zone: null,
    surface: 'flesh',
    penetrable: false,
  };
  register(t: Damageable): void {
    this.targets.push(t);
  }
  unregister(t: Damageable): void {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }
  queryRadius(c: Vec3Like, r: number, out: Damageable[]): Damageable[] {
    out.length = 0;
    for (const t of this.targets) {
      if (t.alive && Math.hypot(t.boundsCenter.x - c.x, t.boundsCenter.y - c.y, t.boundsCenter.z - c.z) <= r + t.boundsRadius)
        out.push(t);
    }
    return out;
  }
  dealDamage(t: Damageable, info: DamageInfo): DamageResult {
    this.dealt.push({ ...info });
    return t.applyDamage(info);
  }
  lineOfSight(): boolean {
    return !this.losBlocked;
  }
  /** Ray vs the targets' aim points (0.5 m spheres). */
  raycast(o: Vec3Like, d: Vec3Like, max: number): CombatHit | null {
    let best: Damageable | null = null;
    let bestT = max;
    for (const t of this.targets) {
      if (!t.alive) continue;
      const px = t.aimPoint.x - o.x;
      const py = t.aimPoint.y - o.y;
      const pz = t.aimPoint.z - o.z;
      const along = px * d.x + py * d.y + pz * d.z;
      if (along < 0 || along > bestT) continue;
      const miss = Math.hypot(px - d.x * along, py - d.y * along, pz - d.z * along);
      if (miss <= 0.5) {
        best = t;
        bestT = along;
      }
    }
    if (!best) return null;
    this.hit.target = best;
    this.hit.zone = 'body';
    this.hit.distance = bestT;
    this.hit.point.set(o.x + d.x * bestT, o.y + d.y * bestT, o.z + d.z * bestT);
    return this.hit;
  }
}

class Player implements KitPlayer {
  readonly position = new Vector3(0, 0, 20);
  readonly eyePosition = new Vector3(0, 1.6, 20);
  alive = true;
  taken: number[] = [];
  damage(amount: number): number {
    this.taken.push(amount);
    return amount;
  }
}

function rig(slots: readonly TrapSlotDef[], points = 10_000) {
  const events = new EventBus<GameEvents>();
  const combat = new Combat();
  const economy = new FakeEconomy(points);
  const power = { powered: true };
  const player = new Player();
  const registered: Interactable[] = [];
  const states: string[] = [];
  events.on('trap:state', (e) => states.push(`${e.trapId}:${e.state}`));
  const traps = new TrapSystem({
    slots,
    events,
    combat,
    economy,
    interaction: { register: (i) => registered.push(i), unregister: () => {} },
    power,
    player,
    seed: 'test',
  });
  const tick = (seconds: number): void => {
    for (let t = 0; t < seconds - 1e-9; t += DT) traps.fixedUpdate(DT);
  };
  return { events, combat, economy, power, player, registered, traps, states, tick };
}

const FENCE: TrapSlotDef = {
  id: 'fence',
  kind: 'fence',
  zone: 'z',
  a: [-2, 0, 0],
  b: [2, 0, 0],
  panel: { position: [3, 1.3, 0], facing: 'nx' },
  duration: 5,
  cooldown: 10,
};

describe('trap math', () => {
  it('runs ready → active → cooldown → ready', () => {
    const t = new TrapTimer(2, 3);
    expect(t.state).toBe('ready');
    expect(t.start()).toBe(true);
    expect(t.start()).toBe(false);
    expect(t.tick(1)).toBeNull();
    expect(t.progress).toBeCloseTo(0.5, 6);
    expect(t.tick(1.5)).toBe('cooldown');
    expect(t.remaining).toBeCloseTo(2.5, 6);
    expect(t.tick(2.5)).toBe('ready');
    expect(t.remaining).toBe(0);
    const noCool = new TrapTimer(1, 0);
    noCool.start();
    expect(noCool.tick(2)).toBe('ready');
  });

  it('segment distance, aiming and slewing', () => {
    const out: SegmentHit = { distance: 0, t: 0, x: 0, z: 0 };
    segmentDistanceXZ(0, 1, -2, 0, 2, 0, out);
    expect(out.distance).toBeCloseTo(1, 6);
    expect(out.t).toBeCloseTo(0.5, 6);
    segmentDistanceXZ(5, 0, -2, 0, 2, 0, out);
    expect(out.distance).toBeCloseTo(3, 6);
    const aim = aimAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -5 }, { yaw: 9, pitch: 9 });
    expect(aim.yaw).toBeCloseTo(0, 6);
    expect(aim.pitch).toBeCloseTo(0, 6);
    aimAt({ x: 0, y: 0, z: 0 }, { x: -3, y: 3, z: 0 }, aim);
    const d = aimDirection(aim.yaw, aim.pitch, { x: 0, y: 0, z: 0 });
    expect(d.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(d.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(slewAngle(0, 1, 0.25)).toBeCloseTo(0.25, 6);
    // The short way round, across ±π: 3 → −3 is 0.28 rad through π, not 6 rad back.
    expect(slewAngle(3, -3, 0.1)).toBeCloseTo(3.1, 6);
    expect(slewAngle(3, -3, 0.5)).toBe(-3);
  });

  it('fan pull cylinder and flame phases', () => {
    const s: FanSample = { axial: 0, radial: 0, inside: false };
    fanSample({ x: 3, y: 0, z: 0.5 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 7, 1.5, s);
    expect(s.inside).toBe(true);
    expect(s.axial).toBeCloseTo(3, 6);
    expect(s.radial).toBeCloseTo(0.5, 6);
    fanSample({ x: -2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 7, 1.5, s);
    expect(s.inside).toBe(false);
    expect(flamePhase(0.1, 1.6, 0.9, 0.45)).toBe('pause');
    expect(flamePhase(0.6, 1.6, 0.9, 0.45)).toBe('warn');
    expect(flamePhase(1.0, 1.6, 0.9, 0.45)).toBe('burn');
    expect(flamePhase(2.6, 1.6, 0.9, 0.45)).toBe('pause');
  });
});

describe('TrapSystem', () => {
  it('builds the lab and calibration hall slots with a panel each', () => {
    for (const slots of [TRAP_SLOTS.lab!, TRAP_SLOTS.testroom!]) {
      const r = rig(slots);
      expect(r.traps.list.length).toBe(slots.length);
      expect(r.registered.length).toBe(slots.length);
    }
    expect(TRAP_SLOTS.lab!.map((s) => s.kind).sort()).toEqual(['fence', 'turret']);
  });

  it('activates through the panel: pays the price, then active → cooldown → ready', () => {
    const r = rig([FENCE], 5000);
    const panel = r.registered[0]!;
    const { price } = trapTiming(FENCE);
    expect(panel.prompt()).toBe('Elektrozaun aktivieren');
    expect(panel.cost()).toBe(price);
    expect(panel.canInteract()).toBe(true);
    panel.interact();
    expect(r.economy.spent).toEqual([{ cost: price, item: 'trap:fence', kind: 'other' }]);
    expect(r.traps.list[0]!.state).toBe('active');
    expect(panel.canInteract()).toBe(false);
    expect(panel.cost()).toBeNull();
    expect(panel.prompt()).toBe('Elektrozaun aktiv');
    r.tick(5.1);
    expect(r.traps.list[0]!.state).toBe('cooldown');
    expect(panel.prompt()).toBe('Elektrozaun lädt auf');
    r.tick(10);
    expect(r.traps.list[0]!.state).toBe('ready');
    expect(r.states).toEqual(['fence:active', 'fence:cooldown', 'fence:ready']);
  });

  it('refuses without points and without power (no charge)', () => {
    const poor = rig([FENCE], 10);
    poor.registered[0]!.interact();
    expect(poor.traps.list[0]!.state).toBe('ready');
    expect(poor.economy.spent.length).toBe(0);
    const dark = rig([FENCE]);
    dark.power.powered = false;
    const panel = dark.registered[0]!;
    expect(panel.canInteract()).toBe(false);
    expect(panel.prompt()).toBe(TRAPS.prompts.unpowered);
    expect(panel.cost()).toBeNull();
    panel.interact();
    expect(dark.economy.spent.length).toBe(0);
  });

  it('fence: zaps enemies crossing it with shock (source trap, stun build-up), hurts the player, counts kills', () => {
    const r = rig([FENCE]);
    const inside = new Enemy(0.5, 0.1, 150);
    const outside = new Enemy(0.5, 3);
    r.combat.register(inside);
    r.combat.register(outside);
    r.traps.activate('fence', true);
    expect(r.economy.spent.length).toBe(0);
    r.tick(0.5);
    expect(inside.received.length).toBeGreaterThan(0);
    const hit = inside.received[0]!;
    expect(hit.source).toBe('trap');
    expect(hit.element).toBe('shock');
    expect(hit.weaponId).toBe('trap:fence');
    expect(hit.statusBuildup).toBe(TRAPS.fence.statusBuildup);
    expect(outside.received.length).toBe(0);
    r.tick(2);
    expect(inside.alive).toBe(false);
    expect(r.traps.kills).toBe(1);
    expect(r.traps.list[0]!.kills).toBe(1);
    r.player.position.set(0, 0, 0.2);
    r.tick(1);
    expect(r.player.taken.length).toBeGreaterThanOrEqual(2);
    expect(r.player.taken[0]).toBe(TRAPS.fence.playerDamage);
    r.traps.reset();
    expect(r.traps.kills).toBe(0);
    expect(r.traps.list[0]!.state).toBe('ready');
  });

  it('turret: targets the nearest enemy in line of sight and shoots bursts; none through walls', () => {
    const turret: TrapSlotDef = {
      id: 'turret',
      kind: 'turret',
      zone: 'z',
      position: [0, 5, 0],
      mount: 'ceiling',
      yawDeg: 0,
      panel: { position: [3, 1.3, 0], facing: 'nx' },
    };
    const r = rig([turret]);
    const near = new Enemy(0, -8, 10_000);
    const far = new Enemy(6, -15, 10_000);
    r.combat.register(near);
    r.combat.register(far);
    const impacts: string[] = [];
    r.events.on('combat:impact', (e) => impacts.push(e.weaponId));
    r.traps.activate('turret', true);
    r.tick(3);
    expect(near.received.length).toBeGreaterThan(3);
    expect(near.received.every((d) => d.source === 'trap' && d.kind === 'bullet')).toBe(true);
    expect(far.received.length).toBe(0);
    expect(impacts.length).toBeGreaterThan(0);
    expect(impacts[0]).toBe('trap:turret');

    const blocked = rig([turret]);
    const e = new Enemy(0, -8);
    blocked.combat.register(e);
    blocked.combat.losBlocked = true;
    blocked.traps.activate('turret', true);
    blocked.tick(3);
    expect(e.received.length).toBe(0);
  });

  it('fan: pulls enemies in front of the intake towards the rotor and shreds them at the blades', () => {
    const fan: TrapSlotDef = {
      id: 'fan',
      kind: 'fan',
      zone: 'z',
      position: [0, 0.9, 0],
      facing: 'px',
      panel: { position: [0, 1.3, 3], facing: 'nz' },
    };
    const r = rig([fan]);
    const pulled = new Enemy(5, 0, 10_000);
    const shredded = new Enemy(1, 0, 60);
    const behind = new Enemy(-4, 0);
    for (const e of [pulled, shredded, behind]) r.combat.register(e);
    r.traps.activate('fan', true);
    r.tick(2.5);
    expect(pulled.received.length).toBeGreaterThan(0);
    const pull = pulled.received[pulled.received.length - 1]!;
    expect(pull.impulse).toBeGreaterThan(0);
    expect(pull.direction.x).toBeLessThan(0); // towards the rotor at x ≈ 0
    expect(shredded.alive).toBe(false);
    expect(behind.received.length).toBe(0);
  });

  it('flame vent: burns what stands in the column during a burst (fire build-up), and the player', () => {
    const flame: TrapSlotDef = {
      id: 'flame',
      kind: 'flame',
      zone: 'z',
      position: [0, 0, 0],
      panel: { position: [0, 1.3, 3], facing: 'nz' },
    };
    const r = rig([flame]);
    const e = new Enemy(0.2, 0, 10_000);
    r.combat.register(e);
    r.player.position.set(0.3, 0, -0.2);
    r.traps.activate('flame', true);
    r.tick(TRAPS.flame.pauseTime * 0.9);
    expect(e.received.length).toBe(0);
    r.tick(TRAPS.flame.burnTime);
    expect(e.received.length).toBeGreaterThan(3);
    expect(e.received[0]!.element).toBe('fire');
    expect(e.received[0]!.statusBuildup).toBe(TRAPS.flame.statusBuildup);
    expect(r.player.taken.length).toBeGreaterThan(0);
  });
});
