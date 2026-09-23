/**
 * Exponential height fog as a depth-aware post effect.
 *
 * World position is reconstructed from the (perspective, non-linear) depth buffer via the
 * inverse projection and camera world matrix. The fog optical depth is the closed-form
 * integral of density(h) = d · exp(−k·(h − h0)) along the view ray, modulated by animated 3D
 * value noise; in-scattering adds a Henyey-Greenstein sun lobe. Sky pixels (depth = 1) are
 * fogged up to a max distance. With FOG_STEPS > 0 a short jittered raymarch adds wispy
 * noise density near the camera (volumetric detail for high/ultra).
 */
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import type { FogDef } from '../../defs/maps';
import { POSTFX } from '../../defs/postfx';

const fragmentShader = /* glsl */ `
uniform vec3 fogColor;
uniform vec3 fogSunColor;
uniform vec3 fogSunDir;
uniform vec4 fogParams;
uniform vec4 fogNoiseParams;
uniform vec2 fogScatter;
uniform vec3 fogWind;
uniform vec4 fogMarch;
uniform mat4 fogProjInverse;
uniform mat4 fogCameraWorld;
uniform vec3 fogCameraPos;

float fogHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float fogNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = fogHash(i);
  float n100 = fogHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = fogHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = fogHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = fogHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = fogHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = fogHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = fogHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fogFbm(vec3 p) {
  return fogNoise(p) * 0.65 + fogNoise(p * 2.03 + vec3(11.7, 3.1, 7.9)) * 0.35;
}

float fogPhaseHG(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}

// Height density factor; the exponent is capped so points far below the base height cannot overflow.
float fogHeightDensity(float y) {
  return exp(min(-fogParams.y * (y - fogParams.z), 60.0));
}

// Closed-form optical depth of exponential height fog from ro along unit rd over dist.
float fogOpticalDepth(vec3 ro, vec3 rd, float dist) {
  float base = fogParams.x * fogHeightDensity(ro.y);
  // Lower bound avoids exp() overflow (inf/NaN) for long rays diving into dense fog.
  float k = max(fogParams.y * rd.y * dist, -60.0);
  // (1 - e^-k) / k with a series fallback near k = 0 (horizontal rays).
  float shape = abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  return base * dist * shape;
}

float fogIGN(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  bool isSky = depth >= 0.999999;
  vec4 ndc = vec4(uv * 2.0 - 1.0, (isSky ? 1.0 : depth) * 2.0 - 1.0, 1.0);
  vec4 viewPos = fogProjInverse * ndc;
  viewPos.xyz /= viewPos.w;
  vec3 worldPos = (fogCameraWorld * vec4(viewPos.xyz, 1.0)).xyz;
  vec3 ray = worldPos - fogCameraPos;
  float hitDist = length(ray);
  vec3 rd = ray / max(hitDist, 1e-5);
  // Geometry never gets more fog than the sky behind it (no bright/dark silhouettes against it).
  float dist = isSky ? fogParams.w : min(hitDist, fogParams.w);

  float od = fogOpticalDepth(fogCameraPos, rd, dist);

  // Animated large-scale modulation, sampled once part-way along the ray.
  vec3 wind = fogWind * (time * fogNoiseParams.z);
  float sampleDist = min(dist, fogNoiseParams.w) * 0.5;
  float n = fogFbm((fogCameraPos + rd * sampleDist) * fogNoiseParams.x + wind);
  od *= max(0.0, 1.0 + fogNoiseParams.y * (n * 2.0 - 1.0));

#if FOG_STEPS > 0
  float marchLen = min(dist, fogMarch.x);
  float stepLen = marchLen / float(FOG_STEPS);
  float jitter = fogIGN(gl_FragCoord.xy);
  float extra = 0.0;
  for (int i = 0; i < FOG_STEPS; i++) {
    vec3 p = fogCameraPos + rd * ((float(i) + jitter) * stepLen);
    float heightDensity = fogHeightDensity(p.y);
    float wisp = fogNoise(p * (fogNoiseParams.x * fogMarch.z) + wind * fogMarch.z);
    extra += max(wisp - fogMarch.w, 0.0) * heightDensity;
  }
  od += extra * stepLen * fogParams.x * fogMarch.y;
#endif

  float fogAmount = 1.0 - exp(-od);
  float phase = fogPhaseHG(dot(rd, fogSunDir), fogScatter.x);
  vec3 inscatter = fogColor + fogSunColor * (phase * fogScatter.y);
  outputColor = vec4(mix(inputColor.rgb, inscatter, fogAmount), inputColor.a);
}
`;

export class HeightFogEffect extends Effect {
  private readonly camera: THREE.PerspectiveCamera;
  private steps = -1;

  constructor(camera: THREE.PerspectiveCamera, fogSteps = 0) {
    const hf = POSTFX.heightFog;
    super('HeightFogEffect', fragmentShader, {
      // Runtime value is DEPTH; the shipped typings declare the enum with wrong ordinals.
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      defines: new Map([['FOG_STEPS', '0']]),
      uniforms: new Map<string, THREE.Uniform>([
        ['fogColor', new THREE.Uniform(new THREE.Color(0.05, 0.07, 0.09))],
        ['fogSunColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['fogSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['fogParams', new THREE.Uniform(new THREE.Vector4(0, 0.2, 0, hf.maxSkyDistance))],
        ['fogNoiseParams', new THREE.Uniform(new THREE.Vector4(0.08, 0, 0, hf.noiseSampleDistance))],
        ['fogScatter', new THREE.Uniform(new THREE.Vector2(0.7, 0))],
        [
          'fogWind',
          new THREE.Uniform(
            new THREE.Vector3(hf.windDirection[0], hf.windDirection[1], hf.windDirection[2]).normalize(),
          ),
        ],
        [
          'fogMarch',
          new THREE.Uniform(
            new THREE.Vector4(hf.marchDistance, hf.marchDensity, hf.marchNoiseScale, hf.marchNoiseThreshold),
          ),
        ],
        ['fogProjInverse', new THREE.Uniform(camera.projectionMatrixInverse)],
        ['fogCameraWorld', new THREE.Uniform(camera.matrixWorld)],
        ['fogCameraPos', new THREE.Uniform(new THREE.Vector3())],
      ]),
    });
    this.camera = camera;
    this.setSteps(fogSteps);
  }

  /** Raymarch sample count (0 = analytic only). Changing it recompiles the pass – settings changes only. */
  setSteps(steps: number): void {
    const s = Math.max(0, Math.floor(steps));
    if (s === this.steps) return;
    this.steps = s;
    this.defines.set('FOG_STEPS', s.toFixed(0));
    this.setChanged();
  }

  setFog(def: FogDef): void {
    const u = this.uniforms;
    (u.get('fogColor')!.value as THREE.Color).setRGB(def.color[0], def.color[1], def.color[2]);
    (u.get('fogParams')!.value as THREE.Vector4).set(
      def.density,
      Math.max(1e-4, def.heightFalloff),
      def.baseHeight,
      POSTFX.heightFog.maxSkyDistance,
    );
    const np = u.get('fogNoiseParams')!.value as THREE.Vector4;
    np.set(def.noiseScale, def.noiseStrength, def.noiseSpeed, POSTFX.heightFog.noiseSampleDistance);
    (u.get('fogScatter')!.value as THREE.Vector2).set(def.sunScatterG, def.sunScatterStrength);
  }

  /**
   * @param travelDir direction the sunlight travels (from the sun towards the scene)
   * @param color linear sun color, already multiplied with its intensity
   */
  setSun(travelDir: THREE.Vector3, color: THREE.Color): void {
    (this.uniforms.get('fogSunDir')!.value as THREE.Vector3).copy(travelDir).negate().normalize();
    (this.uniforms.get('fogSunColor')!.value as THREE.Color)
      .copy(color)
      .multiplyScalar(POSTFX.heightFog.sunIntensityScale);
  }

  override update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget, _dt?: number): void {
    // Matrices are shared by reference; only the position needs extracting.
    (this.uniforms.get('fogCameraPos')!.value as THREE.Vector3).setFromMatrixPosition(
      this.camera.matrixWorld,
    );
  }
}
