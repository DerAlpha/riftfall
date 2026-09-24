/**
 * Rift portals: tears in space where the biomechanical creatures come through.
 *
 * - RiftPortalField: any number of small tears (spawn rifts on walls / floors / behind vents) in
 *   ONE instanced draw call. Per tear: placement (instance matrix), seed, pulse, brightness.
 *   Shader: lens-shaped slit whose outline is domain-warped fbm noise (torn, animated edges), HDR
 *   violet body with hot cyan filaments, a bright rim with a chromatic fringe (red outside, blue
 *   inside), a soft violet halo and a fade to the quad border.
 * - RiftPortal: the large anomaly (atrium centerpiece): a camera-facing vortex billboard (spiral
 *   arms, dark event horizon, chromatic ring, halo) + a cluster of crossed tear planes that slowly
 *   rotates and wobbles + GPU particles spiralling into the core + a pulsing violet point light.
 *
 * Everything is additive, depth-tested, never writes depth and lives on RENDER.volumetricLayer:
 * the post chain draws it after AO and height fog (VolumetricPass) and the shaders apply the fog
 * transmittance themselves. pulse(strength) flares a portal (spawn bursts, wave starts); pulses
 * decay exponentially. setReducedFlashing() scales the visible flare (accessibility). No
 * allocation after construction.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/events';
import { RENDER } from '../../defs/graphics';
import { RIFT_PORTAL } from '../../defs/labLayout';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../postfx/fogShared';
import type { TimeUniform } from './VolumetricCone';

const NOISE_GLSL = /* glsl */ `
float rpHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rpNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(rpHash(i), rpHash(i + vec2(1.0, 0.0)), u.x),
    mix(rpHash(i + vec2(0.0, 1.0)), rpHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float rpFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * rpNoise(p);
    p = p * 2.03 + vec2(17.1, 5.3);
    a *= 0.5;
  }
  return s * 1.0667;
}
`;

// ---------------------------------------------------------------------------
// Tear shader (instanced)
// ---------------------------------------------------------------------------

const TEAR_VERTEX = /* glsl */ `
attribute vec4 aTear; // seed, pulse, brightness, open multiplier
varying vec2 vP;
varying vec4 vTear;
varying float vFog;
${HEIGHT_FOG_GLSL}
void main() {
  // Local units are tear half-extents (the instance matrix scales them to meters): the tear itself
  // is |vP| <= 1, the quad spans ±uHaloScale for the halo.
  vP = position.xy;
  vTear = aTear;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TEAR_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uCore;
uniform vec3 uHot;
uniform vec3 uRim;
uniform vec3 uHalo;
uniform vec3 uFringeOuter;
uniform vec3 uFringeInner;
uniform vec4 uShape;   // open, profile exponent, warp, noise scale
uniform vec4 uShape2;  // jag, flow speed, breathe, breathe rate
uniform vec4 uLight;   // core, hot, rim intensity, rim sharpness
uniform vec4 uLight2;  // fringe width, fringe intensity, halo intensity, halo falloff
uniform vec2 uPulseK;  // pulse open, pulse intensity
uniform vec2 uHaloScale;
uniform float uIntensity;
uniform float uPulseScale; // reduce flashing
varying vec2 vP;
varying vec4 vTear;
varying float vFog;
${NOISE_GLSL}
void main() {
  float seed = vTear.x * 37.0;
  float pulse = vTear.y * uPulseScale;
  float t = uTime * uShape2.y;
  vec2 p = vP;
  // Domain warp: the whole tear wriggles.
  vec2 w = vec2(
    rpFbm(p * uShape.w * 0.5 + vec2(seed, t)),
    rpFbm(p * uShape.w * 0.5 + vec2(t * 0.7, seed + 4.1))
  );
  vec2 q = p + (w - 0.5) * uShape.z * 2.0;
  float breathe = 1.0 + uShape2.z * sin(uTime * uShape2.w * 6.2831853 + seed);
  float open = uShape.x * breathe * (1.0 + uPulseK.x * pulse) * vTear.w;
  float along = min(abs(q.y), 1.0);
  float profile = pow(max(1.0 - along * along, 0.0), uShape.y);
  // Torn outline: the half width and the center line both jitter along the tear.
  float jag = rpFbm(vec2(q.y * uShape.w * 2.0 + seed, t * 1.3)) - 0.5;
  float halfW = max(open * profile * (1.0 + jag * uShape2.x), 1e-3);
  float d = abs(q.x - jag * open * 0.35) / halfW;
  float tips = 1.0 - smoothstep(0.82, 1.0, along);

  float inside = (1.0 - smoothstep(0.8, 1.0, d)) * tips;
  float swirl = rpFbm(vec2(q.x * 2.5 / max(open, 0.05) + seed, q.y * uShape.w * 1.4 - t * 2.2));
  float filaments = pow(1.0 - abs(2.0 * swirl - 1.0), 6.0);
  vec3 body = uCore * uLight.x * (0.3 + 0.7 * swirl) + uHot * uLight.y * filaments * (1.0 - 0.6 * min(d, 1.0));

  float rim = exp(-abs(d - 1.0) * uLight.w);
  float fo = exp(-abs(d - 1.0 - uLight2.x) * uLight.w);
  float fi = exp(-abs(d - 1.0 + uLight2.x) * uLight.w);
  vec3 rimCol = (uRim * uLight.z * rim + (uFringeOuter * fo + uFringeInner * fi) * uLight2.y) * tips;

  vec2 hp = p / uHaloScale;
  float edge = max(abs(hp.x), abs(hp.y));
  float halo = exp(-uLight2.w * length(vec2(p.x * 0.55, p.y * 0.9))) * (0.65 + 0.35 * w.x);
  float border = 1.0 - smoothstep(0.6, 1.0, edge);

  vec3 col = body * inside + rimCol + uHalo * uLight2.z * halo;
  float k = uIntensity * vTear.z * (1.0 + uPulseK.y * pulse) * border * vFog;
  gl_FragColor = vec4(col * k, 1.0);
}
`;

function tearUniforms(time: TimeUniform, intensity: number): Record<string, THREE.IUniform> {
  const c = RIFT_PORTAL.colors;
  const t = RIFT_PORTAL.tear;
  const color = (v: readonly [number, number, number]): THREE.Color =>
    new THREE.Color().setRGB(v[0], v[1], v[2], THREE.LinearSRGBColorSpace);
  return {
    uTime: time,
    uCore: { value: color(c.core) },
    uHot: { value: color(c.hot) },
    uRim: { value: color(c.rim) },
    uHalo: { value: color(c.halo) },
    uFringeOuter: { value: color(c.fringeOuter) },
    uFringeInner: { value: color(c.fringeInner) },
    uShape: { value: new THREE.Vector4(t.open, t.profile, t.warp, t.noiseScale) },
    uShape2: { value: new THREE.Vector4(t.jag, t.flowSpeed, t.breathe, t.breatheRate) },
    uLight: { value: new THREE.Vector4(t.coreIntensity, t.hotIntensity, t.rimIntensity, t.rimSharpness) },
    uLight2: { value: new THREE.Vector4(t.fringeWidth, t.fringeIntensity, t.haloIntensity, t.haloFalloff) },
    uPulseK: { value: new THREE.Vector2(t.pulseOpen, t.pulseIntensity) },
    uHaloScale: { value: new THREE.Vector2(t.haloScale[0], t.haloScale[1]) },
    uIntensity: { value: intensity },
    uPulseScale: { value: 1 },
    fogParams: HEIGHT_FOG_PARAMS,
  };
}

function additiveMaterial(
  name: string,
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

/** Exponential pulse decay (pure; exported for tests). */
export function decayPulse(pulse: number, dt: number, rate: number = RIFT_PORTAL.pulse.decay): number {
  const p = pulse * Math.exp(-rate * Math.max(0, dt));
  return p < 1e-3 ? 0 : p;
}

/** Visible share of a pulse (1, or RIFT_PORTAL.pulse.reducedScale with reduce flashing). */
export function pulseScale(reduceFlashing: boolean): number {
  return reduceFlashing ? RIFT_PORTAL.pulse.reducedScale : 1;
}

/** Combine a new pulse with the current one (strongest wins, clamped). */
export function addPulse(current: number, strength: number, max: number = RIFT_PORTAL.pulse.max): number {
  if (!(strength > 0)) return current;
  return Math.min(max, Math.max(current, strength));
}

export interface RiftTearPlacement {
  /** Center of the tear (world). */
  position: Vec3Like;
  /** Direction the tear faces (wall normal / up for floor tears). */
  normal: Vec3Like;
  /** The tear's long axis (projected onto the tear plane; default world up, or +Z for floor tears). */
  up?: Vec3Like;
  width: number;
  height: number;
  seed: number;
  /** Idle brightness multiplier (default 1). */
  brightness?: number;
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Instance matrix of a tear quad (local XY plane, +Z = normal). Exported for tests. */
export function tearMatrix(t: RiftTearPlacement, out: THREE.Matrix4): THREE.Matrix4 {
  _z.set(t.normal.x, t.normal.y, t.normal.z);
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
  _z.normalize();
  if (t.up) _y.set(t.up.x, t.up.y, t.up.z);
  else if (Math.abs(_z.y) > 0.9) _y.set(0, 0, 1);
  else _y.set(0, 1, 0);
  // Gram-Schmidt: the long axis in the tear plane.
  _y.addScaledVector(_z, -_y.dot(_z));
  if (_y.lengthSq() < 1e-8) _y.set(1, 0, 0).addScaledVector(_z, -_z.x);
  _y.normalize();
  _x.crossVectors(_y, _z).normalize();
  _s.set(t.width / 2, t.height / 2, 1);
  out.makeBasis(_x.multiplyScalar(_s.x), _y.multiplyScalar(_s.y), _z);
  out.setPosition(_p.set(t.position.x, t.position.y, t.position.z));
  return out;
}

export interface RiftFieldOptions {
  time: TimeUniform;
  /** Base brightness of the whole field (default RIFT_PORTAL.small.intensity). */
  intensity?: number;
  name?: string;
}

/** Many small tears in one instanced draw call. */
export class RiftPortalField {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly attr: THREE.InstancedBufferAttribute;
  private readonly pulses: Float32Array;
  private readonly centers: Float32Array;
  private dirty = false;

  constructor(tears: readonly RiftTearPlacement[], opts: RiftFieldOptions) {
    this.count = tears.length;
    const n = Math.max(1, tears.length);
    // Local units are tear half-extents; the quad covers the halo (±haloScale).
    const hs = RIFT_PORTAL.tear.haloScale;
    const geo = new THREE.PlaneGeometry(hs[0] * 2, hs[1] * 2, 1, 1);
    for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
    const data = new Float32Array(n * 4);
    this.pulses = new Float32Array(n);
    this.centers = new Float32Array(n * 3);
    tears.forEach((t, i) => {
      data[i * 4] = (((t.seed * 0.6180339) % 1) + 1) % 1;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = t.brightness ?? 1;
      data[i * 4 + 3] = 1;
      this.centers[i * 3] = t.position.x;
      this.centers[i * 3 + 1] = t.position.y;
      this.centers[i * 3 + 2] = t.position.z;
    });
    this.attr = new THREE.InstancedBufferAttribute(data, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTear', this.attr);
    this.material = additiveMaterial(
      'RiftTear',
      TEAR_VERTEX,
      TEAR_FRAGMENT,
      tearUniforms(opts.time, opts.intensity ?? RIFT_PORTAL.small.intensity),
    );
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    mesh.name = opts.name ?? 'RiftPortalField';
    tears.forEach((t, i) => mesh.setMatrixAt(i, tearMatrix(t, _m)));
    mesh.count = tears.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 12;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.visible = tears.length > 0;
    this.mesh = mesh;
  }

  /** Current pulse of a tear (0 = idle). */
  pulseOf(index: number): number {
    return this.pulses[index] ?? 0;
  }

  /** Flare one tear (strength ~1 = spawn burst). */
  pulse(index: number, strength: number): void {
    if (index < 0 || index >= this.count) return;
    this.pulses[index] = addPulse(this.pulses[index]!, strength);
    this.dirty = true;
  }

  /** Flare every tear. */
  pulseAll(strength: number): void {
    if (!(strength > 0) || this.count === 0) return;
    for (let i = 0; i < this.count; i++) this.pulses[i] = addPulse(this.pulses[i]!, strength);
    this.dirty = true;
  }

  /** Index of the tear closest to `p` within `maxDistance` (m), or -1. */
  nearest(p: Vec3Like, maxDistance: number): number {
    let best = -1;
    let bestD = maxDistance * maxDistance;
    for (let i = 0; i < this.count; i++) {
      const dx = this.centers[i * 3]! - p.x;
      const dy = this.centers[i * 3 + 1]! - p.y;
      const dz = this.centers[i * 3 + 2]! - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Decay pulses and upload changed instance data. Per frame, no allocation. */
  update(dt: number): void {
    if (!this.dirty) return;
    const data = this.attr.array as Float32Array;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      const p = this.pulses[i]!;
      if (p === 0 && data[i * 4 + 1] === 0) continue;
      const next = decayPulse(p, dt);
      this.pulses[i] = next;
      data[i * 4 + 1] = next;
      if (next > 0) any = true;
    }
    this.attr.needsUpdate = true;
    this.dirty = any;
  }

  /** Brightness multiplier of the whole field. */
  setIntensity(k: number): void {
    (this.material.uniforms.uIntensity as THREE.IUniform<number>).value = k;
  }

  /** Accessibility: pulses flare the tears only RIFT_PORTAL.pulse.reducedScale as much. */
  setReducedFlashing(on: boolean): void {
    (this.material.uniforms.uPulseScale as THREE.IUniform<number>).value = pulseScale(on);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Large anomaly
// ---------------------------------------------------------------------------

const VORTEX_VERTEX = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
varying vec2 vP;
varying float vFog;
${HEIGHT_FOG_GLSL}
void main() {
  // Camera-facing billboard around uCenter (world space).
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vP = position.xy * 2.0;
  vec3 wp = uCenter + (right * position.x + up * position.y) * 2.0 * uRadius;
  vFog = fogTransmittance(cameraPosition, uCenter);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const VORTEX_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uCore;
uniform vec3 uHot;
uniform vec3 uRim;
uniform vec3 uHalo;
uniform vec3 uFringeOuter;
uniform vec3 uFringeInner;
uniform vec4 uVortex;   // intensity, twist, spin, horizon
uniform vec4 uVortex2;  // ring width, ring intensity, arms, core fraction of the quad
uniform vec4 uVortex3;  // ring jag, jag noise scale, jag speed, rim share of the ring color
uniform vec2 uHaloK;    // halo intensity, pulse boost
varying vec2 vP;
varying float vFog;
${NOISE_GLSL}
void main() {
  float R = length(vP);
  if (R > 1.0) discard;
  float coreFrac = uVortex2.w;
  // Halo: soft glow with slow wisps over the whole quad.
  float wisps = rpFbm(vP * 3.0 + vec2(uTime * 0.05, -uTime * 0.04));
  float halo = exp(-R * 4.5) * (0.6 + 0.4 * wisps) * (1.0 - smoothstep(0.7, 1.0, R));
  vec3 col = uHalo * uHaloK.x * halo;
  float r = R / coreFrac;
  if (r < 1.0) {
    float lr = log(max(r, 1e-3));
    float ang = uTime * uVortex.z - lr * uVortex.y;
    float c = cos(ang);
    float s = sin(ang);
    vec2 q = mat2(c, -s, s, c) * (vP / coreFrac);
    float n = rpFbm(q * 2.2 + 3.1);
    float a = atan(q.y, q.x);
    float arms = 0.5 + 0.5 * sin(a * uVortex2.z + n * 3.0);
    // Torn horizon: the ring radius wobbles with noise sampled on the (continuous) direction.
    vec2 dir = q / max(length(q), 1e-4);
    float jag = rpFbm(dir * uVortex3.y + vec2(uTime * uVortex3.z, -uTime * uVortex3.z * 0.7)) - 0.5;
    float rj = r + jag * uVortex3.x;
    float horizon = uVortex.w * (1.0 + 0.25 * uPulse);
    float hole = smoothstep(horizon, horizon + 0.06, rj);
    float disc = 1.0 - smoothstep(0.35, 1.0, r);
    float energy = pow(arms * n, 1.5) * 2.2;
    vec3 swirl = mix(uCore, uHot, clamp(energy * 0.8, 0.0, 1.0)) * uVortex.x * (0.25 + energy);
    float rw = uVortex2.x;
    float ring = exp(-abs(rj - horizon - rw) / rw);
    float ringO = exp(-abs(rj - horizon - rw * 2.2) / rw);
    float ringI = exp(-abs(rj - horizon - rw * 0.2) / rw);
    vec3 ringCol = mix(uHot, uRim, uVortex3.w) * (0.75 + 0.5 * n);
    col += swirl * disc * hole;
    col += (ringCol * ring + uFringeOuter * ringO * 0.5 + uFringeInner * ringI * 0.5) * uVortex2.y * hole;
  }
  gl_FragColor = vec4(col * (1.0 + uHaloK.y * uPulse) * vFog, 1.0);
}
`;

/** Largest orbit scale of a particle: `(0.75 + 0.5 * aSeed.y)` in PARTICLE_VERTEX (culling bounds). */
const PARTICLE_ORBIT_SCALE_MAX = 1.25;

const PARTICLE_VERTEX = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter;
uniform float uTime;
uniform vec4 uOrbit;    // radius min, radius max, period, height fraction
uniform vec4 uSize;     // size min, size max, min px, max px
uniform float uOrbitSpeed;
uniform float uViewportHeight;
uniform float uPulse;
varying float vAlpha;
varying float vHot;
varying float vFog;
${HEIGHT_FOG_GLSL}
void main() {
  float life = fract(uTime / uOrbit.z + aSeed.x);
  float r = mix(uOrbit.y, uOrbit.x, life * life) * (0.75 + 0.5 * aSeed.y);
  float ang = aSeed.y * 6.2831853 + uTime * uOrbitSpeed * (uOrbit.y / max(r, 0.1)) * 0.35;
  float h = (aSeed.z - 0.5) * 2.0 * uOrbit.w * r * (1.0 - life);
  vec3 wp = uCenter + vec3(cos(ang) * r, h, sin(ang) * r);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = max(-mv.z, 0.05);
  float size = mix(uSize.x, uSize.y, aSeed.w) * (1.0 + 0.6 * uPulse);
  float px = size * projectionMatrix[1][1] * 0.5 * uViewportHeight / dist;
  float coverage = clamp(px / uSize.z, 0.0, 1.0);
  vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.88, 1.0, life)) * coverage * coverage;
  vHot = life;
  vFog = fogTransmittance(cameraPosition, wp);
  gl_PointSize = clamp(px, uSize.z, uSize.w);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHot;
uniform float uIntensity;
uniform float uPulse;
varying float vAlpha;
varying float vHot;
varying float vFog;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.0) * (1.0 - smoothstep(0.7, 1.0, d)) * vAlpha;
  if (a < 0.002) discard;
  vec3 col = mix(uCore, uHot, vHot * vHot) * uIntensity * (1.0 + uPulse);
  gl_FragColor = vec4(col * a * vFog, 1.0);
}
`;

export interface RiftPortalOptions {
  position: Vec3Like;
  time: TimeUniform;
  /** Stable seed for the tear cluster layout. */
  seed?: number;
  /** Create the pulsing point light (counts against the level light budget). */
  light?: boolean;
}

const _vp = new THREE.Vector4();

/** Tiny deterministic PRNG (cosmetic layout only). */
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

/** The large rift anomaly. Add `root` to the scene; call update() every frame. */
export class RiftPortal {
  readonly root: THREE.Group;
  readonly light: THREE.PointLight | null;
  readonly tears: RiftPortalField;
  readonly particles: THREE.Points;
  private readonly cluster: THREE.Group;
  private readonly vortex: THREE.Mesh;
  private readonly vortexMaterial: THREE.ShaderMaterial;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly maxParticles: number;
  private readonly center = new THREE.Vector3();
  private readonly baseLight: number;
  private pulseValue = 0;
  private reduceFlashing = false;
  private elapsed = 0;

  constructor(opts: RiftPortalOptions) {
    const L = RIFT_PORTAL.large;
    const c = RIFT_PORTAL.colors;
    const color = (v: readonly [number, number, number]): THREE.Color =>
      new THREE.Color().setRGB(v[0], v[1], v[2], THREE.LinearSRGBColorSpace);
    this.center.set(opts.position.x, opts.position.y, opts.position.z);
    this.root = new THREE.Group();
    this.root.name = 'RiftPortal';
    this.root.position.copy(this.center);

    // Vortex + halo billboard (one quad sized by the halo).
    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    for (const name of Object.keys(quad.attributes)) if (name !== 'position') quad.deleteAttribute(name);
    const v = L.vortex;
    this.vortexMaterial = additiveMaterial('RiftVortex', VORTEX_VERTEX, VORTEX_FRAGMENT, {
      uTime: opts.time,
      uPulse: { value: 0 },
      uCenter: { value: this.center.clone() },
      uRadius: { value: L.haloRadius },
      uCore: { value: color(c.core) },
      uHot: { value: color(c.hot) },
      uRim: { value: color(c.rim) },
      uHalo: { value: color(c.halo) },
      uFringeOuter: { value: color(c.fringeOuter) },
      uFringeInner: { value: color(c.fringeInner) },
      uVortex: { value: new THREE.Vector4(v.intensity, v.twist, v.spin, v.horizon) },
      uVortex2: {
        value: new THREE.Vector4(v.ringWidth, v.ringIntensity, v.arms, L.coreRadius / L.haloRadius),
      },
      uVortex3: { value: new THREE.Vector4(v.ringJag, v.ringJagScale, v.ringJagSpeed, v.ringRimShare) },
      uHaloK: { value: new THREE.Vector2(L.haloIntensity, RIFT_PORTAL.tear.pulseIntensity) },
      fogParams: HEIGHT_FOG_PARAMS,
    });
    this.vortex = new THREE.Mesh(quad, this.vortexMaterial);
    this.vortex.name = 'RiftVortex';
    this.vortex.renderOrder = 13;
    this.vortex.layers.set(RENDER.volumetricLayer);
    // Billboarded around the world center in the shader (the model matrix is ignored): the culling
    // sphere covers the camera-facing quad (half diagonal) around the root.
    quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(), L.haloRadius * Math.SQRT2);
    this.vortex.matrixAutoUpdate = false;

    // Crossed tear planes through the core, rotating as a cluster.
    const rand = mulberry32(opts.seed ?? 7);
    const tears: RiftTearPlacement[] = [];
    // Shards around the core: tangential planes (facing outwards), tilted, at jittered radii.
    const C = L.cluster;
    const spread = (k: number): number => 1 + (rand() - 0.5) * k;
    for (let i = 0; i < L.tearCount; i++) {
      const ang = (i / L.tearCount) * Math.PI * 2 + (rand() - 0.5) * C.angleJitter;
      const radial = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
      const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(radial, (rand() - 0.5) * C.tilt);
      const normal = radial.clone().applyAxisAngle(up, (rand() - 0.5) * C.twist);
      const r = L.tearOrbit * spread(C.orbitSpread);
      tears.push({
        position: { x: radial.x * r, y: (rand() - 0.5) * C.heightSpread, z: radial.z * r },
        normal,
        up,
        width: L.tearSize[0] * spread(C.sizeSpread),
        height: L.tearSize[1] * spread(C.sizeSpread),
        seed: i + 1 + (opts.seed ?? 0),
      });
    }
    this.tears = new RiftPortalField(tears, {
      time: opts.time,
      intensity: L.tearIntensity,
      name: 'RiftCluster',
    });
    this.cluster = new THREE.Group();
    this.cluster.name = 'RiftCluster';
    this.cluster.add(this.tears.mesh);
    this.root.add(this.cluster);

    // Particles spiralling into the core.
    const P = L.particles;
    this.maxParticles = P.count;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P.count * 3), 3));
    const seeds = new Float32Array(P.count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.particleGeometry = pg;
    this.particleMaterial = new THREE.ShaderMaterial({
      name: 'RiftParticles',
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        uCenter: { value: this.center.clone() },
        uTime: opts.time,
        uOrbit: { value: new THREE.Vector4(P.radiusMin, P.radiusMax, P.period, P.height) },
        uSize: { value: new THREE.Vector4(P.sizeMin, P.sizeMax, P.minPixelSize, P.maxPixelSize) },
        uOrbitSpeed: { value: P.orbitSpeed },
        uViewportHeight: { value: 1080 },
        uPulse: { value: 0 },
        uCore: { value: color(c.core) },
        uHot: { value: color(c.hot) },
        uIntensity: { value: P.intensity },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.particles = new THREE.Points(pg, this.particleMaterial);
    this.particles.name = 'RiftParticles';
    // Positions come from the shader around the world center (the model matrix is ignored); the
    // culling sphere covers the widest orbit and its vertical spread.
    pg.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      P.radiusMax * PARTICLE_ORBIT_SCALE_MAX * Math.hypot(1, P.height),
    );
    this.particles.matrixAutoUpdate = false;
    this.particles.renderOrder = 14;
    this.particles.layers.set(RENDER.volumetricLayer);
    this.particles.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_vp);
      (this.particleMaterial.uniforms.uViewportHeight as THREE.IUniform<number>).value = Math.max(1, _vp.w);
    };

    this.root.add(this.vortex, this.particles);

    this.baseLight = L.light.intensity;
    if (opts.light ?? true) {
      const lc = L.light.color;
      const light = new THREE.PointLight(color(lc), L.light.intensity, L.light.distance, L.light.decay);
      light.name = 'RiftLight';
      light.castShadow = false;
      this.root.add(light);
      this.light = light;
    } else {
      this.light = null;
    }
  }

  /** Current pulse (0 = idle). */
  get pulseLevel(): number {
    return this.pulseValue;
  }

  /** Flare the anomaly (wave start ~1.5, spawn burst ~0.5); decays exponentially. */
  pulse(strength: number): void {
    this.pulseValue = addPulse(this.pulseValue, strength);
  }

  /** Accessibility: pulses flare the vortex, tears, particles and the light less. */
  setReducedFlashing(on: boolean): void {
    this.reduceFlashing = on;
    this.tears.setReducedFlashing(on);
  }

  /** Visible particle fraction (volumetrics quality); 0 hides them. */
  setParticleFraction(f: number): void {
    const n = Math.max(0, Math.min(this.maxParticles, Math.floor(this.maxParticles * f)));
    this.particleGeometry.setDrawRange(0, n);
    this.particles.visible = n > 0;
  }

  /** Per frame (no allocation). */
  update(dt: number): void {
    const L = RIFT_PORTAL.large;
    this.elapsed += dt;
    this.pulseValue = decayPulse(this.pulseValue, dt);
    const pulse = this.pulseValue;
    const visible = pulse * pulseScale(this.reduceFlashing);
    (this.vortexMaterial.uniforms.uPulse as THREE.IUniform<number>).value = visible;
    (this.particleMaterial.uniforms.uPulse as THREE.IUniform<number>).value = visible;
    // The cluster's own field applies the reduced scale in its shader.
    this.tears.pulseAll(pulse);
    this.tears.update(dt);
    // Slow rotation + wobble of the tear cluster.
    const t = this.elapsed;
    this.cluster.rotation.set(
      Math.sin(t * L.wobbleRate * Math.PI * 2) * L.wobble,
      t * L.rotationSpeed,
      Math.cos(t * L.wobbleRate * Math.PI * 2 * 0.77) * L.wobble,
    );
    if (this.light) {
      const li = L.light;
      const breathe = 1 + li.breathe * Math.sin(t * li.breatheRate * Math.PI * 2);
      const boost = (this.reduceFlashing ? li.reducedPulseBoost : 1) * li.pulseBoost * pulse;
      this.light.intensity = this.baseLight * breathe * (1 + boost);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.tears.dispose();
    this.vortex.geometry.dispose();
    this.vortexMaterial.dispose();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.light?.dispose();
    this.root.clear();
  }
}
