import { beforeEach, describe, expect, it } from 'vitest';
import { Mesh, Object3D } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { DEG2RAD } from '../core/math';
import { CAMERA, VIEWMODEL } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import type { SettingsStore } from '../core/contracts';
import {
  addTrauma,
  decayTrauma,
  horizontalToVerticalFov,
  springImpulseForPeak,
  stepSpringSubstepped,
  verticalToHorizontalFov,
} from './cameraMath';
import { PlayerCamera } from './PlayerCamera';
import { PlayerController } from './PlayerController';
import { FakeInput, fakeRender, fakeSettings, type FakeRender } from './testHelpers';
import { ViewmodelRig } from './ViewmodelRig';

const DT = 1 / 60;

describe('cameraMath', () => {
  it('converts horizontal FOV at 16:9 to vertical and back', () => {
    const v = horizontalToVerticalFov(90, 16 / 9);
    expect(v).toBeCloseTo(58.7155, 3);
    expect(verticalToHorizontalFov(v, 16 / 9)).toBeCloseTo(90, 9);
    expect(horizontalToVerticalFov(CAMERA.maxFov, CAMERA.fovReferenceAspect)).toBeLessThan(CAMERA.maxFov);
  });

  it('trauma adds and decays within [0, 1]', () => {
    expect(addTrauma(0.9, 0.5)).toBe(1);
    expect(decayTrauma(0.1, 1, 1)).toBe(0);
    expect(decayTrauma(0.5, 1, 0.25)).toBeCloseTo(0.25);
  });

  it('spring impulse peaks near the requested dip and substepping stays stable', () => {
    const s = { value: 0, velocity: -springImpulseForPeak(0.1, CAMERA.landing.stiffness) };
    let min = 0;
    for (let i = 0; i < 120; i++) {
      stepSpringSubstepped(s, 0, CAMERA.landing.stiffness, CAMERA.landing.damping, DT, CAMERA.maxSpringStep);
      min = Math.min(min, s.value);
    }
    expect(min).toBeLessThan(-0.08);
    expect(min).toBeGreaterThan(-0.16);
    expect(Math.abs(s.value)).toBeLessThan(1e-3);
    // A huge frame delta must not explode.
    const big = { value: 1, velocity: 0 };
    stepSpringSubstepped(big, 0, 400, 10, 0.25, CAMERA.maxSpringStep);
    expect(Number.isFinite(big.value)).toBe(true);
    expect(Math.abs(big.value)).toBeLessThan(1);
  });
});

describe('PlayerCamera + ViewmodelRig', () => {
  let physics: PhysicsWorld;
  let input: FakeInput;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let render: FakeRender;
  let player: PlayerController;
  let camera: PlayerCamera;
  let viewmodel: ViewmodelRig;

  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      player.fixedUpdate(DT);
      physics.step(DT);
      player.update(DT, 1);
      camera.update(DT);
      viewmodel.update(DT);
      input.endFrame();
    }
  };

  beforeEach(async () => {
    physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 0.5, z: 40 });
    physics.addStaticBox({ x: 0, y: 2, z: -12 }, { x: 5, y: 2, z: 0.5 });
    input = new FakeInput();
    events = new EventBus<GameEvents>();
    settings = fakeSettings();
    render = fakeRender();
    player = new PlayerController(
      { physics, input, events, settings },
      { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    camera = new PlayerCamera({ player, input, render: render.api, events, settings });
    viewmodel = new ViewmodelRig({ render: render.api, player, camera, events });
  });

  it('places the camera at the eye and converts the FOV setting', () => {
    frame(30);
    expect(render.camera.position.distanceTo(player.eyePosition)).toBeLessThan(1e-6);
    expect(render.fovCalls.length).toBeGreaterThan(0);
    expect(render.camera.fov).toBeCloseTo(
      horizontalToVerticalFov(settings.current.controls.fov, CAMERA.fovReferenceAspect),
      1,
    );
  });

  it('applies look to player yaw/pitch with ADS scaling and pitch clamp', () => {
    frame(5);
    input.look.yaw = 0.1; // turn right
    frame(1);
    expect(player.yaw).toBeCloseTo(-0.1, 6);
    expect(camera.lookDelta.yaw).toBeCloseTo(-0.1, 6);
    input.look.yaw = 0;
    input.look.pitch = 10;
    frame(1);
    expect(player.pitch).toBeCloseTo(CAMERA.pitchLimitDeg * DEG2RAD, 6);
    input.look.pitch = 0;
    // Full ADS: sensitivity multiplier applies.
    input.press('ads');
    frame(90);
    expect(player.adsAmount).toBeGreaterThan(0.99);
    const before = player.yaw;
    input.look.yaw = 0.1;
    frame(1);
    expect(before - player.yaw).toBeCloseTo(0.1 * settings.current.controls.adsSensitivityMultiplier, 3);
    input.look.yaw = 0;
    // ADS drives DoF, zooms the FOV and focuses on the wall 12 m ahead.
    expect(render.ads).toBeGreaterThan(0.99);
    expect(render.camera.fov).toBeLessThan(
      horizontalToVerticalFov(settings.current.controls.fov, CAMERA.fovReferenceAspect),
    );
    player.pitch = 0;
    player.yaw = 0;
    frame(2);
    expect(render.focus).toBeGreaterThan(10);
    expect(render.focus).toBeLessThan(12);
  });

  it('bobs while running and respects accessibility scaling', () => {
    frame(10);
    input.move.y = 1;
    frame(60);
    expect(camera.bobIntensity).toBeGreaterThan(0.5);
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      frame(1);
      maxDev = Math.max(maxDev, Math.abs(render.camera.position.y - player.eyePosition.y));
    }
    expect(maxDev).toBeGreaterThan(CAMERA.bob.verticalAmplitude * 0.5);
    settings.update('accessibility', { cameraMotion: 0 });
    frame(30);
    for (let i = 0; i < 30; i++) {
      frame(1);
      expect(Math.abs(render.camera.position.y - player.eyePosition.y)).toBeLessThan(1e-6);
      expect(Math.abs(render.camera.rotation.z)).toBeLessThan(1e-6);
    }
  });

  it('dips on landing and shakes on camera:shake (scaled by screenShake)', () => {
    frame(20);
    events.emit('player:land', {
      impactSpeed: 15,
      heavy: true,
      position: player.position,
      surface: 'default',
    });
    let minDip = 0;
    for (let i = 0; i < 30; i++) {
      frame(1);
      minDip = Math.min(minDip, camera.landingOffset);
    }
    expect(minDip).toBeLessThan(-0.1);
    events.emit('camera:shake', { trauma: 1 });
    frame(1);
    expect(camera.currentTrauma).toBeGreaterThan(0.9);
    frame(Math.ceil(1 / CAMERA.shake.decayPerSecond / DT) + 2);
    expect(camera.currentTrauma).toBe(0);
    settings.update('accessibility', { screenShake: 0 });
    events.emit('camera:shake', { trauma: 1 });
    frame(1);
    expect(render.camera.rotation.x).toBeCloseTo(player.pitch, 6);
  });

  it('viewmodel is parented to the viewmodel camera on the viewmodel layer and swaps models', () => {
    frame(5);
    expect(render.viewmodelCamera.parent).toBe(render.viewmodelScene);
    expect(viewmodel.root.parent).toBe(render.viewmodelCamera);
    let meshes = 0;
    viewmodel.currentModel.traverse((o) => {
      if (o instanceof Mesh) {
        meshes++;
        expect(o.layers.isEnabled(ENGINE.viewmodelLayer)).toBe(true);
        const mat = o.material as { emissiveIntensity?: number };
        expect(mat).toBeDefined();
      }
    });
    // Merged per material: a handful of draw calls.
    expect(meshes).toBeGreaterThan(3);
    expect(meshes).toBeLessThanOrEqual(8);
    // At rest the rig sits at the configured offset (small breathing aside).
    expect(Math.abs(viewmodel.root.position.x - VIEWMODEL.offset.x)).toBeLessThan(0.01);
    // The device lags behind a turn: turning right shifts it left and points the muzzle left.
    input.look.yaw = 0.05;
    frame(2);
    expect(viewmodel.root.position.x).toBeLessThan(VIEWMODEL.offset.x);
    expect(viewmodel.root.rotation.y).toBeGreaterThan(0);
    // Sway reacts to look but stays clamped.
    input.look.yaw = 0.5;
    frame(3);
    input.look.yaw = 0;
    expect(Math.abs(viewmodel.root.position.x - VIEWMODEL.offset.x)).toBeLessThanOrEqual(
      VIEWMODEL.sway.maxPosition + 0.03,
    );
    const custom = new Object3D();
    viewmodel.setModel(custom);
    expect(viewmodel.currentModel).toBe(custom);
    expect(custom.layers.isEnabled(ENGINE.viewmodelLayer)).toBe(true);
    viewmodel.setModel(null);
    expect(viewmodel.currentModel).not.toBe(custom);
    viewmodel.dispose();
    camera.dispose();
    expect(viewmodel.root.parent).toBeNull();
  });
});
