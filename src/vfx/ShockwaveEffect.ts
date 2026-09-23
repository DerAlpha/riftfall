/**
 * Screen-space shockwave distortion (explosions). A UV-transform effect (mainUv only): up to
 * POSTFX.shockwave.maxWaves rings expand around their projected world epicenters and push the
 * image outward/inward across the ring. PostFXPipeline gives it its own EffectPass right after the
 * world effects (fog) – postprocessing forbids UV transforms in a pass with a convolution effect
 * such as motion blur – and enables that pass only while a wave is running, so it costs nothing
 * otherwise. Volumetrics/particles and the viewmodel are drawn after it and stay undistorted
 * (the fireball sits on top of the rippling background).
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

const fragmentShader = /* glsl */ `
uniform vec4 waves[${MAX}];
uniform vec4 shape[${MAX}];
uniform int count;

void mainUv(inout vec2 uv) {
  vec2 aspectScale = vec2(aspect, 1.0);
  vec2 total = vec2(0.0);
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
  private _active = 0;
  private next = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    const waves: THREE.Vector4[] = [];
    const shape: THREE.Vector4[] = [];
    for (let i = 0; i < MAX; i++) {
      waves.push(new THREE.Vector4());
      shape.push(new THREE.Vector4(1, 0, 0, 0));
    }
    super('ShockwaveEffect', fragmentShader, {
      uniforms: new Map<string, THREE.Uniform>([
        ['waves', new THREE.Uniform(waves)],
        ['shape', new THREE.Uniform(shape)],
        ['count', new THREE.Uniform(0)],
      ]),
    });
    this.waveUniforms = waves;
    this.shapeUniforms = shape;
    for (let i = 0; i < MAX; i++) {
      this.waves.push({ active: false, age: 0, position: new THREE.Vector3(), radius: 0, strength: 0 });
    }
  }

  /** True while at least one wave is running (the pipeline enables the pass only then). */
  get active(): boolean {
    return this._active > 0;
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
    this._active = 0;
    (this.uniforms.get('count') as THREE.Uniform<number>).value = 0;
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
  }

  private countActive(): number {
    let n = 0;
    for (const w of this.waves) if (w.active) n++;
    return n;
  }
}
