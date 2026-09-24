/**
 * Shared kit of the energy and wonder weapon viewmodels (M5, package C3).
 *
 * - `createEnergyMaterial`: one unlit HDR "energy" program for every glowing volume (plasma cells,
 *   coils, singularity cores, light strings, pilot flames, ice cores): a facing → rim color ramp,
 *   drifting value noise sharpened into filaments, and an optional vertex wave along the mesh's
 *   own UV v (standing wave for strings pinned at both ends, a free-tip wobble for flames). Every
 *   instance shares the program (uniform values only), so the boot warm-up compiles it once.
 * - `EnergyWeaponModel`: a ProceduralWeaponModel that also animates those materials (breathing,
 *   per-shot flash, heat, driver boost) and "free" nodes the animator does not own (floating
 *   cores, gyro rings, crystals): `freeParts` pulls them out of the animator-bound part table.
 * - Geometry helpers for the exotic silhouettes (helix coils, bent tubes, faceted crystals).
 *
 * Everything here is model content: the per-weapon numbers live in the model files.
 */
import {
  AdditiveBlending,
  Color,
  Curve,
  DoubleSide,
  FrontSide,
  NormalBlending,
  ShaderMaterial,
  TubeGeometry,
  Vector3,
  type BufferGeometry,
  type DataTexture,
  type Object3D,
} from 'three';
import type { WeaponViewmodelDef } from '../../../defs/viewmodels';
import type { BuiltModel } from '../ModelBuilder';
import type { GlowMaterials } from '../materials';
import { ProceduralWeaponModel, type ReadoutSpec, type ViewmodelFxState } from '../WeaponModel';

// ---------------------------------------------------------------------------
// Energy material
// ---------------------------------------------------------------------------

const ENERGY_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uWave;
uniform float uWaveRate;
uniform float uWavePin;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying float vAlong;
void main() {
  vec3 p = position;
  // Wave shape along the mesh's own v: pinned at both ends (strings) or growing to a free tip (flames).
  float along = uv.y;
  float shape = mix(sin(3.14159265 * clamp(along, 0.0, 1.0)), along, uWavePin);
  float phase = dot(position, vec3(137.0, 71.0, 53.0));
  p.x += sin(uTime * uWaveRate + phase) * uWave * shape;
  p.y += cos(uTime * uWaveRate * 0.79 + phase * 1.3) * uWave * shape * uWavePin;
  vP = position;
  vAlong = along;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vV = -mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const ENERGY_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uRim;
uniform float uIntensity;
uniform float uTime;
uniform float uRimPower;
uniform float uNoise;
uniform float uNoiseScale;
uniform vec3 uFlow;
uniform float uTip;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying float vAlong;
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float rim = pow(1.0 - facing, uRimPower);
  vec3 q = vP * uNoiseScale + uFlow * uTime;
  float nz = vnoise(q) * 0.62 + vnoise(q * 2.63 + 7.1) * 0.38;
  // Sharpen the noise into thin bright filaments on a dimmer body.
  float veins = pow(1.0 - abs(nz * 2.0 - 1.0), 7.0);
  float m = mix(1.0, 0.3 + 0.7 * nz + 1.4 * veins, uNoise);
  // uTip fades the far end (flame tips) out along v.
  float tip = 1.0 - uTip * smoothstep(0.35, 1.0, vAlong);
  vec3 col = mix(uCore, uRim, rim) * (uIntensity * m * tip);
  gl_FragColor = vec4(col, uOpacity * tip);
}
`;

export interface EnergyMaterialOptions {
  /** sRGB hex seen face-on (the hot interior) and at grazing angles (the glowing rim). */
  core: number;
  rim: number;
  /** Rim falloff exponent (higher = thinner rim). */
  rimPower?: number;
  /** 0..1 filament noise depth, noise frequency (1/m) and drift (noise units/s). */
  noise?: number;
  noiseScale?: number;
  flow?: readonly [number, number, number];
  /** Additive (glow shells, flames, light strings) instead of opaque. */
  additive?: boolean;
  opacity?: number;
  /** Vertex wave: amplitude is animated per frame; rate (rad/s) and pinning are fixed. */
  waveRate?: number;
  /** 0 = pinned at both ends (strings), 1 = free tip (flames). */
  wavePin?: number;
  /** 0..1 fade towards the far end of the mesh's v (flame tips). */
  tip?: number;
}

export type EnergyUniforms = {
  uCore: { value: Color };
  uRim: { value: Color };
  uIntensity: { value: number };
  uTime: { value: number };
  uRimPower: { value: number };
  uNoise: { value: number };
  uNoiseScale: { value: number };
  uFlow: { value: Vector3 };
  uTip: { value: number };
  uOpacity: { value: number };
  uWave: { value: number };
  uWaveRate: { value: number };
  uWavePin: { value: number };
};

export type EnergyMaterial = ShaderMaterial & { uniforms: EnergyUniforms };

/** An unlit glowing material (linear HDR output: intensities > 1 bloom). */
export function createEnergyMaterial(name: string, o: EnergyMaterialOptions): EnergyMaterial {
  const uniforms: EnergyUniforms = {
    uCore: { value: new Color(o.core) },
    uRim: { value: new Color(o.rim) },
    uIntensity: { value: 1 },
    uTime: { value: 0 },
    uRimPower: { value: o.rimPower ?? 2 },
    uNoise: { value: o.noise ?? 0 },
    uNoiseScale: { value: o.noiseScale ?? 60 },
    uFlow: { value: new Vector3(...(o.flow ?? [0, 0, 0])) },
    uTip: { value: o.tip ?? 0 },
    uOpacity: { value: o.opacity ?? 1 },
    uWave: { value: 0 },
    uWaveRate: { value: o.waveRate ?? 0 },
    uWavePin: { value: o.wavePin ?? 0 },
  };
  const additive = o.additive ?? false;
  const mat = new ShaderMaterial({
    name: `vm-energy-${name}`,
    vertexShader: ENERGY_VERTEX,
    fragmentShader: ENERGY_FRAGMENT,
    uniforms,
    transparent: additive || (o.opacity ?? 1) < 1,
    blending: additive ? AdditiveBlending : NormalBlending,
    depthWrite: !additive,
    side: additive ? DoubleSide : FrontSide,
    toneMapped: false,
    fog: false,
  });
  return mat as EnergyMaterial;
}

/** How an energy material animates (intensities are emissive multipliers; > 1 blooms). */
export interface EnergyChannel {
  readonly material: EnergyMaterial;
  /** Resting intensity. */
  readonly intensity: number;
  /** Breathing: rate (rad/s) and depth (0..1). */
  readonly pulseRate?: number;
  readonly pulseDepth?: number;
  /** Intensity added at a shot's flash peak. */
  readonly flash?: number;
  /** Intensity added at full heat (squared like the heat vents). */
  readonly heat?: number;
  /** Intensity added at full driver boost (charge / beam / spin). */
  readonly boost?: number;
  /** Fast flicker (rad/s, 0..1 depth) – flames, arcs. Stops with reduced flashing. */
  readonly flickerRate?: number;
  readonly flickerDepth?: number;
  /** Vertex wave amplitude at rest and added per shot flash / boost (m). */
  readonly wave?: number;
  readonly waveFlash?: number;
  readonly waveBoost?: number;
}

/** Per-frame inputs of the extra animators. */
export interface EnergyFxState {
  time: number;
  dt: number;
  heat: number;
  flash: number;
  /** Seconds since the last detected shot (large before the first). */
  sinceShot: number;
  /** 0..1 driver level: the def drivers' current accent boost over their total (charge / beam / spin). */
  boost: number;
  /** 0..1 flicker/shimmer depth scale (0 with reduced flashing). */
  flicker: number;
}

/** Custom per-frame motion of free nodes (allocation-free closures created at build time). */
export type ExtraAnimator = (fx: Readonly<EnergyFxState>) => void;

/** A shot is a jump of the flash envelope by at least this much (it decays exponentially). */
const SHOT_FLASH_JUMP = 0.2;
const NO_SHOT_YET = 1e6;

/**
 * Sum of the def's driver accent boosts: the animator hands the model their current total
 * (fx.accentBoost, intensity units), so total / sum is the 0..1 driver level.
 */
function driverBoostSum(def: WeaponViewmodelDef): number {
  let sum = 0;
  for (const d of def.drivers ?? []) sum += Math.max(0, d.accentBoost ?? 0);
  return sum;
}

export class EnergyWeaponModel extends ProceduralWeaponModel {
  private readonly efx: EnergyFxState = {
    time: 0,
    dt: 0,
    heat: 0,
    flash: 0,
    sinceShot: NO_SHOT_YET,
    boost: 0,
    flicker: 1,
  };
  private lastTime = -1;
  private lastFlash = 0;
  private readonly boostSum: number;

  constructor(
    weaponId: string,
    def: WeaponViewmodelDef,
    built: BuiltModel,
    glow: GlowMaterials,
    readoutSpec: ReadoutSpec,
    readout: { texture: DataTexture; data: Uint8Array } | null,
    private readonly channels: readonly EnergyChannel[],
    private readonly extras: readonly ExtraAnimator[] = [],
  ) {
    super(weaponId, def, built, glow, readoutSpec, readout, channels.map((c) => c.material));
    this.boostSum = driverBoostSum(def);
    // Rest state (also what a warm-up compile or a still screenshot shows).
    for (const c of channels) c.material.uniforms.uIntensity.value = c.intensity;
  }

  override animate(fx: Readonly<ViewmodelFxState>): void {
    super.animate(fx);
    const e = this.efx;
    const dt = this.lastTime < 0 ? 0 : Math.max(0, Math.min(0.1, fx.time - this.lastTime));
    this.lastTime = fx.time;
    e.time = fx.time;
    e.dt = dt;
    e.heat = fx.heat;
    e.flicker = fx.flicker ?? 1;
    if (fx.flash > this.lastFlash + SHOT_FLASH_JUMP) e.sinceShot = 0;
    else e.sinceShot = Math.min(NO_SHOT_YET, e.sinceShot + dt);
    this.lastFlash = fx.flash;
    e.flash = fx.flash;
    const boost = this.boostSum > 0 ? (fx.accentBoost ?? 0) / this.boostSum : 0;
    e.boost = Number.isFinite(boost) ? Math.min(1, Math.max(0, boost)) : 0;
    for (const c of this.channels) {
      const u = c.material.uniforms;
      const pulse = 1 + (c.pulseDepth ?? 0) * Math.sin(fx.time * (c.pulseRate ?? 0));
      const flick = 1 + (c.flickerDepth ?? 0) * e.flicker * flickerNoise(fx.time * (c.flickerRate ?? 0));
      u.uIntensity.value =
        (c.intensity * pulse +
          (c.flash ?? 0) * e.flash +
          (c.heat ?? 0) * e.heat * e.heat +
          (c.boost ?? 0) * e.boost) *
        flick;
      u.uTime.value = fx.time;
      u.uWave.value = (c.wave ?? 0) + (c.waveFlash ?? 0) * e.flash + (c.waveBoost ?? 0) * e.boost;
    }
    for (const a of this.extras) a(e);
  }
}

/** Cheap aperiodic flicker in −1..1 (sum of incommensurate sines). */
function flickerNoise(t: number): number {
  return 0.5 * Math.sin(t) + 0.3 * Math.sin(t * 2.37 + 1.1) + 0.2 * Math.sin(t * 5.13 + 2.3);
}

/**
 * Remove parts from the animator-bound part table (they keep their place in the hierarchy): the
 * model animates them itself (floating cores, idle-spinning rings). Returns them by name.
 */
export function freeParts<const K extends string>(built: BuiltModel, names: readonly K[]): Record<K, Object3D> {
  const out = {} as Record<K, Object3D>;
  for (const n of names) {
    const obj = built.parts[n];
    if (!obj) throw new Error(`free part "${n}" was not declared`);
    out[n] = obj;
    delete built.parts[n];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

class HelixCurve extends Curve<Vector3> {
  constructor(
    private readonly radius: number,
    private readonly length: number,
    private readonly turns: number,
  ) {
    super();
  }

  override getPoint(t: number, target = new Vector3()): Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, Math.sin(a) * this.radius, -t * this.length + this.length / 2);
  }
}

/** Wire coil wound around the Z axis (centered, running along −Z). */
export function helixZ(radius: number, wire: number, length: number, turns: number, segmentsPerTurn = 14): BufferGeometry {
  return new TubeGeometry(
    new HelixCurve(radius, length, turns),
    Math.max(8, Math.round(turns * segmentsPerTurn)),
    wire,
    6,
    false,
  );
}

class PolyCurve extends Curve<Vector3> {
  constructor(private readonly pts: readonly Vector3[]) {
    super();
  }

  /** Catmull-Rom through the points (uniform), clamped at the ends. */
  override getPoint(t: number, target = new Vector3()): Vector3 {
    const p = this.pts;
    const n = p.length - 1;
    const x = Math.min(n - 1e-6, Math.max(0, t * n));
    const i = Math.floor(x);
    const u = x - i;
    const p0 = p[Math.max(0, i - 1)]!;
    const p1 = p[i]!;
    const p2 = p[Math.min(n, i + 1)]!;
    const p3 = p[Math.min(n, i + 2)]!;
    const u2 = u * u;
    const u3 = u2 * u;
    const f = (a: number, b: number, c: number, d: number): number =>
      0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return target.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
  }
}

/** A tube bent through model-space points [x, y, z] (harp arcs, organic ribs, cables). */
export function bentTube(
  points: readonly (readonly [number, number, number])[],
  radius: number,
  segments = 24,
  radial = 8,
): BufferGeometry {
  const curve = new PolyCurve(points.map(([x, y, z]) => new Vector3(x, y, z)));
  return new TubeGeometry(curve, segments, radius, radial, false);
}
