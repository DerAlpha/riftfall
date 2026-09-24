/**
 * Looks of the quest objects (QUEST_VISUALS): flickering specimen tags (hidden targets), the rift
 * core (a spinning emissive crystal in a fresnel corona), the socket pedestal with its cradle ring,
 * and the defend zone (floor ring with a progress arc + a containment column that grows with it).
 * Built once at load (hidden until their step), animated per frame without allocation.
 */
import type { CanvasTexture } from 'three';
import {
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
  type ShaderMaterial,
  type SphereGeometry,
} from 'three';
import { noise1D } from '../core/math';
import type { Facing, Vec3Tuple } from '../defs/level';
import { QUEST_VISUALS } from '../defs/quests';
import { facingNormal, facingYaw } from '../interactables/shapes';
import { createCanvasSurface, redraw } from '../interactables/visuals/canvas';
import { createBeamMaterial, type BeamMaterial } from '../interactables/visuals/holo';
import { createProgressRing, createShell, toVolumetric } from '../maps/kit/energy';
import type { KitVisuals } from '../maps/kit/kitTypes';
import type { PropBuilder } from '../maps/kit/PropBuilder';

const V = QUEST_VISUALS;

/** Normal vector + yaw / pitch of an anchor normal. */
export function anchorNormal(n: Facing | 'up' | 'down', out: Vector3): Vector3 {
  if (n === 'up') return out.set(0, 1, 0);
  if (n === 'down') return out.set(0, -1, 0);
  const f = facingNormal(n);
  return out.set(f.x, 0, f.z);
}

let tagTexture: CanvasTexture | null | undefined;

/** Shared tag label (specimen code + barcode), drawn once. */
function tagLabel(): CanvasTexture | null {
  if (tagTexture !== undefined) return tagTexture;
  const s = createCanvasSurface(128, 80);
  redraw(s, (ctx, w, h) => {
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(h * 0.34)}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('K-7', w * 0.08, h * 0.08);
    let x = w * 0.08;
    let seed = 7;
    while (x < w * 0.92) {
      seed = (seed * 16807) % 2147483647;
      const bw = 2 + (seed % 4);
      ctx.fillRect(x, h * 0.55, bw, h * 0.34);
      x += bw + 2 + (seed % 3);
    }
  });
  tagTexture = s?.texture ?? null;
  return tagTexture;
}

/** A small plate with a flickering emissive specimen label. */
export class TagView {
  readonly mesh: Mesh;
  private readonly material: MeshStandardMaterial;
  private burn = 0;
  private readonly seed: number;

  constructor(
    position: Vec3Tuple,
    normal: Facing | 'up' | 'down',
    index: number,
    visuals: KitVisuals,
    props: PropBuilder,
  ) {
    const T = V.tag;
    const n = anchorNormal(normal, new Vector3());
    const [w, h] = T.size;
    this.seed = index * 13.7 + 3.1;
    // Backing plate (merged prop).
    if (normal === 'up' || normal === 'down') {
      props.setFrame(position[0], position[1], position[2], 0);
      props.box(T.material, 0, (n.y * T.depth) / 2, 0, w + 0.03, T.depth, h + 0.03);
    } else {
      props.setFrame(position[0], position[1], position[2], facingYaw(normal));
      props.box(T.material, 0, 0, T.depth / 2, w + 0.03, h + 0.03, T.depth);
    }
    const map = tagLabel();
    this.material = new MeshStandardMaterial({
      name: `quest-tag:${index}`,
      color: 0x050607,
      roughness: 0.4,
      metalness: 0,
      emissive: new Color(T.color[0], T.color[1], T.color[2]),
      emissiveMap: map,
      emissiveIntensity: T.intensity,
    });
    visuals.setupMaterial(this.material);
    this.mesh = new Mesh(new PlaneGeometry(w, h), this.material);
    this.mesh.name = 'prop:quest-tag';
    this.mesh.userData.navIgnore = true;
    const off = T.depth + 0.002;
    this.mesh.position.set(position[0] + n.x * off, position[1] + n.y * off, position[2] + n.z * off);
    this.mesh.lookAt(this.mesh.position.x + n.x, this.mesh.position.y + n.y, this.mesh.position.z + n.z);
    this.mesh.updateMatrixWorld();
    this.mesh.visible = false;
    visuals.root.add(this.mesh);
  }

  show(on: boolean): void {
    this.mesh.visible = on;
    if (on) this.burn = 0;
  }

  /** Shot: a flash, then dark. */
  burnOut(): void {
    this.burn = 1;
  }

  update(dt: number, time: number, reduced: boolean): void {
    if (!this.mesh.visible) return;
    const T = V.tag;
    if (this.burn > 0) {
      this.burn = Math.max(0, this.burn - dt * T.burnDecay);
      this.material.emissiveIntensity = T.intensity * T.burnFlash * this.burn;
      if (this.burn <= 0) this.mesh.visible = false;
      return;
    }
    // A failing label light: value-noise stutter with short dropouts.
    const n = 0.5 + 0.5 * noise1D(time * T.flickerRate, this.seed);
    const depth = T.flickerDepth * (reduced ? T.reducedScale : 1);
    const drop = !reduced && n < 0.22 ? 0.15 : 1;
    this.material.emissiveIntensity = T.intensity * (1 - depth * (1 - n)) * drop;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** The rift core: an emissive crystal with a corona; follows `position` (floats / sits in a socket). */
export class CoreView {
  readonly group = new Group();
  private readonly crystal: Mesh;
  private readonly material: MeshStandardMaterial;
  private readonly corona: Mesh<SphereGeometry, ShaderMaterial>;
  private spin = 0;
  /** Extra brightness (defend / feeding). */
  boost = 0;

  constructor(visuals: KitVisuals) {
    const C = V.core;
    this.material = new MeshStandardMaterial({
      name: 'quest-core',
      color: 0x0a0612,
      roughness: 0.2,
      metalness: 0,
      emissive: new Color(C.color[0], C.color[1], C.color[2]),
      emissiveIntensity: C.intensity,
      flatShading: true,
    });
    visuals.setupMaterial(this.material);
    this.crystal = new Mesh(new IcosahedronGeometry(C.radius, 0), this.material);
    this.crystal.name = 'prop:quest-core';
    this.crystal.userData.navIgnore = true;
    this.crystal.scale.set(0.8, 1.35, 0.8);
    this.group.add(this.crystal);
    this.corona = createShell(C.radius * C.coronaScale, C.color, 1.2, C.coronaRim, visuals.time);
    this.corona.visible = true;
    // No floor fade for the corona (the shell shader fades bubbles into the floor).
    (this.corona.material.uniforms.uFloor as { value: number }).value = -1e4;
    this.group.add(this.corona);
    this.group.name = 'quest-core';
    this.group.visible = false;
    visuals.root.add(this.group);
  }

  place(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  show(on: boolean): void {
    this.group.visible = on;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  update(dt: number, time: number, floating: boolean): void {
    if (!this.group.visible) return;
    const C = V.core;
    this.spin += dt * C.spin * (1 + this.boost * 2);
    this.crystal.rotation.set(0.3, this.spin, 0.15);
    this.crystal.position.y = floating ? Math.sin(time * C.bobRate * Math.PI * 2) * C.bob : 0;
    const pulse = 0.8 + 0.2 * Math.sin(time * C.pulseRate * Math.PI * 2);
    this.material.emissiveIntensity = C.intensity * pulse * (1 + this.boost);
    (this.corona.material.uniforms.uIntensity as { value: number }).value = (0.9 + this.boost) * pulse;
    this.corona.position.y = this.crystal.position.y;
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.crystal.geometry.dispose();
    this.material.dispose();
    this.corona.geometry.dispose();
    this.corona.material.dispose();
  }
}

/** Socket pedestal: dark column, cradle ring (glows when it wants the core), hazard base. */
export class SocketView {
  readonly cradle = new Vector3();
  private readonly ring: MeshStandardMaterial;
  private readonly ringMesh: Mesh;

  constructor(position: Vec3Tuple, visuals: KitVisuals, props: PropBuilder) {
    const S = V.socket;
    const [x, y, z] = position;
    props.setFrame(x, y, z, 0);
    props.cylinder(S.trim, 0, 0.06, 0, S.radius * 1.5, 0.12, 'y', 24);
    props.cylinder('painted_hazard', 0, 0.125, 0, S.radius * 1.3, 0.01, 'y', 24);
    props.cylinder(S.material, 0, S.height / 2, 0, S.radius * 0.55, S.height, 'y', 16, S.radius * 0.45);
    props.cylinder(S.trim, 0, S.height - 0.04, 0, S.radius, 0.08, 'y', 24);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      props.box(
        S.trim,
        Math.cos(a) * S.radius * 0.8,
        S.height + 0.12,
        Math.sin(a) * S.radius * 0.8,
        0.04,
        0.24,
        0.04,
      );
    }
    this.cradle.set(x, y + S.height + V.core.radius * 1.4, z);
    this.ring = new MeshStandardMaterial({
      name: 'quest-socket-ring',
      color: 0x050607,
      roughness: 0.35,
      metalness: 0,
      emissive: new Color(S.color[0], S.color[1], S.color[2]),
      emissiveIntensity: S.idleIntensity,
    });
    visuals.setupMaterial(this.ring);
    const geo = new CylinderGeometry(S.radius * 1.02, S.radius * 1.02, 0.03, 32, 1, true);
    this.ringMesh = new Mesh(geo, this.ring);
    this.ringMesh.name = 'prop:quest-socket-ring';
    this.ringMesh.userData.navIgnore = true;
    this.ringMesh.position.set(x, y + S.height - 0.04, z);
    this.ringMesh.updateMatrixWorld();
    visuals.root.add(this.ringMesh);
  }

  /** 'idle' | 'want' (the core is carried) | 'active' (fed / defending). */
  update(time: number, mode: 'idle' | 'want' | 'active', reduced: boolean): void {
    const S = V.socket;
    const pulse = reduced ? 0.85 : 0.6 + 0.4 * Math.sin(time * 3.2);
    this.ring.emissiveIntensity =
      mode === 'active'
        ? S.activeIntensity * pulse
        : mode === 'want'
          ? S.wantIntensity * pulse
          : S.idleIntensity;
  }

  dispose(): void {
    this.ringMesh.removeFromParent();
    this.ringMesh.geometry.dispose();
    this.ring.dispose();
  }
}

/** Defend zone: floor ring (progress arc) and a column rising with the progress. */
export class DefendView {
  private readonly ring: Mesh;
  private readonly column: Mesh<CylinderGeometry, BeamMaterial>;

  constructor(point: Vec3Tuple, radius: number, visuals: KitVisuals) {
    const D = V.defend;
    this.ring = createProgressRing(radius, D.ringWidth, D.ringColor, D.ringIntensity, visuals.time);
    this.ring.position.set(point[0], point[1] + 0.03, point[2]);
    this.ring.updateMatrixWorld();
    visuals.root.add(this.ring);
    const mat = createBeamMaterial(D.ringColor, D.columnIntensity, visuals.time);
    mat.uniforms.uHeight.value = D.columnHeight;
    const geo = new CylinderGeometry(0.45, 0.45, D.columnHeight, 24, 1, true);
    geo.translate(0, D.columnHeight / 2, 0);
    this.column = toVolumetric(new Mesh(geo, mat));
    this.column.name = 'quest-column';
    this.column.position.set(point[0], point[1], point[2]);
    this.column.visible = false;
    visuals.root.add(this.column);
  }

  update(active: boolean, progress: number, inside: boolean): void {
    this.ring.visible = active;
    this.column.visible = active;
    if (!active) return;
    const D = V.defend;
    const u = (this.ring.material as ShaderMaterial).uniforms;
    (u.uProgress as { value: number }).value = progress;
    (u.uIntensity as { value: number }).value = D.ringIntensity * (inside ? 1 : 0.55);
    this.column.scale.set(1, Math.max(0.05, progress), 1);
    this.column.material.uniforms.uIntensity.value = D.columnIntensity * (0.4 + progress);
    this.column.updateMatrixWorld();
  }

  dispose(): void {
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    (this.ring.material as ShaderMaterial).dispose();
    this.column.removeFromParent();
    this.column.geometry.dispose();
    this.column.material.dispose();
  }
}
