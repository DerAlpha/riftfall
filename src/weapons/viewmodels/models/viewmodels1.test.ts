/**
 * Package C1 viewmodels (M5): revolver, machinepistol, smg, pdw, vector – contract, choreography
 * references, sight alignment, attachment mounts and a full fire/reload cycle through the animator.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Color, Group, Mesh, Object3D, SRGBColorSpace, Vector3, type MeshStandardMaterial } from 'three';
import { EventBus } from '../../../core/EventBus';
import type { GameEvents } from '../../../core/events';
import { POSTFX } from '../../../defs/postfx';
import {
  VIEWMODEL_ANIM,
  VIEWMODEL_ART,
  getViewmodelDef,
  type PartMotionDef,
  type WeaponViewmodelDef,
} from '../../../defs/viewmodels';
import { getWeaponDef, type ReloadMarker, type ReloadStep } from '../../../defs/weapons';
import { ViewmodelAnimator } from '../../ViewmodelAnimator';
import { MOUNT_NAMES, type MountName } from '../ModelBuilder';
import { WeaponMaterialKit, createWeaponViewmodel, hasViewmodel, type WeaponViewmodelModel } from '../index';
import { adsOffsetFromSight } from '../socketMath';
import { MACHINEPISTOL_SIGHT_LINE } from './machinepistol';
import { PDW_SIGHT_LINE } from './pdw';
import { REVOLVER_SIGHT_LINE } from './revolver';
import { SMG_SIGHT_LINE } from './smg';
import { VECTOR_SIGHT_LINE } from './vector';

interface Spec {
  /** Named parts per the roster (choreography targets). */
  parts: readonly string[];
  mounts: readonly MountName[];
  sightLine: number;
  /** Parts hidden at rest. */
  hidden: readonly string[];
  /** Reload markers to exercise when the weapon def is not available (fallback timing). */
  fallbackReload: {
    tactical: number;
    empty: number;
    tacticalSteps: ReloadMarker[];
    emptySteps: ReloadMarker[];
  };
}

const STD_RELOAD = (tactical: number, empty: number): Spec['fallbackReload'] => ({
  tactical,
  empty,
  tacticalSteps: [
    { step: 'magOut', at: tactical * 0.21 },
    { step: 'magIn', at: tactical * 0.62 },
  ],
  emptySteps: [
    { step: 'magOut', at: empty * 0.16 },
    { step: 'magIn', at: empty * 0.48 },
    { step: 'boltRelease', at: empty * 0.77 },
  ],
});

const SPECS: Readonly<Record<string, Spec>> = {
  revolver: {
    parts: ['cylinder', 'crane', 'ejector', 'speedloader', 'rounds', 'hammer', 'trigger'],
    mounts: ['optic', 'muzzleDevice', 'laser'],
    sightLine: REVOLVER_SIGHT_LINE,
    hidden: ['speedloader'],
    fallbackReload: {
      tactical: 2.1,
      empty: 2.25,
      tacticalSteps: [
        { step: 'magOut', at: 0.4 },
        { step: 'magIn', at: 1.25 },
        { step: 'boltRelease', at: 1.7 },
      ],
      emptySteps: [
        { step: 'magOut', at: 0.38 },
        { step: 'magIn', at: 1.3 },
        { step: 'boltRelease', at: 1.8 },
      ],
    },
  },
  machinepistol: {
    parts: ['slide', 'magazine', 'trigger'],
    mounts: ['optic', 'muzzleDevice', 'laser', 'stock'],
    sightLine: MACHINEPISTOL_SIGHT_LINE,
    hidden: [],
    fallbackReload: STD_RELOAD(1.45, 1.8),
  },
  smg: {
    parts: ['bolt', 'magazine', 'trigger'],
    mounts: ['optic', 'muzzleDevice', 'underbarrel', 'laser', 'stock'],
    sightLine: SMG_SIGHT_LINE,
    hidden: [],
    fallbackReload: STD_RELOAD(1.6, 2.05),
  },
  pdw: {
    parts: ['magazine', 'bolt', 'trigger'],
    mounts: ['optic', 'muzzleDevice', 'underbarrel', 'laser', 'stock'],
    sightLine: PDW_SIGHT_LINE,
    hidden: [],
    fallbackReload: STD_RELOAD(2, 2.45),
  },
  vector: {
    parts: ['bolt', 'magazine', 'trigger'],
    mounts: ['optic', 'muzzleDevice', 'underbarrel', 'laser', 'stock'],
    sightLine: VECTOR_SIGHT_LINE,
    hidden: [],
    fallbackReload: STD_RELOAD(1.5, 1.9),
  },
};
const IDS = Object.keys(SPECS);
/** Draw-call budget per model (meshes = one per part × material), as for the M2 models. */
const MAX_MESHES = 24;
const DT = 1 / 60;

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

function modelSpace(obj: Object3D, root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  return obj.getWorldPosition(new Vector3()).applyMatrix4(inv);
}

function descendsFrom(obj: Object3D, root: Object3D): boolean {
  let n: Object3D | null = obj;
  while (n && n !== root) n = n.parent;
  return n === root;
}

function vdef(id: string): WeaponViewmodelDef {
  const d = getViewmodelDef(id);
  if (!d) throw new Error(`no viewmodel def ${id}`);
  return d;
}

function reloadTiming(id: string): Spec['fallbackReload'] {
  const w = getWeaponDef(id);
  if (!w) return SPECS[id]!.fallbackReload;
  return {
    tactical: w.reload.tactical,
    empty: w.reload.empty,
    tacticalSteps: [...w.reload.tacticalSteps],
    emptySteps: [...w.reload.emptySteps],
  };
}

describe('C1 viewmodels (revolver, machine pistol, SMG, PDW, KV-9)', () => {
  for (const id of IDS) {
    const spec = SPECS[id]!;
    describe(id, () => {
      it('is registered with a viewmodel def and implements the contract (parts, sockets, merged meshes)', () => {
        expect(hasViewmodel(id)).toBe(true);
        const m = model(id);
        expect(m.weaponId).toBe(id);
        expect(m.def).toBe(vdef(id));
        expect(m.root).toBeInstanceOf(Group);
        for (const p of spec.parts) expect(m.parts[p], `${id}.${p}`).toBeInstanceOf(Object3D);
        for (const s of [m.muzzle, m.ejectPort, m.sight]) expect(descendsFrom(s, m.root)).toBe(true);
        const list = meshes(m.root);
        expect(list.length).toBeGreaterThan(8);
        expect(list.length).toBeLessThanOrEqual(MAX_MESHES);
        const seen = new Set<string>();
        for (const mesh of list) {
          const key = `${mesh.parent!.uuid}/${(mesh.material as MeshStandardMaterial).uuid}`;
          expect(seen.has(key), key).toBe(false);
          seen.add(key);
          for (const a of ['position', 'normal', 'uv', 'color'])
            expect(mesh.geometry.getAttribute(a), `${id} ${mesh.name} ${a}`).toBeDefined();
          const pos = mesh.geometry.getAttribute('position');
          const nrm = mesh.geometry.getAttribute('normal');
          for (let i = 0; i < pos.count; i++) {
            expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
            expect(
              Number.isFinite(nrm.getX(i) + nrm.getY(i) + nrm.getZ(i)),
              `${id} ${mesh.name} normal`,
            ).toBe(true);
          }
        }
        for (const p of spec.hidden) expect(m.parts[p]!.visible, `${id}.${p} hidden`).toBe(false);
        for (const p of spec.parts)
          if (!spec.hidden.includes(p)) expect(m.parts[p]!.visible, `${id}.${p} visible`).toBe(true);
      });

      it('declares its attachment mounts on the model (+ Y up, −Z forward), none it cannot carry', () => {
        const m = model(id);
        for (const name of MOUNT_NAMES) {
          if (spec.mounts.includes(name)) {
            expect(m.mounts[name], `${id} mount ${name}`).toBeInstanceOf(Object3D);
            expect(descendsFrom(m.mounts[name]!, m.root)).toBe(true);
          } else expect(m.mounts[name], `${id} has no ${name}`).toBeUndefined();
        }
        const muzzle = modelSpace(m.muzzle, m.root);
        const sight = modelSpace(m.sight, m.root);
        // Muzzle device on the barrel tip, the optic on top behind it, a stock (if any) at the back.
        expect(modelSpace(m.mounts.muzzleDevice!, m.root).distanceTo(muzzle)).toBeLessThan(0.01);
        const optic = modelSpace(m.mounts.optic!, m.root);
        expect(optic.y).toBeGreaterThan(muzzle.y);
        expect(optic.z).toBeGreaterThan(muzzle.z + 0.05);
        expect(Math.abs(optic.x)).toBeLessThan(1e-6);
        if (m.mounts.stock) expect(modelSpace(m.mounts.stock, m.root).z).toBeGreaterThan(sight.z - 0.1);
        if (m.mounts.underbarrel) expect(modelSpace(m.mounts.underbarrel, m.root).y).toBeLessThan(muzzle.y);
        // The weapon's attachment slots (A1 data) all have somewhere to go.
        const slotToMount: Readonly<Record<string, MountName | null>> = {
          optic: 'optic',
          muzzle: 'muzzleDevice',
          underbarrel: 'underbarrel',
          laser: 'laser',
          stock: 'stock',
          magazine: null,
        };
        for (const slot of getWeaponDef(id)?.attachmentSlots ?? []) {
          const mount = slotToMount[slot];
          if (mount) expect(m.mounts[mount], `${id}: slot ${slot} → mount ${mount}`).toBeDefined();
        }
      });

      it('every part the choreography references exists; leads only on reload steps', () => {
        const m = model(id);
        const d = vdef(id);
        const lists: (readonly PartMotionDef[])[] = [d.fire, d.fireLast, d.dryFire];
        for (const l of Object.values(d.reloadSteps)) if (l) lists.push(l);
        for (const l of lists)
          for (const mo of l) expect(m.parts[mo.part], `${id}: ${mo.part}`).toBeDefined();
        for (const p of d.lockParts) expect(m.parts[p], `${id}: lock ${p}`).toBeDefined();
        for (const dr of d.drivers ?? []) expect(m.parts[dr.part], `${id}: driver ${dr.part}`).toBeDefined();
        for (const l of [d.fire, d.fireLast, d.dryFire]) for (const mo of l) expect(mo.lead).toBeUndefined();
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

      it('reload tracks anchor every marker of the weapon, in marker order', () => {
        const d = vdef(id);
        const timing = reloadTiming(id);
        expect(d.reload.style).toBe('timeline');
        if (d.reload.style !== 'timeline') return;
        const tracks = [
          [d.reload.tactical, timing.tacticalSteps],
          [d.reload.empty, timing.emptySteps],
        ] as const;
        for (const [track, steps] of tracks) {
          let prev = 0;
          for (const mk of steps) {
            const authored = track.markers[mk.step];
            expect(authored, `${id}: ${mk.step}`).toBeDefined();
            expect(authored!).toBeGreaterThan(prev);
            expect(authored!).toBeLessThan(1);
            prev = authored!;
          }
        }
      });

      it('sights: the socket sits on the sight line, ADS centers it, muzzle ahead and below', () => {
        const m = model(id);
        const d = vdef(id);
        const sight = modelSpace(m.sight, m.root);
        expect(sight.y).toBeCloseTo(spec.sightLine, 9);
        expect(sight.x).toBeCloseTo(0, 9);
        const off = adsOffsetFromSight(sight, d.adsEyeDistance, new Vector3(), d.adsNudge);
        const cam = sight.clone().add(off);
        expect(cam.x).toBeCloseTo(0, 9);
        expect(cam.y).toBeCloseTo(0, 9);
        expect(cam.z).toBeCloseTo(-d.adsEyeDistance, 9);
        const muzzle = modelSpace(m.muzzle, m.root);
        expect(muzzle.z).toBeLessThan(sight.z - 0.1);
        expect(sight.y).toBeGreaterThan(muzzle.y);
        expect(Math.abs(muzzle.x)).toBeLessThan(1e-6);
        // Effect directions: the muzzle fires down −Z.
        const dir = new Vector3(0, 0, -1).transformDirection(m.muzzle.matrixWorld);
        expect(dir.z).toBeLessThan(-0.99);
      });

      it('every glow clears the bloom threshold + smoothing (accent, heat, sight, readout states)', () => {
        const m = model(id);
        const d = vdef(id);
        for (const v of [d.glow.accent, d.glow.readout, d.glow.sight, d.glow.heat])
          expect(v).toBeGreaterThan(1);
        const { luminanceThreshold, luminanceSmoothing } = POSTFX.bloom;
        const floor = luminanceThreshold + luminanceSmoothing;
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
          return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * mat.emissiveIntensity;
        };
        const A = VIEWMODEL_ANIM;
        m.animate({ time: (1.5 * Math.PI) / A.accentPulse.rate, heat: 1, flash: 0 });
        expect(lum(glowOf('vm-accent')), 'accent').toBeGreaterThanOrEqual(floor);
        m.animate({ time: (1.5 * Math.PI) / A.heatFlicker.rate, heat: 1, flash: 0 });
        expect(lum(glowOf('vm-heat')), 'heat').toBeGreaterThanOrEqual(floor);
        expect(lum(glowOf('vm-sight')), 'sight').toBeGreaterThanOrEqual(floor);
        const E = VIEWMODEL_ART.emissive;
        const states: [number, readonly number[]][] = [
          [30, E.readoutOn],
          [2, E.readoutLow],
          [0, E.readoutEmpty],
        ];
        for (const [mag, rgb] of states) {
          m.setAmmo(mag, 30);
          m.animate({ time: (0.5 * Math.PI) / A.emptyBlinkRate, heat: 0, flash: 0 });
          expect(lum(glowOf('vm-readout'), rgb), `readout ${mag}`).toBeGreaterThanOrEqual(floor);
        }
      });

      it('a full fire → empty reload → tactical reload cycle returns every part to rest', () => {
        const m = model(id);
        const events = new EventBus<GameEvents>();
        const anim = new ViewmodelAnimator({ events, showModel: () => m });
        anim.snapTo(id);
        const step = (s: number): void => {
          const n = Math.max(1, Math.round(s / DT));
          for (let i = 0; i < n; i++) anim.update(s / n, 0, 0);
        };
        step(0.2);
        const rest = new Map<string, { p: Vector3; v: boolean }>();
        for (const [name, obj] of Object.entries(m.parts))
          rest.set(name, { p: obj.position.clone(), v: obj.visible });
        const V0 = { x: 0, y: 0, z: 0 };
        const fire = (ammoInMag: number): void =>
          events.emit('weapon:fired', {
            weaponId: id,
            origin: V0,
            direction: { x: 0, y: 0, z: -1 },
            muzzle: V0,
            shotIndex: 0,
            ammoInMag,
            ads: false,
          });
        const reload = (empty: boolean): void => {
          const t = reloadTiming(id);
          const duration = empty ? t.empty : t.tactical;
          const steps = empty ? t.emptySteps : t.tacticalSteps;
          events.emit('weapon:reloadStart', { weaponId: id, empty, duration });
          let clock = 0;
          for (const mk of steps) {
            step(mk.at - clock);
            clock = mk.at;
            events.emit('weapon:reloadStep', { weaponId: id, step: mk.step as ReloadStep });
          }
          step(duration - clock);
          events.emit('weapon:ammoChanged', { weaponId: id, mag: 10, reserve: 50, magSize: 10 });
          events.emit('weapon:reloadEnd', { weaponId: id, completed: true });
          step(1);
        };
        events.emit('weapon:ammoChanged', { weaponId: id, mag: 2, reserve: 50, magSize: 10 });
        fire(1);
        step(0.3);
        fire(0);
        events.emit('weapon:ammoChanged', { weaponId: id, mag: 0, reserve: 50, magSize: 10 });
        step(0.5);
        reload(true);
        fire(9);
        step(0.4);
        reload(false);
        for (const [name, obj] of Object.entries(m.parts)) {
          const r = rest.get(name)!;
          expect(obj.position.distanceTo(r.p), `${id}.${name} home`).toBeLessThan(1e-6);
          expect(obj.visible, `${id}.${name} visibility`).toBe(r.v);
        }
        expect(Math.abs(anim.pose.rz)).toBeLessThan(0.01);
        anim.dispose();
      });
    });
  }

  it('the revolver indexes its cylinder 60° per shot and swings the crane out on magOut', () => {
    const m = model('revolver');
    const events = new EventBus<GameEvents>();
    const anim = new ViewmodelAnimator({ events, showModel: () => m });
    anim.snapTo('revolver');
    const step = (s: number): void => {
      const n = Math.max(1, Math.round(s / DT));
      for (let i = 0; i < n; i++) anim.update(s / n, 0, 0);
    };
    step(0.1);
    const cyl = m.parts.cylinder!;
    const crane = m.parts.crane!;
    const cylRest = cyl.quaternion.clone();
    const craneRest = crane.quaternion.clone();
    events.emit('weapon:fired', {
      weaponId: 'revolver',
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      muzzle: { x: 0, y: 0, z: 0 },
      shotIndex: 0,
      ammoInMag: 5,
      ads: false,
    });
    step(0.4);
    expect((cyl.quaternion.angleTo(cylRest) * 180) / Math.PI).toBeCloseTo(60, 3);
    events.emit('weapon:reloadStart', { weaponId: 'revolver', empty: false, duration: 2.1 });
    step(0.4);
    events.emit('weapon:reloadStep', { weaponId: 'revolver', step: 'magOut' });
    step(0.3);
    // Swung out to the left: the cylinder axis moved clear of the frame.
    expect((crane.quaternion.angleTo(craneRest) * 180) / Math.PI).toBeGreaterThan(80);
    const axis = modelSpace(cyl, m.root);
    expect(axis.x).toBeLessThan(-0.035);
    step(0.35);
    expect(m.parts.rounds!.visible).toBe(false);
    events.emit('weapon:reloadEnd', { weaponId: 'revolver', completed: false });
    step(0.5);
    expect(crane.quaternion.angleTo(craneRest)).toBeLessThan(1e-6);
    expect(m.parts.rounds!.visible).toBe(true);
    anim.dispose();
  });

  it('M5 viewmodel defs stay importable without a runtime cycle', () => {
    for (const id of IDS) expect(getViewmodelDef(id)).toBeDefined();
  });
});
