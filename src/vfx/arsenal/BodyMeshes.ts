/**
 * Solid grenade bodies in flight: per PROJECTILE_MESHES shape one lit InstancedMesh (unit-sized
 * procedural lathe geometry scaled per instance, albedo via instance colour, CSM-shadowed like
 * every world material) plus one unlit HDR InstancedMesh for the glowing identification band
 * (it blooms). World pass (layer 0), allocated at ARSENAL_VFX.bodies.capacity per shape, rebuilt
 * every frame (begin → push → end); meshes with no instance are hidden.
 */
import * as THREE from 'three';
import { ARSENAL_VFX, PROJECTILE_MESHES, type ProjectileMesh } from '../../defs/arsenalVfx';
import { setUpdateRange, type UpdateRange } from '../gpuUpload';

const MESH_INDEX = new Map<string, number>(PROJECTILE_MESHES.map((s, i) => [s, i]));

export function projectileMeshIndex(mesh: ProjectileMesh | string): number {
  return MESH_INDEX.get(mesh) ?? 0;
}

/** Radial segments of the lathe bodies (grenades are a few centimeters on screen). */
const SEGMENTS = 14;

/**
 * Unit geometries along +Z (nose forward): radius 1, length 1 (the instance scale is
 * radius × radius × length). Built from lathe profiles (x = radius, y = along the axis).
 */
function bodyGeometry(shape: ProjectileMesh): { body: THREE.BufferGeometry; band: THREE.BufferGeometry } {
  let profile: [number, number][];
  let band: [number, number];
  if (shape === 'shell') {
    // 40 mm round: flat base, brass-like body, ogive nose.
    profile = [
      [0, 0],
      [0.92, 0],
      [1, 0.05],
      [1, 0.52],
      [0.97, 0.58],
      [0.9, 0.72],
      [0.72, 0.86],
      [0.44, 0.96],
      [0, 1],
    ];
    band = [0.44, 0.54];
  } else if (shape === 'canister') {
    profile = [
      [0, 0],
      [0.78, 0],
      [0.95, 0.05],
      [1, 0.12],
      [1, 0.88],
      [0.95, 0.95],
      [0.78, 1],
      [0, 1],
    ];
    band = [0.44, 0.56];
  } else {
    // Ball: a slightly flattened sphere (the fuse cap is the LED glow).
    profile = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / n;
      profile.push([Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
    }
    band = [0.44, 0.56];
  }
  const body = new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y)),
    SEGMENTS,
  );
  const [b0, b1] = band;
  const bandGeo = new THREE.CylinderGeometry(1.05, 1.05, b1 - b0, SEGMENTS, 1, true);
  bandGeo.translate(0, (b0 + b1) / 2, 0);
  // Lathe/cylinder axes are +Y with the base at 0: rotate so +Y → +Z and center the length.
  for (const g of [body, bandGeo]) {
    g.translate(0, -0.5, 0);
    g.rotateX(Math.PI / 2);
    g.computeVertexNormals();
  }
  return { body, band: bandGeo };
}

interface ShapeMeshes {
  readonly body: THREE.InstancedMesh;
  readonly band: THREE.InstancedMesh;
  readonly ranges: UpdateRange[];
  n: number;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class BodyMeshes {
  readonly object = new THREE.Group();
  private readonly shapes: ShapeMeshes[] = [];
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly bandMaterial: THREE.MeshBasicMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private warming = false;

  constructor(setupMaterial: (m: THREE.Material) => void) {
    this.object.name = 'ArsenalBodies';
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      name: 'ArsenalBody',
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.75,
    });
    setupMaterial(this.bodyMaterial);
    this.bandMaterial = new THREE.MeshBasicMaterial({ name: 'ArsenalBand', color: 0xffffff, toneMapped: false });
    const cap = ARSENAL_VFX.bodies.capacity;
    for (const shape of PROJECTILE_MESHES) {
      const geo = bodyGeometry(shape);
      this.geometries.push(geo.body, geo.band);
      const body = new THREE.InstancedMesh(geo.body, this.bodyMaterial, cap);
      const band = new THREE.InstancedMesh(geo.band, this.bandMaterial, cap);
      for (const m of [body, band]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        m.count = 0;
        m.visible = false;
        m.frustumCulled = false;
        m.castShadow = false;
        m.receiveShadow = true;
        this.object.add(m);
      }
      body.name = `ArsenalBody:${shape}`;
      band.name = `ArsenalBand:${shape}`;
      this.shapes.push({ body, band, ranges: [0, 1, 2, 3].map(() => ({ start: 0, count: 0 })), n: 0 });
    }
  }

  /** Bodies drawn this frame. */
  get count(): number {
    let n = 0;
    for (const s of this.shapes) n += s.n;
    return n;
  }

  begin(): void {
    for (const s of this.shapes) s.n = 0;
  }

  /** Queue a body: shape index, world transform (unit mesh scaled by radius / length), colours. */
  push(
    shape: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    radius: number,
    length: number,
    albedo: readonly [number, number, number],
    band: readonly [number, number, number],
    bandIntensity: number,
  ): boolean {
    const s = this.shapes[shape];
    if (!s || s.n >= s.body.instanceMatrix.count) return false;
    _m.compose(position, quaternion, _s.set(radius, radius, length));
    s.body.setMatrixAt(s.n, _m);
    s.band.setMatrixAt(s.n, _m);
    s.body.setColorAt(s.n, _c.setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace));
    s.band.setColorAt(
      s.n,
      _c.setRGB(band[0] * bandIntensity, band[1] * bandIntensity, band[2] * bandIntensity, THREE.LinearSRGBColorSpace),
    );
    s.n++;
    return true;
  }

  end(): void {
    if (this.warming) return;
    for (const s of this.shapes) {
      const n = s.n;
      let k = 0;
      for (const m of [s.body, s.band]) {
        m.count = n;
        m.visible = n > 0;
        if (n > 0) {
          setUpdateRange(m.instanceMatrix, s.ranges[k++]!, 0, n * 16);
          m.instanceMatrix.needsUpdate = true;
          setUpdateRange(m.instanceColor!, s.ranges[k++]!, 0, n * 3);
          m.instanceColor!.needsUpdate = true;
        } else {
          k += 2;
        }
      }
    }
  }

  /** Warm-up: one zero-scale instance per mesh so both programs compile in the real frame. */
  setWarmup(active: boolean): void {
    this.warming = active;
    if (active) {
      _m.makeScale(0, 0, 0);
      for (const s of this.shapes) {
        for (const m of [s.body, s.band]) {
          m.setMatrixAt(0, _m);
          m.count = 1;
          m.visible = true;
          m.instanceMatrix.clearUpdateRanges();
          m.instanceMatrix.needsUpdate = true;
        }
      }
    } else {
      for (const s of this.shapes) s.n = 0;
      this.end();
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const s of this.shapes) {
      s.body.dispose();
      s.band.dispose();
    }
    for (const g of this.geometries) g.dispose();
    this.bodyMaterial.dispose();
    this.bandMaterial.dispose();
  }
}
