/**
 * Camera-facing strips: projectile ribbons, lightning bolts and chain arcs, flame cores, rail and
 * void rays. A strip is a polyline (point, width, colour, opacity); every segment between two
 * points is one instance of a quad expanded in the vertex shader. Each end's side vector comes
 * from the tangent through its NEIGHBOURS (miter-like), so consecutive segments share their edge
 * vertices exactly – no gaps or overlapping bright joints on bent ribbons.
 *
 * ONE instanced draw for all strips (profiles: STRIP_STYLES in defs/arsenalVfx.ts – soft glow,
 * electric, void, rail helix, fire, frost), rebuilt every frame (begin → strips → end), only the
 * live range uploaded. Additive on RENDER.volumetricLayer, fogged in the shader, at least
 * ARSENAL_VFX.strips.minPixelWidth wide on screen.
 */
import * as THREE from 'three';
import { ARSENAL_VFX, STRIP_STYLES, type StripStyle } from '../../defs/arsenalVfx';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../gpuUpload';
import { NOISE_GLSL, PIXEL_GLSL } from './glsl';

const STYLE_INDEX = new Map<string, number>(STRIP_STYLES.map((s, i) => [s, i]));

export function stripStyleIndex(style: StripStyle | string): number {
  return STYLE_INDEX.get(style) ?? 0;
}

/** Points one strip may have (bolts, ribbons); extra points are ignored. */
export const MAX_STRIP_POINTS = 64;
/** Floats per buffered strip point: xyz, width, rgb, alpha. */
const PF = 8;

const VERTEX = /* glsl */ `
attribute vec4 iP0;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iP3;
attribute vec4 iColA;
attribute vec4 iColB;
attribute vec2 iUv;
uniform float uViewportHeight;
uniform float uMinPx;
uniform float uMaxAngular;
varying vec3 vColor;
varying vec2 vUv;
varying vec2 vStyle;
${HEIGHT_FOG_GLSL}
${PIXEL_GLSL}
void main() {
  bool atA = position.x < 0.5;
  vec3 a = (viewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(iB.xyz, 1.0)).xyz;
  vec3 p = atA ? a : b;
  // Tangent through the neighbours: both segments sharing a point build the same edge there.
  vec3 tang = atA ? b - (viewMatrix * vec4(iP0.xyz, 1.0)).xyz : (viewMatrix * vec4(iP3.xyz, 1.0)).xyz - a;
  vec3 side = cross(tang, p);
  float len = length(side);
  side = len > 1e-9 ? side / len : vec3(1.0, 0.0, 0.0);
  // Never wider than uMaxAngular rad as seen from the eye: a beam leaving the muzzle half a meter
  // away would otherwise fill the screen with its halo (it widens to full width further out).
  float w = min(atA ? iA.w : iB.w, max(-p.z, 0.0) * uMaxAngular);
  float minW = uMinPx * metersPerPixel(-p.z, uViewportHeight);
  float energy = 1.0;
  if (w < minW) {
    energy = w / max(minW, 1e-6);
    w = minW;
  }
  p += side * (position.y * w * 0.5);
  gl_Position = projectionMatrix * vec4(p, 1.0);
  vec4 col = atA ? iColA : iColB;
  vec3 world = atA ? iA.xyz : iB.xyz;
  vColor = col.rgb * col.a * energy * fogTransmittance(cameraPosition, world);
  vUv = vec2(atA ? iUv.x : iUv.y, position.y);
  vStyle = vec2(iP0.w, iP3.w);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFlicker;
varying vec3 vColor;
varying vec2 vUv;
varying vec2 vStyle;
${NOISE_GLSL}
void main() {
  int style = int(vStyle.x + 0.5);
  float seed = vStyle.y;
  float y = vUv.y;
  float u = vUv.x;
  float ay = abs(y);
  float a = 0.0;
  float core = 0.0;
  if (style == 0) {
    float across = 1.0 - ay;
    a = across * across * 0.55 + pow(across, 8.0) * 0.8;
    core = pow(across, 18.0);
  } else if (style == 1) {
    // 30 Hz crackle; steady with reduce flashing (uFlicker 0).
    float fl = mix(0.85, 0.7 + 0.3 * aNoise(vec2(u * 3.0 + seed * 17.0, floor(uTime * 30.0))), uFlicker);
    a = (exp(-y * y * 16.0) + exp(-y * y * 2.5) * 0.22) * fl;
    core = exp(-y * y * 70.0);
  } else if (style == 2) {
    float spiral = 0.5 + 0.5 * sin(u * 4.0 - uTime * 12.0 + y * 2.5 + seed * 6.28);
    float n = aFbm(vec2(u * 1.3 - uTime * 2.5, y * 1.4 + seed));
    float edge = exp(-pow((ay - 0.58) / 0.22, 2.0));
    a = edge * (0.3 + 1.1 * spiral * n) + exp(-y * y * 40.0) * 0.18;
    core = exp(-pow((ay - 0.58) / 0.07, 2.0)) * 0.35;
  } else if (style == 3) {
    float ph = u * 6.5 - uTime * 16.0 + seed * 6.28;
    float h1 = exp(-pow((y - 0.62 * sin(ph)) / 0.12, 2.0));
    float h2 = exp(-pow((y - 0.62 * sin(ph + 3.1416)) / 0.12, 2.0));
    a = exp(-y * y * 38.0) * 1.1 + (h1 + h2) * 0.55 + exp(-y * y * 3.0) * 0.12;
    core = exp(-y * y * 90.0);
  } else if (style == 4) {
    float n = aFbm(vec2(u * 2.2 - uTime * 9.0, y * 1.6 + seed * 3.0));
    a = (1.0 - smoothstep(0.1, 1.0, ay + (n - 0.5) * 0.9)) * (0.55 + 0.8 * n);
    core = (1.0 - smoothstep(0.0, 0.45, ay)) * n;
  } else {
    float n = aNoise(vec2(u * 9.0 + seed * 5.0, y * 3.0));
    float glint = step(0.9, aNoise(vec2(u * 28.0 + floor(uTime * 12.0) * 3.7, y * 6.0 + seed)));
    a = exp(-y * y * 6.0) * (0.55 + 0.45 * n) + glint * 0.9 * (1.0 - ay);
    core = exp(-y * y * 45.0) * 0.6;
  }
  vec3 hot = vec3(max(vColor.r, max(vColor.g, vColor.b)));
  vec3 rgb = vColor * a + hot * core * 0.5;
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

const _viewport = new THREE.Vector4();

export class StripBatch {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly p0: Float32Array;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly p3: Float32Array;
  private readonly colA: Float32Array;
  private readonly colB: Float32Array;
  private readonly uv: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly ranges: UpdateRange[];
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly viewportHeight = { value: 1080 };
  private readonly time: { value: number };
  /** 1: electric strips crackle; 0 with reduce flashing (ArsenalVfx.setFlashScale). */
  readonly flicker = { value: 1 };
  private n = 0;
  private warming = false;
  /** The strip being built: buffered points (PF floats each). */
  private readonly pts = new Float32Array(MAX_STRIP_POINTS * PF);
  private np = 0;
  private stripStyle = 0;
  private stripSeed = 0;
  private stripU0 = 0;
  private stripUDir = 1;

  constructor(capacity: number, time: { value: number }) {
    this.capacity = Math.max(1, capacity);
    this.time = time;
    const c = this.capacity;
    this.p0 = new Float32Array(c * 4);
    this.a = new Float32Array(c * 4);
    this.b = new Float32Array(c * 4);
    this.p3 = new Float32Array(c * 4);
    this.colA = new Float32Array(c * 4);
    this.colB = new Float32Array(c * 4);
    this.uv = new Float32Array(c * 2);
    const geometry = new THREE.InstancedBufferGeometry();
    // x: 0 = end A, 1 = end B; y: side −1..1.
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, array: Float32Array, size: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(array, size);
      at.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, at);
      return at;
    };
    this.attrs = [
      attr('iP0', this.p0, 4),
      attr('iA', this.a, 4),
      attr('iB', this.b, 4),
      attr('iP3', this.p3, 4),
      attr('iColA', this.colA, 4),
      attr('iColB', this.colB, 4),
      attr('iUv', this.uv, 2),
    ];
    this.ranges = this.attrs.map(() => ({ start: 0, count: 0 }));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      name: 'ArsenalStrips',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uViewportHeight: this.viewportHeight,
        uMinPx: { value: ARSENAL_VFX.strips.minPixelWidth },
        uMaxAngular: { value: ARSENAL_VFX.strips.maxAngularWidth },
        uTime: this.time,
        uFlicker: this.flicker,
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'ArsenalStrips';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = ARSENAL_VFX.strips.renderOrder;
    mesh.visible = false;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_viewport);
      this.viewportHeight.value = Math.max(1, _viewport.w);
    };
    this.mesh = mesh;
  }

  /** Segments queued this frame. */
  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
    this.np = 0;
  }

  /**
   * Start a strip. `u0`: pattern coordinate (m) of the first point, `uDir` its direction along
   * the strip (trails pass the head's odometer and −1, so their pattern stays put in the world).
   */
  beginStrip(style: number, seed: number, u0 = 0, uDir = 1): void {
    this.np = 0;
    this.stripStyle = style;
    this.stripSeed = seed;
    this.stripU0 = u0;
    this.stripUDir = uDir;
  }

  /** Append a point (rgb is HDR, `alpha` 0..1 scales it). Returns false once the strip is full. */
  point(
    x: number,
    y: number,
    z: number,
    width: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): boolean {
    if (this.np >= MAX_STRIP_POINTS) return false;
    const o = this.np * PF;
    const p = this.pts;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    p[o + 3] = width;
    p[o + 4] = r;
    p[o + 5] = g;
    p[o + 6] = b;
    p[o + 7] = alpha;
    this.np++;
    return true;
  }

  /** Emit the buffered strip's segments (skips degenerate ones). Returns segments written. */
  endStrip(): number {
    const np = this.np;
    this.np = 0;
    if (np < 2) return 0;
    const p = this.pts;
    let u = this.stripU0;
    let written = 0;
    for (let i = 0; i < np - 1; i++) {
      if (this.n >= this.capacity) break;
      const ia = i * PF;
      const ib = ia + PF;
      const i0 = i > 0 ? ia - PF : ia;
      const i3 = i + 2 < np ? ib + PF : ib;
      const len = Math.hypot(p[ib]! - p[ia]!, p[ib + 1]! - p[ia + 1]!, p[ib + 2]! - p[ia + 2]!);
      const uB = u + len * this.stripUDir;
      if (len > 1e-5) {
        const o = this.n * 4;
        this.p0[o] = p[i0]!;
        this.p0[o + 1] = p[i0 + 1]!;
        this.p0[o + 2] = p[i0 + 2]!;
        this.p0[o + 3] = this.stripStyle;
        for (let k = 0; k < 4; k++) {
          this.a[o + k] = p[ia + k]!;
          this.b[o + k] = p[ib + k]!;
          this.colA[o + k] = p[ia + 4 + k]!;
          this.colB[o + k] = p[ib + 4 + k]!;
        }
        this.p3[o] = p[i3]!;
        this.p3[o + 1] = p[i3 + 1]!;
        this.p3[o + 2] = p[i3 + 2]!;
        this.p3[o + 3] = this.stripSeed;
        this.uv[this.n * 2] = u;
        this.uv[this.n * 2 + 1] = uB;
        this.n++;
        written++;
      }
      u = uB;
    }
    return written;
  }

  end(): void {
    if (this.warming) return;
    const n = this.n;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let i = 0; i < this.attrs.length; i++) {
      const at = this.attrs[i]!;
      setUpdateRange(at, this.ranges[i]!, 0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }

  setWarmup(active: boolean): void {
    this.warming = active;
    if (active) {
      for (const arr of [this.p0, this.a, this.b, this.p3, this.colA, this.colB]) arr.fill(0, 0, 4);
      this.b[2] = -1;
      this.uv.fill(0, 0, 2);
      for (let i = 0; i < this.attrs.length; i++) {
        const at = this.attrs[i]!;
        setUpdateRange(at, this.ranges[i]!, 0, at.itemSize);
        at.needsUpdate = true;
      }
      this.geometry.instanceCount = 1;
      this.mesh.visible = true;
    } else {
      this.n = 0;
      this.end();
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
