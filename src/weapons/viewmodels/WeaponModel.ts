/**
 * A built procedural weapon model: implements the WeaponViewmodel contract (root, sockets, named
 * parts) plus the emissive "life" the animator drives – accent strips breathing and flashing on
 * each shot, heat vents glowing with sustained fire, and ammo readouts (LED rows or a two-digit
 * seven-segment counter) that re-upload their few texels only when the ammo count changes.
 */
import { Color, SRGBColorSpace, type DataTexture, type Group, type Material, type Object3D } from 'three';
import type { WeaponViewmodel } from '../../core/contracts';
import { VIEWMODEL_ANIM, VIEWMODEL_ART, type WeaponViewmodelDef } from '../../defs/viewmodels';
import type { BuiltModel, MountName, SocketName } from './ModelBuilder';
import type { GlowMaterials } from './materials';
import {
  createReadoutTexture,
  ledsLit,
  segmentDisplaySize,
  writeLedPixels,
  writeSegmentPixels,
  type Rgb,
} from './textures';

/** Per-frame inputs for the emissive animation. */
export interface ViewmodelFxState {
  /** Seconds (monotonic). */
  time: number;
  /** 0..1 barrel heat. */
  heat: number;
  /** 0..1 flash right after a shot (decays; already scaled down for reduce-flashing). */
  flash: number;
  /** 0..1 depth scale of the heat shimmer (0 with reduce-flashing); default 1. */
  flicker?: number;
  /** Extra accent emissive intensity from state drivers (charge, beam, spin – M5); default 0. */
  accentBoost?: number;
}

export type ReadoutSpec = { kind: 'leds'; count: number } | { kind: 'segments' } | { kind: 'none' };

export interface WeaponViewmodelModel extends WeaponViewmodel {
  readonly def: WeaponViewmodelDef;
  readonly sockets: Readonly<Record<SocketName, Object3D>>;
  /** Attachment mounts (M5); a missing mount shows no attachment model for that slot. */
  readonly mounts: Readonly<Partial<Record<MountName, Object3D>>>;
  /** Refresh the ammo readout (no-op when nothing changed). */
  setAmmo(mag: number, magSize: number): void;
  /** Uniform-only emissive animation, once per frame while shown. */
  animate(fx: Readonly<ViewmodelFxState>): void;
}

/** Readout color for an ammo state (empty → red, low → amber, else cyan). */
export function readoutColor(mag: number, magSize: number): Rgb {
  const E = VIEWMODEL_ART.emissive;
  if (mag <= 0) return E.readoutEmpty;
  if (magSize > 0 && mag / magSize < VIEWMODEL_ANIM.lowAmmoFraction) return E.readoutLow;
  return E.readoutOn;
}

const _c = new Color();

/** Linear relative luminance of an sRGB byte color. */
export function rgbLuminance(rgb: Rgb): number {
  _c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
  return 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
}

/**
 * Readout intensity gain for a state color: red/amber are far darker than the cyan the per-weapon
 * glow.readout is tuned for, so they are boosted to the same luminance (they must bloom too).
 */
export function readoutGain(rgb: Rgb): number {
  const l = rgbLuminance(rgb);
  return l > 0 ? Math.max(1, rgbLuminance(VIEWMODEL_ART.emissive.readoutOn) / l) : 1;
}

/** Create the readout texture for a spec (null for 'none'). */
export function createReadout(spec: ReadoutSpec): { texture: DataTexture; data: Uint8Array } | null {
  if (spec.kind === 'none') return null;
  if (spec.kind === 'leds') {
    const data = new Uint8Array(Math.max(1, spec.count) * 4);
    writeLedPixels(data, spec.count, 0, VIEWMODEL_ART.emissive.readoutOff, VIEWMODEL_ART.emissive.readoutOff);
    return { texture: createReadoutTexture(data, Math.max(1, spec.count), 1), data };
  }
  const { w, h } = segmentDisplaySize();
  const data = new Uint8Array(w * h * 4);
  const E = VIEWMODEL_ART.emissive;
  writeSegmentPixels(data, 0, E.readoutOff, E.readoutOff, E.readoutBg);
  return { texture: createReadoutTexture(data, w, h), data };
}

/** UV of LED `i` in an LED-strip readout texture (texel center). */
export function ledUv(i: number, count: number): readonly [number, number] {
  return [(i + 0.5) / Math.max(1, count), 0.5];
}

export class ProceduralWeaponModel implements WeaponViewmodelModel {
  readonly root: Group;
  readonly muzzle: Object3D;
  readonly ejectPort: Object3D;
  readonly sight: Object3D;
  readonly parts: Readonly<Record<string, Object3D>>;
  readonly sockets: Readonly<Record<SocketName, Object3D>>;
  readonly mounts: Readonly<Partial<Record<MountName, Object3D>>>;
  private lastMag = -1;
  private lastMagSize = -1;
  private readoutBoost = 1;
  private disposed = false;

  constructor(
    readonly weaponId: string,
    readonly def: WeaponViewmodelDef,
    private readonly built: BuiltModel,
    private readonly glow: GlowMaterials,
    private readonly readoutSpec: ReadoutSpec,
    private readonly readout: { texture: DataTexture; data: Uint8Array } | null,
    /** Extra per-model materials (not in the shared kit) disposed with the model. */
    private readonly ownedMaterials: readonly Material[] = [],
  ) {
    this.root = built.root;
    this.root.scale.setScalar(def.scale ?? 1);
    this.root.userData.weaponId = weaponId;
    this.sockets = built.sockets;
    this.mounts = built.mounts;
    this.muzzle = built.sockets.muzzle;
    this.ejectPort = built.sockets.ejectPort;
    this.sight = built.sockets.sight;
    this.parts = built.parts;
  }

  get ammoMag(): number {
    return this.lastMag;
  }

  setAmmo(mag: number, magSize: number): void {
    if (mag === this.lastMag && magSize === this.lastMagSize) return;
    this.lastMag = mag;
    this.lastMagSize = magSize;
    const r = this.readout;
    if (!r) return;
    const E = VIEWMODEL_ART.emissive;
    const color = readoutColor(mag, magSize);
    this.readoutBoost = readoutGain(color);
    if (this.readoutSpec.kind === 'leds') {
      const count = this.readoutSpec.count;
      // Empty: every LED glows red (and blinks, see animate) instead of going dark.
      const lit = mag <= 0 ? count : ledsLit(mag, magSize, count);
      if (writeLedPixels(r.data, count, lit, color, E.readoutOff)) {
        r.texture.needsUpdate = true;
      }
    } else if (this.readoutSpec.kind === 'segments') {
      writeSegmentPixels(r.data, mag, color, E.readoutOff, E.readoutBg);
      r.texture.needsUpdate = true;
    }
  }

  animate(fx: Readonly<ViewmodelFxState>): void {
    const A = VIEWMODEL_ANIM;
    const g = this.def.glow;
    const pulse = 1 + A.accentPulse.depth * Math.sin(fx.time * A.accentPulse.rate);
    this.glow.accent.emissiveIntensity =
      g.accent * pulse + fx.flash * A.accentPulse.fireFlash + (fx.accentBoost ?? 0);
    const flicker = 1 + A.heatFlicker.depth * (fx.flicker ?? 1) * Math.sin(fx.time * A.heatFlicker.rate);
    // Squared: vents stay dark for a few shots, then ramp up hard during sustained fire.
    this.glow.heat.emissiveIntensity = g.heat * fx.heat * fx.heat * flicker;
    const blink = this.lastMag === 0 && Math.sin(fx.time * A.emptyBlinkRate) < 0 ? A.emptyBlinkLow : 1;
    this.glow.readout.emissiveIntensity = g.readout * this.readoutBoost * blink;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const g of this.built.geometries) g.dispose();
    for (const m of Object.values(this.glow) as Material[]) m.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.readout?.texture.dispose();
  }
}
