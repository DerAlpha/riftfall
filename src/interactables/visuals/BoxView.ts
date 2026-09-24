/**
 * The Rift-Kiste: a heavy dark chest on a hazard plinth with armored corners, rift energy leaking
 * from its seams (violet emissive, pulsing), a holographic "?" rift emblem on the front and a
 * hinged lid. Over the active location a violet light beam rises to the ceiling and a soft glow
 * pools on the floor.
 *
 * Driven by MysteryBox (readout per frame): the lid opens for a roll, the weapon hologram rises
 * and cycles (geometry swapped per display step – no allocation), turns cyan on the result and
 * sinks back when the offer lapses; the anomaly shows a red torn-eye hologram; leaving sinks the
 * chest into the floor under a flaring beam, arriving raises it at the new location.
 *
 * Local frame: origin at the floor center of the box, +Z = front, lid hinge at the back top edge.
 */
import { CylinderGeometry, Group, Mesh, PlaneGeometry, type MeshStandardMaterial } from 'three';
import { clamp01, lerp, smoothstep } from '../../core/math';
import { HOLOGRAM, MYSTERY_BOX } from '../../defs/interactables';
import type { BoxLocation, BoxState, MysteryBoxReadout, MysteryBoxViewApi } from '../MysteryBox';
import { createCanvasSurface, drawAnomaly, drawBoxEmblem, redraw, type CanvasSurface } from './canvas';
import { createGlowMaterial, type VisualContext } from './context';
import {
  createBeamMaterial,
  createHoloMaterial,
  createLightPool,
  toVolumetricLayer,
  type BeamMaterial,
  type HoloMaterial,
  type PoolMaterial,
} from './holo';
import { PartBuilder } from './parts';

const B = MYSTERY_BOX;
const CORNER = 0.09;
const SEAM = 0.014;
const SEAM_PROUD = 0.004;
const BEAM_SEGMENTS = 28;
/** Rise / sink of the hologram (s) and how far below the rim it sinks. */
const HOLO_RISE_TIME = 0.35;
const HOLO_SINK = 0.35;

export class BoxView implements MysteryBoxViewApi {
  readonly group = new Group();
  private readonly chest = new Group();
  private readonly lid = new Group();
  private readonly rift: MeshStandardMaterial;
  private readonly holo: Mesh;
  private readonly holoMat: HoloMaterial;
  private readonly anomaly: Mesh;
  private readonly anomalyMat: HoloMaterial;
  private readonly emblemMat: HoloMaterial;
  private readonly interiorMat: PoolMaterial;
  private readonly interior: Mesh;
  private readonly beam: Mesh;
  private readonly beamMat: BeamMaterial;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial>;
  private readonly surfaces: CanvasSurface[] = [];
  private lidAmount = 0;
  private holoLift = 0;
  private shownWeapon: string | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: VisualContext,
    anomalyLabel: string,
  ) {
    const S = B.size;
    const { width: w, depth: d } = S;
    const h = S.height;
    const g = this.group;
    g.name = 'rift-box';
    ctx.root.add(g);
    g.add(this.chest);
    this.rift = createGlowMaterial(ctx, B.riftColor, B.riftIntensity, 'box-rift');
    const mats = ctx.materials;

    // --- chest ---
    const pb = new PartBuilder();
    pb.boxMinMax('hazard', -w / 2 - 0.03, 0, -d / 2 - 0.03, w / 2 + 0.03, S.baseHeight, d / 2 + 0.03);
    pb.boxMinMax('body', -w / 2, S.baseHeight, -d / 2, w / 2, h, d / 2);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (w / 2 - CORNER / 2 + 0.01);
        const z = sz * (d / 2 - CORNER / 2 + 0.01);
        pb.box('trim', x, (S.baseHeight + h) / 2, z, CORNER, h - S.baseHeight, CORNER);
      }
    }
    // Band under the lid and a mid rib.
    pb.boxMinMax('trim', -w / 2 - 0.012, h - 0.06, -d / 2 - 0.012, w / 2 + 0.012, h - 0.01, d / 2 + 0.012);
    pb.boxMinMax(
      'trim',
      -w / 2 - 0.008,
      S.baseHeight + 0.14,
      -d / 2 - 0.008,
      w / 2 + 0.008,
      S.baseHeight + 0.18,
      d / 2 + 0.008,
    );
    // Rift seams: a circuit of cracks on the front and the sides, and the glowing lid gap.
    const fz = d / 2 + SEAM_PROUD / 2;
    const seams: readonly (readonly [number, number, number, number])[] = [
      // [x0, x1, y0, y1] on the front face (fractions of w / absolute y)
      [-0.44, -0.3, 0.3, 0.3 + SEAM],
      [-0.3, -0.3 + SEAM / w, 0.3, 0.46],
      [0.3 - SEAM / w, 0.3, 0.26, 0.44],
      [0.3, 0.44, 0.26, 0.26 + SEAM],
    ];
    for (const [x0, x1, y0, y1] of seams) {
      pb.boxMinMax('rift', x0 * w, y0, fz - SEAM_PROUD / 2, x1 * w, y1, fz + SEAM_PROUD / 2);
    }
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 + SEAM_PROUD / 2);
      pb.boxMinMax('rift', x - SEAM_PROUD / 2, 0.24, -0.12, x + SEAM_PROUD / 2, 0.24 + SEAM, 0.18);
      pb.boxMinMax('rift', x - SEAM_PROUD / 2, 0.24, 0.18 - SEAM, x + SEAM_PROUD / 2, 0.42, 0.18);
    }
    pb.boxMinMax('rift', -w / 2 - 0.004, h - 0.004, -d / 2 - 0.004, w / 2 + 0.004, h + 0.006, d / 2 + 0.004);
    pb.mesh('hazard', mats.get(B.materials.hazard), this.chest, false);
    pb.mesh('body', mats.get(B.materials.body), this.chest, true);
    pb.mesh('trim', mats.get(B.materials.trim), this.chest, false);
    pb.mesh('rift', this.rift, this.chest, false);
    pb.dispose();

    // --- lid (hinged at the back top edge) ---
    this.lid.position.set(0, h, -d / 2);
    this.chest.add(this.lid);
    const lb = new PartBuilder();
    const lh = S.lidHeight;
    lb.boxMinMax('body', -w / 2 - 0.01, 0, 0, w / 2 + 0.01, lh, d + 0.01);
    lb.boxMinMax('trim', -w / 2 - 0.02, 0, d - 0.03, w / 2 + 0.02, lh * 0.55, d + 0.025);
    lb.boxMinMax('trim', -w / 2 - 0.02, lh * 0.7, 0.04, -w / 2 + 0.07, lh + 0.01, d - 0.04);
    lb.boxMinMax('trim', w / 2 - 0.07, lh * 0.7, 0.04, w / 2 + 0.02, lh + 0.01, d - 0.04);
    // Rift glyph line across the lid top.
    lb.boxMinMax('rift', -w * 0.3, lh, d * 0.5 - SEAM / 2, w * 0.3, lh + SEAM_PROUD, d * 0.5 + SEAM / 2);
    lb.boxMinMax('rift', -SEAM / 2, lh, d * 0.2, SEAM / 2, lh + SEAM_PROUD, d * 0.8);
    lb.mesh('body', mats.get(B.materials.body), this.lid, true);
    lb.mesh('trim', mats.get(B.materials.trim), this.lid, false);
    lb.mesh('rift', this.rift, this.lid, false);
    lb.dispose();

    // --- emblem on the front ---
    const E = B.emblem;
    const emblemSurface = createCanvasSurface(E.canvas, E.canvas);
    redraw(emblemSurface, drawBoxEmblem);
    if (emblemSurface) this.surfaces.push(emblemSurface);
    this.emblemMat = createHoloMaterial({
      color: B.riftColor,
      intensity: B.hologram.intensity,
      time: ctx.time,
      map: emblemSurface?.texture ?? null,
      panel: true,
      reduceFlashing: ctx.reduceFlashing,
      seed: 0.31,
      frame: false,
    });
    const emblem = toVolumetricLayer(new Mesh(new PlaneGeometry(E.size, E.size), this.emblemMat));
    emblem.name = 'box-emblem';
    emblem.position.set(0, S.baseHeight + (h - S.baseHeight) * 0.52, d / 2 + 0.006);
    this.chest.add(emblem);

    // --- interior glow (visible through the open lid) ---
    const interior = createLightPool(B.riftColor, 0, Math.max(w, d) / 2);
    this.interiorMat = interior.material;
    interior.position.set(0, h - 0.03, 0);
    interior.scale.set(1, 1, d / w);
    this.interior = interior;
    this.chest.add(interior);

    // --- hologram (weapon) and the anomaly ---
    const H = B.hologram;
    this.holoMat = createHoloMaterial({
      color: H.color,
      intensity: H.intensity,
      time: ctx.time,
      reduceFlashing: ctx.reduceFlashing,
      seed: 0.77,
      doubleSided: true,
    });
    this.holo = toVolumetricLayer(new Mesh(ctx.holograms.get(B.pool[0]?.weapon ?? 'pistol'), this.holoMat));
    this.holo.name = 'box-hologram';
    this.holo.visible = false;
    this.chest.add(this.holo);

    const anomalySurface = createCanvasSurface(E.canvas * 2, E.canvas * 2);
    redraw(anomalySurface, (c, cw, ch) => drawAnomaly(c, cw, ch, anomalyLabel));
    if (anomalySurface) this.surfaces.push(anomalySurface);
    this.anomalyMat = createHoloMaterial({
      color: B.anomaly.color,
      intensity: B.anomaly.intensity,
      time: ctx.time,
      map: anomalySurface?.texture ?? null,
      panel: true,
      reduceFlashing: ctx.reduceFlashing,
      seed: 0.13,
      frame: false,
    });
    this.anomalyMat.uniforms.uGlitch.value = ctx.reduceFlashing ? 0 : B.anomaly.glitch;
    this.anomaly = toVolumetricLayer(
      new Mesh(new PlaneGeometry(B.anomaly.size, B.anomaly.size), this.anomalyMat),
    );
    this.anomaly.name = 'box-anomaly';
    this.anomaly.visible = false;
    this.chest.add(this.anomaly);

    // --- beam + floor glow (stay at the location while the chest sinks / rises) ---
    this.beamMat = createBeamMaterial(B.beam.color, B.beam.intensity, ctx.time);
    const beamGeo = new CylinderGeometry(B.beam.radius, B.beam.radius, 1, BEAM_SEGMENTS, 1, true);
    beamGeo.translate(0, 0.5, 0);
    this.beam = toVolumetricLayer(new Mesh(beamGeo, this.beamMat));
    this.beam.name = 'box-beam';
    this.beam.position.y = h;
    g.add(this.beam);
    const P = B.glowPool;
    this.pool = createLightPool(P.color, P.intensity, P.radius);
    g.add(this.pool);
  }

  placeAt(location: BoxLocation): void {
    const g = this.group;
    g.position.copy(location.position);
    g.rotation.y = location.yaw;
    const top = location.position.y + B.size.height;
    const ceiling = this.ctx.ceilingAbove?.(location.position.x, top, location.position.z) ?? null;
    const len = ceiling !== null ? Math.max(0.5, ceiling - top - B.beam.ceilingMargin) : B.beam.maxHeight;
    const height = Math.min(B.beam.maxHeight, len);
    this.beam.scale.set(1, height, 1);
    this.beamMat.uniforms.uHeight.value = height;
    g.updateMatrixWorld(true);
  }

  setState(_state: BoxState): void {
    // Everything is driven from the readout in update().
  }

  update(dt: number, time: number, box: MysteryBoxReadout): void {
    if (this.disposed) return;
    const s = box.state;
    const p = box.stateProgress;
    const H = B.hologram;

    // Lid.
    const lidOpen = s === 'rolling' || s === 'offering' || s === 'anomaly';
    const lidTarget = lidOpen ? 1 : 0;
    const step = dt * B.lidSpeed;
    this.lidAmount =
      lidTarget > this.lidAmount
        ? Math.min(lidTarget, this.lidAmount + step)
        : Math.max(lidTarget, this.lidAmount - step);
    this.lid.rotation.x = -B.lidOpenDeg * (Math.PI / 180) * smoothstep(0, 1, this.lidAmount);
    this.interiorMat.uniforms.uIntensity.value = this.lidAmount * B.interiorGlow;
    this.interior.visible = this.lidAmount > 0;

    // Chest sinking / rising on relocation.
    let sink = 0;
    if (s === 'leaving') sink = smoothstep(0.2, 1, p);
    else if (s === 'arriving') sink = 1 - smoothstep(0, 0.8, p);
    this.chest.position.y = -sink * (B.size.height + B.size.lidHeight + 0.05);
    this.chest.visible = sink < 0.999;

    // Rift pulse (faster while active).
    const active = s !== 'idle';
    const rate = B.riftPulseRate * (active ? 3 : 1);
    const depth = this.ctx.reduceFlashing ? B.riftPulseDepth * 0.4 : B.riftPulseDepth;
    this.rift.emissiveIntensity =
      B.riftIntensity * (1 - depth * (0.5 + 0.5 * Math.sin(time * rate * Math.PI * 2))) * (active ? 1.4 : 1);

    // Hologram.
    const weapon = box.displayWeapon;
    const showHolo = weapon !== null && (s === 'rolling' || s === 'offering' || s === 'closing');
    if (weapon !== null && weapon !== this.shownWeapon) {
      this.shownWeapon = weapon;
      this.holo.geometry = this.ctx.holograms.get(weapon);
      this.holo.scale.setScalar(this.ctx.holograms.displayLength(weapon, H.scale, H.minLength, H.maxLength));
    }
    const top = B.size.height;
    if (showHolo) {
      let target: number = H.rise;
      if (s === 'rolling') target = H.rise * smoothstep(0, HOLO_RISE_TIME, box.stateTime);
      else if (s === 'offering') {
        // The last seconds of the offer: sink back towards the rim.
        const left = B.offerDuration - box.stateTime;
        target = H.rise * smoothstep(0, H.sinkWarning, left);
      } else if (s === 'closing') target = -HOLO_SINK;
      this.holoLift = s === 'closing' ? lerp(this.holoLift, target, clamp01(dt * 8)) : target;
      this.holo.visible = true;
      this.holo.position.set(
        0,
        top + 0.12 + this.holoLift + Math.sin(time * H.bobRate * Math.PI * 2) * H.bobAmplitude,
        0,
      );
      this.holo.rotation.y =
        s === 'rolling' ? time * H.spinRate * Math.PI * 4 : Math.sin(time * H.spinRate) * 0.6;
      const c = s === 'rolling' ? H.color : H.resultColor;
      this.holoMat.uniforms.uColor.value.setRGB(c[0], c[1], c[2]);
      const warning = s === 'offering' && B.offerDuration - box.stateTime < H.sinkWarning;
      const reduce = this.ctx.reduceFlashing;
      this.holoMat.uniforms.uFlicker.value =
        warning && !reduce ? H.warningFlicker : reduce ? HOLOGRAM.reducedFlickerDepth : HOLOGRAM.flickerDepth;
      this.holoMat.uniforms.uFade.value = s === 'closing' ? clamp01(1 - p * 1.5) : 1;
    } else {
      this.holo.visible = false;
      this.holoLift = 0;
    }

    // Anomaly.
    const showAnomaly = s === 'anomaly' || (s === 'leaving' && p < 0.3);
    this.anomaly.visible = showAnomaly;
    if (showAnomaly) {
      // Its glitch band is stronger than the shared holo default (setHoloReducedFlashing).
      this.anomalyMat.uniforms.uGlitch.value = this.ctx.reduceFlashing ? 0 : B.anomaly.glitch;
      this.anomaly.position.set(0, top + 0.12 + H.rise + 0.1, 0.05);
      this.anomalyMat.uniforms.uFade.value = s === 'anomaly' ? smoothstep(0, 0.15, p) : 1 - p / 0.3;
    }

    // Beam + floor glow.
    let beam = 1;
    if (s === 'leaving') beam = 1 + B.beam.flare * Math.sin(Math.PI * clamp01(p)) - clamp01((p - 0.6) / 0.4);
    else if (s === 'arriving') beam = clamp01(p * 2) * (1 + B.beam.flare * (1 - p));
    else if (s === 'rolling' || s === 'anomaly') beam = 1.5;
    this.beamMat.uniforms.uIntensity.value = B.beam.intensity * Math.max(0, beam);
    this.beam.visible = beam > 0.01;
    this.pool.material.uniforms.uIntensity.value =
      B.glowPool.intensity * (1 - sink * 0.8) * (active ? 1.5 : 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m !== this.holo) m.geometry.dispose();
    });
    this.rift.dispose();
    this.holoMat.dispose();
    this.anomalyMat.dispose();
    this.emblemMat.dispose();
    this.interiorMat.dispose();
    this.beamMat.dispose();
    this.pool.material.dispose();
    for (const s of this.surfaces) s.texture.dispose();
  }
}
