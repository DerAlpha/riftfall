import { afterAll, describe, expect, it } from 'vitest';
import {
  Color,
  Group,
  Mesh,
  Object3D,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';
import { POSTFX } from '../../defs/postfx';
import {
  VIEWMODELS,
  VIEWMODEL_ANIM,
  VIEWMODEL_ART,
  getViewmodelDef,
  type PartMotionDef,
  type WeaponViewmodelDef,
} from '../../defs/viewmodels';
import { WEAPON_IDS, getWeaponDef } from '../../defs/weapons';
import {
  WeaponMaterialKit,
  createWeaponViewmodel,
  hasViewmodel,
  registerViewmodelBuilder,
  viewmodelIds,
  type WeaponViewmodelModel,
} from './index';
import { adsOffsetFromSight } from './socketMath';
import { PISTOL_SIGHT_LINE } from './pistol';
import { RIFLE_SIGHT_LINE } from './rifle';
import { SHOTGUN_SIGHT_LINE } from './shotgun';

const REQUIRED_PARTS: Record<string, readonly string[]> = {
  pistol: ['slide', 'magazine', 'trigger', 'hammer'],
  rifle: ['chargingHandle', 'bolt', 'magazine', 'trigger', 'dustCover', 'sight'],
  shotgun: ['pump', 'shell', 'trigger', 'sight'],
};
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

describe('weapon viewmodel models', () => {
  it('every M2 weapon has a builder and a viewmodel def', () => {
    for (const id of WEAPON_IDS) {
      expect(hasViewmodel(id)).toBe(true);
      expect(getViewmodelDef(id)).toBeDefined();
    }
    expect(viewmodelIds()).toEqual(expect.arrayContaining([...WEAPON_IDS]));
    expect(getViewmodelDef('nope')).toBeUndefined();
    expect(getViewmodelDef('toString')).toBeUndefined();
  });

  for (const id of ['pistol', 'rifle', 'shotgun']) {
    describe(id, () => {
      it('implements the contract: named parts, sockets, few merged meshes', () => {
        const m = model(id);
        expect(m.weaponId).toBe(id);
        expect(m.root).toBeInstanceOf(Group);
        for (const p of REQUIRED_PARTS[id]!) expect(m.parts[p], `${id}.${p}`).toBeInstanceOf(Object3D);
        for (const s of [m.muzzle, m.ejectPort, m.sight]) {
          let n: Object3D | null = s;
          while (n && n !== m.root) n = n.parent;
          expect(n).toBe(m.root);
        }
        const list = meshes(m.root);
        expect(list.length).toBeGreaterThan(4);
        expect(list.length).toBeLessThanOrEqual(MAX_MESHES);
        // Geometry is merged per (part, material): no two meshes of one parent share a material.
        const seen = new Set<string>();
        for (const mesh of list) {
          const key = `${mesh.parent!.uuid}/${(mesh.material as MeshStandardMaterial).uuid}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
          const geo = mesh.geometry as BufferGeometry;
          for (const a of ['position', 'normal', 'uv', 'color']) expect(geo.getAttribute(a), a).toBeDefined();
          const pos = geo.getAttribute('position');
          for (let i = 0; i < pos.count; i++)
            expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
        }
      });

      it('glowing materials bloom (emissive intensity > 1)', () => {
        const m = model(id);
        const def = VIEWMODELS[id as keyof typeof VIEWMODELS];
        for (const v of [def.glow.accent, def.glow.readout, def.glow.sight, def.glow.heat])
          expect(v).toBeGreaterThan(1);
        m.setAmmo(3, 10);
        m.animate({ time: 1, heat: 1, flash: 0 });
        let emissive = 0;
        for (const mesh of meshes(m.root)) {
          const mat = mesh.material as MeshStandardMaterial;
          if (mat.emissiveIntensity > 1 && mat.emissive.getHex() !== 0) emissive++;
        }
        expect(emissive).toBeGreaterThanOrEqual(3);
      });

      it('every part the choreography references exists in the model', () => {
        const m = model(id);
        const def = VIEWMODELS[id as keyof typeof VIEWMODELS];
        const lists: (readonly PartMotionDef[])[] = [def.fire, def.fireLast, def.dryFire];
        for (const l of Object.values(def.reloadSteps)) if (l) lists.push(l);
        for (const l of lists)
          for (const mo of l) expect(m.parts[mo.part], `${id}: ${mo.part}`).toBeDefined();
        for (const p of def.lockParts) expect(m.parts[p]).toBeDefined();
        if (def.reload.style === 'timeline') {
          for (const track of [def.reload.tactical, def.reload.empty]) {
            const keys = track.keys;
            for (let i = 0; i < keys.length; i++) {
              expect(keys[i]!.t).toBeGreaterThan(0);
              expect(keys[i]!.t).toBeLessThan(1);
              if (i > 0) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
            }
          }
        }
        // Lead motions are scheduled from marker times: only meaningful on reload steps.
        const shotLists: (readonly PartMotionDef[])[] = [def.fire, def.fireLast, def.dryFire];
        for (const l of shotLists) for (const mo of l) expect(mo.lead, `${id}: ${mo.part}`).toBeUndefined();
      });

      it('reload tracks anchor every marker of the weapon, in marker order', () => {
        const def: WeaponViewmodelDef = VIEWMODELS[id as keyof typeof VIEWMODELS];
        const wdef = getWeaponDef(id)!;
        if (def.reload.style !== 'timeline') {
          expect(wdef.reload.perShell).not.toBeNull();
          return;
        }
        const tracks = [
          [def.reload.tactical, wdef.reload.tacticalSteps],
          [def.reload.empty, wdef.reload.emptySteps],
        ] as const;
        for (const [track, steps] of tracks) {
          expect(steps.length).toBeGreaterThan(0);
          let prev = 0;
          for (const m of steps) {
            const authored = track.markers[m.step];
            expect(authored, `${id}: ${m.step}`).toBeDefined();
            expect(authored!).toBeGreaterThan(prev);
            expect(authored!).toBeLessThan(1);
            prev = authored!;
          }
        }
      });

      it('every glow clears the bloom threshold + smoothing (all readout states, pulse minimum)', () => {
        const m = model(id);
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
        // Accent at the bottom of its breathing pulse, heat vents at full heat (bottom of the flicker).
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
          // The blinking empty readout: its bright phase.
          m.animate({ time: (0.5 * Math.PI) / A.emptyBlinkRate, heat: 0, flash: 0 });
          expect(lum(glowOf('vm-readout'), rgb), `readout ${mag}`).toBeGreaterThanOrEqual(floor);
        }
      });

      it('ADS offset derived from the sight socket centers it on the view axis', () => {
        const m = model(id);
        const def = VIEWMODELS[id as keyof typeof VIEWMODELS];
        const sight = modelSpace(m.sight, m.root);
        const off = adsOffsetFromSight(sight, def.adsEyeDistance, new Vector3());
        const cam = sight.clone().add(off);
        expect(cam.x).toBeCloseTo(0, 9);
        expect(cam.y).toBeCloseTo(0, 9);
        expect(cam.z).toBeCloseTo(-def.adsEyeDistance, 9);
        // The muzzle is ahead of the sight, the sight above the bore.
        const muzzle = modelSpace(m.muzzle, m.root);
        expect(muzzle.z).toBeLessThan(sight.z);
        expect(sight.y).toBeGreaterThan(muzzle.y);
      });
    });
  }

  it('iron/red-dot sight lines are level: the sight socket sits on the model sight line', () => {
    expect(modelSpace(model('pistol').sight, model('pistol').root).y).toBeCloseTo(PISTOL_SIGHT_LINE, 9);
    expect(modelSpace(model('rifle').sight, model('rifle').root).y).toBeCloseTo(RIFLE_SIGHT_LINE, 9);
    expect(modelSpace(model('shotgun').sight, model('shotgun').root).y).toBeCloseTo(SHOTGUN_SIGHT_LINE, 9);
  });

  it('an empty readout blinks hard, and pulses softly with reduce flashing', () => {
    const m = model('smg');
    m.setAmmo(0, 30);
    const readout = (): number => {
      let v = -1;
      m.root.traverse((o) => {
        const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
        if (mat?.name === 'vm-readout') v = mat.emissiveIntensity;
      });
      return v;
    };
    const maxJump = (flicker: number): number => {
      let prev = -1;
      let jump = 0;
      let hi = 0;
      for (let i = 0; i <= 120; i++) {
        m.animate({ time: i / 60, heat: 0, flash: 0, flicker });
        const v = readout();
        hi = Math.max(hi, v);
        if (prev >= 0) jump = Math.max(jump, Math.abs(v - prev));
        prev = v;
      }
      return jump / hi;
    };
    expect(maxJump(1)).toBeGreaterThan(0.5);
    expect(maxJump(0)).toBeLessThan(0.15);
    m.setAmmo(30, 30);
  });

  it('the loading shell is hidden at rest', () => {
    expect(model('shotgun').parts.shell!.visible).toBe(false);
    expect(model('pistol').parts.magazine!.visible).toBe(true);
  });

  it('readouts only re-upload when the ammo changes', () => {
    const m = model('rifle');
    m.setAmmo(30, 32);
    let tex: { version: number } | null = null;
    for (const mesh of meshes(m.root)) {
      const mat = mesh.material as MeshStandardMaterial;
      if (mat.emissiveMap) tex = mat.emissiveMap;
    }
    expect(tex).not.toBeNull();
    const v = tex!.version;
    m.setAmmo(30, 32);
    expect(tex!.version).toBe(v);
    m.setAmmo(29, 32);
    expect(tex!.version).toBeGreaterThan(v);
  });

  it('unknown or failing builders yield null instead of throwing; registry is extensible', () => {
    expect(createWeaponViewmodel('does-not-exist', kit)).toBeNull();
    registerViewmodelBuilder('broken-test', () => {
      throw new Error('boom');
    });
    expect(createWeaponViewmodel('broken-test', kit)).toBeNull();
    expect(hasViewmodel('broken-test')).toBe(true);
  });

  it('dispose releases the model geometry and detaches it', () => {
    const k = new WeaponMaterialKit();
    const m = createWeaponViewmodel('pistol', k)!;
    const parent = new Group();
    parent.add(m.root);
    let disposed = 0;
    for (const mesh of meshes(m.root)) mesh.geometry.addEventListener('dispose', () => disposed++);
    m.dispose();
    m.dispose();
    expect(m.root.parent).toBeNull();
    expect(disposed).toBe(meshes(m.root).length);
    k.dispose();
  });
});
