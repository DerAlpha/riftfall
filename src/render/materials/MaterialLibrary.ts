/**
 * Shared PBR materials by id (defs/materials.ts).
 *
 * Texture source per material: a downloaded texture set (assets.loadTextureSet) when available,
 * otherwise GPU procedural textures. Geometry carries UVs in meters, so every map repeats
 * 1 / uvScale times per meter. Materials are created once and shared; maps are attached before
 * the first render when `preload()` ran (the level builders do that), so no shader variant is
 * compiled mid-game. Unknown ids get a loud magenta placeholder.
 */
import * as THREE from 'three';
import type {
  AssetsApi,
  MaterialLibraryApi,
  RenderApi,
  SettingsStore,
  TextureSet,
} from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { createLogger } from '../../core/log';
import { getAssetEntry } from '../../assets/manifest';
import { QUALITY_LEVELS } from '../../defs/graphics';
import {
  ASSET_SCALAR_FALLBACK,
  PLACEHOLDER_MATERIAL,
  getMaterialDef,
  resolveGeneratorParams,
  type MaterialDef,
} from '../../defs/materials';
import type { GraphicsSettings } from '../../save/settingsSchema';
import {
  ProceduralTextureGenerator,
  proceduralSize,
  type ProceduralTextureSet,
} from './ProceduralTextureGenerator';

const log = createLogger('Materials');

interface MaterialEntry {
  def: MaterialDef;
  material: THREE.MeshStandardMaterial;
  /** Where the maps came from. */
  source: 'none' | 'pending' | 'asset' | 'procedural';
  /** Procedural cache key currently bound (released on swap/dispose). */
  procKey: string | null;
  /** Per-material clones of asset textures (share GPU data, own repeat). */
  assetClones: THREE.Texture[];
  loading: Promise<void> | null;
}

/** Yield to the browser so the loading screen can repaint (rAF with a timeout fallback for hidden tabs). */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

function isPhysical(def: MaterialDef): boolean {
  return def.physical !== undefined;
}

export class MaterialLibrary implements MaterialLibraryApi {
  private readonly entries = new Map<string, MaterialEntry>();
  private readonly generator: ProceduralTextureGenerator;
  private placeholder: THREE.MeshStandardMaterial | null = null;
  private readonly warnedUnknown = new Set<string>();
  private anisotropy: number;
  private textureQuality: GraphicsSettings['textureQuality'];
  private readonly unsubscribe: (() => void)[] = [];
  private regenerating: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly render: RenderApi,
    private readonly assets: AssetsApi,
    settings: SettingsStore,
    events?: EventBus<GameEvents>,
  ) {
    this.generator = new ProceduralTextureGenerator(render.renderer);
    const g = settings.current.graphics;
    this.anisotropy = this.clampAnisotropy(g.anisotropy);
    this.textureQuality = g.textureQuality;
    this.generator.setAnisotropy(this.anisotropy);
    if (events) {
      this.unsubscribe.push(
        events.on('settings:changed', ({ settings: s, sections }) => {
          if (sections.includes('graphics')) this.applyGraphicsSettings(s.graphics);
        }),
      );
    }
    const canvas = render.canvas;
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
      this.unsubscribe.push(() => canvas.removeEventListener('webglcontextrestored', this.onContextRestored));
    }
  }

  get(id: string): THREE.MeshStandardMaterial {
    const existing = this.entries.get(id);
    if (existing) return existing.material;
    const def = getMaterialDef(id);
    if (!def) return this.getPlaceholder(id);
    const entry = this.createEntry(def);
    this.entries.set(id, entry);
    if (def.generator || def.textureSet) {
      // Late request without preload: textures arrive asynchronously (one recompile).
      log.debug(`Material "${id}" requested before preload; loading textures lazily`);
      void this.ensureTextures(entry);
    }
    return entry.material;
  }

  async preload(ids: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const unique = [...new Set(ids)];
    const total = unique.length;
    let done = 0;
    onProgress?.(0, total);
    for (const id of unique) {
      if (this.disposed) return;
      const def = getMaterialDef(id);
      if (!def) {
        this.getPlaceholder(id);
      } else {
        let entry = this.entries.get(id);
        if (!entry) {
          entry = this.createEntry(def);
          this.entries.set(id, entry);
        }
        const hadWork = entry.source === 'none' && (def.generator !== null || def.textureSet !== null);
        await this.ensureTextures(entry);
        if (hadWork) await yieldFrame();
      }
      done++;
      onProgress?.(done, total);
    }
    this.generator.releaseScratch();
  }

  /** Apply anisotropy / texture quality changes (called from settings:changed). */
  applyGraphicsSettings(g: GraphicsSettings): void {
    const aniso = this.clampAnisotropy(g.anisotropy);
    if (aniso !== this.anisotropy) {
      this.anisotropy = aniso;
      this.generator.setAnisotropy(aniso);
      for (const entry of this.entries.values()) {
        for (const t of entry.assetClones) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
    }
    if (g.textureQuality !== this.textureQuality) {
      this.textureQuality = g.textureQuality;
      void this.regenerateProcedural();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const entry of this.entries.values()) {
      for (const t of entry.assetClones) t.dispose();
      entry.material.dispose();
    }
    this.entries.clear();
    this.placeholder?.dispose();
    this.placeholder = null;
    this.generator.dispose();
  }

  // ---------------------------------------------------------------------------

  private readonly onContextRestored = (): void => {
    log.warn('WebGL context restored: regenerating procedural textures');
    try {
      this.generator.regenerateAll();
    } catch (err) {
      log.error('Regenerating procedural textures failed', err);
    }
  };

  private clampAnisotropy(v: number): number {
    const max = this.render.renderer.capabilities.getMaxAnisotropy();
    return Math.max(1, Math.min(Math.floor(v) || 1, max || 1));
  }

  private proceduralSizeFor(def: MaterialDef): number {
    const base = QUALITY_LEVELS.textureQuality[this.textureQuality].proceduralSize;
    return proceduralSize(base * def.resolution, this.generator.maxTextureSize);
  }

  private createEntry(def: MaterialDef): MaterialEntry {
    const mat = isPhysical(def) ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
    mat.name = def.id;
    mat.color.setRGB(def.color[0], def.color[1], def.color[2], THREE.LinearSRGBColorSpace);
    mat.roughness = def.roughness;
    mat.metalness = def.metalness;
    mat.normalScale.set(def.normalScale, def.normalScale);
    mat.aoMapIntensity = def.aoIntensity;
    mat.envMapIntensity = def.envMapIntensity;
    mat.emissive.setRGB(def.emissive[0], def.emissive[1], def.emissive[2], THREE.LinearSRGBColorSpace);
    mat.emissiveIntensity = def.emissiveIntensity;
    mat.side = def.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    if (def.opacity < 1) {
      mat.transparent = true;
      mat.opacity = def.opacity;
      mat.depthWrite = false;
    }
    if (mat instanceof THREE.MeshPhysicalMaterial && def.physical) {
      const ph = def.physical;
      if (ph.clearcoat !== undefined) mat.clearcoat = ph.clearcoat;
      if (ph.clearcoatRoughness !== undefined) mat.clearcoatRoughness = ph.clearcoatRoughness;
      if (ph.transmission !== undefined) mat.transmission = ph.transmission;
      if (ph.ior !== undefined) mat.ior = ph.ior;
      if (ph.thickness !== undefined) mat.thickness = ph.thickness;
      if (ph.specularIntensity !== undefined) mat.specularIntensity = ph.specularIntensity;
    }
    this.render.setupMaterial(mat);
    return { def, material: mat, source: 'none', procKey: null, assetClones: [], loading: null };
  }

  private getPlaceholder(id: string): THREE.MeshStandardMaterial {
    if (!this.warnedUnknown.has(id)) {
      this.warnedUnknown.add(id);
      log.warn(`Unknown material "${id}" – using placeholder`);
    }
    if (!this.placeholder) {
      const p = PLACEHOLDER_MATERIAL;
      const mat = new THREE.MeshStandardMaterial({ roughness: p.roughness, metalness: p.metalness });
      mat.name = 'placeholder';
      mat.color.setRGB(p.color[0], p.color[1], p.color[2], THREE.LinearSRGBColorSpace);
      mat.emissive.setRGB(p.emissive[0], p.emissive[1], p.emissive[2], THREE.LinearSRGBColorSpace);
      mat.emissiveIntensity = p.emissiveIntensity;
      this.render.setupMaterial(mat);
      this.placeholder = mat;
    }
    return this.placeholder;
  }

  private ensureTextures(entry: MaterialEntry): Promise<void> {
    if (entry.loading) return entry.loading;
    if (entry.source !== 'none') return Promise.resolve();
    entry.source = 'pending';
    entry.loading = this.loadTextures(entry).finally(() => {
      entry.loading = null;
    });
    return entry.loading;
  }

  private async loadTextures(entry: MaterialEntry): Promise<void> {
    const def = entry.def;
    if (def.textureSet) {
      let set: TextureSet | null = null;
      try {
        set = await this.assets.loadTextureSet(def.textureSet);
      } catch (err) {
        log.warn(`Texture set "${def.textureSet}" failed for "${def.id}"`, err);
      }
      if (this.disposed) return;
      if (set && (set.map || set.normalMap)) {
        this.bindAssetSet(entry, set);
        entry.source = 'asset';
        return;
      }
    }
    if (def.generator) {
      try {
        this.bindProcedural(entry);
        entry.source = 'procedural';
      } catch (err) {
        log.error(`Procedural textures for "${def.id}" failed – using flat material`, err);
        entry.source = 'none';
      }
      return;
    }
    entry.source = 'none';
  }

  private bindProcedural(entry: MaterialEntry): void {
    const def = entry.def;
    const params = resolveGeneratorParams(def);
    if (!def.generator || !params) return;
    const set = this.generator.acquire({
      generator: def.generator,
      params,
      size: this.proceduralSizeFor(def),
      uvScale: def.uvScale,
    });
    const prevKey = entry.procKey;
    this.applySet(entry.material, def, set);
    entry.procKey = set.key;
    if (prevKey && prevKey !== set.key) this.generator.release(prevKey);
  }

  private applySet(mat: THREE.MeshStandardMaterial, def: MaterialDef, set: ProceduralTextureSet): void {
    const repeat = 1 / def.uvScale;
    for (const t of [set.map, set.normalMap, set.ormMap, set.emissiveMap]) {
      // Shared textures only ever carry their own def's uvScale (it is part of the cache key).
      if (t) t.repeat.set(repeat, repeat);
    }
    const hadMaps = mat.map !== null;
    mat.map = set.map;
    mat.normalMap = set.normalMap;
    mat.aoMap = set.ormMap;
    mat.roughnessMap = set.ormMap;
    mat.metalnessMap = set.ormMap;
    if (set.emissiveMap) mat.emissiveMap = set.emissiveMap;
    // Swapping textures of the same kind needs no recompile.
    if (!hadMaps) mat.needsUpdate = true;
  }

  private bindAssetSet(entry: MaterialEntry, set: TextureSet): void {
    const def = entry.def;
    const mat = entry.material;
    // Scanned textures tile at their real-world size (Poly Haven metadata); the def's uvScale is
    // tuned for the procedural generator's cell layout and would stretch e.g. diamond plate 8x.
    const physical = def.textureSet ? getAssetEntry(def.textureSet)?.physicalSizeM : undefined;
    const repeat = 1 / (physical ?? def.uvScale);
    const clone = (t: THREE.Texture | null): THREE.Texture | null => {
      if (!t) return null;
      // A clone shares the GPU upload (same Source) but owns repeat/wrap.
      const c = t.clone();
      c.wrapS = THREE.RepeatWrapping;
      c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(repeat, repeat);
      c.anisotropy = this.anisotropy;
      c.needsUpdate = true;
      entry.assetClones.push(c);
      return c;
    };
    mat.map = clone(set.map);
    mat.normalMap = clone(set.normalMap);
    const orm = clone(set.ormMap);
    mat.aoMap = orm ?? clone(set.aoMap);
    mat.roughnessMap = orm ?? clone(set.roughnessMap);
    mat.metalnessMap = orm ?? clone(set.metalnessMap);
    const emissive = clone(set.emissiveMap);
    if (emissive) mat.emissiveMap = emissive;
    // Def roughness/metalness are multipliers for maps; without a map they would become absolute
    // values (metalness 1 = black chrome). Use the generator's base values instead.
    const params = resolveGeneratorParams(def);
    if (!mat.roughnessMap) {
      mat.roughness = def.roughness * (params?.roughness ?? ASSET_SCALAR_FALLBACK.roughness);
    }
    if (!mat.metalnessMap) {
      mat.metalness = def.metalness * (params?.metalness ?? ASSET_SCALAR_FALLBACK.metalness);
    }
    mat.needsUpdate = true;
  }

  /** Texture quality changed: regenerate procedural sets at the new size and swap them in. */
  private async regenerateProcedural(): Promise<void> {
    if (this.regenerating) await this.regenerating;
    this.regenerating = (async () => {
      for (const entry of this.entries.values()) {
        if (this.disposed) return;
        if (entry.source !== 'procedural') continue;
        try {
          this.bindProcedural(entry);
        } catch (err) {
          log.error(`Regenerating "${entry.def.id}" failed`, err);
        }
        await yieldFrame();
      }
      this.generator.releaseScratch();
    })();
    try {
      await this.regenerating;
    } finally {
      this.regenerating = null;
    }
  }
}
