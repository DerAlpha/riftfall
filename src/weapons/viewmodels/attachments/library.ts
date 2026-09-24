/**
 * The attachment part library (M5 package E2): one procedural model per attachment model id in
 * defs/attachments ('att.<id>'). Rail / muzzle attachments are built once into a prototype and
 * cloned per weapon (shared geometry and materials); magazine add-ons are sized from each
 * weapon's magazine, so they are built per weapon. Materials: the weapon kit's plus the library's
 * reticle / laser / band glows (by color), coated and thermal lenses, the scope depth mask and an
 * accent the outfit swaps for the host weapon's accent. Unknown model ids yield null (the slot
 * shows nothing) – never a crash.
 */
import {
  Box3,
  Color,
  Group,
  LinearSRGBColorSpace,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
} from 'three';
import { createLogger } from '../../../core/log';
import { ATTACHMENT_IDS, getAttachmentDef, type AttachmentDef } from '../../../defs/attachments';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { ATTACHMENT_ART } from '../../../defs/weaponOutfit';
import { ModelBuilder, type Vec3Tuple } from '../ModelBuilder';
import type { WeaponMaterialKit } from '../materials';
import {
  buildApRound,
  buildCapacitor,
  buildDrum,
  buildExtMag,
  buildFastMag,
  buildHeavyLoad,
  buildOverpressure,
} from './magazines';
import {
  buildChoke,
  buildCompensator,
  buildFocusLens,
  buildLongBarrel,
  buildMuzzleBrake,
  buildShortBarrel,
  buildSuppressor,
} from './muzzles';
import { buildAcog, buildHolo, buildRedDot, buildReflex, buildScope4x, buildThermal } from './optics';
import {
  buildAngleGrip,
  buildHeavyStock,
  buildLightStock,
  buildStabilizer,
  buildTacticalLaser,
  buildTargetLaser,
  buildVertGrip,
} from './rails';
import type { AttachmentBuilder, AttachmentSpec, MagazineBuilder, MagazineShape } from './types';

const log = createLogger('viewmodel');

/** Rail, muzzle and optic models (mount space). */
export const ATTACHMENT_BUILDERS: Readonly<Record<string, AttachmentBuilder>> = {
  'att.reflex': buildReflex,
  'att.reddot': buildRedDot,
  'att.holo': buildHolo,
  'att.acog': buildAcog,
  'att.scope4x': buildScope4x,
  'att.thermal': buildThermal,
  'att.suppressor': buildSuppressor,
  'att.compensator': buildCompensator,
  'att.muzzlebrake': buildMuzzleBrake,
  'att.longbarrel': buildLongBarrel,
  'att.shortbarrel': buildShortBarrel,
  'att.choke': buildChoke,
  'att.focuslens': buildFocusLens,
  'att.vertgrip': buildVertGrip,
  'att.anglegrip': buildAngleGrip,
  'att.stabilizer': buildStabilizer,
  'att.lightstock': buildLightStock,
  'att.heavystock': buildHeavyStock,
  'att.tacticallaser': buildTacticalLaser,
  'att.targetlaser': buildTargetLaser,
};

/** Magazine add-ons (magazine part space, sized per weapon). */
export const MAGAZINE_BUILDERS: Readonly<Record<string, MagazineBuilder>> = {
  'att.extmag': buildExtMag,
  'att.fastmag': buildFastMag,
  'att.drum': buildDrum,
  'att.overpressure': buildOverpressure,
  'att.apround': buildApRound,
  'att.capacitor': buildCapacitor,
  'att.heavyload': buildHeavyLoad,
};

/** Marker object names inside an attachment instance. */
export const MARKER = { sight: 'att-sight', muzzle: 'att-muzzle', emitter: 'att-emitter' } as const;

export interface AttachmentInstance {
  readonly id: string;
  readonly def: AttachmentDef;
  readonly root: Object3D;
  readonly spec: AttachmentSpec;
  readonly sight: Object3D | null;
  readonly muzzle: Object3D | null;
  readonly emitter: Object3D | null;
  readonly spinner: Object3D | null;
  /** Geometries owned by this instance (magazine add-ons); prototypes' clones own none. */
  readonly geometries: readonly BufferGeometry[];
}

interface Prototype {
  readonly root: Group;
  readonly spec: AttachmentSpec;
  readonly geometries: readonly BufferGeometry[];
}

/** Stand-in magazine for the warm-up (a pistol-sized stick magazine). */
const WARMUP_MAGAZINE: MagazineShape = {
  box: new Box3(new Vector3(-0.012, -0.12, -0.02), new Vector3(0.012, 0, 0.02)),
  axis: 'y',
  dir: -1,
};

function marker(root: Object3D, name: string, p: Vec3Tuple | undefined): void {
  if (!p) return;
  const o = new Object3D();
  o.name = name;
  o.position.set(p[0], p[1], p[2]);
  root.add(o);
}

export class AttachmentLibrary {
  private readonly glows = new Map<string, MeshStandardMaterial>();
  private readonly lens: MeshStandardMaterial;
  private readonly thermalLens: MeshStandardMaterial;
  private readonly mask: MeshBasicMaterial;
  private readonly accent: MeshStandardMaterial;
  private readonly prototypes = new Map<string, Prototype | null>();
  private disposed = false;

  constructor(private readonly kit: WeaponMaterialKit) {
    const L = ATTACHMENT_ART.lens;
    const lens = (name: string, color: number, opacity: number): MeshStandardMaterial =>
      new MeshStandardMaterial({
        name,
        color,
        metalness: 0,
        roughness: VIEWMODEL_ART.materials.lens.roughness,
        transparent: true,
        opacity,
        depthWrite: false,
      });
    this.lens = lens('vm-att-lens', L.color, L.opacity);
    this.thermalLens = lens('vm-att-lens-thermal', L.thermal, L.thermalOpacity);
    this.mask = new MeshBasicMaterial({ name: 'vm-scopemask', colorWrite: false });
    this.accent = this.glow(
      VIEWMODEL_ART.emissive.accent,
      ATTACHMENT_ART.accentIntensity,
      false,
      'vm-att-accent',
    );
  }

  /** The library's stand-in accent (the outfit swaps it for the host's). */
  get accentMaterial(): Material {
    return this.accent;
  }

  /** A part model exists for this attachment id. */
  has(attachmentId: string): boolean {
    const model = getAttachmentDef(attachmentId)?.model;
    return model !== undefined && (model in ATTACHMENT_BUILDERS || model in MAGAZINE_BUILDERS);
  }

  /** Magazine add-ons need the weapon's magazine shape. */
  isMagazineAddon(attachmentId: string): boolean {
    const model = getAttachmentDef(attachmentId)?.model;
    return model !== undefined && model in MAGAZINE_BUILDERS;
  }

  /**
   * A new instance of an attachment's model; magazine add-ons need `magazine`. Null for unknown
   * ids or failing builders (logged once).
   */
  create(attachmentId: string, magazine?: MagazineShape | null): AttachmentInstance | null {
    if (this.disposed) return null;
    const def = getAttachmentDef(attachmentId);
    if (!def) return null;
    const magBuild = MAGAZINE_BUILDERS[def.model];
    if (magBuild) {
      if (!magazine) return null;
      try {
        const b = new ModelBuilder(def.model, VIEWMODEL_ART.uvDensity);
        const spec = magBuild(b, magazine);
        const built = this.finish(b, def, spec);
        return this.instance(def, built.root, spec, built.geometries);
      } catch (err) {
        log.warn(`attachment "${def.model}" failed to build`, err);
        return null;
      }
    }
    const proto = this.prototype(def);
    if (!proto) return null;
    return this.instance(def, proto.root.clone(true), proto.spec, []);
  }

  /** Dispose an instance (its owned geometries; clones share the prototype's). */
  release(inst: AttachmentInstance): void {
    inst.root.removeFromParent();
    for (const g of inst.geometries) g.dispose();
  }

  /**
   * Every model once (+ each magazine add-on on a stand-in magazine) for a shader warm-up compile;
   * pass the group to `releaseWarmup` afterwards.
   */
  warmupGroup(): Group {
    const g = new Group();
    g.name = 'attachment-warmup';
    const instances: AttachmentInstance[] = [];
    for (const id of ATTACHMENT_IDS) {
      const inst = this.create(id, WARMUP_MAGAZINE);
      if (!inst) continue;
      g.add(inst.root);
      instances.push(inst);
    }
    g.userData.instances = instances;
    return g;
  }

  releaseWarmup(g: Group): void {
    for (const inst of (g.userData.instances as AttachmentInstance[] | undefined) ?? []) this.release(inst);
    g.removeFromParent();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.prototypes.values()) if (p) for (const geo of p.geometries) geo.dispose();
    this.prototypes.clear();
    for (const m of this.glows.values()) m.dispose();
    this.glows.clear();
    this.lens.dispose();
    this.thermalLens.dispose();
    this.mask.dispose();
  }

  // -------------------------------------------------------------------------

  private prototype(def: AttachmentDef): Prototype | null {
    if (this.prototypes.has(def.model)) return this.prototypes.get(def.model) ?? null;
    const build = ATTACHMENT_BUILDERS[def.model];
    let proto: Prototype | null = null;
    if (!build) {
      log.warn(`no attachment model "${def.model}" – the slot shows nothing`);
    } else {
      try {
        const b = new ModelBuilder(def.model, VIEWMODEL_ART.uvDensity);
        const spec = build(b);
        const built = this.finish(b, def, spec);
        proto = { root: built.root, spec, geometries: built.geometries };
      } catch (err) {
        log.warn(`attachment "${def.model}" failed to build`, err);
      }
    }
    this.prototypes.set(def.model, proto);
    return proto;
  }

  /** Sockets (unused, keeps the builder quiet), build, markers, mask draw order. */
  private finish(
    b: ModelBuilder,
    def: AttachmentDef,
    spec: AttachmentSpec,
  ): { root: Group; geometries: BufferGeometry[] } {
    b.socket('muzzle', [0, 0, 0]);
    b.socket('ejectPort', [0, 0, 0]);
    b.socket('sight', [0, 0, 0]);
    const built = b.build(this.materialsFor(def));
    const root = built.root;
    root.name = `att-${def.id}`;
    marker(root, MARKER.sight, spec.sight);
    marker(root, MARKER.muzzle, spec.muzzle);
    marker(root, MARKER.emitter, spec.emitter);
    for (const mesh of built.meshes) if (mesh.material === this.mask) mesh.renderOrder = -1;
    return { root, geometries: built.geometries };
  }

  private instance(
    def: AttachmentDef,
    root: Object3D,
    spec: AttachmentSpec,
    geometries: readonly BufferGeometry[],
  ): AttachmentInstance {
    root.userData.attachmentId = def.id;
    const spinner = spec.spinner ? (root.getObjectByName(`part-${spec.spinner.part}`) ?? null) : null;
    return {
      id: def.id,
      def,
      root,
      spec,
      sight: root.getObjectByName(MARKER.sight) ?? null,
      muzzle: root.getObjectByName(MARKER.muzzle) ?? null,
      emitter: root.getObjectByName(MARKER.emitter) ?? null,
      spinner,
      geometries,
    };
  }

  private materialsFor(def: AttachmentDef): Record<string, Material> {
    const E = VIEWMODEL_ART.emissive;
    const A = ATTACHMENT_ART;
    const color = def.optic?.color ?? E.accent;
    const laser = def.laser?.color;
    const band = A.bands.colors[def.id] ?? A.bands.fallback;
    return {
      ...this.kit.materials,
      accent: this.accent,
      reticle: this.glow(color, A.reticleIntensity, false),
      // Laser colors are linear hex (defs/attachments AttachmentLaserDef).
      laser:
        laser !== undefined
          ? this.glow(laser, A.laserLensIntensity, true)
          : this.glow(color, A.laserLensIntensity, false),
      band: this.glow(band, A.bands.intensity, false),
      lensTint: def.optic?.reticle === 'thermal' ? this.thermalLens : this.lens,
      mask: this.mask,
    };
  }

  /** Shared emissive material per (color, intensity). */
  private glow(hex: number, intensity: number, linear: boolean, name = 'vm-att-glow'): MeshStandardMaterial {
    const key = `${name}:${hex}:${intensity}:${linear ? 1 : 0}`;
    const hit = this.glows.get(key);
    if (hit) return hit;
    const emissive = linear ? new Color().setHex(hex, LinearSRGBColorSpace) : new Color(hex);
    const m = new MeshStandardMaterial({
      name,
      color: 0x050607,
      emissive,
      emissiveIntensity: intensity,
      metalness: 0,
      roughness: 0.35,
    });
    this.glows.set(key, m);
    return m;
  }
}

/** Every mesh under `root` (attachment instances, outfit bookkeeping). */
export function meshesOf(root: Object3D, out: Mesh[] = []): Mesh[] {
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}
