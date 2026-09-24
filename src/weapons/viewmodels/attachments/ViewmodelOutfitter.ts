/**
 * The viewmodel side of the Rift Forge and the Werkbank (owned by ViewmodelRig): keeps the shown
 * weapon model dressed in its carried weapon's mod state (WeaponSystem.modsOf – tier, attachments):
 * the attachments (WeaponOutfit per cached model), the forge look (ForgeLookApplier) and the laser
 * sight (LaserSight, world space). The rig asks every frame (identity compare of the mod state,
 * no allocation); a change re-dresses the model – deferred while the weapon is being lowered into
 * the forge, so the new look appears out of view. Reports the optic's sight point / eye relief and
 * a muzzle device's muzzle point for the rig's ADS alignment and socket anchors.
 */
import { Color, LinearSRGBColorSpace, Vector3, type Camera, type MeshStandardMaterial, type Object3D } from 'three';
import type { Vec3Like } from '../../../core/events';
import { forgePaletteId, getForgeLook, type ForgeLookDef } from '../../../defs/forge';
import { getWeaponDef } from '../../../defs/weapons';
import { ATTACHMENT_ART, FORGE_VIEW, LASER_SIGHT } from '../../../defs/weaponOutfit';
import type { WeaponModState } from '../../resolveWeapon';
import type { WeaponMaterialKit } from '../materials';
import type { WeaponViewmodelModel } from '../WeaponModel';
import { ForgeLookApplier } from './forgeLook';
import { LaserSight } from './LaserSight';
import { AttachmentLibrary } from './library';
import { WeaponOutfit } from './WeaponOutfit';

export type ModsSource = (weaponId: string) => WeaponModState | null;
/** Distance along a world ray to the first thing a shot would hit (null = nothing in range). */
export type LaserRaycast = (origin: Vec3Like, direction: Vec3Like, maxDistance: number) => number | null;

const NO_ATTACHMENTS: readonly string[] = [];
const _from = new Vector3();
const _origin = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();

export class ViewmodelOutfitter {
  private library: AttachmentLibrary | null = null;
  private readonly looks = new ForgeLookApplier();
  private readonly outfits = new Map<WeaponViewmodelModel, WeaponOutfit>();
  private readonly laserSight: LaserSight;
  private modsSource: ModsSource | null = null;
  private raycast: LaserRaycast | null = null;
  private shownModel: WeaponViewmodelModel | null = null;
  private shownMods: WeaponModState | null | undefined = undefined;
  private outfit: WeaponOutfit | null = null;
  private look: ForgeLookDef | null = null;
  private accent: MeshStandardMaterial | null = null;
  private readonly accentColor = new Color();
  private readonly muzzleColor = new Color();
  private disposed = false;

  constructor(
    private readonly kit: () => WeaponMaterialKit,
    worldScene: Object3D,
  ) {
    this.laserSight = new LaserSight(worldScene);
  }

  setModsSource(source: ModsSource | null): void {
    this.modsSource = source;
    this.shownMods = undefined;
  }

  setLaserRaycast(raycast: LaserRaycast | null): void {
    this.raycast = raycast;
  }

  /** The laser draws on the volumetric layer this frame. */
  get hasVolumetricContent(): boolean {
    return this.laserSight.hasVolumetricContent;
  }

  /** Forge look of the shown weapon (null = its own look). */
  get currentLook(): ForgeLookDef | null {
    return this.look;
  }

  /** Optic sight point of the shown model (null = its own sight socket) and eye relief override. */
  get sight(): Object3D | null {
    return this.outfit?.sight ?? null;
  }

  get eyeDistance(): number | null {
    return this.outfit?.eyeDistance ?? null;
  }

  /** Muzzle point of a fitted muzzle device (null = the model's own muzzle socket). */
  get muzzle(): Object3D | null {
    return this.outfit?.muzzle ?? null;
  }

  /** Accent light color of the look (linear), or null. */
  get lookAccentColor(): Color | null {
    return this.look ? this.accentColor : null;
  }

  /** Muzzle light tint of the look (linear), or null. */
  get lookMuzzleColor(): Color | null {
    return this.look ? this.muzzleColor : null;
  }

  /**
   * Dress `model` (shown for `weaponId`) in its weapon's current mods. `defer`: keep the current
   * dress for now (the weapon is being lowered into the forge). True when the dress changed (the
   * rig re-resolves its pose, anchors and lights).
   */
  sync(weaponId: string | null, model: WeaponViewmodelModel | null, defer = false): boolean {
    if (this.disposed) return false;
    if (!weaponId || !model) {
      const changed = this.shownModel !== null;
      this.shownModel = null;
      this.shownMods = undefined;
      this.outfit = null;
      this.look = null;
      this.accent = null;
      return changed;
    }
    const mods = this.modsSource ? this.modsSource(weaponId) : null;
    if (model === this.shownModel && mods === this.shownMods) return false;
    if (defer && model === this.shownModel) return false;
    this.shownModel = model;
    this.shownMods = mods;
    const outfit = this.outfitFor(model);
    this.outfit = outfit;
    outfit.apply(mods?.attachments ?? NO_ATTACHMENTS);
    const base = getWeaponDef(weaponId);
    const tier = mods?.tier ?? 0;
    this.look = (base ? getForgeLook(forgePaletteId(base, tier)) : undefined) ?? null;
    this.accent = this.looks.apply(model.root, this.look);
    if (this.look) {
      this.accentColor.set(this.look.accent);
      this.muzzleColor.setHex(this.look.muzzleLight, LinearSRGBColorSpace);
    }
    return true;
  }

  /** Per frame after the animator animated the model: look intensity, gyros, camo clock. */
  afterAnimate(dt: number): void {
    this.looks.time.value += dt;
    if (this.accent && this.look) this.accent.emissiveIntensity *= this.look.accentIntensity;
    const spin = this.outfit?.spinners;
    if (spin) for (const s of spin) s.obj.rotation[s.axis] += ATTACHMENT_ART.gyroSpin * dt;
  }

  /** The look's accent-light factor (1 without a look). */
  get accentLightScale(): number {
    return this.look ? FORGE_VIEW.accentLightScale : 1;
  }

  /**
   * Per frame after the rig posed the model: the laser dot at the crosshair's hit and the beam
   * from the emitter as seen (`toWorld` maps a viewmodel object into the world camera).
   */
  updateLaser(visible: boolean, camera: Camera, toWorld: (obj: Object3D, out: Vector3) => Vector3): void {
    const laser = visible ? (this.outfit?.laser ?? null) : null;
    if (!laser) {
      this.laserSight.update(null, false, _from, null, camera);
      return;
    }
    toWorld(laser.emitter, _from);
    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_dir);
    const dist = this.raycast ? this.raycast(_origin, _dir, LASER_SIGHT.range) : null;
    const hit = dist !== null ? _hit.copy(_origin).addScaledVector(_dir, dist) : null;
    this.laserSight.update(laser.def.color, laser.def.beam, _from, hit, camera);
  }

  /**
   * Objects to add to the viewmodel scene for a shader warm-up compile: every attachment model
   * and a camo variant of every body material of `models` (and of the attachments). Call
   * `releaseWarmup` with the result afterwards.
   */
  warmup(models: readonly WeaponViewmodelModel[]): Object3D[] {
    const lib = this.lib();
    const group = lib.warmupGroup();
    const meshes = this.looks.warmupMeshes([group, ...models.map((m) => m.root)]);
    return [group, ...meshes];
  }

  releaseWarmup(objects: readonly Object3D[]): void {
    const lib = this.library;
    for (const o of objects) {
      if (o.name === 'attachment-warmup' && lib) lib.releaseWarmup(o as never);
      else o.removeFromParent();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.outfits.values()) o.dispose();
    this.outfits.clear();
    this.library?.dispose();
    this.library = null;
    this.looks.dispose();
    this.laserSight.dispose();
  }

  private lib(): AttachmentLibrary {
    this.library ??= new AttachmentLibrary(this.kit());
    return this.library;
  }

  private outfitFor(model: WeaponViewmodelModel): WeaponOutfit {
    let o = this.outfits.get(model);
    if (!o) {
      o = new WeaponOutfit(model, this.lib());
      this.outfits.set(model, o);
    }
    return o;
  }
}
