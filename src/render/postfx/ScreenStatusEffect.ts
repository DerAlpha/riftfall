/**
 * Player-state screen treatment after grading: low-health desaturation + red edge tint with a
 * heartbeat pulse, a short red edge flash on hits, and (accessibility) a daltonization matrix.
 * The colorblind matrix is compiled in only when a mode is selected (no cost otherwise).
 */
import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';
import type { Mat3 } from './colorblind';

const fragmentShader = /* glsl */ `
uniform vec4 ssHealth;
uniform vec3 ssEdge;
uniform vec3 ssTint;
#ifdef COLORBLIND
uniform mat3 ssColorMatrix;
#endif

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, vec3(lum), ssHealth.z);
  vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
  float edge = smoothstep(ssEdge.x, ssEdge.y, length(centered));
  float tintAmount = clamp((ssHealth.y + ssEdge.z) * edge, 0.0, 1.0);
  c = mix(c, ssTint, tintAmount);
#ifdef COLORBLIND
  c = clamp(ssColorMatrix * c, 0.0, 1.0);
#endif
  outputColor = vec4(c, inputColor.a);
}
`;

export class ScreenStatusEffect extends Effect {
  private colorblind = false;

  constructor(tint: readonly [number, number, number], edgeInner: number, edgeOuter: number) {
    super('ScreenStatusEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['ssHealth', new THREE.Uniform(new THREE.Vector4())],
        ['ssEdge', new THREE.Uniform(new THREE.Vector3(edgeInner, edgeOuter, 0))],
        ['ssTint', new THREE.Uniform(new THREE.Color(tint[0], tint[1], tint[2]))],
        ['ssColorMatrix', new THREE.Uniform(new THREE.Matrix3())],
      ]),
    });
  }

  /**
   * @param lowHealth 0..1 low-health factor (0 = healthy)
   * @param tintAmount 0..1 red edge tint from low health (pulse + strength already applied)
   * @param desaturation 0..1 desaturation amount
   * @param hitFlash 0..1 hit flash amount at the edges
   */
  setState(lowHealth: number, tintAmount: number, desaturation: number, hitFlash: number): void {
    (this.uniforms.get('ssHealth')!.value as THREE.Vector4).set(lowHealth, tintAmount, desaturation, 0);
    (this.uniforms.get('ssEdge')!.value as THREE.Vector3).z = hitFlash;
  }

  /** Row-major correction matrix; null/identity disables the (compiled-out) correction. Recompiles only on toggle. */
  setColorMatrix(m: Mat3 | null): void {
    const enable = m !== null && !isIdentity(m);
    if (enable) {
      (this.uniforms.get('ssColorMatrix')!.value as THREE.Matrix3).set(
        m[0],
        m[1],
        m[2],
        m[3],
        m[4],
        m[5],
        m[6],
        m[7],
        m[8],
      );
    }
    if (enable !== this.colorblind) {
      this.colorblind = enable;
      if (enable) this.defines.set('COLORBLIND', '1');
      else this.defines.delete('COLORBLIND');
      this.setChanged();
    }
  }
}

function isIdentity(m: Mat3): boolean {
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) if (Math.abs(m[i]! - id[i]!) > 1e-6) return false;
  return true;
}
