/**
 * Camera motion blur: reconstructs each pixel's world position from depth, reprojects it with
 * the previous frame's view-projection and blurs along the resulting screen-space velocity.
 * The blur length is normalized to a reference frame rate (framerate independent), scaled by
 * the shutter fraction and clamped. Sky pixels (depth = 1) reproject from the far plane, which
 * yields rotation-only blur. Convolution effect: must be the first effect of its EffectPass
 * (EffectPass sorts convolution effects first).
 */
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { POSTFX } from '../../defs/postfx';

const fragmentShader = /* glsl */ `
uniform mat4 mbPrevViewProj;
uniform mat4 mbProjInverse;
uniform mat4 mbCameraWorld;
uniform vec2 mbParams;

float mbIGN(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, min(depth, 1.0) * 2.0 - 1.0, 1.0);
  vec4 viewPos = mbProjInverse * ndc;
  viewPos.xyz /= viewPos.w;
  vec4 worldPos = mbCameraWorld * vec4(viewPos.xyz, 1.0);
  vec4 prevClip = mbPrevViewProj * worldPos;
  vec2 velocity = vec2(0.0);
  if (prevClip.w > 1e-4) {
    vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    velocity = (uv - prevUv) * mbParams.x;
  }
  float speed = length(velocity);
  if (speed > mbParams.y) velocity *= mbParams.y / speed;
  if (speed * resolution.x < 0.5) {
    outputColor = inputColor;
    return;
  }
  float jitter = mbIGN(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < MB_SAMPLES; i++) {
    float t = (float(i) + jitter) / float(MB_SAMPLES) - 0.5;
    acc += texture2D(inputBuffer, uv + velocity * t).rgb;
  }
  outputColor = vec4(acc / float(MB_SAMPLES), inputColor.a);
}
`;

const _viewProj = new THREE.Matrix4();

export class MotionBlurEffect extends Effect {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly lastViewProj = new THREE.Matrix4();
  private hasHistory = false;
  private frameDt = 1 / 60;

  constructor(camera: THREE.PerspectiveCamera) {
    const mb = POSTFX.motionBlur;
    super('MotionBlurEffect', fragmentShader, {
      // Typings declare EffectAttribute with wrong ordinals; the runtime values combine as bit flags.
      attributes: (EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION) as EffectAttribute,
      blendFunction: BlendFunction.NORMAL,
      defines: new Map([['MB_SAMPLES', Math.max(1, Math.floor(mb.samples)).toFixed(0)]]),
      uniforms: new Map<string, THREE.Uniform>([
        ['mbPrevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['mbProjInverse', new THREE.Uniform(camera.projectionMatrixInverse)],
        ['mbCameraWorld', new THREE.Uniform(camera.matrixWorld)],
        ['mbParams', new THREE.Uniform(new THREE.Vector2(0, mb.maxVelocity))],
      ]),
    });
    this.camera = camera;
  }

  /** Real frame delta of the frame about to be rendered (seconds). */
  setFrameDelta(dt: number): void {
    this.frameDt = dt;
  }

  /** Forget the previous frame (teleport, camera cut, resume from pause) so no bogus streak appears. */
  resetHistory(): void {
    this.hasHistory = false;
  }

  override update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget, _dt?: number): void {
    const cam = this.camera;
    _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const prev = this.uniforms.get('mbPrevViewProj')!.value as THREE.Matrix4;
    const params = this.uniforms.get('mbParams')!.value as THREE.Vector2;
    const mb = POSTFX.motionBlur;
    if (this.hasHistory && this.frameDt > 0) {
      prev.copy(this.lastViewProj);
      // Scale so a given camera speed gives the same blur length at any frame rate.
      params.x = (mb.intensity * (1 / mb.referenceFps)) / Math.max(this.frameDt, 1e-4);
    } else {
      prev.copy(_viewProj);
      params.x = 0;
    }
    params.y = mb.maxVelocity;
    this.lastViewProj.copy(_viewProj);
    this.hasHistory = true;
  }
}
