import { beforeEach, describe, expect, it } from 'vitest';
import {
  Mesh,
  Raycaster,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { VIEWMODEL } from '../../defs/camera';
import { VIEWMODELS } from '../../defs/viewmodels';
import { WEAPONS } from '../../defs/weapons';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { PlayerCamera } from '../../player/PlayerCamera';
import { PlayerController } from '../../player/PlayerController';
import { FakeInput, fakeRender, fakeSettings, type FakeRender } from '../../player/testHelpers';
import { ViewmodelRig } from '../../player/ViewmodelRig';
import { registerViewmodelBuilder, type WeaponViewmodelModel } from './index';
import { buildPistol } from './pistol';

const DT = 1 / 60;

describe('ViewmodelRig weapon layer', () => {
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
      // RenderSystem copies the world camera rotation into the viewmodel camera every frame.
      render.camera.updateMatrixWorld();
      render.viewmodelCamera.quaternion.copy(render.camera.quaternion);
      render.viewmodelCamera.updateMatrixWorld();
    }
  };

  /** Socket position in viewmodel-camera space. */
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
    // Deterministic poses: no breathing/idle drift.
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

  it('shows weapon models by id, keeps the placeholder for no/unknown weapons', () => {
    frame(2);
    const placeholder = rig.currentModel;
    rig.showWeapon('rifle');
    expect(rig.currentWeaponModel?.weaponId).toBe('rifle');
    expect(rig.currentModel).toBe(rig.currentWeaponModel!.root);
    let meshes = 0;
    rig.currentModel.traverse((o) => {
      if (o instanceof Mesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(5);
    rig.showWeapon('does-not-exist');
    expect(rig.currentWeaponModel).toBeNull();
    expect(rig.currentModel).toBe(placeholder);
    rig.showWeapon(null);
    expect(rig.currentModel).toBe(placeholder);
    // Cached: the same instance comes back.
    rig.showWeapon('pistol');
    const first = rig.currentWeaponModel;
    rig.showWeapon('shotgun');
    rig.showWeapon('pistol');
    expect(rig.currentWeaponModel).toBe(first);
  });

  it('equips through weapon:equipStart and animates the raise', () => {
    frame(2);
    events.emit('weapon:equipStart', { weaponId: 'shotgun', slot: 0, duration: 0.5, previous: null });
    expect(rig.currentWeaponId).toBe('shotgun');
    frame(1);
    const hip = VIEWMODELS.shotgun.hip.pos;
    expect(rig.root.position.y).toBeLessThan(hip.y - 0.05);
    frame(90);
    expect(rig.root.position.y).toBeCloseTo(hip.y, 2);
    expect(rig.root.position.x).toBeCloseTo(hip.x, 2);
  });

  it('holster and raise never sweep a weapon (or its stock) up through the view', () => {
    // Hip weapons live in the lower half of the screen: the upper half stays clear throughout.
    const ray = new Raycaster();
    const ndc = new Vector2();
    const probes: [number, number][] = [];
    for (const x of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9])
      for (const y of [0.05, 0.35, 0.7]) probes.push([x, y]);
    const clear = (label: string): void => {
      render.viewmodelScene.updateMatrixWorld(true);
      for (const [x, y] of probes) {
        ray.setFromCamera(ndc.set(x, y), render.viewmodelCamera);
        const hits = ray.intersectObject(rig.root, true);
        expect(hits.length, `${label} @ ${x},${y}`).toBe(0);
      }
    };
    rig.showWeapon('pistol');
    frame(20);
    clear('pistol hip');
    const order = ['rifle', 'shotgun', 'pistol', 'shotgun', 'rifle'] as const;
    let prev: keyof typeof WEAPONS = 'pistol';
    for (const next of order) {
      const h = WEAPONS[prev].holsterTime;
      events.emit('weapon:holsterStart', { weaponId: prev, slot: 0, duration: h, next });
      events.emit('weapon:equipStart', {
        weaponId: next,
        slot: 1,
        duration: h + WEAPONS[next].equipTime,
        previous: prev,
      });
      const n = Math.ceil((h + WEAPONS[next].equipTime) / DT) + 10;
      for (let i = 0; i < n; i++) {
        frame(1);
        clear(`${prev} → ${next} frame ${i}`);
      }
      expect(rig.currentWeaponId).toBe(next);
      prev = next;
    }
  });

  it('socket anchors persist across model swaps and follow the shown model', () => {
    const muzzle = rig.getSocketObject('muzzle');
    for (const id of ['pistol', 'rifle', null, 'shotgun'] as const) {
      rig.showWeapon(id);
      frame(1);
      expect(rig.getSocketObject('muzzle')).toBe(muzzle);
      let n = muzzle.parent;
      while (n && n !== rig.currentModel) n = n.parent;
      expect(n).toBe(rig.currentModel);
      // The muzzle is ahead of the eye, in front of the eject port.
      expect(viewSpace('muzzle').z).toBeLessThan(viewSpace('ejectPort').z);
    }
  });

  it('maps viewmodel sockets to world points on the same pixel at the same depth', () => {
    rig.showWeapon('rifle');
    frame(30);
    const vmCam = render.viewmodelCamera;
    const cam = render.camera;
    for (const s of ['muzzle', 'ejectPort'] as const) {
      const view = viewSpace(s);
      const world = rig.getSocketWorldPosition(s, new Vector3());
      const ndcVm = view.clone().applyMatrix4(vmCam.projectionMatrix);
      const ndcWorld = world.clone().project(cam);
      expect(ndcWorld.x).toBeCloseTo(ndcVm.x, 5);
      expect(ndcWorld.y).toBeCloseTo(ndcVm.y, 5);
      const worldView = world.clone().applyMatrix4(cam.matrixWorldInverse);
      expect(worldView.z).toBeCloseTo(view.z, 6);
      // Not the eye itself: the tracer starts out at the barrel.
      expect(world.distanceTo(cam.position)).toBeGreaterThan(0.2);
    }
    // The barrel points roughly where the player looks.
    const dir = rig.getSocketWorldDirection('muzzle', new Vector3());
    const look = cam.getWorldDirection(new Vector3());
    expect(dir.length()).toBeCloseTo(1, 6);
    expect(dir.dot(look)).toBeGreaterThan(0.9);
  });

  it('full ADS puts the sight socket on the view axis at the defined eye distance', () => {
    for (const id of ['pistol', 'rifle', 'shotgun'] as const) {
      rig.showWeapon(id);
      ads.adsAmount = 1;
      frame(60);
      const sight = viewSpace('sight');
      expect(Math.abs(sight.x), id).toBeLessThan(1e-3);
      expect(Math.abs(sight.y), id).toBeLessThan(1e-3);
      expect(sight.z).toBeCloseTo(-VIEWMODELS[id].adsEyeDistance, 2);
      ads.adsAmount = 0;
      frame(60);
      expect(Math.abs(viewSpace('sight').x)).toBeGreaterThan(0.05);
    }
  });

  it('ADS alignment follows a scaled model (defs scale)', () => {
    const SCALE = 1.5;
    registerViewmodelBuilder('scaled-test', (kit) => {
      const base = buildPistol(kit);
      base.root.scale.setScalar(SCALE);
      const wrapped: WeaponViewmodelModel = Object.create(base) as WeaponViewmodelModel;
      return Object.assign(wrapped, { def: { ...base.def, scale: SCALE } });
    });
    rig.showWeapon('scaled-test');
    expect(rig.currentWeaponModel?.root.scale.x).toBe(SCALE);
    ads.adsAmount = 1;
    frame(60);
    const sight = viewSpace('sight');
    expect(Math.abs(sight.x)).toBeLessThan(1e-3);
    expect(Math.abs(sight.y)).toBeLessThan(1e-3);
    expect(sight.z).toBeCloseTo(-VIEWMODELS.pistol.adsEyeDistance, 2);
  });

  it('fire drives the kick layer and recovers; setModel still supports custom objects', () => {
    rig.showWeapon('shotgun');
    frame(10);
    const restZ = rig.root.position.z;
    const V0 = { x: 0, y: 0, z: 0 };
    events.emit('weapon:fired', {
      weaponId: 'shotgun',
      origin: V0,
      direction: V0,
      muzzle: V0,
      shotIndex: 0,
      ammoInMag: 3,
      ads: false,
    });
    let maxBack = 0;
    for (let i = 0; i < 8; i++) {
      frame(1);
      maxBack = Math.max(maxBack, rig.root.position.z - restZ);
    }
    expect(maxBack).toBeGreaterThan(WEAPONS.shotgun.recoil.visualKick.back * 0.5);
    frame(120);
    expect(rig.root.position.z).toBeCloseTo(restZ, 3);
    const hipZ = VIEWMODEL.offset.z;
    rig.setModel(null);
    frame(5);
    expect(rig.currentWeaponModel).toBeNull();
    expect(rig.root.position.z).toBeCloseTo(hipZ, 2);
  });

  it('warm-up compiles every weapon model into a render target (post-chain variants), then detaches them', () => {
    rig.showWeapon('pistol');
    const seen = new Set<string>();
    let target: unknown = 'unset';
    const calls: string[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: (t: unknown) => {
        calls.push(t ? 'bind' : 'unbind');
        if (t) target = t;
      },
      compile: (scene: Object3D) => {
        calls.push('compile');
        scene.traverse((o) => {
          if (o instanceof Mesh) seen.add(o.name);
          if (o.name.startsWith('vm-')) seen.add(o.name);
        });
      },
    } as unknown as WebGLRenderer;
    rig.warmupWeapons(renderer);
    expect(calls).toEqual(['bind', 'compile', 'unbind']);
    expect(target).toBeInstanceOf(WebGLRenderTarget);
    for (const id of ['pistol', 'rifle', 'shotgun']) expect(seen.has(`vm-${id}`), id).toBe(true);
    // Hidden parts are compiled too (r186 compile() visits hidden meshes): the loading shell.
    expect([...seen].some((n) => n.startsWith('shell-'))).toBe(true);
    // Only the shown model stays in the rig.
    expect(rig.currentWeaponModel?.weaponId).toBe('pistol');
    let models = 0;
    rig.root.traverse((o) => {
      if (o.name.startsWith('vm-')) models++;
    });
    expect(models).toBe(1);
  });

  it('dispose tears everything down', () => {
    rig.showWeapon('rifle');
    frame(2);
    rig.dispose();
    rig.dispose();
    expect(rig.root.parent).toBeNull();
    expect(events.listenerCount('weapon:fired')).toBe(0);
  });
});
