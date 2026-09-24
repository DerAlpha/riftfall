/**
 * Perk machine: a tall neon vending cabinet in the perk's color – dark paneled body on a hazard
 * plinth, a trim crown and bezel, neon tubes along the front edges and the crown, a backlit logo
 * panel (the perk glyph as neon strokes, name, tagline, price), a dispenser slot, and a soft floor
 * glow in the perk color (fake light spill – no real light is added). The neon hums: value-noise
 * flicker with rare dropouts (calm with reduced flashing); owned / unavailable machines glow steady
 * and dim; a purchase flares.
 *
 * Local frame: origin at the floor center of the cabinet, +Z = front.
 */
import { Group, Mesh, MeshStandardMaterial, PlaneGeometry, type Texture } from 'three';
import { noise1D } from '../../core/math';
import { PERK_MACHINES } from '../../defs/interactables';
import type { PerkAvailability, PerkMachineViewApi } from '../PerkMachine';
import type { PerkMachineInfo } from '../types';
import { createCanvasSurface, drawPerkLogo, formatPerkPrice, redraw, type CanvasSurface } from './canvas';
import { createGlowMaterial, srgbHexToLinear, type VisualContext } from './context';
import { hashSeed } from './DoorView';
import { createLightPool, type PoolMaterial } from './holo';
import { PartBuilder } from './parts';

/** Cabinet proportions (m): plinth height, front inset of the body, crown overhang, fin size. */
const PLINTH = 0.14;
const FRONT_INSET = 0.05;
const CROWN_OVERHANG = 0.03;
const FIN = 0.07;
const BEZEL = 0.045;
const NEON_SEGMENTS = 10;
const LOGO_GAP = 0.002;

export class PerkMachineView implements PerkMachineViewApi {
  readonly group = new Group();
  private readonly neon: MeshStandardMaterial;
  private readonly logoMat: MeshStandardMaterial;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial>;
  private readonly surface: CanvasSurface | null;
  private readonly seed: number;
  private availability: PerkAvailability = 'available';
  private flashAmount = 0;
  private disposed = false;

  constructor(
    private readonly perk: PerkMachineInfo,
    private readonly price: number,
    center: { x: number; y: number; z: number },
    yaw: number,
    private readonly ctx: VisualContext,
  ) {
    const P = PERK_MACHINES;
    const { width: w, height: h, depth: d } = P.size;
    const g = this.group;
    g.name = `perk:${perk.id}`;
    g.position.set(center.x, center.y, center.z);
    g.rotation.y = yaw;
    ctx.root.add(g);
    this.seed = hashSeed(perk.id);
    const color = srgbHexToLinear(perk.color);
    this.neon = createGlowMaterial(ctx, color, P.neon.intensity, `perk-neon:${perk.id}`);

    const crown = P.neon.crownHeight;
    const front = d / 2;
    const pb = new PartBuilder();
    // Plinth (hazard kick plate), body, crown.
    pb.boxMinMax('hazard', -w / 2 + 0.02, 0, -d / 2 + 0.02, w / 2 - 0.02, PLINTH, front - 0.02);
    pb.boxMinMax('body', -w / 2, PLINTH, -d / 2, w / 2, h - crown, front - FRONT_INSET);
    pb.boxMinMax(
      'trim',
      -w / 2 - CROWN_OVERHANG,
      h - crown,
      -d / 2,
      w / 2 + CROWN_OVERHANG,
      h,
      front + CROWN_OVERHANG,
    );
    // Front fins (the neon tubes run in front of them).
    for (const s of [-1, 1]) {
      pb.boxMinMax(
        'trim',
        s * (w / 2) - (s > 0 ? FIN : 0),
        PLINTH,
        front - FRONT_INSET,
        s * (w / 2) + (s < 0 ? FIN : 0),
        h - crown,
        front,
      );
    }
    // Logo bezel.
    const L = P.logo;
    const lw = w * L.width;
    const lh = L.height;
    const lz = front - FRONT_INSET;
    for (const s of [-1, 1]) {
      pb.box('trim', (s * (lw + BEZEL)) / 2, L.y, lz + BEZEL / 2, BEZEL, lh + BEZEL * 2, BEZEL);
      pb.box('trim', 0, L.y + (s * (lh + BEZEL)) / 2, lz + BEZEL / 2, lw, BEZEL, BEZEL);
    }
    // Dispenser slot: a dark recess box with a glowing lip.
    const D = P.dispenser;
    pb.box('trim', 0, D.y, lz + D.depth / 2, w * D.width, D.height, D.depth);
    pb.box('neon', 0, D.y + D.height / 2 - 0.01, lz + D.depth + 0.004, w * D.width * 0.86, 0.018, 0.008);
    // Neon tubes: front edges and the crown.
    const r = P.neon.radius;
    const tubeH = h - crown - PLINTH - 0.08;
    for (const s of [-1, 1]) {
      pb.cylinder(
        'neon',
        s * (w / 2 - FIN / 2),
        PLINTH + 0.04 + tubeH / 2,
        front + r,
        r,
        tubeH,
        'y',
        NEON_SEGMENTS,
      );
    }
    pb.cylinder('neon', 0, h - crown / 2, front + CROWN_OVERHANG + r, r, w, 'x', NEON_SEGMENTS);
    const mats = ctx.materials;
    // Cabinets stand against walls: only the body casts (sixteen machines × every cascade adds up).
    pb.mesh('hazard', mats.get(P.materials.hazard), g, false);
    pb.mesh('body', mats.get(P.materials.body), g, P.castShadow);
    pb.mesh('trim', mats.get(P.materials.trim), g, false);
    pb.mesh('neon', this.neon, g, false);
    pb.dispose();

    // Backlit logo panel.
    this.surface = createCanvasSurface(L.canvas[0], L.canvas[1], true);
    const map: Texture | null = this.surface?.texture ?? null;
    this.logoMat = new MeshStandardMaterial({
      name: `perk-logo:${perk.id}`,
      color: 0x0a0c10,
      roughness: 0.25,
      metalness: 0,
      map,
      emissive: 0xffffff,
      emissiveMap: map,
      emissiveIntensity: map ? L.intensity : 0,
    });
    ctx.setupMaterial(this.logoMat);
    const logo = new Mesh(new PlaneGeometry(lw, lh), this.logoMat);
    logo.name = 'perk-logo';
    logo.position.set(0, L.y, lz + LOGO_GAP);
    logo.receiveShadow = true;
    logo.userData.navIgnore = true;
    g.add(logo);

    // Floor glow in front.
    const G = P.glowPool;
    this.pool = createLightPool(color, G.intensity, G.radius);
    this.pool.position.z = front + G.forward;
    g.add(this.pool);
    g.updateMatrixWorld(true);
    this.drawLogo();
  }

  setAvailability(a: PerkAvailability): void {
    this.availability = a;
    this.drawLogo();
  }

  flash(): void {
    this.flashAmount = 1;
  }

  update(dt: number, time: number): void {
    if (this.disposed) return;
    const P = PERK_MACHINES;
    const F = P.flicker;
    let k: number;
    if (this.availability !== 'available') {
      k = P.ownedIntensity;
    } else {
      const depth = this.ctx.reduceFlashing ? F.reducedDepth : F.depth;
      const n = 0.5 + 0.5 * noise1D(time * F.rate, this.seed * 97);
      k = 1 - depth * n;
      // Rare dropouts: a failing starter (never with reduced flashing).
      if (!this.ctx.reduceFlashing) {
        const slot = Math.floor(time * F.rate * 4);
        const r = noise1D(slot * 0.731 + 0.5, this.seed * 13) * 0.5 + 0.5;
        if (r < F.dropoutChance) k *= 0.25;
      }
    }
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * P.flashDecay);
    const boost = 1 + this.flashAmount * (P.flashPeak - 1);
    this.neon.emissiveIntensity = P.neon.intensity * k * boost;
    this.pool.material.uniforms.uIntensity.value = P.glowPool.intensity * k * boost;
    this.logoMat.emissiveIntensity = (this.surface ? P.logo.intensity : 0) * (0.85 + 0.15 * k) * boost;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.neon.dispose();
    this.logoMat.dispose();
    this.pool.material.dispose();
    this.surface?.texture.dispose();
  }

  private drawLogo(): void {
    const P = PERK_MACHINES;
    const line =
      this.availability === 'owned'
        ? P.logoText.owned
        : this.availability === 'limit'
          ? P.prompts.limit.toUpperCase()
          : formatPerkPrice(this.price);
    redraw(this.surface, (c, w, h) => drawPerkLogo(c, w, h, this.perk, line, this.availability === 'limit'));
  }
}
