/**
 * Material variants for any map (the lab's LabMaterials without its two lab-only shader effects):
 * `<baseId>#<variant>` ids resolve to tinted / re-tuned clones of the shared base materials from
 * the game's MaterialLibrary (defs/materials.ts); plain ids pass through. Clones share the base's
 * textures (no GPU memory, no generator work) and follow it when the base swaps its maps (texture
 * quality change) – call update() once per frame from the level. LevelKit buckets variants
 * separately while surfaces, shadows, bullet penetration and the `level:<baseId>` mesh name come
 * from the base def.
 *
 * A map keeps its variant table in its own directory:
 *   const MATS = { 'wall_panel#ice': { tint: [1.6, 1.9, 2.3], roughness: 0.6 }, … } as const;
 *   const materials = new KitMaterials(ctx.materials, MATS, (m) => ctx.render.setupMaterial(m));
 */
import * as THREE from 'three';
import type { MaterialLibraryApi } from '../../core/contracts';
import { createLogger } from '../../core/log';
import type { Vec3Tuple } from '../../defs/level';
import { baseMaterialId } from '../../world/LevelKit';

const log = createLogger('KitMaterials');

export interface KitMaterialVariantDef {
  /** Albedo multiplier per channel (linear). */
  readonly tint?: Vec3Tuple;
  /** Multipliers on the base roughness / metalness; absolute env map intensity. */
  readonly roughness?: number;
  readonly metalness?: number;
  readonly envMapIntensity?: number;
  /** Absolute emissive color (linear) and intensity (> POSTFX bloom threshold to glow). */
  readonly emissive?: Vec3Tuple;
  readonly emissiveIntensity?: number;
  /** Absolute opacity (< 1 = alpha blended, no depth write). */
  readonly opacity?: number;
  /** Meshes of this variant stay out of the navmesh (ceilings, roofs: islands otherwise). */
  readonly navIgnore?: boolean;
}

interface Variant {
  base: THREE.MeshStandardMaterial;
  material: THREE.MeshStandardMaterial;
}

function isAlias(def: KitMaterialVariantDef): boolean {
  return (
    def.tint === undefined &&
    def.roughness === undefined &&
    def.metalness === undefined &&
    def.envMapIntensity === undefined &&
    def.emissive === undefined &&
    def.emissiveIntensity === undefined &&
    def.opacity === undefined
  );
}

export class KitMaterials implements MaterialLibraryApi {
  private readonly variants = new Map<string, Variant>();
  private readonly synced: Variant[] = [];
  private readonly warned = new Set<string>();

  constructor(
    private readonly base: MaterialLibraryApi,
    private readonly defs: Readonly<Record<string, KitMaterialVariantDef>>,
    private readonly setupMaterial?: (m: THREE.Material) => void,
  ) {}

  /** Variant def of an id (undefined for plain / unknown ids). */
  variant(id: string): KitMaterialVariantDef | undefined {
    return Object.prototype.hasOwnProperty.call(this.defs, id) ? this.defs[id] : undefined;
  }

  /** Meshes built from this id stay out of the navmesh (flag them: userData.navIgnore). */
  isNavIgnored(id: string): boolean {
    return this.variant(id)?.navIgnore === true;
  }

  get(id: string): THREE.MeshStandardMaterial {
    if (id.indexOf('#') < 0) return this.base.get(id);
    const existing = this.variants.get(id);
    if (existing) return existing.material;
    const baseMat = this.base.get(baseMaterialId(id));
    const def = this.variant(id);
    if (!def) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        log.warn(`Unknown material variant "${id}" – using its base material`);
      }
      return baseMat;
    }
    if (isAlias(def)) return baseMat;
    const m = baseMat.clone();
    m.name = id;
    if (def.tint)
      m.color.multiply(
        new THREE.Color().setRGB(def.tint[0], def.tint[1], def.tint[2], THREE.LinearSRGBColorSpace),
      );
    if (def.roughness !== undefined) m.roughness = Math.min(1, baseMat.roughness * def.roughness);
    if (def.metalness !== undefined) m.metalness = Math.min(1, baseMat.metalness * def.metalness);
    if (def.envMapIntensity !== undefined) m.envMapIntensity = def.envMapIntensity;
    if (def.emissive)
      m.emissive.setRGB(def.emissive[0], def.emissive[1], def.emissive[2], THREE.LinearSRGBColorSpace);
    if (def.emissiveIntensity !== undefined) m.emissiveIntensity = def.emissiveIntensity;
    if (def.opacity !== undefined) {
      m.opacity = def.opacity;
      m.transparent = def.opacity < 1;
      m.depthWrite = def.opacity >= 1;
    }
    // clone() drops the CSM hooks of the base: register the copy for sun shadows.
    this.setupMaterial?.(m);
    const v: Variant = { base: baseMat, material: m };
    this.variants.set(id, v);
    this.synced.push(v);
    return m;
  }

  /** Preloads the base materials of all (variant) ids. */
  preload(ids: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.base.preload([...new Set(ids.map(baseMaterialId))], onProgress);
  }

  /** Per frame: follow texture maps the base swapped (quality changes). No allocation. */
  update(): void {
    for (let i = 0; i < this.synced.length; i++) {
      const { base: b, material: m } = this.synced[i]!;
      if (
        m.map === b.map &&
        m.normalMap === b.normalMap &&
        m.aoMap === b.aoMap &&
        m.roughnessMap === b.roughnessMap &&
        m.metalnessMap === b.metalnessMap &&
        m.emissiveMap === b.emissiveMap
      )
        continue;
      const had = mask(m);
      m.map = b.map;
      m.normalMap = b.normalMap;
      m.aoMap = b.aoMap;
      m.roughnessMap = b.roughnessMap;
      m.metalnessMap = b.metalnessMap;
      m.emissiveMap = b.emissiveMap;
      // A map appearing / disappearing changes the program (USE_*MAP defines).
      if (mask(m) !== had) m.needsUpdate = true;
    }
  }

  /** Disposes the clones only (the base library belongs to the game). */
  dispose(): void {
    for (const v of this.variants.values()) v.material.dispose();
    this.variants.clear();
    this.synced.length = 0;
  }
}

function mask(m: THREE.MeshStandardMaterial): number {
  return (
    (m.map ? 1 : 0) |
    (m.normalMap ? 2 : 0) |
    (m.aoMap ? 4 : 0) |
    (m.roughnessMap ? 8 : 0) |
    (m.metalnessMap ? 16 : 0) |
    (m.emissiveMap ? 32 : 0)
  );
}
