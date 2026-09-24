/**
 * Power-up pickups as floating holograms – every pickup in ONE instanced additive draw on
 * RENDER.volumetricLayer (after AO and height fog, depth-tested, no depth write, self-fogged like
 * every volumetric). Three quads per pickup:
 *   0 glyph   the power-up sigil (canvas atlas) in a rotating dashed halo ring, turned towards the
 *             camera with a slow wobble, bobbing; HDR core (blooms), scanlines, white flash when it
 *             materializes / is collected,
 *   1 floor   a glowing floor ring with outward pulses (fake light spill – real lights stay constant),
 *   2 shaft   a soft light shaft rising from the floor ring.
 * Materialize grows it from the floor, the last seconds blink (pickupAnim), collecting implodes it
 * upwards. Everything animated per frame through four small instance attributes (no allocation).
 */
import {
  AdditiveBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type Object3D,
} from 'three';
import { DEG2RAD } from '../core/math';
import { RENDER } from '../defs/graphics';
import type { Rgb } from '../defs/enemies';
import { POWERUPS } from '../defs/powerups';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../vfx/gpuUpload';
import { createGlyphAtlas, type GlyphAtlas } from './glyphAtlas';
import { blinkVisibility, collectProgress, spawnProgress } from './pickupAnim';

/** What the view reads of a pickup (PowerUpSystem's pooled records satisfy it). */
export interface PickupVisual {
  readonly active: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cell: number;
  readonly color: Rgb;
  readonly scale: number;
  readonly seed: number;
  readonly age: number;
  readonly lifetime: number;
  /** Seconds since collected, < 0 while on the floor. */
  readonly collecting: number;
}

const PARTS = 3;

const VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
attribute vec4 aP; // floor x, y, z, part
attribute vec4 aQ; // color rgb, scale
attribute vec4 aS; // atlas cell, visibility, seed, materialize 0..1
attribute vec4 aT; // collect 0..1, flash, -, -
uniform float uTime;
uniform float uGlyphSize;
uniform float uHover;
uniform float uBob;
uniform float uBobHz;
uniform float uWobble;
uniform float uWobbleHz;
uniform float uShaftH;
uniform float uShaftW;
uniform float uFloorR;
varying vec2 vUv;
varying float vPart;
varying vec3 vColor;
varying vec4 vS;
varying vec4 vT;
varying float vFog;
void main() {
  float part = aP.w;
  float scale = aQ.w;
  float seed = aS.z;
  float grow = aS.w;
  float collect = aT.x;
  vec3 base = aP.xyz;
  vec2 q = position.xy;
  vec3 wp;
  vec3 toCam = cameraPosition - base;
  float yaw = atan(toCam.x, toCam.z);
  if (part < 0.5) {
    float s = uGlyphSize * scale * (0.25 + 0.75 * grow) * (1.0 - 0.8 * collect * collect);
    vec3 c = base + vec3(0.0, uHover * mix(0.35, 1.0, grow) + sin(uTime * uBobHz * 6.2831 + seed * 6.2831) * uBob, 0.0);
    c.y += collect * 0.7;
    float y2 = yaw + sin(uTime * uWobbleHz * 6.2831 + seed * 4.0) * uWobble;
    vec3 right = vec3(cos(y2), 0.0, -sin(y2));
    wp = c + right * q.x * s + vec3(0.0, q.y * s, 0.0);
  } else if (part < 1.5) {
    float r = uFloorR * scale * (0.35 + 0.65 * grow) * (1.0 + 0.6 * collect);
    wp = base + vec3(q.x * 2.0 * r, 0.03, q.y * 2.0 * r);
  } else {
    vec3 right = vec3(cos(yaw), 0.0, -sin(yaw));
    float h = uShaftH * scale * (0.15 + 0.85 * grow) * (1.0 + 0.5 * collect);
    wp = base + right * q.x * uShaftW * scale * (1.0 - 0.7 * collect) + vec3(0.0, (q.y + 0.5) * h, 0.0);
  }
  vUv = q + 0.5;
  vPart = part;
  vColor = aQ.rgb;
  vS = aS;
  vT = aT;
  vFog = fogTransmittance(cameraPosition, wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uHasAtlas;
uniform vec2 uCells;
uniform float uTime;
uniform float uRing;
uniform float uGlyphFill;
uniform float uGlyphI;
uniform float uRingI;
uniform float uShaftI;
uniform float uFloorI;
uniform float uFlashI;
varying vec2 vUv;
varying float vPart;
varying vec3 vColor;
varying vec4 vS;
varying vec4 vT;
varying float vFog;
void main() {
  float vis = vS.y;
  float seed = vS.z;
  float collect = vT.x;
  float flash = vT.y;
  vec3 col = vec3(0.0);
  if (vPart < 0.5) {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    vec2 g2 = p / uGlyphFill * 0.5 + 0.5;
    float g = 0.0;
    if (uHasAtlas > 0.5) {
      if (g2.x >= 0.0 && g2.x <= 1.0 && g2.y >= 0.0 && g2.y <= 1.0) {
        float cell = vS.x;
        float cx = mod(cell, uCells.x);
        float cy = floor(cell / uCells.x);
        vec2 auv = vec2((cx + g2.x) / uCells.x, (uCells.y - 1.0 - cy + g2.y) / uCells.y);
        g = texture2D(uAtlas, auv).a;
      }
    } else {
      float dm = abs(p.x) + abs(p.y);
      g = exp(-abs(dm - 0.42) * 26.0) + exp(-dm * 9.0);
    }
    float core = smoothstep(0.6, 0.95, g);
    float ang = atan(p.y, p.x);
    float dash = step(0.3, fract(ang / 6.2831 * 14.0 + uTime * 0.3 + seed));
    float ring = exp(-abs(r - uRing * 2.0) * 34.0) * (0.45 + 0.55 * dash);
    float ring2 = exp(-abs(r - uRing * 2.0 * 0.88) * 70.0) * 0.35;
    float halo = exp(-r * 2.6) * 0.3;
    float scan = 0.82 + 0.18 * sin(vUv.y * 110.0 - uTime * 7.0);
    col = vColor * ((g * 0.28 + core * 1.2) * uGlyphI * scan + (ring + ring2) * uRingI + halo);
    col += vec3(1.0) * (core + ring * 0.5) * flash * uFlashI;
    col *= 1.0 - smoothstep(0.9, 1.0, r);
  } else if (vPart < 1.5) {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float pulse = fract(uTime * 0.55 + seed);
    float rings = exp(-abs(r - 0.78) * 28.0) + exp(-abs(r - pulse) * 22.0) * (1.0 - pulse) * 0.8;
    float pool = exp(-r * 3.2) * 0.7;
    col = vColor * (rings + pool) * uFloorI * (1.0 - smoothstep(0.92, 1.0, r)) * (1.0 + flash);
  } else {
    float x = abs(vUv.x * 2.0 - 1.0);
    float y = vUv.y;
    float beam = exp(-x * x * 6.0) * pow(1.0 - y, 1.6) * smoothstep(0.0, 0.04, y);
    float motes = 0.75 + 0.25 * sin(y * 34.0 - uTime * 4.5 + seed * 6.0);
    col = vColor * beam * motes * uShaftI * (1.0 + flash * 2.0);
  }
  float fade = (1.0 - collect) * (1.0 - collect);
  gl_FragColor = vec4(col * vis * mix(1.0, fade, step(0.001, collect)) * vFog, 1.0);
}
`;

export class PickupView {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly atlas: GlyphAtlas | null;
  private readonly aP: InstancedBufferAttribute;
  private readonly aQ: InstancedBufferAttribute;
  private readonly aS: InstancedBufferAttribute;
  private readonly aT: InstancedBufferAttribute;
  private readonly attrs: readonly InstancedBufferAttribute[];
  private readonly ranges: readonly UpdateRange[];
  private readonly capacity: number;
  private reduced: boolean;
  private time = 0;
  private drawn = 0;

  constructor(parent: Object3D, capacity: number, reduceFlashing = false) {
    const V = POWERUPS.visual;
    const P = POWERUPS.pickup;
    this.capacity = Math.max(1, capacity);
    this.reduced = reduceFlashing;
    const n = this.capacity * PARTS;
    const plane = new PlaneGeometry(1, 1, 1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(plane.getIndex());
    geometry.setAttribute('position', plane.getAttribute('position'));
    const attr = (name: string): InstancedBufferAttribute => {
      const a = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
      a.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    this.aP = attr('aP');
    this.aQ = attr('aQ');
    this.aS = attr('aS');
    this.aT = attr('aT');
    this.attrs = [this.aP, this.aQ, this.aS, this.aT];
    this.ranges = this.attrs.map(() => ({ start: 0, count: 0 }));
    geometry.instanceCount = 0;
    this.geometry = geometry;
    plane.dispose();
    this.atlas = createGlyphAtlas();
    this.material = new ShaderMaterial({
      name: 'powerup-pickups',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uAtlas: { value: this.atlas?.texture ?? null },
        uHasAtlas: { value: this.atlas ? 1 : 0 },
        uCells: { value: new Vector2(this.atlas?.cols ?? 1, this.atlas?.rows ?? 1) },
        uTime: { value: 0 },
        uGlyphSize: { value: V.glyphSize },
        uHover: { value: P.hover },
        uBob: { value: P.bobAmplitude },
        uBobHz: { value: P.bobHz },
        uWobble: { value: P.wobbleDeg * DEG2RAD },
        uWobbleHz: { value: P.wobbleHz },
        uShaftH: { value: V.shaftHeight },
        uShaftW: { value: V.shaftWidth },
        uFloorR: { value: V.floorRadius },
        uRing: { value: V.ring },
        uGlyphFill: { value: V.glyphFill },
        uGlyphI: { value: V.intensity.glyph },
        uRingI: { value: V.intensity.ring },
        uShaftI: { value: V.intensity.shaft },
        uFloorI: { value: V.intensity.floor },
        uFlashI: { value: V.intensity.flash },
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
    mesh.name = 'PowerUpPickups';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = V.renderOrder;
    mesh.layers.set(RENDER.volumetricLayer);
    parent.add(mesh);
    this.mesh = mesh;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  /** Instances drawn last frame (pickups × 3). */
  get instances(): number {
    return this.drawn;
  }

  setReducedFlashing(on: boolean): void {
    this.reduced = on;
    this.material.uniforms.uFlashI!.value = POWERUPS.visual.intensity.flash * (on ? 0.3 : 1);
  }

  /** Per frame: pack the live pickups densely. */
  update(dt: number, pickups: readonly PickupVisual[]): void {
    if (dt > 0 && Number.isFinite(dt)) this.time += dt;
    this.material.uniforms.uTime!.value = this.time;
    const p = this.aP.array as Float32Array;
    const q = this.aQ.array as Float32Array;
    const s = this.aS.array as Float32Array;
    const t = this.aT.array as Float32Array;
    let k = 0;
    for (let i = 0; i < pickups.length && k < this.capacity * PARTS; i++) {
      const pk = pickups[i]!;
      if (!pk.active) continue;
      const grow = spawnProgress(pk.age);
      const collect = collectProgress(pk.collecting);
      const vis = pk.collecting >= 0 ? 1 : blinkVisibility(pk.age, pk.lifetime, this.reduced);
      const flash = Math.max(1 - grow, collect > 0 ? 1 - collect : 0);
      for (let part = 0; part < PARTS; part++, k++) {
        const o = k * 4;
        p[o] = pk.x;
        p[o + 1] = pk.y;
        p[o + 2] = pk.z;
        p[o + 3] = part;
        q[o] = pk.color[0];
        q[o + 1] = pk.color[1];
        q[o + 2] = pk.color[2];
        q[o + 3] = pk.scale;
        s[o] = pk.cell < 0 ? 0 : pk.cell;
        s[o + 1] = vis;
        s[o + 2] = pk.seed;
        s[o + 3] = grow;
        t[o] = collect;
        t[o + 1] = flash;
        t[o + 2] = 0;
        t[o + 3] = 0;
      }
    }
    this.drawn = k;
    this.geometry.instanceCount = k;
    this.mesh.visible = k > 0;
    if (k === 0) return;
    for (let i = 0; i < this.attrs.length; i++) {
      setUpdateRange(this.attrs[i]!, this.ranges[i]!, 0, k * 4);
      this.attrs[i]!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.atlas?.texture.dispose();
  }
}
