/**
 * Noise-threshold dissolve for lit materials (dying enemies, training dummies).
 *
 * `applyDissolve()` patches a MeshStandardMaterial (or Physical) through onBeforeCompile: object-space
 * 3D value noise (2 octaves, optionally blended with a directional sweep) is compared with the
 * `uDissolve` threshold – fragments below it are discarded, a thin band above it glows (HDR
 * emissive, blooms). Everything is driven by uniforms, so animating the effect never recompiles:
 * at progress 0 the shader is a no-op apart from the noise evaluation. Materials patched here share
 * one program per base shader (constant customProgramCacheKey); each material still gets its own
 * uniform values (three calls onBeforeCompile per material).
 *
 * Shadows: attach `createDissolveDepthMaterial()` / `createDissolveDistanceMaterial()` as the mesh's
 * customDepthMaterial / customDistanceMaterial so the shadow dissolves with the surface.
 *
 * Call order with cascaded shadows: applyDissolve() FIRST, then RenderApi.setupMaterial() – the
 * shadow system chains a pre-existing onBeforeCompile and keeps its cache key.
 */
import { Color, MeshDepthMaterial, MeshDistanceMaterial, Vector3, Vector4 } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { createLogger } from '../../core/log';

const log = createLogger('Dissolve');

/** Bump when the injected GLSL changes (program cache key). */
export const DISSOLVE_CACHE_KEY = 'rf-dissolve-1';

export interface DissolveOptions {
  /** Glowing band width in noise units (0..1). */
  edgeWidth: number;
  /** Linear RGB edge color; multiplied by `edgeIntensity` (HDR). */
  edgeColor: readonly [number, number, number];
  edgeIntensity: number;
  /** Noise frequency in 1/object-space-meter. */
  noiseScale: number;
  /**
   * Directional sweep: 0 = pure noise; 1 = a clean wipe along `sweepAxis`. The sweep value is
   * `dot(position, sweepAxis) + sweepOffset` clamped to 0..1 (0 dissolves first).
   */
  sweep: number;
  sweepAxis?: readonly [number, number, number];
  sweepOffset?: number;
  /** Per-object noise offset so identical meshes do not dissolve identically. */
  seed?: readonly [number, number, number];
}

export interface DissolveUniforms {
  /** 0 = solid, 1 = fully dissolved. */
  readonly uDissolve: { value: number };
  readonly uDissolveEdge: { value: number };
  /** HDR edge color (color × intensity). */
  readonly uDissolveColor: { value: Color };
  readonly uDissolveScale: { value: number };
  readonly uDissolveSeed: { value: Vector3 };
  /** xyz = sweep axis (pre-scaled by 1/extent), w = offset. */
  readonly uDissolveSweep: { value: Vector4 };
  readonly uDissolveSweepWeight: { value: number };
}

export function createDissolveUniforms(opts: DissolveOptions): DissolveUniforms {
  const u: DissolveUniforms = {
    uDissolve: { value: 0 },
    uDissolveEdge: { value: 0 },
    uDissolveColor: { value: new Color() },
    uDissolveScale: { value: 1 },
    uDissolveSeed: { value: new Vector3() },
    uDissolveSweep: { value: new Vector4(0, 1, 0, 0) },
    uDissolveSweepWeight: { value: 0 },
  };
  configureDissolve(u, opts);
  return u;
}

/** Re-apply options to existing uniforms (uniform writes only). */
export function configureDissolve(u: DissolveUniforms, opts: DissolveOptions): void {
  u.uDissolveEdge.value = Math.max(1e-4, opts.edgeWidth);
  setDissolveEdgeColor(u, opts.edgeColor, opts.edgeIntensity);
  u.uDissolveScale.value = opts.noiseScale;
  const s = opts.seed ?? [0, 0, 0];
  u.uDissolveSeed.value.set(s[0], s[1], s[2]);
  const a = opts.sweepAxis ?? [0, 1, 0];
  u.uDissolveSweep.value.set(a[0], a[1], a[2], opts.sweepOffset ?? 0);
  u.uDissolveSweepWeight.value = clamp01(opts.sweep);
}

export function setDissolveEdgeColor(
  u: DissolveUniforms,
  rgb: readonly [number, number, number],
  intensity: number,
): void {
  u.uDissolveColor.value.setRGB(rgb[0] * intensity, rgb[1] * intensity, rgb[2] * intensity);
}

/** Progress 0 (solid) … 1 (gone). Uniform write only. */
export function setDissolveProgress(u: DissolveUniforms, progress: number): void {
  u.uDissolve.value = Number.isFinite(progress) ? clamp01(progress) : 0;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const VERTEX_PARS = /* glsl */ `
varying vec3 vRfDissolvePos;
`;

const VERTEX_MAIN = /* glsl */ `
vRfDissolvePos = transformed;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vRfDissolvePos;
uniform float uDissolve;
uniform float uDissolveEdge;
uniform vec3 uDissolveColor;
uniform float uDissolveScale;
uniform vec3 uDissolveSeed;
uniform vec4 uDissolveSweep;
uniform float uDissolveSweepWeight;

float rfDissolveHash( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float rfDissolveNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( rfDissolveHash( i ), rfDissolveHash( i + vec3( 1, 0, 0 ) ), f.x ),
			mix( rfDissolveHash( i + vec3( 0, 1, 0 ) ), rfDissolveHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( rfDissolveHash( i + vec3( 0, 0, 1 ) ), rfDissolveHash( i + vec3( 1, 0, 1 ) ), f.x ),
			mix( rfDissolveHash( i + vec3( 0, 1, 1 ) ), rfDissolveHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
		f.z );
}

// Dissolve field in 0..1 (0 = goes first). Two octaves, contrast-stretched so thresholds progress evenly.
float rfDissolveField() {
	vec3 p = vRfDissolvePos * uDissolveScale + uDissolveSeed;
	float n = rfDissolveNoise( p ) * 0.65 + rfDissolveNoise( p * 2.13 + 17.0 ) * 0.35;
	n = clamp( ( n - 0.22 ) / 0.56, 0.0, 1.0 );
	float sweep = clamp( dot( vRfDissolvePos, uDissolveSweep.xyz ) + uDissolveSweep.w, 0.0, 1.0 );
	return mix( n, sweep * 0.85 + n * 0.15, uDissolveSweepWeight );
}
`;

/** Discard below the threshold. `rfDissolveD` (distance above it) feeds the emissive edge. */
const FRAGMENT_CLIP = /* glsl */ `
float rfDissolveD = 1.0;
if ( uDissolve > 0.0 ) {
	rfDissolveD = rfDissolveField() - uDissolve;
	if ( rfDissolveD < 0.0 || uDissolve >= 1.0 ) discard;
}
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
if ( uDissolve > 0.0 ) {
	totalEmissiveRadiance += uDissolveColor * ( 1.0 - smoothstep( 0.0, uDissolveEdge, rfDissolveD ) );
}
`;

const COMMON = '#include <common>';
const BEGIN_VERTEX = '#include <begin_vertex>';
const CLIP_FRAGMENT = '#include <clipping_planes_fragment>';
const EMISSIVE_FRAGMENT = '#include <emissivemap_fragment>';

function injectAfter(src: string, anchor: string, code: string): string | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const end = i + anchor.length;
  return src.slice(0, end) + '\n' + code + src.slice(end);
}

/** Vertex shader with the object-space position varying; null if the anchors are missing. */
export function patchDissolveVertex(src: string): string | null {
  const a = injectAfter(src, COMMON, VERTEX_PARS);
  return a === null ? null : injectAfter(a, BEGIN_VERTEX, VERTEX_MAIN);
}

/**
 * Fragment shader with the dissolve clip (and the HDR edge when `emissive`); null if the anchors
 * are missing (e.g. a future three.js renamed a chunk) – the caller then leaves the material as is.
 */
export function patchDissolveFragment(src: string, emissive: boolean): string | null {
  let out = injectAfter(src, COMMON, FRAGMENT_PARS);
  if (out !== null) out = injectAfter(out, CLIP_FRAGMENT, FRAGMENT_CLIP);
  if (out !== null && emissive) out = injectAfter(out, EMISSIVE_FRAGMENT, FRAGMENT_EMISSIVE);
  return out;
}

const warned = new Set<string>();

function install(material: Material, u: DissolveUniforms, emissive: boolean, key: string): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    const vs = patchDissolveVertex(shader.vertexShader);
    const fs = patchDissolveFragment(shader.fragmentShader, emissive);
    if (vs === null || fs === null) {
      if (!warned.has(material.type)) {
        warned.add(material.type);
        log.warn(`Dissolve: shader anchors missing in ${material.type} – effect disabled`);
      }
      return;
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    Object.assign(shader.uniforms, u);
  };
  material.customProgramCacheKey = (): string => key;
}

/**
 * Patch a lit material (MeshStandard/MeshPhysical) with the dissolve. Returns the material. Must
 * run before the first render of the material and before RenderApi.setupMaterial().
 */
export function applyDissolve<T extends Material>(material: T, uniforms: DissolveUniforms): T {
  install(material, uniforms, true, DISSOLVE_CACHE_KEY);
  material.needsUpdate = true;
  return material;
}

/** Shadow-map depth material (directional/spot lights) that dissolves with `uniforms`. */
export function createDissolveDepthMaterial(uniforms: DissolveUniforms): MeshDepthMaterial {
  const m = new MeshDepthMaterial();
  install(m, uniforms, false, `${DISSOLVE_CACHE_KEY}-depth`);
  return m;
}

/** Point-light shadow material that dissolves with `uniforms`. */
export function createDissolveDistanceMaterial(uniforms: DissolveUniforms): MeshDistanceMaterial {
  const m = new MeshDistanceMaterial();
  install(m, uniforms, false, `${DISSOLVE_CACHE_KEY}-distance`);
  return m;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
