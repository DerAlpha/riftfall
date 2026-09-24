/**
 * Package C1 viewmodels in the real ViewmodelRig: ADS alignment, switches that never sweep a
 * weapon (or a long stock/butt) up through the view, sprint poses that stay out of the way.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { SettingsStore } from '../../../core/contracts';
import { EventBus } from '../../../core/EventBus';
import type { GameEvents } from '../../../core/events';
import { getViewmodelDef } from '../../../defs/viewmodels';
import { getWeaponDef } from '../../../defs/weapons';
import { PhysicsWorld } from '../../../physics/PhysicsWorld';
import { PlayerCamera } from '../../../player/PlayerCamera';
import { PlayerController } from '../../../player/PlayerController';
import { FakeInput, fakeRender, fakeSettings, type FakeRender } from '../../../player/testHelpers';
import { ViewmodelRig } from '../../../player/ViewmodelRig';

const DT = 1 / 60;
/** Frame-by-frame raycast sweeps: generous under a loaded parallel test run. */
const SLOW_TEST_MS = 60_000;
const IDS = ['revolver', 'machinepistol', 'smg', 'pdw', 'vector'] as const;
/** Fallback switch timing when a weapon def is not available. */
const FALLBACK = { holster: 0.24, equip: 0.38 };

describe('C1 viewmodels in the rig', () => {
  let physics: PhysicsWorld;
  let input: FakeInput;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let render: FakeRender;
  let player: PlayerController;
  let camera: PlayerCamera;
  let rig: ViewmodelRig;
  const ads = { adsAmount: 0 };

  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      player.fixedUpdate(DT);
      physics.step(DT);
      player.update(DT, 1);
      camera.update(DT);
      rig.update(DT);
      input.endFrame();
      render.camera.updateMatrixWorld();
      render.viewmodelCamera.quaternion.copy(render.camera.quaternion);
      render.viewmodelCamera.updateMatrixWorld();
    }
  };

  const viewSpace = (socket: 'muzzle' | 'ejectPort' | 'sight'): Vector3 => {
    const obj = rig.getSocketObject(socket);
    obj.updateWorldMatrix(true, false);
    return new Vector3()
      .setFromMatrixPosition(obj.matrixWorld)
      .applyMatrix4(render.viewmodelCamera.matrixWorldInverse);
  };

  beforeEach(async () => {
    physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 0.5, z: 40 });
    input = new FakeInput();
    events = new EventBus<GameEvents>();
    settings = fakeSettings();
    settings.update('accessibility', { cameraMotion: 0 });
    render = fakeRender();
    player = new PlayerController(
      { physics, input, events, settings },
      { position: { x: 0, y: 0, z: 0 }, yaw: 0.7 },
    );
    camera = new PlayerCamera({ player, input, render: render.api, events, settings });
    ads.adsAmount = 0;
    rig = new ViewmodelRig({ render: render.api, player, camera, events, ads });
  });

  it(
    'full ADS puts each sight socket on the view axis at its eye distance',
    () => {
      for (const id of IDS) {
        rig.showWeapon(id);
        expect(rig.currentWeaponModel?.weaponId, id).toBe(id);
        ads.adsAmount = 1;
        frame(60);
        const sight = viewSpace('sight');
        expect(Math.abs(sight.x), id).toBeLessThan(1e-3);
        expect(Math.abs(sight.y), id).toBeLessThan(1e-3);
        expect(sight.z, id).toBeCloseTo(-getViewmodelDef(id)!.adsEyeDistance, 2);
        // The muzzle is further out along the view axis, ahead of the sight.
        expect(viewSpace('muzzle').z, id).toBeLessThan(sight.z - 0.1);
        ads.adsAmount = 0;
        frame(60);
        // Hip: the weapon sits low and right of the crosshair.
        const hip = viewSpace('sight');
        expect(hip.x, id).toBeGreaterThan(0.05);
        expect(hip.y, id).toBeLessThan(-0.02);
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'switches between them never sweep a weapon (stock, butt, magazine) up through the view',
    () => {
      const ray = new Raycaster();
      const ndc = new Vector2();
      const probes: [number, number][] = [];
      for (const x of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9])
        for (const y of [0.05, 0.35, 0.7]) probes.push([x, y]);
      const clear = (label: string): void => {
        render.viewmodelScene.updateMatrixWorld(true);
        for (const [x, y] of probes) {
          ray.setFromCamera(ndc.set(x, y), render.viewmodelCamera);
          expect(ray.intersectObject(rig.root, true).length, `${label} @ ${x},${y}`).toBe(0);
        }
      };
      const timing = (id: string): { holster: number; equip: number } => {
        const w = getWeaponDef(id);
        return w ? { holster: w.holsterTime, equip: w.equipTime } : FALLBACK;
      };
      rig.showWeapon('revolver');
      frame(20);
      clear('revolver hip');
      const order = ['pdw', 'machinepistol', 'vector', 'smg', 'revolver', 'pdw', 'rifle', 'vector', 'pistol'];
      let prev = 'revolver';
      for (const next of order) {
        const h = timing(prev).holster;
        const e = timing(next).equip;
        events.emit('weapon:holsterStart', { weaponId: prev, slot: 0, duration: h, next });
        events.emit('weapon:equipStart', { weaponId: next, slot: 1, duration: h + e, previous: prev });
        const n = Math.ceil((h + e) / DT) + 10;
        for (let i = 0; i < n; i++) {
          frame(1);
          clear(`${prev} → ${next} frame ${i}`);
        }
        expect(rig.currentWeaponId).toBe(next);
        prev = next;
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'reloads keep every weapon below the upper third of the screen',
    () => {
      const ray = new Raycaster();
      const ndc = new Vector2();
      for (const id of IDS) {
        rig.showWeapon(id);
        frame(30);
        const w = getWeaponDef(id);
        const duration = w?.reload.empty ?? 2;
        const steps = w?.reload.emptySteps ?? [];
        events.emit('weapon:reloadStart', { weaponId: id, empty: true, duration });
        let t = 0;
        let next = 0;
        while (t < duration + 0.3) {
          frame(1);
          t += DT;
          while (next < steps.length && steps[next]!.at <= t) {
            events.emit('weapon:reloadStep', { weaponId: id, step: steps[next]!.step });
            next++;
          }
          render.viewmodelScene.updateMatrixWorld(true);
          for (const x of [-0.6, -0.3, 0, 0.3, 0.6]) {
            ray.setFromCamera(ndc.set(x, 0.45), render.viewmodelCamera);
            expect(ray.intersectObject(rig.root, true).length, `${id} reload t=${t.toFixed(2)} @ ${x}`).toBe(
              0,
            );
          }
        }
        events.emit('weapon:reloadEnd', { weaponId: id, completed: true });
        frame(30);
      }
    },
    SLOW_TEST_MS,
  );
});
