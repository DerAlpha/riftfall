/**
 * Shared types of the attachment part library (M5 package E2). Attachment models are built with
 * the weapons' ModelBuilder in MOUNT space (origin = the mount, +Y up / out of the rail, −Z
 * forward; magazine add-ons in the magazine part's space) from the weapon kit materials plus the
 * library's own: reticle / laser glows, tinted lenses, the scope depth mask and an accent that is
 * swapped for the host weapon's accent (so it follows the forge look and the accent animation).
 */
import type { Box3 } from 'three';
import type { ModelBuilder, Vec3Tuple } from '../ModelBuilder';

/** Material keys a builder may use beyond the kit's (KitMaterial). */
export type AttachmentMaterialKey = 'accent' | 'reticle' | 'lensTint' | 'mask' | 'laser' | 'band';

/** What a builder reports about the attachment (mount / part space). */
export interface AttachmentSpec {
  /** Optics: the reticle center on the sight line (the ADS alignment point). */
  readonly sight?: Vec3Tuple;
  /** Magnified optics: eye relief (m) at full ADS; default: the weapon's own adsEyeDistance. */
  readonly eyeDistance?: number;
  /** Muzzle devices / barrels: the new muzzle point (flash, tracers, muzzle light). */
  readonly muzzle?: Vec3Tuple;
  /** Lasers: where the beam leaves (along −Z). */
  readonly emitter?: Vec3Tuple;
  /** A part (ModelBuilder.part) that spins about its local axis while fitted (gyro). */
  readonly spinner?: { readonly part: string; readonly axis: 'x' | 'y' | 'z' };
  /** Magazine add-ons: hide the weapon's own magazine meshes (the add-on replaces it). */
  readonly replacesMagazine?: boolean;
  /** Magazine add-ons: show a copy of the weapon's magazine at this offset (coupled magazines). */
  readonly duplicateMagazine?: Vec3Tuple;
}

export type AttachmentBuilder = (b: ModelBuilder) => AttachmentSpec;

/** A weapon magazine as the magazine add-ons see it (the part's local space). */
export interface MagazineShape {
  /** Bounds of the magazine's own meshes. */
  readonly box: Box3;
  /** Long axis and the direction from the well towards the far end (±1). */
  readonly axis: 'x' | 'y' | 'z';
  readonly dir: 1 | -1;
}

export type MagazineBuilder = (b: ModelBuilder, mag: MagazineShape) => AttachmentSpec;
