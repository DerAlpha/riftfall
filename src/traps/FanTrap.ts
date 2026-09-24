/**
 * Ventilation rotor ("Ventilator"): a wall (or floor) fan unit. Active: the rotor spins up; every
 * TRAPS.fan.pullInterval enemies inside the pull cylinder in front of the intake are shoved towards
 * the rotor (knockback impulses, stronger near the intake) and those that reach the blades are
 * shredded (heavy damage, gore, a grinding hit). Wind streaks flow into the intake; warning strips
 * glow while it runs. The player is not pulled (the character controller has no external forces).
 */
import type { Mesh} from 'three';
import { Color, Group, MeshStandardMaterial, Matrix4, Quaternion, Vector3, type InstancedBufferGeometry, type ShaderMaterial } from 'three';
import { TRAPS, type FanSlotDef } from '../defs/traps';
import { createStreaks } from '../maps/kit/energy';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { facingNormal, propBox, propNavBox } from '../interactables/shapes';
import { SolidBlocker } from '../interactables/SolidBlocker';
import { Trap, type TrapContext } from './Trap';
import { fanSample, type FanSample } from './trapMath';

const F = TRAPS.fan;
const _s: FanSample = { axial: 0, radial: 0, inside: false };
const _q = new Quaternion();
const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _z = new Vector3(0, 0, 1);

export class FanTrap extends Trap {
  /** Rotor hub (in front of the housing face) and the intake normal. */
  private readonly hub = new Vector3();
  private readonly normal = new Vector3();
  private readonly radius: number;
  private readonly reach: number;
  private readonly queryCenter = new Vector3();
  private spin = 0;
  private angle = 0;
  private pullTimer = 0;
  private hitSoundTimer = 0;
  private goreTimer = 0;
  private readonly rotor: Group | null = null;
  private readonly warn: MeshStandardMaterial | null = null;
  private readonly streaks: Mesh<InstancedBufferGeometry, ShaderMaterial> | null = null;
  private readonly meshes: Mesh[] = [];
  private readonly blocker: SolidBlocker | null = null;

  constructor(slot: FanSlotDef, ctx: TrapContext) {
    const n =
      slot.facing === 'up'
        ? { x: 0, y: 1, z: 0 }
        : { x: facingNormal(slot.facing).x, y: 0, z: facingNormal(slot.facing).z };
    const [x, y, z] = slot.position;
    const depth = F.depth;
    super(slot, ctx, { x: x + n.x * depth, y: y + n.y * depth, z: z + n.z * depth });
    this.normal.set(n.x, n.y, n.z);
    this.hub.set(x + n.x * depth * 0.6, y + n.y * depth * 0.6, z + n.z * depth * 0.6);
    this.radius = slot.radius ?? F.radius;
    this.reach = slot.reach ?? F.reach;
    this.queryCenter.copy(this.hub).addScaledVector(this.normal, this.reach / 2);
    const size = (slot.radius ?? F.radius) * 2 + F.frame * 2;
    if (ctx.blockers && slot.facing !== 'up') {
      // The housing sticks out of the wall: solid for the player, bullets and the navmesh.
      const box = propBox({ x: x + n.x * (depth / 2), y: y - size / 2, z: z + n.z * (depth / 2) }, 0, size, size, depth);
      const across = Math.abs(n.x) > 0.5;
      const half = { x: across ? depth / 2 : size / 2, y: size / 2, z: across ? size / 2 : depth / 2 };
      const solid = { center: box.center, half };
      this.blocker = new SolidBlocker(
        ctx.blockers,
        { collider: solid, bullets: { box: solid, materialId: 'pillar_metal' }, nav: propNavBox(solid) },
        true,
      );
    }
    const v = ctx.visuals;
    const props = ctx.props;
    if (!v || !props) return;

    // Housing: a square duct box protruding from the wall, frame, hazard ring, grille bars.
    _q.setFromUnitVectors(_z, this.normal);
    _m.compose(new Vector3(x, y, z), _q, _one);
    props.setMatrix(_m);
    const R = this.radius;
    const s = R * 2 + F.frame * 2;
    const fr = F.frame;
    // Duct walls (local +Z = out of the wall).
    props.box('pillar_metal', 0, s / 2 - fr / 2, depth / 2, s, fr, depth);
    props.box('pillar_metal', 0, -s / 2 + fr / 2, depth / 2, s, fr, depth);
    props.box('pillar_metal', s / 2 - fr / 2, 0, depth / 2, fr, s - fr * 2, depth);
    props.box('pillar_metal', -s / 2 + fr / 2, 0, depth / 2, fr, s - fr * 2, depth);
    props.box('painted_hazard', 0, s / 2 - fr / 2, depth + 0.01, s, fr * 0.6, 0.02);
    props.box('painted_hazard', 0, -s / 2 + fr / 2, depth + 0.01, s, fr * 0.6, 0.02);
    // Back plate (dark) and the motor behind the hub.
    props.box('wall_panel_dark', 0, 0, 0.02, s - fr * 2, s - fr * 2, 0.04);
    props.cylinder('trim_metal', 0, 0, depth * 0.3, R * 0.22, depth * 0.45, 'z', 16);
    // Grille bars across the intake.
    for (let i = 0; i < F.grilleBars; i++) {
      const u = -R + ((i + 0.5) * (R * 2)) / F.grilleBars;
      props.box('trim_metal', u, 0, depth - 0.02, 0.025, s - fr * 2, 0.025);
    }

    // Rotor: blades around the hub (spins about the intake normal).
    const rotor = new Group();
    rotor.position.copy(this.hub);
    rotor.quaternion.copy(_q);
    v.root.add(rotor);
    const blades = new PropBuilder();
    for (let i = 0; i < F.blades; i++) {
      const a = (i / F.blades) * Math.PI * 2;
      _m.makeRotationZ(a);
      blades.setMatrix(_m);
      // Twisted blade: a thin plate tilted about its long axis.
      const blade = new Matrix4().makeRotationY(0.45);
      blades.setMatrix(_m.clone().multiply(blade));
      blades.box('blade', R * 0.55, 0, 0, R * 0.82, R * 0.26, 0.02);
    }
    blades.setMatrix(new Matrix4());
    blades.cylinder('hub', 0, 0, 0, R * 0.2, 0.12, 'z', 16);
    const mats = v.materials;
    this.keep(blades.mesh('blade', mats.get('trim_metal'), rotor, true));
    this.keep(blades.mesh('hub', mats.get('pillar_metal'), rotor, false));
    blades.dispose();
    for (const m of this.meshes) m.matrixAutoUpdate = true;

    // Warning strips on the frame sides (glow in the state color).
    this.warn = new MeshStandardMaterial({
      name: `trap-fan-warn:${slot.id}`,
      color: 0x050607,
      roughness: 0.35,
      metalness: 0,
      emissive: new Color(F.warnColor[0], F.warnColor[1], F.warnColor[2]),
      emissiveIntensity: 0,
    });
    v.setupMaterial(this.warn);
    const strips = new PropBuilder();
    strips.setMatrix(new Matrix4().compose(new Vector3(x, y, z), _q, _one));
    strips.box('w', s / 2 + 0.01, 0, depth - 0.05, 0.02, s * 0.7, 0.04);
    strips.box('w', -s / 2 - 0.01, 0, depth - 0.05, 0.02, s * 0.7, 0.04);
    this.keep(strips.mesh('w', this.warn, v.root, false));
    strips.dispose();

    this.streaks = createStreaks({
      count: F.streaks,
      center: this.hub,
      normal: this.normal,
      reach: this.reach,
      radius: R + F.pullMargin,
      speed: F.streakSpeed,
      length: F.streakLength,
      color: F.streakColor,
      intensity: F.streakIntensity,
      time: v.time,
      seed: slot.id.length + 7,
    });
    v.root.add(this.streaks);
    this.rotor = rotor;
  }

  protected onActivate(): void {
    this.pullTimer = F.spinUp * 0.5;
  }

  protected onDeactivate(): void {}

  protected override onReset(): void {
    this.spin = 0;
  }

  protected tickActive(dt: number): void {
    this.hitSoundTimer -= dt;
    this.goreTimer -= dt;
    this.pullTimer -= dt;
    if (this.pullTimer > 0) return;
    this.pullTimer += F.pullInterval;
    const spin = Math.min(1, this.activeTime / F.spinUp);
    const targets = this.queryEnemies(this.queryCenter, this.reach / 2 + this.radius + F.pullMargin);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      fanSample(t.boundsCenter, this.hub, this.normal, this.reach, this.radius + F.pullMargin, _s);
      if (!_s.inside) continue;
      const c = t.boundsCenter;
      const dx = this.hub.x - c.x;
      const dz = this.hub.z - c.z;
      if (_s.axial <= F.shredRange + t.boundsRadius * 0.5 && _s.radial <= this.radius + t.boundsRadius) {
        this.hurt(t, F.shredDamage * spin, 'physical', 'melee', t.aimPoint, dx, 0, dz, F.pullImpulse * 0.3 * spin);
        if (this.goreTimer <= 0) {
          this.goreTimer = F.hitSoundInterval;
          this.ctx.vfx?.spawn(F.gore, t.aimPoint, this.normal, 1.3);
        }
        if (this.hitSoundTimer <= 0) {
          this.hitSoundTimer = F.hitSoundInterval;
          this.ctx.audio?.play(F.audio.hit, { position: t.aimPoint, volume: F.audio.hitGain, pitchVariance: 0.1 });
        }
      } else {
        const k = 1 - Math.min(1, _s.axial / this.reach) * 0.6;
        this.hurt(t, F.pullDamage * spin, 'physical', 'beam', t.aimPoint, dx, 0, dz, F.pullImpulse * k * spin);
      }
    }
  }

  protected updateVisual(dt: number, time: number, reduceFlashing: boolean): void {
    const on = this.state === 'active';
    const rate = on ? 1 / F.spinUp : -1 / F.spinDown;
    this.spin = Math.min(1, Math.max(0, this.spin + rate * dt));
    this.angle = (this.angle + this.spin * F.rps * Math.PI * 2 * dt) % (Math.PI * 2);
    if (this.rotor) {
      this.rotor.rotation.set(0, 0, 0);
      this.rotor.quaternion.setFromUnitVectors(_z, this.normal);
      this.rotor.rotateZ(this.angle);
      this.rotor.updateMatrixWorld(true);
    }
    if (this.warn) {
      const blink = reduceFlashing ? 0.8 : 0.5 + 0.5 * Math.sin(time * 8);
      this.warn.emissiveIntensity = on ? F.warnIntensity * blink : this.state === 'cooldown' ? F.warnIntensity * 0.08 : 0;
    }
    if (this.streaks) {
      const u = this.streaks.material.uniforms.uOn as { value: number };
      u.value = this.spin * this.spin;
      this.streaks.visible = this.spin > 0.02;
    }
  }

  private keep(m: Mesh | null): void {
    if (m) this.meshes.push(m);
  }

  protected disposeVisuals(): void {
    this.blocker?.dispose();
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.meshes.length = 0;
    this.warn?.dispose();
    this.rotor?.removeFromParent();
    if (this.streaks) {
      this.streaks.removeFromParent();
      this.streaks.geometry.dispose();
      this.streaks.material.dispose();
    }
  }
}
