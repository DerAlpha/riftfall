/**
 * GPU side of the particles: two instanced camera-facing quad meshes (additive + alpha blend),
 * each backed by a ParticleBuffer (CPU simulation over typed arrays). Instance attributes are
 * uploaded once per frame (only the live range); billboarding, velocity stretching, atlas
 * lookup, lighting and fog happen in the vertex shader.
 *
 * Drawing: both meshes live on RENDER.volumetricLayer, so the post chain draws them after AO and
 * height fog (VolumetricPass) depth-tested against the world, without writing depth. They apply
 * the fog transmittance to their own position (fogShared.ts). Lit (alpha) particles get a cheap
 * ambient + nearby flash-light term (the pooled VFX lights) instead of full scene lighting.
 *
 * Instanced quads use an InstancedBufferGeometry (+ Mesh) rather than an InstancedMesh: particles
 * need no per-instance matrix (16 floats each, uploaded every frame) – position, size, rotation
 * and stretch travel in compact attributes instead.
 *
 * Small on screen: quads never shrink below VFX.particles.minPixelSize (sub-pixel sparks would
 * vanish), and a few pixels small the mipmapped sprite fades to a plain soft dot / line.
 */
import * as THREE from 'three';
import { RENDER } from '../defs/graphics';
import { MAX_PARTICLE_BUDGET, SPRITE_ATLAS, VFX, type EffectPreset } from '../defs/vfx';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';
import { emitPreset, type EmitContext, type Rand } from './emit';
import { ParticleBuffer, type ParticleInstanceArrays } from './ParticleBuffer';
import { setUpdateRange, type UpdateRange } from './gpuUpload';

/** Half-texel inset (in cell fractions) so bilinear sampling never reads the neighbouring cell. */
const ATLAS_INSET = 0.5 / SPRITE_ATLAS.cellSize;

const VERTEX = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iColor;
attribute vec4 iMisc;
attribute vec3 iVel;
uniform vec4 uAtlas;
uniform float uInset;
uniform float uDepthPull;
uniform float uMinDepth;
uniform float uViewportHeight;
uniform float uMinPx;
uniform float uMinPxDimming;
#ifdef LIT
uniform vec2 uNearFade;
uniform vec3 uAmbient;
uniform float uMaxLight;
uniform vec4 uFlashPos[LIGHTS];
uniform vec3 uFlashColor[LIGHTS];
#endif
varying vec2 vUv;
varying vec4 vColor;
/** xy: quad corner (-0.5..0.5), z: 0..1 blend towards a plain dot / line, w: 1 = stretched. */
varying vec4 vLocal;
${HEIGHT_FOG_GLSL}
void main() {
  vec3 center = iPos.xyz;
  float size = iPos.w;
  vec4 mv = viewMatrix * vec4(center, 1.0);
  float depth = -mv.z;
  // At least uMinPx pixels on screen: sub-pixel quads (sparks a few meters away) cover no pixel
  // centers and vanish or shimmer. uMinPxDimming 1 dims the particle by the area gain (coverage of
  // lit smoke / debris), 0 keeps its brightness (incandescent sparks stay visible).
  float metersPerPixel = max(depth, 1e-3) / (projectionMatrix[1][1] * 0.5 * uViewportHeight);
  float minSize = uMinPx * metersPerPixel;
  bool stretched = iMisc.z > 0.0;
  // A few pixels small, the mipmapped sprite is only a faint smear: fade to a plain dot / line.
  float plain = clamp(1.0 - size / (2.0 * max(minSize, 1e-6)), 0.0, 1.0);
  float energy = 1.0;
  if (size < minSize) {
    float ratio = size / max(minSize, 1e-6);
    // Stretched streaks only widen; round sprites grow in both directions.
    energy = mix(1.0, stretched ? ratio : ratio * ratio, uMinPxDimming);
    size = minSize;
  }
  vec2 corner = position.xy;
  vLocal = vec4(corner, plain, stretched ? 1.0 : 0.0);
  vec2 offset;
  if (stretched) {
    // Velocity stretch: the head sits on the particle, the quad trails behind it.
    vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
    float len2 = dot(vv.xy, vv.xy);
    vec2 axis = len2 > 1e-8 ? vv.xy * inversesqrt(len2) : vec2(0.0, 1.0);
    // (perp, axis) must be a rotation of the quad's (x, y), not a mirror: a mirrored basis flips
    // the triangle winding and the FrontSide material culls every stretched quad.
    vec2 perp = vec2(axis.y, -axis.x);
    float trail = sqrt(len2) * iMisc.z;
    offset = perp * (corner.x * size) + axis * (corner.y * size + (corner.y - 0.5) * trail);
  } else {
    float c = cos(iMisc.x);
    float s = sin(iMisc.x);
    offset = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  }
  // Pull the quad towards the camera along the view ray (same screen position and size) so big
  // camera-facing sprites next to walls are not cut by the depth test (cheap soft-particle stand-in).
  float pull = min(size * uDepthPull, max(depth - uMinDepth, 0.0));
  float pullScale = (depth - pull) / max(depth, 1e-4);
  mv.xyz *= pullScale;
  mv.xy += offset * pullScale;
  gl_Position = projectionMatrix * mv;

  float cell = iMisc.y;
  vec2 origin = vec2(mod(cell, uAtlas.x), uAtlas.y - 1.0 - floor(cell / uAtlas.x)) * uAtlas.zw;
  vUv = origin + ((corner + 0.5) * (1.0 - 2.0 * uInset) + uInset) * uAtlas.zw;

  float fog = fogTransmittance(cameraPosition, center);
#ifdef LIT
  vec3 light = uAmbient;
  for (int i = 0; i < LIGHTS; i++) {
    vec3 d = uFlashPos[i].xyz - center;
    float d2 = dot(d, d);
    float r = max(uFlashPos[i].w, 1e-3);
    float window = clamp(1.0 - d2 / (r * r), 0.0, 1.0);
    light += uFlashColor[i] * (window * window / (1.0 + d2));
  }
  light = min(light, vec3(uMaxLight));
  float nearFade = smoothstep(uNearFade.x, uNearFade.y, depth);
  // Alpha-blended: fading the coverage lets the (already fogged) background show through.
  vColor = vec4(iColor.rgb * light, iColor.a * fog * nearFade * energy);
#else
  vColor = vec4(iColor.rgb * fog * energy, iColor.a);
#endif
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vLocal;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (vLocal.z > 0.0) {
    // Tiny on screen: a soft dot, or a soft line brightening towards the head for streaks.
    float across = vLocal.w > 0.5 ? abs(vLocal.x) * 2.0 : length(vLocal.xy) * 2.0;
    float shape = 1.0 - smoothstep(0.3, 1.0, across);
    if (vLocal.w > 0.5) shape *= 0.35 + 0.65 * (vLocal.y + 0.5);
    t = mix(t, vec4(1.0, 1.0, 1.0, shape), vLocal.z);
  }
  float a = t.a * vColor.a;
#ifdef LIT
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
#else
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb * a, 1.0);
#endif
}
`;

interface ParticleLayer {
  readonly buffer: ParticleBuffer;
  readonly arrays: ParticleInstanceArrays;
  readonly attrs: THREE.InstancedBufferAttribute[];
  /** One reusable update range per attribute (three keeps a reference until it uploads). */
  readonly ranges: UpdateRange[];
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  readonly baseCapacity: number;
}

/** Camera data for back-to-front sorting (reused). */
const _sort = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, range: VFX.particles.sortRange };
const _fwd = new THREE.Vector3();
const _viewport = new THREE.Vector4();

export class ParticleSystem {
  readonly object = new THREE.Group();
  private readonly additive: ParticleLayer;
  private readonly alpha: ParticleLayer;
  /** Flash lights seen by lit particles (written by the light pool each frame). */
  readonly flashPos: THREE.Vector4[] = [];
  readonly flashColor: THREE.Vector3[] = [];
  /** Render-target height in pixels (minimum on-screen size), set right before each draw. */
  private readonly viewportHeight = { value: 1080 };
  private budget = 1;

  constructor(
    private readonly atlas: THREE.Texture,
    private readonly rand: Rand = Math.random,
  ) {
    this.object.name = 'VfxParticles';
    for (let i = 0; i < VFX.lights.count; i++) {
      this.flashPos.push(new THREE.Vector4(0, -1e4, 0, 1));
      this.flashColor.push(new THREE.Vector3());
    }
    const p = VFX.particles;
    this.alpha = this.createLayer(true, p.alphaCapacity, p.renderOrder.alpha);
    this.additive = this.createLayer(false, p.additiveCapacity, p.renderOrder.additive);
  }

  /** Live particles (both blend modes). */
  get count(): number {
    return this.additive.buffer.count + this.alpha.buffer.count;
  }

  get additiveBuffer(): ParticleBuffer {
    return this.additive.buffer;
  }

  get alphaBuffer(): ParticleBuffer {
    return this.alpha.buffer;
  }

  /** Quality budget multiplier (QUALITY_LEVELS.particles.budgetMultiplier). 0 disables particles. */
  setBudget(multiplier: number): void {
    const m = Math.max(0, Math.min(MAX_PARTICLE_BUDGET, Number.isFinite(multiplier) ? multiplier : 1));
    this.budget = m;
    for (const layer of [this.additive, this.alpha]) {
      layer.buffer.setCapacity(Math.round(layer.baseCapacity * m));
    }
  }

  get budgetMultiplier(): number {
    return this.budget;
  }

  emit(preset: EffectPreset, ctx: EmitContext): number {
    ctx.budget = this.budget;
    return emitPreset(preset, ctx, this.additive.buffer, this.alpha.buffer, this.rand);
  }

  /**
   * Simulate and upload. `camera` provides the sort origin for the alpha particles. Particles
   * spawned since the last update are drawn in their spawn state this frame and simulated from
   * the next one (frame-rate independent first-frame brightness of short flashes).
   */
  update(dt: number, camera: THREE.Camera): void {
    const step = VFX.particles.maxStep;
    let left = Math.max(0, dt);
    // Long frames are split so fast sparks do not tunnel through their collision planes.
    while (left > 1e-6) {
      const h = Math.min(step, left);
      this.additive.buffer.update(h, true);
      this.alpha.buffer.update(h, true);
      left -= h;
    }
    this.additive.buffer.endFrame();
    this.alpha.buffer.endFrame();
    camera.getWorldPosition(_fwd);
    _sort.x = _fwd.x;
    _sort.y = _fwd.y;
    _sort.z = _fwd.z;
    camera.getWorldDirection(_fwd);
    _sort.fx = _fwd.x;
    _sort.fy = _fwd.y;
    _sort.fz = _fwd.z;
    this.upload(this.additive, false);
    this.upload(this.alpha, true);
  }

  /**
   * Shader warm-up: with `active` both meshes draw one invisible (zero-size, zero-alpha) instance
   * so the next render compiles their programs in the real render-target context.
   */
  setWarmup(active: boolean): void {
    for (const layer of [this.additive, this.alpha]) {
      if (active) {
        layer.arrays.pos[3] = 0;
        layer.arrays.color[3] = 0;
        for (let i = 0; i < layer.attrs.length; i++) {
          const attr = layer.attrs[i]!;
          setUpdateRange(attr, layer.ranges[i]!, 0, attr.itemSize);
          attr.needsUpdate = true;
        }
        layer.geometry.instanceCount = 1;
        layer.mesh.visible = true;
      } else {
        this.upload(layer, false);
      }
    }
  }

  clear(): void {
    this.additive.buffer.clear();
    this.alpha.buffer.clear();
    this.upload(this.additive, false);
    this.upload(this.alpha, false);
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const layer of [this.additive, this.alpha]) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
  }

  private upload(layer: ParticleLayer, sort: boolean): void {
    const n = layer.buffer.writeInstances(layer.arrays, sort ? _sort : undefined);
    layer.geometry.instanceCount = n;
    layer.mesh.visible = n > 0;
    if (n === 0) return;
    for (let i = 0; i < layer.attrs.length; i++) {
      const attr = layer.attrs[i]!;
      setUpdateRange(attr, layer.ranges[i]!, 0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  private createLayer(lit: boolean, baseCapacity: number, renderOrder: number): ParticleLayer {
    const max = Math.ceil(baseCapacity * MAX_PARTICLE_BUDGET);
    const buffer = new ParticleBuffer(max, VFX.particles);
    const arrays: ParticleInstanceArrays = {
      pos: new Float32Array(buffer.maxCapacity * 4),
      color: new Float32Array(buffer.maxCapacity * 4),
      misc: new Float32Array(buffer.maxCapacity * 4),
      vel: new Float32Array(buffer.maxCapacity * 3),
    };
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string, array: Float32Array, size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(array, size);
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    const attrs = [
      attr('iPos', arrays.pos, 4),
      attr('iColor', arrays.color, 4),
      attr('iMisc', arrays.misc, 4),
      attr('iVel', arrays.vel, 3),
    ];
    geometry.instanceCount = 0;
    // Culling is off (particles span the level); a fixed sphere keeps three from computing bounds.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);

    const p = VFX.particles;
    const { cols, rows } = SPRITE_ATLAS;
    const material = new THREE.ShaderMaterial({
      name: lit ? 'VfxParticlesLit' : 'VfxParticlesAdditive',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: lit ? { LIT: '', LIGHTS: VFX.lights.count } : { LIGHTS: VFX.lights.count },
      uniforms: {
        uMap: { value: this.atlas },
        uAtlas: { value: new THREE.Vector4(cols, rows, 1 / cols, 1 / rows) },
        uInset: { value: ATLAS_INSET },
        uDepthPull: { value: p.depthPull },
        uMinDepth: { value: p.depthPullMinDistance },
        uViewportHeight: this.viewportHeight,
        uMinPx: { value: lit ? p.minPixelSize.alpha : p.minPixelSize.additive },
        uMinPxDimming: { value: lit ? p.minPixelDimming.alpha : p.minPixelDimming.additive },
        uNearFade: { value: new THREE.Vector2(p.nearFade[0], p.nearFade[1]) },
        uAmbient: { value: new THREE.Vector3(p.ambient[0], p.ambient[1], p.ambient[2]) },
        uMaxLight: { value: p.maxLight },
        uFlashPos: { value: this.flashPos },
        uFlashColor: { value: this.flashColor },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Billboards always face the camera, so culling saves nothing – and a winding slip in the
      // quad basis (mirrored stretch axes) must never make particles silently disappear.
      side: THREE.DoubleSide,
      blending: lit ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = lit ? 'VfxParticlesLit' : 'VfxParticlesAdditive';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = renderOrder;
    mesh.visible = false;
    mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_viewport);
      this.viewportHeight.value = Math.max(1, _viewport.w);
    };
    // Drawn by the post chain after AO and fog (VolumetricPass), fogged in the shader.
    mesh.layers.set(RENDER.volumetricLayer);
    this.object.add(mesh);
    const ranges = attrs.map(() => ({ start: 0, count: 0 }));
    return { buffer, arrays, attrs, ranges, geometry, material, mesh, baseCapacity };
  }
}
