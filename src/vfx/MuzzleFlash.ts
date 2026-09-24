/**
 * First-person muzzle flash: two additive HDR quads parented to the viewmodel's muzzle socket
 * anchor (viewmodel scene, so it is drawn with the weapon and blooms): a face-on star with a
 * random roll/scale per shot and a flame tongue along the barrel that turns around the barrel axis
 * to face the camera. Visible for MuzzleFlashDef.duration (a few frames) and fading over it.
 * The world light of the flash is a pooled world light (LightPool); the light on the weapon
 * itself belongs to the ViewmodelRig.
 */
import * as THREE from 'three';
import { ENGINE } from '../defs/engine';
import { SPRITE_ATLAS, VFX, type MuzzleFlashDef } from '../defs/vfx';
import { cellUv, spriteCell, type CellUv } from './atlas';
import type { Rand } from './emit';

const _cell: CellUv = { u0: 0, v0: 0, du: 1, dv: 1 };
const _cam = new THREE.Vector3();
const _inv = new THREE.Matrix4();

function quad(positions: number[], cell: number): THREE.BufferGeometry {
  cellUv(SPRITE_ATLAS, cell, _cell, 0.5, SPRITE_ATLAS.cellSize);
  const uv = [0, 0, 1, 0, 1, 1, 0, 1].map((t, i) =>
    i % 2 === 0 ? _cell.u0 + t * _cell.du : _cell.v0 + t * _cell.dv,
  );
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

export class MuzzleFlash {
  readonly root = new THREE.Group();
  private readonly star: THREE.Mesh;
  private readonly petalPivot = new THREE.Group();
  private readonly petal: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometries: THREE.BufferGeometry[];
  private readonly baseColor = new THREE.Color();
  private age = Number.POSITIVE_INFINITY;
  private duration = 0;

  constructor(
    atlas: THREE.Texture,
    private readonly rand: Rand = Math.random,
  ) {
    this.material = new THREE.MeshBasicMaterial({
      name: 'VfxMuzzleFlash',
      map: atlas,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    // Star: face-on (normal along the barrel), unit size.
    const starGeo = quad([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], spriteCell('flash'));
    // Tongue: base at the muzzle, tip 1 m down the barrel (−Z), lying in the XZ plane (normal +Y).
    const petalGeo = quad([-0.5, 0, 0, 0.5, 0, 0, 0.5, 0, -1, -0.5, 0, -1], spriteCell('petal'));
    this.geometries = [starGeo, petalGeo];
    this.star = new THREE.Mesh(starGeo, this.material);
    this.petal = new THREE.Mesh(petalGeo, this.material);
    this.petalPivot.add(this.petal);
    this.root.add(this.star, this.petalPivot);
    this.root.name = 'VfxMuzzleFlash';
    this.root.visible = false;
    this.root.traverse((o) => {
      o.layers.enable(ENGINE.viewmodelLayer);
      o.frustumCulled = false;
      o.renderOrder = VFX.muzzleFlash.renderOrder;
    });
  }

  /** Re-parent onto a socket anchor (null detaches). */
  attach(parent: THREE.Object3D | null): void {
    if (parent === this.root.parent) return;
    this.root.removeFromParent();
    parent?.add(this.root);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /**
   * Show a new flash; `intensityScale` dims it (reduce-flashing accessibility option, suppressor),
   * `sizeScale` shrinks it (suppressor).
   */
  fire(def: MuzzleFlashDef, ads: boolean, intensityScale = 1, sizeScale = 1): void {
    const r = this.rand;
    const mf = VFX.muzzleFlash;
    const scale = (ads ? def.adsScale : 1) * Math.max(0, sizeScale);
    const size = def.size * scale * (mf.scaleJitter[0] + (mf.scaleJitter[1] - mf.scaleJitter[0]) * r());
    this.star.scale.set(size, size, 1);
    this.star.rotation.set(0, 0, r() * Math.PI * 2);
    const length =
      def.length * scale * (mf.lengthJitter[0] + (mf.lengthJitter[1] - mf.lengthJitter[0]) * r());
    this.petal.visible = length > 0;
    this.petal.scale.set(def.size * scale * mf.petalWidth, 1, Math.max(1e-4, length));
    this.baseColor.setRGB(def.color[0], def.color[1], def.color[2], THREE.LinearSRGBColorSpace);
    this.baseColor.multiplyScalar(def.intensity * Math.max(0, intensityScale));
    this.duration = Math.max(1e-3, def.duration);
    this.age = 0;
    this.applyFade();
    this.root.visible = this.root.parent !== null;
  }

  /** Advance the fade and turn the tongue towards `camera` (its world position). */
  update(dt: number, camera: THREE.Object3D): void {
    if (!this.root.visible) return;
    this.age += Math.max(0, dt);
    if (this.age >= this.duration || !this.root.parent) {
      this.hide();
      return;
    }
    this.applyFade();
    // Rotate the tongue around the barrel axis (local Z) so its face points at the camera.
    this.root.parent.updateWorldMatrix(true, false);
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _inv.copy(this.root.parent.matrixWorld).invert();
    _cam.applyMatrix4(_inv);
    this.petalPivot.rotation.set(0, 0, Math.atan2(-_cam.x, _cam.y));
  }

  /** Shader warm-up: visible but black (additive → invisible) while active. */
  setWarmup(active: boolean): void {
    if (active) {
      this.material.color.setRGB(0, 0, 0);
      this.root.visible = this.root.parent !== null;
    } else {
      this.hide();
    }
  }

  hide(): void {
    this.age = Number.POSITIVE_INFINITY;
    this.root.visible = false;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }

  private applyFade(): void {
    const t = Math.min(1, this.age / this.duration);
    const k = 1 - t * t;
    this.material.color.copy(this.baseColor).multiplyScalar(k);
  }
}
