/**
 * Bullet tracers: pooled, very short-lived HDR streaks from the muzzle to the impact. The head
 * travels at VFX.tracers.speed (travel time clamped to [minTravel, maxTravel]) with a tail of up
 * to `tailLength` behind it; after arrival the tail catches up with the impact over `fadeTime`.
 *
 * Rendering: ONE instanced draw of camera-facing ribbons (tail → head segment per instance,
 * built in the vertex shader, at least `minPixelWidth` wide so far tracers never shimmer).
 * Additive, on RENDER.volumetricLayer (drawn after fog, fogged in the shader, no depth write).
 */
import * as THREE from 'three';
import type { Vec3Like } from '../core/events';
import { RENDER } from '../defs/graphics';
import { VFX } from '../defs/vfx';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from './gpuUpload';

export interface TracerSegment {
  /** Distances from the start along the tracer (m). */
  head: number;
  tail: number;
  /** 0..1 brightness. */
  alpha: number;
}

/** Travel time of a tracer over `dist` meters. */
export function tracerTravelTime(dist: number): number {
  const t = VFX.tracers;
  return Math.min(t.maxTravel, Math.max(t.minTravel, dist / t.speed));
}

/**
 * Head/tail distances at `age` for a tracer of length `dist`. Returns false once it is over.
 * Pure (unit-tested).
 */
export function tracerSegment(
  age: number,
  travel: number,
  fade: number,
  dist: number,
  tailLength: number,
  out: TracerSegment,
): boolean {
  if (!(dist > 0) || age >= travel + fade) return false;
  const tailLen = Math.min(tailLength, dist);
  if (age <= travel) {
    out.head = dist * Math.max(0, age / Math.max(travel, 1e-6));
    out.tail = Math.max(0, out.head - tailLen);
    out.alpha = 1;
  } else {
    const k = fade > 0 ? (age - travel) / fade : 1;
    out.head = dist;
    out.tail = Math.min(dist, dist - tailLen * (1 - k));
    out.alpha = 1 - k * k;
  }
  return true;
}

const VERTEX = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec3 iColor;
uniform float uViewportHeight;
uniform float uMinPx;
varying vec2 vUv;
varying vec3 vColor;
${HEIGHT_FOG_GLSL}
void main() {
  vec3 a = (viewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(iB.xyz, 1.0)).xyz;
  vec3 p = mix(a, b, position.x);
  vec3 side = cross(b - a, p);
  float len = length(side);
  side = len > 1e-6 ? side / len : vec3(1.0, 0.0, 0.0);
  // Meters per pixel at this depth: keep a minimum on-screen width.
  float mpp = max(-p.z, 1e-3) / (projectionMatrix[1][1] * 0.5 * uViewportHeight);
  float w = max(iA.w, uMinPx * mpp) * 0.5;
  p += side * (position.y * w);
  gl_Position = projectionMatrix * vec4(p, 1.0);
  vUv = position.xy;
  vec3 mid = mix(iA.xyz, iB.xyz, position.x);
  vColor = iColor * iB.w * fogTransmittance(cameraPosition, mid);
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float across = 1.0 - abs(vUv.y);
  float a = across * across * (0.15 + 0.85 * vUv.x * vUv.x);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const _vp = new THREE.Vector4();
const _seg: TracerSegment = { head: 0, tail: 0, alpha: 0 };

export class TracerSystem {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly from: Float32Array;
  private readonly dir: Float32Array;
  private readonly dist: Float32Array;
  private readonly travel: Float32Array;
  private readonly age: Float32Array;
  private readonly color: Float32Array;
  private readonly alive: Uint8Array;
  private next = 0;
  private _count = 0;
  private readonly aArr: Float32Array;
  private readonly bArr: Float32Array;
  private readonly cArr: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly ranges: UpdateRange[];
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const t = VFX.tracers;
    const n = Math.max(1, t.capacity);
    this.capacity = n;
    this.from = new Float32Array(n * 3);
    this.dir = new Float32Array(n * 3);
    this.dist = new Float32Array(n);
    this.travel = new Float32Array(n);
    this.age = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.alive = new Uint8Array(n);
    this.aArr = new Float32Array(n * 4);
    this.bArr = new Float32Array(n * 4);
    this.cArr = new Float32Array(n * 3);

    const geo = new THREE.InstancedBufferGeometry();
    // x: 0 = tail, 1 = head; y: -1..1 across.
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, arr: Float32Array, size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.attrs = [attr('iA', this.aArr, 4), attr('iB', this.bArr, 4), attr('iColor', this.cArr, 3)];
    this.ranges = this.attrs.map(() => ({ start: 0, count: 0 }));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      name: 'VfxTracers',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uViewportHeight: { value: 1080 },
        uMinPx: { value: t.minPixelWidth },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'VfxTracers';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = t.renderOrder;
    mesh.visible = false;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_vp);
      (this.material.uniforms.uViewportHeight as THREE.IUniform<number>).value = Math.max(1, _vp.w);
    };
    this.mesh = mesh;
  }

  get count(): number {
    return this._count;
  }

  /** Start a tracer; `color` is linear RGB hex, multiplied by `intensity` (HDR). */
  spawn(from: Vec3Like, to: Vec3Like, color: number, intensity: number = VFX.tracers.intensity): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 1e-3) || !Number.isFinite(d)) return false;
    // Ring allocation: the oldest tracer is reused when all are busy (they live < 0.1 s).
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (!this.alive[i]) this._count++;
    this.alive[i] = 1;
    this.from[i * 3] = from.x;
    this.from[i * 3 + 1] = from.y;
    this.from[i * 3 + 2] = from.z;
    this.dir[i * 3] = dx / d;
    this.dir[i * 3 + 1] = dy / d;
    this.dir[i * 3 + 2] = dz / d;
    this.dist[i] = d;
    this.travel[i] = tracerTravelTime(d);
    this.age[i] = 0;
    const k = intensity / 255;
    this.color[i * 3] = ((color >> 16) & 0xff) * k;
    this.color[i * 3 + 1] = ((color >> 8) & 0xff) * k;
    this.color[i * 3 + 2] = (color & 0xff) * k;
    return true;
  }

  update(dt: number): void {
    const t = VFX.tracers;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i]! + Math.max(0, dt);
      this.age[i] = age;
      if (!tracerSegment(age, this.travel[i]!, t.fadeTime, this.dist[i]!, t.tailLength, _seg)) {
        this.alive[i] = 0;
        this._count--;
        continue;
      }
      const fx = this.from[i * 3]!;
      const fy = this.from[i * 3 + 1]!;
      const fz = this.from[i * 3 + 2]!;
      const dx = this.dir[i * 3]!;
      const dy = this.dir[i * 3 + 1]!;
      const dz = this.dir[i * 3 + 2]!;
      const o = n * 4;
      this.aArr[o] = fx + dx * _seg.tail;
      this.aArr[o + 1] = fy + dy * _seg.tail;
      this.aArr[o + 2] = fz + dz * _seg.tail;
      this.aArr[o + 3] = t.width;
      this.bArr[o] = fx + dx * _seg.head;
      this.bArr[o + 1] = fy + dy * _seg.head;
      this.bArr[o + 2] = fz + dz * _seg.head;
      this.bArr[o + 3] = _seg.alpha;
      const c = n * 3;
      this.cArr[c] = this.color[i * 3]!;
      this.cArr[c + 1] = this.color[i * 3 + 1]!;
      this.cArr[c + 2] = this.color[i * 3 + 2]!;
      n++;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k]!;
      setUpdateRange(a, this.ranges[k]!, 0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  /** Shader warm-up: draw one zero-brightness instance while active (see ParticleSystem.setWarmup). */
  setWarmup(active: boolean): void {
    if (!active) {
      this.update(0);
      return;
    }
    this.bArr[3] = 0;
    this.cArr[0] = this.cArr[1] = this.cArr[2] = 0;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k]!;
      setUpdateRange(a, this.ranges[k]!, 0, a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = 1;
    this.mesh.visible = true;
  }

  clear(): void {
    this.alive.fill(0);
    this._count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
