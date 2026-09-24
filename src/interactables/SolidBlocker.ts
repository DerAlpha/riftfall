/**
 * A toggleable solid volume for interactables (closed doors, the box, perk machines):
 * - a static Rapier box collider (world kind) the player collides with,
 * - a hidden bullet-stopping mesh named `level:<materialId>` registered with the combat world
 *   (CLAUDE.md: only `level:` / `panel:` meshes stop bullets and block line of sight). CombatWorld
 *   has no removal, so an unblocked mesh is parked far below the world instead (its broadphase box
 *   stays at the old spot; rays through it test the parked triangles and miss),
 * - a blocked navmesh area (NavApi.setAreaBlocked): enemies path around it.
 * Any part may be absent (null deps / no shape). All shapes are axis-aligned world boxes.
 */
import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderData, NavApi, PhysicsApi } from '../core/contracts';
import type { SurfaceType, Vec3Like } from '../core/events';
import { BLOCKERS } from '../defs/interactables';

export interface BoxShape {
  readonly center: Vec3Like;
  readonly half: Vec3Like;
}

export interface SolidBlockerDeps {
  physics: Pick<PhysicsApi, 'addStaticBox' | 'removeCollider'> | null;
  combat: { addStaticMesh(mesh: Mesh, materialId: string): void } | null;
  nav: Pick<NavApi, 'setAreaBlocked'> | null;
  /** Parent of the hidden bullet mesh (must be in the scene graph with current world matrices). */
  parent: Object3D | null;
}

export interface SolidBlockerShapes {
  /** Player collision volume. */
  collider: BoxShape | null;
  /** Bullet / line-of-sight volume and its surface material id (defs/materials). */
  bullets: { box: BoxShape; materialId: string } | null;
  /** Navmesh area enemies must not enter. */
  nav: BoxShape | null;
  surface?: SurfaceType;
}

/** One invisible material for every bullet blocker (never rendered: visible = false). */
let sharedHiddenMaterial: MeshBasicMaterial | null = null;
function hiddenMaterial(): MeshBasicMaterial {
  if (!sharedHiddenMaterial) {
    sharedHiddenMaterial = new MeshBasicMaterial({ name: 'interactable-blocker', visible: false });
  }
  return sharedHiddenMaterial;
}

export class SolidBlocker {
  private collider: RAPIER.Collider | null = null;
  private readonly mesh: Mesh | null = null;
  private readonly data: ColliderData;
  private _blocked = false;
  private disposed = false;

  constructor(
    private readonly deps: SolidBlockerDeps,
    private readonly shapes: SolidBlockerShapes,
    blocked: boolean,
  ) {
    this.data = { kind: 'world', surface: shapes.surface ?? 'metal' };
    const b = shapes.bullets;
    if (b && deps.combat && deps.parent) {
      const h = b.box.half;
      const mesh = new Mesh(new BoxGeometry(h.x * 2, h.y * 2, h.z * 2), hiddenMaterial());
      mesh.name = `level:${b.materialId}`;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Never part of the navmesh (the nav area handles enemies) or of shadow / volumetric passes.
      mesh.userData.navIgnore = true;
      mesh.position.set(b.box.center.x, b.box.center.y, b.box.center.z);
      deps.parent.add(mesh);
      mesh.updateWorldMatrix(true, false);
      this.mesh = mesh;
      deps.combat.addStaticMesh(mesh, b.materialId);
    }
    this.setBlocked(blocked, true);
  }

  get blocked(): boolean {
    return this._blocked;
  }

  setBlocked(blocked: boolean, force = false): void {
    if (this.disposed || (blocked === this._blocked && !force)) return;
    this._blocked = blocked;
    const { physics, nav } = this.deps;
    const s = this.shapes;
    if (physics && s.collider) {
      if (blocked && !this.collider) {
        this.collider = physics.addStaticBox(s.collider.center, s.collider.half, undefined, this.data);
      } else if (!blocked && this.collider) {
        physics.removeCollider(this.collider);
        this.collider = null;
      }
    }
    if (this.mesh && s.bullets) {
      const c = s.bullets.box.center;
      this.mesh.position.set(c.x, blocked ? c.y : c.y + BLOCKERS.parkOffsetY, c.z);
      this.mesh.updateWorldMatrix(true, false);
    }
    if (nav?.setAreaBlocked && s.nav) nav.setAreaBlocked(s.nav.center, s.nav.half, blocked);
  }

  dispose(): void {
    if (this.disposed) return;
    this.setBlocked(false);
    this.disposed = true;
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
    }
  }
}

/** Axis-aligned half extents of a box `across` × `height` × `through` at a yaw in 90° steps. */
export function axisHalf(yaw: number, across: number, height: number, through: number): Vec3Like {
  // Local +X (across) maps to world X when the yaw is 0 or 180°, to Z at ±90°.
  const alongX = Math.abs(Math.cos(yaw)) > Math.SQRT1_2;
  return {
    x: (alongX ? across : through) / 2,
    y: height / 2,
    z: (alongX ? through : across) / 2,
  };
}
