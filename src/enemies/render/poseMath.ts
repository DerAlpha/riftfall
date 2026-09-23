/**
 * Enemy pose math shared by the GPU and the CPU.
 *
 * `compileRig()` turns an EnemyVisualDef into ONE packed float table (the "rig"): header, attack
 * timings, bones (pivot + parent + motion range), parts (bone + material zone) and motions
 * (channel/driver code + parameters). The renderer uploads that exact Float32Array as a data
 * texture; the vertex shader (enemyShader.ts, RIG_GLSL) and `evaluateRig()` here interpret the same
 * numbers with the same formulas:
 *
 *   drivers   locomotion, phase, attack envelope (eW, eS), stagger, death, 1 - emerge, look, life
 *   motion    value = see motionValue() – summed per bone channel (rot / move / scale)
 *   bone      L(x) = R · (S ∘ (x - pivot)) + pivot + move,   R = Ry · Rx · Rz
 *   vertex    applied from its bone up to the root (GPU);  CPU composes M = M_parent · L (parents first)
 *
 * So hitboxes, sockets and aim points follow exactly what is drawn. Everything here is pure and
 * allocation-free per call (compileRig allocates once per type).
 */
import type { HitZone } from '../../core/events';
import { createLogger } from '../../core/log';
import {
  ENEMY_RENDER,
  GAIT_WAVES,
  RIG_CHANNELS,
  RIG_DRIVERS,
  type EnemyHitboxDef,
  type EnemyPartDef,
  type EnemyVisualDef,
  type RigBoneDef,
  type RigChannel,
  type RigDriver,
  type RigMotionDef,
  type Vec3,
} from '../../defs/enemyVisuals';

const log = createLogger('EnemyRig');

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Codes shared with the shader (generated into #defines by enemyShader.ts)
// ---------------------------------------------------------------------------

/** code = driver * CODE_STRIDE + channel. */
export const CODE_STRIDE = 16;

function indexMap<T extends string>(list: readonly T[]): Readonly<Record<T, number>> {
  const out = {} as Record<T, number>;
  list.forEach((k, i) => (out[k] = i));
  return out;
}

export const DRIVER_CODE = indexMap<RigDriver>(RIG_DRIVERS);
export const CHANNEL_CODE = indexMap<RigChannel>(RIG_CHANNELS);
export const WAVE_CODE = indexMap(GAIT_WAVES);

/** Rotation channels are authored in degrees, compiled to radians. */
const ROTATION_CHANNELS: ReadonlySet<RigChannel> = new Set(['rx', 'ry', 'rz']);
/** Channels whose sign flips on the X-mirrored twin. */
const MIRRORED_CHANNELS: ReadonlySet<RigChannel> = new Set(['ry', 'rz', 'tx']);

// ---------------------------------------------------------------------------
// Per-instance state layout (renderer slot arrays; the evaluator reads the same layout)
// ---------------------------------------------------------------------------

export const SLOT = {
  x: 0,
  y: 1,
  z: 2,
  yaw: 3,
  scale: 4,
  locomotion: 5,
  phase: 6,
  attackId: 7,
  attack: 8,
  stagger: 9,
  death: 10,
  dissolve: 11,
  emerge: 12,
  hitFlash: 13,
  lookYaw: 14,
  lookPitch: 15,
  rim: 16,
  rimR: 17,
  rimG: 18,
  rimB: 19,
} as const;
export const SLOT_STRIDE = 20;

/** Floats per bone matrix (3x4 row-major affine: rotation/scale | translation). */
export const BONE_STRIDE = 12;

/** Lower bound of the per-axis bone scale (same clamp in the shader). */
export const MIN_SCALE = 0.05;

// ---------------------------------------------------------------------------
// Compiled rig
// ---------------------------------------------------------------------------

export interface CompiledBone {
  readonly name: string;
  readonly parent: number;
  readonly pivot: Vec3;
  readonly motionStart: number;
  readonly motionCount: number;
}

export interface CompiledPart {
  /** The part def with mirrored coordinates already applied. */
  readonly def: EnemyPartDef;
  readonly bone: number;
  readonly zone: number;
}

export interface CompiledHitbox {
  readonly bone: number;
  readonly shape: 'sphere' | 'capsule';
  readonly zone: HitZone;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
}

export interface CompiledSocket {
  readonly bones: readonly number[];
  readonly points: readonly Vec3[];
}

export interface RigLayout {
  readonly attackBase: number;
  readonly boneBase: number;
  readonly partBase: number;
  readonly motionBase: number;
  readonly texels: number;
  readonly width: number;
  readonly height: number;
}

export interface CompiledRig {
  readonly type: string;
  readonly bones: readonly CompiledBone[];
  readonly boneIndex: ReadonlyMap<string, number>;
  readonly parts: readonly CompiledPart[];
  readonly zoneNames: readonly string[];
  readonly attackIds: readonly string[];
  readonly hitboxes: readonly CompiledHitbox[];
  readonly sockets: ReadonlyMap<string, CompiledSocket>;
  readonly aim: CompiledSocket;
  readonly motionCount: number;
  /** Longest bone chain (root = 1). */
  readonly maxDepth: number;
  readonly lookYawMax: number;
  readonly lookPitchMax: number;
  readonly layout: RigLayout;
  /** Packed table (RGBA texels, row-major) – uploaded unchanged as the rig texture. */
  readonly data: Float32Array;
  /** Driver / channel codes of each motion, decoded from `data` once (CPU fast path). */
  readonly motionDrv: Uint8Array;
  readonly motionCh: Uint8Array;
  /** 1 for bones the CPU mirror needs (hitbox / socket bones and their ancestors). */
  readonly cpuBones: Uint8Array;
}

/** Header texels at the start of the table. */
const HEADER_TEXELS = 2;
const BONE_TEXELS = 2;
const MOTION_TEXELS = 2;

/** Name of a mirrored bone's twin (`_L` → `_R`). */
function mirrorName(name: string): string {
  return name.endsWith('_L') ? `${name.slice(0, -2)}_R` : `${name}_R`;
}

/** Bone a mirrored part/hitbox/child attaches to: the `_R` twin of a sided bone, else the same bone. */
function mirrorRef(name: string): string {
  return name.endsWith('_L') ? `${name.slice(0, -2)}_R` : name;
}

const mirrorVec = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

function mirrorPart(p: EnemyPartDef): EnemyPartDef {
  const bone = mirrorRef(p.bone);
  switch (p.shape) {
    case 'ellipsoid': {
      const r = p.rot ?? [0, 0, 0];
      return { ...p, bone, center: mirrorVec(p.center), rot: [r[0], -r[1], -r[2]] };
    }
    case 'capsule':
      return { ...p, bone, a: mirrorVec(p.a), b: mirrorVec(p.b) };
    case 'spike':
      return {
        ...p,
        bone,
        a: mirrorVec(p.a),
        b: mirrorVec(p.b),
        curve: p.curve ? mirrorVec(p.curve) : undefined,
      };
    case 'lathe':
      return { ...p, bone, a: mirrorVec(p.a), b: mirrorVec(p.b) };
    case 'tube':
      return { ...p, bone, points: p.points.map(mirrorVec) };
  }
}

function mirrorMotion(m: RigMotionDef, phase: number): RigMotionDef {
  const flip = MIRRORED_CHANNELS.has(m.ch) ? -1 : 1;
  const shifted = m.drive === 'gait' || (m.freq ?? 0) > 0;
  return {
    ...m,
    amp: m.amp * flip,
    amp2: m.amp2 === undefined ? undefined : m.amp2 * flip,
    offset: (m.offset ?? 0) + (shifted ? phase : 0),
  };
}

interface ExpandedBone {
  name: string;
  parent: string | null;
  pivot: Vec3;
  motions: RigMotionDef[];
}

function expandBones(defs: readonly RigBoneDef[]): ExpandedBone[] {
  const out: ExpandedBone[] = [];
  for (const b of defs) {
    out.push({ name: b.name, parent: b.parent, pivot: b.pivot, motions: [...(b.motions ?? [])] });
    if (b.mirror) {
      const phase = b.mirrorPhase ?? 0;
      out.push({
        name: mirrorName(b.name),
        parent: b.parent === null ? null : mirrorRef(b.parent),
        pivot: mirrorVec(b.pivot),
        motions: (b.motions ?? []).filter((m) => m.mirror !== false).map((m) => mirrorMotion(m, phase)),
      });
    }
  }
  return out;
}

/** Parents before children (stable); unknown parents become roots. */
function sortBones(type: string, bones: ExpandedBone[]): ExpandedBone[] {
  const names = new Set(bones.map((b) => b.name));
  for (const b of bones) {
    if (b.parent !== null && !names.has(b.parent)) {
      log.warn(`${type}: bone "${b.name}" has unknown parent "${b.parent}" – treated as root`);
      b.parent = null;
    }
  }
  const sorted: ExpandedBone[] = [];
  const placed = new Set<string>();
  let guard = bones.length + 1;
  while (sorted.length < bones.length && guard-- > 0) {
    for (const b of bones) {
      if (placed.has(b.name)) continue;
      if (b.parent === null || placed.has(b.parent)) {
        sorted.push(b);
        placed.add(b.name);
      }
    }
  }
  if (sorted.length < bones.length) {
    for (const b of bones) {
      if (placed.has(b.name)) continue;
      log.warn(`${type}: bone "${b.name}" is part of a parent cycle – treated as root`);
      b.parent = null;
      sorted.push(b);
    }
  }
  return sorted;
}

function expandHitboxes(defs: readonly EnemyHitboxDef[]): EnemyHitboxDef[] {
  const out: EnemyHitboxDef[] = [];
  for (const h of defs) {
    out.push(h);
    if (h.mirror) {
      out.push({ ...h, bone: mirrorRef(h.bone), a: mirrorVec(h.a), b: h.b ? mirrorVec(h.b) : undefined });
    }
  }
  return out;
}

/** Compile a visual def into the packed rig table (+ CPU-side lookups). Never throws on content. */
export function compileRig(type: string, def: EnemyVisualDef): CompiledRig {
  const R = ENEMY_RENDER;
  const bones = sortBones(type, expandBones(def.bones));
  if (bones.length > R.maxBones) log.warn(`${type}: ${bones.length} bones exceed ENEMY_RENDER.maxBones`);
  const boneIndex = new Map<string, number>();
  bones.forEach((b, i) => boneIndex.set(b.name, i));
  const boneOf = (name: string, what: string): number => {
    const i = boneIndex.get(name);
    if (i === undefined) {
      log.warn(`${type}: ${what} references unknown bone "${name}" – using the root`);
      return 0;
    }
    return i;
  };

  const zoneNames = Object.keys(def.zones).slice(0, R.maxZones);
  const attackIds = def.attacks.map((a) => a.id);

  // Motions, flattened per bone (truncated to the shader loop bound).
  const motions: RigMotionDef[] = [];
  const compiledBones: CompiledBone[] = [];
  for (const b of bones) {
    const valid = b.motions.filter((m) => {
      if (m.drive === 'attack' && (m.attack === undefined || !attackIds.includes(m.attack))) {
        log.warn(`${type}: bone "${b.name}" motion references unknown attack "${m.attack}" – dropped`);
        return false;
      }
      return true;
    });
    if (valid.length > R.maxMotionsPerBone) {
      log.warn(`${type}: bone "${b.name}" has ${valid.length} motions, only ${R.maxMotionsPerBone} are used`);
      valid.length = R.maxMotionsPerBone;
    }
    compiledBones.push({
      name: b.name,
      parent: b.parent === null ? -1 : boneIndex.get(b.parent)!,
      pivot: b.pivot,
      motionStart: motions.length,
      motionCount: valid.length,
    });
    motions.push(...valid);
  }

  // Parts (mirrored twins right after their original).
  const parts: CompiledPart[] = [];
  for (const p of def.parts) {
    for (const pd of p.mirror ? [p, mirrorPart(p)] : [p]) {
      let zone = zoneNames.indexOf(pd.zone);
      if (zone < 0) {
        log.warn(`${type}: part uses unknown zone "${pd.zone}"`);
        zone = 0;
      }
      parts.push({ def: pd, bone: boneOf(pd.bone, 'part'), zone });
    }
  }

  const hitboxes: CompiledHitbox[] = expandHitboxes(def.hitboxes).map((h) => ({
    bone: boneOf(h.bone, 'hitbox'),
    shape: h.shape,
    zone: h.zone,
    a: h.a,
    b: h.b ?? h.a,
    radius: h.radius,
  }));

  const sockets = new Map<string, CompiledSocket>();
  for (const [name, anchors] of Object.entries(def.sockets)) {
    if (anchors.length === 0) continue;
    sockets.set(name, {
      bones: anchors.map((a) => boneOf(a.bone, `socket "${name}"`)),
      points: anchors.map((a) => a.point),
    });
  }
  const aim = sockets.get(def.aimSocket) ?? {
    bones: [0],
    points: [bones[0]?.pivot ?? [0, 1, 0]],
  };

  // Depth of the deepest chain.
  let maxDepth = 0;
  for (let i = 0; i < compiledBones.length; i++) {
    let d = 0;
    for (let b = i; b >= 0 && d <= compiledBones.length; b = compiledBones[b]!.parent) d++;
    maxDepth = Math.max(maxDepth, d);
  }
  if (maxDepth > R.maxDepth) log.warn(`${type}: bone chain depth ${maxDepth} exceeds ENEMY_RENDER.maxDepth`);

  // Packed table.
  const attackBase = HEADER_TEXELS;
  const boneBase = attackBase + def.attacks.length;
  const partBase = boneBase + compiledBones.length * BONE_TEXELS;
  const motionBase = partBase + parts.length;
  const texels = motionBase + motions.length * MOTION_TEXELS;
  const width = R.rigTextureWidth;
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Float32Array(width * height * 4);
  const lookYawMax = def.look.yawMaxDeg * DEG;
  const lookPitchMax = def.look.pitchMaxDeg * DEG;
  const put = (texel: number, x: number, y: number, z: number, w: number): void => {
    const o = texel * 4;
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = w;
  };
  put(0, compiledBones.length, parts.length, def.attacks.length, motions.length);
  put(1, lookYawMax, lookPitchMax, 0, 0);
  def.attacks.forEach((a, i) => put(attackBase + i, a.windup, a.strike, a.glow, 0));
  compiledBones.forEach((b, i) => {
    put(boneBase + i * BONE_TEXELS, b.pivot[0], b.pivot[1], b.pivot[2], b.parent);
    put(boneBase + i * BONE_TEXELS + 1, b.motionStart, b.motionCount, 0, 0);
  });
  parts.forEach((p, i) => put(partBase + i, p.bone, p.zone, 0, 0));
  motions.forEach((m, i) => {
    const toUnit = ROTATION_CHANNELS.has(m.ch) ? DEG : 1;
    const code = DRIVER_CODE[m.drive] * CODE_STRIDE + CHANNEL_CODE[m.ch];
    const aux =
      m.drive === 'attack'
        ? attackIds.indexOf(m.attack!)
        : m.drive === 'gait'
          ? WAVE_CODE[m.wave ?? 'sin']
          : 0;
    const amp2 = m.amp2 ?? (m.drive === 'gait' ? m.amp : 0);
    const freq = m.freq ?? (m.drive === 'gait' ? 1 : 0);
    // Windows live in 0..1: a driver at 0 then always yields exactly 0 (CPU skips such motions).
    const w = m.window ?? [0, 1];
    const win = [clamp(w[0], 0, 1), clamp(w[1], 0, 1)] as const;
    const t = motionBase + i * MOTION_TEXELS;
    put(t, code, aux, m.amp * toUnit, amp2 * toUnit);
    put(t + 1, freq, m.offset ?? 0, win[0], win[1]);
  });

  const motionDrv = new Uint8Array(motions.length);
  const motionCh = new Uint8Array(motions.length);
  for (let i = 0; i < motions.length; i++) {
    const code = Math.round(data[(motionBase + i * MOTION_TEXELS) * 4]!);
    motionDrv[i] = Math.floor(code / CODE_STRIDE);
    motionCh[i] = code % CODE_STRIDE;
  }

  const cpuBones = new Uint8Array(compiledBones.length);
  const need = (b: number): void => {
    for (let i = b; i >= 0 && cpuBones[i] === 0; i = compiledBones[i]!.parent) cpuBones[i] = 1;
  };
  for (const h of hitboxes) need(h.bone);
  for (const sock of sockets.values()) sock.bones.forEach(need);
  aim.bones.forEach(need);

  return {
    type,
    motionDrv,
    motionCh,
    cpuBones,
    bones: compiledBones,
    boneIndex,
    parts,
    zoneNames,
    attackIds,
    hitboxes,
    sockets,
    aim,
    motionCount: motions.length,
    maxDepth,
    lookYawMax,
    lookPitchMax,
    layout: { attackBase, boneBase, partBase, motionBase, texels, width, height },
    data,
  };
}

// ---------------------------------------------------------------------------
// Drivers + motions (mirrored 1:1 by RIG_GLSL in enemyShader.ts)
// ---------------------------------------------------------------------------

export interface RigDrivers {
  loc: number;
  phase: number;
  /** Valid attack index or -1. */
  attack: number;
  /** Attack envelope weights of the wind-up and strike amplitudes. */
  eW: number;
  eS: number;
  stagger: number;
  death: number;
  /** 1 - emerge (1 = still inside the rift). */
  emergeInv: number;
  lookYaw: number;
  lookPitch: number;
  time: number;
  seed: number;
  /** 1 - death: gait/idle/look/attack/stagger fade out while dying. */
  life: number;
}

export function createDrivers(): RigDrivers {
  return {
    loc: 0,
    phase: 0,
    attack: -1,
    eW: 0,
    eS: 0,
    stagger: 0,
    death: 0,
    emergeInv: 0,
    lookYaw: 0,
    lookPitch: 0,
    time: 0,
    seed: 0,
    life: 1,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** GLSL smoothstep (edges ordered; equal edges act as a step). */
export function smoothWindow(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  const t = d > 0 ? clamp((x - e0) / d, 0, 1) : x >= e0 ? 1 : 0;
  return t * t * (3 - 2 * t);
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Attack envelope at progress t: wind-up (0 → w) eases into the wind-up pose, the strike (w → s)
 * blends to the strike pose, the recovery (s → 1) returns to rest. Writes the two weights.
 */
export function attackEnvelope(
  t: number,
  windup: number,
  strike: number,
  out: { eW: number; eS: number },
): void {
  const w = clamp(windup, 0, 1);
  const s = clamp(strike, w, 1);
  if (t < w) {
    out.eW = smooth01(t / Math.max(w, 1e-5));
    out.eS = 0;
  } else if (t < s) {
    const u = smooth01((t - w) / Math.max(s - w, 1e-5));
    out.eW = 1 - u;
    out.eS = u;
  } else {
    out.eW = 0;
    out.eS = 1 - smooth01((t - s) / Math.max(1 - s, 1e-5));
  }
}

/** Fill `d` from the slot state at `o` (same clamps as the shader). */
export function computeDrivers(
  rig: CompiledRig,
  s: ArrayLike<number>,
  o: number,
  time: number,
  seed: number,
  d: RigDrivers,
): void {
  d.loc = clamp(s[o + SLOT.locomotion]!, 0, 2);
  d.phase = s[o + SLOT.phase]!;
  const attackCount = rig.attackIds.length;
  const id = Math.round(s[o + SLOT.attackId]!);
  d.attack = id >= 0 && id < attackCount ? id : -1;
  if (d.attack >= 0) {
    const k = (rig.layout.attackBase + d.attack) * 4;
    attackEnvelope(clamp(s[o + SLOT.attack]!, 0, 1), rig.data[k]!, rig.data[k + 1]!, d);
  } else {
    d.eW = 0;
    d.eS = 0;
  }
  d.stagger = clamp(s[o + SLOT.stagger]!, 0, 1);
  d.death = clamp(s[o + SLOT.death]!, 0, 1);
  d.emergeInv = 1 - clamp(s[o + SLOT.emerge]!, 0, 1);
  d.lookYaw = clamp(s[o + SLOT.lookYaw]!, -rig.lookYawMax, rig.lookYawMax);
  d.lookPitch = clamp(s[o + SLOT.lookPitch]!, -rig.lookPitchMax, rig.lookPitchMax);
  d.time = time;
  d.seed = seed;
  d.life = 1 - d.death;
}

/** Value of the motion whose first texel is `texel` (radians / meters / scale fraction). */
export function motionValue(data: Float32Array, texel: number, d: RigDrivers): number {
  const o = texel * 4;
  const code = Math.round(data[o]!);
  const drv = Math.floor(code / CODE_STRIDE);
  const aux = data[o + 1]!;
  const amp = data[o + 2]!;
  const amp2 = data[o + 3]!;
  const freq = data[o + 4]!;
  const off = data[o + 5]!;
  const w0 = data[o + 6]!;
  const w1 = data[o + 7]!;
  if (drv === DRIVER_CODE.gait) {
    let w = Math.sin(d.phase * freq + off);
    const wave = Math.round(aux);
    if (wave === WAVE_CODE.pos) w = Math.max(w, 0);
    else if (wave === WAVE_CODE.abs) w = Math.abs(w);
    const a = amp * clamp(d.loc, 0, 1) + (amp2 - amp) * clamp(d.loc - 1, 0, 1);
    return w * a * d.life;
  }
  if (drv === DRIVER_CODE.attack) {
    return Math.abs(aux - d.attack) < 0.5 ? (amp2 * d.eW + amp * d.eS) * d.life : 0;
  }
  let base: number;
  switch (drv) {
    case DRIVER_CODE.rest:
      base = 1;
      break;
    case DRIVER_CODE.idle:
      base = d.life;
      break;
    case DRIVER_CODE.loco:
      base = smoothWindow(w0, w1, d.loc * 0.5) * d.life;
      break;
    case DRIVER_CODE.stagger:
      base = smoothWindow(w0, w1, d.stagger) * d.life;
      break;
    case DRIVER_CODE.death:
      base = smoothWindow(w0, w1, d.death);
      break;
    case DRIVER_CODE.emerge:
      base = smoothWindow(w0, w1, d.emergeInv);
      break;
    case DRIVER_CODE.lookYaw:
      base = d.lookYaw * d.life;
      break;
    case DRIVER_CODE.lookPitch:
      base = -d.lookPitch * d.life;
      break;
    default:
      base = 0;
  }
  if (freq > 0) base *= Math.sin(TAU * freq * d.time + off + d.seed * TAU);
  return base * amp;
}

// ---------------------------------------------------------------------------
// Bone evaluation
// ---------------------------------------------------------------------------

const _d = createDrivers();

function bit(code: number, on: boolean): number {
  return on ? 1 << code : 0;
}

/**
 * Model-space bone transforms for the slot state at `o` into `out` (BONE_STRIDE floats per bone,
 * 3x4 row-major, starting at `outOffset`). Same math as the vertex shader. `onlyNeeded` skips
 * bones no hitbox/socket depends on (their matrices are left untouched).
 */
export function evaluateRig(
  rig: CompiledRig,
  s: ArrayLike<number>,
  o: number,
  time: number,
  seed: number,
  out: Float32Array,
  outOffset = 0,
  onlyNeeded = false,
): void {
  const d = _d;
  computeDrivers(rig, s, o, time, seed, d);
  const skip = onlyNeeded ? rig.cpuBones : null;
  const data = rig.data;
  const { boneBase, motionBase } = rig.layout;
  const drvOf = rig.motionDrv;
  const chOf = rig.motionCh;
  // Drivers whose motions are exactly 0 this pose are skipped (the shader computes the same 0).
  const alive = d.life > 0;
  const active =
    bit(DRIVER_CODE.rest, true) |
    bit(DRIVER_CODE.idle, alive) |
    bit(DRIVER_CODE.gait, alive && d.loc > 0) |
    bit(DRIVER_CODE.loco, alive && d.loc > 0) |
    bit(DRIVER_CODE.attack, alive && d.attack >= 0) |
    bit(DRIVER_CODE.stagger, alive && d.stagger > 0) |
    bit(DRIVER_CODE.death, d.death > 0) |
    bit(DRIVER_CODE.emerge, d.emergeInv > 0) |
    bit(DRIVER_CODE.lookYaw, alive && d.lookYaw !== 0) |
    bit(DRIVER_CODE.lookPitch, alive && d.lookPitch !== 0);
  const bones = rig.bones;
  for (let b = 0; b < bones.length; b++) {
    if (skip !== null && skip[b] === 0) continue;
    const bt = (boneBase + b * BONE_TEXELS) * 4;
    const cx = data[bt]!;
    const cy = data[bt + 1]!;
    const cz = data[bt + 2]!;
    const start = data[bt + 4]!;
    const count = data[bt + 5]!;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    let sx = 1;
    let sy = 1;
    let sz = 1;
    for (let i = 0; i < count; i++) {
      const mi = start + i;
      if (((active >> drvOf[mi]!) & 1) === 0) continue;
      const v = motionValue(data, motionBase + mi * MOTION_TEXELS, d);
      switch (chOf[mi]) {
        case 0:
          rx += v;
          break;
        case 1:
          ry += v;
          break;
        case 2:
          rz += v;
          break;
        case 3:
          mx += v;
          break;
        case 4:
          my += v;
          break;
        case 5:
          mz += v;
          break;
        case 6:
          sx += v;
          break;
        case 7:
          sy += v;
          break;
        case 8:
          sz += v;
          break;
        default:
          sx += v;
          sy += v;
          sz += v;
      }
    }
    sx = Math.max(sx, MIN_SCALE);
    sy = Math.max(sy, MIN_SCALE);
    sz = Math.max(sz, MIN_SCALE);
    // R = Ry · Rx · Rz (three.js Euler 'YXZ').
    const ca = ry === 0 ? 1 : Math.cos(ry);
    const sa = ry === 0 ? 0 : Math.sin(ry);
    const cb = rx === 0 ? 1 : Math.cos(rx);
    const sb = rx === 0 ? 0 : Math.sin(rx);
    const cc = rz === 0 ? 1 : Math.cos(rz);
    const sc = rz === 0 ? 0 : Math.sin(rz);
    // Local A = R · diag(S).
    const l00 = (ca * cc + sa * sb * sc) * sx;
    const l01 = (-ca * sc + sa * sb * cc) * sy;
    const l02 = sa * cb * sz;
    const l10 = cb * sc * sx;
    const l11 = cb * cc * sy;
    const l12 = -sb * sz;
    const l20 = (-sa * cc + ca * sb * sc) * sx;
    const l21 = (sa * sc + ca * sb * cc) * sy;
    const l22 = ca * cb * sz;
    // Local t = pivot + move - A · pivot.
    const lx = cx + mx - (l00 * cx + l01 * cy + l02 * cz);
    const ly = cy + my - (l10 * cx + l11 * cy + l12 * cz);
    const lz = cz + mz - (l20 * cx + l21 * cy + l22 * cz);
    const m = outOffset + b * BONE_STRIDE;
    const parent = bones[b]!.parent;
    if (parent < 0) {
      out[m] = l00;
      out[m + 1] = l01;
      out[m + 2] = l02;
      out[m + 3] = lx;
      out[m + 4] = l10;
      out[m + 5] = l11;
      out[m + 6] = l12;
      out[m + 7] = ly;
      out[m + 8] = l20;
      out[m + 9] = l21;
      out[m + 10] = l22;
      out[m + 11] = lz;
    } else {
      const p = outOffset + parent * BONE_STRIDE;
      const p00 = out[p]!;
      const p01 = out[p + 1]!;
      const p02 = out[p + 2]!;
      const p03 = out[p + 3]!;
      const p10 = out[p + 4]!;
      const p11 = out[p + 5]!;
      const p12 = out[p + 6]!;
      const p13 = out[p + 7]!;
      const p20 = out[p + 8]!;
      const p21 = out[p + 9]!;
      const p22 = out[p + 10]!;
      const p23 = out[p + 11]!;
      out[m] = p00 * l00 + p01 * l10 + p02 * l20;
      out[m + 1] = p00 * l01 + p01 * l11 + p02 * l21;
      out[m + 2] = p00 * l02 + p01 * l12 + p02 * l22;
      out[m + 3] = p00 * lx + p01 * ly + p02 * lz + p03;
      out[m + 4] = p10 * l00 + p11 * l10 + p12 * l20;
      out[m + 5] = p10 * l01 + p11 * l11 + p12 * l21;
      out[m + 6] = p10 * l02 + p11 * l12 + p12 * l22;
      out[m + 7] = p10 * lx + p11 * ly + p12 * lz + p13;
      out[m + 8] = p20 * l00 + p21 * l10 + p22 * l20;
      out[m + 9] = p20 * l01 + p21 * l11 + p22 * l21;
      out[m + 10] = p20 * l02 + p21 * l12 + p22 * l22;
      out[m + 11] = p20 * lx + p21 * ly + p22 * lz + p23;
    }
  }
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Rest-pose model point `p` through bone `bone`'s transform (from evaluateRig) into `out`. */
export function boneTransformPoint<T extends XYZ>(
  mats: Float32Array,
  outOffset: number,
  bone: number,
  p: Vec3,
  out: T,
): T {
  const m = outOffset + bone * BONE_STRIDE;
  const x = p[0];
  const y = p[1];
  const z = p[2];
  out.x = mats[m]! * x + mats[m + 1]! * y + mats[m + 2]! * z + mats[m + 3]!;
  out.y = mats[m + 4]! * x + mats[m + 5]! * y + mats[m + 6]! * z + mats[m + 7]!;
  out.z = mats[m + 8]! * x + mats[m + 9]! * y + mats[m + 10]! * z + mats[m + 11]!;
  return out;
}

/** Largest axis scale of bone `bone`'s transform (hitbox radii follow inflating / shrinking parts). */
export function boneScale(mats: Float32Array, outOffset: number, bone: number): number {
  const m = outOffset + bone * BONE_STRIDE;
  const a = mats[m]!;
  const b = mats[m + 1]!;
  const c = mats[m + 2]!;
  const d = mats[m + 4]!;
  const e = mats[m + 5]!;
  const f = mats[m + 6]!;
  const g = mats[m + 8]!;
  const h = mats[m + 9]!;
  const i = mats[m + 10]!;
  const sx = a * a + d * d + g * g;
  const sy = b * b + e * e + h * h;
  const sz = c * c + f * f + i * i;
  return Math.sqrt(sx > sy ? (sx > sz ? sx : sz) : sy > sz ? sy : sz);
}

/** Model → world for the slot at `o`: position + Ry(yaw) · (scale · p) (the instance matrix). */
export function slotModelToWorld<T extends XYZ>(s: ArrayLike<number>, o: number, out: T): T {
  const yaw = s[o + SLOT.yaw]!;
  const k = s[o + SLOT.scale]!;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const x = out.x * k;
  const y = out.y * k;
  const z = out.z * k;
  out.x = c * x + sn * z + s[o + SLOT.x]!;
  out.y = y + s[o + SLOT.y]!;
  out.z = -sn * x + c * z + s[o + SLOT.z]!;
  return out;
}

/** Body yaw that faces the direction (dx, dz) (model front = +Z). */
export function yawToward(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

export interface SphereLike {
  a: XYZ;
  b: XYZ;
  radius: number;
}

/**
 * Bounding sphere of `n` hitboxes (sphere: a; capsule: segment a-b) → center into `outCenter`,
 * returns the radius. Contains every hitbox completely.
 */
export function boundsOfHitboxes(boxes: readonly SphereLike[], n: number, outCenter: XYZ): number {
  if (n <= 0) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = boxes[i]!;
    const r = h.radius;
    minX = Math.min(minX, h.a.x - r, h.b.x - r);
    minY = Math.min(minY, h.a.y - r, h.b.y - r);
    minZ = Math.min(minZ, h.a.z - r, h.b.z - r);
    maxX = Math.max(maxX, h.a.x + r, h.b.x + r);
    maxY = Math.max(maxY, h.a.y + r, h.b.y + r);
    maxZ = Math.max(maxZ, h.a.z + r, h.b.z + r);
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  outCenter.x = cx;
  outCenter.y = cy;
  outCenter.z = cz;
  let radius = 0;
  for (let i = 0; i < n; i++) {
    const h = boxes[i]!;
    const ax = h.a.x - cx;
    const ay = h.a.y - cy;
    const az = h.a.z - cz;
    const bx = h.b.x - cx;
    const by = h.b.y - cy;
    const bz = h.b.z - cz;
    const d2 = Math.max(ax * ax + ay * ay + az * az, bx * bx + by * by + bz * bz);
    radius = Math.max(radius, Math.sqrt(d2) + h.radius);
  }
  return radius;
}

/** Floats per packed world hitbox: a (3), b (3), radius. */
export const HITBOX_STRIDE = 7;

/**
 * boundsOfHitboxes for `n` packed hitboxes (HITBOX_STRIDE floats each, from `offset`): writes the
 * center and radius to `out` at `outOffset` (x, y, z, r) and returns the radius.
 */
export function boundsOfPacked(
  w: Float32Array,
  offset: number,
  n: number,
  out: Float32Array,
  outOffset: number,
): number {
  if (n <= 0) {
    out.fill(0, outOffset, outOffset + 4);
    return 0;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0, q = offset; i < n; i++, q += HITBOX_STRIDE) {
    const r = w[q + 6]!;
    for (let e = 0; e < 6; e += 3) {
      const x = w[q + e]!;
      const y = w[q + e + 1]!;
      const z = w[q + e + 2]!;
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (z - r < minZ) minZ = z - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
      if (z + r > maxZ) maxZ = z + r;
    }
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  let radius = 0;
  for (let i = 0, q = offset; i < n; i++, q += HITBOX_STRIDE) {
    for (let e = 0; e < 6; e += 3) {
      const dx = w[q + e]! - cx;
      const dy = w[q + e + 1]! - cy;
      const dz = w[q + e + 2]! - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + w[q + 6]!;
      if (d > radius) radius = d;
    }
  }
  out[outOffset] = cx;
  out[outOffset + 1] = cy;
  out[outOffset + 2] = cz;
  out[outOffset + 3] = radius;
  return radius;
}
