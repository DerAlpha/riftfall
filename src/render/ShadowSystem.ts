/**
 * Sun light + cascaded shadow maps (three CSM addon, WebGL).
 *
 * - Quality comes from QUALITY_LEVELS.shadows (cascades, map size, distance, PCF radius).
 *   'off' (or a map without a shadow-casting sun) uses one plain directional light.
 * - Every lit world material must go through setupMaterial(); the registry lets us tear CSM
 *   down and rebuild it (cascade count change / on-off) and re-setup all materials.
 *   Pre-existing onBeforeCompile hooks are chained, not replaced, and get a distinct program
 *   cache key so materials with different hooks never share a program.
 * - Safety net: lit materials found in the scene that were never registered would receive the
 *   sun once per cascade (the CSM light loop only gates USE_CSM materials), so they are
 *   registered automatically with a warning.
 * - Disposed materials leave the registry (and CSM's own material map), so level/enemy
 *   materials that come and go do not leak.
 * - update() must run every frame after the camera matrices are final and before rendering.
 */
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { createLogger } from '../core/log';
import { QUALITY_LEVELS, SHADOWS } from '../defs/graphics';
import type { SunDef } from '../defs/maps';
import type { QualityLevel } from '../save/settingsSchema';

const log = createLogger('Shadows');

/**
 * The CSM addon replaces ShaderChunk.lights_fragment_begin globally with its own copy, which in
 * r186 is stale: it lacks the DFG-LUT / multi-scattering setup (material.dfg stays zero, so the
 * split-sum IBL specular of EVERY PBR material goes black – metals render black), sun lights and
 * light-probe grids. We therefore rebuild the chunk from the stock r186 source (captured here,
 * before any CSM instance injects) and splice in only CSM's cascaded directional-light block.
 */
const STOCK_LIGHTS_FRAGMENT_BEGIN = THREE.ShaderChunk.lights_fragment_begin;
const CSM_DIR_BLOCK =
  '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_CSM ) && defined( CSM_CASCADES )';
const NON_CSM_DIR_BLOCK =
  '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && !defined( USE_CSM ) && !defined( CSM_CASCADES )';
const STOCK_DIR_BLOCK = /#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \)[ \t]*\r?\n/;

/** Exported for tests. Returns null when either chunk has an unexpected shape. */
export function buildCsmLightsChunk(stock: string, csmChunk: string): string | null {
  if (stock.includes('USE_CSM')) return null;
  const start = csmChunk.indexOf(CSM_DIR_BLOCK);
  const end = csmChunk.indexOf(NON_CSM_DIR_BLOCK);
  if (start < 0 || end <= start || !STOCK_DIR_BLOCK.test(stock)) return null;
  const csmBlock = csmChunk.slice(start, end);
  return stock.replace(STOCK_DIR_BLOCK, () => `${csmBlock}\n${NON_CSM_DIR_BLOCK}\n`);
}

let patchedChunk: string | null | undefined;

/** Call right after constructing a CSM (its constructor injects the stale chunk). */
function installLightsChunk(): void {
  if (patchedChunk === undefined) {
    patchedChunk = buildCsmLightsChunk(STOCK_LIGHTS_FRAGMENT_BEGIN, THREE.ShaderChunk.lights_fragment_begin);
    if (!patchedChunk)
      log.warn('Could not rebuild the CSM lighting chunk; using the addon version (IBL may be wrong)');
  }
  if (patchedChunk) THREE.ShaderChunk.lights_fragment_begin = patchedChunk;
}

type CompileHook = THREE.Material['onBeforeCompile'];
type CacheKeyFn = THREE.Material['customProgramCacheKey'];

interface MaterialEntry {
  /** Own onBeforeCompile the material had before we touched it (null = prototype no-op). */
  hook: CompileHook | null;
  /** Own customProgramCacheKey before we touched it. */
  keyFn: CacheKeyFn | null;
  /** True while CSM-specific hooks/defines are installed on the material. */
  csm: boolean;
}

type ShadowParams = Exclude<(typeof QUALITY_LEVELS.shadows)[QualityLevel], null>;

const _dir = new THREE.Vector3();

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isLitMaterial(m: THREE.Material): boolean {
  const f = m as THREE.Material & {
    isMeshStandardMaterial?: boolean;
    isMeshLambertMaterial?: boolean;
    isMeshPhongMaterial?: boolean;
    isMeshToonMaterial?: boolean;
  };
  return !!(
    f.isMeshStandardMaterial ||
    f.isMeshLambertMaterial ||
    f.isMeshPhongMaterial ||
    f.isMeshToonMaterial
  );
}

export class ShadowSystem {
  private csm: CSM | null = null;
  private plainLight: THREE.DirectionalLight | null = null;
  private readonly registry = new Map<THREE.Material, MaterialEntry>();
  private readonly warnedAuto = new Set<string>();

  private level: QualityLevel = 'off';
  private params: ShadowParams | null = null;
  private castShadows = true;
  private readonly direction = new THREE.Vector3(-0.4, -0.8, -0.4).normalize();
  private readonly color = new THREE.Color(1, 1, 1);
  private intensity = 3;
  private lastFov = -1;
  private lastAspect = -1;
  private autoSetupTimer = 0;

  /** Direction the sunlight travels (normalized, from the sun towards the scene). */
  get sunDirection(): THREE.Vector3 {
    return this.direction;
  }

  get sunColor(): THREE.Color {
    return this.color;
  }

  get sunIntensity(): number {
    return this.intensity;
  }

  get cascades(): number {
    return this.csm?.cascades ?? 0;
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.rebuild();
  }

  /** Representative sun light (first cascade or the plain light) – e.g. for the viewmodel copy. */
  getSunLight(): THREE.DirectionalLight {
    return this.csm?.lights[0] ?? this.plainLight!;
  }

  setQuality(level: QualityLevel): void {
    const params = QUALITY_LEVELS.shadows[level];
    if (level === this.level) return;
    const prev = this.params;
    this.level = level;
    this.params = params;
    // Same cascade count: adjust in place (no material recompiles).
    if (this.csm && params && prev && params.cascades === prev.cascades && this.castShadows) {
      this.applyParamsInPlace(params);
      return;
    }
    this.rebuild();
  }

  setSun(def: SunDef): void {
    _dir.set(def.direction[0], def.direction[1], def.direction[2]);
    if (_dir.lengthSq() < 1e-8) {
      log.warn('Sun direction is zero, keeping previous direction');
    } else {
      this.direction.copy(_dir.normalize());
    }
    this.color.setRGB(def.color[0], def.color[1], def.color[2]);
    this.intensity = def.intensity;
    const wantShadows = def.castShadows;
    if (wantShadows !== this.castShadows) {
      this.castShadows = wantShadows;
      this.rebuild();
      return;
    }
    this.applySunToLights();
  }

  /** Register a lit world material for cascaded shadows (idempotent). */
  setupMaterial(material: THREE.Material): void {
    if (this.registry.has(material)) return;
    const entry: MaterialEntry = {
      hook: hasOwn(material, 'onBeforeCompile') ? material.onBeforeCompile : null,
      keyFn: hasOwn(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null,
      csm: false,
    };
    this.registry.set(material, entry);
    material.addEventListener('dispose', this.onMaterialDispose);
    if (this.csm) this.installCsm(material, entry);
  }

  /** Call when the camera projection (fov/aspect/near/far) changed. Cheap when nothing relevant changed. */
  onProjectionChanged(force = false): void {
    const cam = this.camera;
    const fovDelta = Math.abs(cam.fov - this.lastFov);
    if (!force && fovDelta < SHADOWS.fovUpdateThresholdDeg && cam.aspect === this.lastAspect) return;
    this.lastFov = cam.fov;
    this.lastAspect = cam.aspect;
    if (this.csm) {
      this.csm.updateFrustums();
      this.updateNormalBias();
    }
  }

  /** Per frame, before rendering (camera world matrix must be current). */
  update(dt: number): void {
    if (this.csm) this.csm.update();
    if (SHADOWS.autoSetupIntervalSeconds > 0 && this.csm) {
      this.autoSetupTimer += dt;
      if (this.autoSetupTimer >= SHADOWS.autoSetupIntervalSeconds) {
        this.autoSetupTimer = 0;
        this.scene.traverse(this.autoSetupVisitor);
      }
    }
  }

  dispose(): void {
    this.teardown();
    for (const material of this.registry.keys())
      material.removeEventListener('dispose', this.onMaterialDispose);
    this.registry.clear();
  }

  // ---------------------------------------------------------------------------

  private readonly onMaterialDispose = (event: { target: THREE.Material }): void => {
    const material = event.target;
    material.removeEventListener('dispose', this.onMaterialDispose);
    const entry = this.registry.get(material);
    if (!entry) return;
    this.csm?.shaders.delete(material);
    // Restore the material's own hooks so a later re-registration does not chain a stale CSM hook.
    this.uninstallCsm(material, entry);
    this.registry.delete(material);
  };

  private readonly autoSetupVisitor = (obj: THREE.Object3D): void => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) this.autoSetup(m);
    } else if (mat) {
      this.autoSetup(mat);
    }
  };

  private autoSetup(m: THREE.Material): void {
    if (this.registry.has(m) || !isLitMaterial(m)) return;
    const name = m.name || m.type;
    if (!this.warnedAuto.has(name)) {
      this.warnedAuto.add(name);
      log.warn(`Material "${name}" was not passed to render.setupMaterial(); registering it for CSM now`);
    }
    this.setupMaterial(m);
  }

  private rebuild(): void {
    this.teardown();
    const params = this.params;
    if (params && this.castShadows) {
      const csm = new CSM({
        camera: this.camera,
        parent: this.scene,
        cascades: params.cascades,
        maxFar: params.maxFar,
        mode: SHADOWS.splitMode,
        shadowMapSize: params.mapSize,
        shadowBias: SHADOWS.bias,
        lightDirection: this.direction.clone(),
        lightIntensity: this.intensity,
        lightNear: SHADOWS.lightNear,
        lightFar: SHADOWS.lightMargin + params.maxFar * SHADOWS.lightFarPerMaxFar,
        lightMargin: SHADOWS.lightMargin,
      });
      installLightsChunk();
      csm.fade = SHADOWS.fade;
      this.csm = csm;
      this.applyParamsInPlace(params);
      for (const [material, entry] of this.registry) this.installCsm(material, entry);
    } else {
      const light = new THREE.DirectionalLight(this.color, this.intensity);
      light.name = 'Sun';
      light.castShadow = false;
      this.scene.add(light);
      this.scene.add(light.target);
      this.plainLight = light;
    }
    this.applySunToLights();
  }

  private applyParamsInPlace(params: ShadowParams): void {
    const csm = this.csm;
    if (!csm) return;
    const resized = csm.shadowMapSize !== params.mapSize;
    csm.shadowMapSize = params.mapSize;
    csm.maxFar = params.maxFar;
    csm.lightFar = SHADOWS.lightMargin + params.maxFar * SHADOWS.lightFarPerMaxFar;
    for (const light of csm.lights) {
      const shadow = light.shadow;
      shadow.radius = params.radius;
      shadow.bias = SHADOWS.bias;
      shadow.camera.far = csm.lightFar;
      shadow.camera.updateProjectionMatrix();
      if (resized) {
        shadow.mapSize.set(params.mapSize, params.mapSize);
        // three reallocates the shadow map lazily when it is null.
        shadow.map?.dispose();
        shadow.map = null;
      }
    }
    this.onProjectionChanged(true);
  }

  /** Normal offset proportional to each cascade's texel footprint (+ PCF kernel reach). */
  private updateNormalBias(): void {
    const csm = this.csm;
    const params = this.params;
    if (!csm || !params) return;
    const texels = SHADOWS.normalBiasTexels + SHADOWS.normalBiasPerRadius * params.radius;
    for (const light of csm.lights) {
      const cam = light.shadow.camera;
      const texel = (cam.right - cam.left) / csm.shadowMapSize;
      light.shadow.normalBias = texel * texels;
    }
  }

  private applySunToLights(): void {
    if (this.csm) {
      this.csm.lightDirection.copy(this.direction);
      this.csm.lightIntensity = this.intensity;
      for (const light of this.csm.lights) {
        light.color.copy(this.color);
        light.intensity = this.intensity;
      }
    }
    if (this.plainLight) {
      const l = this.plainLight;
      l.color.copy(this.color);
      l.intensity = this.intensity;
      l.position.copy(this.direction).multiplyScalar(-SHADOWS.plainLightDistance);
      l.target.position.set(0, 0, 0);
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
    }
  }

  private installCsm(material: THREE.Material, entry: MaterialEntry): void {
    const csm = this.csm;
    if (!csm) return;
    csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    const original = entry.hook;
    if (original) {
      material.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
        original.call(this, shader, renderer);
        csmHook.call(this, shader, renderer);
      };
      const originalKey = entry.keyFn;
      const hookSource = original.toString();
      material.customProgramCacheKey = function (this: THREE.Material): string {
        return (originalKey ? originalKey.call(this) : hookSource) + '|csm';
      };
    }
    entry.csm = true;
    material.needsUpdate = true;
  }

  /** Undo installCsm: restore the material's own hooks and drop the CSM defines. */
  private uninstallCsm(material: THREE.Material, entry: MaterialEntry): void {
    if (!entry.csm) return;
    const m = material as unknown as Record<string, unknown>;
    if (entry.hook) material.onBeforeCompile = entry.hook;
    else delete m.onBeforeCompile;
    if (entry.keyFn) material.customProgramCacheKey = entry.keyFn;
    else delete m.customProgramCacheKey;
    const defines = (material as { defines?: Record<string, unknown> }).defines;
    if (defines) {
      delete defines.USE_CSM;
      delete defines.CSM_CASCADES;
      delete defines.CSM_FADE;
    }
    entry.csm = false;
    material.needsUpdate = true;
  }

  private teardown(): void {
    if (this.csm) {
      const csm = this.csm;
      csm.remove();
      // Removes CSM defines + its own onBeforeCompile from all materials it set up.
      csm.dispose();
      for (const light of csm.lights) light.dispose();
      this.csm = null;
      for (const [material, entry] of this.registry) this.uninstallCsm(material, entry);
    }
    if (this.plainLight) {
      this.scene.remove(this.plainLight.target);
      this.scene.remove(this.plainLight);
      this.plainLight.dispose();
      this.plainLight = null;
    }
    this.lastFov = -1;
    this.lastAspect = -1;
  }
}
