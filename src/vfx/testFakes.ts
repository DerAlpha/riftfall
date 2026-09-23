/**
 * Test doubles for the VFX tests (imported by *.test.ts only; never by game code).
 */
import * as THREE from 'three';
import type { ColliderData, PhysicsApi, RaycastHit, RenderApi } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import type { VfxSocket, VfxSocketSource } from './VfxSystem';

/** Minimal RenderApi: real scenes/cameras, recorded setupMaterial calls, hookable render(). */
export function fakeRender(): RenderApi & { setupCalls: THREE.Material[]; onRender: (() => void) | null } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld();
  const viewmodelScene = new THREE.Scene();
  const viewmodelCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 10);
  viewmodelScene.add(viewmodelCamera);
  const setupCalls: THREE.Material[] = [];
  const fake = {
    scene,
    camera,
    viewmodelScene,
    viewmodelCamera,
    setupCalls,
    onRender: null as (() => void) | null,
    setupMaterial: (m: THREE.Material) => {
      setupCalls.push(m);
    },
    render: () => fake.onRender?.(),
  };
  return fake as unknown as RenderApi & { setupCalls: THREE.Material[]; onRender: (() => void) | null };
}

export interface FakePlane {
  /** Plane n·p = d; hits come from the front side. */
  normal: THREE.Vector3;
  d: number;
  data: ColliderData;
}

/**
 * Physics fake: an infinite floor at y = 0 plus optional extra planes. raycast() returns the
 * nearest front-face plane hit (shared object, like PhysicsWorld).
 */
export class FakePhysics {
  readonly planes: FakePlane[] = [
    { normal: new THREE.Vector3(0, 1, 0), d: 0, data: { kind: 'world', surface: 'concrete' } },
  ];
  readonly calls: { origin: Vec3Like; direction: Vec3Like; max: number }[] = [];
  private readonly hit: RaycastHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    collider: undefined as unknown as RaycastHit['collider'],
    data: undefined,
  };

  raycast(origin: Vec3Like, direction: Vec3Like, max: number): RaycastHit | null {
    this.calls.push({ origin: { ...origin }, direction: { ...direction }, max });
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (!(len > 0)) return null;
    let best: FakePlane | null = null;
    let bestT = max;
    for (const p of this.planes) {
      const n = p.normal;
      const denom = (n.x * direction.x + n.y * direction.y + n.z * direction.z) / len;
      if (denom >= 0) continue;
      const t = (p.d - (n.x * origin.x + n.y * origin.y + n.z * origin.z)) / denom;
      if (t >= 0 && t <= bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best) return null;
    this.hit.distance = bestT;
    this.hit.point.set(
      origin.x + (direction.x / len) * bestT,
      origin.y + (direction.y / len) * bestT,
      origin.z + (direction.z / len) * bestT,
    );
    this.hit.normal.copy(best.normal);
    this.hit.data = best.data;
    return this.hit;
  }

  asApi(): PhysicsApi {
    return this as unknown as PhysicsApi;
  }
}

/** Sockets fake: fixed world points in front of the camera and viewmodel anchors. */
export class FakeSockets implements VfxSocketSource {
  readonly anchors: Record<VfxSocket, THREE.Object3D> = {
    muzzle: new THREE.Object3D(),
    ejectPort: new THREE.Object3D(),
  };
  readonly world: Record<VfxSocket, THREE.Vector3> = {
    muzzle: new THREE.Vector3(0.2, 1.4, -0.6),
    ejectPort: new THREE.Vector3(0.12, 1.45, -0.3),
  };
  readonly dirs: Record<VfxSocket, THREE.Vector3> = {
    muzzle: new THREE.Vector3(0, 0, -1),
    ejectPort: new THREE.Vector3(1, 0.5, 0).normalize(),
  };

  constructor(parent?: THREE.Object3D) {
    parent?.add(this.anchors.muzzle, this.anchors.ejectPort);
  }

  getSocketObject(socket: VfxSocket): THREE.Object3D {
    return this.anchors[socket];
  }

  getSocketWorldPosition(socket: VfxSocket, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.world[socket]);
  }

  getSocketWorldDirection(socket: VfxSocket, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.dirs[socket]);
  }
}

/** Seeded cosmetic randomness for deterministic tests. */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
