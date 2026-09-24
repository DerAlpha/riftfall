/**
 * The Rift Forge: a monumental rift-energy furnace. A hazard plinth and a heavy base carry the
 * furnace tower with a swirling rift core behind a thick ring, two pylons with molten-amber strips
 * and hammer arms on their shoulders, and the anvil in front. Glowing heat vents on the tower
 * flanks, a crown with a warning lamp, a price screen on the base front and a warm floor glow.
 *
 * Driven by RiftForge (readout per frame): during a sequence the weapon in hand appears as a
 * hologram on the anvil (tinted in its new forge color), the core spins up and runs hot, the arms
 * hammer it (sparks, strike flashes), and the hologram bursts when the weapon goes back to the
 * player; then the machine cools down. Idle: slow core swirl, breathing strips, raised arms.
 * Only uniforms / transforms change per frame (no allocation, no recompiles).
 *
 * Local frame: origin at the floor center of the machine, +Z = front.
 */
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { VfxApi } from '../../core/contracts';
import { clamp01, lerp, smoothstep } from '../../core/math';
import { FORGE, forgePaletteId, getForgeLook } from '../../defs/forge';
import { HOLOGRAM } from '../../defs/interactables';
import { getWeaponDef } from '../../defs/weapons';
import { RIFT_FORGE_MACHINE } from '../../defs/workshop';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';
import type { RiftForgeReadout, RiftForgeViewApi } from '../RiftForge';
import { createCanvasSurface, redraw, type CanvasSurface } from './canvas';
import { createGlowMaterial, srgbHexToLinear, type VisualContext } from './context';
import { createHoloMaterial, createLightPool, toVolumetricLayer, type HoloMaterial, type PoolMaterial } from './holo';
import { PartBuilder } from './parts';

const M = RIFT_FORGE_MACHINE;
const L = M.layout;
const SEQ = M.sequence;
const UP = { x: 0, y: 1, z: 0 };
const CYL_SEGMENTS = 20;
const TORUS_TUBE_SEGMENTS = 12;
/** Beam of an arm: it starts this far out of the shoulder (m). */
const ARM_ROOT = 0.05;
/** The hologram's fade-out rate after the release burst (1/s). */
const HOLO_OUT_RATE = 5;

const _v = new Vector3();

const CORE_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vUv;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vUv = uv;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uIntensity;
uniform float uPhase;
uniform float uHeat;
varying vec2 vUv;
varying float vFog;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  // Logarithmic spiral arms drifting inwards, a fine grain, a hot center and a bright lip.
  float spiral = sin(a * 3.0 + log(r + 0.04) * 5.5 + uPhase * 2.0);
  float arms = smoothstep(0.1, 1.0, spiral * 0.5 + 0.5);
  float grain = 0.5 + 0.5 * sin(a * 13.0 - uPhase * 3.3 + r * 31.0);
  float core = 1.0 - smoothstep(0.0, 0.42, r);
  float lip = smoothstep(0.72, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
  float i = arms * (0.25 + 0.75 * (1.0 - r)) + grain * 0.14 * (1.0 - r) + core * (0.5 + 1.6 * uHeat) + lip * 0.9;
  vec3 col = mix(uColor, uHot, clamp(core * (0.35 + uHeat) + uHeat * 0.3 * (1.0 - r), 0.0, 1.0));
  gl_FragColor = vec4(col * i * uIntensity * vFog, 1.0);
}
`;

type CoreMaterial = ShaderMaterial & {
  uniforms: {
    uColor: { value: Color };
    uHot: { value: Color };
    uIntensity: { value: number };
    uPhase: { value: number };
    uHeat: { value: number };
  };
};

function createCoreMaterial(): CoreMaterial {
  const c = M.coreColor;
  const h = M.coreHotColor;
  return new ShaderMaterial({
    name: 'forge-core',
    uniforms: {
      uColor: { value: new Color(c[0], c[1], c[2]) },
      uHot: { value: new Color(h[0], h[1], h[2]) },
      uIntensity: { value: M.coreIntensity },
      uPhase: { value: 0 },
      uHeat: { value: 0 },
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
    fog: false,
  }) as CoreMaterial;
}

interface Arm {
  readonly pivot: Group;
  /** +1 right arm, −1 left arm. */
  readonly side: number;
  /** Rotation (rad, about Z) at the strike and at rest. */
  readonly strike: number;
  readonly rest: number;
  /** Seconds since its last strike began (large = resting). */
  since: number;
}

export class RiftForgeView implements RiftForgeViewApi {
  readonly group = new Group();
  private readonly strips: MeshStandardMaterial;
  private readonly vents: MeshStandardMaterial;
  private readonly coreBack: MeshStandardMaterial;
  private readonly screenMat: MeshStandardMaterial;
  private readonly core: CoreMaterial;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial>;
  private readonly corona: Mesh<PlaneGeometry, PoolMaterial>;
  private readonly holo: Mesh;
  private readonly holoMat: HoloMaterial;
  private readonly arms: Arm[] = [];
  private readonly surface: CanvasSurface | null;
  private readonly strikePoint = new Vector3();
  private phase = 0;
  private heat = 0;
  private flashAmount = 0;
  private holoLevel = 0;
  private holoWeapon: string | null = null;
  private holoBurst = false;
  private disposed = false;

  constructor(
    private readonly ctx: VisualContext,
    center: Vector3,
    yaw: number,
    private readonly vfx: Pick<VfxApi, 'spawn'> | null,
  ) {
    const g = this.group;
    g.name = 'rift-forge';
    g.position.copy(center);
    g.rotation.y = yaw;
    ctx.root.add(g);
    this.strips = createGlowMaterial(ctx, M.stripColor, M.stripIntensity, 'forge-strip');
    this.vents = createGlowMaterial(ctx, M.ventColor, 0, 'forge-vent');
    this.coreBack = createGlowMaterial(ctx, M.coreColor, M.coreIntensity * 0.35, 'forge-core-back');

    const { width: W, depth: D } = M.size;
    const P = L.plinth;
    const B = L.base;
    const T = L.tower;
    const baseTop = P.height + B.height;
    const pb = new PartBuilder();

    // --- plinth, base, deck ---
    pb.boxMinMax('hazard', -W / 2 + P.inset, 0, -D / 2 + P.inset, W / 2 - P.inset, P.height, D / 2 - P.inset);
    pb.boxMinMax('body', -B.width / 2, P.height, -B.depth / 2, B.width / 2, baseTop, B.depth / 2);
    pb.boxMinMax('deck', -B.width / 2 + 0.06, baseTop, -B.depth / 2 + 0.06, B.width / 2 - 0.06, baseTop + 0.02, B.depth / 2 - 0.06);
    // Hazard lip along the base front top edge and trim corners.
    pb.boxMinMax('hazard', -B.width / 2, baseTop - 0.07, B.depth / 2, B.width / 2, baseTop, B.depth / 2 + 0.015);
    for (const s of [-1, 1]) {
      pb.boxMinMax('trim', s * B.width / 2 - 0.07, P.height, B.depth / 2 - 0.07, s * B.width / 2 + 0.07, baseTop + 0.03, B.depth / 2 + 0.03);
    }

    // --- furnace tower ---
    const tz0 = T.back;
    const tz1 = T.back + T.depth;
    pb.boxMinMax('panel', -T.width / 2, baseTop, tz0, T.width / 2, T.top, tz1);
    for (const s of [-1, 1]) {
      // Corner ribs and a mid band.
      pb.boxMinMax('trim', s * T.width / 2 - 0.08, baseTop, tz1 - 0.08, s * T.width / 2 + 0.03, T.top, tz1 + 0.03);
      pb.boxMinMax('trim', s * T.width / 2 - 0.08, baseTop, tz0 - 0.03, s * T.width / 2 + 0.03, T.top, tz0 + 0.08);
    }
    pb.boxMinMax('trim', -T.width / 2, baseTop + 0.62, tz1, T.width / 2, baseTop + 0.7, tz1 + 0.025);
    // Heat vents on both flanks: a glowing slot behind slats.
    const V = L.vent;
    for (const s of [-1, 1]) {
      const x = s * (T.width / 2 + 0.01);
      const zc = (tz0 + tz1) / 2;
      pb.box('vent', x, V.y, zc, 0.02, V.height, V.width);
      for (let i = 0; i < V.slats; i++) {
        const y = V.y - V.height / 2 + ((i + 0.5) * V.height) / V.slats;
        pb.box('trim', x + s * 0.02, y, zc, 0.04, 0.035, V.width + 0.06);
      }
    }
    // Crown with a hazard band and a warning lamp.
    const C = L.crown;
    pb.boxMinMax('hazard', -T.width / 2, T.top - 0.12, tz0, T.width / 2, T.top, tz1 + 0.01);
    pb.boxMinMax('trim', -T.width / 2 - C.overhang, T.top, tz0 - C.overhang, T.width / 2 + C.overhang, T.top + C.height, tz1 + C.overhang);
    pb.box('strip', 0, T.top + C.height + 0.05, tz1 - 0.1, 0.5, 0.1, 0.12);

    // Exhaust stack with a glowing throat.
    const SK = L.stack;
    pb.cylinder('trim', 0, T.top + C.height + SK.height / 2, SK.z, SK.radius, SK.height, 'y', CYL_SEGMENTS);
    pb.cylinder('coreBack', 0, T.top + C.height + SK.height + 0.005, SK.z, SK.radius * 0.72, 0.012, 'y', CYL_SEGMENTS);
    pb.cylinder('hazard', 0, T.top + C.height + SK.height * 0.7, SK.z, SK.radius + 0.012, 0.06, 'y', CYL_SEGMENTS);
    // Coolant tanks behind the pylons: rift fluid glowing through a front window.
    const TK = L.tank;
    for (const s of [-1, 1]) {
      const x = s * TK.x;
      pb.cylinder('body', x, baseTop + TK.height / 2, TK.z, TK.radius, TK.height, 'y', CYL_SEGMENTS);
      pb.cylinder('trim', x, baseTop + TK.height + 0.04, TK.z, TK.radius + 0.03, 0.08, 'y', CYL_SEGMENTS);
      pb.cylinder('trim', x, baseTop + 0.05, TK.z, TK.radius + 0.03, 0.1, 'y', CYL_SEGMENTS);
      pb.box('coreBack', x, baseTop + TK.height / 2, TK.z + TK.radius - 0.005, TK.window, TK.height * 0.8, 0.02);
    }

    // --- rift core window ---
    const K = L.core;
    const coreRing = new TorusGeometry(K.radius + K.ring * 0.4, K.ring, TORUS_TUBE_SEGMENTS, K.segments);
    // The ring is merged by hand (PartBuilder has no torus).
    const ringMesh = new Mesh(coreRing, ctx.materials.get(M.materials.trim));
    ringMesh.position.set(0, K.y, tz1 + K.ring * 0.4);
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    ringMesh.userData.navIgnore = true;
    ringMesh.name = 'prop:forge-ring';
    g.add(ringMesh);
    // Glowing recess behind the swirl.
    pb.cylinder('coreBack', 0, K.y, tz1 - K.recess / 2 + 0.005, K.radius, K.recess, 'z', K.segments);
    // Bolts around the ring.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r = K.radius + K.ring * 1.6;
      pb.cylinder('trim', Math.cos(a) * r, K.y + Math.sin(a) * r, tz1 + 0.02, 0.035, 0.05, 'z', 8);
    }

    // --- pylons with the arm shoulders ---
    const Y = L.pylon;
    const A = L.arm;
    for (const s of [-1, 1]) {
      const x = s * Y.x;
      pb.boxMinMax('body', x - Y.width / 2, baseTop, Y.back, x + Y.width / 2, Y.top, Y.back + Y.depth);
      pb.boxMinMax('trim', x - Y.width / 2 - 0.03, Y.top, Y.back - 0.03, x + Y.width / 2 + 0.03, Y.top + 0.08, Y.back + Y.depth + 0.03);
      // Amber strip up the pylon front.
      const fz = Y.back + Y.depth + 0.006;
      pb.box('strip', x, (baseTop + 0.15 + Y.top - 0.45) / 2, fz, M.layout.strip.width, Y.top - 0.45 - baseTop - 0.15, 0.012);
      // Shoulder bracket and joint.
      pb.boxMinMax('trim', s * A.pivot[0] - 0.12, A.pivot[1] - 0.2, Y.back + Y.depth - 0.05, s * A.pivot[0] + 0.12, A.pivot[1] + 0.2, A.pivot[2] - 0.08);
      pb.cylinder('trim', s * A.pivot[0], A.pivot[1], A.pivot[2] - 0.04, A.shoulder * 1.15, 0.1, 'z', CYL_SEGMENTS);
      // Conduits from the tower into the pylon.
      pb.cylinder('trim', (s * (T.width / 2 + Y.x - Y.width / 2)) / 2, baseTop + 1.9, tz0 + 0.3, 0.05, Y.x - Y.width / 2 - T.width / 2 + 0.1, 'x', 10);
      pb.cylinder('trim', (s * (T.width / 2 + Y.x - Y.width / 2)) / 2, baseTop + 1.72, tz0 + 0.3, 0.035, Y.x - Y.width / 2 - T.width / 2 + 0.1, 'x', 10);
    }

    // --- anvil ---
    const N = L.anvil;
    const pedTop = baseTop + N.pedestal[1];
    pb.box('body', 0, baseTop + N.pedestal[1] / 2, N.z, N.pedestal[0], N.pedestal[1], N.pedestal[2]);
    pb.box('trim', 0, pedTop + N.top[1] / 2, N.z, N.top[0], N.top[1], N.top[2]);
    // Horn (stepped taper to the left) and a heel block to the right.
    pb.box('trim', -N.top[0] / 2 - N.horn / 2, pedTop + N.top[1] * 0.62, N.z, N.horn, N.top[1] * 0.5, N.top[2] * 0.55);
    pb.box('trim', -N.top[0] / 2 - N.horn * 1.1, pedTop + N.top[1] * 0.68, N.z, N.horn * 0.3, N.top[1] * 0.3, N.top[2] * 0.3);
    pb.box('trim', N.top[0] / 2 + 0.05, pedTop + N.top[1] * 0.5, N.z, 0.1, N.top[1] * 0.8, N.top[2] * 0.8);
    // Glowing cradle groove on the anvil face.
    const anvilTop = pedTop + N.top[1];
    pb.box('coreBack', 0, anvilTop + 0.004, N.z, N.top[0] * 0.78, 0.01, 0.05);

    const mats = ctx.materials;
    pb.mesh('hazard', mats.get(M.materials.hazard), g, false);
    pb.mesh('body', mats.get(M.materials.body), g, true);
    pb.mesh('deck', mats.get(M.materials.deck), g, false);
    pb.mesh('panel', mats.get(M.materials.panel), g, true);
    pb.mesh('trim', mats.get(M.materials.trim), g, false);
    pb.mesh('strip', this.strips, g, false);
    pb.mesh('vent', this.vents, g, false);
    pb.mesh('coreBack', this.coreBack, g, false);
    pb.dispose();

    // --- hammer arms ---
    const trim = mats.get(M.materials.trim);
    const body = mats.get(M.materials.body);
    for (const side of [-1, 1]) {
      const px = side * A.pivot[0];
      const dx = side * A.strikeAt[0] - px;
      const dy = A.strikeAt[1] - A.pivot[1];
      const len = Math.hypot(dx, dy);
      // Angle about Z that turns the arm's local −Y onto the strike direction.
      const strike = Math.atan2(dx, -dy);
      const rest = strike - side * A.liftDeg * (Math.PI / 180);
      const pivot = new Group();
      pivot.name = `forge-arm-${side > 0 ? 'r' : 'l'}`;
      pivot.position.set(px, A.pivot[1], A.pivot[2]);
      pivot.rotation.z = rest;
      g.add(pivot);
      const ab = new PartBuilder();
      ab.cylinder('trim', 0, 0, 0, A.shoulder, 0.16, 'z', CYL_SEGMENTS);
      ab.box('body', 0, -(ARM_ROOT + len) / 2, 0, A.beam, len - ARM_ROOT, A.beam);
      // Hydraulic sleeve and the hammer head with a glowing striking face.
      ab.box('trim', 0, -len * 0.45, A.beam * 0.7, A.beam * 0.5, len * 0.45, A.beam * 0.4);
      ab.box('trim', 0, -len, 0, A.head[0], A.head[1], A.head[2]);
      ab.box('strip', 0, -len - A.head[1] / 2 - 0.006, 0, A.head[0] * 0.8, 0.012, A.head[2] * 0.8);
      ab.box('strip', 0, -len, A.head[2] / 2 + 0.004, A.head[0] * 0.7, 0.03, 0.008);
      ab.mesh('trim', trim, pivot, true);
      ab.mesh('body', body, pivot, true);
      ab.mesh('strip', this.strips, pivot, false);
      ab.dispose();
      this.arms.push({ pivot, side, strike, rest, since: Number.POSITIVE_INFINITY });
    }
    this.strikePoint.set(0, anvilTop + N.holoLift, N.z);

    // Soft corona around the ring (an upright light pool).
    this.corona = createLightPool(M.coreColor, M.corona.intensity, K.radius * K.corona);
    this.corona.rotation.x = Math.PI / 2;
    this.corona.position.set(0, K.y, tz1 + 0.03);
    g.add(this.corona);

    // --- rift core swirl (additive, volumetric layer) ---
    this.core = createCoreMaterial();
    const disc = toVolumetricLayer(new Mesh(new CircleGeometry(K.radius, K.segments), this.core));
    disc.name = 'forge-core';
    disc.position.set(0, K.y, tz1 + 0.012);
    g.add(disc);

    // --- weapon hologram on the anvil ---
    this.holoMat = createHoloMaterial({
      color: M.stripColor,
      intensity: M.hologram.intensity,
      time: ctx.time,
      reduceFlashing: ctx.reduceFlashing,
      seed: 0.37,
    });
    this.holoMat.uniforms.uFade.value = 0;
    this.holo = toVolumetricLayer(new Mesh(ctx.holograms.get('rifle'), this.holoMat));
    this.holo.name = 'forge-hologram';
    this.holo.position.copy(this.strikePoint);
    this.holo.scale.setScalar(N.holoLength);
    this.holo.visible = false;
    g.add(this.holo);

    // --- price screen on the base front ---
    const S = L.panel;
    this.surface = createCanvasSurface(S.canvas[0], S.canvas[1], true);
    const map = this.surface?.texture ?? null;
    const pc = M.panelColor;
    this.screenMat = new MeshStandardMaterial({
      name: 'forge-screen',
      color: 0x07080a,
      roughness: 0.3,
      metalness: 0,
      map,
      emissive: new Color(pc[0], pc[1], pc[2]),
      emissiveMap: map,
      emissiveIntensity: map ? M.panelIntensity : 0,
    });
    ctx.setupMaterial(this.screenMat);
    const screen = new Mesh(new PlaneGeometry(S.width, S.height), this.screenMat);
    screen.name = 'forge-screen';
    screen.position.set(0, S.y, B.depth / 2 + 0.004);
    screen.userData.navIgnore = true;
    g.add(screen);
    redraw(this.surface, drawForgePanel);

    // --- floor glow ---
    const G = M.glowPool;
    this.pool = createLightPool(G.color, G.intensity, G.radius);
    this.pool.position.z = D / 2 + G.forward;
    g.add(this.pool);
    g.updateMatrixWorld(true);
  }

  begin(weaponId: string, tier: number): void {
    const def = getWeaponDef(weaponId);
    const look = def ? getForgeLook(forgePaletteId(def, tier)) : undefined;
    const c = look ? srgbHexToLinear(look.accent) : M.stripColor;
    this.holoMat.uniforms.uColor.value.setRGB(c[0], c[1], c[2]);
    if (weaponId !== this.holoWeapon) {
      this.holo.geometry = this.ctx.holograms.get(weaponId);
      this.holo.scale.setScalar(
        this.ctx.holograms.displayLength(weaponId, 1, L.anvil.holoLength * 0.6, L.anvil.holoLength),
      );
      this.holoWeapon = weaponId;
    }
    this.holoBurst = false;
    for (const a of this.arms) a.since = Number.POSITIVE_INFINITY;
  }

  strike(index: number): void {
    const n = SEQ.strikes.length;
    // Alternate left / right; the last blow comes from both arms.
    for (const a of this.arms) {
      const hits = index === n - 1 || (index % 2 === 0 ? a.side < 0 : a.side > 0);
      if (hits) a.since = 0;
    }
    this.flashAmount = M.strikeFlash.peak;
    this.holoMat.uniforms.uFlash.value = 1;
    if (this.vfx) {
      this.group.localToWorld(_v.copy(this.strikePoint));
      this.vfx.spawn(SEQ.sparkEffect, _v, UP, SEQ.sparkScale);
    }
  }

  release(): void {
    this.holoBurst = true;
    this.flashAmount = M.strikeFlash.peak;
    this.holoMat.uniforms.uFlash.value = 1;
    if (this.vfx) {
      this.group.localToWorld(_v.copy(this.strikePoint));
      this.vfx.spawn(SEQ.releaseEffect, _v, UP, SEQ.releaseScale);
    }
  }

  update(dt: number, time: number, r: RiftForgeReadout): void {
    if (this.disposed) return;
    // Heat follows the sequence: ramps up to the last strike, cools after the release.
    const t = r.time;
    const lastStrike = SEQ.strikes[SEQ.strikes.length - 1] ?? SEQ.releaseAt;
    const target = r.forging
      ? r.released
        ? 1 - smoothstep(SEQ.releaseAt, SEQ.duration, t)
        : smoothstep(0, lastStrike, t)
      : 0;
    this.heat = lerp(this.heat, target, 1 - Math.exp(-dt * 6));
    const heat = this.heat;
    this.flashAmount = Math.max(0, this.flashAmount - dt * M.strikeFlash.decay);
    const reduced = this.ctx.reduceFlashing;
    const flash = this.flashAmount * (reduced ? 0.4 : 1);

    // Core swirl and glow.
    this.phase += dt * lerp(M.swirl.idle, M.swirl.forging, heat);
    const pu = M.pulse;
    const breathe = 1 + (reduced ? pu.reducedDepth : pu.depth) * Math.sin(time * pu.rate);
    const B = M.forgingBoost;
    const cu = this.core.uniforms;
    cu.uPhase.value = this.phase;
    cu.uHeat.value = heat;
    cu.uIntensity.value = M.coreIntensity * breathe * lerp(1, B.core, heat) + flash * 0.5;
    this.coreBack.emissiveIntensity = M.coreIntensity * 0.35 * breathe * lerp(1, B.core, heat);
    this.strips.emissiveIntensity = M.stripIntensity * breathe * lerp(1, B.strips, heat) + flash * M.stripIntensity * 0.4;
    this.vents.emissiveIntensity = M.ventIntensity * heat * heat;
    this.pool.material.uniforms.uIntensity.value = M.glowPool.intensity * breathe * lerp(1, B.pool, heat);
    this.corona.material.uniforms.uIntensity.value =
      M.corona.intensity * breathe * lerp(1, M.corona.forgingBoost, heat) + flash * 0.2;

    // Arms: raised at rest, cocked while the weapon is fed in, hammer blows on the strikes.
    const cock = r.forging && !r.released ? smoothstep(0, SEQ.holoIn * 2, t) : 0;
    for (const a of this.arms) {
      a.since += dt;
      const rest = a.rest - a.side * cock * L.arm.cockDeg * (Math.PI / 180);
      let k = 0;
      if (a.since < SEQ.strikeDown) k = smoothstep(0, 1, a.since / SEQ.strikeDown);
      else if (a.since < SEQ.strikeDown + SEQ.strikeUp) k = 1 - smoothstep(0, 1, (a.since - SEQ.strikeDown) / SEQ.strikeUp);
      a.pivot.rotation.z = lerp(rest, a.strike, k * k);
    }

    // Weapon hologram: forms after the intake, flickers on strikes, bursts at the release.
    const holoTarget = r.forging && !this.holoBurst && t >= SEQ.holoIn ? 1 : 0;
    const rate = holoTarget > this.holoLevel ? 1 / Math.max(1e-3, SEQ.holoFade) : HOLO_OUT_RATE;
    this.holoLevel = clamp01(this.holoLevel + Math.sign(holoTarget - this.holoLevel) * rate * dt);
    const hu = this.holoMat.uniforms;
    hu.uFlash.value = Math.max(0, hu.uFlash.value - dt * M.strikeFlash.decay);
    hu.uFade.value = this.holoLevel;
    hu.uIntensity.value = M.hologram.intensity * (1 + heat * 0.6);
    this.holo.visible = this.holoLevel > 0.001;
    if (this.holo.visible) {
      this.holo.position.y = this.strikePoint.y + Math.sin(time * 2.1) * M.hologram.bob;
      this.holo.rotation.y = Math.sin(time * M.hologram.spinRate) * 0.12;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o: Object3D) => {
      const m = o as Mesh;
      // The hologram geometry belongs to the shared library.
      if (m.isMesh && m !== this.holo) m.geometry.dispose();
    });
    this.strips.dispose();
    this.vents.dispose();
    this.coreBack.dispose();
    this.screenMat.dispose();
    this.core.dispose();
    this.holoMat.dispose();
    this.pool.material.dispose();
    this.corona.material.dispose();
    this.surface?.texture.dispose();
  }
}

/** Price screen: caption + the three tier prices (white on black; tinted by the material). */
function drawForgePanel(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.95;
  ctx.textAlign = 'left';
  ctx.font = `800 ${Math.round(h * 0.42)}px ${HOLOGRAM.fontDisplay}`;
  ctx.fillText(M.panelCaption, w * 0.04, h * 0.52);
  const captionW = ctx.measureText(M.panelCaption).width;
  const x0 = w * 0.04 + captionW + w * 0.04;
  ctx.globalAlpha = 0.45;
  ctx.fillRect(x0 - w * 0.02, h * 0.2, Math.max(2, w * 0.004), h * 0.6);
  ctx.globalAlpha = 0.9;
  const n = FORGE.tierCosts.length;
  const span = (w * 0.97 - x0) / n;
  for (let i = 0; i < n; i++) {
    const cx = x0 + span * (i + 0.5);
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(h * 0.2)}px ${HOLOGRAM.fontMono}`;
    ctx.fillText(FORGE.tierLabels[i] ?? '', cx, h * 0.3);
    ctx.font = `700 ${Math.round(h * 0.34)}px ${HOLOGRAM.fontDisplay}`;
    ctx.fillText(Math.round(FORGE.tierCosts[i] ?? 0).toLocaleString('de-DE'), cx, h * 0.68);
  }
  // Frame.
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(2, h * 0.03);
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
}
