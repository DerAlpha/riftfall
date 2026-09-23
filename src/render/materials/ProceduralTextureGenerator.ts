/**
 * GPU procedural PBR texture synthesis.
 *
 * One shared fullscreen triangle + one ShaderMaterial per generator render into
 * WebGLRenderTargets: height (float scratch) → normal, albedo (sRGB), ORM and optional emissive
 * (all RGBA8, mipmapped, trilinear, repeat, anisotropic). Results are cached per
 * (generator, params, size, uvScale) and shared by every material that asks for the same key.
 *
 * Render-target textures cannot be re-uploaded, so later anisotropy changes are applied to the
 * live GL texture directly (see applyAnisotropy). After a WebGL context restore the targets are
 * re-rendered in place (materials keep their texture references).
 */
import * as THREE from 'three';
import { createLogger } from '../../core/log';
import type { GeneratorId, GeneratorParams } from '../../defs/materials';
import { PROCEDURAL_TEXTURES } from '../../defs/materials';
import {
  FULLSCREEN_VERTEX,
  NORMAL_FRAGMENT,
  PASS_ALBEDO,
  PASS_EMISSIVE,
  PASS_HEIGHT,
  PASS_ORM,
  buildGeneratorFragment,
  generatorHasEmissive,
} from './proceduralShaders';

const log = createLogger('ProcTex');

export interface ProceduralRequest {
  generator: GeneratorId;
  params: GeneratorParams;
  /** Texture edge length in pixels (power of two). */
  size: number;
  /** Meters per texture repeat (converts mm-based params to uv space). */
  uvScale: number;
}

export interface ProceduralTextureSet {
  readonly key: string;
  readonly size: number;
  readonly map: THREE.Texture;
  readonly normalMap: THREE.Texture;
  /** R = AO, G = roughness, B = metalness. */
  readonly ormMap: THREE.Texture;
  readonly emissiveMap: THREE.Texture | null;
}

interface CacheEntry {
  request: ProceduralRequest;
  set: ProceduralTextureSet;
  targets: THREE.WebGLRenderTarget[];
  albedo: THREE.WebGLRenderTarget;
  normal: THREE.WebGLRenderTarget;
  orm: THREE.WebGLRenderTarget;
  emissive: THREE.WebGLRenderTarget | null;
  refs: number;
}

type AnisotropyExt = { readonly TEXTURE_MAX_ANISOTROPY_EXT: number };

/** Stable cache key; numbers are rounded so float noise in params does not split the cache. */
export function proceduralCacheKey(req: ProceduralRequest): string {
  const p = req.params;
  const r = (v: number): string => (Math.round(v * 1e4) / 1e4).toString();
  const parts: string[] = [
    req.generator,
    String(req.size),
    r(req.uvScale),
    p.colorA.map(r).join(','),
    p.colorB.map(r).join(','),
    p.colorC.map(r).join(','),
    p.cells.map(r).join(','),
    r(p.reliefMm),
    r(p.seamMm),
    r(p.bevelMm),
    r(p.wear),
    r(p.grime),
    r(p.scratches),
    r(p.roughness),
    r(p.roughnessVariation),
    r(p.metalness),
    r(p.bareMetalness),
    r(p.colorVariation),
    p.detail.map(r).join(','),
    r(p.seed),
  ];
  return parts.join('|');
}

/** Largest power of two <= v, clamped to the procedural size limits and the GPU limit. */
export function proceduralSize(requested: number, maxTextureSize: number): number {
  const max = Math.min(PROCEDURAL_TEXTURES.maxSize, maxTextureSize);
  const clamped = Math.max(PROCEDURAL_TEXTURES.minSize, Math.min(max, requested));
  return 2 ** Math.floor(Math.log2(clamped));
}

export class ProceduralTextureGenerator {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly generatorMaterials = new Map<GeneratorId, THREE.ShaderMaterial>();
  private readonly normalMaterial: THREE.ShaderMaterial;
  private readonly heightTargets = new Map<number, THREE.WebGLRenderTarget>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly heightType: THREE.TextureDataType;
  private anisotropy = 1;
  private disposed = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    // One oversized triangle covers the viewport without a diagonal seam.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.normalMaterial = new THREE.ShaderMaterial({
      name: 'ProcTex.normal',
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: NORMAL_FRAGMENT,
      uniforms: {
        uHeightTex: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStrength: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(geo, this.normalMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const ext = renderer.extensions;
    this.heightType = ext.has('EXT_color_buffer_float')
      ? THREE.FloatType
      : ext.has('EXT_color_buffer_half_float')
        ? THREE.HalfFloatType
        : THREE.UnsignedByteType;
    if (this.heightType === THREE.UnsignedByteType) {
      log.warn('No renderable float format: procedural normal maps will be quantized');
    }
  }

  get maxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  /** Number of cached texture sets (debug). */
  get cachedSets(): number {
    return this.cache.size;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Generate (or fetch from cache) a texture set. Synchronous GPU work – callers yield between
   * requests to keep the loading screen responsive. Adds one reference; pair with release().
   */
  acquire(req: ProceduralRequest): ProceduralTextureSet {
    const key = proceduralCacheKey(req);
    const cached = this.cache.get(key);
    if (cached) {
      cached.refs++;
      return cached.set;
    }
    const entry = this.createEntry(key, req);
    this.renderEntry(entry);
    this.cache.set(key, entry);
    return entry.set;
  }

  release(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    for (const rt of entry.targets) rt.dispose();
    this.cache.delete(key);
  }

  /**
   * Free the float height scratch targets and the generator programs (call after a batch of
   * generations). Both are rebuilt lazily if another generation is requested later.
   */
  releaseScratch(): void {
    for (const rt of this.heightTargets.values()) rt.dispose();
    this.heightTargets.clear();
    for (const m of this.generatorMaterials.values()) m.dispose();
    this.generatorMaterials.clear();
  }

  setAnisotropy(value: number): void {
    const v = Math.max(1, Math.floor(value));
    if (v === this.anisotropy) return;
    this.anisotropy = v;
    for (const entry of this.cache.values()) {
      for (const rt of entry.targets) this.applyAnisotropy(rt.texture, v);
    }
  }

  /** Re-render every cached set into its existing targets (after a WebGL context restore). */
  regenerateAll(): void {
    for (const entry of this.cache.values()) {
      try {
        this.renderEntry(entry);
      } catch (err) {
        log.error(`Regenerating ${entry.request.generator} failed`, err);
      }
    }
    this.releaseScratch();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.cache.values()) for (const rt of entry.targets) rt.dispose();
    this.cache.clear();
    this.releaseScratch();
    this.normalMaterial.dispose();
    this.quad.geometry.dispose();
  }

  // ---------------------------------------------------------------------------

  private createEntry(key: string, req: ProceduralRequest): CacheEntry {
    const size = req.size;
    const albedo = this.createTarget(size, THREE.SRGBColorSpace, 'albedo');
    const normal = this.createTarget(size, THREE.NoColorSpace, 'normal');
    const orm = this.createTarget(size, THREE.NoColorSpace, 'orm');
    const emissive = generatorHasEmissive(req.generator)
      ? this.createTarget(size, THREE.SRGBColorSpace, 'emissive')
      : null;
    const targets = emissive ? [albedo, normal, orm, emissive] : [albedo, normal, orm];
    const set: ProceduralTextureSet = {
      key,
      size,
      map: albedo.texture,
      normalMap: normal.texture,
      ormMap: orm.texture,
      emissiveMap: emissive ? emissive.texture : null,
    };
    return { request: req, set, targets, albedo, normal, orm, emissive, refs: 1 };
  }

  private createTarget(size: number, colorSpace: THREE.ColorSpace, label: string): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      anisotropy: this.anisotropy,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = `proc.${label}`;
    return rt;
  }

  private heightTarget(size: number): THREE.WebGLRenderTarget {
    let rt = this.heightTargets.get(size);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: this.heightType,
        format: THREE.RedFormat,
        colorSpace: THREE.NoColorSpace,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        // Nearest: the offsets used for derivatives land on exact texel centers.
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.name = 'proc.height';
      this.heightTargets.set(size, rt);
    }
    return rt;
  }

  private materialFor(id: GeneratorId): THREE.ShaderMaterial {
    let mat = this.generatorMaterials.get(id);
    if (!mat) {
      mat = new THREE.ShaderMaterial({
        name: `ProcTex.${id}`,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: buildGeneratorFragment(id),
        uniforms: {
          uPass: { value: PASS_HEIGHT },
          uSeed: { value: 0 },
          uMeters: { value: 1 },
          uTexel: { value: new THREE.Vector2() },
          uHeightTex: { value: null },
          uColorA: { value: new THREE.Color() },
          uColorB: { value: new THREE.Color() },
          uColorC: { value: new THREE.Color() },
          uCells: { value: new THREE.Vector2() },
          uSeamMm: { value: 0 },
          uBevelMm: { value: 0 },
          uWear: { value: 0 },
          uGrime: { value: 0 },
          uScratches: { value: 0 },
          uRough: { value: 0.5 },
          uRoughVar: { value: 0 },
          uMetal: { value: 0 },
          uBareMetal: { value: 1 },
          uColorVar: { value: 0 },
          uDetail: { value: new THREE.Vector4() },
          uAoRadius: {
            value: new THREE.Vector2(PROCEDURAL_TEXTURES.aoRadiusNear, PROCEDURAL_TEXTURES.aoRadiusFar),
          },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      this.generatorMaterials.set(id, mat);
    }
    return mat;
  }

  private renderEntry(entry: CacheEntry): void {
    const req = entry.request;
    const size = req.size;
    const p = req.params;
    const mat = this.materialFor(req.generator);
    const u = mat.uniforms as Record<string, THREE.IUniform>;
    const height = this.heightTarget(size);

    u.uSeed!.value = p.seed;
    u.uMeters!.value = req.uvScale;
    (u.uTexel!.value as THREE.Vector2).set(1 / size, 1 / size);
    // Colors are already linear: bypass three's color management on purpose.
    (u.uColorA!.value as THREE.Color).setRGB(
      p.colorA[0],
      p.colorA[1],
      p.colorA[2],
      THREE.LinearSRGBColorSpace,
    );
    (u.uColorB!.value as THREE.Color).setRGB(
      p.colorB[0],
      p.colorB[1],
      p.colorB[2],
      THREE.LinearSRGBColorSpace,
    );
    (u.uColorC!.value as THREE.Color).setRGB(
      p.colorC[0],
      p.colorC[1],
      p.colorC[2],
      THREE.LinearSRGBColorSpace,
    );
    (u.uCells!.value as THREE.Vector2).set(p.cells[0], p.cells[1]);
    u.uSeamMm!.value = p.seamMm;
    u.uBevelMm!.value = p.bevelMm;
    u.uWear!.value = p.wear;
    u.uGrime!.value = p.grime;
    u.uScratches!.value = p.scratches;
    u.uRough!.value = p.roughness;
    u.uRoughVar!.value = p.roughnessVariation;
    u.uMetal!.value = p.metalness;
    u.uBareMetal!.value = p.bareMetalness;
    u.uColorVar!.value = p.colorVariation;
    (u.uDetail!.value as THREE.Vector4).set(p.detail[0], p.detail[1], p.detail[2], p.detail[3]);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevLevel = r.getActiveMipmapLevel();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    const prevShadowAuto = r.shadowMap.autoUpdate;
    r.autoClear = false;
    r.xr.enabled = false;
    r.shadowMap.autoUpdate = false;
    try {
      this.quad.material = mat;
      u.uHeightTex!.value = null;
      u.uPass!.value = PASS_HEIGHT;
      this.draw(height);

      u.uHeightTex!.value = height.texture;
      u.uPass!.value = PASS_ALBEDO;
      this.draw(entry.albedo);
      u.uPass!.value = PASS_ORM;
      this.draw(entry.orm);
      if (entry.emissive) {
        u.uPass!.value = PASS_EMISSIVE;
        this.draw(entry.emissive);
      }

      this.quad.material = this.normalMaterial;
      const nu = this.normalMaterial.uniforms as Record<string, THREE.IUniform>;
      nu.uHeightTex!.value = height.texture;
      (nu.uTexel!.value as THREE.Vector2).set(1 / size, 1 / size);
      // Height units → slope: relief (m) per unit over texel size (m).
      nu.uStrength!.value = ((p.reliefMm * 0.001) / req.uvScale) * size * PROCEDURAL_TEXTURES.normalBoost;
      this.draw(entry.normal);
      nu.uHeightTex!.value = null;
      u.uHeightTex!.value = null;
    } finally {
      r.setRenderTarget(prevTarget, prevFace, prevLevel);
      r.autoClear = prevAutoClear;
      r.xr.enabled = prevXr;
      r.shadowMap.autoUpdate = prevShadowAuto;
    }
  }

  private draw(target: THREE.WebGLRenderTarget): void {
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * three only applies anisotropy when a render target is first set up; later changes go to
   * the GL texture object directly (internal `__webglTexture`, stable across three releases).
   */
  private applyAnisotropy(texture: THREE.Texture, value: number): void {
    texture.anisotropy = value;
    const props = this.renderer.properties.get(texture) as {
      __webglTexture?: WebGLTexture;
      __currentAnisotropy?: number;
    };
    const glTex = props.__webglTexture;
    if (!glTex) return; // Not set up yet: three applies texture.anisotropy on setup.
    const ext = this.renderer.extensions.get('EXT_texture_filter_anisotropic') as AnisotropyExt | null;
    if (!ext) return;
    const gl = this.renderer.getContext();
    const max = this.renderer.capabilities.getMaxAnisotropy();
    this.renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(value, max));
    this.renderer.state.unbindTexture();
    props.__currentAnisotropy = value;
  }
}
