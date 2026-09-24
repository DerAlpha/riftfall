/**
 * Charge glow at the weapon's muzzle (railgun): ONE camera-facing quad parented to the viewmodel's
 * muzzle socket anchor (viewmodel scene, drawn with the weapon, blooms). The fragment shader draws
 * everything procedurally from the charge amount and time: a core that swells with the charge,
 * sparks spiralling into it, a contracting ring, crackling arcs, and a pulse once fully charged.
 */
import * as THREE from 'three';
import { ARSENAL_VFX, type ChargeStyleDef } from '../../defs/arsenalVfx';
import { ENGINE } from '../../defs/engine';
import { NOISE_GLSL } from './glsl';

const VERTEX = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  // Billboard at the anchor: face the viewmodel camera whatever the socket's orientation.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  vP = position.xy * 2.0;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform float uSwirl;
uniform float uPulse;
uniform vec3 uColor;
uniform vec3 uCore;
varying vec2 vP;
${NOISE_GLSL}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float amt = clamp(uAmount, 0.0, 1.0);
  float t = uTime;
  float ang = atan(vP.y, vP.x);
  // Core swelling with the charge.
  float coreR = 0.04 + 0.2 * amt * amt;
  float core = exp(-r * r / (coreR * coreR)) * (0.4 + amt);
  float halo = exp(-r * 4.5) * amt * 0.5;
  // Sparks spiralling in (faster as the charge builds).
  float sparks = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float h1 = fract(sin(fi * 12.9898) * 43758.5453);
    float h2 = fract(sin(fi * 78.233) * 12543.1234);
    float ph = fract(h2 + t * (0.8 + amt * 2.2) * uSwirl);
    float rad = (1.0 - ph) * 0.9;
    float a = h1 * 6.2832 + ph * (2.0 + h1 * 2.0) * uSwirl;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 d = vP - dir * rad;
    // Stretched along the fall direction.
    float along = dot(d, dir);
    float across = dot(d, vec2(-dir.y, dir.x));
    float s = exp(-(along * along * 180.0 + across * across * 2500.0));
    sparks += s * smoothstep(0.0, 0.2, ph) * (0.3 + amt);
  }
  // Ring contracting onto the core.
  float ringR = mix(0.85, 0.3, amt);
  float ring = exp(-pow((r - ringR) / 0.035, 2.0)) * amt * (0.6 + 0.4 * sin(ang * 6.0 + t * 9.0));
  // Crackling arcs once the charge is well under way.
  float tt = floor(t * 26.0);
  float arcs = aRidge(aNoise(vec2(ang * 2.5 + tt * 1.3, r * 3.5 - tt)), 18.0);
  arcs *= smoothstep(0.35, 0.8, amt) * (1.0 - smoothstep(0.2, 0.9, r)) * 1.3;
  float ready = amt >= 0.999 ? 1.0 + 0.45 * sin(t * 6.2832 * uPulse) : 1.0;
  vec3 rgb = (uColor * (sparks * 1.4 + ring + arcs + halo) + uCore * core * 2.0) * ready;
  rgb *= 1.0 - smoothstep(0.85, 1.0, r);
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

export class ChargeGlow {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly u: {
    uAmount: { value: number };
    uTime: { value: number };
    uSize: { value: number };
    uSwirl: { value: number };
    uPulse: { value: number };
    uColor: { value: THREE.Color };
    uCore: { value: THREE.Color };
  };

  constructor() {
    this.u = {
      uAmount: { value: 0 },
      uTime: { value: 0 },
      uSize: { value: 0.1 },
      uSwirl: { value: 1 },
      uPulse: { value: 8 },
      uColor: { value: new THREE.Color() },
      uCore: { value: new THREE.Color() },
    };
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      name: 'ArsenalCharge',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = 'ArsenalChargeGlow';
    mesh.frustumCulled = false;
    mesh.renderOrder = ARSENAL_VFX.charge.renderOrder;
    mesh.layers.enable(ENGINE.viewmodelLayer);
    mesh.visible = false;
    this.mesh = mesh;
  }

  /** Re-parent onto the muzzle socket anchor (null detaches). */
  attach(parent: THREE.Object3D | null): void {
    if (parent === this.mesh.parent) return;
    this.mesh.removeFromParent();
    parent?.add(this.mesh);
  }

  /** Show the glow at `amount` (0..1); `intensityScale` dims it (reduce flashing). */
  show(style: ChargeStyleDef, amount: number, time: number, intensityScale: number): void {
    const u = this.u;
    const k = style.intensity * Math.max(0, intensityScale);
    u.uAmount.value = amount;
    u.uTime.value = time;
    u.uSize.value = style.size[0] + (style.size[1] - style.size[0]) * amount;
    u.uSwirl.value = style.swirl;
    u.uPulse.value = style.readyPulse;
    u.uColor.value.setRGB(style.color[0] * k, style.color[1] * k, style.color[2] * k, THREE.LinearSRGBColorSpace);
    u.uCore.value.setRGB(
      style.coreColor[0] * k,
      style.coreColor[1] * k,
      style.coreColor[2] * k,
      THREE.LinearSRGBColorSpace,
    );
    this.mesh.visible = this.mesh.parent !== null && amount > 0;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /** Warm-up: visible and black (additive → invisible). */
  setWarmup(active: boolean): void {
    if (active) {
      this.u.uAmount.value = 0;
      this.u.uColor.value.setRGB(0, 0, 0);
      this.u.uCore.value.setRGB(0, 0, 0);
      this.mesh.visible = this.mesh.parent !== null;
    } else {
      this.hide();
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
