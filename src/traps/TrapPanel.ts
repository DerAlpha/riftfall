/**
 * The activation panel of a trap: an Interactable ("[F] Elektrozaun aktivieren (1000)") and its
 * look – a dark wall box with a hazard frame, a holo screen (name, price / state, countdown bar)
 * and a big glowing button in the state color (ready: green, breathing; active: orange; cooldown:
 * blue; no power: dark red). The screen canvas is redrawn on state changes and while a countdown
 * bar moves (at most TRAPS.panel.redrawRate per second).
 */
import { Mesh, MeshStandardMaterial, PlaneGeometry, Vector3, type Object3D } from 'three';
import type { Interactable } from '../core/contracts';
import { TRAPS, type TrapState } from '../defs/traps';
import { facingNormal, facingYaw } from '../interactables/shapes';
import { createCanvasSurface, redraw, type CanvasSurface } from '../interactables/visuals/canvas';
import { createHoloMaterial, type HoloMaterial } from '../interactables/visuals/holo';
import { HOLOGRAM } from '../defs/interactables';
import type { KitVisuals } from '../maps/kit/kitTypes';
import type { PropBuilder } from '../maps/kit/PropBuilder';
import { toVolumetric } from '../maps/kit/energy';
import type { TrapSlotDef } from '../defs/traps';

/** What the panel asks its trap. */
export interface TrapPanelOwner {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly state: TrapState;
  /** 0..1 progress of the active time / cooldown. */
  readonly progress: number;
  readonly powered: boolean;
  /** Pay and start; false when refused. */
  purchase(): boolean;
}

type PanelLook = TrapState | 'unpowered';

function formatPoints(n: number): string {
  return Math.round(n).toLocaleString('de-DE');
}

export class TrapPanel implements Interactable {
  readonly position: Vector3;
  readonly range = TRAPS.range;
  private readonly promptReady: string;
  private readonly promptActive: string;
  private readonly promptCooldown: string;
  private readonly button: MeshStandardMaterial | null = null;
  private readonly screen: HoloMaterial | null = null;
  private readonly surface: CanvasSurface | null = null;
  private readonly screenMesh: Mesh | null = null;
  private shown: PanelLook | null = null;
  private shownStep = -1;
  private redrawCooldown = 0;

  constructor(
    private readonly owner: TrapPanelOwner,
    slot: TrapSlotDef,
    visuals: KitVisuals | null,
    props: PropBuilder | null,
  ) {
    const P = TRAPS.panel;
    const f = slot.panel.facing;
    const n = facingNormal(f);
    const [px, py, pz] = slot.panel.position;
    this.position = new Vector3(px + n.x * P.anchorOffset, py, pz + n.z * P.anchorOffset);
    const fill = (t: string): string => t.replace('{name}', owner.name);
    this.promptReady = fill(TRAPS.prompts.activate);
    this.promptActive = fill(TRAPS.prompts.active);
    this.promptCooldown = fill(TRAPS.prompts.cooldown);
    if (!visuals || !props) return;

    // Body (merged with every other static trap part by the PropBuilder).
    const yaw = facingYaw(f);
    const { width: w, height: h, depth: d } = P;
    props.setFrame(px, py, pz, yaw);
    props.box(P.materials.body, 0, 0, d / 2, w, h, d);
    const fr = 0.035;
    props.box(P.materials.hazard, 0, h / 2 - fr / 2, d + 0.004, w + 0.02, fr, 0.012);
    props.box(P.materials.hazard, 0, -h / 2 + fr / 2, d + 0.004, w + 0.02, fr, 0.012);
    props.box(P.materials.trim, -w / 2 - 0.01, 0, d / 2, 0.025, h + 0.02, d + 0.02);
    props.box(P.materials.trim, w / 2 + 0.01, 0, d / 2, 0.025, h + 0.02, d + 0.02);
    // Button collar.
    const B = P.button;
    props.cylinder(P.materials.trim, 0, B.y, d + B.depth / 2, B.radius * 1.35, B.depth, 'z', 20);
    // Conduit from the panel down to the floor (the trap is wired, not magic).
    props.box(
      P.materials.trim,
      w * 0.3,
      -h / 2 - py / 2 + h / 4,
      0.03,
      0.05,
      Math.max(0.05, py - h / 2),
      0.05,
    );

    const group = visuals.root;
    // Glowing button.
    this.button = new MeshStandardMaterial({
      name: `trap-button:${slot.id}`,
      color: 0x050607,
      roughness: 0.35,
      metalness: 0,
      emissive: 0xffffff,
      emissiveIntensity: P.buttonIntensity,
    });
    visuals.setupMaterial(this.button);
    const btnGeo = new PlaneGeometry(B.radius * 2, B.radius * 2);
    const btn = new Mesh(btnGeo, this.button);
    btn.name = 'prop:trap-button';
    const bz = d + B.depth + 0.002;
    btn.position.set(px + n.x * bz, py + B.y, pz + n.z * bz);
    btn.rotation.y = yaw;
    btn.userData.navIgnore = true;
    group.add(btn);

    // Holo screen with the canvas text.
    const S = P.screen;
    this.surface = createCanvasSurface(S.canvas[0], S.canvas[1]);
    this.screen = createHoloMaterial({
      color: P.colors.ready,
      intensity: P.screenIntensity,
      time: visuals.time,
      map: this.surface?.texture ?? null,
      panel: true,
      reduceFlashing: visuals.reduceFlashing,
      seed: slot.id.length * 0.37,
    });
    const sw = w * S.width;
    const sh = h * S.height;
    const screen = toVolumetric(new Mesh(new PlaneGeometry(sw, sh), this.screen));
    const sz = d + 0.006;
    screen.position.set(px + n.x * sz, py + h * S.y, pz + n.z * sz);
    screen.rotation.y = yaw;
    screen.frustumCulled = true;
    screen.name = 'trap-screen';
    group.add(screen);
    this.screenMesh = screen;
    this.refresh(true);
  }

  get id(): string {
    return `trap_panel:${this.owner.id}`;
  }

  prompt(): string {
    if (this.owner.state === 'active') return this.promptActive;
    if (this.owner.state === 'cooldown') return this.promptCooldown;
    return this.owner.powered ? this.promptReady : TRAPS.prompts.unpowered;
  }

  cost(): number | null {
    return this.owner.state === 'ready' && this.owner.powered ? this.owner.price : null;
  }

  canInteract(): boolean {
    return this.owner.state === 'ready' && this.owner.powered;
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    if (this.canInteract()) this.owner.purchase();
  }

  /** Per frame: button glow + screen (redrawn on change / countdown steps). */
  update(dt: number, time: number, reduceFlashing: boolean): void {
    if (!this.button) return;
    const P = TRAPS.panel;
    const look: PanelLook =
      this.owner.powered || this.owner.state !== 'ready' ? this.owner.state : 'unpowered';
    const c = P.colors[look];
    let k = 1;
    if (look === 'ready') {
      const depth = P.breathe.depth * (reduceFlashing ? P.breathe.reducedScale : 1);
      k = 1 - depth * (0.5 + 0.5 * Math.sin(time * P.breathe.rate * Math.PI * 2));
    }
    this.button.emissive.setRGB(c[0], c[1], c[2]);
    this.button.emissiveIntensity = P.buttonIntensity * k;
    this.redrawCooldown -= dt;
    this.refresh(false);
  }

  /** Redraw the canvas when the look or the countdown step changed. */
  private refresh(force: boolean): void {
    if (!this.screen) return;
    const P = TRAPS.panel;
    const look: PanelLook =
      this.owner.powered || this.owner.state !== 'ready' ? this.owner.state : 'unpowered';
    const step = look === 'active' || look === 'cooldown' ? Math.floor(this.owner.progress * 40) : -1;
    if (!force && look === this.shown && (step === this.shownStep || this.redrawCooldown > 0)) return;
    this.shown = look;
    this.shownStep = step;
    this.redrawCooldown = 1 / P.redrawRate;
    const c = P.colors[look];
    this.screen.uniforms.uColor.value.setRGB(c[0], c[1], c[2]);
    const name = this.owner.name.toUpperCase();
    const caption = P.captions[look];
    const price = this.owner.price;
    const progress = this.owner.progress;
    redraw(this.surface, (ctx, w, h) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(h * 0.2)}px ${HOLOGRAM.fontDisplay}`;
      fit(ctx, name, w * 0.9, h * 0.2);
      ctx.fillText(name, w / 2, h * 0.2);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(w * 0.08, h * 0.36, w * 0.84, Math.max(2, h * 0.012));
      ctx.globalAlpha = 1;
      if (look === 'ready') {
        ctx.font = `800 ${Math.round(h * 0.3)}px ${HOLOGRAM.fontDisplay}`;
        ctx.fillText(formatPoints(price), w / 2, h * 0.6);
      } else {
        // Countdown bar: active drains, cooldown fills.
        const frac = look === 'active' ? 1 - progress : look === 'cooldown' ? progress : 0;
        const bx = w * 0.1;
        const bw = w * 0.8;
        const by = h * 0.52;
        const bh = h * 0.13;
        ctx.lineWidth = Math.max(2, h * 0.02);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillRect(bx + 3, by + 3, Math.max(0, (bw - 6) * frac), bh - 6);
      }
      ctx.globalAlpha = 0.85;
      ctx.font = `700 ${Math.round(h * 0.13)}px ${HOLOGRAM.fontMono}`;
      fit(ctx, caption, w * 0.9, h * 0.13, HOLOGRAM.fontMono);
      ctx.fillText(caption, w / 2, h * 0.84);
    });
  }

  dispose(): void {
    this.button?.dispose();
    if (this.screenMesh) {
      this.screenMesh.removeFromParent();
      this.screenMesh.geometry.dispose();
    }
    this.screen?.dispose();
    this.surface?.texture.dispose();
  }

  /** Scene objects of the panel that are not merged props (power dimming, tests). */
  get objects(): Object3D[] {
    return this.screenMesh ? [this.screenMesh] : [];
  }
}

function fit(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  px: number,
  family: string = HOLOGRAM.fontDisplay,
): void {
  let size = px;
  while (size > 8 && ctx.measureText(text).width > maxWidth) {
    size *= 0.9;
    ctx.font = `800 ${Math.round(size)}px ${family}`;
  }
}
