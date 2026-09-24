/**
 * Package C3 viewmodels (energy + wonder weapons: plasma, chain lightning, railgun, flamethrower,
 * grenade launcher, black hole, rift ripper, aether harp, cryo nova): contract, choreography ↔
 * parts, drivers, reload marker anchoring, bloom (kit glows, readout tints and the energy
 * materials), ADS alignment, mounts, hip framing, and the energy model's own animation (driver
 * boost, shot flare / collapse of free nodes, readout tint, disposal).
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  Color,
  Euler,
  Group,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import { DEG2RAD } from '../../../core/math';
import { CAMERA } from '../../../defs/camera';
import { POSTFX } from '../../../defs/postfx';
import {
  VIEWMODEL_ANIM,
  VIEWMODEL_ART,
  getViewmodelDef,
  type PartMotionDef,
  type PoseDef,
  type WeaponViewmodelDef,
} from '../../../defs/viewmodels';
import { getWeaponDef, type ReloadStep } from '../../../defs/weapons';
import { WeaponMaterialKit, createWeaponViewmodel, hasViewmodel, type WeaponViewmodelModel } from '../index';
import { adsOffsetFromSight } from '../socketMath';
import { AETHERHARP_SIGHT_LINE } from './aetherharp';
import { BLACKHOLE_SIGHT_LINE } from './blackhole';
import { CHAINLIGHTNING_SIGHT_LINE } from './chainlightning';
import { CRYONOVA_SIGHT_LINE } from './cryonova';
import { EnergyWeaponModel, type EnergyMaterial } from './energyKit';
import { FLAMETHROWER_SIGHT_LINE } from './flamethrower';
import { GRENADELAUNCHER_SIGHT_LINE } from './grenadelauncher';
import { M5_BUILDERS } from './index';
import { PLASMA_SIGHT_LINE } from './plasma';
import { RAILGUN_SIGHT_LINE } from './railgun';
import { RIFTRIPPER_SIGHT_LINE } from './riftripper';

/** Named parts per the M5 roster (plus the extras the choreography uses). */
const REQUIRED_PARTS: Record<string, readonly string[]> = {
  plasma: ['cell', 'coils', 'vents', 'trigger', 'sight'],
  chainlightning: ['prongs', 'prongA', 'prongB', 'prongC', 'coils', 'cell', 'trigger', 'sight'],
  railgun: ['rails', 'railL', 'railR', 'coils', 'cell', 'primer', 'trigger', 'sight'],
  flamethrower: ['tank', 'nozzle', 'pilot', 'flare', 'swirl', 'trigger', 'sight'],
  grenadelauncher: ['drum', 'shells', 'trigger', 'sight'],
  blackhole: ['ring', 'core', 'cell', 'trigger', 'sight'],
  riftripper: ['prongs', 'prongL', 'prongR', 'cell', 'trigger', 'sight'],
  aetherharp: ['strings', 'resonator', 'cell', 'trigger', 'sight'],
  cryonova: ['canister', 'fins', 'core', 'trigger', 'sight'],
};
const SIGHT_LINES: Record<string, number> = {
  plasma: PLASMA_SIGHT_LINE,
  chainlightning: CHAINLIGHTNING_SIGHT_LINE,
  railgun: RAILGUN_SIGHT_LINE,
  flamethrower: FLAMETHROWER_SIGHT_LINE,
  grenadelauncher: GRENADELAUNCHER_SIGHT_LINE,
  blackhole: BLACKHOLE_SIGHT_LINE,
  riftripper: RIFTRIPPER_SIGHT_LINE,
  aetherharp: AETHERHARP_SIGHT_LINE,
  cryonova: CRYONOVA_SIGHT_LINE,
};
/** Parts the model animates itself (the animator must not own them). */
const FREE_PARTS: Record<string, readonly string[]> = {
  blackhole: ['ringSpin', 'gyro', 'coreFloat', 'disk'],
  riftripper: ['riftTear'],
  aetherharp: ['crystal', 'orbitA', 'orbitB'],
  cryonova: ['star'],
};
const IDS = Object.keys(REQUIRED_PARTS);
/** Markers the roster gives these weapons (used until the weapon defs exist). */
const ROSTER_TACTICAL: readonly ReloadStep[] = ['magOut', 'magIn'];
const ROSTER_EMPTY: readonly ReloadStep[] = ['magOut', 'magIn', 'boltRelease'];
/** Draw-call budget per model (meshes = one per part × material); the showpieces carry more materials. */
const MAX_MESHES = 34;

const kit = new WeaponMaterialKit();
const built = new Map<string, WeaponViewmodelModel>();
function model(id: string): WeaponViewmodelModel {
  let m = built.get(id);
  if (!m) {
    const made = createWeaponViewmodel(id, kit);
    if (!made) throw new Error(`no model ${id}`);
    built.set(id, made);
    m = made;
  }
  return m;
}
function vdef(id: string): WeaponViewmodelDef {
  const d = getViewmodelDef(id);
  if (!d) throw new Error(`no viewmodel def ${id}`);
  return d;
}

afterAll(() => {
  for (const m of built.values()) m.dispose();
  kit.dispose();
});

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

function findNode(root: Object3D, name: string): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (o.name === name) found = o;
  });
  return found;
}

function modelSpace(obj: Object3D, root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  return obj.getWorldPosition(new Vector3()).applyMatrix4(inv);
}

function euler(p: PoseDef | undefined): Euler {
  const r = p?.rot;
  return new Euler((r?.x ?? 0) * DEG2RAD, (r?.y ?? 0) * DEG2RAD, (r?.z ?? 0) * DEG2RAD);
}

function energyMaterials(m: WeaponViewmodelModel): EnergyMaterial[] {
  const out = new Set<EnergyMaterial>();
  for (const mesh of meshes(m.root)) {
    const mat = mesh.material as Material;
    if (mat.name.startsWith('vm-energy-')) out.add(mat as EnergyMaterial);
  }
  return [...out];
}

const BLOOM_FLOOR = POSTFX.bloom.luminanceThreshold + POSTFX.bloom.luminanceSmoothing;
const lumOf = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('C3 energy + wonder weapon viewmodels', () => {
  it('every model is registered, has a def and builds an energy model', () => {
    for (const id of IDS) {
      expect(M5_BUILDERS[id], id).toBeTypeOf('function');
      expect(hasViewmodel(id), id).toBe(true);
      expect(getViewmodelDef(id), id).toBeDefined();
      expect(model(id), id).toBeInstanceOf(EnergyWeaponModel);
    }
  });

  for (const id of IDS) {
    describe(id, () => {
      it('implements the contract: named parts, sockets, optic + laser mounts, few merged meshes', () => {
        const m = model(id);
        expect(m.weaponId).toBe(id);
        expect(m.root).toBeInstanceOf(Group);
        for (const p of REQUIRED_PARTS[id]!) expect(m.parts[p], `${id}.${p}`).toBeInstanceOf(Object3D);
        for (const s of [m.muzzle, m.ejectPort, m.sight, m.mounts.optic!, m.mounts.laser!]) {
          expect(s, id).toBeInstanceOf(Object3D);
          let n: Object3D | null = s;
          while (n && n !== m.root) n = n.parent;
          expect(n).toBe(m.root);
        }
        const list = meshes(m.root);
        expect(list.length).toBeGreaterThan(8);
        expect(list.length).toBeLessThanOrEqual(MAX_MESHES);
        const seen = new Set<string>();
        for (const mesh of list) {
          const key = `${mesh.parent!.uuid}/${(mesh.material as Material).uuid}`;
          expect(seen.has(key), `${id}: ${mesh.name}`).toBe(false);
          seen.add(key);
          const geo = mesh.geometry as BufferGeometry;
          for (const a of ['position', 'normal', 'uv', 'color']) expect(geo.getAttribute(a), a).toBeDefined();
          const pos = geo.getAttribute('position');
          for (let i = 0; i < pos.count; i++)
            expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
        }
      });

      it('every part the choreography and the drivers reference exists; free parts stay out of the animator', () => {
        const m = model(id);
        const d = vdef(id);
        const lists: (readonly PartMotionDef[])[] = [d.fire, d.fireLast, d.dryFire];
        for (const l of Object.values(d.reloadSteps)) if (l) lists.push(l);
        for (const l of lists)
          for (const mo of l) expect(m.parts[mo.part], `${id}: ${mo.part}`).toBeDefined();
        for (const p of d.lockParts) expect(m.parts[p], `${id} lock ${p}`).toBeDefined();
        for (const dr of d.drivers ?? []) expect(m.parts[dr.part], `${id} driver ${dr.part}`).toBeDefined();
        for (const l of [d.fire, d.fireLast, d.dryFire])
          for (const mo of l) expect(mo.lead, `${id}: ${mo.part}`).toBeUndefined();
        for (const name of FREE_PARTS[id] ?? []) {
          expect(m.parts[name], `${id} free ${name}`).toBeUndefined();
          const node = findNode(m.root, `part-${name}`);
          expect(node, `${id} free ${name} in the hierarchy`).toBeDefined();
        }
        if (d.reload.style === 'timeline') {
          for (const track of [d.reload.tactical, d.reload.empty]) {
            const keys = track.keys;
            for (let i = 0; i < keys.length; i++) {
              expect(keys[i]!.t).toBeGreaterThan(0);
              expect(keys[i]!.t).toBeLessThan(1);
              if (i > 0) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
            }
          }
        }
      });

      it('reload choreography anchors every marker of the weapon (def, else the roster)', () => {
        const d = vdef(id);
        const wdef = getWeaponDef(id);
        if (d.reload.style === 'loop') {
          // Shell by shell: every grenade has a motion on its marker.
          expect(d.reloadSteps.shellIn?.length ?? 0).toBeGreaterThan(0);
          if (wdef) expect(wdef.reload.perShell).not.toBeNull();
          return;
        }
        const tactical = wdef ? wdef.reload.tacticalSteps.map((s) => s.step) : ROSTER_TACTICAL;
        const empty = wdef ? wdef.reload.emptySteps.map((s) => s.step) : ROSTER_EMPTY;
        for (const [track, steps] of [
          [d.reload.tactical, tactical],
          [d.reload.empty, empty],
        ] as const) {
          let prev = 0;
          for (const step of steps) {
            const authored = track.markers[step];
            expect(authored, `${id}: ${step}`).toBeDefined();
            expect(authored!).toBeGreaterThan(prev);
            expect(authored!).toBeLessThan(1);
            prev = authored!;
          }
        }
        // The magazine part leaves on magOut and comes back on magIn.
        expect(
          d.reloadSteps.magOut?.some((mo) => mo.hideAtEnd),
          id,
        ).toBe(true);
        expect(
          d.reloadSteps.magIn?.some((mo) => mo.show && (mo.lead ?? 0) > 0),
          id,
        ).toBe(true);
      });

      it('kit glows and readouts clear the bloom threshold + smoothing (all readout states, pulse minimum)', () => {
        const m = model(id);
        const d = vdef(id);
        const glowOf = (name: string): MeshStandardMaterial => {
          for (const mesh of meshes(m.root)) {
            const mat = mesh.material as MeshStandardMaterial;
            if (mat.name === name) return mat;
          }
          throw new Error(`${id}: no ${name}`);
        };
        const lum = (mat: MeshStandardMaterial, rgb?: readonly number[]): number => {
          const c = mat.emissive.clone();
          if (rgb)
            c.multiply(new Color().setRGB(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, SRGBColorSpace));
          return lumOf(c) * mat.emissiveIntensity;
        };
        const A = VIEWMODEL_ANIM;
        for (const v of [d.glow.accent, d.glow.readout, d.glow.sight, d.glow.heat])
          expect(v).toBeGreaterThan(1);
        m.animate({ time: (1.5 * Math.PI) / A.accentPulse.rate, heat: 1, flash: 0 });
        expect(lum(glowOf('vm-accent')), 'accent').toBeGreaterThanOrEqual(BLOOM_FLOOR);
        expect(lum(glowOf('vm-sight')), 'sight').toBeGreaterThanOrEqual(BLOOM_FLOOR);
        const readout = glowOf('vm-readout');
        const tex = readout.emissiveMap!;
        const data = (tex.image as { data: Uint8Array }).data;
        const E = VIEWMODEL_ART.emissive;
        for (const mag of [30, 2, 0]) {
          m.setAmmo(mag, 30);
          m.animate({ time: (0.5 * Math.PI) / A.emptyBlinkRate, heat: 0, flash: 0 });
          // The brightest lit texel is the state color (a weapon's tint replaces the shared cyan).
          let best = 0;
          let rgb: number[] = [0, 0, 0];
          for (let i = 0; i + 2 < data.length; i += 4) {
            const l = lumOf(
              new Color().setRGB(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255, SRGBColorSpace),
            );
            if (l > best) {
              best = l;
              rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
            }
          }
          if (mag === 2) expect(rgb, `${id} low`).toEqual([...E.readoutLow]);
          if (mag === 0) expect(rgb, `${id} empty`).toEqual([...E.readoutEmpty]);
          expect(lum(readout, rgb), `${id} readout ${mag}`).toBeGreaterThanOrEqual(BLOOM_FLOOR);
        }
      });

      it('the energy glow blooms at rest and brightens on a shot', () => {
        const m = model(id);
        const mats = energyMaterials(m);
        expect(mats.length, id).toBeGreaterThan(0);
        m.animate({ time: 10, heat: 0, flash: 0 });
        m.animate({ time: 10.016, heat: 0, flash: 0 });
        const peak = (mat: EnergyMaterial): number =>
          Math.max(lumOf(mat.uniforms.uCore.value), lumOf(mat.uniforms.uRim.value)) *
          mat.uniforms.uIntensity.value;
        const rest = mats.map(peak);
        expect(Math.max(...rest), `${id} brightest energy`).toBeGreaterThanOrEqual(BLOOM_FLOOR);
        m.animate({ time: 10.032, heat: 0, flash: 1 });
        const shot = mats.map(peak);
        expect(Math.max(...shot.map((v, i) => v - rest[i]!)), id).toBeGreaterThan(0);
        for (const mat of mats) expect(mat.uniforms.uTime.value).toBeCloseTo(10.032, 6);
      });

      it('ADS puts the sight socket on the view axis; sight line level, above the bore, behind the muzzle', () => {
        const m = model(id);
        const d = vdef(id);
        const sight = modelSpace(m.sight, m.root);
        expect(sight.y).toBeCloseTo(SIGHT_LINES[id]!, 9);
        expect(sight.x).toBeCloseTo(0, 9);
        const cam = sight.clone().add(adsOffsetFromSight(sight, d.adsEyeDistance, new Vector3(), d.adsNudge));
        expect(cam.x).toBeCloseTo(0, 9);
        expect(cam.y).toBeCloseTo(0, 9);
        expect(cam.z).toBeCloseTo(-d.adsEyeDistance, 9);
        const muzzle = modelSpace(m.muzzle, m.root);
        expect(muzzle.z).toBeLessThan(sight.z);
        expect(sight.y).toBeGreaterThan(muzzle.y);
        expect(muzzle.x).toBeCloseTo(0, 9);
      });

      it('nothing opaque sits between the eye and the sight socket at full ADS', () => {
        const m = model(id);
        const d = vdef(id);
        m.root.updateMatrixWorld(true);
        const sight = modelSpace(m.sight, m.root);
        const eye = sight.clone().add(new Vector3(0, 0, d.adsEyeDistance));
        const ray = new Raycaster(eye, new Vector3(0, 0, -1), 0, d.adsEyeDistance - 1e-4);
        const hits = ray.intersectObject(m.root, true).filter((h) => (h.object as Mesh).visible);
        const blocking = hits.filter((h) => {
          const mat = (h.object as Mesh).material as MeshStandardMaterial;
          return !mat.transparent && mat.name !== 'vm-sight';
        });
        expect(blocking.map((h) => h.object.name)).toEqual([]);
      });

      it('at hip (and sprinting) the gun stays out of the upper half of the screen', () => {
        const m = model(id);
        const d = vdef(id);
        const holder = new Group();
        holder.add(m.root);
        const camera = new PerspectiveCamera(CAMERA.viewmodelFov, 16 / 9, 0.01, 10);
        camera.updateMatrixWorld(true);
        const ray = new Raycaster();
        const ndc = new Vector2();
        const poses: [string, Vector3, Euler][] = [
          ['hip', new Vector3(d.hip.pos.x, d.hip.pos.y, d.hip.pos.z), euler(d.hip)],
          [
            'sprint',
            new Vector3(
              d.hip.pos.x + (d.sprint.pos?.x ?? 0),
              d.hip.pos.y + (d.sprint.pos?.y ?? 0),
              d.hip.pos.z + (d.sprint.pos?.z ?? 0),
            ),
            new Euler(
              euler(d.hip).x + euler(d.sprint).x,
              euler(d.hip).y + euler(d.sprint).y,
              euler(d.hip).z + euler(d.sprint).z,
            ),
          ],
        ];
        for (const [label, pos, rot] of poses) {
          holder.position.copy(pos);
          holder.rotation.copy(rot);
          holder.updateMatrixWorld(true);
          for (const x of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]) {
            for (const y of [0.05, 0.35, 0.7]) {
              ray.setFromCamera(ndc.set(x, y), camera);
              expect(ray.intersectObject(m.root, true).length, `${id} ${label} @ ${x},${y}`).toBe(0);
            }
          }
        }
        holder.remove(m.root);
        m.root.updateMatrixWorld(true);
      });
    });
  }

  it('drivers: charge spreads the rails and burns the coils, the beam claws/whirls, heat spins the ring', () => {
    const rail = vdef('railgun').drivers ?? [];
    expect(rail.filter((d) => d.source === 'charge').map((d) => d.part)).toEqual(
      expect.arrayContaining(['railL', 'railR', 'coils']),
    );
    expect(rail.find((d) => d.part === 'coils')?.accentBoost ?? 0).toBeGreaterThan(0);
    const cl = vdef('chainlightning').drivers ?? [];
    expect(cl.find((d) => d.part === 'coils' && d.source === 'beam')?.spin?.axis).toBe('z');
    for (const p of ['prongA', 'prongB', 'prongC'])
      expect(cl.find((d) => d.part === p)?.source, p).toBe('beam');
    const ft = vdef('flamethrower').drivers ?? [];
    expect(ft.find((d) => d.part === 'flare')?.source).toBe('beam');
    expect(ft.find((d) => d.part === 'swirl')?.spin?.degPerSec ?? 0).toBeGreaterThan(0);
    expect(vdef('blackhole').drivers?.find((d) => d.part === 'ring')?.source).toBe('heat');
  });

  it('a full driver boost brightens the energy materials (charging railgun)', () => {
    const m = model('railgun');
    const sum = (vdef('railgun').drivers ?? []).reduce((a, d) => a + (d.accentBoost ?? 0), 0);
    const slug = energyMaterials(m).find((mat) => mat.name === 'vm-energy-rail-slug')!;
    m.animate({ time: 3, heat: 0, flash: 0 });
    const idle = slug.uniforms.uIntensity.value;
    m.animate({ time: 3, heat: 0, flash: 0, accentBoost: sum });
    expect(slug.uniforms.uIntensity.value).toBeGreaterThan(idle * 3);
  });

  it('the singularity and the cryo star collapse on a shot and re-form; the rift flares', () => {
    const cases: [string, string, (o: Object3D) => number][] = [
      ['blackhole', 'part-coreFloat', (o) => o.scale.x],
      ['cryonova', 'part-star', (o) => o.scale.x],
      ['riftripper', 'part-riftTear', (o) => o.scale.x],
    ];
    for (const [id, node, read] of cases) {
      const m = model(id);
      const obj = findNode(m.root, node)!;
      let t = 20;
      const frame = (flash: number): void => {
        t += 1 / 60;
        m.animate({ time: t, heat: 0, flash });
      };
      for (let i = 0; i < 90; i++) frame(0);
      const before = read(obj);
      frame(1);
      const after = read(obj);
      if (id === 'riftripper') expect(after, id).toBeGreaterThan(before * 1.5);
      else expect(after, id).toBeLessThan(before * 0.5);
      for (let i = 0; i < 120; i++) frame(0);
      expect(read(obj), `${id} re-formed`).toBeCloseTo(before, 1);
    }
  });

  it('free spinners turn without the animator (black hole gyro, harp crystal)', () => {
    for (const [id, node] of [
      ['blackhole', 'part-gyro'],
      ['aetherharp', 'part-crystal'],
    ] as const) {
      const m = model(id);
      const obj = findNode(m.root, node)!;
      m.animate({ time: 1, heat: 0, flash: 0 });
      const q0 = obj.quaternion.clone();
      m.animate({ time: 1.25, heat: 0, flash: 0 });
      expect(obj.quaternion.angleTo(q0), id).toBeGreaterThan(0.05);
    }
  });

  it('wonder weapons tint their readout; low/empty keep the shared warning colors', () => {
    const m = model('riftripper');
    const readout = meshes(m.root)
      .map((mesh) => mesh.material as MeshStandardMaterial)
      .find((mat) => mat.name === 'vm-readout')!;
    const data = (readout.emissiveMap!.image as { data: Uint8Array }).data;
    const on = VIEWMODEL_ART.emissive.readoutOn;
    m.setAmmo(8, 8);
    let cyan = 0;
    for (let i = 0; i + 2 < data.length; i += 4)
      if (data[i] === on[0] && data[i + 1] === on[1] && data[i + 2] === on[2]) cyan++;
    expect(cyan).toBe(0);
    expect([data[0], data[1], data[2]]).toEqual([255, 80, 220]);
  });

  it('the loading grenade is hidden at rest, magazines are shown', () => {
    expect(model('grenadelauncher').parts.shells!.visible).toBe(false);
    for (const [id, part] of [
      ['plasma', 'cell'],
      ['railgun', 'cell'],
      ['flamethrower', 'tank'],
      ['cryonova', 'canister'],
      ['flamethrower', 'pilot'],
    ] as const) {
      expect(model(id).parts[part]!.visible, `${id}.${part}`).toBe(true);
    }
  });

  it('dispose releases the energy and per-model materials', () => {
    const k = new WeaponMaterialKit();
    const m = createWeaponViewmodel('blackhole', k)!;
    const owned = new Set<Material>();
    for (const mesh of meshes(m.root)) {
      const mat = mesh.material as Material;
      if (
        mat.name.startsWith('vm-energy-') ||
        mat.name.startsWith('vm-chitin') ||
        mat.name.startsWith('vm-ice')
      )
        owned.add(mat);
    }
    expect(owned.size).toBeGreaterThan(2);
    let disposed = 0;
    for (const mat of owned) mat.addEventListener('dispose', () => disposed++);
    m.dispose();
    expect(disposed).toBe(owned.size);
    k.dispose();
  });
});
