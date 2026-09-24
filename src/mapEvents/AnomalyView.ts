/**
 * Gravity anomaly look: floating debris (one lit InstancedMesh of metal shards that rise from the
 * floor, bob and tumble, then drop when it ends), a faint fresnel bubble, a ring on the floor and
 * motes drifting upwards (additive, volumetric layer). Built once at load (hidden; compiled with the
 * world), moved to each anomaly's center. Cosmetic randomness only (Math.random).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Points,
  Quaternion,
  Vector3,
  type Mesh,
  type ShaderMaterial,
  type SphereGeometry,
} from 'three';
import { GRAVITY } from '../defs/mapEvents';
import {
  MOTE_FRAGMENT,
  MOTE_VERTEX,
  createAdditiveMaterial,
  createProgressRing,
  createShell,
  toVolumetric,
} from '../maps/kit/energy';
import type { KitVisuals } from '../maps/kit/kitTypes';

const A = GRAVITY.anomaly;
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _axis = new Vector3();

export class AnomalyView {
  readonly group = new Group();
  private readonly debris: InstancedMesh;
  private readonly shell: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly ring: Mesh;
  private readonly motes: Points<BufferGeometry, ShaderMaterial>;
  /** Per piece: x, z (offset), lift, size, phase, spin axis (xyz), spin rate. */
  private readonly pieces: Float32Array;
  private readonly count: number;
  private radius = 1;
  private floorY = 0;
  /** 0..1 rise (debris up) and the shell fade. */
  private rise = 0;
  private active = false;
  private time = 0;

  constructor(private readonly visuals: KitVisuals) {
    const D = A.debris;
    this.count = D.count;
    this.group.name = 'gravity-anomaly';
    this.group.visible = false;
    visuals.root.add(this.group);
    const geo = new BoxGeometry(1, 1, 1);
    this.debris = new InstancedMesh(geo, visuals.materials.get(D.material), D.count);
    this.debris.name = 'prop:anomaly-debris';
    this.debris.castShadow = false;
    this.debris.receiveShadow = true;
    this.debris.frustumCulled = false;
    this.debris.userData.navIgnore = true;
    this.group.add(this.debris);
    this.pieces = new Float32Array(D.count * 9);
    this.shell = createShell(1, A.shell.color, A.shell.intensity, A.shell.rimPower, visuals.time);
    this.group.add(this.shell);
    this.ring = createProgressRing(1, 0.035, A.shell.color, A.shell.ring, visuals.time);
    (this.ring.material as ShaderMaterial).uniforms.uProgress!.value = 1;
    this.group.add(this.ring);

    const M = A.motes;
    const mg = new BufferGeometry();
    const seeds = new Float32Array(M.count * 4);
    for (let i = 0; i < M.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      seeds[i * 4] = Math.cos(a) * r;
      seeds[i * 4 + 1] = Math.sin(a) * r;
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = 0.6 + Math.random() * 0.8;
    }
    mg.setAttribute('position', new BufferAttribute(new Float32Array(M.count * 3), 3));
    mg.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    const mm = createAdditiveMaterial('kit-motes', MOTE_VERTEX, MOTE_FRAGMENT, {
      uCenter: { value: new Vector3() },
      uRadius: { value: 1 },
      uHeight: { value: 3 },
      uSpeed: { value: M.speed },
      uSize: { value: M.size * 400 },
      uTime: visuals.time,
      uScale: { value: 1 },
      uColor: {
        value: new Color(M.color[0] * M.intensity, M.color[1] * M.intensity, M.color[2] * M.intensity),
      },
      uOn: { value: 0 },
    });
    this.motes = toVolumetric(new Points(mg, mm));
    this.motes.name = 'kit-motes';
    // Motes are placed in world space by the shader (uCenter): keep them out of the moved group.
    visuals.root.add(this.motes);
    this.motes.visible = false;
  }

  /** Start at a floor point with the anomaly radius. */
  begin(center: Vector3, radius: number): void {
    this.radius = radius;
    this.floorY = center.y;
    this.group.position.copy(center);
    this.shell.scale.setScalar(radius);
    this.ring.scale.setScalar(radius);
    this.ring.position.y = 0.02;
    (this.shell.material.uniforms.uFloor as { value: number }).value = center.y;
    const mu = this.motes.material.uniforms;
    (mu.uCenter as { value: Vector3 }).value.copy(center);
    (mu.uRadius as { value: number }).value = radius * 0.85;
    (mu.uHeight as { value: number }).value = Math.min(radius, A.debris.lift[1] + 1.5);
    const D = A.debris;
    const p = this.pieces;
    for (let i = 0; i < this.count; i++) {
      const o = i * 9;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 0.85;
      p[o] = Math.cos(a) * r;
      p[o + 1] = Math.sin(a) * r;
      p[o + 2] = D.lift[0] + Math.random() * (D.lift[1] - D.lift[0]);
      p[o + 3] = D.size[0] + Math.random() * (D.size[1] - D.size[0]);
      p[o + 4] = Math.random() * Math.PI * 2;
      _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      p[o + 5] = _axis.x;
      p[o + 6] = _axis.y;
      p[o + 7] = _axis.z;
      p[o + 8] = (0.4 + Math.random()) * D.spin;
    }
    this.rise = 0;
    this.active = true;
    this.group.visible = true;
    this.motes.visible = true;
    this.group.updateMatrixWorld(true);
  }

  /** The anomaly collapses: debris drops, glows fade. */
  end(): void {
    this.active = false;
  }

  /** Hide at once (reset). */
  clear(): void {
    this.active = false;
    this.rise = 0;
    this.group.visible = false;
    this.motes.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Per frame; `strength` 0..1 of the zone (fade). */
  update(dt: number, strength: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    const D = A.debris;
    const rate = this.active ? 1 / D.rise : 1 / D.fall;
    this.rise = Math.min(1, Math.max(0, this.rise + (this.active ? rate : -rate) * dt));
    if (!this.active && this.rise <= 0 && strength <= 0.001) {
      this.clear();
      return;
    }
    const p = this.pieces;
    // Ease out rising, accelerate falling.
    const k = this.active ? 1 - (1 - this.rise) * (1 - this.rise) : this.rise * this.rise;
    for (let i = 0; i < this.count; i++) {
      const o = i * 9;
      const size = p[o + 3]!;
      const bob = Math.sin(this.time * D.bobRate * Math.PI * 2 + p[o + 4]!) * D.bob;
      const y = size / 2 + (p[o + 2]! + bob) * k;
      _p.set(p[o]!, y, p[o + 1]!);
      _axis.set(p[o + 5]!, p[o + 6]!, p[o + 7]!);
      _q.setFromAxisAngle(_axis, p[o + 4]! + this.time * p[o + 8]! * k);
      _s.set(size, size * 0.45, size * 0.8);
      _m.compose(_p, _q, _s);
      this.debris.setMatrixAt(i, _m);
    }
    this.debris.instanceMatrix.needsUpdate = true;
    const glow = Math.min(strength, this.rise + (this.active ? 0 : strength));
    (this.shell.material.uniforms.uIntensity as { value: number }).value = A.shell.intensity * glow;
    (this.ring.material as ShaderMaterial).uniforms.uIntensity!.value = A.shell.ring * glow;
    (this.motes.material.uniforms.uOn as { value: number }).value = glow;
    this.shell.visible = glow > 0.01;
    this.ring.visible = glow > 0.01;
    this.group.updateMatrixWorld(true);
  }

  get floor(): number {
    return this.floorY;
  }

  get size(): number {
    return this.radius;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.motes.removeFromParent();
    this.debris.geometry.dispose();
    this.debris.dispose();
    this.shell.geometry.dispose();
    this.shell.material.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as ShaderMaterial).dispose();
    this.motes.geometry.dispose();
    this.motes.material.dispose();
  }

  /** Visuals context (reduced flashing is irrelevant here; kept for symmetry). */
  get context(): KitVisuals {
    return this.visuals;
  }
}
