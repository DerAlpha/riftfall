import { beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
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

  it('dispose removes the body and collider', () => {
    rig.frame(2);
    const before = rig.physics.stats.colliders;
    rig.player.dispose();
    expect(rig.physics.stats.colliders).toBe(before - 1);
    rig.player.fixedUpdate(DT);
  });
});
