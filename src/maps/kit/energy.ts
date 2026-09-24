/**
 * Additive "energy" looks of the map kit, drawn on RENDER.volumetricLayer (after AO and height fog,
 * depth-tested, no depth write) and fogged in their own shaders like every volumetric:
 * - ArcBundle: jagged lightning ribbons between point pairs (fence strands, zap strikes, the
 *   turret laser with zero jitter) – camera-facing, a white-hot HDR core in a colored glow,
 * - flame column (open cylinder, scrolling noise fire),
 * - wind streaks flowing into a fan intake (instanced quads animated in the vertex shader),
 * - floor ring with a progress arc (quest defend zone, anomaly border),
 * - fresnel shell (gravity anomaly bubble).
 * Everything is built once; per frame only uniforms change (no allocation). The shaders' noise
 * hashes and shape constants are shader-internal.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { Vec3Like } from '../../core/events';
import type { Rgb } from '../../defs/interactables';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';

export interface TimeUniform {
  value: number;
}

const NOISE_GLSL = /* glsl */ `
float kHash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float kNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(kHash(i), kHash(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float kNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = kHash(i.x + i.y * 57.0);
  float b = kHash(i.x + 1.0 + i.y * 57.0);
  float c = kHash(i.x + (i.y + 1.0) * 57.0);
  float d = kHash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

function hdr(c: Rgb, k = 1): Color {
  return new Color(c[0] * k, c[1] * k, c[2] * k);
}

/** Put an additive mesh on the volumetric layer (never shadows, never nav / bullets). */
export function toVolumetric<T extends Object3D>(o: T, renderOrder = 0): T {
  o.layers.set(RENDER.volumetricLayer);
  o.castShadow = false;
  o.receiveShadow = false;
  o.userData.navIgnore = true;
  o.frustumCulled = false;
  o.renderOrder = renderOrder;
  return o;
}

function additive(
  name: string,
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, unknown>,
  doubleSided = true,
): ShaderMaterial {
  return new ShaderMaterial({
    name,
    vertexShader,
    fragmentShader,
    uniforms: { ...uniforms, fogParams: HEIGHT_FOG_PARAMS } as ShaderMaterial['uniforms'],
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: doubleSided ? DoubleSide : FrontSide,
    toneMapped: false,
    fog: false,
  });
}

// ---------------------------------------------------------------------------
// Arc bundle
// ---------------------------------------------------------------------------

const ARC_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
${NOISE_GLSL}
attribute vec4 aRib; // t along, side (-1/1), ribbon index, 0
uniform vec3 uFrom[ARCS];
uniform vec3 uTo[ARCS];
uniform float uEnergy[ARCS];
uniform float uTime;
uniform float uJitter;
uniform float uJitterRate;
uniform float uWidth;
varying float vSide;
varying float vEnergy;
varying float vFog;
varying float vT;
varying float vRib;
void main() {
  int k = int(aRib.z + 0.5);
  vec3 p0 = uFrom[k];
  vec3 p1 = uTo[k];
  float t = aRib.x;
  vec3 axis = p1 - p0;
  float len = max(length(axis), 1e-4);
  vec3 dir = axis / len;
  vec3 mid = p0 + axis * t;
  // Lightning: the shape jumps (stepped time), anchored at both ends.
  float step = floor(uTime * uJitterRate);
  float env = sin(t * 3.14159265);
  float s = aRib.z * 17.31 + step * 3.71;
  float n1 = (kNoise(t * 9.0 + s) - 0.5) * 1.4 + (kNoise(t * 23.0 + s * 1.7) - 0.5) * 0.6;
  float n2 = (kNoise(t * 8.0 + s + 41.0) - 0.5) * 1.4 + (kNoise(t * 19.0 + s * 2.3 + 7.0) - 0.5) * 0.6;
  vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 pa = normalize(cross(dir, up));
  vec3 pb = cross(pa, dir);
  mid += (pb * n1 + pa * n2) * uJitter * env * min(1.0, len * 0.5);
  vec3 side = cross(dir, cameraPosition - mid);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : pa;
  vec3 wp = mid + side * aRib.y * uWidth;
  vSide = aRib.y;
  vEnergy = uEnergy[k];
  vT = t;
  vRib = aRib.z;
  vFog = fogTransmittance(cameraPosition, wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const ARC_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uCoreWidth;
uniform float uTime;
uniform float uFlicker;
varying float vSide;
varying float vEnergy;
varying float vFog;
varying float vT;
varying float vRib;
void main() {
  if (vEnergy <= 0.001) discard;
  float d = abs(vSide);
  float core = exp(-(d * d) / (uCoreWidth * uCoreWidth));
  float glow = exp(-d * 3.0) * (1.0 - d * d);
  float flick = 1.0 - uFlicker * kHash(floor(uTime * 30.0) + vRib * 7.0);
  float ends = smoothstep(0.0, 0.03, vT) * smoothstep(1.0, 0.97, vT);
  vec3 col = (uCore * core + uGlow * glow) * vEnergy * flick * mix(0.6, 1.0, ends);
  gl_FragColor = vec4(col * vFog, 1.0);
}
`;

export interface ArcBundleOptions {
  /** Ribbons in the bundle (fixed at build). */
  count: number;
  segments: number;
  /** Half width of the ribbon (glow extent, m). */
  width: number;
  /** Core width as a fraction of the half width. */
  core: number;
  jitter: number;
  jitterRate: number;
  coreColor: Rgb;
  glowColor: Rgb;
  intensity: number;
  time: TimeUniform;
  /** 0..1 random per-frame brightness flicker. */
  flicker?: number;
  name?: string;
}

/** Up to `count` lightning ribbons; set endpoints + energy per ribbon, 0 energy = hidden. */
export class ArcBundle {
  readonly mesh: Mesh;
  private readonly from: Vector3[];
  private readonly to: Vector3[];
  private readonly energy: number[];
  private readonly material: ShaderMaterial;

  constructor(o: ArcBundleOptions) {
    const n = Math.max(1, o.count);
    const segs = Math.max(1, o.segments);
    const verts = n * (segs + 1) * 2;
    const rib = new Float32Array(verts * 4);
    const index: number[] = [];
    let v = 0;
    for (let r = 0; r < n; r++) {
      const base = v;
      for (let i = 0; i <= segs; i++) {
        for (const side of [-1, 1]) {
          const q = v * 4;
          rib[q] = i / segs;
          rib[q + 1] = side;
          rib[q + 2] = r;
          rib[q + 3] = 0;
          v++;
        }
        if (i < segs) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const geo = new BufferGeometry();
    // Positions are computed in the shader; three needs a position attribute for the draw count.
    geo.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
    geo.setAttribute('aRib', new BufferAttribute(rib, 4));
    geo.setIndex(index);
    this.from = Array.from({ length: n }, () => new Vector3());
    this.to = Array.from({ length: n }, () => new Vector3());
    this.energy = new Array<number>(n).fill(0);
    this.material = additive('kit-arcs', ARC_VERTEX, ARC_FRAGMENT, {
      uFrom: { value: this.from },
      uTo: { value: this.to },
      uEnergy: { value: this.energy },
      uTime: o.time,
      uJitter: { value: o.jitter },
      uJitterRate: { value: o.jitterRate },
      uWidth: { value: o.width },
      uCoreWidth: { value: o.core },
      uCore: { value: hdr(o.coreColor, o.intensity) },
      uGlow: { value: hdr(o.glowColor, o.intensity * 0.35) },
      uFlicker: { value: o.flicker ?? 0.25 },
    });
    this.material.defines = { ARCS: n };
    this.mesh = toVolumetric(new Mesh(geo, this.material));
    this.mesh.name = o.name ?? 'kit-arcs';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  get count(): number {
    return this.energy.length;
  }

  set(i: number, from: Vec3Like, to: Vec3Like, energy: number): void {
    if (i < 0 || i >= this.energy.length) return;
    this.from[i]!.set(from.x, from.y, from.z);
    this.to[i]!.set(to.x, to.y, to.z);
    this.energy[i] = Math.max(0, energy);
  }

  setEnergy(i: number, energy: number): void {
    if (i >= 0 && i < this.energy.length) this.energy[i] = Math.max(0, energy);
  }

  /** Show the mesh while any ribbon has energy. */
  sync(): void {
    let any = false;
    for (let i = 0; i < this.energy.length; i++) if (this.energy[i]! > 0.001) any = true;
    this.mesh.visible = any;
  }

  setJitter(j: number): void {
    (this.material.uniforms.uJitter as { value: number }).value = j;
  }

  setFlicker(f: number): void {
    (this.material.uniforms.uFlicker as { value: number }).value = f;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Flame column
// ---------------------------------------------------------------------------

const FLAME_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FLAME_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uBurst;
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vFog;
void main() {
  float h = vUv.y;
  float around = vUv.x * 6.2831853;
  vec2 p = vec2(vUv.x * 5.0, h * 3.0 - uTime * 3.4);
  float n = kNoise2(p) * 0.6 + kNoise2(p * 2.3 + 11.0) * 0.4;
  float n2 = kNoise2(vec2(vUv.x * 9.0, h * 6.0 - uTime * 5.5) + 3.0);
  // The column tapers and tears apart towards the top; the burst length follows uBurst.
  float reach = uBurst;
  float top = smoothstep(reach, reach * 0.35, h + (n - 0.5) * 0.35);
  float body = pow(n, 1.6) * top;
  vec3 v = normalize(vViewW);
  float facing = abs(dot(normalize(vNormalW), v));
  float soft = pow(facing, 1.3);
  float heat = clamp(body * 1.6 - h * 0.6, 0.0, 1.0);
  vec3 col = mix(uColor, uCoreColor, heat) * (body + n2 * 0.25 * top) * soft;
  gl_FragColor = vec4(col * uIntensity * vFog, 1.0);
}
`;

export function createFlameColumn(
  radius: number,
  height: number,
  color: Rgb,
  core: Rgb,
  intensity: number,
  time: TimeUniform,
): Mesh {
  const geo = new CylinderGeometry(radius * 0.55, radius, height, 20, 6, true);
  geo.translate(0, height / 2, 0);
  const mat = additive('kit-flame', FLAME_VERTEX, FLAME_FRAGMENT, {
    uColor: { value: hdr(color) },
    uCoreColor: { value: hdr(core) },
    uIntensity: { value: intensity },
    uBurst: { value: 0 },
    uTime: time,
  });
  const m = toVolumetric(new Mesh(geo, mat));
  m.name = 'kit-flame';
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------
// Wind streaks (fan intake)
// ---------------------------------------------------------------------------

const STREAK_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
attribute vec4 aSeed; // angle, radial fraction, phase, speed factor
uniform vec3 uCenter;
uniform vec3 uNormal;
uniform vec3 uU;
uniform vec3 uV;
uniform float uReach;
uniform float uRadius;
uniform float uSpeed;
uniform float uLength;
uniform float uTime;
varying float vAlong;
varying float vAcross;
varying float vLife;
varying float vFog;
void main() {
  float life = fract(aSeed.z + uTime * uSpeed * aSeed.w / max(uReach, 0.1));
  float axial = uReach * (1.0 - life);
  float r = aSeed.y * uRadius * mix(0.3, 1.0, axial / max(uReach, 0.1));
  vec3 radial = uU * cos(aSeed.x) + uV * sin(aSeed.x);
  vec3 head = uCenter + uNormal * axial + radial * r;
  vec3 dir = normalize(uNormal * uReach + radial * uRadius * 0.7);
  vec3 tail = head + dir * uLength;
  vec3 mid = mix(tail, head, position.x + 0.5);
  vec3 side = normalize(cross(dir, cameraPosition - mid));
  vec3 wp = mid + side * position.y * 0.02;
  vAlong = position.x + 0.5;
  vAcross = position.y * 2.0;
  vLife = life;
  vFog = fogTransmittance(cameraPosition, wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const STREAK_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOn;
varying float vAlong;
varying float vAcross;
varying float vLife;
varying float vFog;
void main() {
  float fade = smoothstep(0.0, 0.2, vLife) * smoothstep(1.0, 0.75, vLife);
  float a = vAlong * (1.0 - abs(vAcross));
  gl_FragColor = vec4(uColor * a * fade * uOn * vFog, 1.0);
}
`;

export interface StreakOptions {
  count: number;
  center: Vec3Like;
  normal: Vec3Like;
  reach: number;
  radius: number;
  speed: number;
  length: number;
  color: Rgb;
  intensity: number;
  time: TimeUniform;
  seed: number;
}

export function createStreaks(o: StreakOptions): Mesh<InstancedBufferGeometry, ShaderMaterial> {
  const plane = new PlaneGeometry(1, 1, 1, 1);
  const geo = new InstancedBufferGeometry();
  geo.setIndex(plane.getIndex());
  geo.setAttribute('position', plane.getAttribute('position'));
  const seeds = new Float32Array(o.count * 4);
  let s = o.seed * 9301 + 49297;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < o.count; i++) {
    seeds[i * 4] = rand() * Math.PI * 2;
    seeds[i * 4 + 1] = Math.sqrt(rand());
    seeds[i * 4 + 2] = rand();
    seeds[i * 4 + 3] = 0.7 + rand() * 0.6;
  }
  geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = o.count;
  plane.dispose();
  const n = new Vector3(o.normal.x, o.normal.y, o.normal.z).normalize();
  const u = new Vector3(0, 1, 0);
  if (Math.abs(n.y) > 0.9) u.set(1, 0, 0);
  const v = new Vector3().crossVectors(n, u).normalize();
  u.crossVectors(v, n).normalize();
  const mat = additive('kit-streaks', STREAK_VERTEX, STREAK_FRAGMENT, {
    uCenter: { value: new Vector3(o.center.x, o.center.y, o.center.z) },
    uNormal: { value: n },
    uU: { value: u },
    uV: { value: v },
    uReach: { value: o.reach },
    uRadius: { value: o.radius },
    uSpeed: { value: o.speed },
    uLength: { value: o.length },
    uTime: o.time,
    uColor: { value: hdr(o.color, o.intensity) },
    uOn: { value: 0 },
  });
  const m = toVolumetric(new Mesh(geo, mat));
  m.name = 'kit-streaks';
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------
// Floor ring with a progress arc
// ---------------------------------------------------------------------------

const RING_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vLocal;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vLocal = position.xy;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uRadius;
uniform float uWidth;
uniform float uProgress;
uniform float uTime;
varying vec2 vLocal;
varying float vFog;
void main() {
  float r = length(vLocal);
  float d = abs(r - uRadius);
  float line = exp(-(d * d) / (uWidth * uWidth));
  float inner = smoothstep(uRadius, 0.0, r) * 0.12;
  // Progress arc: clockwise from "north"; the filled part glows brighter.
  float ang = fract(atan(vLocal.x, vLocal.y) / 6.2831853 + 1.0);
  float filled = step(ang, uProgress);
  float dashes = 0.55 + 0.45 * step(0.5, fract(ang * 48.0 - uTime * 0.35));
  float k = line * mix(dashes * 0.45, 1.6, filled) + inner * (0.5 + 0.5 * filled);
  gl_FragColor = vec4(uColor * k * uIntensity * vFog, 1.0);
}
`;

export function createProgressRing(
  radius: number,
  width: number,
  color: Rgb,
  intensity: number,
  time: TimeUniform,
): Mesh {
  const geo = new RingGeometry(0, radius + width * 3, 96, 1);
  geo.rotateX(-Math.PI / 2);
  // RingGeometry lies in XY; after rotateX(-π/2) the local XY of the fragment is (x, -z).
  const mat = additive(
    'kit-ring',
    RING_VERTEX.replace('vLocal = position.xy;', 'vLocal = vec2(position.x, -position.z);'),
    RING_FRAGMENT,
    {
      uColor: { value: hdr(color) },
      uIntensity: { value: intensity },
      uRadius: { value: radius },
      uWidth: { value: width },
      uProgress: { value: 0 },
      uTime: time,
    },
  );
  const m = toVolumetric(new Mesh(geo, mat));
  m.name = 'kit-ring';
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------
// Fresnel shell (anomaly bubble)
// ---------------------------------------------------------------------------

const SHELL_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vWorld;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPower;
uniform float uTime;
uniform float uFloor;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vWorld;
varying float vFog;
void main() {
  vec3 v = normalize(vViewW);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), v)), uPower);
  float ripple = 0.6 + 0.4 * kNoise2(vec2(vWorld.x + vWorld.z, vWorld.y * 1.7 - uTime * 0.8) * 1.3);
  // Fade the lower half into the floor.
  float lift = smoothstep(uFloor, uFloor + 0.6, vWorld.y);
  gl_FragColor = vec4(uColor * fres * ripple * lift * uIntensity * vFog, 1.0);
}
`;

export function createShell(
  radius: number,
  color: Rgb,
  intensity: number,
  rimPower: number,
  time: TimeUniform,
): Mesh<SphereGeometry, ShaderMaterial> {
  const geo = new SphereGeometry(radius, 40, 20);
  const mat = additive('kit-shell', SHELL_VERTEX, SHELL_FRAGMENT, {
    uColor: { value: hdr(color) },
    uIntensity: { value: intensity },
    uPower: { value: rimPower },
    uTime: time,
    uFloor: { value: 0 },
  });
  const m = toVolumetric(new Mesh(geo, mat));
  m.name = 'kit-shell';
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------
// Motes (points drifting upwards in a sphere)
// ---------------------------------------------------------------------------

const MOTE_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
attribute vec4 aSeed; // x, z (unit disc), phase, speed
uniform vec3 uCenter;
uniform float uRadius;
uniform float uHeight;
uniform float uSpeed;
uniform float uSize;
uniform float uTime;
uniform float uScale;
varying float vLife;
varying float vFog;
void main() {
  float life = fract(aSeed.z + uTime * uSpeed * aSeed.w / max(uHeight, 0.1));
  vec3 wp = uCenter + vec3(aSeed.x * uRadius, life * uHeight, aSeed.y * uRadius);
  wp.x += sin(uTime * 0.7 + aSeed.z * 20.0) * 0.15;
  wp.z += cos(uTime * 0.6 + aSeed.z * 13.0) * 0.15;
  vLife = life;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uScale / max(0.1, -mv.z);
  vFog = fogTransmittance(cameraPosition, wp);
}
`;

const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOn;
varying float vLife;
varying float vFog;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  float fade = smoothstep(0.0, 0.15, vLife) * smoothstep(1.0, 0.7, vLife);
  gl_FragColor = vec4(uColor * (1.0 - d) * fade * uOn * vFog, 1.0);
}
`;
export { MOTE_VERTEX, MOTE_FRAGMENT, additive as createAdditiveMaterial };
