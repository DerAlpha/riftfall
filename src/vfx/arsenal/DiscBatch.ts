/**
 * Flat procedural discs of the lingering fields: the singularity's accretion disc (horizontal
 * through the core), burning pools, toxic puddles and spreading rime on the floor (DISC_STYLES in
 * defs/arsenalVfx.ts). ONE instanced additive draw on RENDER.volumetricLayer, depth-tested against
 * the world with a polygon offset + small lift (no z-fighting with the floor), fogged in the
 * shader, rebuilt every frame by the field renderer.
 */
import * as THREE from 'three';
import { ARSENAL_VFX, DISC_STYLES, type DiscStyle } from '../../defs/arsenalVfx';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../gpuUpload';
import { NOISE_GLSL } from './glsl';

const STYLE_INDEX = new Map<string, number>(DISC_STYLES.map((s, i) => [s, i]));

export function discStyleIndex(style: DiscStyle | string): number {
  return STYLE_INDEX.get(style) ?? 0;
}

const VERTEX = /* glsl */ `
attribute vec4 iCenter;
attribute vec4 iNormal;
attribute vec4 iColor;
attribute vec4 iParams;
varying vec2 vP;
varying vec4 vColor;
varying vec4 vParams;
${HEIGHT_FOG_GLSL}
void main() {
  vec3 n = normalize(iNormal.xyz);
  vec3 ref = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(ref, n));
  vec3 t2 = cross(n, t1);
  float c = cos(iNormal.w);
  float s = sin(iNormal.w);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  vec3 world = iCenter.xyz + (t1 * q.x + t2 * q.y) * iCenter.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vP = position.xy;
  vColor = vec4(iColor.rgb * iColor.a * fogTransmittance(cameraPosition, world), 1.0);
  vParams = iParams;
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vP;
varying vec4 vColor;
varying vec4 vParams;
${NOISE_GLSL}
void main() {
  int style = int(vParams.x + 0.5);
  float seed = vParams.y;
  float t = vParams.z;
  float grow = vParams.w;
  vec2 p = vP;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float a = 0.0;
  float core = 0.0;
  vec3 tint = vec3(1.0);
  if (style == 0) {
    // accretion disc: differential rotation (inner matter orbits faster), hot inner edge
    float inner = 0.3;
    float w = t * 2.4 / max(r, 0.2);
    vec2 q = mat2(cos(w), -sin(w), sin(w), cos(w)) * p;
    float n = aFbm(q * 3.6 + seed * 3.0);
    float lanes = aRidge(aNoise(vec2(r * 14.0, 0.0) + q * 1.5), 3.0);
    float heat = pow(1.0 - smoothstep(inner, 1.0, r), 1.6);
    float band = smoothstep(inner, inner + 0.05, r) * (1.0 - smoothstep(0.45, 1.0, r));
    // Streaky orbiting matter, hotter towards the inner edge; a thin bright inner rim.
    a = band * pow(n, 1.6) * (0.5 + 0.9 * lanes) * (0.25 + heat * 1.2);
    a += exp(-pow((r - inner - 0.015) / 0.015, 2.0)) * 0.8;
    core = band * heat * heat * n * 0.6;
    tint = mix(vec3(0.5, 0.3, 1.0), vec3(1.0, 0.85, 1.0), heat * 0.35);
  } else if (style == 1) {
    // burning pool: domain-warped burning patches, glowing specks, ragged spreading edge
    vec2 q = p * 2.6 + seed * 7.0;
    vec2 warp = vec2(aFbm(q + vec2(0.0, -t * 0.7)), aFbm(q + vec2(5.2, 1.3) - t * 0.5));
    float n = aFbm(q + warp * 1.7 + vec2(0.0, -t * 1.1));
    float reach = min(1.0, grow);
    float edge = 1.0 - smoothstep(reach * 0.55, reach, r + (n - 0.5) * 0.4);
    float heat = smoothstep(0.38, 0.8, n);
    float specks = pow(aNoise(p * 16.0 + seed * 3.0 + floor(t * 6.0) * 0.37), 7.0) * 2.5;
    a = edge * (heat * 1.3 + specks * (1.0 - heat) + 0.04);
    core = edge * heat * heat * heat;
    tint = mix(vec3(0.75, 0.16, 0.05), vec3(1.0, 0.9, 0.55), heat * heat);
  } else if (style == 2) {
    // toxic puddle: slow murky swirl, caustic ripples, popping bubbles
    float n = aFbm(p * 2.0 + vec2(seed, t * 0.12));
    float reach = min(1.0, grow);
    float puddle = 1.0 - smoothstep(reach * 0.55, reach, r + (n - 0.5) * 0.4);
    vec2 cp = p * 5.0 + seed * 3.0;
    vec2 cell = floor(cp);
    vec2 f = fract(cp) - 0.5;
    float h = aHash(cell);
    float ph = fract(t * (0.35 + h * 0.5) + h * 7.0);
    float bub = exp(-pow((length(f) - ph * 0.3) / 0.025, 2.0)) * (1.0 - ph) * step(0.72, h);
    float caustic = aRidge(aNoise(p * 6.0 + vec2(t * 0.35, -t * 0.25)), 6.0);
    // Murky: dark troughs, glowing sludge only where the noise pools.
    float sludge = smoothstep(0.35, 0.75, n);
    a = puddle * (0.06 + 0.45 * sludge + caustic * 0.22 * sludge + bub * 1.3);
    core = puddle * bub * 0.4;
  } else {
    // rime: crystal spikes race out from the center, veins, glittering ice
    float n = aFbm(p * 3.0 + seed);
    float reach = min(1.0, grow) * (0.88 + 0.12 * n);
    float spikes = pow(abs(sin(ang * 9.0 + (aNoise(p * 2.5 + seed) - 0.5) * 4.0)), 10.0);
    float veins = aRidge(aNoise(p * 9.0 + seed * 3.0), 14.0) * 0.55 + aRidge(aNoise(p * 19.0 - seed), 18.0) * 0.35;
    float cover = 1.0 - smoothstep(reach - 0.3, reach, r + (1.0 - spikes) * 0.18);
    float front = exp(-pow((r - reach) / 0.05, 2.0)) * step(grow, 0.999);
    float glint = step(0.93, aNoise(p * 38.0 + floor(t * 7.0) * 1.37)) * 1.6;
    a = cover * (0.12 + 0.22 * n + veins * 0.85 + spikes * 0.25 + glint) + front * 0.5;
    core = cover * (veins * 0.25 + glint * 0.4);
  }
  a *= 1.0 - smoothstep(0.9, 1.0, r);
  vec3 hot = vec3(max(vColor.r, max(vColor.g, vColor.b)));
  vec3 rgb = vColor.rgb * tint * a + hot * core * 0.4;
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

export class DiscBatch {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly center: Float32Array;
  private readonly normal: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly ranges: UpdateRange[];
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private n = 0;
  private warming = false;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    const c = this.capacity;
    this.center = new Float32Array(c * 4);
    this.normal = new Float32Array(c * 4);
    this.color = new Float32Array(c * 4);
    this.params = new Float32Array(c * 4);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, array: Float32Array): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(array, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, at);
      return at;
    };
    this.attrs = [
      attr('iCenter', this.center),
      attr('iNormal', this.normal),
      attr('iColor', this.color),
      attr('iParams', this.params),
    ];
    this.ranges = this.attrs.map(() => ({ start: 0, count: 0 }));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      name: 'ArsenalDiscs',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { fogParams: HEIGHT_FOG_PARAMS },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'ArsenalDiscs';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = ARSENAL_VFX.discs.renderOrder;
    mesh.visible = false;
    mesh.layers.set(RENDER.volumetricLayer);
    this.mesh = mesh;
  }

  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  /** Queue a disc: center, radius, unit normal, pattern rotation, HDR rgb × fade, style/seed/age/growth. */
  push(
    x: number,
    y: number,
    z: number,
    radius: number,
    nx: number,
    ny: number,
    nz: number,
    rotation: number,
    r: number,
    g: number,
    b: number,
    fade: number,
    style: number,
    seed: number,
    age: number,
    growth: number,
  ): boolean {
    if (this.n >= this.capacity || !(radius > 0) || !(fade > 0)) return false;
    const o = this.n * 4;
    this.center[o] = x;
    this.center[o + 1] = y;
    this.center[o + 2] = z;
    this.center[o + 3] = radius;
    this.normal[o] = nx;
    this.normal[o + 1] = ny;
    this.normal[o + 2] = nz;
    this.normal[o + 3] = rotation;
    this.color[o] = r;
    this.color[o + 1] = g;
    this.color[o + 2] = b;
    this.color[o + 3] = fade;
    this.params[o] = style;
    this.params[o + 1] = seed;
    this.params[o + 2] = age;
    this.params[o + 3] = growth;
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
      const at = this.attrs[i]!;
      setUpdateRange(at, this.ranges[i]!, 0, n * 4);
      at.needsUpdate = true;
    }
  }

  setWarmup(active: boolean): void {
    this.warming = active;
    if (active) {
      this.center.fill(0, 0, 4);
      this.normal.set([0, 1, 0, 0], 0);
      this.color.fill(0, 0, 4);
      this.params.fill(0, 0, 4);
      for (let i = 0; i < this.attrs.length; i++) {
        const at = this.attrs[i]!;
        setUpdateRange(at, this.ranges[i]!, 0, 4);
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
