import { beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { MOVEMENT } from '../defs/movement';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PlayerController } from './PlayerController';
import { FakeInput, fakeSettings } from './testHelpers';

const DT = 1 / 60;

interface Rig {
  settings: SettingsStore;
  physics: PhysicsWorld;
  input: FakeInput;
  events: EventBus<GameEvents>;
  player: PlayerController;
  log: string[];
  frame(n?: number): void;
}

/**
 * Test course (feet level y = 0):
 * - floor 80 x 80
 * - wall along x = 10 (face at x = 9.5)
 * - low ceiling block over x ∈ [-12, -8], z ∈ [-2, 2], bottom at y = 1.4
 * - 1.2 m platform at z ∈ [-24, -20], x ∈ [18, 22]
 * - stairs (0.2 m steps, 0.35 m deep) climbing towards -z at x = -20
 * - 25° trimesh ramp at x ∈ [25, 30], top edge z = 0 (y = 5) descending to z = -10.72 (y = 0)
 * - thin wall (1.0 m high, 0.2 m thick) at z ∈ [29.9, 30.1], x ∈ [-3, 3] (vault)
 * - 60° trimesh slope at x ∈ [-30, -25], rising from z = 20 (y = 0) to z ≈ 22.89 (y = 5)
 * - 4 m tall, 4 cm thin wall at z ∈ [19.98, 20.02], x ∈ [30, 36] with a 1 m platform behind it
 *   (z ∈ [16.1, 19.9]) – a mantle must never pass through the wall
 * - V crevice of two 60° slabs, crease along x ∈ [-40, -28] at y = 0, z = 34
 * - 1.5 m ledge (face at z = -31, x ∈ [32.5, 35.5]) with a 10 cm beam at y ∈ [1.2, 1.3] in front
 *   of it (z ∈ [-30.95, -28.55]) – a crouched player under the beam must not mantle through it
 */
async function createRig(spawn = { x: 0, y: 0, z: 0 }): Promise<Rig> {
  const physics = await PhysicsWorld.create();
  physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 0.5, z: 40 }, undefined, {
    kind: 'world',
    surface: 'concrete',
  });
  physics.addStaticBox({ x: 10.5, y: 2, z: 0 }, { x: 1, y: 2, z: 8 });
  physics.addStaticBox({ x: -10, y: 1.9, z: 0 }, { x: 2, y: 0.5, z: 2 });
  physics.addStaticBox({ x: 20, y: 0.6, z: -22 }, { x: 2, y: 0.6, z: 2 }, undefined, {
    kind: 'world',
    surface: 'metal',
  });
  for (let i = 0; i < 8; i++) {
    const h = 0.2 * (i + 1);
    physics.addStaticBox({ x: -20, y: h / 2, z: -2 - i * 0.35 - 0.175 }, { x: 1.5, y: h / 2, z: 0.175 });
  }
  physics.addStaticBox({ x: -20, y: 0.8, z: -2 - 8 * 0.35 - 2 }, { x: 1.5, y: 0.8, z: 2 });
  const rampLen = 5 / Math.tan((25 * Math.PI) / 180);
  physics.addStaticTrimesh(
    new Float32Array([25, 5, 0, 30, 5, 0, 30, 0, -rampLen, 25, 0, -rampLen]),
    new Uint32Array([0, 1, 3, 1, 2, 3]),
    { kind: 'world', surface: 'grate' },
  );
  physics.addStaticBox({ x: 0, y: 0.5, z: 30 }, { x: 3, y: 0.5, z: 0.1 });
  const steepRun = 5 / Math.tan((60 * Math.PI) / 180);
  physics.addStaticTrimesh(
    new Float32Array([-30, 0, 20, -25, 0, 20, -25, 5, 20 + steepRun, -30, 5, 20 + steepRun]),
    new Uint32Array([0, 2, 1, 0, 3, 2]),
    { kind: 'world', surface: 'concrete' },
  );
  physics.addStaticBox({ x: 33, y: 2, z: 20 }, { x: 3, y: 2, z: 0.02 });
  physics.addStaticBox({ x: 33, y: 0.5, z: 18 }, { x: 3, y: 0.5, z: 1.9 });
  addVCrevice(physics, { x: -34, y: 0, z: 34 }, 60, 6);
  physics.addStaticBox({ x: 34, y: 0.75, z: -33 }, { x: 1.5, y: 0.75, z: 2 });
  physics.addStaticBox({ x: 34, y: 1.25, z: -29.75 }, { x: 1.5, y: 0.05, z: 1.2 });
  const input = new FakeInput();
  const events = new EventBus<GameEvents>();
  const log: string[] = [];
  const types: (keyof GameEvents)[] = [
    'player:jump',
    'player:land',
    'player:footstep',
    'player:slideStart',
    'player:slideEnd',
    'player:dash',
    'player:mantle',
    'player:crouch',
    'player:teleported',
    'camera:shake',
  ];
  for (const t of types) events.on(t, () => log.push(t));
  const settings = fakeSettings();
  const player = new PlayerController({ physics, input, events, settings }, { position: spawn, yaw: 0 });
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      player.fixedUpdate(DT);
      physics.step(DT);
      player.update(DT, 1);
      input.endFrame();
    }
  };
  return { settings, physics, input, events, player, log, frame };
}

/** Two slabs rising at ±`deg` from a crease along x through `crease` (a V trough). */
function addVCrevice(physics: PhysicsWorld, crease: Vec3Like, deg: number, halfX: number): void {
  const a = (deg * Math.PI) / 180;
  const halfLen = 3;
  const halfThick = 0.25;
  const cy = crease.y + Math.sin(a) * halfLen - Math.cos(a) * halfThick;
  const dz = Math.cos(a) * halfLen + Math.sin(a) * halfThick;
  for (const side of [1, -1]) {
    const half = (-side * a) / 2;
    physics.addStaticBox(
      { x: crease.x, y: cy, z: crease.z + side * dz },
      { x: halfX, y: halfThick, z: halfLen },
      { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) },
    );
  }
}

/**
 * Run `seconds` of frames at `hz` through a real fixed-step accumulator (render alpha < 1),
 * starting `phase` ticks into the accumulator; calls `onFrame` after every frame.
 */
function runAtRefreshRate(r: Rig, hz: number, seconds: number, phase: number, onFrame: () => void): void {
  const frameDt = 1 / hz;
  let acc = phase * DT;
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) {
    acc += frameDt;
    while (acc >= DT) {
      r.player.fixedUpdate(DT);
      r.physics.step(DT);
      acc -= DT;
    }
    r.player.update(frameDt, acc / DT);
    r.input.endFrame();
    onFrame();
  }
}

function count(log: string[], type: string): number {
  return log.filter((e) => e === type).length;
}

describe('PlayerController (Rapier integration)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await createRig();
  });

  it('settles on the ground with the configured eye height', () => {
    rig.frame(30);
    const p = rig.player;
    expect(p.grounded).toBe(true);
    expect(p.state).toBe('ground');
    expect(p.position.y).toBeGreaterThanOrEqual(0);
    expect(p.position.y).toBeLessThan(0.05);
    expect(p.eyePosition.y - p.position.y).toBeCloseTo(MOVEMENT.collider.standEyeHeight, 2);
    expect(p.velocity.y).toBe(0);
  });

  it('runs at run speed, sprints faster and emits footsteps', () => {
    rig.frame(10);
    rig.input.move.y = 1;
    rig.frame(60);
    const p = rig.player;
    expect(p.horizontalSpeed).toBeCloseTo(MOVEMENT.ground.runSpeed, 1);
    // yaw 0 looks down -Z.
    expect(p.velocity.z).toBeLessThan(0);
    expect(count(rig.log, 'player:footstep')).toBeGreaterThanOrEqual(2);
    rig.input.press('sprint');
    rig.frame(30);
    expect(p.sprinting).toBe(true);
    expect(p.horizontalSpeed).toBeCloseTo(MOVEMENT.ground.sprintSpeed, 1);
    // Backwards input cancels sprint.
    rig.input.move.y = -1;
    rig.frame(2);
    expect(p.sprinting).toBe(false);
  });

  it('jumps to the configured height and lands', () => {
    rig.frame(20);
    const y0 = rig.player.position.y;
    rig.input.press('jump');
    let maxY = y0;
    for (let i = 0; i < 90; i++) {
      rig.frame();
      maxY = Math.max(maxY, rig.player.position.y);
    }
    expect(count(rig.log, 'player:jump')).toBe(1);
    expect(maxY - y0).toBeGreaterThan(MOVEMENT.jump.height * 0.9);
    expect(maxY - y0).toBeLessThan(MOVEMENT.jump.height * 1.1);
    expect(count(rig.log, 'player:land')).toBe(1);
    expect(rig.player.state).toBe('ground');
  });

  it('releasing jump early cuts the jump short', () => {
    rig.frame(20);
    const y0 = rig.player.position.y;
    rig.input.press('jump');
    rig.frame(2);
    rig.input.release('jump');
    let maxY = y0;
    for (let i = 0; i < 90; i++) {
      rig.frame();
      maxY = Math.max(maxY, rig.player.position.y);
    }
    expect(maxY - y0).toBeLessThan(MOVEMENT.jump.height * 0.85);
  });

  it('double jumps once per airtime (only when unlocked)', () => {
    rig.frame(20);
    rig.input.press('jump');
    rig.frame(20);
    rig.input.tap('jump');
    let maxY = 0;
    for (let i = 0; i < 20; i++) {
      rig.frame();
      maxY = Math.max(maxY, rig.player.position.y);
    }
    // Third press in the same airtime does nothing.
    rig.input.tap('jump');
    rig.frame(1);
    expect(count(rig.log, 'player:jump')).toBe(2);
    expect(maxY).toBeGreaterThan(MOVEMENT.jump.height + MOVEMENT.jump.doubleJumpHeight * 0.6);
    rig.frame(120);
    expect(rig.player.grounded).toBe(true);

    rig.player.unlocks.doubleJump = false;
    rig.log.length = 0;
    rig.input.press('jump');
    rig.frame(20);
    rig.input.tap('jump');
    rig.frame(5);
    expect(count(rig.log, 'player:jump')).toBe(1);
  });

  it('coyote time allows a jump shortly after walking off a ledge', async () => {
    const r = await createRig({ x: 20, y: 1.2, z: -21 });
    r.frame(20);
    expect(r.player.grounded).toBe(true);
    // Walk towards +z off the platform edge (z = -20).
    r.player.yaw = Math.PI;
    r.input.move.y = 1;
    let leftGround = -1;
    for (let i = 0; i < 60 && leftGround < 0; i++) {
      r.frame();
      if (!r.player.grounded) leftGround = i;
    }
    expect(leftGround).toBeGreaterThan(0);
    r.input.press('jump');
    r.frame(2);
    expect(count(r.log, 'player:jump')).toBe(1);
    expect(r.player.velocity.y).toBeGreaterThan(0);
  });

  it('slides along walls and loses into-wall momentum in the air', () => {
    rig.player.teleport({ x: 8, y: 0, z: 0 }, -Math.PI / 4); // facing +x/-z diagonal
    rig.frame(10);
    rig.input.move.y = 1;
    rig.frame(40);
    const p = rig.player;
    expect(p.position.x).toBeLessThanOrEqual(9.5 - MOVEMENT.collider.radius + 1e-3);
    // Actually moving along the wall, not into it.
    expect(Math.abs(p.actualVelocity.x)).toBeLessThan(0.3);
    expect(p.actualVelocity.z).toBeLessThan(-3);
    // Airborne: the into-wall component must be clipped so no hidden momentum builds up.
    rig.input.press('jump');
    rig.frame(6);
    expect(p.state).toBe('air');
    expect(p.velocity.x).toBeLessThan(0.5);
    expect(p.velocity.z).toBeLessThan(-2);
  });

  it('stays crouched under a low ceiling and stands up once there is headroom', () => {
    rig.player.teleport({ x: -6, y: 0, z: 0 }, Math.PI / 2); // facing -x
    rig.frame(10);
    rig.input.press('crouch');
    rig.frame(5);
    expect(rig.player.crouched).toBe(true);
    rig.input.move.y = 1;
    rig.frame(90);
    expect(rig.player.position.x).toBeLessThan(-9);
    rig.input.move.y = 0;
    rig.input.release('crouch');
    rig.frame(20);
    expect(rig.player.crouched).toBe(true);
    // Walk out the other side.
    rig.input.move.y = 1;
    rig.frame(90);
    expect(rig.player.position.x).toBeLessThan(-12.5);
    expect(rig.player.crouched).toBe(false);
  });

  it('slides when crouching at sprint speed and ends the slide later', () => {
    rig.player.teleport({ x: 0, y: 0, z: 20 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    rig.frame(40);
    rig.input.press('crouch');
    rig.frame(2);
    expect(rig.player.state).toBe('slide');
    expect(rig.player.horizontalSpeed).toBeGreaterThan(MOVEMENT.ground.sprintSpeed + 1);
    expect(count(rig.log, 'player:slideStart')).toBe(1);
    rig.frame(Math.ceil(MOVEMENT.slide.maxDuration / DT) + 5);
    expect(rig.player.state).toBe('ground');
    expect(rig.player.crouched).toBe(true);
    expect(count(rig.log, 'player:slideEnd')).toBe(1);
  });

  it('dashes with charges that recharge sequentially', () => {
    rig.frame(20);
    const z0 = rig.player.position.z;
    // Edges pressed this frame are consumed by this frame's tick.
    rig.input.tap('dash');
    rig.frame(2);
    expect(rig.player.state).toBe('dash');
    expect(rig.player.dashCharges).toBe(1);
    rig.frame(11);
    // No input: dash follows the look direction (-z).
    const dist = z0 - rig.player.position.z;
    expect(dist).toBeGreaterThan(3);
    expect(dist).toBeLessThan(6);
    expect(rig.player.state).toBe('ground');
    expect(count(rig.log, 'player:dash')).toBe(1);
    expect(count(rig.log, 'camera:shake')).toBe(1);
    rig.frame(Math.ceil(MOVEMENT.dash.minInterval / DT));
    rig.input.tap('dash');
    rig.frame(2);
    expect(rig.player.dashCharges).toBe(0);
    rig.frame(15);
    // Out of charges: nothing happens.
    rig.input.tap('dash');
    rig.frame(2);
    expect(count(rig.log, 'player:dash')).toBe(2);
    rig.frame(Math.ceil(MOVEMENT.dash.rechargeTime / DT) + 2);
    expect(rig.player.dashCharges).toBe(1);
    rig.frame(Math.ceil(MOVEMENT.dash.rechargeTime / DT) + 2);
    expect(rig.player.dashCharges).toBe(2);
    expect(rig.player.dashRecharge).toBe(1);
  });

  it('mantles onto a chest-high platform', () => {
    // Platform face towards +z is at z = -20; stand in front of it facing -z.
    rig.player.teleport({ x: 20, y: 0, z: -19.2 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('jump');
    rig.frame(2);
    expect(rig.player.state).toBe('mantle');
    expect(count(rig.log, 'player:mantle')).toBe(1);
    rig.frame(40);
    expect(rig.player.position.y).toBeGreaterThan(1.15);
    expect(rig.player.position.z).toBeLessThan(-20);
    expect(rig.player.grounded).toBe(true);
  });

  it('auto-mantles when airborne and pushing forward into a ledge', () => {
    rig.player.teleport({ x: 20, y: 0, z: -17 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    rig.frame(5);
    rig.input.press('jump');
    rig.input.release('jump');
    rig.frame(40);
    expect(count(rig.log, 'player:mantle')).toBe(1);
    rig.input.move.y = 0;
    rig.frame(30);
    expect(rig.player.position.y).toBeGreaterThan(1.15);
    expect(rig.player.state).toBe('ground');
  });

  it('climbs stairs smoothly via autostep', () => {
    rig.player.teleport({ x: -20, y: 0, z: -1 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    let maxEyeJump = 0;
    let prevEye = rig.player.eyePosition.y;
    // ~0.9 s at run speed ends on the top landing (z ∈ [-8.8, -4.8], y = 1.6).
    for (let i = 0; i < 55; i++) {
      rig.frame();
      maxEyeJump = Math.max(maxEyeJump, rig.player.eyePosition.y - prevEye);
      prevEye = rig.player.eyePosition.y;
    }
    expect(rig.player.position.y).toBeGreaterThan(1.55);
    expect(rig.player.grounded).toBe(true);
    // Stair smoothing: the eye never pops a full step in one frame.
    expect(maxEyeJump).toBeLessThan(0.15);
  });

  it('pushes dynamic crates', async () => {
    const r = await createRig({ x: 20, y: 0, z: 14 });
    const crate = r.physics.addDynamicBox({ x: 20, y: 0.5, z: 10 }, { x: 0.5, y: 0.5, z: 0.5 }, null);
    r.frame(30);
    r.input.move.y = 1;
    r.frame(180);
    expect(crate.translation().z).toBeLessThan(9);
  });

  it('noclip flies through geometry and teleport resets state', () => {
    rig.frame(10);
    rig.player.noclip = true;
    expect(rig.player.state).toBe('noclip');
    rig.player.yaw = -Math.PI / 2; // face +x
    rig.input.move.y = 1;
    rig.frame(60);
    expect(rig.player.position.x).toBeGreaterThan(12);
    rig.player.noclip = false;
    rig.input.move.y = 0;
    rig.player.teleport({ x: 1, y: 0, z: 1 }, 0.5);
    expect(rig.player.position.x).toBe(1);
    expect(rig.player.yaw).toBe(0.5);
    expect(count(rig.log, 'player:teleported')).toBe(1);
    rig.frame(30);
    expect(rig.player.grounded).toBe(true);
  });

  it('slides faster down a steep ramp (slope acceleration beats slide deceleration)', () => {
    rig.player.teleport({ x: 27.5, y: 4.8, z: -0.6 }, 0); // facing -z = downhill
    rig.frame(10);
    expect(rig.player.grounded).toBe(true);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    rig.frame(20);
    rig.input.press('crouch');
    rig.frame(2);
    expect(rig.player.state).toBe('slide');
    const startSpeed = rig.player.horizontalSpeed;
    rig.frame(20);
    expect(rig.player.state).toBe('slide');
    expect(rig.player.position.z).toBeGreaterThan(-10);
    expect(rig.player.horizontalSpeed).toBeGreaterThan(startSpeed + 0.5);
  });

  it('landing at speed with crouch held starts a slide', () => {
    rig.player.teleport({ x: 0, y: 0, z: 20 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    rig.frame(40);
    rig.input.press('jump');
    rig.frame(3);
    rig.input.release('jump');
    rig.input.press('crouch');
    let slid = false;
    for (let i = 0; i < 60 && !slid; i++) {
      rig.frame();
      slid = rig.player.state === 'slide';
    }
    expect(slid).toBe(true);
    expect(count(rig.log, 'player:land')).toBe(1);
  });

  it('a buffered jump cancels the dash and keeps the exit momentum', () => {
    rig.frame(20);
    rig.input.tap('dash');
    rig.frame(4);
    expect(rig.player.state).toBe('dash');
    rig.input.press('jump');
    rig.frame(2);
    expect(rig.player.state).toBe('air');
    expect(rig.player.velocity.y).toBeGreaterThan(0);
    const exit = MOVEMENT.dash.speed * MOVEMENT.dash.exitSpeedFraction;
    expect(Math.hypot(rig.player.velocity.x, rig.player.velocity.z)).toBeGreaterThan(exit * 0.9);
  });

  it('toggle crouch stays crouched after release and toggles back', () => {
    const r = rig;
    r.player.teleport({ x: 0, y: 0, z: 20 }, 0);
    // Settings are read every tick, so switching at runtime works.
    r.settings.update('controls', { toggleCrouch: true });
    r.frame(10);
    r.input.press('crouch');
    r.frame(2);
    r.input.release('crouch');
    r.frame(10);
    expect(r.player.crouched).toBe(true);
    r.input.tap('crouch');
    r.frame(3);
    expect(r.player.crouched).toBe(false);
  });

  it('heavy landings emit a heavy land event and camera shake', () => {
    let heavy = false;
    rig.events.on('player:land', (e) => {
      heavy = e.heavy;
    });
    rig.player.teleport({ x: 0, y: 7, z: 20 }, 0);
    rig.frame(90);
    expect(heavy).toBe(true);
    expect(count(rig.log, 'camera:shake')).toBe(1);
  });

  it('consumes a press in the same frame (no extra frame of input latency) and only once', () => {
    rig.frame(20);
    rig.input.press('jump');
    rig.frame(1);
    expect(rig.player.state).toBe('air');
    expect(count(rig.log, 'player:jump')).toBe(1);
    // Several ticks in one frame must not see the same edge twice (would double jump).
    rig.player.fixedUpdate(DT);
    rig.physics.step(DT);
    rig.player.fixedUpdate(DT);
    rig.physics.step(DT);
    expect(count(rig.log, 'player:jump')).toBe(1);
    rig.player.update(DT, 1);
    rig.input.endFrame();
    rig.frame(90);
    expect(rig.player.grounded).toBe(true);
    // A frame without a tick (high refresh rate): update() latches, the next tick jumps once.
    rig.input.press('jump');
    rig.player.update(DT, 0.5);
    rig.input.endFrame();
    rig.frame(2);
    expect(count(rig.log, 'player:jump')).toBe(2);
  });

  it('keeps velocity honest against walls on the ground (no slide from standing at a wall)', () => {
    rig.player.teleport({ x: 7, y: 0, z: 0 }, -Math.PI / 2); // facing +x, wall face at x = 9.5
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    rig.frame(60);
    const p = rig.player;
    expect(p.state).toBe('ground');
    expect(Math.abs(p.velocity.x)).toBeLessThan(0.5);
    rig.input.press('crouch');
    rig.frame(5);
    expect(count(rig.log, 'player:slideStart')).toBe(0);
  });

  it('slides off a steep slope instead of sticking, without a fake terminal-velocity landing', async () => {
    let impact = 0;
    rig.events.on('player:land', (e) => {
      impact = Math.max(impact, e.impactSpeed);
    });
    rig.player.teleport({ x: -27.5, y: 3.5, z: 22 }, 0);
    rig.frame(150);
    const p = rig.player;
    expect(p.grounded).toBe(true);
    expect(p.position.y).toBeLessThan(0.1);
    expect(p.position.z).toBeLessThan(20.1);
    // Physically ~a 3.5 m drop; never the accumulated terminal velocity.
    expect(impact).toBeLessThan(
      Math.sqrt(2 * MOVEMENT.air.gravity * MOVEMENT.air.fallGravityMultiplier * 3.5) + 1,
    );
  });

  it('vaults a thin wall with jump + forward, but a jump in place stays a jump', () => {
    rig.player.teleport({ x: 0, y: 0, z: 28.8 }, Math.PI); // facing +z, wall face at z = 29.9
    rig.frame(10);
    rig.input.press('jump');
    rig.frame(3);
    rig.input.release('jump');
    rig.frame(60);
    expect(count(rig.log, 'player:mantle')).toBe(0);
    expect(rig.player.position.z).toBeLessThan(29.9);
    rig.input.move.y = 1;
    rig.frame(8);
    rig.input.press('jump');
    rig.frame(1);
    expect(rig.player.state).toBe('mantle');
    rig.input.release('jump');
    rig.frame(30);
    expect(rig.player.position.z).toBeGreaterThan(30.1);
  });

  it('never mantles through a thin tall wall onto a platform behind it', () => {
    rig.player.teleport({ x: 33, y: 0, z: 20.6 }, 0); // facing -z towards the wall
    rig.frame(10);
    rig.input.move.y = 1;
    rig.frame(5);
    rig.input.press('jump');
    rig.frame(60);
    expect(count(rig.log, 'player:mantle')).toBe(0);
    expect(rig.player.position.z).toBeGreaterThan(20);
  });

  it('a stray jump press without an available jump does not cancel a dash', () => {
    rig.frame(20);
    rig.input.press('jump');
    rig.frame(10);
    rig.input.tap('jump'); // double jump
    rig.frame(10);
    expect(count(rig.log, 'player:jump')).toBe(2);
    rig.input.tap('jump'); // nothing left to jump with
    rig.input.tap('dash');
    rig.frame(3);
    expect(rig.player.state).toBe('dash');
  });

  it('stair smoothing never moves the eye against the climb direction (alpha < 1)', () => {
    // A step pop drawn half interpolated, half offset moved the eye 2-11 cm the wrong way. What
    // remains is millimetres of real feet motion (controller offset at the first step's nosing).
    const MAX_WRONG_WAY = 0.01;
    for (const [hz, phase] of [
      [144, 0],
      [60, 0.05],
      [240, 0.5],
    ] as const) {
      const p = rig.player;
      p.teleport({ x: -20, y: 0, z: -1 }, 0);
      rig.frame(10);
      rig.input.move.y = 1;
      let prev = p.eyePosition.y;
      let wrongWay = 0;
      // Up the stairs (0.2 m box steps) onto the landing...
      runAtRefreshRate(rig, hz, 1, phase, () => {
        wrongWay = Math.max(wrongWay, prev - p.eyePosition.y);
        prev = p.eyePosition.y;
      });
      expect(p.position.y).toBeGreaterThan(1.55);
      expect(wrongWay).toBeLessThan(MAX_WRONG_WAY);
      // ...and back down.
      p.yaw = Math.PI;
      wrongWay = 0;
      runAtRefreshRate(rig, hz, 1.2, phase, () => {
        wrongWay = Math.max(wrongWay, p.eyePosition.y - prev);
        prev = p.eyePosition.y;
      });
      expect(p.position.y).toBeLessThan(0.05);
      expect(wrongWay).toBeLessThan(MAX_WRONG_WAY);
      rig.input.move.y = 0;
    }
  });

  it('stands, jumps and walks in a V crevice of two too-steep slopes', () => {
    const doubles: boolean[] = [];
    rig.events.on('player:jump', (e) => doubles.push(e.double));
    const p = rig.player;
    p.teleport({ x: -37, y: 1.5, z: 34 }, -Math.PI / 2); // facing +x, along the crease
    rig.frame(60);
    expect(p.grounded).toBe(true);
    expect(p.state).toBe('ground');
    for (let i = 0; i < 2; i++) {
      rig.input.tap('jump');
      rig.frame(45);
      expect(p.grounded).toBe(true);
    }
    expect(doubles).toEqual([false, false]);
    const x0 = p.position.x;
    rig.input.move.y = 1;
    rig.frame(60);
    // Ground speed, not the 0.9 m/s air-strafe cap.
    expect(p.position.x - x0).toBeGreaterThan(MOVEMENT.ground.runSpeed * 0.75);
  });

  it('a crouched mantle never lifts the capsule through a beam above the player', () => {
    const p = rig.player;
    p.teleport({ x: 34, y: 0, z: -29.3 }, 0); // under the beam, facing the ledge face (z = -31)
    rig.input.press('crouch');
    rig.frame(10);
    rig.input.move.y = 1;
    rig.frame(30);
    expect(p.crouched).toBe(true);
    rig.input.press('jump');
    let maxY = 0;
    for (let i = 0; i < 40; i++) {
      rig.frame();
      maxY = Math.max(maxY, p.position.y);
    }
    expect(count(rig.log, 'player:mantle')).toBe(0);
    // Crouched head (1.1 m) stays below the beam bottom (1.2 m).
    expect(maxY).toBeLessThan(1.2 - MOVEMENT.collider.crouchHeight + 0.02);

    // Without an obstacle overhead a crouched mantle still works.
    rig.input.release('jump');
    rig.input.move.y = 0;
    p.teleport({ x: 20, y: 0, z: -19.2 }, 0);
    rig.frame(10);
    expect(p.crouched).toBe(true);
    rig.input.move.y = 1;
    rig.input.press('jump');
    rig.frame(2);
    expect(p.state).toBe('mantle');
    rig.input.release('crouch');
    rig.frame(40);
    expect(p.position.y).toBeGreaterThan(1.15);
  });

  it('slide-hop chains can not stack the slide boost', () => {
    const p = rig.player;
    p.teleport({ x: 5, y: 0, z: 38 }, 0); // clear lane along -z
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    rig.frame(40);
    let hops = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 360 && p.position.z > -36; i++) {
      // Land in a slide on every third hop (re-earning the cooldown in between), jump right away.
      if (p.grounded && p.state !== 'air') {
        rig.input.tap('jump');
        hops++;
        if (hops % 3 === 0) rig.input.press('crouch');
        else rig.input.release('crouch');
      }
      rig.frame();
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.velocity.x, p.velocity.z));
    }
    expect(hops).toBeGreaterThan(6);
    expect(count(rig.log, 'player:slideStart')).toBeGreaterThanOrEqual(2);
    expect(maxSpeed).toBeLessThan(MOVEMENT.ground.sprintSpeed + MOVEMENT.slide.startBoost + 0.05);
  });

  it('a short tap gives the same hop whether pressed on the ground or buffered before landing', () => {
    const p = rig.player;
    p.unlocks.doubleJump = false;
    rig.frame(20);
    const apexAfterJump = (n: number): number => {
      let jumps = 0;
      let maxY = 0;
      const off = rig.events.on('player:jump', () => jumps++);
      for (let i = 0; i < 90; i++) {
        rig.frame();
        if (jumps >= n) maxY = Math.max(maxY, p.position.y);
      }
      off();
      return maxY;
    };
    // Ground tap: held for a single frame.
    rig.input.press('jump');
    rig.frame(1);
    rig.input.release('jump');
    const groundTap = apexAfterJump(0);
    expect(p.grounded).toBe(true);
    // Buffered tap: a full jump, then the same one-frame tap shortly before touchdown.
    rig.input.press('jump');
    rig.frame(20);
    rig.input.release('jump');
    while (p.position.y > 0.35 || p.velocity.y > 0) rig.frame();
    rig.input.press('jump');
    rig.frame(1);
    rig.input.release('jump');
    const buffered = apexAfterJump(1);
    expect(groundTap).toBeGreaterThan(MOVEMENT.jump.height * 0.7);
    expect(Math.abs(buffered - groundTap)).toBeLessThan(0.03);
  });

  it('a press just before landing waits for the ground jump instead of spending the double jump', () => {
    const doubles: boolean[] = [];
    rig.events.on('player:jump', (e) => doubles.push(e.double));
    const p = rig.player;
    rig.frame(20);
    rig.input.press('jump');
    rig.frame(20);
    rig.input.release('jump');
    while (p.position.y > 0.2 || p.velocity.y > 0) rig.frame();
    rig.input.tap('jump');
    rig.frame(6);
    expect(doubles).toEqual([false, false]);
    expect(p.velocity.y).toBeGreaterThan(0);
    // The double jump is still available in this airtime.
    rig.frame(10);
    rig.input.tap('jump');
    rig.frame(1);
    expect(doubles).toEqual([false, false, true]);
    // High above the ground a press is a double jump right away.
    rig.frame(120);
    rig.input.press('jump');
    rig.frame(20);
    rig.input.release('jump');
    while (p.position.y > 0.9 || p.velocity.y > 0) rig.frame();
    rig.input.tap('jump');
    rig.frame(1);
    expect(doubles).toEqual([false, false, true, false, true]);
  });

  it('keeps a dash and a toggle-crouch pressed during a mantle', () => {
    const p = rig.player;
    p.teleport({ x: 20, y: 0, z: -19.2 }, 0);
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('jump');
    rig.frame(2);
    rig.input.release('jump');
    expect(p.state).toBe('mantle');
    rig.input.tap('dash');
    rig.frame(1);
    expect(p.state).toBe('mantle');
    expect(count(rig.log, 'player:dash')).toBe(0);
    rig.frame(30);
    expect(count(rig.log, 'player:dash')).toBe(1);

    rig.settings.update('controls', { toggleCrouch: true });
    rig.input.move.y = 0;
    p.teleport({ x: 20, y: 0, z: -19.2 }, 0);
    rig.frame(40);
    rig.input.move.y = 1;
    rig.input.press('jump');
    rig.frame(2);
    rig.input.release('jump');
    expect(p.state).toBe('mantle');
    rig.input.tap('crouch');
    rig.frame(1);
    rig.input.move.y = 0;
    rig.frame(30);
    expect(p.state).toBe('ground');
    expect(p.crouched).toBe(true);
  });

  it('does not start a slide while pushing a heavy crate (real motion is too slow)', async () => {
    const r = await createRig({ x: 20, y: 0, z: 14 });
    r.physics.addDynamicBox({ x: 20, y: 1, z: 10.5 }, { x: 1, y: 1, z: 1 }, null);
    r.frame(20);
    r.input.move.y = 1;
    r.input.press('sprint');
    r.frame(60);
    expect(r.player.horizontalSpeed).toBeLessThan(MOVEMENT.slide.minStartSpeed);
    r.input.press('crouch');
    r.frame(3);
    expect(count(r.log, 'player:slideStart')).toBe(0);
  });

  it('can slide right out of a sprint vault', () => {
    const p = rig.player;
    p.teleport({ x: 20, y: 0, z: -12 }, 0); // sprint towards the 1.2 m platform (face z = -20)
    rig.frame(10);
    rig.input.move.y = 1;
    rig.input.press('sprint');
    while (p.position.z > -19.1) rig.frame();
    rig.input.press('jump');
    rig.frame(1);
    rig.input.release('jump');
    expect(p.state).toBe('mantle');
    while (p.state === 'mantle') rig.frame();
    rig.input.press('crouch');
    rig.frame(1);
    expect(count(rig.log, 'player:slideStart')).toBe(1);
  });

  it('does not report sprinting while held crouched by a low ceiling', () => {
    const p = rig.player;
    p.teleport({ x: -6, y: 0, z: 0 }, Math.PI / 2); // facing -x
    rig.frame(10);
    rig.input.press('crouch');
    rig.input.move.y = 1;
    rig.frame(90);
    expect(p.position.x).toBeLessThan(-9);
    rig.input.release('crouch');
    rig.input.press('sprint');
    rig.frame(5);
    expect(p.crouched).toBe(true);
    expect(p.sprinting).toBe(false);
    rig.frame(90);
    expect(p.position.x).toBeLessThan(-12.5);
    expect(p.crouched).toBe(false);
    expect(p.sprinting).toBe(true);
  });

  it('dispose removes the body and collider', () => {
    rig.frame(2);
    const before = rig.physics.stats.colliders;
    rig.player.dispose();
    expect(rig.physics.stats.colliders).toBe(before - 1);
    rig.player.fixedUpdate(DT);
  });
});
