/**
 * Package C3 viewmodels in the real ViewmodelRig + animator: ADS alignment, switches and reloads
 * that never sweep a weapon up through the view, and the state drivers acting on the models
 * (railgun rails spread with the charge, the Kettenblitz rotor/prongs with the beam, the flame
 * tongue, the black hole ring with heat) plus the grenade launcher's shell-by-shell loading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Raycaster, Vector2, Vector3, type Object3D } from 'three';
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
const SLOW_TEST_MS = 120_000;
const IDS = [
  'plasma',
  'chainlightning',
  'railgun',
  'flamethrower',
  'grenadelauncher',
  'blackhole',
  'riftripper',
  'aetherharp',
  'cryonova',
] as const;
/** Fallback timing when a weapon def is not available. */
const FALLBACK = { holster: 0.3, equip: 0.55, reload: 2.6 };
const V0 = { x: 0, y: 0, z: 0 };

describe('C3 viewmodels in the rig', () => {
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

  const part = (name: string): Object3D => {
    const p = rig.currentWeaponModel?.parts[name];
    if (!p) throw new Error(`no part ${name}`);
    return p;
  };

  const upperClear = (label: string, ys: readonly number[], xs: readonly number[]): void => {
    const ray = new Raycaster();
    const ndc = new Vector2();
    render.viewmodelScene.updateMatrixWorld(true);
    for (const x of xs)
      for (const y of ys) {
        ray.setFromCamera(ndc.set(x, y), render.viewmodelCamera);
        expect(ray.intersectObject(rig.root, true).length, `${label} @ ${x},${y}`).toBe(0);
      }
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
        expect(viewSpace('muzzle').z, id).toBeLessThan(sight.z - 0.1);
        ads.adsAmount = 0;
        frame(60);
        const hip = viewSpace('sight');
        expect(hip.x, id).toBeGreaterThan(0.05);
        expect(hip.y, id).toBeLessThan(-0.01);
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'switches between them never sweep a weapon up through the view',
    () => {
      const timing = (id: string): { holster: number; equip: number } => {
        const w = getWeaponDef(id);
        return w ? { holster: w.holsterTime, equip: w.equipTime } : FALLBACK;
      };
      rig.showWeapon('plasma');
      frame(20);
      const order = [...IDS.slice(1), 'rifle', 'plasma'];
      let prev = 'plasma';
      for (const next of order) {
        const h = timing(prev).holster;
        const e = timing(next).equip;
        events.emit('weapon:holsterStart', { weaponId: prev, slot: 0, duration: h, next });
        events.emit('weapon:equipStart', { weaponId: next, slot: 1, duration: h + e, previous: prev });
        const n = Math.ceil((h + e) / DT) + 10;
        for (let i = 0; i < n; i++) {
          frame(1);
          upperClear(`${prev} → ${next} frame ${i}`, [0.05, 0.35, 0.7], [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]);
        }
        expect(rig.currentWeaponId).toBe(next);
        prev = next;
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'magazine reloads keep every weapon below the upper third of the screen',
    () => {
      for (const id of IDS) {
        if (getViewmodelDef(id)!.reload.style !== 'timeline') continue;
        rig.showWeapon(id);
        frame(30);
        const w = getWeaponDef(id);
        const duration = w?.reload.empty ?? FALLBACK.reload;
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
          upperClear(`${id} reload t=${t.toFixed(2)}`, [0.45], [-0.6, -0.3, 0, 0.3, 0.6]);
        }
        events.emit('weapon:reloadEnd', { weaponId: id, completed: true });
        frame(30);
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'grenade launcher: every loaded grenade shows up in the gate and indexes the drum 60°',
    () => {
      rig.showWeapon('grenadelauncher');
      events.emit('weapon:ammoChanged', { weaponId: 'grenadelauncher', mag: 0, reserve: 12, magSize: 6 });
      frame(30);
      const ps = getWeaponDef('grenadelauncher')?.reload.perShell ?? {
        start: 0.45,
        shell: 0.55,
        insertAt: 0.35,
        end: 0.4,
        emptyEnd: 0.7,
        pumpAt: 0.35,
      };
      const drum = part('drum');
      const shells = part('shells');
      const rest = drum.quaternion.clone();
      events.emit('weapon:reloadStart', { weaponId: 'grenadelauncher', empty: true, duration: 3 });
      let t = 0;
      let sawShell = false;
      let loaded = 0;
      let nextAt = ps.start + ps.insertAt;
      while (loaded < 3) {
        frame(1);
        t += DT;
        if (shells.visible) sawShell = true;
        upperClear(`gl reload t=${t.toFixed(2)}`, [0.45], [-0.6, -0.3, 0, 0.3, 0.6]);
        if (t >= nextAt) {
          events.emit('weapon:reloadStep', { weaponId: 'grenadelauncher', step: 'shellIn' });
          loaded++;
          events.emit('weapon:ammoChanged', {
            weaponId: 'grenadelauncher',
            mag: loaded,
            reserve: 12 - loaded,
            magSize: 6,
          });
          // Indexing: right after the marker the drum is a chamber away from rest, turning home.
          // (The index starts a beat after the click, then snaps most of the way at once.)
          frame(4);
          t += 4 * DT;
          expect(drum.quaternion.angleTo(rest), `index ${loaded}`).toBeGreaterThan(0.3);
          nextAt += ps.shell;
        }
      }
      expect(sawShell).toBe(true);
      events.emit('weapon:reloadEnd', { weaponId: 'grenadelauncher', completed: true });
      frame(60);
      // Every index ends at rest (six-fold drum): nothing is left to settle, the round is hidden.
      expect(shells.visible).toBe(false);
      expect(drum.quaternion.angleTo(rest)).toBeLessThan(1e-3);
    },
    SLOW_TEST_MS,
  );

  it('railgun: the charge spreads the rails apart and the release snaps them back', () => {
    rig.showWeapon('railgun');
    frame(10);
    const l = part('railL');
    const r = part('railR');
    const l0 = l.position.clone();
    const r0 = r.position.clone();
    const q0 = l.quaternion.clone();
    events.emit('weapon:charge', { weaponId: 'railgun', amount: 1 });
    frame(40);
    expect(l.position.x).toBeLessThan(l0.x - 0.002);
    expect(r.position.x).toBeGreaterThan(r0.x + 0.002);
    expect(l.quaternion.angleTo(q0)).toBeGreaterThan(0.01);
    events.emit('weapon:charge', { weaponId: 'railgun', amount: 0 });
    events.emit('weapon:fired', {
      weaponId: 'railgun',
      origin: V0,
      direction: V0,
      muzzle: V0,
      shotIndex: 0,
      ammoInMag: 5,
      ads: false,
    });
    frame(90);
    expect(l.position.distanceTo(l0)).toBeLessThan(1e-3);
    expect(r.position.distanceTo(r0)).toBeLessThan(1e-3);
  });

  it('Kettenblitz: the beam whirls the rotor and claws the prongs open; flamethrower pushes the flare out', () => {
    rig.showWeapon('chainlightning');
    frame(10);
    const coils = part('coils');
    const prong = part('prongA');
    const c0 = coils.quaternion.clone();
    const p0 = prong.quaternion.clone();
    events.emit('weapon:beam', { weaponId: 'chainlightning', active: true });
    frame(30);
    const c1 = coils.quaternion.clone();
    frame(3);
    expect(coils.quaternion.angleTo(c1)).toBeGreaterThan(0.05);
    expect(c1.angleTo(c0)).toBeGreaterThan(0);
    expect(prong.quaternion.angleTo(p0)).toBeGreaterThan(0.1);
    events.emit('weapon:beam', { weaponId: 'chainlightning', active: false });
    frame(90);
    expect(prong.quaternion.angleTo(p0)).toBeLessThan(0.01);

    rig.showWeapon('flamethrower');
    frame(10);
    const flare = part('flare');
    const f0 = flare.position.clone();
    events.emit('weapon:beam', { weaponId: 'flamethrower', active: true });
    frame(30);
    expect(flare.position.z).toBeLessThan(f0.z - 0.02);
    events.emit('weapon:beam', { weaponId: 'flamethrower', active: false });
    frame(60);
    expect(flare.position.distanceTo(f0)).toBeLessThan(1e-3);
  });

  it('black hole: sustained fire spins the containment ring (heat driver)', () => {
    rig.showWeapon('blackhole');
    frame(10);
    const ring = part('ring');
    const q0 = new Quaternion().copy(ring.quaternion);
    for (let i = 0; i < 3; i++) {
      events.emit('weapon:fired', {
        weaponId: 'blackhole',
        origin: V0,
        direction: V0,
        muzzle: V0,
        shotIndex: i,
        ammoInMag: 2 - i,
        ads: false,
      });
      frame(20);
    }
    const q1 = ring.quaternion.clone();
    frame(5);
    expect(ring.quaternion.angleTo(q1)).toBeGreaterThan(0.01);
    expect(q1.angleTo(q0)).toBeGreaterThan(0);
  });
});
