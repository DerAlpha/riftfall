/**
 * The attachments fitted to one weapon model (one outfit per cached model, owned by the rig).
 *
 * apply(ids) fits exactly the listed attachments: rail / muzzle / optic models go on the model's
 * mounts (a muzzle device on a weapon without a muzzleDevice mount sits on its muzzle socket),
 * magazine add-ons on its magazine part (MAGAZINE_PARTS) so they ride every reload motion. An
 * optic hides the built-in `sight` part's meshes; a drum hides the magazine's own meshes; coupled
 * magazines show a copy of it. The outfit reports what the rig needs: the optic's sight point
 * (+ eye relief), the device's new muzzle point, a laser emitter, spinning gyro parts. Detached
 * instances are kept for a later refit; their accents use the host weapon's accent material (they
 * follow its forge look and its breathing / shot flashes).
 */
import { Box3, Group, Mesh, Object3D, Vector3, type Material } from 'three';
import { getAttachmentDef, type AttachmentLaserDef } from '../../../defs/attachments';
import type { AttachmentSlot } from '../../../defs/weapons';
import { ATTACHMENT_ART, MAGAZINE_PARTS, OUTFIT_MATERIALS } from '../../../defs/weaponOutfit';
import type { MountName } from '../ModelBuilder';
import type { WeaponViewmodelModel } from '../WeaponModel';
import type { AttachmentInstance, AttachmentLibrary } from './library';
import type { MagazineShape } from './types';

const SLOT_MOUNT: Readonly<Record<Exclude<AttachmentSlot, 'magazine'>, MountName>> = {
  optic: 'optic',
  muzzle: 'muzzleDevice',
  underbarrel: 'underbarrel',
  stock: 'stock',
  laser: 'laser',
};

const _box = new Box3();
const _size = new Vector3();

export interface OutfitLaser {
  readonly emitter: Object3D;
  readonly def: AttachmentLaserDef;
}

export interface OutfitSpinner {
  readonly obj: Object3D;
  readonly axis: 'x' | 'y' | 'z';
}

export class WeaponOutfit {
  /** Optic sight point (null = the model's own sight socket) and its eye relief (null = the weapon's). */
  sight: Object3D | null = null;
  eyeDistance: number | null = null;
  /** Muzzle point of a fitted device (null = the model's muzzle socket). */
  muzzle: Object3D | null = null;
  laser: OutfitLaser | null = null;
  /** A fitted muzzle device suppresses the report (smaller viewmodel flash light). */
  suppressed = false;
  readonly spinners: OutfitSpinner[] = [];
  private readonly fitted = new Map<string, AttachmentInstance>();
  private readonly spare = new Map<string, AttachmentInstance>();
  private readonly hiddenSight: Object3D[] = [];
  private readonly hiddenMagazine: Object3D[] = [];
  private duplicate: Group | null = null;
  private magazinePart: Object3D | null | undefined = undefined;
  private magazineShape: MagazineShape | null = null;
  private hostAccent: Material | null | undefined = undefined;
  private rear: Object3D | null = null;
  private applied = '';

  constructor(
    readonly model: WeaponViewmodelModel,
    private readonly library: AttachmentLibrary,
  ) {}

  /** Attachment ids fitted right now. */
  get ids(): readonly string[] {
    return [...this.fitted.keys()];
  }

  /**
   * Fit exactly `ids` (unknown ids and slots the model has nowhere to put are skipped). Returns
   * true when the fitted set changed.
   */
  apply(ids: readonly string[]): boolean {
    const key = ids.join('|');
    if (key === this.applied) return false;
    this.applied = key;
    for (const [id, inst] of this.fitted) {
      if (ids.includes(id)) continue;
      inst.root.removeFromParent();
      this.fitted.delete(id);
      this.spare.set(id, inst);
    }
    for (const id of ids) {
      if (this.fitted.has(id)) continue;
      const inst = this.attach(id);
      if (inst) this.fitted.set(id, inst);
    }
    this.refresh();
    return true;
  }

  /** Release every instance (the model is being disposed or the rig shuts down). */
  dispose(): void {
    this.apply([]);
    for (const inst of this.spare.values()) this.library.release(inst);
    this.spare.clear();
  }

  // -------------------------------------------------------------------------

  private attach(id: string): AttachmentInstance | null {
    const def = getAttachmentDef(id);
    if (!def) return null;
    let parent: Object3D | null;
    if (def.slot === 'magazine') {
      parent = this.findMagazinePart();
    } else {
      parent = this.model.mounts[SLOT_MOUNT[def.slot]] ?? null;
      // Energy weapons carry their muzzle devices on the muzzle socket itself; a stock slot
      // without a stock mount gets one at the rear of the model.
      if (!parent && def.slot === 'muzzle') parent = this.model.muzzle;
      if (!parent && def.slot === 'stock') parent = this.rearMount();
    }
    if (!parent) return null;
    let inst = this.spare.get(id) ?? null;
    if (inst) this.spare.delete(id);
    else {
      inst = this.library.isMagazineAddon(id)
        ? this.library.create(id, this.magazineShapeOf())
        : this.library.create(id);
      if (!inst) return null;
      this.adoptAccent(inst.root);
    }
    inst.root.position.set(0, 0, 0);
    inst.root.quaternion.identity();
    parent.add(inst.root);
    return inst;
  }

  /** Overrides, hidden built-in parts and the coupled magazine for the fitted set. */
  private refresh(): void {
    this.sight = null;
    this.eyeDistance = null;
    this.muzzle = null;
    this.laser = null;
    this.suppressed = false;
    this.spinners.length = 0;
    let replaceMagazine = false;
    let duplicate: readonly [number, number, number] | null = null;
    for (const inst of this.fitted.values()) {
      if (inst.def.slot === 'optic' && inst.sight) {
        this.sight = inst.sight;
        this.eyeDistance = inst.spec.eyeDistance ?? null;
      }
      if (inst.muzzle) this.muzzle = inst.muzzle;
      if (inst.def.suppressed) this.suppressed = true;
      if (inst.emitter && inst.def.laser) this.laser = { emitter: inst.emitter, def: inst.def.laser };
      if (inst.spinner && inst.spec.spinner)
        this.spinners.push({ obj: inst.spinner, axis: inst.spec.spinner.axis });
      if (inst.spec.replacesMagazine) replaceMagazine = true;
      if (inst.spec.duplicateMagazine) duplicate = inst.spec.duplicateMagazine;
    }
    this.setSightHidden(this.sight !== null);
    this.setMagazineHidden(replaceMagazine);
    this.setDuplicate(duplicate);
  }

  /** Hide / show the meshes of the built-in `sight` part (not mounts or attachments on it). */
  private setSightHidden(hidden: boolean): void {
    for (const o of this.hiddenSight) o.visible = true;
    this.hiddenSight.length = 0;
    const part = this.model.parts.sight;
    if (!hidden || !part) return;
    collectOwnMeshes(part, this.hiddenSight, true);
    for (const o of this.hiddenSight) o.visible = false;
  }

  private setMagazineHidden(hidden: boolean): void {
    for (const o of this.hiddenMagazine) o.visible = true;
    this.hiddenMagazine.length = 0;
    const part = this.findMagazinePart();
    if (!hidden || !part) return;
    collectOwnMeshes(part, this.hiddenMagazine, false);
    for (const o of this.hiddenMagazine) o.visible = false;
  }

  /** A copy of the magazine's own meshes (shared geometry / materials) at `offset`. */
  private setDuplicate(offset: readonly [number, number, number] | null): void {
    const part = this.findMagazinePart();
    if (!offset || !part) {
      this.duplicate?.removeFromParent();
      return;
    }
    if (!this.duplicate) {
      const g = new Group();
      g.name = 'att-magazine-copy';
      for (const child of part.children) {
        const m = child as Mesh;
        if (!m.isMesh) continue;
        const copy = new Mesh(m.geometry, m.material);
        copy.name = m.name;
        copy.position.copy(m.position);
        copy.quaternion.copy(m.quaternion);
        copy.scale.copy(m.scale);
        g.add(copy);
      }
      this.duplicate = g;
    }
    this.duplicate.position.set(offset[0], offset[1], offset[2]);
    part.add(this.duplicate);
  }

  /** Fallback stock mount: centered at the rear end of the model, at the grip's top. */
  private rearMount(): Object3D {
    if (this.rear) return this.rear;
    const box = new Box3();
    this.model.root.updateMatrixWorld(true);
    const inv = this.model.root.matrixWorld.clone().invert();
    this.model.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || m.name.startsWith('att-')) return;
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (geo.boundingBox)
        box.union(_box.copy(geo.boundingBox).applyMatrix4(m.matrixWorld).applyMatrix4(inv));
    });
    const rear = new Object3D();
    rear.name = 'mount-stock-fallback';
    rear.position.set(
      0,
      ATTACHMENT_ART.rearMount.y,
      box.isEmpty() ? 0 : box.max.z - ATTACHMENT_ART.rearMount.inset,
    );
    this.model.root.add(rear);
    this.rear = rear;
    return rear;
  }

  private findMagazinePart(): Object3D | null {
    if (this.magazinePart !== undefined) return this.magazinePart;
    this.magazinePart = null;
    for (const name of MAGAZINE_PARTS) {
      const p = this.model.parts[name];
      if (p) {
        this.magazinePart = p;
        break;
      }
    }
    return this.magazinePart;
  }

  /** Bounds of the magazine's own meshes, its long axis and the far end (away from the well). */
  private magazineShapeOf(): MagazineShape | null {
    if (this.magazineShape) return this.magazineShape;
    const part = this.findMagazinePart();
    if (!part) return null;
    const box = new Box3();
    for (const child of part.children) {
      const m = child as Mesh;
      if (!m.isMesh) continue;
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) continue;
      m.updateMatrix();
      box.union(_box.copy(geo.boundingBox).applyMatrix4(m.matrix));
    }
    if (box.isEmpty()) return null;
    box.getSize(_size);
    const axis = _size.x >= _size.y && _size.x >= _size.z ? 'x' : _size.y >= _size.z ? 'y' : 'z';
    const dir = Math.abs(box.max[axis]) >= Math.abs(box.min[axis]) ? 1 : -1;
    this.magazineShape = { box, axis, dir };
    return this.magazineShape;
  }

  /** Attachment accents take the host weapon's accent material (its look and animation). */
  private adoptAccent(root: Object3D): void {
    if (this.hostAccent === undefined) {
      this.hostAccent = null;
      this.model.root.traverse((o) => {
        const m = o as Mesh;
        if (this.hostAccent || !m.isMesh || Array.isArray(m.material)) return;
        if ((m.material as Material).name === OUTFIT_MATERIALS.accent)
          this.hostAccent = m.material as Material;
      });
    }
    const host = this.hostAccent;
    if (!host) return;
    const own = this.library.accentMaterial;
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.material === own) m.material = host;
    });
  }
}

/**
 * Meshes of a part itself: its mesh children (and, with `deep`, those of nested parts), never
 * mounts, attachment instances or the coupled-magazine copy.
 */
function collectOwnMeshes(part: Object3D, out: Object3D[], deep: boolean): void {
  for (const child of part.children) {
    const name = child.name;
    if (name.startsWith('mount-') || name.startsWith('att-') || name.startsWith('socket-')) continue;
    if ((child as Mesh).isMesh) out.push(child);
    else if (deep && name.startsWith('part-')) collectOwnMeshes(child, out, deep);
  }
}
