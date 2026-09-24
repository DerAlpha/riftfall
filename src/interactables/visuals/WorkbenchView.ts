/**
 * The Werkbank: a heavy workbench with a diamond-plate top, a drawer cabinet, a lower shelf and a
 * tool board behind it (tool silhouettes, a vise, parts bins), a lamp bar over the top, a status
 * screen and a weapon projector: while the bench menu is open the weapon in hand turns slowly as
 * a hologram above the projector disc. Accents breathe; a purchase flashes lamp, projector and
 * hologram. A soft floor glow in front. Only uniforms / transforms change per frame.
 *
 * Local frame: origin at the floor center of the bench, +Z = front.
 */
import { Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry, type Object3D, type Vector3 } from 'three';
import { clamp01 } from '../../core/math';
import { HOLOGRAM } from '../../defs/interactables';
import { WORKBENCH } from '../../defs/workshop';
import type { WorkbenchViewApi } from '../Workbench';
import { createCanvasSurface, redraw, type CanvasSurface } from './canvas';
import { createGlowMaterial, type VisualContext } from './context';
import {
  createHoloMaterial,
  createLightPool,
  toVolumetricLayer,
  type HoloMaterial,
  type PoolMaterial,
} from './holo';
import { PartBuilder } from './parts';

const B = WORKBENCH;
const L = B.layout;
const DISC_SEGMENTS = 28;
/** Hologram fade in / out rate (1/s). */
const HOLO_RATE = 4;

export class WorkbenchView implements WorkbenchViewApi {
  readonly group = new Group();
  private readonly lamp: MeshStandardMaterial;
  private readonly accent: MeshStandardMaterial;
  private readonly screenMat: MeshStandardMaterial;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial>;
  private readonly holo: Mesh;
  private readonly holoMat: HoloMaterial;
  private readonly surface: CanvasSurface | null;
  private readonly holoY: number;
  private weapon: string | null = null;
  private open = false;
  private holoLevel = 0;
  private flashAmount = 0;
  private disposed = false;

  constructor(
    private readonly ctx: VisualContext,
    center: Vector3,
    yaw: number,
  ) {
    const g = this.group;
    g.name = 'workbench';
    g.position.copy(center);
    g.rotation.y = yaw;
    ctx.root.add(g);
    this.lamp = createGlowMaterial(ctx, B.lampColor, B.lampIntensity, 'bench-lamp');
    this.accent = createGlowMaterial(ctx, B.accentColor, B.accentIntensity, 'bench-accent');

    const { width: w, depth: d } = B.size;
    const T = L.top;
    const topY = T.y;
    const back = -d / 2;
    const front = d / 2;
    const pb = new PartBuilder();

    // --- table: top slab, legs, lower shelf, drawer cabinet (right), kick plate ---
    pb.boxMinMax('top', -w / 2, topY - T.thickness, back + 0.04, w / 2, topY, front);
    pb.boxMinMax(
      'trim',
      -w / 2 - 0.01,
      topY - T.thickness - 0.02,
      front - 0.03,
      w / 2 + 0.01,
      topY - T.thickness + 0.01,
      front + 0.01,
    );
    const lg = L.leg;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (w / 2 - lg / 2 - 0.02);
        const z = sz * (d / 2 - lg / 2 - 0.05);
        pb.box('body', x, (topY - T.thickness) / 2, z, lg, topY - T.thickness, lg);
      }
    }
    pb.boxMinMax('body', -w / 2 + 0.05, L.shelf - 0.03, back + 0.1, w / 2 - 0.05, L.shelf, front - 0.08);
    const cw = L.cabinet.width;
    const cx0 = w / 2 - 0.04 - cw;
    pb.boxMinMax('body', cx0, 0.06, back + 0.08, w / 2 - 0.04, topY - T.thickness, front - 0.03);
    for (let i = 0; i < 3; i++) {
      const y0 = 0.14 + i * 0.25;
      pb.boxMinMax('trim', cx0 + 0.03, y0, front - 0.03, w / 2 - 0.07, y0 + 0.2, front - 0.01);
      pb.box('accent', cx0 + cw / 2 - 0.02, y0 + 0.16, front + 0.001, 0.14, 0.012, 0.012);
    }
    pb.boxMinMax('hazard', -w / 2, 0, front - 0.1, w / 2, 0.06, front - 0.05);

    // --- tool board with tools, lamp bar, parts bins ---
    const Bd = L.board;
    const by0 = topY + Bd.lift;
    const by1 = by0 + Bd.height;
    pb.boxMinMax('board', -w / 2, topY, back, w / 2, by1, back + Bd.depth);
    pb.boxMinMax('trim', -w / 2 - 0.03, by1, back - 0.01, w / 2 + 0.03, by1 + 0.06, back + Bd.depth + 0.04);
    for (const s of [-1, 1])
      pb.boxMinMax(
        'trim',
        (s * w) / 2 - 0.035,
        topY,
        back - 0.01,
        (s * w) / 2 + 0.035,
        by1,
        back + Bd.depth + 0.03,
      );
    const tz = back + Bd.depth + 0.012;
    // Wrench, screwdriver, hammer and pliers silhouettes on the left half.
    const tools: readonly (readonly [number, number, number, number])[] = [
      [-0.72, 0.62, 0.035, 0.34],
      [-0.72, 0.84, 0.09, 0.05],
      [-0.56, 0.6, 0.022, 0.3],
      [-0.56, 0.78, 0.04, 0.09],
      [-0.4, 0.58, 0.03, 0.32],
      [-0.4, 0.76, 0.14, 0.06],
      [-0.23, 0.62, 0.022, 0.28],
      [-0.19, 0.62, 0.022, 0.28],
      [-0.21, 0.8, 0.07, 0.07],
    ];
    for (const [x, y, sx, sy] of tools) pb.box('trim', x, by0 + y - Bd.lift, tz, sx, sy, 0.02);
    // Peg rail and a row of accent-lit parts bins on the board.
    pb.boxMinMax('trim', -w / 2 + 0.08, by0 + 0.2, tz - 0.01, w / 2 - 0.08, by0 + 0.23, tz + 0.02);
    for (let i = 0; i < 4; i++) {
      const x = -0.1 + i * 0.16;
      pb.boxMinMax('hazard', x - 0.065, by0 + 0.02, tz, x + 0.065, by0 + 0.14, tz + 0.12);
    }
    // Lamp bar reaching over the top.
    const Lp = L.lamp;
    pb.boxMinMax(
      'trim',
      -w / 2 + 0.05,
      by1 - 0.02,
      back + Bd.depth,
      w / 2 - 0.05,
      by1 + Lp.height,
      back + Bd.depth + Lp.depth,
    );
    pb.box('lamp', 0, by1 - 0.025, back + Bd.depth + Lp.depth * 0.55, w - 0.2, 0.012, Lp.depth * 0.5);
    // Vise on the left of the top.
    const vx = -w / 2 + 0.28;
    pb.box('trim', vx, topY + 0.05, front - 0.16, 0.2, 0.1, 0.16);
    pb.box('trim', vx, topY + 0.08, front - 0.03, 0.16, 0.08, 0.06);
    pb.cylinder('trim', vx, topY + 0.07, front + 0.05, 0.012, 0.12, 'z', 8);
    // Projector disc in the middle of the top.
    const P = L.projector;
    pb.cylinder('trim', 0.05, topY + 0.015, 0.02, P.radius + 0.03, 0.03, 'y', DISC_SEGMENTS);
    pb.cylinder('accent', 0.05, topY + 0.034, 0.02, P.radius, 0.008, 'y', DISC_SEGMENTS);
    // Accent strip along the top front edge.
    pb.box('accent', -0.2, topY - T.thickness - 0.012, front + 0.012, w * 0.5, 0.014, 0.01);

    const mats = this.ctx.materials;
    pb.mesh('body', mats.get(B.materials.body), g, true);
    pb.mesh('top', mats.get(B.materials.top), g, true);
    pb.mesh('trim', mats.get(B.materials.trim), g, false);
    pb.mesh('board', mats.get(B.materials.board), g, true);
    pb.mesh('hazard', mats.get(B.materials.hazard), g, false);
    pb.mesh('lamp', this.lamp, g, false);
    pb.mesh('accent', this.accent, g, false);
    pb.dispose();

    // --- status screen on the board (right side) ---
    const S = L.screen;
    this.surface = createCanvasSurface(S.canvas[0], S.canvas[1], true);
    const map = this.surface?.texture ?? null;
    const sc = B.screenColor;
    this.screenMat = new MeshStandardMaterial({
      name: 'bench-screen',
      color: 0x06080a,
      roughness: 0.3,
      metalness: 0,
      map,
      emissive: new Color(sc[0], sc[1], sc[2]),
      emissiveMap: map,
      emissiveIntensity: map ? B.screenIntensity : 0,
    });
    ctx.setupMaterial(this.screenMat);
    const screen = new Mesh(new PlaneGeometry(S.width, S.height), this.screenMat);
    screen.name = 'bench-screen';
    screen.position.set(w / 2 - S.width / 2 - 0.12, topY + S.y, back + Bd.depth + 0.004);
    screen.userData.navIgnore = true;
    g.add(screen);
    redraw(this.surface, drawBenchScreen);

    // --- weapon hologram over the projector ---
    const H = B.hologram;
    this.holoMat = createHoloMaterial({
      color: H.color,
      intensity: H.intensity,
      time: ctx.time,
      reduceFlashing: ctx.reduceFlashing,
      seed: 0.61,
    });
    this.holoMat.uniforms.uFade.value = 0;
    this.holo = toVolumetricLayer(new Mesh(ctx.holograms.get('rifle'), this.holoMat));
    this.holo.name = 'bench-hologram';
    this.holoY = topY + P.lift;
    this.holo.position.set(0.05, this.holoY, 0.02);
    this.holo.scale.setScalar(P.holoLength);
    this.holo.visible = false;
    g.add(this.holo);

    // --- floor glow ---
    const G = B.glowPool;
    this.pool = createLightPool(G.color, G.intensity, G.radius);
    this.pool.position.z = front + G.forward;
    g.add(this.pool);
    g.updateMatrixWorld(true);
  }

  setWeapon(weaponId: string | null): void {
    if (weaponId === this.weapon) return;
    this.weapon = weaponId;
    if (!weaponId) return;
    this.holo.geometry = this.ctx.holograms.get(weaponId);
    const P = L.projector;
    this.holo.scale.setScalar(
      this.ctx.holograms.displayLength(weaponId, 1, P.holoLength * 0.55, P.holoLength),
    );
  }

  setOpen(open: boolean): void {
    this.open = open;
  }

  flash(): void {
    this.flashAmount = 1;
    this.holoMat.uniforms.uFlash.value = 1;
  }

  update(dt: number, time: number): void {
    if (this.disposed) return;
    const target = this.open && this.weapon !== null ? 1 : 0;
    this.holoLevel = clamp01(this.holoLevel + Math.sign(target - this.holoLevel) * HOLO_RATE * dt);
    this.flashAmount = Math.max(0, this.flashAmount - dt * B.flash.decay);
    const f = this.flashAmount * (this.ctx.reduceFlashing ? 0.4 : 1);
    const boost = 1 + f * (B.flash.peak - 1);
    const pulse = 1 + B.pulse.depth * Math.sin(time * B.pulse.rate);
    const active = 0.7 + 0.3 * this.holoLevel;
    this.lamp.emissiveIntensity = B.lampIntensity * boost;
    this.accent.emissiveIntensity = B.accentIntensity * pulse * active * boost;
    this.screenMat.emissiveIntensity = (this.surface ? B.screenIntensity : 0) * active * boost;
    this.pool.material.uniforms.uIntensity.value = B.glowPool.intensity * active * boost;
    const hu = this.holoMat.uniforms;
    hu.uFade.value = this.holoLevel;
    hu.uFlash.value = Math.max(0, hu.uFlash.value - dt * B.flash.decay);
    this.holo.visible = this.holoLevel > 0.001;
    if (this.holo.visible) {
      this.holo.rotation.y = time * B.hologram.spinRate;
      this.holo.position.y = this.holoY + Math.sin(time * 1.7) * B.hologram.bob;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.isMesh && m !== this.holo) m.geometry.dispose();
    });
    this.lamp.dispose();
    this.accent.dispose();
    this.screenMat.dispose();
    this.holoMat.dispose();
    this.pool.material.dispose();
    this.surface?.texture.dispose();
  }
}

/** Status screen: caption, two lines and slot pips (white on black; tinted by the material). */
function drawBenchScreen(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.95;
  ctx.font = `800 ${Math.round(h * 0.2)}px ${HOLOGRAM.fontDisplay}`;
  ctx.fillText(B.screenCaption, w * 0.08, h * 0.2);
  ctx.globalAlpha = 0.5;
  ctx.fillRect(w * 0.08, h * 0.33, w * 0.84, Math.max(2, h * 0.012));
  ctx.globalAlpha = 0.8;
  ctx.font = `600 ${Math.round(h * 0.11)}px ${HOLOGRAM.fontMono}`;
  B.screenLines.forEach((line, i) => ctx.fillText(line, w * 0.08, h * (0.46 + i * 0.15)));
  // Six slot pips (optic, muzzle, magazine, underbarrel, stock, laser).
  const n = 6;
  const pw = (w * 0.84) / n;
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.35 + 0.1 * (i % 2);
    ctx.fillRect(w * 0.08 + i * pw + pw * 0.1, h * 0.8, pw * 0.8, h * 0.08);
  }
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(2, h * 0.02);
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
}
