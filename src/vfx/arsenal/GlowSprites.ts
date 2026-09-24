/**
 * Procedural glow sprites: camera-facing quads whose look is computed in the fragment shader
 * (orb, stretched bolt, photon ring, crackling electric filaments, void rim, ice crystal, LED
 * flare, spiral swirl, dark disc, flame tongue – GLOW_SHAPES in defs/arsenalVfx.ts). ONE instanced
 * draw for every sprite of a blend mode; the instance list is rebuilt each frame by the arsenal
 * renderers (begin → push … → end) and only the live range is uploaded.
 *
 * Emissive sprites are additive; 'dark' sprites (event horizons) use normal blending with black
 * and write depth – drawn first, they hide what lies behind the core (the far side of an accretion
 * disc, infalling streaks) from the glows drawn after them. Both live on RENDER.volumetricLayer
 * (drawn after AO and fog, depth-tested; the pass's depth is discarded afterwards), fog
 * themselves like the particles, never shrink below ARSENAL_VFX.glows.minPixelSize and are pulled
 * towards the camera by size × depthPull so a glow at a wall is not cut in half by it.
 */
import * as THREE from 'three';
import { ARSENAL_VFX, GLOW_SHAPES, type GlowShape } from '../../defs/arsenalVfx';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../gpuUpload';
import { NOISE_GLSL, PIXEL_GLSL } from './glsl';

const SHAPE_INDEX = new Map<string, number>(GLOW_SHAPES.map((s, i) => [s, i]));

/** Shader id of a glow shape (0 = orb for unknown names). */
export function glowShapeIndex(shape: GlowShape | string): number {
  return SHAPE_INDEX.get(shape) ?? 0;
}

const VERTEX = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iAxis;
attribute vec4 iColor;
attribute vec4 iParams;
uniform float uViewportHeight;
uniform float uMinPx;
uniform float uDepthPull;
uniform float uMinDepth;
varying vec2 vUv;
varying float vLen;
varying vec4 vColor;
varying vec4 vParams;
${HEIGHT_FOG_GLSL}
${PIXEL_GLSL}
void main() {
  vec3 center = iPos.xyz;
  float size = iPos.w;
  vec4 mv = viewMatrix * vec4(center, 1.0);
  float depth = -mv.z;
  float minSize = uMinPx * metersPerPixel(depth, uViewportHeight);
  float energy = 1.0;
  if (size < minSize) {
    // Enlarged far sprites keep their energy (area), not their surface brightness.
    float k = size / max(minSize, 1e-6);
    energy = k * k;
    size = minSize;
  }
  vec2 corner = position.xy;
  vec2 axis;
  float len = size;
  if (iAxis.w > 0.0) {
    // Stretched along the projected flight direction; the head sits on the center.
    vec3 va = (viewMatrix * vec4(iAxis.xyz, 0.0)).xyz;
    float l2 = dot(va.xy, va.xy);
    axis = l2 > 1e-8 ? va.xy * inversesqrt(l2) : vec2(0.0, 1.0);
    len = size + iAxis.w * sqrt(min(l2, 1.0));
  } else {
    float c = cos(iParams.w);
    float s = sin(iParams.w);
    axis = vec2(-s, c);
  }
  // (perp, axis) is a rotation of the quad's (x, y), never a mirror (winding stays front-facing).
  vec2 perp = vec2(axis.y, -axis.x);
  vec2 offset = perp * (corner.x * size) + axis * (corner.y * len - 0.5 * (len - size));
  float pull = min(size * uDepthPull, max(depth - uMinDepth, 0.0));
  float k = (depth - pull) / max(depth, 1e-4);
  mv.xyz *= k;
  mv.xy += offset * k;
  gl_Position = projectionMatrix * mv;
  vLen = len / max(size, 1e-6);
  vUv = vec2(corner.x * 2.0, (corner.y * 2.0) * vLen);
  float fog = fogTransmittance(cameraPosition, center);
#ifdef DARK
  vColor = vec4(iColor.rgb, iColor.a * fog * energy);
#else
  vColor = vec4(iColor.rgb * fog * energy * iColor.a, 1.0);
#endif
  vParams = iParams;
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying float vLen;
varying vec4 vColor;
varying vec4 vParams;
${NOISE_GLSL}
void main() {
  int shape = int(vParams.x + 0.5);
  float seed = vParams.y;
  float t = vParams.z;
  vec2 p = vUv;
  float r = length(p);
  float a = 0.0;
  float core = 0.0;
  float ang = atan(p.y, p.x);
  if (shape == 0) {
    // orb: soft halo around a hot center
    a = exp(-r * r * 5.0) * 0.75 + exp(-r * 5.5) * 0.5;
    core = exp(-r * r * 40.0);
    a *= 1.0 - smoothstep(0.75, 1.0, r);
  } else if (shape == 1) {
    // bolt: capsule along the flight axis, brighter towards the head
    float along = max(abs(p.y) - (vLen - 1.0), 0.0);
    float d = length(vec2(p.x, along));
    float s = clamp((p.y + vLen) / (2.0 * vLen), 0.0, 1.0);
    float head = mix(0.25, 1.0, s * s);
    a = (exp(-d * d * 6.0) + 0.3 * exp(-d * 3.0)) * head * (1.0 - smoothstep(0.8, 1.0, d));
    core = exp(-d * d * 30.0) * head;
  } else if (shape == 2) {
    // photon ring
    float band = exp(-pow((r - 0.62) / 0.07, 2.0));
    float wob = 0.8 + 0.2 * aNoise(vec2(ang * 3.0 + seed * 7.0, t * 2.0));
    a = band * wob;
    a *= 1.0 - smoothstep(0.85, 1.0, r);
    core = band * 0.35;
  } else if (shape == 3) {
    // electric: crackling filaments around a bright core, re-shaped many times a second
    float tt = floor(t * 24.0);
    float n1 = aNoise(vec2(ang * 2.4 + seed * 13.0 + tt * 1.7, r * 3.0 - tt * 0.9));
    float n2 = aNoise(vec2(ang * 3.9 - seed * 7.0 - tt * 2.3, r * 4.5 + tt * 1.3));
    float fil = aRidge(n1, 16.0) + aRidge(n2, 22.0) * 0.8;
    float fade = 1.0 - smoothstep(0.2, 0.95, r);
    a = fil * fade * 1.5 + exp(-r * r * 14.0) * 0.9 + exp(-r * 5.0) * 0.18;
    core = exp(-r * r * 50.0) + fil * fade * 0.35;
    a *= 1.0 - smoothstep(0.85, 1.0, r);
  } else if (shape == 4) {
    // void rim: dark inside, a thin bright photon edge, swirling violet matter outside
    float edge = exp(-pow((r - 0.42) / 0.03, 2.0));
    float rim = exp(-pow((r - 0.55) / 0.13, 2.0));
    float sw = 0.5 + 0.5 * sin(ang * 3.0 + r * 11.0 + seed * 6.28);
    float n = aFbm(vec2(ang * 1.6 + seed * 3.0, r * 4.0 - t * 1.4));
    a = rim * (0.35 + 1.1 * sw * n) + edge * 0.9;
    a *= smoothstep(0.34, 0.41, r) * (1.0 - smoothstep(0.8, 1.0, r));
    core = edge * 0.8;
  } else if (shape == 5) {
    // crystal: six-pointed ice star with faceted glints
    float sp = pow(abs(cos(ang * 3.0)), 24.0) + pow(abs(cos(ang * 3.0 + 0.5236)), 40.0) * 0.5;
    float star = exp(-r * (2.4 + 14.0 * (1.0 - min(sp, 1.0))));
    float facet = 0.7 + 0.3 * aNoise(vec2(ang * 4.0 + seed * 9.0, r * 7.0 + t * 0.5));
    a = star * facet + exp(-r * r * 10.0) * 0.45;
    a *= 1.0 - smoothstep(0.8, 1.0, r);
    core = exp(-r * r * 45.0) + star * 0.2;
  } else if (shape == 6) {
    // LED flare: anamorphic streak + hot dot
    a = exp(-abs(p.y) * 24.0) * exp(-abs(p.x) * 3.0) * 0.8
      + exp(-abs(p.x) * 26.0) * exp(-abs(p.y) * 6.0) * 0.25
      + exp(-r * r * 26.0);
    a *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));
    core = exp(-r * r * 140.0);
  } else if (shape == 7) {
    // swirl: spiral arms of glowing matter
    float lr = log(max(r, 1e-3));
    float arms = 0.5 + 0.5 * cos(ang * 2.0 + lr * 7.0 + seed * 6.28);
    float n = aFbm(vec2(ang * 2.0 + seed * 5.0, lr * 3.0 - t * 0.6));
    // Hollow: it swirls around a dark core, never over it.
    a = pow(arms, 2.5) * (0.35 + n) * smoothstep(0.26, 0.42, r) * (1.0 - smoothstep(0.55, 1.0, r));
  } else if (shape == 8) {
    // dark disc (event horizon): opaque black with a soft edge
    a = 1.0 - smoothstep(0.6, 1.0, r);
  } else if (shape == 10) {
    // halo: a hollow glow around a dark core
    a = smoothstep(0.24, 0.34, r) * exp(-(r - 0.34) * 4.0) * (1.0 - smoothstep(0.8, 1.0, r));
  } else {
    // flame tongue: base at the head, flickering tip trailing behind
    float s = clamp((p.y + vLen) / (2.0 * vLen), 0.0, 1.0);
    float width = 0.25 + 0.75 * pow(s, 0.6);
    float n = aNoise(vec2(p.x * 2.5 + seed * 11.0, s * 3.0 + t * 11.0));
    float d = abs(p.x) / width + (1.0 - s) * 0.35 + (n - 0.5) * 0.45;
    a = (1.0 - smoothstep(0.2, 0.95, d)) * smoothstep(0.0, 0.3, s) * (1.0 - smoothstep(0.92, 1.0, s));
    core = (1.0 - smoothstep(0.0, 0.45, d)) * s;
  }
#ifdef DARK
  // Dark discs write depth (the far half of an accretion disc hides behind the event horizon):
  // the faint rim must not, or it would cut a hard edge into what is drawn behind it.
  float alpha = a * vColor.a;
  if (alpha < 0.3) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
#else
  vec3 hot = vec3(max(vColor.r, max(vColor.g, vColor.b)));
  vec3 rgb = vColor.rgb * a + hot * core * 0.6;
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
#endif
}
`;

const _viewport = new THREE.Vector4();

export class GlowSprites {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly axis: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly ranges: UpdateRange[];
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly viewportHeight = { value: 1080 };
  private n = 0;
  private warming = false;

  constructor(capacity: number, dark: boolean) {
    const g = ARSENAL_VFX.glows;
    this.capacity = Math.max(1, capacity);
    this.pos = new Float32Array(this.capacity * 4);
    this.axis = new Float32Array(this.capacity * 4);
    this.color = new Float32Array(this.capacity * 4);
    this.params = new Float32Array(this.capacity * 4);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, array: Float32Array): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(array, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    this.attrs = [
      attr('iPos', this.pos),
      attr('iAxis', this.axis),
      attr('iColor', this.color),
      attr('iParams', this.params),
    ];
    this.ranges = this.attrs.map(() => ({ start: 0, count: 0 }));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      name: dark ? 'ArsenalGlowDark' : 'ArsenalGlow',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: dark ? { DARK: '' } : {},
      uniforms: {
        uViewportHeight: this.viewportHeight,
        uMinPx: { value: g.minPixelSize },
        // Dark discs sit exactly at their core depth (they write it); glows are pulled forward.
        uDepthPull: { value: dark ? 0 : g.depthPull },
        uMinDepth: { value: g.depthPullMinDistance },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: dark,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = dark ? 'ArsenalGlowDark' : 'ArsenalGlow';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = dark ? g.darkRenderOrder : g.renderOrder;
    mesh.visible = false;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_viewport);
      this.viewportHeight.value = Math.max(1, _viewport.w);
    };
    this.mesh = mesh;
  }

  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * Queue one sprite. `size`: quad edge (m); (ax, ay, az) unit flight axis and `stretch` extra
   * length (m, 0 = round, rotated by `rotation`); rgb × `alpha` (dark: black × alpha coverage).
   */
  push(
    x: number,
    y: number,
    z: number,
    size: number,
    shape: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    seed: number,
    time: number,
    rotation = 0,
    ax = 0,
    ay = 0,
    az = 0,
    stretch = 0,
  ): boolean {
    if (this.n >= this.capacity || !(size > 0) || !(alpha > 0)) return false;
    const o = this.n * 4;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.pos[o + 3] = size;
    this.axis[o] = ax;
    this.axis[o + 1] = ay;
    this.axis[o + 2] = az;
    this.axis[o + 3] = stretch;
    this.color[o] = r;
    this.color[o + 1] = g;
    this.color[o + 2] = b;
    this.color[o + 3] = alpha;
    this.params[o] = shape;
    this.params[o + 1] = seed;
    this.params[o + 2] = time;
    this.params[o + 3] = rotation;
    this.n++;
    return true;
  }

  end(): void {
    if (this.warming) return;
    const n = this.n;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i]!;
      setUpdateRange(a, this.ranges[i]!, 0, n * 4);
      a.needsUpdate = true;
    }
  }

  /** Shader warm-up: one invisible instance per shape family so the program compiles now. */
  setWarmup(active: boolean): void {
    this.warming = active;
    if (active) {
      this.pos.fill(0, 0, 4);
      this.color.fill(0, 0, 4);
      this.params.fill(0, 0, 4);
      this.axis.fill(0, 0, 4);
      for (let i = 0; i < this.attrs.length; i++) {
        const a = this.attrs[i]!;
        setUpdateRange(a, this.ranges[i]!, 0, 4);
        a.needsUpdate = true;
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
