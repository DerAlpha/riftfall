/**
 * Screen-space shockwave distortion (explosions). A UV-transform effect (mainUv only): up to
 * POSTFX.shockwave.maxWaves rings expand around their projected world epicenters and push the
 * image outward/inward across the ring. PostFXPipeline gives it its own EffectPass right after the
 * world effects (fog) – postprocessing forbids UV transforms in a pass with a convolution effect
 * such as motion blur – and enables that pass only while a wave is running, so it costs nothing
 * otherwise. Volumetrics/particles and the viewmodel are drawn after it and stay undistorted
 * (the fireball sits on top of the rippling background).
 *
 * M5 lenses: up to POSTFX.shockwave.maxLenses persistent gravitational lenses (singularity fields,
 * void orbs) set per frame by the arsenal VFX (setLens). A thin-lens mapping β = θ − θE²/θ bends
 * the background around each center (an Einstein ring hugging the event horizon drawn on top),
 * faded out towards the lens radius; the pass stays enabled while a lens is set.
 *
 * M5 heat haze: up to POSTFX.shockwave.maxHazes capsules (flamethrower streams, setHaze) whose
 * background shimmers with scrolling noise, widening from the nozzle to the flame's end.
 */
import * as THREE from 'three';
import { Effect } from 'postprocessing';
import type { Vec3Like } from '../core/events';
import { POSTFX } from '../defs/postfx';
import {
  distanceFalloff,
  ringThickness,
  screenRadius,
  shockwaveEnvelope,
  shockwaveRadius,
} from './shockwaveMath';

const MAX = POSTFX.shockwave.maxWaves;
const LENSES = POSTFX.shockwave.maxLenses;
const HAZES = POSTFX.shockwave.maxHazes;

const fragmentShader = /* glsl */ `
uniform vec4 waves[${MAX}];
uniform vec4 shape[${MAX}];
uniform int count;
// Lenses: xy = center (UV), z = influence radius (UV height units), w = Einstein radius.
uniform vec4 lenses[${LENSES}];
uniform int lensCount;
// Hazes: A = start (UV xy, radius z, strength w), B = end (UV xy, radius z); hazeTime in s.
uniform vec4 hazeA[${HAZES}];
uniform vec4 hazeB[${HAZES}];
uniform int hazeCount;
uniform float hazeTime;
uniform vec2 hazeNoise;

float hazeHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hazeValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hazeHash(i), hazeHash(i + vec2(1.0, 0.0)), u.x),
    mix(hazeHash(i + vec2(0.0, 1.0)), hazeHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void mainUv(inout vec2 uv) {
  vec2 aspectScale = vec2(aspect, 1.0);
  vec2 total = vec2(0.0);
  for (int i = 0; i < ${HAZES}; i++) {
    if (i >= hazeCount) break;
    vec4 a = hazeA[i];
    vec4 b = hazeB[i];
    vec2 pa = (uv - a.xy) * aspectScale;
    vec2 ba = (b.xy - a.xy) * aspectScale;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    float r = mix(a.z, b.z, t);
    float dist = length(pa - ba * t);
    if (dist < r) {
      // Rising, scrolling shimmer, strongest along the stream's core.
      float fade = (1.0 - smoothstep(r * 0.35, r, dist)) * smoothstep(0.0, 0.2, t);
      vec2 q = uv * aspectScale * hazeNoise.x + vec2(0.0, -hazeTime * hazeNoise.y);
      vec2 n = vec2(hazeValue(q), hazeValue(q + 17.3)) - 0.5;
      total += n * a.w * fade;
    }
  }
  for (int i = 0; i < ${LENSES}; i++) {
    if (i >= lensCount) break;
    vec4 l = lenses[i];
    vec2 d = (uv - l.xy) * aspectScale;
    float dist = length(d);
    if (dist < l.z && dist > 1e-5) {
      // Thin lens: sample the background at θ − θE²/θ (clamped near the center, faded to the rim).
      float bend = min(l.w * l.w / dist, l.w * 1.6);
      float fade = 1.0 - smoothstep(l.z * 0.45, l.z, dist);
      total += (d / dist) * bend * fade;
    }
  }
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= count) break;
    vec4 w = waves[i];
    vec2 d = (uv - w.xy) * aspectScale;
    float dist = length(d);
    float x = (dist - w.z) / shape[i].x;
    if (abs(x) < 1.0 && dist > 1e-5) {
      // Lens-like ring: pulls in just inside the front, pushes out behind it.
      float profile = sin(x * PI) * (1.0 - x * x);
      total += (d / dist) * (profile * w.w);
    }
  }
  uv = clamp(uv - total / aspectScale, vec2(0.0), vec2(1.0));
}
`;

interface Lens {
  strength: number;
  position: THREE.Vector3;
  radius: number;
}

interface Haze {
  strength: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  radiusFrom: number;
  radiusTo: number;
}

interface Wave {
  active: boolean;
  age: number;
  position: THREE.Vector3;
  radius: number;
  strength: number;
}

const _view = new THREE.Vector3();
const _ndc = new THREE.Vector3();

export class ShockwaveEffect extends Effect {
  private readonly waves: Wave[] = [];
  private readonly waveUniforms: THREE.Vector4[];
  private readonly shapeUniforms: THREE.Vector4[];
  private readonly lenses: Lens[] = [];
  private readonly lensUniforms: THREE.Vector4[];
  private readonly hazes: Haze[] = [];
  private readonly hazeA: THREE.Vector4[];
  private readonly hazeB: THREE.Vector4[];
  private hazeTime = 0;
  private _active = 0;
  private next = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    const waves: THREE.Vector4[] = [];
    const shape: THREE.Vector4[] = [];
    const lenses: THREE.Vector4[] = [];
    for (let i = 0; i < MAX; i++) {
      waves.push(new THREE.Vector4());
      shape.push(new THREE.Vector4(1, 0, 0, 0));
    }
    for (let i = 0; i < LENSES; i++) lenses.push(new THREE.Vector4());
    const hazeA: THREE.Vector4[] = [];
    const hazeB: THREE.Vector4[] = [];
    for (let i = 0; i < HAZES; i++) {
      hazeA.push(new THREE.Vector4());
      hazeB.push(new THREE.Vector4());
    }
    const cfg = POSTFX.shockwave;
    super('ShockwaveEffect', fragmentShader, {
      uniforms: new Map<string, THREE.Uniform>([
        ['waves', new THREE.Uniform(waves)],
        ['shape', new THREE.Uniform(shape)],
        ['count', new THREE.Uniform(0)],
        ['lenses', new THREE.Uniform(lenses)],
        ['lensCount', new THREE.Uniform(0)],
        ['hazeA', new THREE.Uniform(hazeA)],
        ['hazeB', new THREE.Uniform(hazeB)],
        ['hazeCount', new THREE.Uniform(0)],
        ['hazeTime', new THREE.Uniform(0)],
        ['hazeNoise', new THREE.Uniform(new THREE.Vector2(cfg.hazeFrequency, cfg.hazeScroll))],
      ]),
    });
    this.hazeA = hazeA;
    this.hazeB = hazeB;
    for (let i = 0; i < HAZES; i++) {
      this.hazes.push({
        strength: 0,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        radiusFrom: 0,
        radiusTo: 0,
      });
    }
    this.waveUniforms = waves;
    this.shapeUniforms = shape;
    this.lensUniforms = lenses;
    for (let i = 0; i < LENSES; i++)
      this.lenses.push({ strength: 0, position: new THREE.Vector3(), radius: 0 });
    for (let i = 0; i < MAX; i++) {
      this.waves.push({ active: false, age: 0, position: new THREE.Vector3(), radius: 0, strength: 0 });
    }
  }

  /** True while at least one wave runs or a lens is set (the pipeline enables the pass only then). */
  get active(): boolean {
    return this._active > 0 || this.lensesActive() || this.hazesActive();
  }

  /**
   * Set (strength > 0, UV displacement) or clear heat-haze `slot` (< POSTFX.shockwave.maxHazes): a
   * shimmering capsule from `from` to `to` (world) widening from `radiusFrom` to `radiusTo` m.
   */
  setHaze(
    slot: number,
    from: Vec3Like,
    to: Vec3Like,
    radiusFrom: number,
    radiusTo: number,
    strength: number,
  ): void {
    const h = this.hazes[slot];
    if (!h) return;
    const ok =
      strength > 0 &&
      radiusTo > 0 &&
      Number.isFinite(from.x + from.y + from.z) &&
      Number.isFinite(to.x + to.y + to.z);
    h.strength = ok ? strength : 0;
    if (!ok) return;
    h.from.set(from.x, from.y, from.z);
    h.to.set(to.x, to.y, to.z);
    h.radiusFrom = Math.max(0, radiusFrom);
    h.radiusTo = radiusTo;
  }

  /**
   * Set (strength > 0) or clear lens `slot` (< POSTFX.shockwave.maxLenses): a gravitational lens
   * at a world position bending the image within `radius` m. It stays until changed or cleared.
   */
  setLens(slot: number, position: Vec3Like, radius: number, strength: number): void {
    const l = this.lenses[slot];
    if (!l) return;
    const ok = radius > 0 && strength > 0 && Number.isFinite(position.x + position.y + position.z);
    l.strength = ok ? Math.min(1, strength) : 0;
    if (!ok) return;
    l.position.set(position.x, position.y, position.z);
    l.radius = radius;
  }

  /** Start a wave at a world position growing to `radius` meters; strength scales the displacement. */
  trigger(position: Vec3Like, radius: number, strength = 1): void {
    if (!(radius > 0) || !(strength > 0) || !Number.isFinite(position.x + position.y + position.z)) return;
    // Reuse a finished slot, else the oldest (round robin).
    let slot = this.waves.findIndex((w) => !w.active);
    if (slot < 0) {
      slot = this.next;
      this.next = (this.next + 1) % MAX;
    }
    const w = this.waves[slot]!;
    w.active = true;
    w.age = 0;
    w.position.set(position.x, position.y, position.z);
    w.radius = radius;
    w.strength = strength;
    this._active = this.countActive();
  }

  clear(): void {
    for (const w of this.waves) w.active = false;
    for (const l of this.lenses) l.strength = 0;
    for (const h of this.hazes) h.strength = 0;
    this._active = 0;
    (this.uniforms.get('hazeCount') as THREE.Uniform<number>).value = 0;
    (this.uniforms.get('count') as THREE.Uniform<number>).value = 0;
    (this.uniforms.get('lensCount') as THREE.Uniform<number>).value = 0;
  }

  /**
   * Age the waves and project them with the (already updated) camera. Call once per frame before
   * the composer renders, whether or not the pass is enabled.
   */
  advance(dt: number): void {
    const cfg = POSTFX.shockwave;
    const cam = this.camera;
    const projYY = cam.projectionMatrix.elements[5]!;
    let n = 0;
    for (const w of this.waves) {
      if (!w.active) continue;
      w.age += Math.max(0, dt);
      if (w.age >= cfg.duration) {
        w.active = false;
        continue;
      }
      _view.copy(w.position).applyMatrix4(cam.matrixWorldInverse);
      const depth = -_view.z;
      if (depth < cfg.minDepth) continue; // behind / too close to the camera: nothing sensible to show
      _ndc.copy(w.position).project(cam);
      const radiusUv = screenRadius(shockwaveRadius(w.age, cfg.duration, w.radius), depth, projYY);
      const amp =
        cfg.amplitude *
        w.strength *
        shockwaveEnvelope(w.age, cfg.duration) *
        distanceFalloff(depth, cfg.fullDistance);
      this.waveUniforms[n]!.set(_ndc.x * 0.5 + 0.5, _ndc.y * 0.5 + 0.5, radiusUv, amp);
      this.shapeUniforms[n]!.x = ringThickness(radiusUv, cfg);
      n++;
    }
    (this.uniforms.get('count') as THREE.Uniform<number>).value = n;
    this._active = this.countActive();
    let k = 0;
    for (const l of this.lenses) {
      if (!(l.strength > 0)) continue;
      _view.copy(l.position).applyMatrix4(cam.matrixWorldInverse);
      const depth = -_view.z;
      if (depth < cfg.minDepth) continue;
      _ndc.copy(l.position).project(cam);
      const radiusUv = screenRadius(l.radius, depth, projYY);
      this.lensUniforms[k]!.set(
        _ndc.x * 0.5 + 0.5,
        _ndc.y * 0.5 + 0.5,
        radiusUv,
        radiusUv * cfg.lensEinstein * l.strength,
      );
      k++;
    }
    (this.uniforms.get('lensCount') as THREE.Uniform<number>).value = k;

    this.hazeTime += Math.max(0, dt);
    (this.uniforms.get('hazeTime') as THREE.Uniform<number>).value = this.hazeTime;
    let m = 0;
    for (const h of this.hazes) {
      if (!(h.strength > 0)) continue;
      _view.copy(h.from).applyMatrix4(cam.matrixWorldInverse);
      const d0 = -_view.z;
      _view.copy(h.to).applyMatrix4(cam.matrixWorldInverse);
      const d1 = -_view.z;
      // Both ends in front of the camera (a stream pointed at the player is not hazed).
      if (d0 < cfg.minDepth || d1 < cfg.minDepth) continue;
      _ndc.copy(h.from).project(cam);
      this.hazeA[m]!.set(
        _ndc.x * 0.5 + 0.5,
        _ndc.y * 0.5 + 0.5,
        screenRadius(h.radiusFrom, d0, projYY),
        h.strength,
      );
      _ndc.copy(h.to).project(cam);
      this.hazeB[m]!.set(_ndc.x * 0.5 + 0.5, _ndc.y * 0.5 + 0.5, screenRadius(h.radiusTo, d1, projYY), 0);
      m++;
    }
    (this.uniforms.get('hazeCount') as THREE.Uniform<number>).value = m;
  }

  private hazesActive(): boolean {
    for (const h of this.hazes) if (h.strength > 0) return true;
    return false;
  }

  private lensesActive(): boolean {
    for (const l of this.lenses) if (l.strength > 0) return true;
    return false;
  }

  private countActive(): number {
    let n = 0;
    for (const w of this.waves) if (w.active) n++;
    return n;
  }
}
