/**
 * Training dummies for the calibration hall (Damageable): humanoid silhouettes from primitives
 * with a glowing weakpoint core on the chest, per-zone hitboxes refreshed every tick, a rocking hit
 * reaction, a noise dissolve on death (render/materials/dissolve.ts) and a materialize on respawn.
 * Some ride rails (moving targets), armored ones carry an energy barrier (zone 'shield', its own
 * Damageable – see TrainingShield) that absorbs damage until it breaks and regenerates. A kinematic
 * Rapier capsule (ENEMY group) keeps the player from walking through them; bullets ignore it (they
 * test the hitboxes).
 *
 * Frame/tick flow: fixedUpdate(dt) advances state machines, rails and the wobble spring and
 * refreshes hitboxes/bounds (hits resolve against tick state); update(dt, alpha) interpolates the
 * visuals and drives uniforms only (no recompiles, no allocations).
 *
 * Draw calls: 2 per dummy (body + glow) + 1 per shield. Geometry is shared per target type.
 * The additive barrier lives on RENDER.volumetricLayer: the post chain draws it after AO and height
 * fog (VolumetricPass), so neither darkens it by the surface behind it; it fogs itself. Its pass
 * runs while `hasVolumetricContent` reports a visible barrier.
 */
import {
  BufferAttribute,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  AdditiveBlending,
  DoubleSide,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type {
  ColliderData,
  CombatWorldApi,
  DamageInfo,
  DamageResult,
  Damageable,
  Hitbox,
  PhysicsApi,
  RenderApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { FleshSurface, GameEvents, HitZone } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD, clamp, clamp01, lerp, smoothstep } from '../core/math';
import { RENDER } from '../defs/graphics';
import { COLLISION_FILTER, COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { TEST_ROOM_LAYOUT } from '../defs/level';
import {
  TARGETS,
  getTargetType,
  type TargetPlacementDef,
  type TargetShieldDef,
  type TargetTypeDef,
  type Vec3Def,
} from '../defs/targets';
import {
  applyDissolve,
  createDissolveDepthMaterial,
  createDissolveDistanceMaterial,
  createDissolveUniforms,
  setDissolveEdgeColor,
  setDissolveProgress,
  type DissolveUniforms,
} from '../render/materials/dissolve';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../render/postfx/fogShared';

const log = createLogger('Targets');

/** Damageable ids of training targets start here (enemies allocate from 1). */
export const TARGET_ID_BASE = 1_000_000;

const ENEMY_GROUPS = interactionGroups(COLLISION_GROUP.ENEMY, COLLISION_FILTER.enemy);
/** Overlap query: "is the player inside this capsule?" */
const PLAYER_QUERY_GROUPS = interactionGroups(COLLISION_GROUP.ENEMY, COLLISION_GROUP.PLAYER);

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

export interface RailState {
  /** 0..1 progress from `position` (0) to `rail.to` (1). */
  s: number;
  dir: 1 | -1;
  /** Remaining pause at an end (s). */
  pause: number;
}

/** Advance a ping-pong rail pass at `speed` m/s average over `length` m, pausing at both ends. */
export function advanceRail(
  state: RailState,
  dt: number,
  length: number,
  speed: number,
  pause: number,
): void {
  if (!(dt > 0) || !(length > 0) || !(speed > 0)) return;
  let t = dt;
  if (state.pause > 0) {
    const used = Math.min(state.pause, t);
    state.pause -= used;
    t -= used;
    if (t <= 0) return;
  }
  state.s += (state.dir * speed * t) / length;
  if (state.s >= 1) {
    state.s = 1;
    state.dir = -1;
    state.pause = Math.max(0, pause);
  } else if (state.s <= 0) {
    state.s = 0;
    state.dir = 1;
    state.pause = Math.max(0, pause);
  }
}

/** Eased rail position fraction (smoothstep: soft starts/stops, same average speed). */
export function railFraction(state: Readonly<RailState>): number {
  return smoothstep(0, 1, state.s);
}

/**
 * Energy barrier: absorbs damage until depleted, regenerates after `regenDelay` without hits
 * (a broken barrier comes back at full strength).
 */
export class ShieldState {
  hp: number;
  broken = false;
  /** Seconds since the last hit / the break. */
  sinceHit = Number.POSITIVE_INFINITY;

  constructor(readonly def: Pick<TargetShieldDef, 'health' | 'regenDelay' | 'regenPerSecond'>) {
    this.hp = def.health;
  }

  get up(): boolean {
    return !this.broken && this.hp > 0;
  }

  /** Absorb up to the remaining strength; returns the absorbed amount (overflow is blocked). */
  absorb(amount: number): number {
    if (!this.up || !(amount > 0)) return 0;
    const absorbed = Math.min(this.hp, amount);
    this.hp -= absorbed;
    this.sinceHit = 0;
    if (this.hp <= 1e-6) {
      this.hp = 0;
      this.broken = true;
    }
    return absorbed;
  }

  /** Returns true when a broken barrier came back up this tick. */
  tick(dt: number): boolean {
    this.sinceHit += dt;
    if (this.sinceHit < this.def.regenDelay) return false;
    if (this.broken) {
      this.broken = false;
      this.hp = this.def.health;
      return true;
    }
    this.hp = Math.min(this.def.health, this.hp + this.def.regenPerSecond * dt);
    return false;
  }

  reset(): void {
    this.hp = this.def.health;
    this.broken = false;
    this.sinceHit = Number.POSITIVE_INFINITY;
  }

  breakNow(): void {
    this.hp = 0;
    this.broken = true;
    this.sinceHit = 0;
  }
}

/** Local-frame hitbox template (see TARGETS.hitboxes) → world Hitbox via the dummy transform. */
interface LocalHitbox {
  readonly box: Hitbox;
  readonly la: Vector3;
  readonly lb: Vector3;
}

function localBox(
  shape: Hitbox['shape'],
  zone: HitZone,
  a: Vec3Def,
  b: Vec3Def | undefined,
  radius: number,
): LocalHitbox {
  return {
    box: { shape, zone, a: new Vector3(), b: new Vector3(), radius },
    la: new Vector3(a[0], a[1], a[2]),
    lb: b ? new Vector3(b[0], b[1], b[2]) : new Vector3(a[0], a[1], a[2]),
  };
}

/** Shield capsules along the arc in front of the dummy (local frame). */
export function shieldCapsules(def: TargetShieldDef): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const n = Math.max(1, Math.floor(def.capsules));
  const half = def.arcHalfAngleDeg * DEG2RAD;
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? 0 : -half + (2 * half * i) / (n - 1);
    out.push({ x: Math.sin(a) * def.arcRadius, z: Math.cos(a) * def.arcRadius });
  }
  return out;
}

/** Wobble kick (rad/s) for a hit of `amount` damage and `impulse` m/s knockback. */
export function wobbleKick(amount: number, impulse: number): number {
  const W = TARGETS.wobble;
  const k = Math.max(0, amount) * W.perDamage + Math.max(0, impulse) * W.perImpulse;
  return Math.min(W.maxKick, Number.isFinite(k) ? k : 0);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const _qa = new Quaternion();
const _va = new Vector3();
const _vb = new Vector3();
const _up = new Vector3(0, 1, 0);
const _m = new Matrix4();
const _s1 = new Vector3(1, 1, 1);

function tint(geo: BufferGeometry, rgb: readonly [number, number, number], scale = 1): BufferGeometry {
  const n = geo.getAttribute('position').count;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = rgb[0] * scale;
    data[i * 3 + 1] = rgb[1] * scale;
    data[i * 3 + 2] = rgb[2] * scale;
  }
  geo.setAttribute('color', new BufferAttribute(data, 3));
  return geo;
}

/** Capsule from a to b (local frame). */
function capsule(a: Vec3Def, b: Vec3Def, radius: number, depthScale = 1): BufferGeometry {
  const B = TARGETS.body;
  _va.set(a[0], a[1], a[2]);
  _vb.set(b[0], b[1], b[2]);
  const len = _va.distanceTo(_vb);
  const geo = new CapsuleGeometry(radius, Math.max(1e-3, len), B.capSegments, B.radialSegments);
  if (depthScale !== 1) geo.scale(1, 1, depthScale);
  _qa.setFromUnitVectors(_up, _vb.clone().sub(_va).normalize());
  _m.compose(_va.add(_vb).multiplyScalar(0.5), _qa, _s1);
  geo.applyMatrix4(_m);
  return geo;
}

function mirrorX(v: Vec3Def): Vec3Def {
  return [-v[0], v[1], v[2]];
}

interface TypeGeometry {
  body: BufferGeometry;
  glow: BufferGeometry;
  shield: BufferGeometry | null;
}

/** Merged body (vertex colors) + glow (core, visor) geometry for a target type. */
export function buildTargetGeometry(type: TargetTypeDef): TypeGeometry {
  const B = TARGETS.body;
  const body = type.bodyColor;
  const accent = type.accentColor;
  const dark = B.trimColor;
  const parts: BufferGeometry[] = [];

  // Rocking dome base (upper hemisphere, squashed).
  const base = new SphereGeometry(
    B.base.radius,
    B.base.segments,
    B.base.segments / 4,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  base.scale(1, B.base.height / B.base.radius, 1);
  parts.push(tint(base, dark, 1.6));

  const L = B.leg;
  for (const s of [1, -1]) {
    parts.push(tint(capsule([s * L.x, L.bottom, 0], [s * L.x * 0.9, L.top, 0], L.radius), body));
  }
  const P = B.pelvis;
  parts.push(tint(capsule([-P.halfWidth, P.y, 0], [P.halfWidth, P.y, 0], P.radius), body, 0.7));
  const T = B.torso;
  parts.push(tint(capsule([0, T.bottom, 0], [0, T.top, 0], T.radius, T.depthScale), body));
  const stripe = new CylinderGeometry(
    T.radius * 1.02,
    T.radius * 1.02,
    B.stripe.height,
    B.radialSegments * 2,
    1,
    true,
  );
  stripe.scale(1, 1, T.depthScale);
  stripe.translate(0, B.stripe.y, 0);
  parts.push(tint(stripe, accent));
  const S = B.shoulders;
  parts.push(tint(capsule([-S.halfWidth, S.y, 0], [S.halfWidth, S.y, 0], S.radius), accent, 0.8));
  const A = B.arm;
  parts.push(tint(capsule(A.shoulder, A.hand, A.radius), body, 0.9));
  parts.push(tint(capsule(mirrorX(A.shoulder), mirrorX(A.hand), A.radius), body, 0.9));
  const N = B.neck;
  const neck = new CylinderGeometry(N.radius, N.radius, N.top - N.bottom, B.radialSegments);
  neck.translate(0, (N.top + N.bottom) / 2, 0);
  parts.push(tint(neck, dark, 2));
  const H = B.head;
  const head = new SphereGeometry(H.radius, B.radialSegments + 4, B.radialSegments);
  head.translate(H.center[0], H.center[1], H.center[2]);
  parts.push(tint(head, body, 1.15));
  const C = B.core;
  const bezel = new TorusGeometry(C.bezelRadius, C.bezelTube, 8, B.radialSegments * 2);
  bezel.translate(C.center[0], C.center[1], C.center[2] + C.bezelTube);
  parts.push(tint(bezel, dark, 1.2));

  const bodyGeo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();

  // Glow: weakpoint core + visor band (emissive material).
  const core = new SphereGeometry(C.radius, B.radialSegments, B.radialSegments - 4);
  core.translate(C.center[0], C.center[1], C.center[2]);
  const V = B.visor;
  const half = V.halfAngleDeg * DEG2RAD;
  const visor = new CylinderGeometry(
    H.radius * 1.03,
    H.radius * 1.03,
    V.height,
    B.radialSegments * 2,
    1,
    true,
    -half,
    half * 2,
  );
  visor.translate(0, V.y, 0);
  const glowParts = [core, visor];
  const glowGeo = mergeGeometries(glowParts, false);
  for (const p of glowParts) p.dispose();

  let shieldGeo: BufferGeometry | null = null;
  const sh = type.shield;
  if (sh) {
    const half = sh.arcHalfAngleDeg * DEG2RAD + sh.visualMarginDeg * DEG2RAD;
    const radius = sh.arcRadius + sh.capsuleRadius * sh.visualInset;
    const height = sh.top - sh.bottom;
    const segments = TARGETS.shieldPanel.segments;
    shieldGeo = new CylinderGeometry(radius, radius, height, segments, 1, true, -half, half * 2);
    shieldGeo.translate(0, (sh.top + sh.bottom) / 2, 0);
  }
  // Never crash on content: a failed merge (attribute mismatch) degrades to plain primitives.
  if (!bodyGeo) log.error('Training target body merge failed – capsule fallback');
  if (!glowGeo) log.error('Training target glow merge failed – sphere fallback');
  return {
    body:
      bodyGeo ??
      tint(
        new CapsuleGeometry(T.radius, TARGETS.collider.height - T.radius * 2).translate(
          0,
          TARGETS.collider.height / 2,
          0,
        ),
        body,
      ),
    glow: glowGeo ?? new SphereGeometry(C.radius).translate(C.center[0], C.center[1], C.center[2]),
    shield: shieldGeo,
  };
}

// ---------------------------------------------------------------------------
// Shield shader (additive energy barrier, HDR)
// ---------------------------------------------------------------------------

const SHIELD_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vFog;
void main() {
	vUv = uv;
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vNormalW = normalize( mat3( modelMatrix ) * normal );
	vViewW = cameraPosition - wp.xyz;
	// Drawn after the height-fog pass (volumetric layer): fog to its own position.
	vFog = fogTransmittance( cameraPosition, wp.xyz );
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHIELD_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFill;
uniform float uRim;
uniform float uGrid;
uniform float uHit;
uniform float uVisible;
uniform float uTime;
uniform float uGridScale;
uniform float uAspect;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vFog;

float hexEdge( vec2 p ) {
	p.x *= 1.1547;
	p.y += mod( floor( p.x ), 2.0 ) * 0.5;
	p = abs( fract( p ) - 0.5 );
	return abs( max( p.x * 1.5 + p.y, p.y * 2.0 ) - 1.0 );
}

void main() {
	vec3 n = normalize( vNormalW );
	vec3 v = normalize( vViewW );
	float fres = pow( 1.0 - abs( dot( n, v ) ), 3.0 );
	float grid = 1.0 - smoothstep( 0.0, 0.06, hexEdge( vUv * vec2( uGridScale * uAspect, uGridScale ) ) );
	float scan = 0.55 + 0.45 * sin( vUv.y * 60.0 - uTime * 5.0 );
	float border = smoothstep( 0.0, 0.06, vUv.x ) * smoothstep( 0.0, 0.06, 1.0 - vUv.x )
		* smoothstep( 0.0, 0.05, vUv.y ) * smoothstep( 0.0, 0.05, 1.0 - vUv.y );
	float frame = 1.0 - smoothstep( 0.0, 0.02, min( min( vUv.x, 1.0 - vUv.x ), min( vUv.y, 1.0 - vUv.y ) ) );
	// Mostly see-through: a faint fill, the grid shimmering along a scanline, bright rims and frame.
	float i = ( uFill + uRim * fres + uGrid * grid * scan + uHit * ( 0.2 + grid ) ) * border + uRim * 0.7 * frame;
	gl_FragColor = vec4( uColor * i * uVisible * vFog, 1.0 );
}
`;

function createShieldMaterial(def: TargetShieldDef): ShaderMaterial {
  const height = def.top - def.bottom;
  const arcLen = 2 * (def.arcHalfAngleDeg + def.visualMarginDeg) * DEG2RAD * def.arcRadius;
  return new ShaderMaterial({
    name: 'target-shield',
    uniforms: {
      uColor: { value: new Color(def.color[0], def.color[1], def.color[2]) },
      uFill: { value: def.fillIntensity },
      uRim: { value: def.rimIntensity },
      uGrid: { value: def.gridIntensity },
      uHit: { value: 0 },
      uVisible: { value: 1 },
      uTime: { value: 0 },
      uGridScale: { value: def.gridScale },
      uAspect: { value: arcLen / Math.max(1e-3, height) },
      // Shared by reference: HeightFogEffect.setFog updates it.
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: SHIELD_VERTEX,
    fragmentShader: SHIELD_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  });
}

// ---------------------------------------------------------------------------
// Dummy
// ---------------------------------------------------------------------------

type DummyState = 'alive' | 'dying' | 'dead' | 'spawning';

/** PhysicsWorld extras used when present (collider metadata registry). */
interface PhysicsExtras {
  createCollider?(
    desc: RAPIER.ColliderDesc,
    parent: RAPIER.RigidBody | null,
    data: ColliderData,
  ): RAPIER.Collider;
}

let nextId = TARGET_ID_BASE;

/**
 * The energy barrier of an armored dummy as a Damageable of its own (surface 'shield', team
 * 'neutral' so aim assist keeps pulling to the dummy). Hits resolve per Damageable, so:
 * - a barrier hit reports the shield surface while a hit on the exposed back reports armor,
 * - pellets on the barrier never merge with pellets on the body (weapons aggregate one damage
 *   event per target and keep the best zone – one body pellet would carry the whole blast past
 *   the barrier),
 * - penetration pays the barrier's cost (COMBAT.penetrationCost.shield stops bullets).
 * Shares the owner's bounds center and aim point; it is only alive while the barrier is up.
 */
export class TrainingShield implements Damageable {
  readonly id = nextId++;
  readonly team = 'neutral' as const;
  readonly surface = 'shield' as const;

  constructor(
    private readonly owner: TrainingDummy,
    readonly hitboxes: readonly Hitbox[],
    readonly boundsRadius: number,
  ) {}

  get alive(): boolean {
    return this.owner.shieldUp;
  }

  get boundsCenter(): Vector3 {
    return this.owner.boundsCenter;
  }

  get aimPoint(): Vector3 {
    return this.owner.aimPoint;
  }

  applyDamage(info: DamageInfo): DamageResult {
    return this.owner.applyShieldDamage(info);
  }
}

export class TrainingDummy implements Damageable {
  readonly id = nextId++;
  readonly team = 'enemy' as const;
  readonly boundsCenter = new Vector3();
  readonly boundsRadius: number;
  readonly aimPoint = new Vector3();
  readonly type: TargetTypeDef;
  readonly root = new Group();
  readonly shield: ShieldState | null;
  /** Barrier hit volume (registered with the combat world next to the dummy), null without a shield. */
  readonly shieldTarget: TrainingShield | null;

  health: number;
  state: DummyState = 'alive';
  /** Seconds in the current state. */
  stateTime = 0;
  /** Seconds since the last damage (health regen). */
  sinceDamage = Number.POSITIVE_INFINITY;

  // Pose (tick state + previous tick for interpolation).
  readonly position = new Vector3();
  private readonly prevPosition = new Vector3();
  readonly yaw: number;
  readonly tilt = { x: 0, z: 0, vx: 0, vz: 0 };
  private prevTiltX = 0;
  private prevTiltZ = 0;
  private readonly rail: {
    state: RailState;
    from: Vector3;
    to: Vector3;
    length: number;
    speed: number;
    pause: number;
  } | null;
  private readonly yawQ = new Quaternion();
  private readonly matrix = new Matrix4();

  private readonly boxes: LocalHitbox[] = [];
  private readonly bodyHitboxes: Hitbox[] = [];
  private readonly boundsLocal: Vector3;
  private readonly aimLocal: Vector3;

  // Visual state.
  readonly bodyMaterial: MeshStandardMaterial;
  readonly glowMaterial: MeshStandardMaterial;
  readonly shieldMaterial: ShaderMaterial | null;
  readonly dissolve: DissolveUniforms;
  private readonly meshes: Mesh[] = [];
  private readonly depthMaterials: { dispose(): void }[] = [];
  private readonly shieldMesh: Mesh | null;
  private bodyFlash = 0;
  private coreFlash = 0;
  private shieldFlash = 0;
  /** 0 = barrier gone, 1 = fully up (collapse/raise animation). */
  private shieldVisible = 1;
  private edgeMode: 'out' | 'in' | null = null;
  private time = 0;
  reduceFlashing = false;

  // Physics.
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  private colliderEnabled = true;
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly queryRot = { x: 0, y: 0, z: 0, w: 1 };
  private queryShape: RAPIER.Shape | null = null;

  constructor(
    placement: TargetPlacementDef,
    type: TargetTypeDef,
    geometry: TypeGeometry,
    private readonly physics: (PhysicsApi & PhysicsExtras) | null,
  ) {
    this.type = type;
    this.health = type.health;
    this.shield = type.shield ? new ShieldState(type.shield) : null;
    this.yaw = (Number.isFinite(placement.yawDeg) ? placement.yawDeg : 0) * DEG2RAD;
    this.yawQ.setFromAxisAngle(_up, this.yaw);
    const p = placement.position;
    const lift = placement.rail ? TARGETS.rail.height : 0;
    this.position.set(p[0], p[1] + lift, p[2]);
    if (placement.rail) {
      const to = placement.rail.to;
      const from = this.position.clone();
      const dest = new Vector3(to[0], to[1] + lift, to[2]);
      this.rail = {
        state: { s: 0, dir: 1, pause: placement.rail.pause },
        from,
        to: dest,
        length: from.distanceTo(dest),
        speed: placement.rail.speed,
        pause: placement.rail.pause,
      };
    } else {
      this.rail = null;
    }
    this.prevPosition.copy(this.position);

    // Hitboxes.
    for (const h of TARGETS.hitboxes) this.boxes.push(localBox(h.shape, h.zone, h.a, h.b, h.radius));
    for (const b of this.boxes) this.bodyHitboxes.push(b.box);
    const sh = type.shield;
    if (sh) {
      const shieldBoxes: Hitbox[] = [];
      for (const c of shieldCapsules(sh)) {
        const lb = localBox(
          'capsule',
          'shield',
          [c.x, sh.bottom + sh.capsuleRadius, c.z],
          [c.x, sh.top - sh.capsuleRadius, c.z],
          sh.capsuleRadius,
        );
        this.boxes.push(lb);
        shieldBoxes.push(lb.box);
      }
      this.shieldTarget = new TrainingShield(this, shieldBoxes, TARGETS.bounds.shieldRadius);
    } else {
      this.shieldTarget = null;
    }
    const bc = TARGETS.bounds.center;
    this.boundsLocal = new Vector3(bc[0], bc[1], bc[2]);
    this.boundsRadius = TARGETS.bounds.radius;
    const ap = TARGETS.aimPoint;
    this.aimLocal = new Vector3(ap[0], ap[1], ap[2]);

    // Materials (per dummy: own dissolve/flash uniforms; programs are shared).
    const D = TARGETS.dissolve;
    const height = TARGETS.collider.height;
    this.dissolve = createDissolveUniforms({
      edgeWidth: D.edgeWidth,
      edgeColor: D.edgeColor,
      edgeIntensity: D.edgeIntensity,
      noiseScale: D.noiseScale,
      sweep: D.sweep,
      // Top dissolves first: sweep 0 at the head, 1 at the feet.
      sweepAxis: [0, -1 / height, 0],
      sweepOffset: 1,
      seed: [(this.id * 7.31) % 19, (this.id * 3.17) % 23, (this.id * 5.13) % 29],
    });
    const M = TARGETS.material;
    const F = TARGETS.hitFlash;
    this.bodyMaterial = applyDissolve(
      new MeshStandardMaterial({
        name: 'target-body',
        color: 0xffffff,
        vertexColors: true,
        roughness: M.roughness,
        metalness: M.metalness,
        emissive: new Color(F.color[0], F.color[1], F.color[2]),
        emissiveIntensity: 0,
      }),
      this.dissolve,
    );
    const g = type.glowColor;
    this.glowMaterial = applyDissolve(
      new MeshStandardMaterial({
        name: 'target-glow',
        color: 0x080808,
        roughness: M.glowRoughness,
        metalness: 0,
        emissive: new Color(g[0], g[1], g[2]),
        emissiveIntensity: TARGETS.core.intensity,
      }),
      this.dissolve,
    );

    this.root.name = `target:${this.id}`;
    const depth = createDissolveDepthMaterial(this.dissolve);
    const distance = createDissolveDistanceMaterial(this.dissolve);
    this.depthMaterials.push(depth, distance);
    for (const [geo, mat] of [
      [geometry.body, this.bodyMaterial],
      [geometry.glow, this.glowMaterial],
    ] as const) {
      const mesh = new Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depth;
      mesh.customDistanceMaterial = distance;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
    if (sh && geometry.shield) {
      this.shieldMaterial = createShieldMaterial(sh);
      this.shieldMesh = new Mesh(geometry.shield, this.shieldMaterial);
      this.shieldMesh.renderOrder = 1;
      // Additive HDR: drawn by the volumetric pass after AO and fog (see the header).
      this.shieldMesh.layers.set(RENDER.volumetricLayer);
      this.root.add(this.shieldMesh);
    } else {
      this.shieldMaterial = null;
      this.shieldMesh = null;
    }

    this.createCollider();
    this.refreshTransform();
    this.applyVisualPose(1);
  }

  get alive(): boolean {
    return this.state === 'alive';
  }

  /** The body's own surface; barrier hits resolve on `shieldTarget` (surface 'shield'). */
  get surface(): FleshSurface {
    return this.type.surface;
  }

  /** Body zones only; the barrier's capsules belong to `shieldTarget`. */
  get hitboxes(): readonly Hitbox[] {
    return this.bodyHitboxes;
  }

  get maxHealth(): number {
    return this.type.health;
  }

  /** The barrier panel draws this frame (up, raising or still collapsing). */
  get shieldDrawn(): boolean {
    return this.shieldMesh !== null && this.shieldMesh.visible && this.root.visible;
  }

  /** Barrier up and the dummy alive (the shield target is hittable). */
  get shieldUp(): boolean {
    return this.state === 'alive' && this.shield?.up === true;
  }

  /** A hit on the barrier: absorbed up to its strength, overflow blocked, the dummy rocks. */
  applyShieldDamage(info: DamageInfo): DamageResult {
    const shield = this.shield;
    if (!shield || !this.shieldUp || !(info.amount > 0)) return { applied: 0, killed: false };
    this.sinceDamage = 0;
    this.kick(info, wobbleKick(info.amount, info.impulse ?? 0));
    const absorbed = shield.absorb(info.amount);
    this.shieldFlash = 1;
    return { applied: absorbed, killed: false };
  }

  applyDamage(info: DamageInfo): DamageResult {
    if (!this.alive || !(info.amount > 0)) return { applied: 0, killed: false };
    if (info.zone === 'shield' && this.shieldUp) return this.applyShieldDamage(info);
    this.sinceDamage = 0;
    this.kick(info, wobbleKick(info.amount, info.impulse ?? 0));
    const mult = this.type.zoneMultipliers[info.zone] ?? 1;
    const dmg = info.amount * (Number.isFinite(mult) ? Math.max(0, mult) : 1);
    const applied = Math.min(this.health, dmg);
    this.health -= applied;
    this.bodyFlash = info.zone === 'weakpoint' ? TARGETS.hitFlash.weakpointBoost : 1;
    if (info.zone === 'weakpoint') this.coreFlash = 1;
    if (this.health <= 1e-6) {
      this.health = 0;
      this.kick(info, TARGETS.wobble.killKick);
      this.die();
      return { applied, killed: true };
    }
    return { applied, killed: false };
  }

  /** Instantly back to full health, alive, shield up (dev console / tests). */
  reset(): void {
    this.health = this.type.health;
    this.shield?.reset();
    this.shieldVisible = 1;
    this.sinceDamage = Number.POSITIVE_INFINITY;
    this.setState('alive');
    this.setColliderEnabled(true);
  }

  fixedUpdate(dt: number): void {
    this.prevPosition.copy(this.position);
    this.prevTiltX = this.tilt.x;
    this.prevTiltZ = this.tilt.z;
    this.stateTime += dt;
    this.sinceDamage += dt;
    const D = TARGETS.dissolve;
    switch (this.state) {
      case 'alive':
        if (this.type.healthRegenDelay > 0 && this.sinceDamage >= this.type.healthRegenDelay) {
          this.health = this.type.health;
        }
        if (this.shield?.tick(dt)) this.shieldVisible = 0;
        break;
      case 'dying':
        if (this.stateTime >= D.outTime) this.setState('dead');
        break;
      case 'dead':
        if (this.stateTime >= TARGETS.respawnDelay && !this.playerInside(this.position)) {
          this.health = this.type.health;
          this.shield?.reset();
          this.shieldVisible = 0;
          this.sinceDamage = Number.POSITIVE_INFINITY;
          this.tilt.x = this.tilt.z = this.tilt.vx = this.tilt.vz = 0;
          this.prevTiltX = this.prevTiltZ = 0;
          this.setColliderEnabled(true);
          this.setState('spawning');
        }
        break;
      case 'spawning':
        if (this.stateTime >= D.inTime) this.setState('alive');
        break;
    }
    this.stepRail(dt);
    this.stepWobble(dt);
    this.refreshTransform();
  }

  update(dt: number, alpha: number): void {
    this.time += dt;
    this.applyVisualPose(alpha);
    const D = TARGETS.dissolve;
    let progress = 0;
    if (this.state === 'dying') {
      progress = clamp01(this.stateTime / D.outTime);
      this.setEdge('out');
    } else if (this.state === 'dead') {
      progress = 1;
    } else if (this.state === 'spawning') {
      progress = 1 - clamp01(this.stateTime / D.inTime);
      this.setEdge('in');
    }
    setDissolveProgress(this.dissolve, progress);
    this.root.visible = progress < 1;

    const F = TARGETS.hitFlash;
    const flashScale = this.reduceFlashing ? TARGETS.reducedFlashScale : 1;
    this.bodyFlash = Math.max(0, this.bodyFlash - F.decay * dt);
    this.bodyMaterial.emissiveIntensity = this.bodyFlash * F.intensity * flashScale;
    const C = TARGETS.core;
    this.coreFlash = Math.max(0, this.coreFlash - C.hitDecay * dt);
    const pulse = this.reduceFlashing ? 0 : Math.sin(this.time * C.pulseRate * Math.PI * 2) * C.pulseAmount;
    this.glowMaterial.emissiveIntensity =
      C.intensity * (1 + pulse) + this.coreFlash * C.hitIntensity * flashScale;

    this.updateShieldVisual(dt, flashScale);
  }

  dispose(): void {
    if (this.body && this.physics) this.physics.removeBody(this.body);
    this.body = null;
    this.collider = null;
    this.root.removeFromParent();
    this.bodyMaterial.dispose();
    this.glowMaterial.dispose();
    this.shieldMaterial?.dispose();
    for (const m of this.depthMaterials) m.dispose();
  }

  // -------------------------------------------------------------------------

  private setState(s: DummyState): void {
    this.state = s;
    this.stateTime = 0;
  }

  private die(): void {
    this.setState('dying');
    this.shield?.breakNow();
    this.setColliderEnabled(false);
  }

  private kick(info: DamageInfo, strength: number): void {
    if (!(strength > 0)) return;
    // Shot direction into the dummy's local frame (inverse yaw), horizontal only.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const dx = info.direction.x;
    const dz = info.direction.z;
    const lx = cos * dx - sin * dz;
    const lz = sin * dx + cos * dz;
    const len = Math.hypot(lx, lz);
    if (!(len > 1e-6)) return;
    // +X rotation tips the top towards +Z; +Z rotation tips it towards -X.
    this.tilt.vx += (lz / len) * strength;
    this.tilt.vz -= (lx / len) * strength;
  }

  private stepWobble(dt: number): void {
    const W = TARGETS.wobble;
    const t = this.tilt;
    t.vx += (-W.stiffness * t.x - W.damping * t.vx) * dt;
    t.vz += (-W.stiffness * t.z - W.damping * t.vz) * dt;
    t.x = clamp(t.x + t.vx * dt, -W.maxTilt, W.maxTilt);
    t.z = clamp(t.z + t.vz * dt, -W.maxTilt, W.maxTilt);
  }

  private stepRail(dt: number): void {
    const r = this.rail;
    if (!r) return;
    const st = r.state;
    const s0 = st.s;
    const dir0 = st.dir;
    const pause0 = st.pause;
    advanceRail(st, dt, r.length, r.speed, r.pause);
    _va.copy(r.from).lerp(r.to, railFraction(st));
    // Never push into the player: wait until the way is clear.
    if (this.colliderEnabled && this.playerInside(_va)) {
      st.s = s0;
      st.dir = dir0;
      st.pause = pause0;
      return;
    }
    this.position.copy(_va);
    if (this.body) {
      const k = this.kinPos;
      k.x = _va.x;
      k.y = _va.y;
      k.z = _va.z;
      this.body.setNextKinematicTranslation(k);
    }
  }

  private refreshTransform(): void {
    _qa.setFromEuler(_euler.set(this.tilt.x, 0, this.tilt.z));
    _qa.premultiply(this.yawQ);
    this.matrix.compose(this.position, _qa, _s1);
    const m = this.matrix;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i]!;
      b.box.a.copy(b.la).applyMatrix4(m);
      b.box.b.copy(b.lb).applyMatrix4(m);
    }
    this.boundsCenter.copy(this.boundsLocal).applyMatrix4(m);
    this.aimPoint.copy(this.aimLocal).applyMatrix4(m);
  }

  private applyVisualPose(alpha: number): void {
    const a = clamp01(Number.isFinite(alpha) ? alpha : 1);
    this.root.position.lerpVectors(this.prevPosition, this.position, a);
    _qa.setFromEuler(
      _euler.set(lerp(this.prevTiltX, this.tilt.x, a), 0, lerp(this.prevTiltZ, this.tilt.z, a)),
    );
    this.root.quaternion.copy(this.yawQ).multiply(_qa);
  }

  private setEdge(mode: 'out' | 'in'): void {
    if (this.edgeMode === mode) return;
    this.edgeMode = mode;
    const D = TARGETS.dissolve;
    if (mode === 'out') setDissolveEdgeColor(this.dissolve, D.edgeColor, D.edgeIntensity);
    else setDissolveEdgeColor(this.dissolve, D.spawnEdgeColor, D.spawnEdgeIntensity);
  }

  private updateShieldVisual(dt: number, flashScale: number): void {
    const def = this.type.shield;
    const mat = this.shieldMaterial;
    if (!def || !mat || !this.shieldMesh) return;
    const up = this.shield?.up === true && (this.state === 'alive' || this.state === 'spawning');
    const rate = up ? 1 / Math.max(1e-3, def.raiseTime) : -1 / Math.max(1e-3, def.collapseTime);
    this.shieldVisible = clamp01(this.shieldVisible + rate * dt);
    this.shieldFlash = Math.max(0, this.shieldFlash - def.hitDecay * dt);
    const u = mat.uniforms;
    u.uTime!.value = this.time;
    u.uHit!.value = this.shieldFlash * def.hitIntensity * flashScale;
    // Collapsing barriers flicker out; raising ones fade in.
    const P = TARGETS.shieldPanel;
    const flicker =
      up || this.reduceFlashing
        ? 1
        : 1 - P.collapseFlickerDepth * (0.5 - 0.5 * Math.sin(this.time * P.collapseFlickerRate));
    u.uVisible!.value = this.shieldVisible * flicker;
    this.shieldMesh.visible = this.shieldVisible > 0.001;
  }

  private createCollider(): void {
    const ph = this.physics;
    if (!ph) return;
    const R = ph.rapier;
    const C = TARGETS.collider;
    const halfHeight = Math.max(0.01, C.height / 2 - C.radius);
    try {
      const body = ph.world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased().setTranslation(
          this.position.x,
          this.position.y,
          this.position.z,
        ),
      );
      const desc = R.ColliderDesc.capsule(halfHeight, C.radius)
        .setTranslation(0, C.height / 2, 0)
        .setCollisionGroups(ENEMY_GROUPS)
        .setSolverGroups(ENEMY_GROUPS);
      const data: ColliderData = { kind: 'enemy', surface: 'metal', entityId: this.id };
      this.collider = ph.createCollider
        ? ph.createCollider(desc, body, data)
        : ph.world.createCollider(desc, body);
      this.body = body;
      this.queryShape = new R.Capsule(halfHeight, C.radius);
    } catch (err) {
      log.warn(`Target ${this.id}: collider creation failed – no player blocking`, err);
      this.body = null;
      this.collider = null;
    }
  }

  private setColliderEnabled(on: boolean): void {
    this.colliderEnabled = on;
    this.collider?.setEnabled(on);
  }

  /** Does the player's capsule overlap this dummy's capsule placed at `feet`? */
  private playerInside(feet: Vector3): boolean {
    const ph = this.physics;
    if (!ph || !this.queryShape) return false;
    const k = this.kinPos;
    k.x = feet.x;
    k.y = feet.y + TARGETS.collider.height / 2;
    k.z = feet.z;
    try {
      return (
        ph.world.intersectionWithShape(
          k,
          this.queryRot,
          this.queryShape,
          undefined,
          PLAYER_QUERY_GROUPS,
          this.collider ?? undefined,
        ) !== null
      );
    } catch {
      return false;
    }
  }
}

const _euler = new Euler();

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface TrainingTargetsDeps {
  scene: Object3D;
  combat: CombatWorldApi;
  events: EventBus<GameEvents>;
  /** null: no player blocking (tests, headless tools). */
  physics: PhysicsApi | null;
  render: Pick<RenderApi, 'setupMaterial'>;
  /** Default: TEST_ROOM_LAYOUT.targets. */
  placements?: readonly TargetPlacementDef[];
  /** Initial accessibility "reduce flashing" (live changes arrive via settings:changed). */
  reduceFlashing?: boolean;
}

export class TrainingTargets {
  readonly root = new Group();
  readonly dummies: TrainingDummy[] = [];
  readonly stats = { total: 0, alive: 0 };
  private readonly geometries = new Map<string, TypeGeometry>();
  private readonly combat: CombatWorldApi;
  private readonly offs: (() => void)[] = [];
  private disposed = false;

  constructor(deps: TrainingTargetsDeps) {
    this.combat = deps.combat;
    this.root.name = 'TrainingTargets';
    const placements = deps.placements ?? TEST_ROOM_LAYOUT.targets;
    for (const p of placements) {
      const type = getTargetType(p.type);
      if (!type) {
        log.warn(`Unknown target type "${String(p.type)}" – skipped`);
        continue;
      }
      let geo = this.geometries.get(p.type);
      if (!geo) {
        geo = buildTargetGeometry(type);
        this.geometries.set(p.type, geo);
      }
      const dummy = new TrainingDummy(p, type, geo, deps.physics);
      dummy.reduceFlashing = deps.reduceFlashing === true;
      deps.render.setupMaterial(dummy.bodyMaterial);
      deps.render.setupMaterial(dummy.glowMaterial);
      this.root.add(dummy.root);
      this.dummies.push(dummy);
      this.combat.register(dummy);
      if (dummy.shieldTarget) this.combat.register(dummy.shieldTarget);
    }
    this.root.updateMatrixWorld(true);
    deps.scene.add(this.root);
    this.stats.total = this.dummies.length;
    this.stats.alive = this.dummies.length;
    this.offs.push(
      deps.events.on('settings:changed', ({ settings, sections }) => {
        if (!sections.includes('accessibility')) return;
        for (const d of this.dummies) d.reduceFlashing = settings.accessibility.reduceFlashing;
      }),
    );
    log.info(`${this.dummies.length} training targets`);
  }

  /** 60 Hz tick: state machines, rails, wobble, hitboxes. Call before physics.step (rails move kinematically). */
  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    let alive = 0;
    for (let i = 0; i < this.dummies.length; i++) {
      const d = this.dummies[i]!;
      d.fixedUpdate(dt);
      if (d.alive) alive++;
    }
    this.stats.alive = alive;
  }

  /** Per frame: interpolated pose (alpha from the loop), dissolve/flash/shield uniforms. */
  update(dt: number, alpha = 1): void {
    if (this.disposed) return;
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.update(d, alpha);
  }

  /**
   * True while a barrier panel draws on RENDER.volumetricLayer: with level volumetrics off the
   * post chain runs that layer's pass only while this (or live VFX) reports content.
   */
  get hasVolumetricContent(): boolean {
    if (this.disposed) return false;
    for (let i = 0; i < this.dummies.length; i++) if (this.dummies[i]!.shieldDrawn) return true;
    return false;
  }

  /** Every dummy back to full health and alive (dev console). */
  resetAll(): void {
    for (const d of this.dummies) d.reset();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const d of this.dummies) {
      this.combat.unregister(d);
      if (d.shieldTarget) this.combat.unregister(d.shieldTarget);
      d.dispose();
    }
    this.dummies.length = 0;
    for (const g of this.geometries.values()) {
      g.body.dispose();
      g.glow.dispose();
      g.shield?.dispose();
    }
    this.geometries.clear();
    this.root.removeFromParent();
  }
}
