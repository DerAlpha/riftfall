/**
 * Ground rift tears under emerging enemies: one instanced additive quad per emerging enemy (one
 * draw call for all types), a jagged glowing slit that opens as the creature starts to rise and
 * closes behind it. HDR rim (blooms) over a violet core, scrolling noise from the enemy surface
 * texture. Lives on RENDER.volumetricLayer like the other additive world effects (drawn after AO
 * and height fog by the VolumetricPass) and fogs itself with the shared height-fog GLSL.
 * The owner reports `visible` through its hasVolumetricContent probe.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  DynamicDrawUsage,
  type Object3D,
  type Texture,
} from 'three';
import { ENEMY_RENDER } from '../../defs/enemyVisuals';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import { setUpdateRange, type UpdateRange } from '../../vfx/gpuUpload';

const T = ENEMY_RENDER.tears;

const VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
attribute vec4 aTear0; // world xyz, radius
attribute vec4 aTear1; // open 0..1, seed, yaw, color index (unused)
uniform float uLift;
varying vec2 vP;
varying vec2 vTear;
varying float vFog;
void main() {
	float c = cos( aTear1.z );
	float s = sin( aTear1.z );
	vec2 q = position.xy * aTear0.w;
	vec3 wp = aTear0.xyz + vec3( c * q.x + s * q.y, uLift, - s * q.x + c * q.y );
	vP = position.xy;
	vTear = aTear1.xy;
	vFog = fogTransmittance( cameraPosition, wp );
	gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uRim;
uniform vec3 uCore;
uniform float uHalo;
uniform float uAspect;
uniform float uTime;
uniform float uScroll;
varying vec2 vP;
varying vec2 vTear;
varying float vFog;
void main() {
	float open = vTear.x;
	float seed = vTear.y * 17.0;
	vec4 n0 = texture( uNoise, vP * 0.45 + vec2( uTime * uScroll, seed ) );
	vec4 n1 = texture( uNoise, vP * 1.3 - vec2( seed, uTime * uScroll * 1.7 ) );
	// Slit: an ellipse that widens with 'open', edges torn by two noise octaves.
	float width = max( uAspect * open, 0.02 );
	vec2 e = vec2( vP.x, vP.y / width );
	float r = length( e ) + ( n0.r - 0.5 ) * 0.55 + ( n1.a - 0.5 ) * 0.2;
	float edge = r - 0.72;
	float inside = 1.0 - smoothstep( -0.25, 0.0, edge );
	float rim = exp( - abs( edge ) * 14.0 ) * ( 0.45 + 0.9 * n1.b );
	// Energy crackling outwards from the tear, fading with distance.
	float crackle = n1.b * n0.g * exp( - max( edge, 0.0 ) * 4.0 ) * ( 1.0 - inside );
	float halo = exp( - max( length( vP ) - 0.25, 0.0 ) * 5.0 ) * uHalo;
	float fade = 1.0 - smoothstep( 0.85, 1.0, length( vP ) );
	vec3 col = uCore * inside * ( 0.1 + 0.9 * n1.b ) + uRim * ( rim + 0.35 * crackle ) + uCore * halo;
	gl_FragColor = vec4( col * open * fade * vFog, 1.0 );
}
`;

export class RiftTears {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly a0: InstancedBufferAttribute;
  private readonly a1: InstancedBufferAttribute;
  private readonly r0: UpdateRange = { start: 0, count: 0 };
  private readonly r1: UpdateRange = { start: 0, count: 0 };
  private count = 0;
  readonly capacity: number = T.capacity;

  constructor(parent: Object3D, noise: Texture | null, time: { value: number }) {
    const plane = new PlaneGeometry(2, 2, 1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(plane.getIndex());
    geometry.setAttribute('position', plane.getAttribute('position'));
    this.a0 = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.a1 = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.a0.setUsage(DynamicDrawUsage);
    this.a1.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aTear0', this.a0);
    geometry.setAttribute('aTear1', this.a1);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    const rim = ENEMY_RENDER.tears;
    this.material = new ShaderMaterial({
      name: 'enemy-rift-tears',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uNoise: { value: noise },
        uRim: { value: new Color(0, 0, 0) },
        uCore: {
          value: new Color(rim.coreColor[0], rim.coreColor[1], rim.coreColor[2]).multiplyScalar(
            rim.coreIntensity,
          ),
        },
        uHalo: { value: rim.haloIntensity },
        uAspect: { value: rim.aspect },
        uLift: { value: rim.lift },
        uScroll: { value: rim.scroll },
        uTime: time,
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      // The XY quad is laid onto XZ by the vertex shader (mirrored winding): never cull it.
      side: DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const mesh = new Mesh(geometry, this.material);
    mesh.name = 'EnemyRiftTears';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = 2;
    mesh.layers.set(RENDER.volumetricLayer);
    parent.add(mesh);
    this.mesh = mesh;
  }

  /** Rim color (linear RGB × intensity) of the tears. */
  setColor(r: number, g: number, b: number): void {
    (this.material.uniforms.uRim!.value as Color).setRGB(
      r * T.rimIntensity,
      g * T.rimIntensity,
      b * T.rimIntensity,
    );
  }

  begin(): void {
    this.count = 0;
  }

  /** Queue one tear this frame; false when the pool is full. */
  push(x: number, y: number, z: number, radius: number, open: number, seed: number, yaw: number): boolean {
    if (this.count >= this.capacity || !(open > 0)) return false;
    const o = this.count * 4;
    const a = this.a0.array as Float32Array;
    const b = this.a1.array as Float32Array;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = radius;
    b[o] = Math.min(1, open);
    b[o + 1] = seed;
    b[o + 2] = yaw;
    b[o + 3] = 0;
    this.count++;
    return true;
  }

  /** Upload the used range once and show/hide the draw. */
  end(): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    setUpdateRange(this.a0, this.r0, 0, n * 4);
    setUpdateRange(this.a1, this.r1, 0, n * 4);
    this.a0.needsUpdate = true;
    this.a1.needsUpdate = true;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  get drawn(): number {
    return this.count;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Tear opening for an emerge value: opens fast, holds, closes as the body clears the floor. */
export function tearOpen(emerge: number): number {
  if (!(emerge < 1)) return 0;
  const e = Math.max(0, emerge);
  const openT = Math.min(1, e / T.openUntil);
  const open = openT * openT * (3 - 2 * openT);
  const c = Math.min(1, Math.max(0, (e - T.closeFrom) / (1 - T.closeFrom)));
  return open * (1 - c * c * (3 - 2 * c));
}
