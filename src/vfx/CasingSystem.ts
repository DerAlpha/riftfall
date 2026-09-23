/**
 * Ejected shell casings: pooled, instanced (one InstancedMesh per casing mesh kind – brass
 * cartridge cases, red shotgun hulls), lit world geometry with cheap CPU physics (CasingSim).
 * Collision: one floor probe at ejection plus a ray along the velocity every
 * VFX.casings.probeInterval frames per casing (staggered), through PhysicsApi.raycast.
 * Bounces fast enough call `onClink(position, soundId, impactSpeed)` – wire it to
 * AudioEventBridge.playCasing(soundId, position, impactSpeed).
 */
import * as THREE from 'three';
import type { PhysicsApi, RaycastOptions, RenderApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { DEG2RAD } from '../core/math';
import { interactionGroups } from '../defs/physics';
import { CASINGS, VFX, type CasingDef, type CasingMesh } from '../defs/vfx';
import { CasingSim, createCasingSpawn, type CasingBounce } from './CasingSim';
import { lerpRange, sampleCone, type Rand } from './emit';
import { setUpdateRange, type UpdateRange } from './gpuUpload';

/** Casing bounce: world position, CasingDef.clinkSound, impact speed into the surface (m/s). */
export type ClinkCallback = (position: Vec3Like, sound: string, impactSpeed: number) => void;

const PROBE_GROUPS = interactionGroups(VFX.probe.membership, VFX.probe.filter);
/** Shared (read-only) raycast options: no object literal per probe. */
const PROBE_OPTS: RaycastOptions = { groups: PROBE_GROUPS };
const MESH_KINDS: readonly CasingMesh[] = ['brass', 'shell'];

const TYPE_IDS = Object.keys(CASINGS);
const TYPE_DEFS: readonly CasingDef[] = TYPE_IDS.map((id) => (CASINGS as Record<string, CasingDef>)[id]!);

const Y = new THREE.Vector3(0, 1, 0);
const _dir = { x: 0, y: 0, z: 0 };
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _clinkPos = { x: 0, y: 0, z: 0 };
const _probeDir = { x: 0, y: -1, z: 0 };
const _probeDirV = { x: 0, y: 0, z: 0 };
const _origin = { x: 0, y: 0, z: 0 };

function brassGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.5, 0.5, 1, VFX.casings.radialSegments, 1, false);
}

/** Shotgun hull: lathe profile with a brass head band, colored per vertex (long axis = +Y, unit size). */
function shellGeometry(): THREE.BufferGeometry {
  const c = VFX.casings.shell;
  const head = -0.5 + c.headFraction;
  const rim = c.rimRadius;
  const pts = [
    new THREE.Vector2(0, -0.5),
    new THREE.Vector2(rim, -0.5),
    new THREE.Vector2(rim, -0.46),
    new THREE.Vector2(0.5, -0.45),
    new THREE.Vector2(0.5, head),
    new THREE.Vector2(0.5, head),
    new THREE.Vector2(0.5, 0.5),
    new THREE.Vector2(0.3, 0.5),
    new THREE.Vector2(0, 0.47),
  ];
  // The head band ends at the first of the two coincident points: coloring by profile index (not
  // by height) gives the band a hard edge – both points share the height.
  const bandEnd = 4;
  const geo = new THREE.LatheGeometry(pts, VFX.casings.radialSegments);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // LatheGeometry writes one meridian of `pts.length` vertices per segment.
    const col = i % pts.length <= bandEnd ? c.head : c.hull;
    colors[i * 3] = col[0];
    colors[i * 3 + 1] = col[1];
    colors[i * 3 + 2] = col[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

interface CasingBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly range: UpdateRange;
}

export class CasingSystem {
  readonly object = new THREE.Group();
  readonly sim: CasingSim;
  private readonly batches: Record<CasingMesh, CasingBatch>;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly spawn = createCasingSpawn();
  private frame = 0;

  constructor(
    maxCapacity: number,
    private readonly render: Pick<RenderApi, 'setupMaterial'>,
    private readonly physics: PhysicsApi | null,
    private readonly rand: Rand = Math.random,
    private readonly onClink: ClinkCallback | null = null,
  ) {
    const c = VFX.casings;
    this.object.name = 'VfxCasings';
    this.sim = new CasingSim(maxCapacity, {
      gravity: c.gravity,
      life: c.life,
      fadeTime: c.fadeTime,
      settleSpeed: c.settleSpeed,
      settleTime: c.settleTime,
      spinDamping: c.spinDamping,
      maxFlightTime: c.maxFlightTime,
    });
    const brass = new THREE.MeshStandardMaterial({
      name: 'VfxCasingBrass',
      color: new THREE.Color().setRGB(c.brass.color[0], c.brass.color[1], c.brass.color[2]),
      roughness: c.brass.roughness,
      metalness: c.brass.metalness,
    });
    const shell = new THREE.MeshStandardMaterial({
      name: 'VfxCasingShell',
      vertexColors: true,
      roughness: c.shell.roughness,
      metalness: c.shell.metalness,
    });
    this.batches = {
      brass: this.createBatch('brass', brassGeometry(), brass, this.sim.capacity),
      shell: this.createBatch('shell', shellGeometry(), shell, this.sim.capacity),
    };
  }

  get count(): number {
    return this.sim.count;
  }

  setLimit(n: number): void {
    this.sim.setLimit(n);
    this.writeInstances();
  }

  /** Shader warm-up: while active each batch draws one zero-scale instance. */
  setWarmup(active: boolean): void {
    if (!active) {
      this.writeInstances();
      return;
    }
    _m.makeScale(0, 0, 0);
    for (const k of MESH_KINDS) {
      const b = this.batches[k];
      b.mesh.setMatrixAt(0, _m);
      this.commit(b, 1);
    }
  }

  clear(): void {
    this.sim.clear();
    this.writeInstances();
  }

  /**
   * Eject a casing of preset `id` (defs CASINGS) at `position`, flying along the unit `direction`
   * (eject port), oriented along `barrel`, plus `inherit` (shooter velocity). Unknown ids: no-op.
   */
  eject(id: string, position: Vec3Like, direction: Vec3Like, barrel: Vec3Like, inherit: Vec3Like): boolean {
    const typeIndex = TYPE_IDS.indexOf(id);
    if (typeIndex < 0) return false;
    const def = TYPE_DEFS[typeIndex]!;
    const s = this.spawn;
    const r = this.rand;
    sampleCone(direction.x, direction.y, direction.z, Math.cos(def.spread * DEG2RAD), r(), r(), _dir);
    const speed = lerpRange(def.speed, r());
    const up = lerpRange(def.upSpeed, r());
    s.x = position.x;
    s.y = position.y;
    s.z = position.z;
    s.vx = _dir.x * speed + inherit.x;
    s.vy = _dir.y * speed + up + inherit.y;
    s.vz = _dir.z * speed + inherit.z;
    // Tumble around a random axis, mostly end over end.
    sampleCone(0, 1, 0, -1, r(), r(), _dir);
    const spin = lerpRange(def.spin, r());
    s.wx = _dir.x * spin;
    s.wy = _dir.y * spin;
    s.wz = _dir.z * spin;
    _v.set(barrel.x, barrel.y, barrel.z);
    if (_v.lengthSq() < 1e-8) _v.set(0, 0, -1);
    _q.setFromUnitVectors(Y, _v.normalize());
    s.qx = _q.x;
    s.qy = _q.y;
    s.qz = _q.z;
    s.qw = _q.w;
    s.bounce = def.bounce;
    s.friction = def.friction;
    s.radius = def.radius;
    s.type = typeIndex;
    s.floorY = Number.NEGATIVE_INFINITY;
    if (this.physics) {
      const hit = this.physics.raycast(position, _probeDir, VFX.casings.floorProbe, PROBE_OPTS);
      if (hit) s.floorY = hit.point.y;
    }
    return this.sim.spawn(s) >= 0;
  }

  update(dt: number): void {
    this.frame++;
    if (this.sim.count > 0) {
      this.probe(dt);
      this.sim.update(dt, this.onBounce);
    }
    this.writeInstances();
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const k of MESH_KINDS) this.batches[k].mesh.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private readonly onBounce = (b: CasingBounce): void => {
    if (!this.onClink) return;
    const sim = this.sim;
    const def = TYPE_DEFS[sim.type[b.index]!];
    if (!def || b.impactSpeed < def.clinkMinSpeed || sim.clinks[b.index]! > VFX.casings.maxClinks) return;
    _clinkPos.x = sim.px[b.index]!;
    _clinkPos.y = sim.py[b.index]!;
    _clinkPos.z = sim.pz[b.index]!;
    this.onClink(_clinkPos, def.clinkSound, b.impactSpeed);
  };

  /** Sparse wall probes: each moving casing casts along its velocity every Nth frame. */
  private probe(dt: number): void {
    const physics = this.physics;
    if (!physics) return;
    const sim = this.sim;
    const interval = Math.max(1, VFX.casings.probeInterval);
    for (let i = 0; i < sim.activeLimit; i++) {
      if (!sim.alive[i] || sim.rest[i]! >= 0 || (this.frame + i) % interval !== 0) continue;
      const vx = sim.vx[i]!;
      const vy = sim.vy[i]!;
      const vz = sim.vz[i]!;
      const speed = Math.hypot(vx, vy, vz);
      if (speed < 1e-3) continue;
      _probeDirV.x = vx / speed;
      _probeDirV.y = vy / speed;
      _probeDirV.z = vz / speed;
      _origin.x = sim.px[i]!;
      _origin.y = sim.py[i]!;
      _origin.z = sim.pz[i]!;
      // Cover the frames until the next probe (+ one for safety) plus the casing radius.
      const reach = speed * dt * (interval + 1) + sim.radius[i]! * 2;
      const hit = physics.raycast(_origin, _probeDirV, reach, PROBE_OPTS);
      if (hit)
        sim.setWall(i, hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z);
    }
  }

  private writeInstances(): void {
    const sim = this.sim;
    const brass = this.batches.brass;
    const shell = this.batches.shell;
    let nb = 0;
    let ns = 0;
    for (let i = 0; i < sim.activeLimit; i++) {
      if (!sim.alive[i]) continue;
      const def = TYPE_DEFS[sim.type[i]!]!;
      const k = sim.scaleOf(i);
      _p.set(sim.px[i]!, sim.py[i]!, sim.pz[i]!);
      _qa.set(sim.q[i * 4]!, sim.q[i * 4 + 1]!, sim.q[i * 4 + 2]!, sim.q[i * 4 + 3]!);
      const d = def.radius * 2 * k;
      _s.set(d, def.length * k, d);
      _m.compose(_p, _qa, _s);
      if (def.mesh === 'shell') shell.mesh.setMatrixAt(ns++, _m);
      else brass.mesh.setMatrixAt(nb++, _m);
    }
    this.commit(brass, nb);
    this.commit(shell, ns);
  }

  private commit(batch: CasingBatch, n: number): void {
    const mesh = batch.mesh;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      setUpdateRange(mesh.instanceMatrix, batch.range, 0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private createBatch(
    kind: CasingMesh,
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    capacity: number,
  ): CasingBatch {
    this.render.setupMaterial(material);
    this.materials.push(material);
    this.geometries.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.name = `VfxCasings:${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.object.add(mesh);
    return { mesh, range: { start: 0, count: 0 } };
  }
}
