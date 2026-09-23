/**
 * Shared material kit for the procedural weapon viewmodels. One kit serves every weapon model
 * (same programs, same tiny textures); per-weapon emissive materials are created by
 * `createGlowMaterials` because their intensities animate per model.
 *
 * All lit kit materials use vertex colors (edge wear, see ModelBuilder) and a tiling wear map
 * as roughness map; grips and pump ribs get a knurl normal map. Everything is small and cheap:
 * two textures (128² + 64²) for all weapons.
 */
import {
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector2,
  type DataTexture,
  type Material,
} from 'three';
import { VIEWMODEL_ART } from '../../defs/viewmodels';
import { createDataTexture, generateKnurlPixels, generateWearPixels } from './textures';

export type KitMaterial =
  'gunmetal' | 'darkMetal' | 'polymer' | 'accentPaint' | 'grip' | 'brass' | 'shellHull' | 'bore' | 'lens';

export type GlowMaterial = 'accent' | 'heat' | 'sight' | 'readout';

export class WeaponMaterialKit {
  readonly wearTexture: DataTexture;
  readonly knurlTexture: DataTexture;
  readonly materials: Readonly<Record<KitMaterial, Material>>;
  private disposed = false;

  constructor() {
    const T = VIEWMODEL_ART.textures;
    const M = VIEWMODEL_ART.materials;
    this.wearTexture = createDataTexture(generateWearPixels(T.wearSize), T.wearSize, T.anisotropy);
    this.knurlTexture = createDataTexture(
      generateKnurlPixels(T.knurlSize, T.knurlCells, T.knurlStrength),
      T.knurlSize,
      T.anisotropy,
    );
    const wear = this.wearTexture;
    this.materials = {
      gunmetal: new MeshStandardMaterial({
        name: 'vm-gunmetal',
        color: M.gunmetal.color,
        metalness: M.gunmetal.metalness,
        roughness: M.gunmetal.roughness,
        roughnessMap: wear,
        vertexColors: true,
      }),
      darkMetal: new MeshStandardMaterial({
        name: 'vm-darkmetal',
        color: M.darkMetal.color,
        metalness: M.darkMetal.metalness,
        roughness: M.darkMetal.roughness,
        roughnessMap: wear,
        vertexColors: true,
      }),
      polymer: new MeshPhysicalMaterial({
        name: 'vm-polymer',
        color: M.polymer.color,
        metalness: 0,
        roughness: M.polymer.roughness,
        roughnessMap: wear,
        clearcoat: M.polymer.clearcoat,
        clearcoatRoughness: M.polymer.clearcoatRoughness,
        vertexColors: true,
      }),
      accentPaint: new MeshStandardMaterial({
        name: 'vm-accentpaint',
        color: M.accentPaint.color,
        metalness: M.accentPaint.metalness,
        roughness: M.accentPaint.roughness,
        roughnessMap: wear,
        vertexColors: true,
      }),
      grip: new MeshStandardMaterial({
        name: 'vm-grip',
        color: M.grip.color,
        metalness: 0,
        roughness: M.grip.roughness,
        normalMap: this.knurlTexture,
        normalScale: new Vector2(M.grip.normalScale, M.grip.normalScale),
        vertexColors: true,
      }),
      brass: new MeshStandardMaterial({
        name: 'vm-brass',
        color: M.brass.color,
        metalness: M.brass.metalness,
        roughness: M.brass.roughness,
        roughnessMap: wear,
        vertexColors: true,
      }),
      shellHull: new MeshPhysicalMaterial({
        name: 'vm-shellhull',
        color: M.shellHull.color,
        metalness: 0,
        roughness: M.shellHull.roughness,
        clearcoat: M.shellHull.clearcoat,
        clearcoatRoughness: M.shellHull.clearcoatRoughness,
        vertexColors: true,
      }),
      bore: new MeshStandardMaterial({
        name: 'vm-bore',
        color: M.bore.color,
        metalness: 0,
        roughness: M.bore.roughness,
      }),
      lens: new MeshStandardMaterial({
        name: 'vm-lens',
        color: M.lens.color,
        metalness: 0,
        roughness: M.lens.roughness,
        transparent: true,
        opacity: M.lens.opacity,
        depthWrite: false,
      }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of Object.values(this.materials)) m.dispose();
    this.wearTexture.dispose();
    this.knurlTexture.dispose();
  }
}

export interface GlowMaterials {
  readonly accent: MeshStandardMaterial;
  readonly heat: MeshStandardMaterial;
  readonly sight: MeshStandardMaterial;
  readonly readout: MeshStandardMaterial;
}

/** Near-black base so the emissive term dominates; the emissive color × intensity > 1 blooms. */
const GLOW_BASE = 0x050607;

export function createGlowMaterials(
  sightColor: number,
  readoutMap: DataTexture | null,
  glow: { accent: number; readout: number; sight: number },
): GlowMaterials {
  const E = VIEWMODEL_ART.emissive;
  const mk = (name: string, emissive: number, intensity: number): MeshStandardMaterial =>
    new MeshStandardMaterial({
      name,
      color: GLOW_BASE,
      emissive: new Color(emissive),
      emissiveIntensity: intensity,
      metalness: 0,
      roughness: 0.35,
    });
  const readout = mk('vm-readout', 0xffffff, glow.readout);
  if (readoutMap) readout.emissiveMap = readoutMap;
  return {
    accent: mk('vm-accent', E.accent, glow.accent),
    // Heat vents start dark; the model drives the intensity from the heat accumulator.
    heat: mk('vm-heat', E.heat, 0),
    sight: mk('vm-sight', sightColor, glow.sight),
    readout,
  };
}
