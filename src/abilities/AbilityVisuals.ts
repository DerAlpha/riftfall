/**
 * In-world ability looks (AbilityVisualsApi): the Schockwelle's shock ring racing out over the
 * floor and the Chronofeld's time dome moving with the player (defs/abilities ABILITY_VISUALS).
 *
 * Each look is a flat floor disc + a low open cylinder "curtain", additive, on
 * RENDER.volumetricLayer (drawn after AO and height fog, depth-tested, no depth write, fogged in
 * the shader like every volumetric; `hasVolumetricContent` feeds the pass probe). Two programs
 * (disc, curtain) shared by both looks; the meshes live in the scene from construction, so the
 * boot warm-up (compileForPostChain) compiles them. Per frame only uniforms and transforms change.
 *
 * - shockRing: the ring grows to the blast radius over `duration` (ease-out) with an electric
 *   flicker and a short light wall riding on it; a screen-space shockwave at the start.
 * - chronoDome: rim band with clock ticks and a slow sweep hand, faint ripples crawling INWARDS
 *   (slowed time), a curtain rising from the rim; follows the rendered camera over the floor below
 *   it (one physics ray per frame), grows in / fades out.
 */
import {
  AdditiveBlending,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import type { PhysicsApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { clamp01 } from '../core/math';
import { ABILITY_VISUALS, type AbilityWorldFx } from '../defs/abilities';
import { RENDER } from '../defs/graphics';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';
import type { AbilityVisualsApi } from './AbilitySystem';

const FLOOR_GROUPS = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);
const DOWN = { x: 0, y: -1, z: 0 };
/** Discs sit this far above the floor (no z-fighting; the depth test keeps them under walls). */
const FLOOR_LIFT = 0.03;
/** The floor probe starts this far above the anchor. */
const PROBE_LIFT = 0.2;

const MODE_CHRONO = 0;
const MODE_SHOCK = 1;

const COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform float uIntensity;
uniform float uMode;
uniform float uProgress;
uniform vec3 uColor;
uniform vec3 uRim;
varying float vFog;
float aHash(float n) { return fract(sin(n) * 43758.5453); }
float aNoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(aHash(i), aHash(i + 1.0), f * f * (3.0 - 2.0 * f));
}
`;

const DISC_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vP;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = position.xz;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DISC_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform float uTicks;
uniform float uRipple;
uniform float uWidth;
varying vec2 vP;
const float TAU = 6.2831853;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  vec3 col;
  if (uMode < 0.5) {
    // Chronofeld: rim band + clock ticks, a slow sweep hand, ripples crawling inwards.
    float edge = 1.0 - r;
    float rim = exp(-pow(edge / 0.012, 2.0)) + 0.35 * exp(-pow(edge / 0.07, 2.0));
    float cell = ang / TAU * uTicks + uTime * 0.04;
    float d = abs(fract(cell) - 0.5);
    float major = step(mod(floor(cell) + 0.5, 6.0), 1.0);
    float tickLine = 1.0 - smoothstep(0.05, 0.12, d);
    float tickBand = smoothstep(0.9 - 0.06 * major, 0.915 - 0.06 * major, r) * (1.0 - smoothstep(0.965, 0.98, r));
    float ticks = tickLine * tickBand * (0.55 + 0.45 * major);
    float ph = fract(r * 5.0 + uTime * uRipple);
    float ripple = smoothstep(0.0, 0.03, ph) * (1.0 - smoothstep(0.03, 0.1, ph));
    ripple *= smoothstep(0.25, 0.9, r) * 0.28;
    float sweepA = fract(ang / TAU - uTime * 0.07);
    float sweep = pow(1.0 - sweepA, 10.0) * smoothstep(0.2, 0.95, r) * 0.4;
    float fill = 0.05 * smoothstep(0.35, 1.0, r);
    col = uColor * (ripple + sweep + fill) + uRim * (rim + ticks);
  } else {
    // Schockwelle: an electric ring at the current radius with a fading wake behind it.
    float p = uProgress;
    float w = max(uWidth * max(p, 0.08), 1e-3);
    float x = (r - p) / w;
    float ring = exp(-x * x * 3.0);
    float wake = smoothstep(-6.0, 0.0, x) * (1.0 - step(0.0, x)) * 0.22;
    float flick = 0.55 + 0.45 * aNoise1(ang * 18.0 + uTime * 40.0);
    float arcs = pow(aNoise1(ang * 7.0 - uTime * 25.0), 6.0) * 2.5;
    col = uRim * ring * (flick + arcs) + uColor * wake;
    col *= pow(1.0 - p, 1.4);
  }
  gl_FragColor = vec4(col * uIntensity * uFade * vFog, 1.0);
}
`;

const WALL_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying float vH;
varying float vAng;
varying float vFacing;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vH = position.y;
  vAng = atan(position.z, position.x);
  vec3 n = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
  vec3 v = normalize(cameraPosition - wp.xyz);
  vFacing = abs(dot(n, v));
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WALL_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
varying float vH;
varying float vAng;
varying float vFacing;
void main() {
  float h = clamp(vH, 0.0, 1.0);
  float base = pow(1.0 - h, 2.6);
  vec3 col;
  if (uMode < 0.5) {
    // Time curtain: bright at the floor, fading up; slow rising scan lines, fine vertical threads.
    float scan = smoothstep(0.85, 1.0, fract(h * 5.0 - uTime * 0.18)) * 0.5;
    float threads = 0.65 + 0.35 * sin(vAng * 90.0 + h * 3.0);
    float graze = 0.3 + 0.7 * (1.0 - vFacing);
    col = mix(uColor, uRim, base) * (base * threads + scan * (1.0 - h)) * graze;
  } else {
    float flick = 0.6 + 0.4 * aNoise1(vAng * 14.0 + uTime * 35.0);
    col = uRim * base * flick * pow(1.0 - uProgress, 1.6);
  }
  gl_FragColor = vec4(col * uIntensity * uFade * vFog, 1.0);
}
`;

interface Look {
  readonly fx: AbilityWorldFx;
  readonly disc: Mesh;
  readonly wall: Mesh;
  readonly discMat: ShaderMaterial;
  readonly wallMat: ShaderMaterial;
  active: boolean;
  age: number;
  duration: number;
  /** Age at which stop() started the fade-out (−1 = running). */
  stoppedAt: number;
  radius: number;
  readonly center: Vector3;
}

export interface AbilityVisualsDeps {
  /** Scene the meshes live in (render.scene). */
  parent: Object3D;
  /** Chronofeld anchor: the rendered camera (the dome follows it smoothly). */
  anchor: () => Vec3Like;
  /** Floor probe below the anchor; null = the dome stays at the cast height. */
  physics?: Pick<PhysicsApi, 'raycast'> | null;
  /** Screen-space shockwave (render.addShockwave), already scaled by accessibility.screenShake. */
  shockwave?: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  reduceFlashing?: boolean;
}

const _probe = new Vector3();

export class AbilityVisuals implements AbilityVisualsApi {
  private readonly looks: Look[] = [];
  private readonly deps: AbilityVisualsDeps;
  private time = 0;
  private flashScale = 1;
  private disposed = false;

  constructor(deps: AbilityVisualsDeps) {
    this.deps = deps;
    this.flashScale = deps.reduceFlashing ? ABILITY_VISUALS.reducedFlashingScale : 1;
    const seg = ABILITY_VISUALS.segments;
    const discGeo = new CircleGeometry(1, seg).rotateX(-Math.PI / 2);
    const wallGeo = new CylinderGeometry(1, 1, 1, seg, 1, true).translate(0, 0.5, 0);
    const discBase = this.material(DISC_VERTEX, DISC_FRAGMENT, true);
    const wallBase = this.material(WALL_VERTEX, WALL_FRAGMENT, false);
    this.looks.push(this.look('chronoDome', discGeo, wallGeo, discBase, wallBase, MODE_CHRONO));
    this.looks.push(this.look('shockRing', discGeo, wallGeo, discBase.clone(), wallBase.clone(), MODE_SHOCK));
  }

  /** True while a look draws (volumetric pass probe). */
  get hasVolumetricContent(): boolean {
    for (const l of this.looks) if (l.active) return true;
    return false;
  }

  /** Looks drawing right now (debug / tests). */
  get activeLooks(): number {
    let n = 0;
    for (const l of this.looks) if (l.active) n++;
    return n;
  }

  start(fx: AbilityWorldFx, position: Vec3Like, radius: number, duration: number): void {
    const look = this.find(fx);
    if (!look || this.disposed || !(radius > 0)) return;
    look.active = true;
    look.age = 0;
    look.stoppedAt = -1;
    look.radius = radius;
    look.center.set(position.x, position.y, position.z);
    if (fx === 'shockRing') {
      const S = ABILITY_VISUALS.shockRing;
      look.duration = S.duration;
      this.deps.shockwave?.(look.center, radius * S.shockwaveRadius, S.shockwave);
    } else {
      look.duration = duration > 0 ? duration : ABILITY_VISUALS.chronoDome.fadeIn;
      this.deps.shockwave?.(look.center, radius, ABILITY_VISUALS.chronoDome.shockwave);
    }
    look.disc.visible = true;
    look.wall.visible = true;
  }

  stop(fx: AbilityWorldFx): void {
    const look = this.find(fx);
    if (look?.active && look.stoppedAt < 0) look.stoppedAt = look.age;
  }

  setReducedFlashing(on: boolean): void {
    this.flashScale = on ? ABILITY_VISUALS.reducedFlashingScale : 1;
  }

  /** Per frame (after the camera moved). */
  update(dt: number): void {
    const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
    this.time += step;
    for (const l of this.looks) {
      if (!l.active) continue;
      l.age += step;
      if (l.fx === 'shockRing') this.updateShock(l);
      else this.updateChrono(l);
    }
  }

  clear(): void {
    for (const l of this.looks) this.hide(l);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geos = new Set<BufferGeometry>();
    for (const l of this.looks) {
      l.disc.removeFromParent();
      l.wall.removeFromParent();
      geos.add(l.disc.geometry);
      geos.add(l.wall.geometry);
      l.discMat.dispose();
      l.wallMat.dispose();
    }
    for (const g of geos) g.dispose();
    this.looks.length = 0;
  }

  // -------------------------------------------------------------------------

  private updateShock(l: Look): void {
    const S = ABILITY_VISUALS.shockRing;
    const t = l.duration > 0 ? l.age / l.duration : 1;
    if (t >= 1) {
      this.hide(l);
      return;
    }
    // Ease-out: the front leaves fast and slows at the blast radius.
    const p = 1 - (1 - t) * (1 - t) * (1 - t);
    this.setUniforms(l, 1, S.intensity, p);
    const r = Math.max(0.05, l.radius * p);
    l.disc.position.set(l.center.x, l.center.y + FLOOR_LIFT, l.center.z);
    l.disc.scale.set(l.radius, 1, l.radius);
    l.wall.position.set(l.center.x, l.center.y, l.center.z);
    l.wall.scale.set(r, S.wallHeight * (1 - 0.5 * p), r);
    l.disc.updateMatrix();
    l.wall.updateMatrix();
  }

  private updateChrono(l: Look): void {
    const C = ABILITY_VISUALS.chronoDome;
    const end = l.stoppedAt >= 0 ? Math.min(l.stoppedAt, l.duration) : l.duration;
    const fadeIn = C.fadeIn > 0 ? clamp01(l.age / C.fadeIn) : 1;
    const fadeOut = l.age <= end ? 1 : C.fadeOut > 0 ? 1 - (l.age - end) / C.fadeOut : 0;
    const fade = Math.min(fadeIn, fadeOut);
    if (fade <= 0 && l.age > end) {
      this.hide(l);
      return;
    }
    // Follow the rendered camera over the floor below it (smooth at any frame rate).
    const a = this.deps.anchor();
    if (Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)) {
      let y = l.center.y;
      const physics = this.deps.physics;
      if (physics) {
        _probe.set(a.x, a.y + PROBE_LIFT, a.z);
        const reach = C.floorProbe + PROBE_LIFT + Math.max(0, a.y - l.center.y);
        const hit = physics.raycast(_probe, DOWN, reach, {
          groups: FLOOR_GROUPS,
        });
        if (hit) y = hit.point.y;
      }
      l.center.set(a.x, y, a.z);
    }
    const grow = 0.6 + 0.4 * (1 - (1 - fadeIn) * (1 - fadeIn));
    const r = l.radius * grow;
    this.setUniforms(l, fade, C.intensity, 0);
    l.disc.position.set(l.center.x, l.center.y + FLOOR_LIFT, l.center.z);
    l.disc.scale.set(r, 1, r);
    l.wall.position.set(l.center.x, l.center.y, l.center.z);
    l.wall.scale.set(r, C.wallHeight * fade, r);
    l.disc.updateMatrix();
    l.wall.updateMatrix();
  }

  private setUniforms(l: Look, fade: number, intensity: number, progress: number): void {
    for (const m of [l.discMat, l.wallMat]) {
      const u = m.uniforms;
      u.uTime!.value = this.time;
      u.uFade!.value = fade;
      u.uIntensity!.value = intensity * this.flashScale;
      u.uProgress!.value = progress;
    }
  }

  private hide(l: Look): void {
    l.active = false;
    l.stoppedAt = -1;
    l.disc.visible = false;
    l.wall.visible = false;
  }

  private find(fx: AbilityWorldFx): Look | null {
    for (const l of this.looks) if (l.fx === fx) return l;
    return null;
  }

  private material(vertexShader: string, fragmentShader: string, disc: boolean): ShaderMaterial {
    const C = ABILITY_VISUALS.chronoDome;
    return new ShaderMaterial({
      name: disc ? 'AbilityDisc' : 'AbilityWall',
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 0 },
        uIntensity: { value: 1 },
        uMode: { value: MODE_CHRONO },
        uProgress: { value: 0 },
        uColor: { value: new Vector3(...C.color) },
        uRim: { value: new Vector3(...C.rimColor) },
        uTicks: { value: C.ticks },
        uRipple: { value: C.rippleRate },
        uWidth: { value: ABILITY_VISUALS.shockRing.width },
        fogParams: HEIGHT_FOG_PARAMS,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      fog: false,
      // Discs lie on the floor: pulled towards the camera so they never z-fight with it.
      polygonOffset: disc,
      polygonOffsetFactor: disc ? -2 : 0,
      polygonOffsetUnits: disc ? -2 : 0,
    });
  }

  private look(
    fx: AbilityWorldFx,
    discGeo: BufferGeometry,
    wallGeo: BufferGeometry,
    discMat: ShaderMaterial,
    wallMat: ShaderMaterial,
    mode: number,
  ): Look {
    for (const m of [discMat, wallMat]) {
      m.uniforms.uMode!.value = mode;
      // clone() copies uniform values: the fog uniform must stay the shared object.
      m.uniforms.fogParams = HEIGHT_FOG_PARAMS;
      if (mode === MODE_SHOCK) {
        const S = ABILITY_VISUALS.shockRing;
        (m.uniforms.uColor!.value as Vector3).set(...S.color);
        (m.uniforms.uRim!.value as Vector3).set(...S.color);
      }
    }
    const disc = new Mesh(discGeo, discMat);
    const wall = new Mesh(wallGeo, wallMat);
    for (const [mesh, name] of [
      [disc, `ability-${fx}-disc`],
      [wall, `ability-${fx}-wall`],
    ] as const) {
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.renderOrder = ABILITY_VISUALS.renderOrder;
      mesh.layers.set(RENDER.volumetricLayer);
      this.deps.parent.add(mesh);
    }
    return {
      fx,
      disc,
      wall,
      discMat,
      wallMat,
      active: false,
      age: 0,
      duration: 0,
      stoppedAt: -1,
      radius: 1,
      center: new Vector3(),
    };
  }
}
