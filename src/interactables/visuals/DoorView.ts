/**
 * Door visuals: two sliding leaves (service door: paneled leaves with hazard edges and a glowing
 * status bar; blast door: thick armored leaves with a hazard band and two locking bolts across the
 * seam), and a holographic price panel in front of each face. Opening (hydraulic): the bolts
 * retract and the leaves pop apart (unseal), then slide into the wall pockets with an ease-in-out;
 * the status glow flips from amber to green and the price panels fade. Leaves are hidden once
 * fully open (they sit inside the walls).
 *
 * Local frame: origin at the slot (floor center of the passage), +Z = zoneA → zoneB, X across.
 */
import { Group, Mesh, PlaneGeometry, type MeshStandardMaterial } from 'three';
import { clamp01, smoothstep } from '../../core/math';
import { DOORS } from '../../defs/interactables';
import type { DoorSlotDef } from '../../maps/types';
import type { DoorState, DoorViewApi } from '../Door';
import { doorLeafThickness } from '../shapes';
import { createCanvasSurface, drawDoorPanel, redraw, type CanvasSurface } from './canvas';
import { createGlowMaterial, type VisualContext } from './context';
import { createHoloMaterial, toVolumetricLayer, type HoloMaterial } from './holo';
import { PartBuilder } from './parts';

const BODY = 'body';
const TRIM = 'trim';
const HAZARD = 'hazard';
const GLOW = 'glow';

/** Kick plate height (m) and the gap of the glow strips in front of the leaf faces (m). */
const KICK_HEIGHT = 0.24;
const GLOW_PROUD = 0.004;
const RIB_INSET = 0.05;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export class DoorView implements DoorViewApi {
  readonly group = new Group();
  private readonly leaves: [Group, Group] = [new Group(), new Group()];
  private readonly bolts: Group | null = null;
  private readonly glow: MeshStandardMaterial;
  private readonly panelMat: HoloMaterial;
  private readonly panels: Mesh[] = [];
  private readonly surface: CanvasSurface | null;
  private readonly slideDistance: number;
  private readonly unseal: number;
  private state: DoorState = 'closed';
  private stateTime = 0;
  private open = 0;
  private disposed = false;

  constructor(
    private readonly slot: DoorSlotDef,
    price: number,
    private readonly ctx: VisualContext,
  ) {
    const g = this.group;
    g.name = `door:${slot.id}`;
    g.position.copy(slot.position);
    g.rotation.y = slot.yaw;
    ctx.root.add(g);

    const w = slot.width;
    const h = slot.height;
    const t = doorLeafThickness(slot);
    const blast = slot.blast;
    const lw = w / 2 + DOORS.leafOverlap / 2;
    this.slideDistance = w / 2 + DOORS.slideExtra;
    this.unseal = DOORS.unsealFraction;
    this.glow = createGlowMaterial(ctx, DOORS.lockedColor, DOORS.emissiveIntensity, `door-glow:${slot.id}`);

    const mats = ctx.materials;
    const body = mats.get(blast ? DOORS.blast.body : DOORS.service.body);
    const trim = mats.get(DOORS.trimMaterial);
    const hazard = mats.get(DOORS.hazardMaterial);

    for (let side = 0; side < 2; side++) {
      const leaf = this.leaves[side]!;
      leaf.name = side === 0 ? 'leaf-left' : 'leaf-right';
      g.add(leaf);
      const s = side === 0 ? -1 : 1; // outward direction across
      const b = new PartBuilder();
      buildLeaf(b, s, lw, h, t, blast);
      // Only the leaf body casts shadows (thin trims add shadow draws, not shape).
      b.mesh(BODY, body, leaf, true);
      b.mesh(TRIM, trim, leaf, false);
      b.mesh(HAZARD, hazard, leaf, false);
      b.mesh(GLOW, this.glow, leaf, false);
      b.dispose();
    }

    if (blast) {
      // Locking bolts across the seam, carried by the right leaf; they retract into it first.
      const bolts = new Group();
      bolts.name = 'bolts';
      const B = DOORS.bolts;
      const pb = new PartBuilder();
      for (const fy of B.y) {
        for (const face of [-1, 1]) {
          pb.box(TRIM, 0, fy * h, face * (t / 2 + B.proud / 2), B.width, B.height, B.proud);
          pb.box(
            GLOW,
            0,
            fy * h,
            face * (t / 2 + B.proud + GLOW_PROUD / 2),
            B.width * 0.7,
            B.height * 0.18,
            GLOW_PROUD,
          );
        }
      }
      pb.mesh(TRIM, trim, bolts, false);
      pb.mesh(GLOW, this.glow, bolts, false);
      pb.dispose();
      this.leaves[1].add(bolts);
      this.bolts = bolts;
    }

    // Holographic price panels, one in front of each face.
    const P = DOORS.panel;
    this.surface = createCanvasSurface(P.canvas[0], P.canvas[1]);
    redraw(this.surface, (c, cw, ch) =>
      drawDoorPanel(c, cw, ch, price, blast ? DOORS.caption.blast : DOORS.caption.service),
    );
    this.panelMat = createHoloMaterial({
      color: P.color,
      intensity: P.intensity,
      time: ctx.time,
      map: this.surface?.texture ?? null,
      panel: true,
      reduceFlashing: ctx.reduceFlashing,
      seed: hashSeed(slot.id),
    });
    const geo = new PlaneGeometry(P.width, P.height);
    for (const face of [-1, 1]) {
      const m = toVolumetricLayer(new Mesh(geo, this.panelMat));
      m.name = 'door-panel';
      m.position.set(0, P.y, face * (slot.depth / 2 + P.offset));
      // Plane normal +Z: the zone B panel faces +Z, the zone A panel is turned around.
      if (face < 0) m.rotation.y = Math.PI;
      g.add(m);
      this.panels.push(m);
    }
    g.updateMatrixWorld(true);
    this.setOpenAmount(0);
  }

  setOpenAmount(t: number): void {
    this.open = clamp01(t);
    const u = this.open;
    const k = this.unseal > 0 ? clamp01(u / this.unseal) : 1;
    const pop = DOORS.unsealPop * smoothstep(0, 1, k);
    const slide =
      u <= this.unseal ? 0 : easeInOutCubic(clamp01((u - this.unseal) / Math.max(1e-3, 1 - this.unseal)));
    const x = pop + slide * this.slideDistance;
    this.leaves[0].position.x = -x;
    this.leaves[1].position.x = x;
    if (this.bolts) this.bolts.position.x = DOORS.bolts.travel * smoothstep(0, 1, k);
    const visible = u < 1;
    this.leaves[0].visible = visible;
    this.leaves[1].visible = visible;
    const fade = 1 - clamp01(u / Math.max(1e-3, DOORS.panel.fadeOut));
    this.panelMat.uniforms.uFade.value = fade;
    for (const p of this.panels) p.visible = fade > 0;
  }

  setState(state: DoorState): void {
    this.state = state;
    this.stateTime = 0;
    const c = state === 'closed' ? DOORS.lockedColor : DOORS.unlockedColor;
    this.glow.emissive.setRGB(c[0], c[1], c[2]);
    this.glow.emissiveIntensity = DOORS.emissiveIntensity;
  }

  update(dt: number, time: number): void {
    if (this.disposed) return;
    this.stateTime += dt;
    if (this.state === 'closed') {
      // Slow "locked" breathing (calmer with reduced flashing).
      const depth = DOORS.breatheDepth * (this.ctx.reduceFlashing ? DOORS.reducedBreatheScale : 1);
      const b = 0.5 + 0.5 * Math.sin(time * DOORS.breatheRate * Math.PI * 2 + this.slot.position.x);
      this.glow.emissiveIntensity = DOORS.emissiveIntensity * (1 - depth * b);
    } else {
      // Green flash on unlock that settles.
      this.glow.emissiveIntensity =
        DOORS.emissiveIntensity * (1 + Math.exp(-this.stateTime * DOORS.unlockFlashDecay));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.glow.dispose();
    this.panelMat.dispose();
    this.surface?.texture.dispose();
  }
}

/**
 * One leaf in leaf space: the seam at x = 0, the leaf extends towards `s` (−1 left, +1 right)
 * over `lw`; thickness `t` centered on z = 0.
 */
function buildLeaf(b: PartBuilder, s: number, lw: number, h: number, t: number, blast: boolean): void {
  const D = DOORS;
  const x = (a: number, bb: number): [number, number] => (s > 0 ? [a, bb] : [-bb, -a]);
  const proud = D.trimProud;
  const tp = t + proud * 2;
  // Body.
  {
    const [x0, x1] = x(0, lw);
    b.boxMinMax(BODY, x0, KICK_HEIGHT, -t / 2, x1, h - D.trimWidth, t / 2);
  }
  // Outer edge trim + top trim.
  {
    const [x0, x1] = x(lw - D.trimWidth, lw);
    b.boxMinMax(TRIM, x0, 0, -tp / 2, x1, h, tp / 2);
    const [y0, y1] = x(0, lw);
    b.boxMinMax(TRIM, y0, h - D.trimWidth, -tp / 2, y1, h, tp / 2);
  }
  // Kick plate (hazard stripes) and the hazard strip along the meeting edge.
  {
    const [x0, x1] = x(0, lw - D.trimWidth);
    b.boxMinMax(HAZARD, x0, 0, -tp / 2, x1, KICK_HEIGHT, tp / 2);
    const [e0, e1] = x(0, D.hazardWidth);
    b.boxMinMax(HAZARD, e0, KICK_HEIGHT, -tp / 2, e1, h - D.trimWidth, tp / 2);
  }
  // Horizontal ribs.
  for (const fy of D.ribs) {
    const [x0, x1] = x(D.hazardWidth + RIB_INSET, lw - D.trimWidth - RIB_INSET);
    const y = fy * h;
    b.boxMinMax(
      TRIM,
      x0,
      y - D.ribHeight / 2,
      -t / 2 - proud * 0.6,
      x1,
      y + D.ribHeight / 2,
      t / 2 + proud * 0.6,
    );
  }
  if (blast) {
    const [x0, x1] = x(D.hazardWidth, lw - D.trimWidth);
    const y0 = D.blastBand.y * h;
    b.boxMinMax(HAZARD, x0, y0, -tp / 2, x1, y0 + D.blastBand.height * h, tp / 2);
  }
  // Glow: status bar on both faces and the seam light next to the hazard edge.
  const SB = D.statusBar;
  const barW = (lw - D.hazardWidth - D.trimWidth) * SB.width;
  const barC = D.hazardWidth + (lw - D.hazardWidth - D.trimWidth) / 2;
  const seamH = h * D.seam.height;
  for (const face of [-1, 1]) {
    const z = face * (tp / 2 + GLOW_PROUD / 2);
    const [b0, b1] = x(barC - barW / 2, barC + barW / 2);
    b.boxMinMax(
      GLOW,
      b0,
      SB.y - SB.height / 2,
      z - GLOW_PROUD / 2,
      b1,
      SB.y + SB.height / 2,
      z + GLOW_PROUD / 2,
    );
    const [s0, s1] = x(D.hazardWidth, D.hazardWidth + D.seam.width);
    b.boxMinMax(GLOW, s0, (h - seamH) / 2, z - GLOW_PROUD / 2, s1, (h + seamH) / 2, z + GLOW_PROUD / 2);
  }
}

/** Stable 0..1 seed from an id (holo flicker desync). */
export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}
