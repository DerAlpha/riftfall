/**
 * What the interactable views share: the scene group they live in, the level's material library
 * (props use the same PBR materials as the level), CSM setup for lit materials they create, the
 * shared time uniform, weapon hologram geometry and the reduce-flashing setting.
 */
import { Color, MeshStandardMaterial, type Material, type Object3D } from 'three';
import type { MaterialLibraryApi } from '../../core/contracts';
import type { Rgb } from '../../defs/interactables';
import type { TimeUniform } from './holo';
import type { WeaponHologramLibrary } from './weaponHolograms';

export interface VisualContext {
  /** Parent of every prop (in the world scene, NOT under level.root: never nav / level geometry). */
  readonly root: Object3D;
  readonly materials: MaterialLibraryApi;
  /** RenderApi.setupMaterial for lit materials created by the views (CSM sun shadows). */
  setupMaterial(m: Material): void;
  readonly time: TimeUniform;
  readonly holograms: WeaponHologramLibrary;
  reduceFlashing: boolean;
  /** Ceiling height above a floor point (beam length); null = unknown. */
  ceilingAbove?(x: number, y: number, z: number): number | null;
}

/** Near-black base so the emissive term dominates; emissive color × intensity > 1 blooms. */
const GLOW_BASE = 0x050607;

/** Lit emissive material (neon, status strips) with CSM set up. */
export function createGlowMaterial(
  ctx: VisualContext,
  color: Rgb,
  intensity: number,
  name: string,
): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    name,
    color: GLOW_BASE,
    roughness: 0.4,
    metalness: 0,
    emissive: new Color(color[0], color[1], color[2]),
    emissiveIntensity: intensity,
  });
  ctx.setupMaterial(m);
  return m;
}

/** Linear RGB triplet of an sRGB hex color (perk neon). */
export function srgbHexToLinear(hex: number): Rgb {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
}
