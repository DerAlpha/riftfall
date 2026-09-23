/**
 * Projected-quad decals (bullet holes, glass cracks, scorch marks, blood / slime splats): ONE
 * InstancedMesh of surface-aligned quads with a procedural atlas (albedo + normal + ORM), a ring
 * buffer capacity from the particle quality level, and GPU fades (spawn fade-in, fade-out of the
 * decals about to be overwritten) driven by a shared time uniform – no per-frame CPU work.
 *
 * The material is a lit MeshStandardMaterial (normal + roughness + metalness from the atlas, so
 * holes read as embedded) patched in onBeforeCompile: per-instance atlas cell, fade and emissive
 * afterglow (hot metal, embers, bioluminescent slime; the ORM red channel is the glow mask).
 * It goes through render.setupMaterial (cascaded sun shadows); ShadowSystem chains our hook.
 * polygonOffset + a small normal lift + depthWrite false keep the quads on their surface
 * without z-fighting; decals are drawn in the world pass (AO + fog apply like to the wall).
 */
import * as THREE from 'three';
import type { RenderApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { DECAL_ATLAS, DECAL_KINDS, VFX, type DecalKind } from '../defs/vfx';
import { decalCell } from './atlas';
import type { DecalAtlasTextures } from './decalAtlas';
import { DecalRing, type DecalAllocation } from './DecalRing';
import { addUpdateRange, type UpdateRange } from './gpuUpload';

/** Die time of decals that are not fading (far future; float32-safe). */
const NEVER = 1e9;
/** Half-texel inset (cell fraction) against atlas bleeding. */
const ATLAS_INSET = 0.5 / DECAL_ATLAS.cellSize;

const VERTEX_DECLS = /* glsl */ `
attribute vec4 aDecal;
attribute vec3 aGlow;
uniform float uDecalTime;
uniform vec4 uDecalAtlas;
uniform vec2 uDecalFade;
uniform float uDecalInset;
varying float vDecalAlpha;
varying vec3 vDecalGlow;
`;

const VERTEX_UV = /* glsl */ `
{
  float decalCell = aDecal.x;
  vec2 decalOrigin = vec2(mod(decalCell, uDecalAtlas.x), uDecalAtlas.y - 1.0 - floor(decalCell / uDecalAtlas.x)) * uDecalAtlas.zw;
  vec2 decalUv = decalOrigin + (uv * (1.0 - 2.0 * uDecalInset) + uDecalInset) * uDecalAtlas.zw;
#ifdef USE_MAP
  vMapUv = decalUv;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv = decalUv;
#endif
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = decalUv;
#endif
#ifdef USE_METALNESSMAP
  vMetalnessMapUv = decalUv;
#endif
  float decalAge = max(uDecalTime - aDecal.y, 0.0);
  vDecalAlpha = clamp((aDecal.z - uDecalTime) / uDecalFade.x, 0.0, 1.0) * clamp(decalAge / uDecalFade.y, 0.0, 1.0);
  vDecalGlow = aGlow * exp(-decalAge * aDecal.w);
}
`;

const FRAGMENT_DECLS = /* glsl */ `
varying float vDecalAlpha;
varying vec3 vDecalGlow;
`;

const FRAGMENT_ALPHA = /* glsl */ `
diffuseColor.a *= vDecalAlpha;
`;

const FRAGMENT_GLOW = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
totalEmissiveRadiance += vDecalGlow * texture2D(roughnessMap, vRoughnessMapUv).r;
#endif
`;

const Z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class DecalSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly ring: DecalRing;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly decalAttr: THREE.InstancedBufferAttribute;
  private readonly glowAttr: THREE.InstancedBufferAttribute;
  private readonly matrixRange: UpdateRange = { start: 0, count: 0 };
  private readonly decalRange: UpdateRange = { start: 0, count: 0 };
  private readonly glowRange: UpdateRange = { start: 0, count: 0 };
  private readonly alloc: DecalAllocation = { slot: 0, fadeSlot: -1 };
  private readonly timeUniform: { value: number };

  constructor(
    atlas: DecalAtlasTextures,
    render: Pick<RenderApi, 'setupMaterial'>,
    maxCapacity: number,
    capacity: number,
    time: { value: number },
  ) {
    const d = VFX.decals;
    this.timeUniform = time;
    this.ring = new DecalRing(Math.max(1, Math.floor(maxCapacity)), capacity, d.fadeAhead);
    const max = this.ring.maxCapacity;

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.decalAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.decalAttr.setUsage(THREE.DynamicDrawUsage);
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aDecal', this.decalAttr);
    this.geometry.setAttribute('aGlow', this.glowAttr);

    const material = new THREE.MeshStandardMaterial({
      name: 'VfxDecals',
      map: atlas.albedo,
      normalMap: atlas.normal,
      normalScale: new THREE.Vector2(d.normalScale, d.normalScale),
      roughnessMap: atlas.orm,
      metalnessMap: atlas.orm,
      roughness: 1,
      metalness: 1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: d.polygonOffsetFactor,
      polygonOffsetUnits: d.polygonOffsetUnits,
    });
    const { cols, rows } = DECAL_ATLAS;
    const atlasUniform = { value: new THREE.Vector4(cols, rows, 1 / cols, 1 / rows) };
    const fadeUniform = { value: new THREE.Vector2(d.fadeDuration, d.fadeIn) };
    const insetUniform = { value: ATLAS_INSET };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uDecalTime = this.timeUniform;
      shader.uniforms.uDecalAtlas = atlasUniform;
      shader.uniforms.uDecalFade = fadeUniform;
      shader.uniforms.uDecalInset = insetUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_DECLS}`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n${VERTEX_UV}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_ALPHA}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAGMENT_GLOW}`);
    };
    material.customProgramCacheKey = () => 'vfx-decals-v1';
    this.material = material;
    render.setupMaterial(material);

    const mesh = new THREE.InstancedMesh(this.geometry, material, max);
    mesh.name = 'VfxDecals';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = d.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.mesh = mesh;
  }

  get count(): number {
    return this.ring.count;
  }

  get capacity(): number {
    return this.ring.capacity;
  }

  /** New capacity (quality change). Clears all decals. */
  setCapacity(n: number): void {
    this.ring.setCapacity(n);
    this.syncDrawCount();
  }

  /**
   * Shader warm-up: while active the mesh draws one fully faded instance (die time 0) so the next
   * render compiles the patched program. Only meaningful while no decal exists (boot).
   */
  setWarmup(active: boolean): void {
    if (active && this.ring.count === 0) {
      const da = this.decalAttr.array as Float32Array;
      da[0] = 0;
      da[1] = 0;
      da[2] = 0;
      da[3] = 0;
      addUpdateRange(this.decalAttr, this.decalRange, 0, 4);
      this.decalAttr.needsUpdate = true;
      this.mesh.count = 1;
      this.mesh.visible = true;
    } else {
      this.syncDrawCount();
    }
  }

  clear(): void {
    this.ring.clear();
    this.syncDrawCount();
  }

  /**
   * Place a decal. `size` multiplies the kind's base size; `rotation` (radians) spins it around
   * the normal (random when omitted). Returns false for unknown kinds, zero capacity or bad input.
   */
  add(
    kind: DecalKind | string,
    position: Vec3Like,
    normal: Vec3Like,
    size = 1,
    rotation: number = Math.random() * Math.PI * 2,
    sizeRand: number = Math.random(),
  ): boolean {
    const cell = decalCell(kind);
    if (cell < 0) return false;
    _n.set(normal.x, normal.y, normal.z);
    const len = _n.length();
    if (!(len > 1e-6) || !Number.isFinite(position.x + position.y + position.z)) return false;
    _n.multiplyScalar(1 / len);
    const alloc = this.ring.allocate(this.alloc);
    if (!alloc) return false;
    const def = DECAL_KINDS[kind as DecalKind];
    const edge = (def.size[0] + (def.size[1] - def.size[0]) * sizeRand) * Math.max(0, size);
    const now = this.timeUniform.value;

    _p.set(position.x, position.y, position.z).addScaledVector(_n, VFX.decals.normalOffset);
    _q.setFromUnitVectors(Z, _n);
    _qr.setFromAxisAngle(Z, rotation);
    _q.multiply(_qr);
    _s.set(edge, edge, 1);
    _m.compose(_p, _q, _s);
    const slot = alloc.slot;
    this.mesh.setMatrixAt(slot, _m);
    addUpdateRange(this.mesh.instanceMatrix, this.matrixRange, slot * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;

    const da = this.decalAttr.array as Float32Array;
    da[slot * 4] = cell;
    da[slot * 4 + 1] = now;
    da[slot * 4 + 2] = NEVER;
    da[slot * 4 + 3] = def.glow ? def.glow.decay : 0;
    const ga = this.glowAttr.array as Float32Array;
    const g = def.glow;
    ga[slot * 3] = g ? g.color[0] * g.intensity : 0;
    ga[slot * 3 + 1] = g ? g.color[1] * g.intensity : 0;
    ga[slot * 3 + 2] = g ? g.color[2] * g.intensity : 0;
    addUpdateRange(this.decalAttr, this.decalRange, slot * 4, 4);
    addUpdateRange(this.glowAttr, this.glowRange, slot * 3, 3);
    this.glowAttr.needsUpdate = true;

    if (alloc.fadeSlot >= 0) {
      // Only start a fade once: a decal already fading keeps its earlier die time.
      const i = alloc.fadeSlot * 4 + 2;
      if (da[i]! >= NEVER) {
        da[i] = now + VFX.decals.fadeDuration;
        addUpdateRange(this.decalAttr, this.decalRange, alloc.fadeSlot * 4, 4);
      }
    }
    this.decalAttr.needsUpdate = true;
    this.syncDrawCount();
    return true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  private syncDrawCount(): void {
    this.mesh.count = this.ring.drawCount;
    this.mesh.visible = this.mesh.count > 0;
  }
}
