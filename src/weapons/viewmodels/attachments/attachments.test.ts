/**
 * Attachment part library, outfits on every weapon model, forge looks (material variants, camo
 * patch, recolors) and the rig integration (optic sight line, muzzle devices, stow).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Color, Mesh, MeshStandardMaterial, ShaderLib, Vector3, type Material, type Object3D } from 'three';
import type { SettingsStore } from '../../../core/contracts';
import { EventBus } from '../../../core/EventBus';
import type { GameEvents } from '../../../core/events';
import { ATTACHMENT_IDS, attachmentsFor, getAttachmentDef } from '../../../defs/attachments';
import { FORGE_LOOKS } from '../../../defs/forge';
import { getViewmodelDef } from '../../../defs/viewmodels';
import { ATTACHMENT_ART, OUTFIT_RIG } from '../../../defs/weaponOutfit';
import { WEAPON_IDS, getWeaponDef } from '../../../defs/weapons';
import { PhysicsWorld } from '../../../physics/PhysicsWorld';
import { PlayerCamera } from '../../../player/PlayerCamera';
import { PlayerController } from '../../../player/PlayerController';
import { FakeInput, fakeRender, fakeSettings, type FakeRender } from '../../../player/testHelpers';
import { ViewmodelRig } from '../../../player/ViewmodelRig';
import type { WeaponModState } from '../../resolveWeapon';
import { WeaponMaterialKit, createWeaponViewmodel, type WeaponViewmodelModel } from '../index';
import { CAMO_PROGRAM_KEY, ForgeLookApplier, materialRole, patchCamoShader } from './forgeLook';
import { AttachmentLibrary, meshesOf } from './library';
import { WeaponOutfit } from './WeaponOutfit';

const DT = 1 / 60;

function descendsFrom(o: Object3D, root: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

function modelSpace(o: Object3D, root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  return new Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
}

describe('attachment part library', () => {
  let kit: WeaponMaterialKit;
  let lib: AttachmentLibrary;
  beforeAll(() => {
    kit = new WeaponMaterialKit();
    lib = new AttachmentLibrary(kit);
  });

  it('builds every attachment model id of defs/attachments', () => {
    const group = lib.warmupGroup();
    const built = new Set<string>();
    for (const c of group.children) built.add(String(c.userData.attachmentId));
    for (const id of ATTACHMENT_IDS) {
      expect(lib.has(id), id).toBe(true);
      expect(built.has(id), `${id} builds`).toBe(true);
    }
    for (const c of group.children) expect(meshesOf(c).length, String(c.userData.attachmentId)).toBeGreaterThan(0);
    lib.releaseWarmup(group);
    expect(lib.create('nope')).toBeNull();
  });

  it('optics report a sight point, muzzle devices a muzzle point, lasers an emitter', () => {
    for (const id of ATTACHMENT_IDS) {
      const def = getAttachmentDef(id)!;
      if (lib.isMagazineAddon(id)) continue;
      const inst = lib.create(id)!;
      if (def.slot === 'optic') {
        expect(inst.sight, id).not.toBeNull();
        expect(inst.sight!.position.y, id).toBeGreaterThan(0.01);
      }
      if (def.slot === 'muzzle') expect(inst.muzzle!.position.z, id).toBeLessThan(-0.02);
      if (def.laser) expect(inst.emitter, id).not.toBeNull();
      lib.release(inst);
    }
    expect(lib.create('scope4x')!.spec.eyeDistance).toBe(ATTACHMENT_ART.eyeRelief.scope4x);
  });
});

describe('weapon outfits', () => {
  let kit: WeaponMaterialKit;
  let lib: AttachmentLibrary;
  const models = new Map<string, WeaponViewmodelModel>();
  beforeAll(() => {
    kit = new WeaponMaterialKit();
    lib = new AttachmentLibrary(kit);
    for (const id of WEAPON_IDS) {
      const m = createWeaponViewmodel(id, kit);
      if (m) models.set(id, m);
    }
  }, 60_000);

  it('fits every compatible attachment of every weapon somewhere on its model', () => {
    for (const id of WEAPON_IDS) {
      const model = models.get(id)!;
      expect(model, id).toBeDefined();
      const outfit = new WeaponOutfit(model, lib);
      for (const att of attachmentsFor(getWeaponDef(id)!)) {
        outfit.apply([att.id]);
        expect(outfit.ids, `${id} ← ${att.id}`).toEqual([att.id]);
        const root = model.root.getObjectByName(`att-${att.id}`);
        expect(root && descendsFrom(root, model.root), `${id} ← ${att.id}`).toBe(true);
      }
      outfit.dispose();
      expect(model.root.getObjectByName('att-reddot')).toBeUndefined();
    }
  });

  it('an optic takes over the sight line and hides the built-in sight; removing restores it', () => {
    const rifle = models.get('rifle')!;
    const outfit = new WeaponOutfit(rifle, lib);
    const sightMeshes = meshesOf(rifle.parts.sight!);
    expect(sightMeshes.length).toBeGreaterThan(0);
    outfit.apply(['holo']);
    expect(outfit.sight).not.toBeNull();
    expect(sightMeshes.every((m) => !m.visible)).toBe(true);
    const own = modelSpace(rifle.sight, rifle.root);
    const holo = modelSpace(outfit.sight!, rifle.root);
    expect(holo.y).toBeGreaterThan(own.y - 0.01);
    expect(Math.abs(holo.x)).toBeLessThan(1e-6);
    outfit.apply([]);
    expect(outfit.sight).toBeNull();
    expect(sightMeshes.every((m) => m.visible)).toBe(true);
    outfit.apply(['scope4x']);
    expect(outfit.eyeDistance).toBe(ATTACHMENT_ART.eyeRelief.scope4x);
    outfit.dispose();
  });

  it('muzzle devices move the muzzle forward; energy weapons carry them on the muzzle socket', () => {
    for (const [weapon, att] of [
      ['pistol', 'suppressor'],
      ['rifle', 'muzzlebrake'],
      ['shotgun', 'choke'],
      ['plasma', 'focuslens'],
    ] as const) {
      const model = models.get(weapon)!;
      const outfit = new WeaponOutfit(model, lib);
      outfit.apply([att]);
      expect(outfit.muzzle, `${weapon} ${att}`).not.toBeNull();
      expect(modelSpace(outfit.muzzle!, model.root).z).toBeLessThan(modelSpace(model.muzzle, model.root).z - 0.02);
      outfit.dispose();
    }
  });

  it('a drum replaces the magazine, coupled magazines show a copy, bands ride on it', () => {
    const smg = models.get('smg')!;
    const mag = smg.parts.magazine!;
    const own = mag.children.filter((c) => (c as Mesh).isMesh);
    const outfit = new WeaponOutfit(smg, lib);
    outfit.apply(['drum']);
    expect(own.every((m) => !m.visible)).toBe(true);
    expect(descendsFrom(mag.getObjectByName('att-drum')!, mag)).toBe(true);
    outfit.apply(['fastmag']);
    expect(own.every((m) => m.visible)).toBe(true);
    expect(mag.getObjectByName('att-magazine-copy')).toBeDefined();
    outfit.apply(['overpressure', 'vertgrip']);
    expect(mag.getObjectByName('att-magazine-copy')).toBeUndefined();
    expect(mag.getObjectByName('att-overpressure')).toBeDefined();
    outfit.dispose();
  });

  it('attachment accents take the host weapon’s accent material', () => {
    const rifle = models.get('rifle')!;
    const outfit = new WeaponOutfit(rifle, lib);
    outfit.apply(['reddot']);
    const names = meshesOf(rifle.root.getObjectByName('att-reddot')!).map((m) => (m.material as Material).name);
    expect(names).toContain('vm-accent');
    expect(names).not.toContain('vm-att-accent');
    outfit.dispose();
  });
});

describe('forge looks', () => {
  let kit: WeaponMaterialKit;
  beforeAll(() => {
    kit = new WeaponMaterialKit();
  });

  it('knows the material roles (masks untouched)', () => {
    expect(materialRole('vm-gunmetal')).toBe('body');
    expect(materialRole('vm-chitin-shell')).toBe('body');
    expect(materialRole('vm-accentpaint')).toBe('paint');
    expect(materialRole('vm-accent')).toBe('accent');
    expect(materialRole('vm-heat')).toBe('heat');
    expect(materialRole('vm-energy-core')).toBe('energy');
    expect(materialRole('vm-scopemask')).toBe('none');
    expect(materialRole('vm-sight')).toBe('none');
  });

  it('swaps body / paint for per-look variants (camo patch on tier 3) and restores them', () => {
    const looks = new ForgeLookApplier();
    const sniper = createWeaponViewmodel('sniper', kit)!;
    const before = new Map(meshesOf(sniper.root).map((m) => [m, m.material as Material]));
    const accent = looks.apply(sniper.root, FORGE_LOOKS.forge3!);
    expect(accent?.name).toBe('vm-accent');
    expect(accent!.emissive.getHex()).toBe(new Color(FORGE_LOOKS.forge3!.accent).getHex());
    let camo = 0;
    for (const [mesh, orig] of before) {
      const role = materialRole(orig.name);
      const now = mesh.material as MeshStandardMaterial;
      if (role === 'body') {
        expect(now).not.toBe(orig);
        expect(now.customProgramCacheKey()).toBe(CAMO_PROGRAM_KEY);
        camo++;
      } else if (role === 'paint') {
        expect(now.color.getHex()).toBe(new Color(FORGE_LOOKS.forge3!.paint).getHex());
      } else expect(now, orig.name).toBe(orig);
    }
    expect(camo).toBeGreaterThan(0);
    // Tier 1 has no camo; the same source material gets its own cached variant.
    looks.apply(sniper.root, FORGE_LOOKS.forge1!);
    for (const [mesh, orig] of before) {
      if (materialRole(orig.name) !== 'body') continue;
      expect((mesh.material as Material).customProgramCacheKey()).not.toBe(CAMO_PROGRAM_KEY);
    }
    looks.apply(sniper.root, null);
    for (const [mesh, orig] of before) expect(mesh.material).toBe(orig);
    expect(accent!.emissive.getHex()).toBe(new Color(0x36e4ff).getHex());
    looks.dispose();
    sniper.dispose();
  });

  it('tints the energy volumes towards the accent and restores them', () => {
    const looks = new ForgeLookApplier();
    const plasma = createWeaponViewmodel('plasma', kit)!;
    const energy = meshesOf(plasma.root)
      .map((m) => m.material as Material & { uniforms?: { uRim?: { value: Color } } })
      .find((m) => m.name.startsWith('vm-energy-'))!;
    const rim = energy.uniforms!.uRim!.value.clone();
    looks.apply(plasma.root, FORGE_LOOKS.forge2!);
    expect(energy.uniforms!.uRim!.value.equals(rim)).toBe(false);
    looks.apply(plasma.root, null);
    expect(energy.uniforms!.uRim!.value.equals(rim)).toBe(true);
    // Warm-up: one camo variant per body material.
    expect(looks.warmupMeshes([plasma.root]).length).toBeGreaterThan(0);
    looks.dispose();
    plasma.dispose();
  });

  it('the camo patch lands in the standard / physical shaders', () => {
    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    patchCamoShader(shader, { uCamoTime: { value: 0 } });
    expect(shader.vertexShader).toContain('vCamoPos = position;');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(diffuseColor.rgb, cbase');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += cvein');
    expect(shader.uniforms.uCamoTime).toBeDefined();
  });
});

describe('ViewmodelRig outfit integration', () => {
  let physics: PhysicsWorld;
  let input: FakeInput;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let render: FakeRender;
  let player: PlayerController;
  let camera: PlayerCamera;
  let rig: ViewmodelRig;
  const ads = { adsAmount: 0 };
  const mods = new Map<string, WeaponModState>();

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
  const viewSpace = (socket: 'muzzle' | 'sight'): Vector3 => {
    const obj = rig.getSocketObject(socket);
    obj.updateWorldMatrix(true, false);
    return new Vector3().setFromMatrixPosition(obj.matrixWorld).applyMatrix4(render.viewmodelCamera.matrixWorldInverse);
  };

  beforeEach(async () => {
    physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 0.5, z: 40 });
    input = new FakeInput();
    events = new EventBus<GameEvents>();
    settings = fakeSettings();
    settings.update('accessibility', { cameraMotion: 0 });
    render = fakeRender();
    player = new PlayerController({ physics, input, events, settings }, { position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    camera = new PlayerCamera({ player, input, render: render.api, events, settings });
    ads.adsAmount = 0;
    mods.clear();
    rig = new ViewmodelRig({ render: render.api, player, camera, events, ads });
    rig.setModsSource((id) => mods.get(id) ?? null);
  });

  it('aims through a fitted optic: its sight point on the view axis at the right eye distance', () => {
    mods.set('rifle', { tier: 0, attachments: ['reddot'] });
    rig.showWeapon('rifle');
    ads.adsAmount = 1;
    frame(90);
    const s = viewSpace('sight');
    expect(Math.hypot(s.x, s.y)).toBeLessThan(0.004);
    expect(s.z).toBeCloseTo(-getViewmodelDef('rifle')!.adsEyeDistance, 2);
    expect(rig.currentModel.getObjectByName('att-reddot')).toBeDefined();
    // Swap to a magnified optic mid-game: the sight line follows at its eye relief.
    mods.set('rifle', { tier: 0, attachments: ['scope4x'] });
    frame(90);
    const s2 = viewSpace('sight');
    expect(Math.hypot(s2.x, s2.y)).toBeLessThan(0.004);
    expect(s2.z).toBeCloseTo(-ATTACHMENT_ART.eyeRelief.scope4x, 2);
  });

  it('a suppressor moves the muzzle anchor to its tip; a forge tier recolors the accent light', () => {
    rig.showWeapon('pistol');
    frame(30);
    const bare = viewSpace('muzzle');
    mods.set('pistol', { tier: 3, attachments: ['suppressor'] });
    frame(2);
    const suppressed = viewSpace('muzzle');
    expect(suppressed.z).toBeLessThan(bare.z - 0.1);
    let camo = false;
    rig.currentModel.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && (m.material as Material).customProgramCacheKey?.() === CAMO_PROGRAM_KEY) camo = true;
    });
    expect(camo).toBe(true);
  });

  it('stows the weapon out of view for the forge and raises it again', () => {
    rig.showWeapon('rifle');
    frame(60);
    const hipY = rig.root.position.y;
    rig.setStowed(true);
    frame(Math.ceil(OUTFIT_RIG.stow.lowerTime / DT) + 5);
    expect(rig.root.position.y).toBeLessThan(hipY - 0.3);
    // A new look applied while lowered shows once it is down (the model is out of view).
    mods.set('rifle', { tier: 2 });
    frame(2);
    rig.setStowed(false);
    frame(Math.ceil(OUTFIT_RIG.stow.raiseTime / DT) + 30);
    expect(rig.root.position.y).toBeCloseTo(hipY, 2);
  });
});
