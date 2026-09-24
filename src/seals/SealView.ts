/**
 * Rift seal visuals – every seal of the map in two draw calls:
 *
 * 1. One instanced additive quad draw on RENDER.volumetricLayer (drawn after AO and height fog,
 *    depth-tested, no depth write; the shader fogs itself like every volumetric). Per seal:
 *    - `segments` bars: camera-facing energy ribbons between the pylons – a white-hot HDR core
 *      (blooms) in a violet glow with flowing noise; re-forming bars grow from the pylons with a
 *      bright front, breaking bars flicker, turn warning-red and dissolve,
 *    - `segments` lattice bands: a faint drifting hex lattice between the bars, rippling where a
 *      swing lands,
 *    - 2 emitter strips on the pylons' inner faces (cyan, scan pulses; warning pulse when damaged),
 *    - 1 floor glow strip (fake light spill – real lights never change at runtime).
 * 2. One merged lit mesh for all emitter pylons (dark metal, render.setupMaterial for the CSM
 *    shadows; named `seal-pylons`: not a `level:` mesh, bullets pass).
 *
 * Static placement lives in aA/aB (uploaded once); aC/aD (animation) are rewritten per frame for
 * the used range – a few hundred floats, no allocation.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RENDER } from '../defs/graphics';
import { SEALS } from '../defs/seals';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../vfx/gpuUpload';
import type { Seal } from './Seal';
import { bandHeight, barHeight } from './sealGeometry';

const PART_BAR = 0;
const PART_BAND = 1;
const PART_EMITTER = 2;
const PART_FLOOR = 3;

const VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
attribute vec4 aA; // start xyz, part
attribute vec4 aB; // end xyz, size (ribbon width / band height / floor half depth)
attribute vec4 aC; // grow, shatter, flash, preview
attribute vec4 aD; // seed, ripple u, ripple strength, integrity
uniform float uTime;
uniform float uWobble;
varying vec2 vUv;
varying float vLen;
varying float vPart;
varying vec4 vC;
varying vec4 vD;
varying vec3 vWorld;
varying float vFog;
void main() {
  vec3 a = aA.xyz;
  vec3 axis = aB.xyz - a;
  float len = max(length(axis), 1e-4);
  vec3 dir = axis / len;
  float part = aA.w;
  float t = position.x + 0.5;
  vec3 wp;
  if (part < 0.5 || (part > 1.5 && part < 2.5)) {
    // Ribbon around its axis, facing the camera.
    vec3 mid = a + axis * t;
    vec3 side = cross(dir, cameraPosition - mid);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
    float wob = part < 0.5 ? sin(uTime * 3.1 + aD.x * 6.2831 + t * 9.0) * uWobble * sin(t * 3.14159) : 0.0;
    wp = mid + side * (position.y * aB.w) + vec3(0.0, wob, 0.0);
    vUv = vec2(t, position.y * 2.0);
  } else if (part < 1.5) {
    // Lattice band: vertical plane from the bottom-left to the bottom-right corner, aB.w high.
    wp = a + axis * t + vec3(0.0, (position.y + 0.5) * aB.w, 0.0);
    vUv = vec2(t, position.y + 0.5);
  } else {
    // Floor strip: ± aB.w across the axis.
    vec3 n = vec3(-dir.z, 0.0, dir.x);
    wp = a + axis * t + n * (position.y * 2.0 * aB.w);
    vUv = vec2(t, position.y * 2.0);
  }
  vLen = len;
  vPart = part;
  vC = aC;
  vD = aD;
  vWorld = wp;
  vFog = fogTransmittance(cameraPosition, wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uCore;
uniform vec3 uGlow;
uniform vec3 uLattice;
uniform vec3 uEmitter;
uniform vec3 uDamaged;
uniform float uFlash;
uniform float uFloor;
uniform float uCoreWidth;
uniform float uFlowSpeed;
uniform float uFlowScale;
uniform float uCell;
uniform float uLine;
uniform float uDrift;
uniform float uScan;
uniform float uWarnHz;
uniform float uReduced;
varying vec2 vUv;
varying float vLen;
varying float vPart;
varying vec4 vC;
varying vec4 vD;
varying vec3 vWorld;
varying float vFog;

float sHash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float sNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(sHash(i), sHash(i + 1.0), f * f * (3.0 - 2.0 * f));
}
// Distance to the nearest hex cell edge (0 on the edge, ~0.5 in the middle).
float hexEdge(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  return 0.5 - max(dot(q, s * 0.5), q.x);
}

void main() {
  float grow = vC.x;
  float shatter = vC.y;
  float flash = vC.z * uReduced;
  float preview = vC.w;
  float seed = vD.x;
  float integrity = vD.w;
  float along = vUv.x;
  float edge = 0.5 - abs(along - 0.5); // 0 at the pylons, 0.5 in the middle
  float x = along * vLen;
  vec3 col = vec3(0.0);

  // Formed part (grows from both pylons inwards) and the dissolve of a breaking bar.
  float reach = grow * 0.5;
  float formed = 1.0 - smoothstep(reach - 0.004, reach + 0.004, edge);
  float front = grow < 1.0 && grow > 0.0 ? exp(-abs(edge - reach) * vLen * 9.0) : 0.0;
  float crumble = sNoise(x * 5.0 + seed * 31.0) * 0.7 + sNoise(x * 17.0 - seed * 13.0) * 0.3;
  float alive = shatter > 0.0 ? smoothstep(shatter - 0.08, shatter + 0.08, crumble) : 1.0;
  float flicker = shatter > 0.0 ? mix(1.0, 0.35 + 0.65 * step(0.5, sHash(floor(uTime * 40.0) + seed * 7.0)), uReduced) : 1.0;

  if (vPart < 0.5) {
    float d = abs(vUv.y);
    float core = exp(-d * d / (uCoreWidth * uCoreWidth));
    float glow = exp(-d * 3.2) * (1.0 - d * d);
    float flow = sNoise(x * uFlowScale - uTime * uFlowSpeed + seed * 7.0) * 0.6
               + sNoise(x * uFlowScale * 2.7 + uTime * uFlowSpeed * 1.6 + seed) * 0.4;
    vec3 bar = uCore * core * (0.65 + 0.7 * flow) + uGlow * glow * (0.55 + 0.9 * flow);
    bar *= 1.0 + flash * uFlash;
    // Breaking: hot warning tint, fragments flare at the dissolve edge.
    float rim = shatter > 0.0 ? exp(-abs(crumble - shatter) * 18.0) : 0.0;
    bar = mix(bar, (uDamaged * (core * 3.0 + glow) + uCore * core * rim * 2.0), min(1.0, shatter * 1.6));
    col = bar * formed * alive * flicker;
    // Re-forming front and the repair ghost (hold progress) of an empty bar.
    col += uCore * (core + glow * 0.5) * front * 1.5;
    if (grow <= 0.0 && preview > 0.0) {
      float ghost = 1.0 - smoothstep(preview * 0.5 - 0.01, preview * 0.5 + 0.01, edge);
      col += (uCore * core * 0.35 + uGlow * glow * 0.25) * ghost * (0.6 + 0.4 * sin(uTime * 18.0));
    }
  } else if (vPart < 1.5) {
    vec2 p = vec2(x, vWorld.y + uTime * uDrift) / uCell;
    float lines = 1.0 - smoothstep(0.0, uLine, hexEdge(p));
    float shimmer = 0.55 + 0.45 * sNoise(x * 1.3 + vWorld.y * 2.1 - uTime * 0.7 + seed * 3.0);
    // Ripple travelling out from the last swing along the plane.
    float rx = abs(x - vD.y * vLen);
    float rr = (1.0 - vD.z) * 2.6;
    float ripple = vD.z * exp(-abs(rx - rr) * 5.0) * uReduced;
    float sides = smoothstep(0.0, 0.035, edge);
    vec3 lat = uLattice * (lines * shimmer + 0.12) * (1.0 + ripple * 5.0 + flash * 2.0);
    lat = mix(lat, uDamaged * (lines + 0.1) * 0.6, min(1.0, shatter * 1.6));
    col = lat * formed * alive * sides;
  } else if (vPart < 2.5) {
    float d = abs(vUv.y);
    float core = exp(-d * d * 30.0);
    float glow = exp(-d * 3.5) * (1.0 - d * d);
    float scan = pow(fract(vWorld.y * 0.7 - uTime * uScan + seed), 8.0);
    float warn = (1.0 - integrity) * (0.5 + 0.5 * sin(uTime * uWarnHz * 6.2831));
    vec3 c = mix(uEmitter, uDamaged, warn * mix(0.4, 1.0, uReduced));
    float ends = smoothstep(0.0, 0.04, edge);
    col = c * (core * (0.7 + 1.6 * scan) + glow * 0.35) * (0.45 + 0.55 * integrity + warn * 0.4) * ends;
  } else {
    float d = abs(vUv.y);
    float fall = exp(-d * 3.0) * (1.0 - d);
    float ends = smoothstep(0.0, 0.12, edge);
    vec3 c = mix(uDamaged * 0.5, uGlow + uCore * 0.15, integrity);
    col = c * uFloor * fall * ends * (0.35 + 0.65 * integrity);
  }
  gl_FragColor = vec4(col * vFog, 1.0);
}
`;

function hdr(rgb: readonly [number, number, number], intensity: number): Color {
  return new Color(rgb[0], rgb[1], rgb[2]).multiplyScalar(intensity);
}

export interface SealViewOptions {
  /** Lit pylon material → render.setupMaterial (CSM shadows). */
  setupMaterial?: ((m: Material) => void) | null;
  reduceFlashing?: boolean;
}

export class SealView {
  readonly mesh: Mesh;
  readonly pylons: Mesh | null;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly pylonMaterial: MeshStandardMaterial | null;
  private readonly aC: InstancedBufferAttribute;
  private readonly aD: InstancedBufferAttribute;
  private readonly rC: UpdateRange = { start: 0, count: 0 };
  private readonly rD: UpdateRange = { start: 0, count: 0 };
  /** First instance of each seal (bars, bands, emitters, floor follow). */
  private readonly first: Int32Array;
  /** Bars standing per seal at the last write, and whether that write was an idle (final) state. */
  private readonly writtenUp: Int32Array;
  private idleWritten = false;
  private readonly count: number;
  private time = 0;

  constructor(
    parent: Object3D,
    private readonly seals: readonly Seal[],
    opts: SealViewOptions = {},
  ) {
    const V = SEALS.visual;
    this.first = new Int32Array(seals.length);
    this.writtenUp = new Int32Array(seals.length).fill(-1);
    let n = 0;
    for (let i = 0; i < seals.length; i++) {
      this.first[i] = n;
      n += seals[i]!.segments * 2 + 3;
    }
    this.count = n;
    const cap = Math.max(1, n);
    const plane = new PlaneGeometry(1, 1, 1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(plane.getIndex());
    geometry.setAttribute('position', plane.getAttribute('position'));
    const aA = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const aB = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aC = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aD = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aC.setUsage(DynamicDrawUsage);
    this.aD.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aA', aA);
    geometry.setAttribute('aB', aB);
    geometry.setAttribute('aC', this.aC);
    geometry.setAttribute('aD', this.aD);
    geometry.instanceCount = n;
    this.geometry = geometry;
    this.writeStatic(aA.array as Float32Array, aB.array as Float32Array);
    plane.dispose();

    const C = V.colors;
    const I = V.intensity;
    const reduced = opts.reduceFlashing ? V.reducedFlash : 1;
    this.material = new ShaderMaterial({
      name: 'rift-seals',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uWobble: { value: V.bar.wobble },
        uCore: { value: hdr(C.core, I.core) },
        uGlow: { value: hdr(C.glow, I.glow) },
        uLattice: { value: hdr(C.lattice, I.lattice) },
        uEmitter: { value: hdr(C.emitter, I.emitter) },
        uDamaged: { value: hdr(C.damaged, I.emitter) },
        uFlash: { value: I.flash },
        uFloor: { value: I.floor },
        uCoreWidth: { value: V.bar.core * 2 },
        uFlowSpeed: { value: V.bar.flowSpeed },
        uFlowScale: { value: V.bar.flowScale },
        uCell: { value: V.lattice.cell },
        uLine: { value: V.lattice.line },
        uDrift: { value: V.lattice.drift },
        uScan: { value: V.emitter.scanSpeed },
        uWarnHz: { value: V.warnHz },
        uReduced: { value: reduced },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const mesh = new Mesh(geometry, this.material);
    mesh.name = 'RiftSeals';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = V.renderOrder;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.visible = n > 0;
    parent.add(mesh);
    this.mesh = mesh;

    const pylonGeo = seals.length > 0 ? buildPylonGeometry(seals) : null;
    if (pylonGeo) {
      const P = V.pylon;
      this.pylonMaterial = new MeshStandardMaterial({
        name: 'seal-pylon',
        color: P.color,
        metalness: P.metalness,
        roughness: P.roughness,
      });
      opts.setupMaterial?.(this.pylonMaterial);
      const pylons = new Mesh(pylonGeo, this.pylonMaterial);
      // Not a `level:` mesh: bullets, decals and line of sight pass (COMBAT.staticMeshPrefixes).
      pylons.name = 'seal-pylons';
      pylons.castShadow = false;
      pylons.receiveShadow = true;
      pylons.matrixAutoUpdate = false;
      parent.add(pylons);
      this.pylons = pylons;
    } else {
      this.pylonMaterial = null;
      this.pylons = null;
    }
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  setReducedFlashing(on: boolean): void {
    this.material.uniforms.uReduced!.value = on ? SEALS.visual.reducedFlash : 1;
  }

  /**
   * Per frame: animation state of every seal → aC/aD. Idle seals (nothing forming, breaking or
   * flashing; the warning pulse runs on uTime) are written once, then the upload is skipped.
   */
  update(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.time += dt;
    this.material.uniforms.uTime!.value = this.time;
    const n = this.count;
    if (n === 0) return;
    let busy = false;
    for (let s = 0; s < this.seals.length && !busy; s++) {
      const seal = this.seals[s]!;
      busy = seal.animating || seal.up !== this.writtenUp[s];
    }
    if (!busy && this.idleWritten) return;
    this.idleWritten = !busy;
    const c = this.aC.array as Float32Array;
    const d = this.aD.array as Float32Array;
    for (let s = 0; s < this.seals.length; s++) {
      const seal = this.seals[s]!;
      this.writtenUp[s] = seal.up;
      const segs = seal.segments;
      const integrity = seal.up / segs;
      const next = seal.up;
      let k = this.first[s]!;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < segs; i++, k++) {
          const o = k * 4;
          c[o] = seal.grow[i]!;
          c[o + 1] = seal.shatter[i]!;
          c[o + 2] = seal.flash[i]!;
          c[o + 3] = pass === 0 && i === next ? seal.preview : 0;
          d[o + 1] = seal.rippleU;
          d[o + 2] = seal.ripple;
          d[o + 3] = integrity;
        }
      }
      for (let i = 0; i < 3; i++, k++) {
        const o = k * 4;
        c[o] = 1;
        c[o + 1] = 0;
        c[o + 2] = 0;
        c[o + 3] = 0;
        d[o + 3] = integrity;
      }
    }
    setUpdateRange(this.aC, this.rC, 0, n * 4);
    setUpdateRange(this.aD, this.rD, 0, n * 4);
    this.aC.needsUpdate = true;
    this.aD.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    if (this.pylons) {
      this.pylons.removeFromParent();
      this.pylons.geometry.dispose();
    }
    this.pylonMaterial?.dispose();
  }

  /** Placement of every instance (once). */
  private writeStatic(a: Float32Array, b: Float32Array): void {
    const V = SEALS.visual;
    const d = this.aD.array as Float32Array;
    for (let s = 0; s < this.seals.length; s++) {
      const seal = this.seals[s]!;
      const f = seal.frame;
      const segs = seal.segments;
      // Pylon axis ends (world XZ) and the strips on their inner faces.
      const lx = f.cx - f.sx * f.left;
      const lz = f.cz - f.sz * f.left;
      const rx = f.cx + f.sx * f.right;
      const rz = f.cz + f.sz * f.right;
      const inset = V.pylon.stripInset;
      const band = bandHeight(f, segs);
      let k = this.first[s]!;
      const put = (
        part: number,
        ax: number,
        ay: number,
        az: number,
        bx: number,
        by: number,
        bz: number,
        size: number,
        seed: number,
      ): void => {
        const o = k * 4;
        a[o] = ax;
        a[o + 1] = ay;
        a[o + 2] = az;
        a[o + 3] = part;
        b[o] = bx;
        b[o + 1] = by;
        b[o + 2] = bz;
        b[o + 3] = size;
        d[o] = seed;
        k++;
      };
      const seedBase = s * 0.618 + 0.13;
      for (let i = 0; i < segs; i++) {
        const y = f.cy + barHeight(f, i, segs);
        put(PART_BAR, lx, y, lz, rx, y, rz, V.bar.width, fract(seedBase + i * 0.371));
      }
      for (let i = 0; i < segs; i++) {
        const y = f.cy + f.bottom + i * band;
        put(PART_BAND, lx, y, lz, rx, y, rz, band, fract(seedBase + i * 0.53));
      }
      const top = f.cy + f.height;
      const bottom = f.cy + f.bottom * 0.5;
      put(
        PART_EMITTER,
        lx + f.sx * inset,
        bottom,
        lz + f.sz * inset,
        lx + f.sx * inset,
        top,
        lz + f.sz * inset,
        V.emitter.width,
        fract(seedBase + 0.2),
      );
      put(
        PART_EMITTER,
        rx - f.sx * inset,
        bottom,
        rz - f.sz * inset,
        rx - f.sx * inset,
        top,
        rz - f.sz * inset,
        V.emitter.width,
        fract(seedBase + 0.7),
      );
      const fy = f.cy + 0.02;
      put(PART_FLOOR, lx, fy, lz, rx, fy, rz, V.floor.depth, fract(seedBase + 0.4));
    }
  }
}

function fract(v: number): number {
  return v - Math.floor(v);
}

/** Every pylon (post + base plate) of every seal merged into one static geometry. */
function buildPylonGeometry(seals: readonly Seal[]): BufferGeometry | null {
  const P = SEALS.visual.pylon;
  const parts: BufferGeometry[] = [];
  for (const seal of seals) {
    const f = seal.frame;
    const yaw = Math.atan2(f.sx, f.sz);
    const postH = f.height + P.extra;
    for (const u of [-f.left, f.right]) {
      const x = f.cx + f.sx * u;
      const z = f.cz + f.sz * u;
      const post = new BoxGeometry(P.size, postH, P.size);
      post.rotateY(yaw);
      post.translate(x, f.cy + postH / 2, z);
      const base = new BoxGeometry(P.baseSize, P.baseHeight, P.baseSize);
      base.rotateY(yaw);
      base.translate(x, f.cy + P.baseHeight / 2, z);
      parts.push(post, base);
    }
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged) merged.computeBoundingSphere();
  return merged;
}
