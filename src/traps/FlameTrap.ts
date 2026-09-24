/**
 * Flame vent ("Flammenschlot"): a floor grate that jets fire upwards in pulses while active. Each
 * cycle telegraphs (the grate glows and hisses), then burns: enemies and the player inside the
 * column take fire damage every TRAPS.flame.tickInterval (enemies build up burn); embers rise.
 */
import { Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { TRAPS, type FlameSlotDef } from '../defs/traps';
import { createLightPool, type PoolMaterial } from '../interactables/visuals/holo';
import { createFlameColumn } from '../maps/kit/energy';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { Trap, type TrapContext } from './Trap';
import { flamePhase, inColumn } from './trapMath';

const F = TRAPS.flame;
const UP = { x: 0, y: 1, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

type Phase = 'off' | 'warn' | 'burn' | 'pause';

export class FlameTrap extends Trap {
  private readonly base = new Vector3();
  private readonly height: number;
  private readonly radius: number;
  private phase: Phase = 'off';
  private tickTimer = 0;
  private emberTimer = 0;
  private hitSoundTimer = 0;
  private burst = 0;
  private readonly glow: MeshStandardMaterial | null = null;
  private readonly column: Mesh | null = null;
  private readonly pool: Mesh<import('three').PlaneGeometry, PoolMaterial> | null = null;
  private readonly meshes: Mesh[] = [];

  constructor(slot: FlameSlotDef, ctx: TrapContext) {
    const [x, y, z] = slot.position;
    const height = slot.height ?? F.height;
    super(slot, ctx, { x, y: y + height * 0.3, z });
    this.base.set(x, y, z);
    this.height = height;
    this.radius = slot.radius ?? F.radius;
    const v = ctx.visuals;
    const props = ctx.props;
    if (!v || !props) return;

    // Grate: frame, slats and the burner trough below (glows before and during a burst).
    const G = F.grate;
    const s = G.size;
    props.setFrame(x, y, z, 0);
    props.box('trim_metal', 0, G.depth / 2, s / 2 - G.frame / 2, s, G.depth, G.frame);
    props.box('trim_metal', 0, G.depth / 2, -s / 2 + G.frame / 2, s, G.depth, G.frame);
    props.box('trim_metal', s / 2 - G.frame / 2, G.depth / 2, 0, G.frame, G.depth, s - G.frame * 2);
    props.box('trim_metal', -s / 2 + G.frame / 2, G.depth / 2, 0, G.frame, G.depth, s - G.frame * 2);
    props.box('painted_hazard', 0, 0.004, 0, s + 0.3, 0.008, s + 0.3);
    for (let i = 0; i < G.slats; i++) {
      const u = -s / 2 + G.frame + ((i + 0.5) * (s - G.frame * 2)) / G.slats;
      props.box('pillar_metal', u, G.depth * 0.6, 0, 0.035, G.depth * 0.8, s - G.frame * 2);
    }
    this.glow = new MeshStandardMaterial({
      name: `trap-flame-glow:${slot.id}`,
      color: 0x050607,
      roughness: 0.5,
      metalness: 0,
      emissive: new Color(F.flameColor[0], F.flameColor[1], F.flameColor[2]),
      emissiveIntensity: 0,
    });
    v.setupMaterial(this.glow);
    const trough = new PropBuilder();
    trough.setFrame(x, y, z, 0);
    trough.box('g', 0, 0.012, 0, s - G.frame * 2, 0.01, s - G.frame * 2);
    const m = trough.mesh('g', this.glow, v.root, false);
    if (m) this.meshes.push(m);
    trough.dispose();

    const column = createFlameColumn(this.radius, height, F.flameColor, F.coreColor, F.flameIntensity, v.time);
    column.position.set(x, y, z);
    column.updateMatrixWorld();
    v.root.add(column);
    this.column = column;
    const pool = createLightPool(F.flameColor, 0, TRAPS.glowPool.radius * 1.3);
    pool.position.set(x, y + pool.position.y, z);
    pool.updateMatrixWorld();
    v.root.add(pool);
    this.pool = pool;
  }

  protected onActivate(): void {
    this.phase = 'pause';
    this.tickTimer = 0;
  }

  protected onDeactivate(): void {
    this.phase = 'off';
  }

  protected override onReset(): void {
    this.burst = 0;
  }

  protected tickActive(dt: number): void {
    this.hitSoundTimer -= dt;
    const phase = flamePhase(this.activeTime, F.burnTime, F.pauseTime, F.warnTime);
    this.phase = phase;
    if (phase !== 'burn') return;
    this.tickTimer -= dt;
    if (this.tickTimer > 0) return;
    this.tickTimer += F.tickInterval;
    const targets = this.queryEnemies(this.center, this.height);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (!inColumn(t.boundsCenter, this.base, this.radius + t.boundsRadius * 0.5, this.height)) continue;
      this.hurt(t, F.damagePerTick, 'fire', 'beam', t.aimPoint, 0, 1, 0, 0, F.statusBuildup);
      if (this.hitSoundTimer <= 0) {
        this.hitSoundTimer = F.hitSoundInterval;
        this.ctx.audio?.play(F.audio.hit, { position: t.aimPoint, volume: F.audio.hitGain, pitchVariance: 0.1 });
      }
    }
    const player = this.ctx.player;
    if (player && player.alive && inColumn(player.position, this.base, this.radius, this.height)) {
      _dir.x = this.base.x - player.position.x;
      _dir.y = 0;
      _dir.z = this.base.z - player.position.z;
      player.damage(F.playerDamagePerTick, _dir, 'generic');
    }
  }

  protected updateVisual(dt: number, time: number, reduceFlashing: boolean): void {
    const burning = this.state === 'active' && this.phase === 'burn';
    const target = burning ? 1 : 0;
    // Fast ignition, quick collapse.
    this.burst += (target - this.burst) * Math.min(1, dt * (burning ? 9 : 6));
    if (this.burst < 0.003) this.burst = 0;
    if (this.column) {
      const u = (this.column.material as import('three').ShaderMaterial).uniforms;
      (u.uBurst as { value: number }).value = this.burst;
      this.column.visible = this.burst > 0.01;
    }
    if (this.glow) {
      let k = 0;
      if (this.state === 'active') {
        if (this.phase === 'burn') k = 6;
        else if (this.phase === 'warn') k = reduceFlashing ? 3 : 2 + 2.5 * (0.5 + 0.5 * Math.sin(time * 22));
        else k = 0.6;
      } else if (this.state === 'cooldown') {
        k = 0.25;
      }
      this.glow.emissiveIntensity = Math.max(k, this.burst * 6);
    }
    if (this.pool) {
      this.pool.material.uniforms.uIntensity.value = TRAPS.glowPool.intensity * 1.6 * this.burst;
      this.pool.visible = this.burst > 0.01;
    }
    if (burning) {
      this.emberTimer -= dt;
      if (this.emberTimer <= 0) {
        this.emberTimer = 0.12;
        this.ctx.vfx?.spawn(F.emberEffect, this.base, UP, 1);
      }
    }
  }

  protected disposeVisuals(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.glow?.dispose();
    if (this.column) {
      this.column.removeFromParent();
      this.column.geometry.dispose();
      (this.column.material as import('three').Material).dispose();
    }
    if (this.pool) {
      this.pool.removeFromParent();
      this.pool.geometry.dispose();
      this.pool.material.dispose();
    }
  }
}
