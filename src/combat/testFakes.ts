/**
 * Test doubles for combat/weapon tests (imported by *.test.ts only; never by game code).
 */
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { DamageInfo, DamageResult, Damageable, Hitbox } from '../core/contracts';
import type { FleshSurface, Vec3Like } from '../core/events';
import { ensureBvhPatched } from '../world/LevelKit';

let nextId = 1;

/** Standing humanoid target: capsule body (+ limbs zone below the hips) and a head sphere. */
export class FakeTarget implements Damageable {
  readonly id = nextId++;
  readonly team = 'enemy' as const;
  surface: FleshSurface = 'flesh';
  health: number;
  readonly boundsCenter = new Vector3();
  boundsRadius = 1.2;
  readonly aimPoint = new Vector3();
  readonly hitboxes: Hitbox[];
  readonly received: DamageInfo[] = [];

  constructor(
    readonly feet: Vec3Like,
    health = 100,
  ) {
    this.health = health;
    const { x, y, z } = feet;
    this.hitboxes = [
      { shape: 'sphere', zone: 'head', a: new Vector3(x, y + 1.62, z), b: new Vector3(), radius: 0.14 },
      {
        shape: 'capsule',
        zone: 'body',
        a: new Vector3(x, y + 0.95, z),
        b: new Vector3(x, y + 1.35, z),
        radius: 0.24,
      },
      {
        shape: 'capsule',
        zone: 'limb',
        a: new Vector3(x, y + 0.12, z),
        b: new Vector3(x, y + 0.7, z),
        radius: 0.16,
      },
    ];
    this.boundsCenter.set(x, y + 0.9, z);
    this.aimPoint.set(x, y + 1.25, z);
  }

  get alive(): boolean {
    return this.health > 0;
  }

  applyDamage(info: DamageInfo): DamageResult {
    this.received.push({ ...info, point: { ...info.point }, direction: { ...info.direction } });
    const applied = Math.min(this.health, info.amount);
    this.health -= applied;
    return { applied, killed: this.health <= 0 };
  }
}

/** A level-like root with BVH meshes named like LevelKit output. */
export function buildTestLevel(
  boxes: { material: string; center: Vec3Like; size: Vec3Like; noshadow?: boolean }[],
): Group {
  ensureBvhPatched();
  const root = new Group();
  const mat = new MeshBasicMaterial();
  for (const b of boxes) {
    const geo = new BoxGeometry(b.size.x, b.size.y, b.size.z);
    geo.translate(b.center.x, b.center.y, b.center.z);
    geo.computeBoundsTree();
    const mesh = new Mesh(geo, mat);
    mesh.name = `level:${b.material}${b.noshadow ? ':noshadow' : ''}`;
    root.add(mesh);
  }
  return root;
}
