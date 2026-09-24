/**
 * Local fog volumes: low-lying cryo mist, the violet haze around the rift anomaly, dock floor
 * haze. One box mesh per volume on RENDER.volumetricLayer (drawn by the post chain after AO and
 * height fog). The fragment shader intersects the view ray with the volume analytically (box or
 * ellipsoid), integrates the density (height falloff / radial falloff × drifting noise × soft
 * borders) in a few steps and blends premultiplied: glow = color · a, the scene behind is dimmed
 * by a · absorption. Like the skylight shafts it shades the entry faces from outside and the exit
 * faces from inside; objects inside a volume are hazed by its full chord (no scene depth here),
 * which reads as mist around them; from inside, the exit faces skip the depth test so the same
 * holds and nothing pops when the eye crosses a face. The proxy box is inset by
 * FOG_VOLUME.faceInset so its faces never z-fight with the floor / walls / platform tops a volume
 * ends at.
 */
import * as THREE from 'three';
import { RENDER } from '../../defs/graphics';
import { FOG_VOLUME, type LabFogVolumeDef } from '../../defs/labLayout';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import type { TimeUniform } from '../../render/vfx/VolumetricCone';

const VERTEX = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAGMENT = /* glsl */ `
#define STEPS ${FOG_VOLUME.steps}
uniform vec3 uMin;
uniform vec3 uMax;
uniform float uEllipsoid;
uniform float uDensity;
uniform float uFalloff;
uniform vec3 uColor;
uniform float uAbsorption;
uniform float uEdge;
uniform vec3 uNoise; // scale, speed, amount
uniform float uTime;
uniform float uMaxAlpha;
uniform float uIntensity;
uniform float uInset;
varying vec3 vWorldPos;
${HEIGHT_FOG_GLSL}
float fvHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float fvNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fvHash(i), fvHash(i + vec3(1, 0, 0)), u.x), mix(fvHash(i + vec3(0, 1, 0)), fvHash(i + vec3(1, 1, 0)), u.x), u.y),
    mix(mix(fvHash(i + vec3(0, 0, 1)), fvHash(i + vec3(1, 0, 1)), u.x), mix(fvHash(i + vec3(0, 1, 1)), fvHash(i + vec3(1, 1, 1)), u.x), u.y),
    u.z
  );
}
void main() {
  vec3 center = 0.5 * (uMin + uMax);
  vec3 halfSize = 0.5 * (uMax - uMin);
  vec3 ro = cameraPosition;
  vec3 seg = vWorldPos - ro;
  float segLen = length(seg);
  vec3 rd = seg / max(segLen, 1e-4);
  // Inside the (inset) proxy box: its back faces shade, from outside its front faces.
  bool inside = all(greaterThan(ro, uMin + uInset)) && all(lessThan(ro, uMax - uInset));
  if (gl_FrontFacing == inside) discard;
  float tn;
  float tf;
  if (uEllipsoid > 0.5) {
    // Unit-sphere space.
    vec3 o = (ro - center) / halfSize;
    vec3 d = rd / halfSize;
    float a = dot(d, d);
    float b = dot(o, d);
    float c = dot(o, o) - 1.0;
    float disc = b * b - a * c;
    if (disc <= 0.0) discard;
    float sq = sqrt(disc);
    tn = max((-b - sq) / a, 0.0);
    tf = (-b + sq) / a;
  } else {
    vec3 inv = 1.0 / (rd + vec3(1e-6));
    vec3 t0 = (uMin - ro) * inv;
    vec3 t1 = (uMax - ro) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
    tf = min(min(tmax.x, tmax.y), tmax.z);
  }
  if (tf <= tn) discard;
  float ds = (tf - tn) / float(STEPS);
  float od = 0.0;
  vec3 drift = vec3(0.35, 0.05, -0.25) * uTime * uNoise.y;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (tn + (float(i) + 0.5) * ds);
    vec3 l = (p - center) / halfSize;
    float dens;
    if (uEllipsoid > 0.5) {
      dens = pow(max(1.0 - dot(l, l), 0.0), uFalloff);
    } else {
      vec3 e = smoothstep(vec3(0.0), vec3(uEdge), 1.0 - abs(l));
      dens = exp(-uFalloff * (p.y - uMin.y)) * e.x * e.z * smoothstep(0.0, uEdge, 1.0 - l.y);
    }
    float n = fvNoise(p * uNoise.x + drift) * 0.65 + fvNoise(p * uNoise.x * 2.3 - drift) * 0.35;
    od += dens * mix(1.0 - uNoise.z, 1.0, n) * ds;
  }
  float a = min(1.0 - exp(-uDensity * od), uMaxAlpha) * uIntensity;
  a *= fogTransmittance(ro, ro + rd * 0.5 * (tn + tf));
  gl_FragColor = vec4(uColor * a, a * uAbsorption);
}
`;

export class FogVolume {
  readonly mesh: THREE.Mesh;
  readonly def: LabFogVolumeDef;
  private readonly material: THREE.ShaderMaterial;

  constructor(def: LabFogVolumeDef, time: TimeUniform) {
    this.def = def;
    const min = new THREE.Vector3(def.min[0], def.min[1], def.min[2]);
    const max = new THREE.Vector3(def.max[0], def.max[1], def.max[2]);
    const size = max.clone().sub(min);
    const inset = FOG_VOLUME.faceInset;
    const geo = new THREE.BoxGeometry(
      Math.max(size.x - 2 * inset, inset),
      Math.max(size.y - 2 * inset, inset),
      Math.max(size.z - 2 * inset, inset),
    );
    for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
    this.material = new THREE.ShaderMaterial({
      name: `FogVolume:${def.id}`,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uMin: { value: min },
        uMax: { value: max },
        uEllipsoid: { value: def.shape === 'ellipsoid' ? 1 : 0 },
        uDensity: { value: def.density },
        uFalloff: { value: def.falloff },
        uColor: {
          value: new THREE.Color().setRGB(
            def.color[0],
            def.color[1],
            def.color[2],
            THREE.LinearSRGBColorSpace,
          ),
        },
        uAbsorption: { value: def.absorption },
        uEdge: { value: def.edgeSoftness },
        uNoise: { value: new THREE.Vector3(def.noiseScale, def.noiseSpeed, def.noiseAmount) },
        uTime: time,
        uMaxAlpha: { value: FOG_VOLUME.maxAlpha },
        uIntensity: { value: 1 },
        uInset: { value: inset },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Premultiplied: glow is added, the background is dimmed by the absorbed fraction.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `FogVolume:${def.id}`;
    mesh.position.copy(min).add(max).multiplyScalar(0.5);
    mesh.renderOrder = 9;
    mesh.layers.set(RENDER.volumetricLayer);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    // Inside the (inset) proxy box the shader shades the exit faces. Everything between the eye and
    // an exit face is inside the box then, so those faces draw over it (the chord behind included,
    // like the entry faces from outside) instead of being occluded: the haze would otherwise pop
    // off nearby objects whenever the eye crosses a face (crouching into floor mist, stairs).
    const lo = min.clone().addScalar(inset);
    const hi = max.clone().subScalar(inset);
    const material = this.material;
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const e = camera.matrixWorld.elements;
      const x = e[12]!;
      const y = e[13]!;
      const z = e[14]!;
      material.depthTest = !(x > lo.x && x < hi.x && y > lo.y && y < hi.y && z > lo.z && z < hi.z);
    };
    this.mesh = mesh;
  }

  /** Brightness / opacity multiplier (0..1). */
  setIntensity(k: number): void {
    (this.material.uniforms.uIntensity as THREE.IUniform<number>).value = k;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
