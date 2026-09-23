/**
 * Integration of the M2 hooks added to PlayerCamera (recoil, view punch, look modifier) and
 * PlayerController (ADS provider) with the weapon system.
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import type { LookOut, SettingsStore } from '../core/contracts';
import { DEG2RAD, RAD2DEG } from '../core/math';
import { CAMERA } from '../defs/camera';
import { MOVEMENT } from '../defs/movement';
import { WEAPONS } from '../defs/weapons';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CombatWorld } from '../combat/CombatWorld';
import { horizontalToVerticalFov } from '../player/cameraMath';
import { PlayerCamera, type LookModifier } from '../player/PlayerCamera';
import { PlayerController, type AdsProvider } from '../player/PlayerController';
import { FakeInput, fakeRender, fakeSettings, type FakeRender } from '../player/testHelpers';
import { WeaponSystem } from './WeaponSystem';

const DT = 1 / 60;

describe('PlayerCamera / PlayerController weapon hooks', () => {
  let physics: PhysicsWorld;
  let input: FakeInput;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let render: FakeRender;
  let player: PlayerController;
  let camera: PlayerCamera;

  const frame = (n = 1, extra?: () => void): void => {
    for (let i = 0; i < n; i++) {
      camera.applyLook();
      player.fixedUpdate(DT);
      extra?.();
      physics.step(DT);
      player.update(DT, 1);
      camera.update(DT);
      input.endFrame();
    }
  };

  beforeEach(async () => {
    physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 60, y: 0.5, z: 60 });
    input = new FakeInput();
    events = new EventBus<GameEvents>();
    settings = fakeSettings();
    render = fakeRender();
    player = new PlayerController(
      { physics, input, events, settings },
      { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    camera = new PlayerCamera({ player, input, render: render.api, events, settings });
    frame(10);
  });

  it('addRecoil eases the kick onto the aim over its duration (not a snap)', () => {
    const kick = 2 * DEG2RAD;
    camera.addRecoil(kick, -0.5 * DEG2RAD, 0.05);
    frame(1);
    const afterOne = player.pitch;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(kick);
    // Ease-out: the first frame carries the biggest share.
    frame(1);
    expect(player.pitch - afterOne).toBeLessThan(afterOne);
    frame(5);
    expect(player.pitch).toBeCloseTo(kick, 9);
    expect(player.yaw).toBeCloseTo(-0.5 * DEG2RAD, 9);
    // Immediate recovery steps land with the next update; the pitch limit holds.
    camera.addRecoil(-kick, 0);
    frame(1);
    expect(player.pitch).toBeCloseTo(0, 9);
    camera.takeRecoilPitchLoss();
    camera.addRecoil(Math.PI, 0);
    frame(1);
    expect(player.pitch).toBeCloseTo(CAMERA.pitchLimitDeg * DEG2RAD, 9);
    // The swallowed part is reported once (the weapon then never "recovers" it).
    expect(camera.takeRecoilPitchLoss()).toBeCloseTo(Math.PI - CAMERA.pitchLimitDeg * DEG2RAD, 9);
    expect(camera.takeRecoilPitchLoss()).toBe(0);
    camera.addRecoil(Number.NaN, 0, 0.1);
    frame(1);
    expect(Number.isFinite(player.pitch)).toBe(true);
  });

  it('many overlapping kicks never lose recoil', () => {
    for (let i = 0; i < 40; i++) camera.addRecoil(0.1 * DEG2RAD, 0, 0.2);
    frame(30);
    expect(player.pitch).toBeCloseTo(4 * DEG2RAD, 9);
  });

  it('view punch is visual only, springs back and follows the screen-shake setting', () => {
    camera.addViewPunch(3 * DEG2RAD, 0, 2 * DEG2RAD);
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      frame(1);
      peak = Math.max(peak, render.camera.rotation.x - player.pitch);
    }
    expect(peak).toBeGreaterThan(2 * DEG2RAD);
    expect(peak).toBeLessThanOrEqual(3 * DEG2RAD * 1.01);
    expect(player.pitch).toBe(0);
    frame(90);
    expect(Math.abs(camera.viewPunchPitch)).toBeLessThan(1e-3);
    settings.update('accessibility', { screenShake: 0 });
    camera.addViewPunch(3 * DEG2RAD, 0, 0);
    frame(3);
    expect(render.camera.rotation.x).toBeCloseTo(player.pitch, 9);
  });

  it('look modifier replaces ADS sensitivity and zoom', () => {
    const mod: LookModifier = {
      modifyLook(look: LookOut) {
        look.yaw *= 0.5;
        look.pitch *= 0.5;
      },
      fovMultiplier: 0.5,
    };
    camera.lookModifier = mod;
    input.look.yaw = 0.1;
    frame(1);
    expect(player.yaw).toBeCloseTo(-0.05, 9);
    input.look.yaw = 0;
    frame(120);
    const expected = horizontalToVerticalFov(settings.current.controls.fov * 0.5, CAMERA.fovReferenceAspect);
    expect(render.camera.fov).toBeCloseTo(expected, 2);
    camera.snapFov();
    expect(render.camera.fov).toBeCloseTo(expected, 6);
  });

  it('ADS provider drives adsAmount, ADS move speed and blocks sprinting', () => {
    const provider: { -readonly [K in keyof AdsProvider]: AdsProvider[K] } = {
      adsAmount: 0,
      adsMoveSpeedMultiplier: 0.5,
      blocksSprint: false,
    };
    player.adsProvider = provider;
    // Raw ADS input is ignored while a provider is set.
    input.press('ads');
    frame(30);
    expect(player.adsAmount).toBe(0);
    input.release('ads');
    // Sprint forward, then the provider blocks it.
    input.move.y = 1;
    input.press('sprint');
    frame(60);
    expect(player.sprinting).toBe(true);
    provider.blocksSprint = true;
    frame(2);
    expect(player.sprinting).toBe(false);
    provider.blocksSprint = false;
    input.release('sprint');
    frame(60);
    const runSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    expect(runSpeed).toBeCloseTo(MOVEMENT.ground.runSpeed, 0);
    provider.adsAmount = 1;
    frame(90);
    const adsSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    expect(adsSpeed).toBeCloseTo(MOVEMENT.ground.runSpeed * 0.5, 0);
    player.adsProvider = null;
    expect(player.adsAmount).toBe(0);
  });

  it('end to end: firing at the pitch limit never leaves the aim lower after recovery', () => {
    const combat = new CombatWorld({ events, physics });
    const weapons = new WeaponSystem(
      {
        events,
        input,
        settings,
        player,
        camera,
        render: render.api,
        combat,
        getMuzzleWorld: (o) => o.copy(render.camera.position),
      },
      { loadout: ['shotgun'], slots: 2 },
    );
    const frameW = (n: number): void => {
      for (let i = 0; i < n; i++) {
        frame(1, () => weapons.fixedUpdate(DT));
        weapons.update(DT);
      }
    };
    frameW(Math.ceil(WEAPONS.shotgun.equipTime / DT) + 2);
    const start = (CAMERA.pitchLimitDeg - 1) * DEG2RAD;
    player.pitch = start;
    input.tap('fire');
    frameW(1);
    frameW(120);
    expect(player.pitch).toBeCloseTo(start, 6);
    weapons.dispose();
  });

  it('end to end: a rifle burst kicks the camera up, recovery brings it back', () => {
    const combat = new CombatWorld({ events, physics });
    const weapons = new WeaponSystem(
      {
        events,
        input,
        settings,
        player,
        camera,
        render: render.api,
        combat,
        getMuzzleWorld: (o) => o.copy(render.camera.position),
      },
      { loadout: ['rifle'], slots: 2 },
    );
    const tickWeapons = (): void => weapons.fixedUpdate(DT);
    const frameW = (n: number): void => {
      for (let i = 0; i < n; i++) {
        frame(1, tickWeapons);
        weapons.update(DT);
      }
    };
    frameW(Math.ceil(WEAPONS.rifle.equipTime / DT) + 2);
    expect(weapons.state).toBe('idle');
    const pitch0 = player.pitch;
    input.press('fire');
    frameW(30);
    input.release('fire');
    expect(player.pitch - pitch0).toBeGreaterThan(3 * DEG2RAD);
    frameW(240);
    expect(Math.abs(player.pitch - pitch0)).toBeLessThan(0.05 * DEG2RAD);
    // ADS through the weapon: zoom + provider.
    input.press('ads');
    frameW(60);
    expect(player.adsAmount).toBe(1);
    expect(weapons.fovMultiplier).toBeCloseTo(WEAPONS.rifle.ads.zoom, 9);
    weapons.dispose();
    expect(player.adsProvider).toBeNull();
    expect(camera.lookModifier).toBeNull();
  });
  const makeWeapons = (loadout: string[]): WeaponSystem =>
    new WeaponSystem(
      {
        events,
        input,
        settings,
        player,
        camera,
        render: render.api,
        combat: new CombatWorld({ events, physics }),
        getMuzzleWorld: (o) => o.copy(render.camera.position),
      },
      { loadout, slots: 2 },
    );

  it('end to end: a short tap out of a held sprint fires once with every weapon, then the sprint resumes', () => {
    for (const id of ['pistol', 'rifle', 'shotgun'] as const) {
      const weapons = makeWeapons([id]);
      const shots: number[] = [];
      const off = events.on('weapon:fired', (e) => shots.push(e.shotIndex));
      const frameW = (n: number): void => {
        for (let i = 0; i < n; i++) {
          frame(1, () => weapons.fixedUpdate(DT));
          weapons.update(DT);
        }
      };
      frameW(Math.ceil(WEAPONS[id].equipTime / DT) + 2);
      input.move.y = 1;
      input.press('sprint');
      frameW(40);
      expect(player.sprinting).toBe(true);
      expect(weapons.state).toBe('sprinting');
      input.press('fire');
      frameW(4);
      input.release('fire');
      frameW(60);
      expect(shots, id).toHaveLength(1);
      expect(player.sprinting, id).toBe(true);
      input.release('sprint');
      input.move.y = 0;
      frameW(60);
      off();
      weapons.dispose();
    }
  });

  it('end to end: after a landing the shot goes where the camera (crosshair, sights) points', () => {
    const weapons = makeWeapons(['pistol']);
    const dirs: Vec3Like[] = [];
    events.on('weapon:fired', (e) => dirs.push({ ...e.direction }));
    const frameW = (n: number): void => {
      for (let i = 0; i < n; i++) {
        frame(1, () => weapons.fixedUpdate(DT));
        weapons.update(DT);
      }
    };
    frameW(Math.ceil(WEAPONS.pistol.equipTime / DT) + 2);
    events.emit('player:land', {
      impactSpeed: 8.8,
      heavy: false,
      position: { x: 0, y: 0, z: 0 },
      surface: 'concrete',
    });
    frameW(4);
    expect(Math.abs(camera.aimPitchOffset) * RAD2DEG).toBeGreaterThan(0.5);
    // Camera forward as rendered this frame = the crosshair.
    const fwd = render.camera.getWorldDirection(new Vector3());
    input.tap('fire');
    frameW(1);
    expect(dirs).toHaveLength(1);
    const d = dirs[0]!;
    const cos = Math.min(1, fwd.x * d.x + fwd.y * d.y + fwd.z * d.z);
    expect(Math.acos(cos) * RAD2DEG).toBeLessThan(0.01);
    weapons.dispose();
  });
});
