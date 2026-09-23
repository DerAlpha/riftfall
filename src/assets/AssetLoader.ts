/**
 * Asset loading with caching, in-flight de-duplication and graceful fallbacks.
 *
 * - The available index (assets/available.json, written by `npm run assets`) is fetched first;
 *   only files listed there are ever requested. No index ⇒ every asset is unavailable and callers
 *   use their procedural fallbacks (texture sets / HDRI return null, textures/models placeholders).
 * - Public methods never reject. Failed ids are collected in `missing` (debug overlay).
 * - Texture color spaces: albedo/emissive sRGB, all data maps NoColorSpace (no browser color
 *   conversion on upload). Asset textures use RepeatWrapping. JPGs keep three's flipY=true; KTX2
 *   files are written bottom-up by the fetch script (compressed textures cannot be flipped on
 *   upload), so UVs and normal-map orientation are identical for both formats.
 * - Heavy loaders (KTX2 transcoder workers, Draco, glTF) are created on first use only.
 */
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetType, AssetsApi, LoadedModel, TextureSet } from '../core/contracts';
import { createLogger } from '../core/log';
import { ASSETS } from '../defs/assets';
import {
  getAssetEntry,
  parseAvailableIndex,
  planTextureSet,
  type AvailableAsset,
  type AvailableIndex,
  type TextureLoadPlan,
} from './manifest';
import {
  createPlaceholderModel,
  createPlaceholderTexture,
  disposePlaceholderResources,
} from './placeholders';

const log = createLogger('Assets');

type ProgressFn = (loaded: number, total: number, label: string) => void;

function normalizeBase(base: string): string {
  if (base === '') return './';
  return base.endsWith('/') ? base : `${base}/`;
}

function emptyTextureSet(): TextureSet {
  return {
    map: null,
    normalMap: null,
    ormMap: null,
    aoMap: null,
    roughnessMap: null,
    metalnessMap: null,
    emissiveMap: null,
  };
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}

/** Run `fn` over items with at most `limit` in flight. */
async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) workers.push(worker());
  await Promise.all(workers);
}

export class AssetLoader implements AssetsApi {
  private readonly baseUrl: string;
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly missingIds: string[] = [];
  private readonly missingSet = new Set<string>();
  private readonly loadedIds = new Set<string>();
  /** Every texture this loader created (disposed in dispose()). */
  private readonly textures = new Set<THREE.Texture>();
  private readonly models: GLTF[] = [];
  private indexPromise: Promise<AvailableIndex | null> | null = null;
  private index: AvailableIndex | null = null;

  private readonly textureLoader = new THREE.TextureLoader();
  private hdrLoader: HDRLoader | null = null;
  private ktx2Loader: KTX2Loader | null = null;
  private ktx2Failed = false;
  private dracoLoader: DRACOLoader | null = null;
  private gltfLoader: GLTFLoader | null = null;
  private placeholderTexture: THREE.DataTexture | null = null;
  private decodeContext: OfflineAudioContext | null = null;
  private disposed = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getAudioContext: () => BaseAudioContext | null,
    baseUrl: string = import.meta.env.BASE_URL,
  ) {
    this.baseUrl = normalizeBase(baseUrl);
  }

  get missing(): readonly string[] {
    return this.missingIds;
  }

  /** The parsed available index once fetched (null before, or when there is none). */
  get availableIndex(): AvailableIndex | null {
    return this.index;
  }

  /** True if the id was loaded from real files, or the index lists it as downloaded. */
  has(id: string): boolean {
    return this.loadedIds.has(id) || (this.index?.assets[id] !== undefined && !this.missingSet.has(id));
  }

  async preload(ids: readonly string[], onProgress?: ProgressFn): Promise<void> {
    const unique = [...new Set(ids)];
    const total = unique.length;
    let loaded = 0;
    const report = (label: string): void => {
      try {
        onProgress?.(loaded, total, label);
      } catch (err) {
        log.warn('preload progress callback threw', err);
      }
    };
    report(unique.length > 0 ? this.labelOf(unique[0] as string) : '');
    await runLimited(unique, ASSETS.loader.maxConcurrent, async (id) => {
      try {
        await this.loadAny(id);
      } catch (err) {
        this.markMissing(id, err);
      }
      loaded++;
      report(this.labelOf(id));
    });
  }

  loadHDRI(id: string): Promise<THREE.Texture | null> {
    return this.cached(`hdri:${id}`, async () => {
      const asset = await this.availableAsset(id, 'hdri');
      const file = asset?.files.hdr;
      if (!file) return null;
      try {
        this.hdrLoader ??= new HDRLoader().setDataType(THREE.HalfFloatType);
        const tex = await this.hdrLoader.loadAsync(this.url(file));
        if (this.disposed) {
          tex.dispose();
          return null;
        }
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.name = id;
        return this.track(id, tex);
      } catch (err) {
        this.markMissing(id, err);
        return null;
      }
    });
  }

  loadTexture(id: string, opts?: { srgb?: boolean }): Promise<THREE.Texture> {
    const srgb = opts?.srgb ?? true;
    return this.cached(`tex:${id}:${srgb ? 's' : 'l'}`, async () => {
      const asset = await this.availableAsset(id, 'texture', 'lut');
      const file = asset?.files.image ?? asset?.files.lut;
      if (asset && file) {
        const tex = await this.loadImage(
          { role: 'map', url: file, ktx2Url: asset.ktx2?.map ?? null, srgb },
          id,
        );
        if (tex) {
          this.loadedIds.add(id);
          return tex;
        }
        this.markMissing(id, 'image failed to load');
      }
      return this.getPlaceholderTexture();
    });
  }

  loadTextureSet(id: string): Promise<TextureSet | null> {
    return this.cached(`set:${id}`, async () => {
      const asset = await this.availableAsset(id, 'textureSet');
      if (!asset) return null;
      const set = emptyTextureSet();
      // Only spin up the KTX2 transcoder when converted files actually exist.
      const plan = planTextureSet(asset, asset.ktx2 !== undefined && this.ktx2Usable());
      await Promise.all(
        plan.map(async (p) => {
          set[p.role] = await this.loadImage(p, id);
        }),
      );
      if (this.disposed) return null;
      // Without albedo the set would render flat – let the caller use its procedural textures instead.
      if (!set.map) {
        for (const tex of Object.values(set)) if (tex) this.releaseTexture(tex);
        this.markMissing(id, 'albedo map failed to load');
        return null;
      }
      this.loadedIds.add(id);
      return set;
    });
  }

  async loadModel(id: string): Promise<LoadedModel> {
    const gltf = await this.loadGltf(id);
    if (!gltf)
      return { scene: createPlaceholderModel(`placeholder:${id}`), animations: [], placeholder: true };
    try {
      // SkeletonUtils.clone keeps skinned meshes bound to their own skeleton; geometry/materials stay shared.
      const scene = cloneSkinned(gltf.scene) as THREE.Group;
      return { scene, animations: gltf.animations, placeholder: false };
    } catch (err) {
      this.markMissing(id, err);
      return { scene: createPlaceholderModel(`placeholder:${id}`), animations: [], placeholder: true };
    }
  }

  loadAudio(id: string): Promise<AudioBuffer | null> {
    return this.cached(`audio:${id}`, async () => {
      const asset = await this.availableAsset(id, 'audio');
      const file = asset?.files.audio;
      if (!file) return null;
      try {
        const res = await fetch(this.url(file));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const ctx = this.getAudioContext() ?? this.createDecodeContext();
        if (!ctx) throw new Error('Web Audio unavailable');
        const buffer = await ctx.decodeAudioData(data);
        this.loadedIds.add(id);
        return buffer;
      } catch (err) {
        this.markMissing(id, err);
        return null;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const tex of this.textures) tex.dispose();
    this.textures.clear();
    for (const gltf of this.models) disposeObject(gltf.scene);
    this.models.length = 0;
    this.placeholderTexture?.dispose();
    this.placeholderTexture = null;
    disposePlaceholderResources();
    this.ktx2Loader?.dispose();
    this.ktx2Loader = null;
    this.dracoLoader?.dispose();
    this.dracoLoader = null;
    this.gltfLoader = null;
    this.decodeContext = null;
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private url(path: string): string {
    return this.baseUrl + path;
  }

  private labelOf(id: string): string {
    return getAssetEntry(id)?.label ?? id;
  }

  private cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = factory();
      this.cache.set(key, p);
    }
    return p;
  }

  private markMissing(id: string, reason: unknown): void {
    if (this.missingSet.has(id)) return;
    this.missingSet.add(id);
    this.missingIds.push(id);
    log.warn(`Asset "${id}" unavailable – using fallback`, reason);
  }

  private track<T extends THREE.Texture>(id: string, tex: T): T {
    this.textures.add(tex);
    this.loadedIds.add(id);
    return tex;
  }

  private releaseTexture(tex: THREE.Texture): void {
    this.textures.delete(tex);
    tex.dispose();
  }

  private loadIndex(): Promise<AvailableIndex | null> {
    this.indexPromise ??= (async () => {
      try {
        const res = await fetch(this.url(ASSETS.indexFile), { cache: 'no-cache' });
        if (!res.ok) {
          log.info(
            `No asset index (HTTP ${res.status}) – run "npm run assets" for CC0 textures/HDRI; procedural fallbacks active`,
          );
          return null;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(await res.text());
        } catch {
          // Dev servers answer unknown paths with index.html.
          log.info(
            'No asset index – run "npm run assets" for CC0 textures/HDRI; procedural fallbacks active',
          );
          return null;
        }
        const index = parseAvailableIndex(raw);
        if (!index) log.warn('Asset index has an unsupported format – ignoring it');
        this.index = index;
        return index;
      } catch (err) {
        log.info('Asset index unavailable – procedural fallbacks active', err);
        return null;
      }
    })();
    return this.indexPromise;
  }

  /** Index entry for id if it was downloaded and has an accepted type; marks it missing otherwise. */
  private async availableAsset(id: string, ...types: AssetType[]): Promise<AvailableAsset | null> {
    const index = await this.loadIndex();
    if (this.disposed) return null;
    const asset = index?.assets[id];
    if (!asset) {
      const known = getAssetEntry(id) !== undefined;
      this.markMissing(id, known ? (index ? 'not downloaded' : 'no asset index') : 'unknown asset id');
      return null;
    }
    if (!types.includes(asset.type)) {
      this.markMissing(id, `expected ${types.join('/')}, index says ${asset.type}`);
      return null;
    }
    return asset;
  }

  private async loadAny(id: string): Promise<void> {
    const type = getAssetEntry(id)?.type ?? (await this.loadIndex())?.assets[id]?.type;
    switch (type) {
      case 'hdri':
        await this.loadHDRI(id);
        return;
      case 'textureSet':
        await this.loadTextureSet(id);
        return;
      case 'texture':
      case 'lut':
        await this.loadTexture(id);
        return;
      case 'gltf':
        await this.loadGltf(id);
        return;
      case 'audio':
        await this.loadAudio(id);
        return;
      default:
        this.markMissing(id, 'unknown asset id');
    }
  }

  private ktx2Usable(): boolean {
    if (this.ktx2Failed) return false;
    if (this.ktx2Loader) return true;
    try {
      // three r186 resolves its bundled Basis transcoder via import.meta.url, which Vite emits as
      // hashed assets – no transcoder path needed and it works under any deploy base.
      this.ktx2Loader = new KTX2Loader()
        .setWorkerLimit(ASSETS.loader.ktx2Workers)
        .detectSupport(this.renderer);
      return true;
    } catch (err) {
      log.warn('KTX2 unsupported – using JPG textures', err);
      this.ktx2Failed = true;
      this.ktx2Loader = null;
      return false;
    }
  }

  /** One image texture: KTX2 first when available, JPG/PNG otherwise. Returns null on failure. */
  private async loadImage(p: TextureLoadPlan, id: string): Promise<THREE.Texture | null> {
    let tex: THREE.Texture | null = null;
    if (p.ktx2Url && this.ktx2Usable() && this.ktx2Loader) {
      try {
        tex = await this.ktx2Loader.loadAsync(this.url(p.ktx2Url));
      } catch (err) {
        log.warn(`KTX2 "${p.ktx2Url}" failed – falling back to ${p.url}`, err);
        tex = null;
      }
    }
    if (!tex) {
      try {
        tex = await this.textureLoader.loadAsync(this.url(p.url));
        tex.flipY = true;
      } catch (err) {
        log.warn(`Texture "${p.url}" (${id}) failed to load`, err);
        return null;
      }
    }
    // Finished after dispose(): nobody will release it.
    if (this.disposed) {
      tex.dispose();
      return null;
    }
    tex.name = `${id}.${p.role}`;
    tex.colorSpace = p.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(ASSETS.loader.anisotropy, this.maxAnisotropy());
    tex.needsUpdate = true;
    this.textures.add(tex);
    return tex;
  }

  private maxAnisotropy(): number {
    try {
      return this.renderer.capabilities.getMaxAnisotropy();
    } catch {
      return 1;
    }
  }

  private getPlaceholderTexture(): THREE.Texture {
    this.placeholderTexture ??= createPlaceholderTexture();
    return this.placeholderTexture;
  }

  private getGltfLoader(): GLTFLoader {
    if (this.gltfLoader) return this.gltfLoader;
    // Default decoder URLs (import.meta.url based) are bundled by Vite.
    this.dracoLoader = new DRACOLoader();
    const loader = new GLTFLoader().setDRACOLoader(this.dracoLoader).setMeshoptDecoder(MeshoptDecoder);
    if (this.ktx2Usable() && this.ktx2Loader) loader.setKTX2Loader(this.ktx2Loader);
    this.gltfLoader = loader;
    return loader;
  }

  private loadGltf(id: string): Promise<GLTF | null> {
    return this.cached(`gltf:${id}`, async () => {
      const asset = await this.availableAsset(id, 'gltf');
      const file = asset?.files.model;
      if (!file) return null;
      try {
        const gltf = await this.getGltfLoader().loadAsync(this.url(file));
        if (this.disposed) {
          disposeObject(gltf.scene);
          return null;
        }
        this.models.push(gltf);
        this.loadedIds.add(id);
        return gltf;
      } catch (err) {
        this.markMissing(id, err);
        return null;
      }
    });
  }

  private createDecodeContext(): BaseAudioContext | null {
    if (typeof OfflineAudioContext === 'undefined') return null;
    // AudioBuffers are context independent; one shared 1-frame offline context is enough for decoding.
    this.decodeContext ??= new OfflineAudioContext(1, 1, ASSETS.loader.fallbackDecodeSampleRate);
    return this.decodeContext;
  }
}
