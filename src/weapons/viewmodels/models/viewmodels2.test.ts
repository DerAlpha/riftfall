/**
 * Package C2 viewmodels (burst/battle rifle, auto/double-barrel shotgun, LMG, minigun, sniper,
 * marksman): contract, choreography ↔ parts, reload marker anchoring, bloom, ADS alignment, mounts,
 * scope depth masks, the minigun's spin axis and the hip pose staying out of the upper screen half.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  Color,
  Euler,
  Group,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
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
import { MOUNT_NAMES } from '../ModelBuilder';
import { WeaponMaterialKit, createWeaponViewmodel, hasViewmodel, type WeaponViewmodelModel } from '../index';
import { adsOffsetFromSight } from '../socketMath';
import { M5_BUILDERS } from './index';
import { AUTOSHOTGUN_SIGHT_LINE } from './autoshotgun';
import { BATTLERIFLE_SIGHT_LINE } from './battlerifle';
import { BURSTRIFLE_SIGHT_LINE } from './burstrifle';
import { DOUBLEBARREL_SIGHT_LINE } from './doublebarrel';
import { LMG_SIGHT_LINE } from './lmg';
import { MARKSMAN_SIGHT_LINE } from './marksman';
import { MINIGUN_SIGHT_LINE } from './minigun';
import { SNIPER_SIGHT_LINE } from './sniper';

/** Named parts per the M5 roster (plus the extras the choreography uses). */
const REQUIRED_PARTS: Record<string, readonly string[]> = {
  burstrifle: ['bolt', 'magazine', 'trigger', 'chargingHandle', 'sight'],
  battlerifle: ['bolt', 'magazine', 'trigger', 'chargingHandle', 'sight'],
  autoshotgun: ['magazine', 'drum', 'bolt', 'trigger', 'chargingHandle', 'sight'],
  doublebarrel: ['barrels', 'shells', 'hammers', 'trigger', 'lever'],
  lmg: ['cover', 'magazine', 'belt', 'bolt', 'trigger', 'sight'],
  minigun: ['barrels', 'magazine', 'trigger', 'chute', 'lever', 'sight'],
  sniper: ['bolt', 'boltHandle', 'magazine', 'trigger', 'sight'],
  marksman: ['bolt', 'dustCover', 'boltCatch', 'magazine', 'trigger', 'sight'],
};
const SIGHT_LINES: Record<string, number> = {
  burstrifle: BURSTRIFLE_SIGHT_LINE,
  battlerifle: BATTLERIFLE_SIGHT_LINE,
  autoshotgun: AUTOSHOTGUN_SIGHT_LINE,
  doublebarrel: DOUBLEBARREL_SIGHT_LINE,
  lmg: LMG_SIGHT_LINE,
  minigun: MINIGUN_SIGHT_LINE,
  sniper: SNIPER_SIGHT_LINE,
  marksman: MARKSMAN_SIGHT_LINE,
};
const IDS = Object.keys(REQUIRED_PARTS);
/** Markers the roster gives every weapon of this package (used until the weapon defs exist). */
const ROSTER_TACTICAL: readonly ReloadStep[] = ['magOut', 'magIn'];
const ROSTER_EMPTY: readonly ReloadStep[] = ['magOut', 'magIn', 'boltRelease'];
/** Break action / belt feed: the tactical reload also closes (boltRelease). */
const CLOSES_ON_TACTICAL = new Set(['doublebarrel', 'lmg']);
/** Draw-call budget per model (meshes = one per part × material). */
const MAX_MESHES = 24;

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

function modelSpace(obj: Object3D, root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  return obj.getWorldPosition(new Vector3()).applyMatrix4(inv);
}

function euler(p: PoseDef | undefined): Euler {
  const r = p?.rot;
  return new Euler((r?.x ?? 0) * DEG2RAD, (r?.y ?? 0) * DEG2RAD, (r?.z ?? 0) * DEG2RAD);
}

describe('C2 weapon viewmodels', () => {
  it('every model is registered and has a def', () => {
    for (const id of IDS) {
      expect(M5_BUILDERS[id], id).toBeTypeOf('function');
      expect(hasViewmodel(id), id).toBe(true);
      expect(getViewmodelDef(id), id).toBeDefined();
    }
  });

  for (const id of IDS) {
    describe(id, () => {
      it('implements the contract: named parts, sockets, mounts, few merged meshes', () => {
        const m = model(id);
        expect(m.weaponId).toBe(id);
        expect(m.root).toBeInstanceOf(Group);
        for (const p of REQUIRED_PARTS[id]!) expect(m.parts[p], `${id}.${p}`).toBeInstanceOf(Object3D);
        for (const s of [m.muzzle, m.ejectPort, m.sight]) {
          let n: Object3D | null = s;
          while (n && n !== m.root) n = n.parent;
          expect(n).toBe(m.root);
        }
        for (const name of MOUNT_NAMES)
          expect(m.mounts[name], `${id} mount ${name}`).toBeInstanceOf(Object3D);
        const list = meshes(m.root);
        expect(list.length).toBeGreaterThan(6);
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

      it('every part the choreography and the drivers reference exists', () => {
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

      it('reload tracks anchor every marker in order (weapon def, else the roster markers)', () => {
        const d = vdef(id);
        expect(d.reload.style).toBe('timeline');
        if (d.reload.style !== 'timeline') return;
        const wdef = getWeaponDef(id);
        const tactical = wdef
          ? wdef.reload.tacticalSteps.map((s) => s.step)
          : CLOSES_ON_TACTICAL.has(id)
            ? ROSTER_EMPTY
            : ROSTER_TACTICAL;
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
      });

      it('a part pulsed per shot and latched on the last shot finishes its pulse within the shot interval', () => {
        const d = vdef(id);
        const wdef = getWeaponDef(id);
        if (!wdef) return;
        const rpm = wdef.fireMode === 'burst' && wdef.burst ? Math.max(wdef.rpm, wdef.burst.rpm) : wdef.rpm;
        const interval = 60 / rpm;
        const latched = new Set(d.fireLast.filter((m) => m.type === 'tween').map((m) => m.part));
        for (const m of d.fire) {
          if (m.type !== 'pulse' || !latched.has(m.part)) continue;
          const end = (m.delay ?? 0) + m.duration + (m.hold ?? 0) + (m.release ?? m.duration);
          expect(end, `${id}: ${m.part}`).toBeLessThanOrEqual(interval);
        }
      });

      it('every glow clears the bloom threshold + smoothing (all readout states, pulse minimum)', () => {
        const m = model(id);
        const d = vdef(id);
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
        for (const v of [d.glow.accent, d.glow.readout, d.glow.sight, d.glow.heat])
          expect(v).toBeGreaterThan(1);
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

      it('nothing sits between the eye and the sight socket at full ADS', () => {
        const m = model(id);
        const d = vdef(id);
        m.root.updateMatrixWorld(true);
        const sight = modelSpace(m.sight, m.root);
        const eye = sight.clone().add(new Vector3(0, 0, d.adsEyeDistance));
        const ray = new Raycaster(eye, new Vector3(0, 0, -1), 0, d.adsEyeDistance - 1e-4);
        const hits = ray.intersectObject(m.root, true).filter((h) => (h.object as Mesh).visible);
        // Glass and the reticle itself (it IS the aim point) do not block the picture.
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

  it('scoped rifles: a depth-only disk just in front of the reticle, drawn before everything else', () => {
    for (const id of ['sniper', 'marksman']) {
      const m = model(id);
      const masks = meshes(m.root).filter((mesh) => (mesh.material as Material).colorWrite === false);
      expect(masks.length, id).toBe(1);
      const mask = masks[0]!;
      expect(mask.renderOrder).toBeLessThan(0);
      expect((mask.material as Material).depthWrite).toBe(true);
      mask.geometry.computeBoundingBox();
      const box = mask.geometry.boundingBox!.clone().applyMatrix4(mask.matrixWorld);
      const sight = modelSpace(m.sight, m.root);
      // In front of the reticle (further from the eye), by a few millimeters at most.
      expect(box.max.z).toBeLessThan(sight.z);
      expect(sight.z - box.max.z).toBeLessThan(0.005);
      // Centered on the sight line.
      expect((box.min.y + box.max.y) / 2).toBeCloseTo(sight.y, 6);
    }
  });

  it('minigun: the spinning cluster turns around the bore axis (no part rotation, muzzle on the axis)', () => {
    const m = model('minigun');
    const d = vdef('minigun');
    const spin = (d.drivers ?? []).find((dr) => dr.source === 'spin');
    expect(spin?.part).toBe('barrels');
    expect(spin?.spin?.axis).toBe('z');
    expect(spin?.spin?.degPerSec ?? 0).toBeGreaterThan(0);
    const barrels = m.parts.barrels!;
    expect(barrels.quaternion.equals(new Quaternion())).toBe(true);
    const axis = modelSpace(barrels, m.root);
    const muzzle = modelSpace(m.muzzle, m.root);
    expect(muzzle.x).toBeCloseTo(axis.x, 9);
    expect(muzzle.y).toBeCloseTo(axis.y, 9);
  });

  it('break action: shells hidden at rest, the barrels pivot on the hinge below the bore', () => {
    const m = model('doublebarrel');
    expect(m.parts.shells!.visible).toBe(false);
    const hinge = modelSpace(m.parts.barrels!, m.root);
    const muzzle = modelSpace(m.muzzle, m.root);
    expect(hinge.y).toBeLessThan(muzzle.y);
    expect(hinge.z).toBeGreaterThan(muzzle.z);
  });

  it('KR-7 and SG-12 declare every attachment mount (the shotgun grip rides on the pump)', () => {
    for (const id of ['rifle', 'shotgun']) {
      const m = model(id);
      for (const name of MOUNT_NAMES) expect(m.mounts[name], `${id} mount ${name}`).toBeInstanceOf(Object3D);
      const muzzle = modelSpace(m.muzzle, m.root);
      const device = modelSpace(m.mounts.muzzleDevice!, m.root);
      expect(device.distanceTo(muzzle)).toBeLessThan(1e-6);
    }
    expect(model('shotgun').mounts.underbarrel!.parent).toBe(model('shotgun').parts.pump);
  });

  it('sniper: the bolt handle rides on the bolt; the LMG sight rides on the feed cover', () => {
    expect(model('sniper').parts.boltHandle!.parent).toBe(model('sniper').parts.bolt);
    expect(model('lmg').parts.sight!.parent).toBe(model('lmg').parts.cover);
    expect(model('lmg').parts.belt!.parent).toBe(model('lmg').parts.magazine);
    expect(model('autoshotgun').parts.drum!.parent).toBe(model('autoshotgun').parts.magazine);
  });
});
