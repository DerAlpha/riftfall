/**
 * Rift Forge looks on a weapon viewmodel (defs/forge.ts FORGE_LOOKS), applied per model by the
 * rig whenever the shown weapon's tier or attachments change:
 * - body materials (gunmetal, dark metal, polymer, energy-weapon ceramic / chitin shells) and
 *   accent paint are swapped for per-look variants (cloned once per source material and look:
 *   tinted, glossier, recolored paint); looks with a camo get the animated rift camo patch –
 *   domain-warped value noise thresholded into glowing veins over a darkened base, in the mesh's
 *   own space (the pattern rides on moving parts). One program per base material type, shared by
 *   every camo look (the look's numbers are uniforms), compiled at boot (warmupMeshes),
 * - per-model emissive materials are recolored in place: accent strips (look accent), heat vents
 *   (look heat) and the energy volumes' core / rim colors (towards the accent),
 * - the scope depth masks and every material without a role stay untouched.
 * Restoring (tier 0) puts the source materials / colors back. Nothing allocates per frame; the
 * camo animates through one shared time uniform (`time`).
 */
import {
  Color,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { clamp01 } from '../../../core/math';
import { FORGE_LOOKS, type ForgeCamoDef, type ForgeLookDef } from '../../../defs/forge';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { FORGE_VIEW, OUTFIT_MATERIALS } from '../../../defs/weaponOutfit';

export type MaterialRole = 'body' | 'paint' | 'accent' | 'heat' | 'energy' | 'readout' | 'none';

/** The role of a weapon material by its name (OUTFIT_MATERIALS). */
export function materialRole(name: string): MaterialRole {
  const R = OUTFIT_MATERIALS;
  if (R.skip.includes(name)) return 'none';
  if (R.body.includes(name) || R.bodyPrefixes.some((p) => name.startsWith(p))) return 'body';
  if (R.paint.includes(name)) return 'paint';
  if (name === R.accent || name === 'vm-att-accent') return 'accent';
  if (name === R.heat) return 'heat';
  if (name === R.readout) return 'readout';
  if (name.startsWith(R.energyPrefix)) return 'energy';
  return 'none';
}

/** Program cache key of every camo variant (the look's values are uniforms). */
export const CAMO_PROGRAM_KEY = 'forge-camo-1';
/** Program cache key of the patched readouts (the tint is a uniform, 0 = the weapon's own colors). */
export const READOUT_PROGRAM_KEY = 'forge-readout-1';

/**
 * Readout recolor: lit "on" texels (the cyan of VIEWMODEL_ART.emissive.readoutOn) take the look's
 * readout color; low / empty (amber / red) and dark segments stay as they are.
 */
const READOUT_FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uReadoutTint;
uniform float uReadoutMix;
`;

const READOUT_EMISSIVE = /* glsl */ `
#ifdef USE_EMISSIVEMAP
{
  vec3 rt = texture2D(emissiveMap, vEmissiveMapUv).rgb;
  float onMask = clamp((min(rt.g, rt.b) - rt.r) * 2.0, 0.0, 1.0) * uReadoutMix;
  totalEmissiveRadiance = mix(totalEmissiveRadiance, emissive * uReadoutTint * max(rt.g, rt.b), onMask);
}
#endif
`;

/** Patch a readout material (in place) so a forge look can recolor its lit segments. */
export function patchReadoutShader(
  shader: Pick<WebGLProgramParametersWithUniforms, 'fragmentShader' | 'uniforms'>,
  uniforms: Uniforms,
): void {
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${READOUT_FRAGMENT_HEAD}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${READOUT_EMISSIVE}`);
}

const CAMO_VERTEX_HEAD = /* glsl */ `
varying vec3 vCamoPos;
`;

const CAMO_FRAGMENT_HEAD = /* glsl */ `
uniform float uCamoTime;
uniform float uCamoScale;
uniform float uCamoSpeed;
uniform float uCamoWarp;
uniform float uCamoCoverage;
uniform vec3 uCamoBase;
uniform vec3 uCamoVein;
uniform vec3 uCamoShift;
uniform float uCamoVeinIntensity;
uniform float uCamoWidth;
uniform float uCamoSharp;
uniform float uCamoPulseRate;
uniform float uCamoPulseDepth;
uniform float uCamoBaseMix;
uniform float uCamoShiftRate;
varying vec3 vCamoPos;
float camoVein;
float camoHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float camoNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(camoHash(i), camoHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(camoHash(i + vec3(0.0, 1.0, 0.0)), camoHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(camoHash(i + vec3(0.0, 0.0, 1.0)), camoHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(camoHash(i + vec3(0.0, 1.0, 1.0)), camoHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

const CAMO_COLOR = /* glsl */ `
{
  vec3 cp = vCamoPos * uCamoScale;
  float ct = uCamoTime * uCamoSpeed;
  vec3 cw = vec3(
    camoNoise(cp + vec3(0.0, ct, 0.0)),
    camoNoise(cp + vec3(17.3, -ct, 3.1)),
    camoNoise(cp + vec3(-5.7, 9.2, ct))) - 0.5;
  float cn = camoNoise(cp + cw * uCamoWarp * 2.0 + vec3(ct * 0.6));
  float cov = camoNoise(vCamoPos * uCamoScale * 0.31 + vec3(4.1, 1.7, 2.9));
  float cmask = uCamoCoverage >= 0.999 ? 1.0 : smoothstep(0.92 - uCamoCoverage, 1.08 - uCamoCoverage, cov);
  camoVein = pow(clamp(1.0 - abs(cn - 0.5) / max(uCamoWidth, 1e-3), 0.0, 1.0), uCamoSharp) * cmask;
  vec3 cbase = uCamoBase;
  #ifdef USE_COLOR
  cbase *= 0.6 + 0.4 * vColor.r;
  #endif
  diffuseColor.rgb = mix(diffuseColor.rgb, cbase, cmask * uCamoBaseMix);
}
`;

const CAMO_EMISSIVE = /* glsl */ `
{
  float cpulse = 1.0 + uCamoPulseDepth * sin(uCamoTime * uCamoPulseRate + vCamoPos.x * 7.0 + vCamoPos.y * 5.0);
  vec3 cvein = mix(uCamoVein, uCamoShift, 0.5 + 0.5 * sin(uCamoTime * uCamoShiftRate + vCamoPos.z * 11.0));
  totalEmissiveRadiance += cvein * camoVein * uCamoVeinIntensity * cpulse;
}
`;

type Uniforms = Record<string, { value: unknown }>;

function camoUniforms(c: ForgeCamoDef, time: { value: number }): Uniforms {
  return {
    uCamoTime: time,
    uCamoScale: { value: c.scale },
    uCamoSpeed: { value: c.speed },
    uCamoWarp: { value: c.warp },
    uCamoCoverage: { value: c.coverage },
    uCamoBase: { value: new Color(c.base) },
    uCamoVein: { value: new Color(c.vein) },
    uCamoShift: { value: new Color(c.veinShift) },
    uCamoVeinIntensity: { value: c.veinIntensity },
    uCamoWidth: { value: c.veinWidth },
    uCamoSharp: { value: c.sharpness },
    uCamoPulseRate: { value: c.pulseRate },
    uCamoPulseDepth: { value: c.pulseDepth },
    uCamoBaseMix: { value: FORGE_VIEW.camoBaseMix },
    uCamoShiftRate: { value: FORGE_VIEW.camoShiftRate },
  };
}

/** Patch a standard / physical material's shaders with the camo (in place). */
export function patchCamoShader(
  shader: Pick<WebGLProgramParametersWithUniforms, 'vertexShader' | 'fragmentShader' | 'uniforms'>,
  uniforms: Uniforms,
): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${CAMO_VERTEX_HEAD}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamoPos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${CAMO_FRAGMENT_HEAD}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${CAMO_COLOR}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${CAMO_EMISSIVE}`);
}

interface ColorBackup {
  emissive?: number;
  core?: Color;
  rim?: Color;
}

const _c = new Color();
const _w = new Color();
const WHITE = new Color(1, 1, 1);

export class ForgeLookApplier {
  /** Shared camo clock (seconds), advanced by the rig every frame. */
  readonly time = { value: 0 };
  private readonly variants = new Map<Material, Map<string, Material>>();
  private readonly backups = new Map<Material, ColorBackup>();
  private warmGeometry: PlaneGeometry | null = null;

  /**
   * Patch the model's readout materials once (before the warm-up compile): a look can then recolor
   * their lit segments through uniforms only.
   */
  prepare(root: Object3D): void {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const m = mesh.material as Material;
      if (materialRole(m.name) !== 'readout' || m.userData.readoutUniforms) return;
      const uniforms: Uniforms = { uReadoutTint: { value: new Color(1, 1, 1) }, uReadoutMix: { value: 0 } };
      m.userData.readoutUniforms = uniforms;
      m.onBeforeCompile = (shader) => patchReadoutShader(shader, uniforms);
      m.customProgramCacheKey = () => READOUT_PROGRAM_KEY;
      m.needsUpdate = true;
    });
  }

  /**
   * Apply `look` to every mesh under `root` (null restores the weapon's own look). Returns the
   * accent material found (the rig scales its intensity per frame), or null.
   */
  apply(root: Object3D, look: ForgeLookDef | null | undefined): MeshStandardMaterial | null {
    let accent: MeshStandardMaterial | null = null;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const base = (mesh.userData.forgeBase as Material | undefined) ?? (mesh.material as Material);
      const role = materialRole(base.name);
      switch (role) {
        case 'body':
        case 'paint':
          if (look) {
            mesh.userData.forgeBase = base;
            mesh.material = this.variant(base, look, role);
          } else {
            mesh.material = base;
            delete mesh.userData.forgeBase;
          }
          break;
        case 'accent':
          accent = base as MeshStandardMaterial;
          this.recolorEmissive(accent, look?.accent);
          break;
        case 'heat':
          this.recolorEmissive(base as MeshStandardMaterial, look?.heat);
          break;
        case 'energy':
          this.tintEnergy(base, look?.accent);
          break;
        case 'readout':
          this.tintReadout(base, look?.readout);
          break;
        default:
          break;
      }
    });
    return accent;
  }

  /**
   * Meshes carrying one camo variant of every body material under `roots` (for a shader
   * warm-up compile); the variants stay cached, so the first forged weapon never compiles.
   */
  warmupMeshes(roots: readonly Object3D[]): Mesh[] {
    const look = firstCamoLook();
    if (!look) return [];
    this.warmGeometry ??= new PlaneGeometry(1e-3, 1e-3);
    const seen = new Set<Material>();
    const out: Mesh[] = [];
    for (const root of roots) {
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const base = (mesh.userData.forgeBase as Material | undefined) ?? (mesh.material as Material);
        if (seen.has(base) || materialRole(base.name) !== 'body') return;
        seen.add(base);
        out.push(new Mesh(this.warmGeometry!, this.variant(base, look, 'body')));
      });
    }
    return out;
  }

  dispose(): void {
    for (const perLook of this.variants.values()) for (const m of perLook.values()) m.dispose();
    this.variants.clear();
    this.backups.clear();
    this.warmGeometry?.dispose();
    this.warmGeometry = null;
  }

  // -------------------------------------------------------------------------

  private variant(base: Material, look: ForgeLookDef, role: 'body' | 'paint'): Material {
    let perLook = this.variants.get(base);
    if (!perLook) {
      perLook = new Map();
      this.variants.set(base, perLook);
    }
    const hit = perLook.get(look.id);
    if (hit) return hit;
    const m = base.clone() as MeshStandardMaterial;
    m.name = `${base.name}#${look.id}`;
    if (role === 'paint') {
      m.color.set(look.paint);
    } else {
      m.color.multiply(_c.set(look.bodyTint));
      m.roughness = clamp01(m.roughness * look.roughnessScale);
      m.metalness = clamp01(m.metalness + look.metalnessOffset);
      const camo = look.camo;
      if (camo) {
        const uniforms = camoUniforms(camo, this.time);
        m.onBeforeCompile = (shader) => patchCamoShader(shader, uniforms);
        m.customProgramCacheKey = () => CAMO_PROGRAM_KEY;
      }
    }
    perLook.set(look.id, m);
    return m;
  }

  private recolorEmissive(m: MeshStandardMaterial, hex: number | undefined): void {
    if (!m.emissive) return;
    let b = this.backups.get(m);
    if (!b) {
      b = { emissive: m.emissive.getHex() };
      this.backups.set(m, b);
    }
    if (hex === undefined) m.emissive.setHex(b.emissive!);
    else m.emissive.set(hex);
  }

  private tintReadout(m: Material, rgb: readonly [number, number, number] | undefined): void {
    const u = m.userData.readoutUniforms as Uniforms | undefined;
    if (!u) return;
    (u.uReadoutMix as { value: number }).value = rgb ? 1 : 0;
    if (!rgb) return;
    const tint = u.uReadoutTint!.value as Color;
    tint.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
    // As bright as the cyan it replaces (the readout intensities are tuned for it).
    const on = VIEWMODEL_ART.emissive.readoutOn;
    const ref = _c.setRGB(on[0] / 255, on[1] / 255, on[2] / 255, SRGBColorSpace);
    const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const l = lum(tint);
    if (l > 0) tint.multiplyScalar(Math.max(1, lum(ref) / l) / Math.max(ref.g, ref.b));
  }

  private tintEnergy(m: Material, accentHex: number | undefined): void {
    const u = (m as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
    const core = u?.uCore?.value;
    const rim = u?.uRim?.value;
    if (!(core instanceof Color) || !(rim instanceof Color)) return;
    let b = this.backups.get(m);
    if (!b) {
      b = { core: core.clone(), rim: rim.clone() };
      this.backups.set(m, b);
    }
    core.copy(b.core!);
    rim.copy(b.rim!);
    if (accentHex === undefined) return;
    const k = FORGE_VIEW.energyTint;
    _c.set(accentHex);
    _w.copy(_c).lerp(WHITE, FORGE_VIEW.coreWhiten);
    core.lerp(_w, k);
    rim.lerp(_c, k);
  }
}

/** A look with a camo (the warm-up variant). */
function firstCamoLook(): ForgeLookDef | undefined {
  for (const id of Object.keys(FORGE_LOOKS)) {
    const look = FORGE_LOOKS[id];
    if (look?.camo) return look;
  }
  return undefined;
}
