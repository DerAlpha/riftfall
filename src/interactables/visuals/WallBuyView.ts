/**
 * Wall-buy board: a framed dark plate on the wall, a faint scanline field, the weapon as a
 * holographic outline floating in front of it (fresnel rims of the real viewmodel geometry) and a
 * holographic price plate below. Carried weapons switch the plate to the ammo offer and dim the
 * hologram; a purchase flares it.
 *
 * Local frame: origin at the board center on the wall face, +Z out of the wall, +X to the viewer's
 * right (the barrel points there).
 */
import { Group, Mesh, PlaneGeometry } from 'three';
import { WALL_BUYS } from '../../defs/interactables';
import type { Facing, Vec3Tuple } from '../../defs/level';
import type { WallBuyViewApi } from '../WallBuy';
import { facingYaw } from '../shapes';
import { createCanvasSurface, drawPricePlate, redraw, type CanvasSurface } from './canvas';
import type { VisualContext } from './context';
import { hashSeed } from './DoorView';
import { createHoloMaterial, toVolumetricLayer, type HoloMaterial } from './holo';
import { PartBuilder } from './parts';

export interface WallBuyViewOptions {
  id: string;
  weaponId: string;
  /** Plate label (upper case short name + name). */
  label: string;
  ammoLabel: string;
  weaponPrice: number;
  ammoPrice: number;
  position: Vec3Tuple;
  facing: Facing;
}

/** The screen field sits this far in front of the board face; the plate clears wall rails (m). */
const SCREEN_GAP = 0.004;
const PLATE_GAP = 0.075;

export class WallBuyView implements WallBuyViewApi {
  readonly group = new Group();
  private readonly holo: Mesh;
  private readonly holoMat: HoloMaterial;
  private readonly screenMat: HoloMaterial;
  private readonly plateMat: HoloMaterial;
  private readonly surface: CanvasSurface | null;
  private owned = false;
  private flashAmount = 0;
  private disposed = false;
  private readonly seed: number;

  constructor(
    private readonly opts: WallBuyViewOptions,
    ctx: VisualContext,
  ) {
    const W = WALL_BUYS;
    const B = W.board;
    const g = this.group;
    g.name = `wallbuy:${opts.id}`;
    g.position.set(opts.position[0], opts.position[1], opts.position[2]);
    g.rotation.y = facingYaw(opts.facing);
    ctx.root.add(g);
    this.seed = hashSeed(opts.id);

    // Board + frame.
    const pb = new PartBuilder();
    pb.box('body', 0, 0, B.depth / 2, B.width, B.height, B.depth);
    const f = B.frame;
    const fz = B.depth + f / 4;
    for (const s of [-1, 1]) {
      pb.box('trim', (s * (B.width + f)) / 2, 0, fz / 2, f, B.height + f * 2, fz);
      pb.box('trim', 0, (s * (B.height + f)) / 2, fz / 2, B.width, f, fz);
    }
    // Flat on the wall: no shadow casting.
    pb.mesh('body', ctx.materials.get(B.body), g, false);
    pb.mesh('trim', ctx.materials.get(B.trim), g, false);
    pb.dispose();

    // Scanline field behind the hologram.
    const S = W.screen;
    this.screenMat = createHoloMaterial({
      color: S.color,
      intensity: S.intensity,
      time: ctx.time,
      panel: true,
      reduceFlashing: ctx.reduceFlashing,
      seed: this.seed,
    });
    const screen = toVolumetricLayer(
      new Mesh(new PlaneGeometry(B.width - S.inset * 2, B.height - S.inset * 2), this.screenMat),
    );
    screen.name = 'wallbuy-screen';
    screen.position.z = B.depth + SCREEN_GAP;
    g.add(screen);

    // Weapon hologram.
    const H = W.hologram;
    this.holoMat = createHoloMaterial({
      color: H.color,
      intensity: H.intensity,
      time: ctx.time,
      reduceFlashing: ctx.reduceFlashing,
      seed: this.seed,
      doubleSided: true,
    });
    this.holo = toVolumetricLayer(new Mesh(ctx.holograms.get(opts.weaponId), this.holoMat));
    this.holo.name = 'wallbuy-hologram';
    this.holo.scale.setScalar(ctx.holograms.displayLength(opts.weaponId, H.scale, H.minLength, H.maxLength));
    this.holo.position.set(0, H.y, H.offset);
    g.add(this.holo);

    // Price plate under the board.
    const P = W.plate;
    this.surface = createCanvasSurface(P.canvas[0], P.canvas[1]);
    this.plateMat = createHoloMaterial({
      color: P.color,
      intensity: P.intensity,
      time: ctx.time,
      map: this.surface?.texture ?? null,
      panel: true,
      reduceFlashing: ctx.reduceFlashing,
      seed: this.seed,
    });
    const plate = toVolumetricLayer(new Mesh(new PlaneGeometry(P.width, P.height), this.plateMat));
    plate.name = 'wallbuy-plate';
    plate.position.set(0, -B.height / 2 - f - P.gap - P.height / 2, PLATE_GAP);
    g.add(plate);
    g.updateMatrixWorld(true);
    this.drawPlate();
  }

  setOwned(owned: boolean): void {
    this.owned = owned;
    this.holoMat.uniforms.uIntensity.value =
      WALL_BUYS.hologram.intensity * (owned ? WALL_BUYS.hologram.ownedIntensity : 1);
    this.drawPlate();
  }

  flash(): void {
    this.flashAmount = 1;
  }

  update(dt: number, time: number): void {
    if (this.disposed) return;
    const H = WALL_BUYS.hologram;
    this.holo.position.y = H.y + Math.sin((time * H.bobRate + this.seed) * Math.PI * 2) * H.bobAmplitude;
    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * H.flashDecay);
      this.holoMat.uniforms.uFlash.value = this.flashAmount;
      this.plateMat.uniforms.uFlash.value = this.flashAmount;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as Mesh;
      // The hologram geometry belongs to the shared library.
      if (m.isMesh && m !== this.holo) m.geometry.dispose();
    });
    this.holoMat.dispose();
    this.screenMat.dispose();
    this.plateMat.dispose();
    this.surface?.texture.dispose();
  }

  private drawPlate(): void {
    const o = this.opts;
    redraw(this.surface, (c, w, h) =>
      drawPricePlate(c, w, h, this.owned ? o.ammoLabel : o.label, this.owned ? o.ammoPrice : o.weaponPrice),
    );
  }
}
