/**
 * World-space laser of a fitted laser attachment: a glowing dot where the shot would land (the
 * point the crosshair ray hits – the laser is zeroed to the aim point) and, for visible-beam
 * lasers, a thin beam from the emitter as the player sees it (the viewmodel socket mapped into the
 * world camera) to the dot. Additive on RENDER.volumetricLayer (drawn after AO and fog, depth
 * tested against the world, fogged in its own shader). One ray per frame while a laser is fitted,
 * nothing otherwise. Preallocated; only uniforms / transforms change per frame.
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import { clamp } from '../../../core/math';
import { RENDER } from '../../../defs/graphics';
import { LASER_SIGHT } from '../../../defs/weaponOutfit';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../../render/postfx/fogShared';

const VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vUv;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vUv = uv;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DOT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying float vFog;
void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r2 = dot(d, d);
  float core = exp(-r2 * 18.0);
  float halo = exp(-r2 * 3.5) * 0.35;
  gl_FragColor = vec4((uColor * (core + halo) + vec3(core * 0.6)) * uIntensity * vFog, 1.0);
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uLength;
uniform float uFade;
varying vec2 vUv;
varying float vFog;
void main() {
  // v runs from the emitter (0) to the dot (1).
  float along = vUv.y * uLength;
  float fade = exp(-along / uFade) * smoothstep(0.0, 0.08, along);
  gl_FragColor = vec4(uColor * uIntensity * fade * vFog, 1.0);
}
`;

type GlowMaterial = ShaderMaterial & {
  uniforms: { uColor: { value: Color }; uIntensity: { value: number }; uLength?: { value: number } };
};

function material(name: string, fragment: string, beam: boolean): GlowMaterial {
  return new ShaderMaterial({
    name,
    uniforms: {
      uColor: { value: new Color(1, 0, 0) },
      uIntensity: { value: 1 },
      ...(beam ? { uLength: { value: 1 }, uFade: { value: LASER_SIGHT.beamFade } } : {}),
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: VERTEX,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  }) as GlowMaterial;
}

const _dir = new Vector3();
const _q = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);
const BEAM_SEGMENTS = 6;

export class LaserSight {
  private readonly dot: Mesh;
  private readonly beam: Mesh;
  private readonly dotMat: GlowMaterial;
  private readonly beamMat: GlowMaterial;
  private active = false;
  private disposed = false;

  constructor(private readonly scene: Object3D) {
    this.dotMat = material('laser-dot', DOT_FRAGMENT, false);
    this.beamMat = material('laser-beam', BEAM_FRAGMENT, true);
    this.dot = new Mesh(new PlaneGeometry(2, 2), this.dotMat);
    const g = new CylinderGeometry(1, 1, 1, BEAM_SEGMENTS, 1, true);
    // Base at the origin, running up +Y (scaled to the beam length).
    g.translate(0, 0.5, 0);
    this.beam = new Mesh(g, this.beamMat);
    for (const m of [this.dot, this.beam]) {
      m.name = m === this.dot ? 'laser-dot' : 'laser-beam';
      m.layers.set(RENDER.volumetricLayer);
      m.frustumCulled = false;
      m.visible = false;
      m.userData.navIgnore = true;
      scene.add(m);
    }
  }

  /** Something draws on the volumetric layer this frame. */
  get hasVolumetricContent(): boolean {
    return this.active;
  }

  /**
   * Per frame. `color` linear hex (null: no laser fitted – hide). `hit`: where the dot goes
   * (null = nothing within range: beam only); `from`: the emitter as seen.
   */
  update(color: number | null, beam: boolean, from: Vector3, hit: Vector3 | null, camera: Camera): void {
    if (this.disposed) return;
    this.active = color !== null;
    if (color === null) {
      this.dot.visible = false;
      this.beam.visible = false;
      return;
    }
    const L = LASER_SIGHT;
    this.dotMat.uniforms.uColor.value.setHex(color, LinearSRGBColorSpace);
    this.beamMat.uniforms.uColor.value.setHex(color, LinearSRGBColorSpace);
    this.dot.visible = hit !== null;
    if (hit) {
      const dist = hit.distanceTo(camera.position);
      this.dot.position.copy(hit);
      // Pull it a little towards the camera (never inside the surface it lies on).
      _dir.subVectors(camera.position, hit).normalize();
      this.dot.position.addScaledVector(_dir, L.surfaceOffset);
      this.dot.quaternion.copy(camera.quaternion);
      this.dot.scale.setScalar(clamp(dist * L.dotPerMeter, L.minDot, L.maxDot));
      this.dotMat.uniforms.uIntensity.value = L.dotIntensity;
    }
    this.beam.visible = beam;
    if (beam) {
      let len = 0;
      if (hit) {
        _dir.subVectors(hit, from);
        len = _dir.length();
      }
      if (len < 1e-3) {
        len = L.range;
        camera.getWorldDirection(_dir);
      } else _dir.multiplyScalar(1 / len);
      this.beam.position.copy(from);
      this.beam.quaternion.copy(_q.setFromUnitVectors(Y_AXIS, _dir));
      this.beam.scale.set(L.beamWidth, len, L.beamWidth);
      this.beamMat.uniforms.uLength!.value = len;
      this.beamMat.uniforms.uIntensity.value = L.beamIntensity;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.dot, this.beam);
    this.dot.geometry.dispose();
    this.beam.geometry.dispose();
    this.dotMat.dispose();
    this.beamMat.dispose();
  }
}
