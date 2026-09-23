/**
 * GPU-animated dust motes. All motion happens in the vertex shader from a shared time uniform
 * (drift + swirl + slow fall, wrapped inside the particle's spawn region), so the CPU never
 * touches the particles after creation. Motes light up inside registered light volumes
 * (spot cones and skylight shafts, passed as uniform arrays) – that is what sells the beams.
 *
 * The buffer is allocated once for the maximum count; quality changes only move the draw range.
 */
import * as THREE from 'three';
import { RENDER } from '../../defs/graphics';
import { DUST, type DustRegionDef } from '../../defs/level';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../postfx/fogShared';
import type { BoxVolume, ConeVolume, TimeUniform } from './VolumetricCone';

const VERTEX = /* glsl */ `
#define MAX_CONES ${DUST.maxCones}
#define MAX_BOXES ${DUST.maxBoxes}
attribute vec3 aBoxMin;
attribute vec3 aBoxSize;
attribute vec4 aRand;
uniform float uTime;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uViewportHeight;
uniform float uDrift;
uniform float uFall;
uniform float uSwirlAmp;
uniform float uSwirlFreq;
uniform float uTwinkle;
uniform float uBase;
uniform float uFadeDist;
uniform int uConeCount;
uniform vec4 uConeA[MAX_CONES];
uniform vec4 uConeB[MAX_CONES];
uniform vec4 uConeColor[MAX_CONES];
uniform int uBoxCount;
uniform vec3 uBoxOrigin[MAX_BOXES];
uniform mat3 uBoxInv[MAX_BOXES];
uniform vec3 uBoxColor[MAX_BOXES];
varying vec3 vColor;
varying float vAlpha;
${HEIGHT_FOG_GLSL}
void main() {
  float t = uTime * (0.6 + 0.8 * aRand.w);
  float ph = aRand.x * 6.2831853;
  vec3 drift = vec3(
    sin(t * uSwirlFreq + ph) * uSwirlAmp + t * uDrift * (aRand.y - 0.5),
    -t * uFall * (0.4 + aRand.z) + sin(t * uSwirlFreq * 1.3 + ph * 2.0) * uSwirlAmp * 0.4,
    cos(t * uSwirlFreq * 0.83 + ph * 1.7) * uSwirlAmp + t * uDrift * (aRand.x - 0.5)
  );
  vec3 local = mod(position - aBoxMin + drift, aBoxSize);
  vec3 wp = aBoxMin + local;

  vec3 light = vec3(uBase);
  for (int i = 0; i < MAX_CONES; i++) {
    if (i >= uConeCount) break;
    vec3 rel = wp - uConeA[i].xyz;
    float h = dot(rel, uConeB[i].xyz);
    float r = length(rel - uConeB[i].xyz * h);
    float R = uConeColor[i].w + max(h, 0.0) * uConeB[i].w;
    float along = step(0.0, h) * (1.0 - smoothstep(uConeA[i].w * 0.7, uConeA[i].w, h));
    float radial = 1.0 - smoothstep(R * 0.55, R, r);
    light += uConeColor[i].rgb * along * radial;
  }
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uBoxCount) break;
    vec3 lp = uBoxInv[i] * (wp - uBoxOrigin[i]);
    vec3 e = smoothstep(vec3(0.0), vec3(0.12), lp) * smoothstep(vec3(0.0), vec3(0.12), vec3(1.0) - lp);
    light += uBoxColor[i] * (e.x * e.y * e.z);
  }

  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float dist = max(-mv.z, 0.01);
  float size = mix(uSizeMin, uSizeMax, aRand.y);
  float px = size * projectionMatrix[1][1] * 0.5 * uViewportHeight / dist;
  // Sub-pixel motes fade instead of shrinking further (avoids shimmering).
  float coverage = clamp(px / uMinPx, 0.0, 1.0);
  float twinkle = 0.6 + 0.4 * sin(uTime * uTwinkle * (0.5 + aRand.z) + aRand.x * 40.0);
  float fade = 1.0 - smoothstep(uFadeDist * 0.6, uFadeDist, dist);
  vColor = light * twinkle * fogTransmittance(cameraPosition, (modelMatrix * vec4(wp, 1.0)).xyz);
  vAlpha = coverage * coverage * fade;
  gl_PointSize = clamp(px, uMinPx, uMaxPx);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.5) * (1.0 - smoothstep(0.7, 1.0, d)) * vAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const _vp = new THREE.Vector4();

/** Tiny deterministic PRNG (cosmetic only, keeps layouts identical between runs). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Axis-aligned spawn region around a cone volume (both end discs), cut `floorLift` above the cone's
 * end point so no motes are wasted below the surface it lands on. Null if nothing is left.
 */
export function coneDustRegion(v: ConeVolume, share: number, floorLift: number): DustRegionDef | null {
  const r0 = v.apexRadius;
  const r1 = v.apexRadius + v.length * v.tanAngle;
  const a = v.axis;
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  const apex = [v.apex.x, v.apex.y, v.apex.z] as const;
  const dir = [a.x, a.y, a.z] as const;
  for (let i = 0; i < 3; i++) {
    // Half extent of a disc with normal `axis` along world axis i.
    const e = Math.sqrt(Math.max(0, 1 - dir[i]! * dir[i]!));
    const p0 = apex[i]!;
    const p1 = apex[i]! + dir[i]! * v.length;
    min[i] = Math.min(p0 - r0 * e, p1 - r1 * e);
    max[i] = Math.max(p0 + r0 * e, p1 + r1 * e);
  }
  const endY = v.apex.y + a.y * v.length;
  min[1] = Math.max(min[1], endY + floorLift);
  if (!(max[0] > min[0] && max[1] > min[1] && max[2] > min[2]) || !(share > 0)) return null;
  return { min, max, share };
}

/** Volume (m³) of a cone volume (a truncated cone: apex radius > 0). */
export function coneVolumeM3(v: ConeVolume): number {
  const r0 = v.apexRadius;
  const r1 = v.apexRadius + v.length * v.tanAngle;
  return (Math.PI / 3) * v.length * (r0 * r0 + r0 * r1 + r1 * r1);
}

/**
 * Ambient regions scaled to (1 - coneShare) plus one region per cone sharing `coneShare` by
 * volume. Without cones the ambient regions are returned unchanged.
 */
export function dustRegionsWithCones(
  ambient: readonly DustRegionDef[],
  cones: readonly ConeVolume[],
  coneShare: number,
  floorLift: number,
): DustRegionDef[] {
  const weights = cones.map(coneVolumeM3);
  const total = weights.reduce((s, w) => s + w, 0);
  const share = total > 0 ? Math.min(1, Math.max(0, coneShare)) : 0;
  const coneRegions: DustRegionDef[] = [];
  cones.forEach((c, i) => {
    const r = coneDustRegion(c, (share * weights[i]!) / total, floorLift);
    if (r) coneRegions.push(r);
  });
  if (coneRegions.length === 0) return [...ambient];
  const ambientTotal = ambient.reduce((s, r) => s + Math.max(0, r.share), 0);
  const scale = ambientTotal > 0 ? (1 - share) / ambientTotal : 0;
  return [...ambient.map((r) => ({ ...r, share: r.share * scale })), ...coneRegions];
}

/** Split a particle budget over regions by share (largest remainder, sums exactly to `count`). */
export function distributeCount(count: number, shares: readonly number[]): number[] {
  const total = shares.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0 || count <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (Math.max(0, s) / total) * count);
  const out = exact.map((v) => Math.floor(v));
  let rest = count - out.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k]!.i]!++;
  return out;
}

export interface DustOptions {
  regions: readonly DustRegionDef[];
  /** Allocated particle count (the draw range can only shrink below it). */
  maxCount: number;
  time: TimeUniform;
  seed?: number;
}

export class DustParticles {
  readonly points: THREE.Points;
  readonly maxCount: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  /** Order of particles is shuffled across regions so a shorter draw range keeps every region populated. */
  private count: number;

  constructor(opts: DustOptions) {
    const max = Math.max(0, Math.floor(opts.maxCount));
    this.maxCount = max;
    this.count = max;
    const rand = mulberry32(opts.seed ?? 1337);
    const counts = distributeCount(
      max,
      opts.regions.map((r) => r.share),
    );
    const regionOf: number[] = [];
    counts.forEach((c, i) => {
      for (let k = 0; k < c; k++) regionOf.push(i);
    });
    // Fisher-Yates so any prefix of the buffer samples all regions proportionally.
    for (let i = regionOf.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = regionOf[i]!;
      regionOf[i] = regionOf[j]!;
      regionOf[j] = t;
    }

    const pos = new Float32Array(max * 3);
    const boxMin = new Float32Array(max * 3);
    const boxSize = new Float32Array(max * 3);
    const rnd = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) {
      const r = opts.regions[regionOf[i]!]!;
      for (let a = 0; a < 3; a++) {
        const lo = Math.min(r.min[a]!, r.max[a]!);
        const size = Math.max(0.01, Math.abs(r.max[a]! - r.min[a]!));
        boxMin[i * 3 + a] = lo;
        boxSize[i * 3 + a] = size;
        pos[i * 3 + a] = lo + rand() * size;
      }
      for (let a = 0; a < 4; a++) rnd[i * 4 + a] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBoxMin', new THREE.BufferAttribute(boxMin, 3));
    geo.setAttribute('aBoxSize', new THREE.BufferAttribute(boxSize, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    geo.computeBoundingSphere();
    this.geometry = geo;

    const coneA: THREE.Vector4[] = [];
    const coneB: THREE.Vector4[] = [];
    const coneColor: THREE.Vector4[] = [];
    for (let i = 0; i < DUST.maxCones; i++) {
      coneA.push(new THREE.Vector4());
      coneB.push(new THREE.Vector4());
      coneColor.push(new THREE.Vector4());
    }
    const boxOrigin: THREE.Vector3[] = [];
    const boxInv: THREE.Matrix3[] = [];
    const boxColor: THREE.Vector3[] = [];
    for (let i = 0; i < DUST.maxBoxes; i++) {
      boxOrigin.push(new THREE.Vector3());
      boxInv.push(new THREE.Matrix3());
      boxColor.push(new THREE.Vector3());
    }

    this.material = new THREE.ShaderMaterial({
      name: 'DustParticles',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: opts.time,
        uSizeMin: { value: DUST.sizeMin },
        uSizeMax: { value: DUST.sizeMax },
        uMinPx: { value: DUST.minPixelSize },
        uMaxPx: { value: DUST.maxPixelSize },
        uViewportHeight: { value: 1080 },
        uDrift: { value: DUST.driftSpeed },
        uFall: { value: DUST.fallSpeed },
        uSwirlAmp: { value: DUST.swirlAmplitude },
        uSwirlFreq: { value: DUST.swirlFrequency },
        uTwinkle: { value: DUST.twinkleRate },
        uBase: { value: DUST.baseBrightness },
        uFadeDist: { value: DUST.fadeDistance },
        uConeCount: { value: 0 },
        uConeA: { value: coneA },
        uConeB: { value: coneB },
        uConeColor: { value: coneColor },
        uBoxCount: { value: 0 },
        uBoxOrigin: { value: boxOrigin },
        uBoxInv: { value: boxInv },
        uBoxColor: { value: boxColor },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });

    const points = new THREE.Points(geo, this.material);
    points.name = 'DustParticles';
    // Particles wrap inside their regions; the static bounds are fine but culling buys nothing.
    points.frustumCulled = false;
    points.renderOrder = 11;
    // Drawn by the post chain after AO and fog (RENDER.volumetricLayer), fogged in the shader.
    points.layers.set(RENDER.volumetricLayer);
    points.matrixAutoUpdate = false;
    points.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_vp);
      (this.material.uniforms.uViewportHeight as THREE.IUniform<number>).value = Math.max(1, _vp.w);
    };
    this.points = points;
  }

  /** Visible particle count (clamped to the allocated maximum). */
  setCount(n: number): void {
    this.count = Math.max(0, Math.min(this.maxCount, Math.floor(n)));
    this.geometry.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
  }

  get visibleCount(): number {
    return this.count;
  }

  /**
   * Register light volumes (copied into the uniform arrays; extra volumes beyond the shader limits
   * are ignored). Call again after changing volume colors (flicker) – cheap, no allocation.
   */
  setVolumes(cones: readonly ConeVolume[], boxes: readonly BoxVolume[]): void {
    const u = this.material.uniforms;
    const coneA = u.uConeA!.value as THREE.Vector4[];
    const coneB = u.uConeB!.value as THREE.Vector4[];
    const coneColor = u.uConeColor!.value as THREE.Vector4[];
    const nc = Math.min(cones.length, DUST.maxCones);
    for (let i = 0; i < nc; i++) {
      const c = cones[i]!;
      coneA[i]!.set(c.apex.x, c.apex.y, c.apex.z, c.length);
      coneB[i]!.set(c.axis.x, c.axis.y, c.axis.z, c.tanAngle);
      coneColor[i]!.set(
        c.color.r * DUST.volumeBrightness,
        c.color.g * DUST.volumeBrightness,
        c.color.b * DUST.volumeBrightness,
        c.apexRadius,
      );
    }
    (u.uConeCount as THREE.IUniform<number>).value = nc;

    const boxOrigin = u.uBoxOrigin!.value as THREE.Vector3[];
    const boxInv = u.uBoxInv!.value as THREE.Matrix3[];
    const boxColor = u.uBoxColor!.value as THREE.Vector3[];
    const nb = Math.min(boxes.length, DUST.maxBoxes);
    for (let i = 0; i < nb; i++) {
      const b = boxes[i]!;
      boxOrigin[i]!.copy(b.origin);
      boxInv[i]!.copy(b.inverse);
      boxColor[i]!.set(
        b.color.r * DUST.volumeBrightness,
        b.color.g * DUST.volumeBrightness,
        b.color.b * DUST.volumeBrightness,
      );
    }
    (u.uBoxCount as THREE.IUniform<number>).value = nb;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
