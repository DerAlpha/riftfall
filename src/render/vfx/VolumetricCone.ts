/**
 * Fake volumetric light: spot-light cones and skylight shafts. Both are cheap additive meshes
 * (no depth write, no ray marching through the scene) tuned so only the dense core reaches the
 * bloom threshold.
 *
 * - VolumetricCone: open cone mesh, |N·V| falloff (soft silhouettes), length falloff, floor fade,
 *   animated 3D noise; fades out when the camera enters the cone.
 * - VolumetricShafts: all skylight shafts in ONE draw call. Each shaft is a parallelepiped
 *   (opening rectangle extruded along the sun direction); its inverse basis travels as vertex
 *   attributes and the fragment shader integrates the analytic chord of the view ray through the
 *   box (works from outside and inside). Adjacent segments of one skylight do not fade at their
 *   shared faces, so a skylight can be split into segments that end on different surfaces.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/events';
import { VOLUMETRIC_CONE, VOLUMETRIC_SHAFT } from '../../defs/level';

/** Shared uniform object for animated effects (update `.value` once per frame). */
export interface TimeUniform {
  value: number;
}

/** World-space cone description (also consumed by DustParticles). */
export interface ConeVolume {
  readonly apex: THREE.Vector3;
  /** Unit axis from the apex along the light direction. */
  readonly axis: THREE.Vector3;
  readonly tanAngle: number;
  readonly apexRadius: number;
  readonly length: number;
  /** Linear light color (scaled by the current intensity multiplier). */
  readonly color: THREE.Color;
}

/** Parallelepiped: p = origin + u*edgeA + v*edgeB + w*extrude, u,v,w ∈ [0,1]. */
export interface BoxVolume {
  readonly origin: THREE.Vector3;
  /** Inverse of the [edgeA edgeB extrude] basis (world → unit cube). */
  readonly inverse: THREE.Matrix3;
  readonly color: THREE.Color;
}

const NOISE_GLSL = /* glsl */ `
float vhash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = vhash13(i);
  float n100 = vhash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = vhash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = vhash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = vhash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = vhash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = vhash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = vhash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
float vfbm3(vec3 p) {
  return vnoise3(p) * 0.62 + vnoise3(p * 2.17 + 13.7) * 0.38;
}
`;

const CONE_VERTEX = /* glsl */ `
uniform float uLength;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vAxial;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vAxial = clamp(-position.y / uLength, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CONE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform vec3 uApex;
uniform vec3 uAxis;
uniform float uTan;
uniform float uApexRadius;
uniform float uLength;
uniform float uFloorY;
uniform float uFloorFade;
uniform float uEdgePower;
uniform float uLengthPower;
uniform float uApexFade;
uniform float uNoiseScale;
uniform float uNoiseSpeed;
uniform float uNoiseAmount;
uniform float uInsideFade;
uniform float uInsideMargin;
uniform float uNearStart;
uniform float uNearEnd;
uniform float uBackWeight;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vAxial;
${NOISE_GLSL}
void main() {
  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length(toCam);
  vec3 V = toCam / max(camDist, 1e-4);
  float ndv = abs(dot(normalize(vWorldNormal), V));
  float edge = pow(ndv, uEdgePower);
  float axial = pow(1.0 - vAxial, uLengthPower) * smoothstep(0.0, uApexFade, vAxial);
  float floorFade = smoothstep(uFloorY, uFloorY + uFloorFade, vWorldPos.y);
  vec3 drift = vec3(0.3, -1.0, 0.2) * uTime * uNoiseSpeed;
  float n = vfbm3(vWorldPos * uNoiseScale + drift);
  float dens = mix(1.0 - uNoiseAmount, 1.0, n);
  // Camera inside the cone: fade (the silhouettes are gone, a uniform veil would remain).
  vec3 rel = cameraPosition - uApex;
  float h = dot(rel, uAxis);
  float r = length(rel - uAxis * h);
  float coneR = uApexRadius + max(h, 0.0) * uTan;
  float inside = (1.0 - smoothstep(coneR - uInsideMargin, coneR + uInsideMargin, r))
    * smoothstep(-uInsideMargin, 0.0, h) * (1.0 - smoothstep(uLength, uLength + uInsideMargin, h));
  float fade = mix(1.0, uInsideFade, inside);
  float nearFade = smoothstep(uNearStart, uNearEnd, camDist);
  float face = gl_FrontFacing ? 1.0 : uBackWeight;
  float a = uIntensity * edge * axial * floorFade * dens * fade * nearFade * face;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export interface VolumetricConeOptions {
  apex: Vec3Like;
  /** Light direction (need not be normalized). */
  direction: Vec3Like;
  /** Half angle in radians (already scaled by the caller if desired). */
  angle: number;
  length: number;
  color: THREE.Color;
  /** Base intensity (VOLUMETRIC_CONE.intensity * per-light multiplier). */
  intensity: number;
  /** World height below which the cone fades (floor level under the light). */
  floorY: number;
  time: TimeUniform;
}

const _down = new THREE.Vector3(0, -1, 0);

export class VolumetricCone {
  readonly mesh: THREE.Mesh;
  readonly volume: ConeVolume;
  private readonly material: THREE.ShaderMaterial;
  private readonly baseIntensity: number;
  private readonly baseColor: THREE.Color;

  constructor(opts: VolumetricConeOptions) {
    const cfg = VOLUMETRIC_CONE;
    const length = Math.max(0.1, opts.length);
    const tan = Math.tan(opts.angle);
    const bottomRadius = cfg.apexRadius + length * tan;
    const geo = new THREE.CylinderGeometry(
      cfg.apexRadius,
      bottomRadius,
      length,
      cfg.radialSegments,
      cfg.heightSegments,
      true,
    );
    // Apex at the local origin, cone extends down -Y.
    geo.translate(0, -length / 2, 0);

    const axis = new THREE.Vector3(opts.direction.x, opts.direction.y, opts.direction.z);
    if (axis.lengthSq() < 1e-8) axis.copy(_down);
    axis.normalize();
    const apex = new THREE.Vector3(opts.apex.x, opts.apex.y, opts.apex.z);

    this.baseIntensity = opts.intensity;
    this.baseColor = opts.color.clone();
    this.material = new THREE.ShaderMaterial({
      name: 'VolumetricCone',
      vertexShader: CONE_VERTEX,
      fragmentShader: CONE_FRAGMENT,
      uniforms: {
        uColor: { value: opts.color.clone() },
        uIntensity: { value: opts.intensity },
        uTime: opts.time,
        uApex: { value: apex.clone() },
        uAxis: { value: axis.clone() },
        uTan: { value: tan },
        uApexRadius: { value: cfg.apexRadius },
        uLength: { value: length },
        uFloorY: { value: opts.floorY },
        uFloorFade: { value: cfg.floorFadeHeight },
        uEdgePower: { value: cfg.edgePower },
        uLengthPower: { value: cfg.lengthPower },
        uApexFade: { value: cfg.apexFade },
        uNoiseScale: { value: cfg.noiseScale },
        uNoiseSpeed: { value: cfg.noiseSpeed },
        uNoiseAmount: { value: cfg.noiseAmount },
        uInsideFade: { value: cfg.insideFade },
        uInsideMargin: { value: cfg.insideMargin },
        uNearStart: { value: cfg.nearFadeStart },
        uNearEnd: { value: cfg.nearFadeEnd },
        uBackWeight: { value: cfg.backFaceWeight },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'VolumetricCone';
    mesh.position.copy(apex);
    mesh.quaternion.setFromUnitVectors(_down, axis);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Additive light is drawn after opaque geometry; never occludes or receives AO.
    mesh.renderOrder = 10;
    mesh.userData.cannotReceiveAO = true;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;

    this.volume = {
      apex,
      axis,
      tanAngle: tan,
      apexRadius: cfg.apexRadius,
      length,
      color: opts.color.clone(),
    };
  }

  /** Multiplier on the base intensity (flicker); also scales the dust volume color. */
  setIntensityScale(k: number): void {
    (this.material.uniforms.uIntensity as THREE.IUniform<number>).value = this.baseIntensity * k;
    this.volume.color.copy(this.baseColor).multiplyScalar(k);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Skylight shafts
// ---------------------------------------------------------------------------

const SHAFT_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aInv0;
attribute vec3 aInv1;
attribute vec3 aInv2;
attribute vec2 aFadeU;
varying vec3 vWorldPos;
varying vec3 vOrigin;
varying vec3 vInv0;
varying vec3 vInv1;
varying vec3 vInv2;
varying vec2 vFadeU;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vOrigin = aOrigin;
  vInv0 = aInv0;
  vInv1 = aInv1;
  vInv2 = aInv2;
  vFadeU = aFadeU;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHAFT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uDensity;
uniform float uEdge;
uniform float uTime;
uniform float uNoiseScale;
uniform float uNoiseSpeed;
uniform float uNoiseAmount;
uniform float uStartFade;
uniform float uEndFade;
varying vec3 vWorldPos;
varying vec3 vOrigin;
varying vec3 vInv0;
varying vec3 vInv1;
varying vec3 vInv2;
varying vec2 vFadeU;
${NOISE_GLSL}
vec3 toUnit(vec3 d) { return vec3(dot(vInv0, d), dot(vInv1, d), dot(vInv2, d)); }
void main() {
  vec3 ro = toUnit(cameraPosition - vOrigin);
  vec3 seg = vWorldPos - cameraPosition;
  vec3 rd = toUnit(seg);
  bool inside = all(greaterThan(ro, vec3(0.0))) && all(lessThan(ro, vec3(1.0)));
  // Outside: shade entry (front) faces only; inside: exit (back) faces.
  if (gl_FrontFacing == inside) discard;
  vec3 rdSafe = rd + vec3(1e-7);
  vec3 inv = 1.0 / rdSafe;
  vec3 t0 = -ro * inv;
  vec3 t1 = (vec3(1.0) - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= tn) discard;
  float segLen = length(seg);
  float chord = (tf - tn) * segLen;
  float dens = 0.0;
  vec3 drift = vec3(0.4, -1.0, 0.25) * uTime * uNoiseSpeed;
  for (int i = 0; i < 4; i++) {
    float t = mix(tn, tf, (float(i) + 0.5) * 0.25);
    vec3 lp = ro + rd * t;
    vec3 wp = cameraPosition + seg * t;
    float eu0 = mix(1.0, smoothstep(0.0, uEdge, lp.x), vFadeU.x);
    float eu1 = mix(1.0, smoothstep(0.0, uEdge, 1.0 - lp.x), vFadeU.y);
    float ev = smoothstep(0.0, uEdge, lp.y) * smoothstep(0.0, uEdge, 1.0 - lp.y);
    float along = smoothstep(0.0, uStartFade, lp.z) * (1.0 - smoothstep(1.0 - uEndFade, 1.0, lp.z));
    float n = vfbm3(wp * uNoiseScale + drift);
    dens += eu0 * eu1 * ev * along * mix(1.0 - uNoiseAmount, 1.0, n);
  }
  dens *= 0.25;
  float a = (1.0 - exp(-uDensity * chord * dens)) * uIntensity;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export interface ShaftSegment {
  /** Corner of the opening rectangle. */
  origin: Vec3Like;
  /** Opening edges (the slit's length and width). */
  edgeA: Vec3Like;
  edgeB: Vec3Like;
  /** Extrusion (sun direction * length). */
  extrude: Vec3Like;
  /** Soft edge at u = 0 / u = 1 (false where segments of one skylight touch). */
  fadeU0: boolean;
  fadeU1: boolean;
}

// Unit cube corners (bit 0 = u, bit 1 = v, bit 2 = w) and outward CCW triangles.
const CUBE_TRIS = [
  0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6,
];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix3();

export class VolumetricShafts {
  readonly mesh: THREE.Mesh;
  readonly volumes: BoxVolume[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly baseIntensity: number;
  private readonly baseColor: THREE.Color;

  constructor(segments: readonly ShaftSegment[], color: THREE.Color, intensity: number, time: TimeUniform) {
    const n = segments.length;
    const pos = new Float32Array(n * 8 * 3);
    const origin = new Float32Array(n * 8 * 3);
    const inv0 = new Float32Array(n * 8 * 3);
    const inv1 = new Float32Array(n * 8 * 3);
    const inv2 = new Float32Array(n * 8 * 3);
    const fade = new Float32Array(n * 8 * 2);
    const index: number[] = [];
    this.baseColor = color.clone();
    this.baseIntensity = intensity;

    for (let s = 0; s < n; s++) {
      const seg = segments[s]!;
      _a.set(seg.edgeA.x, seg.edgeA.y, seg.edgeA.z);
      _b.set(seg.edgeB.x, seg.edgeB.y, seg.edgeB.z);
      _c.set(seg.extrude.x, seg.extrude.y, seg.extrude.z);
      const o = new THREE.Vector3(seg.origin.x, seg.origin.y, seg.origin.z);
      let fadeU0 = seg.fadeU0;
      let fadeU1 = seg.fadeU1;
      // Keep a right-handed basis so the cube's outward winding survives the transform:
      // mirror the u edge (same volume, u reversed) and swap its fade flags.
      _m.set(_a.x, _b.x, _c.x, _a.y, _b.y, _c.y, _a.z, _b.z, _c.z);
      if (_m.determinant() < 0) {
        o.add(_a);
        _a.negate();
        _m.set(_a.x, _b.x, _c.x, _a.y, _b.y, _c.y, _a.z, _b.z, _c.z);
        fadeU0 = seg.fadeU1;
        fadeU1 = seg.fadeU0;
      }
      const inverse = _m.clone().invert();
      const ie = inverse.elements; // column-major
      const fu0 = fadeU0 ? 1 : 0;
      const fu1 = fadeU1 ? 1 : 0;
      for (let k = 0; k < 8; k++) {
        const u = k & 1;
        const v = (k >> 1) & 1;
        const w = (k >> 2) & 1;
        const vi = s * 8 + k;
        pos[vi * 3] = o.x + _a.x * u + _b.x * v + _c.x * w;
        pos[vi * 3 + 1] = o.y + _a.y * u + _b.y * v + _c.y * w;
        pos[vi * 3 + 2] = o.z + _a.z * u + _b.z * v + _c.z * w;
        origin[vi * 3] = o.x;
        origin[vi * 3 + 1] = o.y;
        origin[vi * 3 + 2] = o.z;
        // Rows of the inverse (elements are column-major: row r = [e[r], e[r+3], e[r+6]]).
        inv0[vi * 3] = ie[0]!;
        inv0[vi * 3 + 1] = ie[3]!;
        inv0[vi * 3 + 2] = ie[6]!;
        inv1[vi * 3] = ie[1]!;
        inv1[vi * 3 + 1] = ie[4]!;
        inv1[vi * 3 + 2] = ie[7]!;
        inv2[vi * 3] = ie[2]!;
        inv2[vi * 3 + 1] = ie[5]!;
        inv2[vi * 3 + 2] = ie[8]!;
        fade[vi * 2] = fu0;
        fade[vi * 2 + 1] = fu1;
      }
      for (const t of CUBE_TRIS) index.push(s * 8 + t);
      this.volumes.push({ origin: o, inverse, color: color.clone() });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(origin, 3));
    geo.setAttribute('aInv0', new THREE.BufferAttribute(inv0, 3));
    geo.setAttribute('aInv1', new THREE.BufferAttribute(inv1, 3));
    geo.setAttribute('aInv2', new THREE.BufferAttribute(inv2, 3));
    geo.setAttribute('aFadeU', new THREE.BufferAttribute(fade, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const cfg = VOLUMETRIC_SHAFT;
    this.material = new THREE.ShaderMaterial({
      name: 'VolumetricShafts',
      vertexShader: SHAFT_VERTEX,
      fragmentShader: SHAFT_FRAGMENT,
      uniforms: {
        uColor: { value: color.clone() },
        uIntensity: { value: intensity },
        uDensity: { value: cfg.density },
        uEdge: { value: cfg.edgeSoftness },
        uTime: time,
        uNoiseScale: { value: cfg.noiseScale },
        uNoiseSpeed: { value: cfg.noiseSpeed },
        uNoiseAmount: { value: cfg.noiseAmount },
        uStartFade: { value: cfg.startFade },
        uEndFade: { value: cfg.endFade },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'VolumetricShafts';
    mesh.renderOrder = 10;
    mesh.userData.cannotReceiveAO = true;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;
  }

  setIntensityScale(k: number): void {
    (this.material.uniforms.uIntensity as THREE.IUniform<number>).value = this.baseIntensity * k;
    for (const v of this.volumes) v.color.copy(this.baseColor).multiplyScalar(k);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
