/**
 * Emergency generator (power outage objective): a wall cabinet with a crank lever, hazard frame,
 * status lamp and a floor glow. During an outage the lamp pulses red, a warning beacon rises over
 * it and it can be restarted by holding interact (POWER.generator.hold) – "Generator neu starten";
 * otherwise it is not focusable (empty prompt). Crank ticks play while the hold runs.
 */
import { Color, CylinderGeometry, Mesh, MeshStandardMaterial, Vector3, type Object3D, type PlaneGeometry } from 'three';
import type { Interactable } from '../core/contracts';
import { POWER, type GeneratorSpotDef } from '../defs/mapEvents';
import { facingNormal, facingYaw } from '../interactables/shapes';
import { createBeamMaterial, createLightPool, type BeamMaterial, type PoolMaterial } from '../interactables/visuals/holo';
import { toVolumetric } from '../maps/kit/energy';
import type { KitAudio, KitVisuals } from '../maps/kit/kitTypes';
import type { PropBuilder } from '../maps/kit/PropBuilder';

const G = POWER.generator;

export class GeneratorPanel implements Interactable {
  readonly id: string;
  readonly position: Vector3;
  readonly range = G.range;
  /** Floor point in front of the cabinet (beacon, sounds). */
  readonly base = new Vector3();
  /** Waiting for a restart (outage running with this generator as the objective). */
  alarm = false;
  private restoreHandler: (() => void) | null = null;
  private readonly lamp: MeshStandardMaterial | null = null;
  private readonly lampMesh: Mesh | null = null;
  private readonly beam: Mesh<CylinderGeometry, BeamMaterial> | null = null;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial> | null = null;
  private readonly lever: Mesh | null = null;
  private readonly okColor = new Color(G.okColor[0], G.okColor[1], G.okColor[2]);
  private readonly alarmColor = new Color(G.alarmColor[0], G.alarmColor[1], G.alarmColor[2]);
  private crankTimer = 0;

  constructor(
    readonly spot: GeneratorSpotDef,
    visuals: KitVisuals | null,
    props: PropBuilder | null,
    private readonly audio: KitAudio | null,
  ) {
    this.id = `generator:${spot.id}`;
    const n = facingNormal(spot.facing);
    const yaw = facingYaw(spot.facing);
    const [x, y, z] = spot.position;
    const { width: w, height: h, depth: d } = G.size;
    const cz = G.wallGap + d / 2;
    const cx = x + n.x * cz;
    const czz = z + n.z * cz;
    const a = d / 2 + G.anchor.offset;
    this.position = new Vector3(cx + n.x * a, y + G.anchor.y, czz + n.z * a);
    this.base.set(cx + n.x * (d / 2 + 0.6), y, czz + n.z * (d / 2 + 0.6));
    if (!visuals || !props) return;

    // Cabinet: plinth, body, front panel with vents, hazard frame, cable ducts to the ceiling.
    const M = G.materials;
    props.setFrame(cx, y, czz, yaw);
    props.box(M.hazard, 0, 0.07, 0, w + 0.04, 0.14, d + 0.04);
    props.box(M.body, 0, 0.14 + (h - 0.14) / 2, 0, w, h - 0.14, d);
    props.box(M.panel, 0, h * 0.55, d / 2 + 0.01, w * 0.84, h * 0.62, 0.02);
    for (let i = 0; i < 6; i++) props.box(M.trim, -w * 0.18, h * 0.32 + i * 0.07, d / 2 + 0.025, w * 0.34, 0.025, 0.01);
    props.box(M.trim, 0, h + 0.03, 0, w + 0.06, 0.06, d + 0.06);
    props.box(M.trim, w * 0.3, h + 0.5, -d / 2 + 0.08, 0.1, 1.0, 0.1);
    props.box(M.trim, -w * 0.3, h + 0.5, -d / 2 + 0.08, 0.1, 1.0, 0.1);
    // Lever housing (right side of the front).
    props.box(M.trim, w * 0.26, h * 0.55, d / 2 + 0.05, 0.16, 0.5, 0.08);

    this.lamp = new MeshStandardMaterial({
      name: `generator-lamp:${spot.id}`,
      color: 0x050607,
      roughness: 0.3,
      metalness: 0,
      emissive: this.okColor.clone(),
      emissiveIntensity: G.lampIntensity * 0.4,
    });
    visuals.setupMaterial(this.lamp);
    const lampGeo = new CylinderGeometry(0.07, 0.08, 0.14, 16);
    const lamp = new Mesh(lampGeo, this.lamp);
    lamp.name = 'prop:generator-lamp';
    lamp.position.set(cx, y + h + 0.13, czz);
    lamp.updateMatrixWorld();
    lamp.userData.navIgnore = true;
    visuals.root.add(lamp);
    this.lampMesh = lamp;

    // Lever arm (rotates down while held / after a restart).
    const leverGeo = new CylinderGeometry(0.025, 0.025, 0.36, 10);
    leverGeo.rotateX(Math.PI / 2);
    leverGeo.translate(0, 0, 0.18);
    const lever = new Mesh(leverGeo, visuals.materials.get(M.hazard));
    lever.name = 'prop:generator-lever';
    const lz = d / 2 + 0.09;
    // Local +X (the cabinet's right) is world (n.z, 0, -n.x).
    const ox = w * 0.26;
    lever.position.set(cx + n.x * lz + n.z * ox, y + h * 0.7, czz + n.z * lz - n.x * ox);
    lever.rotation.order = 'YXZ';
    lever.rotation.y = yaw;
    lever.userData.navIgnore = true;
    visuals.root.add(lever);
    this.lever = lever;

    // Beacon beam over the generator during an outage (additive, volumetric layer).
    const B = G.beacon;
    const beamMat = createBeamMaterial(B.color, B.intensity, visuals.time);
    beamMat.uniforms.uHeight.value = B.height;
    const beamGeo = new CylinderGeometry(B.radius, B.radius, B.height, 24, 1, true);
    beamGeo.translate(0, B.height / 2, 0);
    const beam = toVolumetric(new Mesh(beamGeo, beamMat));
    beam.position.copy(this.base);
    beam.updateMatrixWorld();
    beam.visible = false;
    beam.name = 'generator-beacon';
    visuals.root.add(beam);
    this.beam = beam;
    const pool = createLightPool(G.alarmColor, 0, G.glowPool.radius);
    pool.position.set(this.base.x, y + pool.position.y, this.base.z);
    pool.updateMatrixWorld();
    visuals.root.add(pool);
    this.pool = pool;
  }

  /** Called when a restart completes (the director restores the power). */
  onRestore(handler: (() => void) | null): void {
    this.restoreHandler = handler;
  }

  prompt(): string {
    return this.alarm ? G.prompt : '';
  }

  cost(): number | null {
    return null;
  }

  canInteract(): boolean {
    return this.alarm;
  }

  holdTime(): number {
    return G.hold;
  }

  interact(): void {
    if (!this.alarm) return;
    this.alarm = false;
    this.restoreHandler?.();
  }

  /** Per frame: lamp / beacon look; `holding` = the player is holding interact on it. */
  update(dt: number, time: number, holding: boolean, reduceFlashing: boolean): void {
    if (holding && this.alarm) {
      this.crankTimer -= dt;
      if (this.crankTimer <= 0) {
        this.crankTimer = G.crankInterval;
        this.audio?.play(POWER.audio.crank, { position: this.position, volume: POWER.audio.crankGain, pitchVariance: 0.08 });
      }
    } else {
      this.crankTimer = 0;
    }
    if (!this.lamp) return;
    const rate = reduceFlashing ? G.reducedPulseRate : G.pulseRate;
    const pulse = 0.5 + 0.5 * Math.sin(time * rate * Math.PI * 2);
    if (this.alarm) {
      this.lamp.emissive.copy(this.alarmColor);
      this.lamp.emissiveIntensity = G.lampIntensity * (0.35 + 0.65 * pulse);
    } else {
      this.lamp.emissive.copy(this.okColor);
      this.lamp.emissiveIntensity = G.lampIntensity * 0.4;
    }
    if (this.beam) {
      this.beam.visible = this.alarm;
      this.beam.material.uniforms.uIntensity.value = G.beacon.intensity * (0.6 + 0.4 * pulse);
    }
    if (this.pool) {
      this.pool.visible = this.alarm;
      this.pool.material.uniforms.uIntensity.value = G.glowPool.intensity * (0.5 + 0.5 * pulse);
    }
    if (this.lever) {
      const target = holding && this.alarm ? -0.9 : this.alarm ? 0.5 : -0.9;
      this.lever.rotation.x += (target - this.lever.rotation.x) * Math.min(1, dt * 6);
      this.lever.updateMatrixWorld();
    }
  }

  /** Objects that belong to the generator (debug). */
  get objects(): Object3D[] {
    return [this.lampMesh, this.beam, this.pool, this.lever].filter((o): o is NonNullable<typeof o> => o !== null);
  }

  dispose(): void {
    for (const o of this.objects) {
      o.removeFromParent();
      const m = o as Mesh;
      m.geometry?.dispose();
    }
    this.lamp?.dispose();
    this.beam?.material.dispose();
    this.pool?.material.dispose();
  }
}
