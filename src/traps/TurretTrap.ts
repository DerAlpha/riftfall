/**
 * Sentry turret ("Geschützturm"), hung from a ceiling or standing on the floor. Active: it boots
 * (the head swings level), picks the nearest enemy in line of sight within range (re-evaluated
 * every TRAPS.turret.retargetInterval, a few LOS rays per search), slews towards it at limited
 * yaw / pitch rates and fires hitscan bursts once on target – tracers, flash light, sparks through
 * combat:impact, damage through CombatWorld (source 'trap', head shots count). Without a target it
 * sweeps around its rest yaw. A red laser sight shows where it aims; the sensor eye shows the state.
 */
import type { Mesh } from 'three';
import { Color, Group, MeshStandardMaterial, Vector3, type Material } from 'three';
import type { Damageable } from '../core/contracts';
import type { GameEvents, HitZone, SurfaceType, FleshSurface } from '../core/events';
import { DEG2RAD } from '../core/math';
import { TRAPS, type TurretSlotDef } from '../defs/traps';
import { ArcBundle } from '../maps/kit/energy';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { Trap, type TrapContext } from './Trap';
import { aimAt, aimDirection, slewAngle, wrapAngle, type Aim } from './trapMath';

const T = TRAPS.turret;
const M = T.model;
const _aim: Aim = { yaw: 0, pitch: 0 };
const _dir = new Vector3();
const _muzzle = new Vector3();
const _end = new Vector3();
const _hitPoint = new Vector3();
const _hitNormal = new Vector3();

export class TurretTrap extends Trap {
  /** Pitch pivot (world): the aim origin. */
  private readonly pivot = new Vector3();
  private readonly restYaw: number;
  private readonly range: number;
  private readonly down: number;
  private yaw: number;
  private pitch: number;
  private target: Damageable | null = null;
  private targetDistance = 0;
  private retarget = 0;
  private fireTimer = 0;
  private burstLeft: number = T.burst.shots;
  private boot = 0;
  private sweep = 0;
  private recoil = 0;
  private muzzleGlow = 0;
  private readonly impact: GameEvents['combat:impact'] = {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 'metal',
    kind: 'bullet',
    weaponId: '',
    decal: true,
  };
  // --- visuals ---
  private readonly yawGroup: Group | null = null;
  private readonly pitchGroup: Group | null = null;
  private readonly barrels: Group | null = null;
  private readonly eye: MeshStandardMaterial | null = null;
  private readonly flashMat: MeshStandardMaterial | null = null;
  private readonly laser: ArcBundle | null = null;
  private readonly ownedMaterials: Material[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly eyeColor = new Color();

  constructor(slot: TurretSlotDef, ctx: TrapContext) {
    const [x, y, z] = slot.position;
    const down = slot.mount === 'ceiling' ? -1 : 1;
    const ringY = y + down * (M.plate[1] + M.rod.length + M.ring.height);
    const pivotY = ringY + down * M.yoke[1] * 0.7;
    super(slot, ctx, { x, y: pivotY, z });
    this.down = down;
    this.pivot.set(x, pivotY, z);
    this.restYaw = slot.yawDeg * DEG2RAD;
    this.range = slot.range ?? T.range;
    this.yaw = this.restYaw;
    this.pitch = this.restPitch;
    this.impact.weaponId = this.weaponId;
    const v = ctx.visuals;
    const props = ctx.props;
    if (!v || !props) return;

    // Static mount: plate + drop rod + bearing ring (merged with the other trap bodies).
    props.setFrame(x, y, z, this.restYaw);
    props.box('pillar_metal', 0, (down * M.plate[1]) / 2, 0, M.plate[0], M.plate[1], M.plate[2]);
    props.box('painted_hazard', 0, down * (M.plate[1] + 0.01), 0, M.plate[0] * 0.7, 0.02, M.plate[2] * 0.7);
    props.cylinder(
      'trim_metal',
      0,
      down * (M.plate[1] + M.rod.length / 2),
      0,
      M.rod.radius,
      M.rod.length,
      'y',
      12,
    );
    props.cylinder(
      'pillar_metal',
      0,
      down * (M.plate[1] + M.rod.length + M.ring.height / 2),
      0,
      M.ring.radius,
      M.ring.height,
      'y',
      20,
    );

    const mats = v.materials;
    const body = mats.get('pillar_metal');
    const trim = mats.get('trim_metal');
    const hazard = mats.get('painted_hazard');
    this.eye = this.glow(`trap-turret-eye:${slot.id}`, T.eyeColor, T.eyeIntensity.ready);
    this.flashMat = this.glow(`trap-turret-flash:${slot.id}`, [1, 0.62, 0.25], 0);
    v.setupMaterial(this.eye);
    v.setupMaterial(this.flashMat);

    const yawGroup = new Group();
    yawGroup.name = `trap-turret:${slot.id}`;
    yawGroup.position.set(x, ringY, z);
    v.root.add(yawGroup);
    const pitchGroup = new Group();
    pitchGroup.position.set(0, down * M.yoke[1] * 0.7, 0);
    yawGroup.add(pitchGroup);
    const barrels = new Group();
    pitchGroup.add(barrels);

    // Yoke: two side arms + the crossbar at the bearing.
    const yoke = new PropBuilder();
    const [yw, yh, yd] = M.yoke;
    yoke.box('b', 0, (down * 0.06) / 2, 0, yw, 0.06, yd);
    yoke.box('b', -yw / 2 + 0.03, (down * yh) / 2, 0, 0.06, yh, yd);
    yoke.box('b', yw / 2 - 0.03, (down * yh) / 2, 0, 0.06, yh, yd);
    this.keep(yoke.mesh('b', body, yawGroup, true));
    yoke.dispose();

    // Head: armored body with hazard cheeks, sensor eye, twin barrels.
    const head = new PropBuilder();
    const [hw, hh, hd] = M.head;
    head.box('body', 0, 0, 0, hw * 0.78, hh, hd);
    head.box('body', 0, hh * 0.18, -hd * 0.08, hw * 0.62, hh * 0.5, hd * 0.9);
    head.box('trim', 0, 0, 0, hw, hh * 0.3, hd * 0.55);
    head.box('hazard', 0, -hh / 2 - 0.005, hd * 0.1, hw * 0.5, 0.01, hd * 0.5);
    head.box('trim', 0, hh * 0.1, hd / 2 + 0.05, hw * 0.4, hh * 0.35, 0.12);
    this.keep(head.mesh('body', body, pitchGroup, true));
    this.keep(head.mesh('trim', trim, pitchGroup, false));
    this.keep(head.mesh('hazard', hazard, pitchGroup, false));
    head.dispose();
    const eyeB = new PropBuilder();
    eyeB.cylinder('eye', 0, hh * 0.2, -hd / 2 - 0.004, M.eye.radius, 0.02, 'z', 16);
    this.keep(eyeB.mesh('eye', this.eye, pitchGroup, false));
    eyeB.dispose();
    const bar = new PropBuilder();
    const B = M.barrel;
    for (const s of [-1, 1]) {
      bar.cylinder('b', (s * B.spacing) / 2, -hh * 0.12, -hd / 2 - B.length / 2, B.radius, B.length, 'z', 10);
      bar.cylinder('b', (s * B.spacing) / 2, -hh * 0.12, -hd / 2 - 0.06, B.radius * 1.6, 0.12, 'z', 10);
    }
    this.keep(bar.mesh('b', trim, barrels, false));
    for (const s of [-1, 1])
      bar.cylinder(
        'f',
        (s * B.spacing) / 2,
        -hh * 0.12,
        -hd / 2 - B.length - 0.005,
        B.radius * 0.8,
        0.01,
        'z',
        10,
      );
    this.keep(bar.mesh('f', this.flashMat, barrels, false));
    bar.dispose();
    for (const m of this.meshes) m.matrixAutoUpdate = true;

    this.laser = new ArcBundle({
      count: 1,
      segments: 1,
      width: T.laser.width * 4,
      core: 0.25,
      jitter: 0,
      jitterRate: 0,
      coreColor: T.laser.color,
      glowColor: T.laser.color,
      intensity: T.laser.intensity,
      time: v.time,
      flicker: 0.05,
      name: `trap-turret-laser:${slot.id}`,
    });
    v.root.add(this.laser.mesh);
    this.yawGroup = yawGroup;
    this.pitchGroup = pitchGroup;
    this.barrels = barrels;
    this.applyPose();
  }

  /** Parked pose: the head points down (ceiling) / level (floor) while off. */
  private get restPitch(): number {
    return this.down < 0 ? T.pitchMinDeg * DEG2RAD * 0.6 : 0;
  }

  protected onActivate(): void {
    this.boot = T.bootTime;
    this.target = null;
    this.retarget = 0;
    this.burstLeft = T.burst.shots;
    this.fireTimer = 0;
    this.sweep = 0;
  }

  protected onDeactivate(): void {
    this.target = null;
  }

  protected override onReset(): void {
    this.yaw = this.restYaw;
    this.pitch = this.restPitch;
    this.recoil = 0;
    this.muzzleGlow = 0;
    this.applyPose();
  }

  protected tickActive(dt: number): void {
    this.boot = Math.max(0, this.boot - dt);
    this.retarget -= dt;
    const t = this.target;
    if (t && (!t.alive || t.team !== 'enemy')) this.target = null;
    if (this.retarget <= 0 || this.target === null) {
      this.retarget = T.retargetInterval;
      this.target = this.findTarget();
    }
    // Desired aim: the target, else a slow sweep around the rest yaw, head level.
    const target = this.target;
    let wantYaw: number;
    let wantPitch: number;
    if (target && this.boot <= 0) {
      aimAt(this.pivot, target.aimPoint, _aim);
      wantYaw = _aim.yaw;
      wantPitch = _aim.pitch;
      this.targetDistance = this.pivot.distanceTo(target.aimPoint);
    } else {
      this.sweep += dt;
      const S = T.sweep;
      wantYaw = this.restYaw + Math.sin(this.sweep * S.rate) * S.amplitudeDeg * DEG2RAD;
      wantPitch = this.down < 0 ? T.pitchMinDeg * DEG2RAD * 0.25 : 0;
    }
    wantPitch = Math.min(T.pitchMaxDeg * DEG2RAD, Math.max(T.pitchMinDeg * DEG2RAD, wantPitch));
    this.yaw = slewAngle(this.yaw, wantYaw, T.yawRateDeg * DEG2RAD * dt);
    this.pitch = slewAngle(this.pitch, wantPitch, T.pitchRateDeg * DEG2RAD * dt);

    if (!target || this.boot > 0) return;
    const tol = T.aimToleranceDeg * DEG2RAD;
    const onTarget =
      Math.abs(wrapAngle(wantYaw - this.yaw)) < tol && Math.abs(wrapAngle(wantPitch - this.pitch)) < tol;
    this.fireTimer -= dt;
    while (onTarget && this.fireTimer <= 0) {
      if (this.burstLeft <= 0) {
        this.burstLeft = T.burst.shots;
        this.fireTimer += T.burst.pause;
        continue;
      }
      this.shoot();
      this.burstLeft--;
      this.fireTimer += 60 / T.burst.rpm;
    }
    if (!onTarget && this.fireTimer < 0) this.fireTimer = 0;
  }

  /** Nearest enemy within range and pitch limits with line of sight (a few rays per search). */
  private findTarget(): Damageable | null {
    const list = this.queryEnemies(this.pivot, this.range);
    const pMin = T.pitchMinDeg * DEG2RAD;
    const pMax = T.pitchMaxDeg * DEG2RAD;
    let checks = 0;
    let lastDist = -1;
    while (checks < T.losChecks) {
      // Next nearest beyond the last checked distance (no sort, no allocation).
      let best: Damageable | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < list.length; i++) {
        const c = list[i]!;
        const d = this.pivot.distanceTo(c.aimPoint);
        if (d <= lastDist || d >= bestD || d > this.range) continue;
        aimAt(this.pivot, c.aimPoint, _aim);
        if (_aim.pitch < pMin || _aim.pitch > pMax) continue;
        best = c;
        bestD = d;
      }
      if (!best) return null;
      checks++;
      lastDist = bestD;
      if (this.ctx.combat.lineOfSight(this.pivot, best.aimPoint)) return best;
    }
    return null;
  }

  private shoot(): void {
    const rng = this.ctx.rng;
    const spread = T.spreadDeg * DEG2RAD;
    const yaw = this.yaw + (rng.next() * 2 - 1) * spread;
    const pitch = this.pitch + (rng.next() * 2 - 1) * spread;
    aimDirection(yaw, pitch, _dir);
    _muzzle.copy(this.pivot).addScaledVector(_dir, M.head[2] / 2 + M.barrel.length);
    const hit = this.ctx.combat.raycast(_muzzle, _dir, this.range);
    // Copy the shared hit before anything emits or raycasts again.
    let target: Damageable | null = null;
    let zone: HitZone = 'body';
    let surface: SurfaceType | FleshSurface = 'metal';
    if (hit) {
      _hitPoint.copy(hit.point);
      _hitNormal.copy(hit.normal);
      target = hit.target;
      zone = hit.zone ?? 'body';
      surface = hit.surface;
      _end.copy(_hitPoint);
    } else {
      _end.copy(_muzzle).addScaledVector(_dir, this.range);
    }
    const vfx = this.ctx.vfx;
    vfx?.tracer(_muzzle, _end, T.tracerColor);
    vfx?.lights?.flash(T.flash, _muzzle, null);
    this.ctx.audio?.play(T.fireSound, {
      position: _muzzle,
      volume: T.fireGain,
      pitchVariance: 0.06,
      bus: 'sfx',
    });
    this.recoil = M.recoil;
    this.muzzleGlow = 1;
    if (!hit) return;
    if (target && target.team === 'enemy') {
      const mult = zone === 'head' || zone === 'weakpoint' ? T.headMultiplier : 1;
      this.hurt(
        target,
        T.damage * mult,
        'physical',
        'bullet',
        _hitPoint,
        _dir.x,
        _dir.y,
        _dir.z,
        T.impulse,
        0,
        zone,
      );
    }
    const p = this.impact;
    p.point.x = _hitPoint.x;
    p.point.y = _hitPoint.y;
    p.point.z = _hitPoint.z;
    p.normal.x = _hitNormal.x;
    p.normal.y = _hitNormal.y;
    p.normal.z = _hitNormal.z;
    p.surface = surface;
    p.decal = target === null;
    this.ctx.events.emit('combat:impact', p);
  }

  protected updateVisual(dt: number, time: number, reduceFlashing: boolean): void {
    if (!this.yawGroup) return;
    if (this.state !== 'active') {
      // Park slowly (off / cooling down).
      this.yaw = slewAngle(this.yaw, this.restYaw, T.yawRateDeg * DEG2RAD * dt * 0.25);
      this.pitch = slewAngle(this.pitch, this.restPitch, T.pitchRateDeg * DEG2RAD * dt * 0.25);
    }
    this.recoil = Math.max(0, this.recoil - this.recoil * Math.min(1, dt * M.recoilReturn));
    this.muzzleGlow = Math.max(0, this.muzzleGlow - dt * M.recoilReturn);
    this.applyPose();
    if (this.eye) {
      const I = T.eyeIntensity;
      const active = this.state === 'active';
      const c = active || this.powered ? T.eyeColor : TRAPS.panel.colors.unpowered;
      this.eyeColor.setRGB(c[0], c[1], c[2]);
      this.eye.emissive.copy(this.eyeColor);
      const blink = active && this.target === null && !reduceFlashing ? 0.75 + 0.25 * Math.sin(time * 9) : 1;
      this.eye.emissiveIntensity =
        (active ? I.active : this.state === 'cooldown' ? I.cooldown : I.ready) * blink;
    }
    if (this.flashMat) this.flashMat.emissiveIntensity = this.muzzleGlow * T.flash.intensity * 2;
    const laser = this.laser;
    if (laser) {
      const on = this.state === 'active' && this.boot <= 0;
      if (on) {
        aimDirection(this.yaw, this.pitch, _dir);
        _muzzle.copy(this.pivot).addScaledVector(_dir, M.head[2] / 2);
        const len = this.target ? Math.min(T.laser.length, this.targetDistance) : T.laser.length;
        _end.copy(_muzzle).addScaledVector(_dir, len);
        laser.set(0, _muzzle, _end, this.target ? 1 : 0.45);
      } else {
        laser.setEnergy(0, 0);
      }
      laser.sync();
    }
  }

  private applyPose(): void {
    if (!this.yawGroup || !this.pitchGroup) return;
    this.yawGroup.rotation.y = this.yaw;
    this.pitchGroup.rotation.x = this.pitch;
    if (this.barrels) this.barrels.position.z = this.recoil;
    this.yawGroup.updateMatrixWorld(true);
  }

  private glow(
    name: string,
    color: readonly [number, number, number],
    intensity: number,
  ): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
      name,
      color: 0x050607,
      roughness: 0.3,
      metalness: 0,
      emissive: new Color(color[0], color[1], color[2]),
      emissiveIntensity: intensity,
    });
    this.ownedMaterials.push(m);
    return m;
  }

  private keep(m: Mesh | null): void {
    if (m) this.meshes.push(m);
  }

  protected disposeVisuals(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.meshes.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.yawGroup?.removeFromParent();
    this.laser?.dispose();
  }
}
