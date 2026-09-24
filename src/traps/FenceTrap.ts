/**
 * Electric fence ("Elektrozaun"): lightning strands between two emitter posts across a corridor.
 * Active: every TRAPS.fence.zapInterval everything inside the slab around the post line takes
 * shock damage with status build-up (shocked = stunned: they stay in the arcs), a jolt away from
 * the line, a zap strike from the fence to the body, sparks and a crackle; the player takes damage
 * on contact too. The navmesh is untouched – enemies walk straight into it.
 */
import { Color, MeshStandardMaterial, Vector3, type Mesh, type PlaneGeometry } from 'three';
import type { Vec3Like } from '../core/events';
import { TRAPS, type FenceSlotDef } from '../defs/traps';
import { MOVEMENT } from '../defs/movement';
import { createLightPool, type PoolMaterial } from '../interactables/visuals/holo';
import { ArcBundle } from '../maps/kit/energy';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { Trap, type TrapContext } from './Trap';
import { segmentDistanceXZ, type SegmentHit } from './trapMath';

const F = TRAPS.fence;
const _seg: SegmentHit = { distance: 0, t: 0, x: 0, z: 0 };
const _p = new Vector3();
const _q = new Vector3();
const _dir = { x: 0, y: 0, z: 0 };
const UP = { x: 0, y: 1, z: 0 };

export class FenceTrap extends Trap {
  private readonly a: Vector3;
  private readonly b: Vector3;
  private readonly height: number;
  private readonly halfLength: number;
  /** Unit normal of the fence plane (XZ). */
  private readonly nx: number;
  private readonly nz: number;
  private zapTimer = 0;
  private playerTimer = 0;
  private hitSoundTimer = 0;
  /** Arc energy 0..1 (ramps on / off). */
  private energy = 0;
  private strikeNext = 0;
  private readonly strikeLife: Float32Array;
  private readonly arcs: ArcBundle | null = null;
  private readonly coils: MeshStandardMaterial | null = null;
  private readonly coilMesh: Mesh | null = null;
  private readonly pool: Mesh<PlaneGeometry, PoolMaterial> | null = null;
  private readonly coilColor = new Color();

  constructor(slot: FenceSlotDef, ctx: TrapContext) {
    const a = new Vector3(slot.a[0], slot.a[1], slot.a[2]);
    const b = new Vector3(slot.b[0], slot.b[1], slot.b[2]);
    const height = slot.height ?? F.height;
    super(slot, ctx, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + height / 2, z: (a.z + b.z) / 2 });
    this.a = a;
    this.b = b;
    this.height = height;
    this.halfLength = a.distanceTo(b) / 2;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    this.nx = -dz / len;
    this.nz = dx / len;
    this.strikeLife = new Float32Array(F.strikes);
    const v = ctx.visuals;
    const props = ctx.props;
    if (!v || !props) return;

    // Emitter posts: dark pillar, hazard base, insulator coils (glow), top cap.
    const P = F.post;
    const coilMat = new MeshStandardMaterial({
      name: `trap-fence-coils:${slot.id}`,
      color: 0x050607,
      roughness: 0.35,
      metalness: 0,
      emissive: new Color(F.coilColor[0], F.coilColor[1], F.coilColor[2]),
      emissiveIntensity: F.coilIntensity.ready,
    });
    v.setupMaterial(coilMat);
    this.coils = coilMat;
    const yaw = Math.atan2(dx, dz);
    const coilMeshes: Vector3[] = [];
    for (const p of [a, b]) {
      props.setFrame(p.x, p.y, p.z, yaw);
      props.box('pillar_metal', 0, P.height / 2, 0, P.width, P.height, P.depth);
      props.box('painted_hazard', 0, 0.2, 0, P.width + 0.03, 0.4, P.depth + 0.03);
      props.box('trim_metal', 0, P.height + 0.04, 0, P.width + 0.06, 0.08, P.depth + 0.06);
      props.box('trim_metal', 0, 0.02, 0, P.width + 0.14, 0.04, P.depth + 0.14);
      for (const h of F.strands) coilMeshes.push(new Vector3(p.x, p.y + h * height, p.z));
    }
    // Coil discs (one merged glow mesh per fence: they share the state color).
    const coilProps = new PropBuilder();
    for (const c of coilMeshes) {
      coilProps.setFrame(c.x, c.y, c.z, yaw);
      for (let k = 0; k < P.coils; k++) {
        const y = (k - (P.coils - 1) / 2) * P.coilHeight * 1.6;
        coilProps.cylinder('coil', 0, y, 0, P.coilRadius, P.coilHeight * 0.7, 'y', 16);
      }
    }
    this.coilMesh = coilProps.mesh('coil', coilMat, v.root, false);
    coilProps.dispose();

    this.arcs = new ArcBundle({
      count: F.strands.length + F.strikes,
      segments: F.arc.segments,
      width: F.arc.glow,
      core: F.arc.core / F.arc.glow,
      jitter: F.arc.jitter,
      jitterRate: F.arc.jitterRate,
      coreColor: F.arc.coreColor,
      glowColor: F.arc.glowColor,
      intensity: F.arc.intensity,
      time: v.time,
      flicker: v.reduceFlashing ? 0.05 : 0.35,
      name: `trap-fence-arcs:${slot.id}`,
    });
    // Strands: from coil to coil (static endpoints, energy per frame).
    F.strands.forEach((h, i) => {
      _p.set(a.x, a.y + h * height, a.z);
      _q.set(b.x, b.y + h * height, b.z);
      this.arcs!.set(i, _p, _q, 0);
    });
    v.root.add(this.arcs.mesh);
    const pool = createLightPool(F.arc.glowColor, 0, Math.max(TRAPS.glowPool.radius, this.halfLength + 0.6));
    pool.position.set(this.center.x, a.y + pool.position.y, this.center.z);
    pool.updateMatrixWorld();
    v.root.add(pool);
    this.pool = pool;
  }

  protected onActivate(): void {
    this.zapTimer = F.zapInterval * 0.5;
    this.playerTimer = 0;
  }

  protected onDeactivate(): void {
    this.strikeLife.fill(0);
  }

  protected tickActive(dt: number): void {
    this.hitSoundTimer -= dt;
    this.zapTimer -= dt;
    if (this.zapTimer <= 0) {
      this.zapTimer += F.zapInterval;
      this.zap();
    }
    this.playerTimer -= dt;
    const player = this.ctx.player;
    if (player && player.alive && this.playerTimer <= 0) {
      const p = player.position;
      segmentDistanceXZ(p.x, p.z, this.a.x, this.a.z, this.b.x, this.b.z, _seg);
      const inside =
        _seg.distance <= F.halfThickness + MOVEMENT.collider.radius &&
        p.y < this.a.y + this.height &&
        p.y + MOVEMENT.collider.standHeight > this.a.y;
      if (inside) {
        this.playerTimer = F.playerInterval;
        _dir.x = _seg.x - p.x;
        _dir.y = 0;
        _dir.z = _seg.z - p.z;
        player.damage(F.playerDamage, _dir, 'generic');
        this.shake(F.playerShake);
        this.ctx.vfx?.spawn(F.zapEffect, player.eyePosition, UP, F.playerEffectScale);
        this.hitSound(player.eyePosition);
      }
    }
  }

  private zap(): void {
    const reach = this.halfLength + F.halfThickness + F.queryMargin;
    const targets = this.queryEnemies(this.center, reach);
    let effects = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const c = t.boundsCenter;
      if (c.y - t.boundsRadius > this.a.y + this.height) continue;
      segmentDistanceXZ(c.x, c.z, this.a.x, this.a.z, this.b.x, this.b.z, _seg);
      if (_seg.distance > F.halfThickness + t.boundsRadius * F.radiusShare) continue;
      // Push away from the line (the side it is on), shock build-up stuns.
      const side = (c.x - _seg.x) * this.nx + (c.z - _seg.z) * this.nz >= 0 ? 1 : -1;
      this.hurt(
        t,
        F.zapDamage,
        'shock',
        'beam',
        t.aimPoint,
        this.nx * side,
        0,
        this.nz * side,
        F.impulse,
        F.statusBuildup,
      );
      if (effects < F.effectsPerZap) {
        effects++;
        this.ctx.vfx?.spawn(F.zapEffect, t.aimPoint, UP, 1);
        this.strike(_seg.x, Math.min(t.aimPoint.y, this.a.y + this.height), _seg.z, t.aimPoint);
        this.hitSound(t.aimPoint);
      }
    }
  }

  private strike(x: number, y: number, z: number, to: Vec3Like): void {
    if (!this.arcs) return;
    const k = this.strikeNext;
    this.strikeNext = (k + 1) % F.strikes;
    _p.set(x, y, z);
    this.arcs.set(F.strands.length + k, _p, to, 1);
    this.strikeLife[k] = F.strikeLife;
  }

  private hitSound(at: Vec3Like): void {
    if (this.hitSoundTimer > 0) return;
    this.hitSoundTimer = F.hitSoundInterval;
    this.ctx.audio?.play(F.audio.hit, { position: at, volume: F.audio.hitGain, pitchVariance: 0.12 });
  }

  protected updateVisual(dt: number, time: number, reduceFlashing: boolean): void {
    const on = this.state === 'active' ? 1 : 0;
    // Arcs strike up fast and die with a short tail.
    const rate = on > this.energy ? F.ramp.on : F.ramp.off;
    this.energy += (on - this.energy) * Math.min(1, dt * rate);
    if (this.energy < 0.002) this.energy = 0;
    if (this.coils) {
      const I = F.coilIntensity;
      let k: number;
      if (this.state === 'active') k = I.active * (0.8 + 0.2 * Math.sin(time * 40));
      else if (this.state === 'cooldown') k = I.cooldown * (0.7 + 0.3 * Math.sin(time * 2.2));
      else k = this.powered ? I.ready : I.cooldown * 0.3;
      if (reduceFlashing && this.state === 'active') k = I.active * 0.9;
      this.coils.emissiveIntensity = k;
      const warm = this.state === 'cooldown' ? TRAPS.panel.colors.cooldown : F.coilColor;
      this.coilColor.setRGB(warm[0], warm[1], warm[2]);
      this.coils.emissive.copy(this.coilColor);
    }
    const arcs = this.arcs;
    if (arcs) {
      for (let i = 0; i < F.strands.length; i++) {
        const flicker = reduceFlashing ? 1 : 0.75 + 0.25 * Math.sin(time * (23 + i * 7) + i);
        arcs.setEnergy(i, this.energy * flicker);
      }
      for (let k = 0; k < F.strikes; k++) {
        const life = this.strikeLife[k]!;
        if (life > 0) this.strikeLife[k] = Math.max(0, life - dt);
        arcs.setEnergy(F.strands.length + k, life > 0 ? (life / F.strikeLife) * 1.6 : 0);
      }
      arcs.sync();
    }
    if (this.pool) {
      this.pool.material.uniforms.uIntensity.value = TRAPS.glowPool.intensity * this.energy;
      this.pool.visible = this.energy > 0.01;
    }
  }

  protected disposeVisuals(): void {
    this.arcs?.dispose();
    this.coils?.dispose();
    if (this.coilMesh) {
      this.coilMesh.removeFromParent();
      this.coilMesh.geometry.dispose();
    }
    if (this.pool) {
      this.pool.removeFromParent();
      this.pool.geometry.dispose();
      this.pool.material.dispose();
    }
  }
}
