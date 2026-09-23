/**
 * Linear exposure multiply, placed right before ToneMappingEffect.
 *
 * ToneMappingEffect reads three's `toneMappingExposure` uniform, which WebGLRenderer only
 * uploads when a material is (re)bound – it works, but relies on renderer state caching and
 * is global. An explicit uniform keeps exposure local to the post chain and animatable.
 */
import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const fragmentShader = /* glsl */ `
uniform float exposure;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
}
`;

export class ExposureEffect extends Effect {
  constructor(exposure = 1) {
    super('ExposureEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['exposure', new THREE.Uniform(exposure)]]),
    });
  }

  get exposure(): number {
    return this.uniforms.get('exposure')!.value as number;
  }

  set exposure(v: number) {
    this.uniforms.get('exposure')!.value = v;
  }
}
