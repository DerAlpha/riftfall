/**
 * Material library wrapper for the research lab: resolves `<baseId>#<variant>` ids (LAB_MATERIALS)
 * to tinted clones of the shared base materials and delegates everything else to the game's
 * MaterialLibrary. Clones share the base's textures (no extra GPU memory, no extra generator
 * work); when the base swaps its maps (texture quality change) the clones follow on the next
 * update(). Two variants carry an animated emissive shader patch (server LEDs, specimen fluid).
 *
 * Variants without any override (navIgnore aliases) return the base material itself.
 */
import * as THREE from 'three';
import type { MaterialLibraryApi } from '../../core/contracts';
import { createLogger } from '../../core/log';
import { LAB_EFFECTS, LAB_MATERIALS, type LabMaterialVariantDef } from '../../defs/labLayout';
import { baseMaterialId } from '../../world/LevelKit';

const log = createLogger('LabMaterials');

export function labVariantDef(id: string): LabMaterialVariantDef | undefined {
  return Object.prototype.hasOwnProperty.call(LAB_MATERIALS, id)
    ? (LAB_MATERIALS as Record<string, LabMaterialVariantDef>)[id]
    : undefined;
}

/** Meshes built from this (variant) material id stay out of the navmesh. */
export function isNavIgnoredMaterial(id: string): boolean {
  return labVariantDef(id)?.navIgnore === true;
}

/** True when the variant changes nothing visual (it is only a bucket / nav marker). */
export function isAliasVariant(def: LabMaterialVariantDef): boolean {
  return (
    def.tint === undefined &&
    def.roughness === undefined &&
    def.metalness === undefined &&
    def.envMapIntensity === undefined &&
    def.emissive === undefined &&
    def.emissiveIntensity === undefined &&
    def.opacity === undefined &&
    def.effect === undefined
  );
}

const HASH_GLSL = /* glsl */ `
float labHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const LED_FRAGMENT = /* glsl */ `
{
  vec2 g = vLabUv * uLedDensity;
  vec2 cell = floor(g);
  float fx = fract(g.x) - 0.5;
  float h = labHash(cell);
  float rate = mix(uLedRate.x, uLedRate.y, labHash(cell + 17.31));
  float blink = step(fract(uLabTime * rate + h * 7.13), uLedDuty);
  float smoothOn = 0.5 + 0.5 * sin((uLabTime * uLedReducedRate + h) * 6.2831853);
  float on = mix(blink, smoothOn, uLabReduce);
  float dotMask = 1.0 - smoothstep(uLedDot * 0.55, uLedDot, abs(fx));
  float pick = labHash(cell + 3.7);
  vec3 col = pick < 0.34 ? uLedPalette[0] : pick < 0.6 ? uLedPalette[1] : pick < 0.8 ? uLedPalette[2]
    : pick < 0.93 ? uLedPalette[3] : uLedPalette[4];
  totalEmissiveRadiance *= mix(vec3(uLedBackground), col * mix(uLedOff, 1.0, on), dotMask);
}
`;

const FLUID_FRAGMENT = /* glsl */ `
{
  float wave = 0.5 + 0.5 * sin(vLabUv.y * uFluidWave.x - uLabTime * uFluidWave.y + sin(vLabUv.x * 2.1) * 1.3);
  float glow = 1.0 - uFluidWave.z + uFluidWave.z * wave;
  vec2 bg = vec2(vLabUv.x * uBubbleCells.x, vLabUv.y * uBubbleCells.y - uLabTime * uBubble.x);
  vec2 bc = floor(bg);
  vec2 bf = fract(bg) - 0.5;
  float bh = labHash(bc);
  vec2 off = vec2(bh - 0.5, labHash(bc + 9.1) - 0.5) * 0.5;
  float bubble = (1.0 - smoothstep(uBubble.y * 0.5, uBubble.y, length(bf - off))) * step(0.55, bh);
  totalEmissiveRadiance *= glow + bubble * uBubble.z;
}
`;

/** Bit mask of the texture maps a material has (program-relevant). */
export function mapMask(m: THREE.MeshStandardMaterial): number {
  return (
    (m.map ? 1 : 0) |
    (m.normalMap ? 2 : 0) |
    (m.aoMap ? 4 : 0) |
    (m.roughnessMap ? 8 : 0) |
    (m.metalnessMap ? 16 : 0) |
    (m.emissiveMap ? 32 : 0)
  );
}

interface Variant {
  id: string;
  base: THREE.MeshStandardMaterial;
  material: THREE.MeshStandardMaterial;
}

export class LabMaterials implements MaterialLibraryApi {
  /** Shared animation uniforms of the effect variants. */
  readonly time: THREE.IUniform<number> = { value: 0 };
  private readonly reduce: THREE.IUniform<number> = { value: 0 };
  private readonly variants = new Map<string, Variant>();
  /** Clones follow the base's texture maps (they may arrive or change after the clone). */
  private readonly synced: Variant[] = [];
  private readonly warned = new Set<string>();

  constructor(
    private readonly base: MaterialLibraryApi,
    private readonly setupMaterial?: (m: THREE.Material) => void,
  ) {}

  get(id: string): THREE.MeshStandardMaterial {
    if (id.indexOf('#') < 0) return this.base.get(id);
    const existing = this.variants.get(id);
    if (existing) return existing.material;
    const baseMat = this.base.get(baseMaterialId(id));
    const def = labVariantDef(id);
    if (!def) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        log.warn(`Unknown material variant "${id}" – using its base material`);
      }
      return baseMat;
    }
    if (isAliasVariant(def)) return baseMat;
    const mat = this.createVariant(id, baseMat, def);
    const v: Variant = { id, base: baseMat, material: mat };
    this.variants.set(id, v);
    this.synced.push(v);
    return mat;
  }

  /** Preloads the base materials of all (variant) ids. */
  preload(ids: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.base.preload([...new Set(ids.map(baseMaterialId))], onProgress);
  }

  /** Per frame: effect time and texture maps swapped by the base (quality changes). No allocation. */
  update(time: number): void {
    this.time.value = time;
    for (let i = 0; i < this.synced.length; i++) {
      const v = this.synced[i]!;
      const b = v.base;
      const m = v.material;
      if (
        m.map === b.map &&
        m.normalMap === b.normalMap &&
        m.aoMap === b.aoMap &&
        m.roughnessMap === b.roughnessMap &&
        m.metalnessMap === b.metalnessMap &&
        m.emissiveMap === b.emissiveMap
      )
        continue;
      // A map appearing / disappearing changes the program (USE_*MAP defines): recompile.
      const had = mapMask(m);
      m.map = b.map;
      m.normalMap = b.normalMap;
      m.aoMap = b.aoMap;
      m.roughnessMap = b.roughnessMap;
      m.metalnessMap = b.metalnessMap;
      m.emissiveMap = b.emissiveMap;
      if (mapMask(m) !== had) m.needsUpdate = true;
    }
  }

  /** Accessibility "reduce flashing": blinking LEDs fade smoothly instead. */
  setReducedFlashing(on: boolean): void {
    this.reduce.value = on ? 1 : 0;
  }

  /** Disposes the variant clones only (the base library belongs to the game). */
  dispose(): void {
    for (const v of this.variants.values()) v.material.dispose();
    this.variants.clear();
    this.synced.length = 0;
  }

  private createVariant(
    id: string,
    baseMat: THREE.MeshStandardMaterial,
    def: LabMaterialVariantDef,
  ): THREE.MeshStandardMaterial {
    // clone() copies maps and parameters but not the CSM hooks: the copy is registered below.
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
    if (def.effect) this.installEffect(m, def.effect);
    this.setupMaterial?.(m);
    return m;
  }

  private installEffect(m: THREE.MeshStandardMaterial, effect: 'led' | 'fluid'): void {
    const time = this.time;
    const reduce = this.reduce;
    const L = LAB_EFFECTS.led;
    const F = LAB_EFFECTS.fluid;
    const uniforms: Record<string, THREE.IUniform> =
      effect === 'led'
        ? {
            uLabTime: time,
            uLabReduce: reduce,
            uLedDensity: { value: new THREE.Vector2(L.density[0], L.density[1]) },
            uLedRate: { value: new THREE.Vector2(L.rateMin, L.rateMax) },
            uLedDuty: { value: L.duty },
            uLedReducedRate: { value: L.reducedRate },
            uLedDot: { value: L.dotRadius },
            uLedOff: { value: L.offLevel },
            uLedBackground: { value: L.background },
            uLedPalette: {
              value: L.palette.map((c) =>
                new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace),
              ),
            },
          }
        : {
            uLabTime: time,
            uFluidWave: { value: new THREE.Vector3(F.waveScale, F.waveSpeed, F.waveAmount) },
            uBubbleCells: { value: new THREE.Vector2(F.bubbleCells[0], F.bubbleCells[1]) },
            uBubble: { value: new THREE.Vector3(F.bubbleSpeed, F.bubbleRadius, F.bubbleBoost) },
          };
    const decl =
      effect === 'led'
        ? /* glsl */ `uniform float uLabTime;
uniform float uLabReduce;
uniform vec2 uLedDensity;
uniform vec2 uLedRate;
uniform float uLedDuty;
uniform float uLedReducedRate;
uniform float uLedDot;
uniform float uLedOff;
uniform float uLedBackground;
uniform vec3 uLedPalette[${L.palette.length}];`
        : /* glsl */ `uniform float uLabTime;
uniform vec3 uFluidWave;
uniform vec2 uBubbleCells;
uniform vec3 uBubble;`;
    const body = effect === 'led' ? LED_FRAGMENT : FLUID_FRAGMENT;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLabUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vLabUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vLabUv;\n${decl}\n${HASH_GLSL}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${body}`);
    };
    m.customProgramCacheKey = () => `lab-${effect}-v1`;
  }
}
