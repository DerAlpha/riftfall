/**
 * Test fakes for the interactables: economy, perks, weapons, input, physics / combat / nav
 * recorders. Plain objects with call logs – no three.js renderer, no Rapier, no recast.
 */
import type { Vec3Like } from '../core/events';
import type { InteractableWeapons } from './types';

export class FakeEconomy {
  points: number;
  readonly spent: { cost: number; item: string; kind: string }[] = [];
  readonly earned: { amount: number; reason: string }[] = [];
  readonly refused: { cost: number; item: string }[] = [];

  constructor(points = 0) {
    this.points = points;
  }

  canAfford(cost: number): boolean {
    return cost <= this.points;
  }

  spend(cost: number, item: string, kind: string): boolean {
    if (!this.canAfford(cost)) {
      this.refused.push({ cost, item });
      return false;
    }
    this.points -= cost;
    this.spent.push({ cost, item, kind });
    return true;
  }

  earn(amount: number, reason: string): number {
    this.points += amount;
    this.earned.push({ amount, reason });
    return amount;
  }
}

export class FakePerks {
  readonly owned: string[] = [];
  grantResult: boolean | null = null;
  readonly granted: string[] = [];

  constructor(readonly maxPerks = 4) {}

  has(id: string): boolean {
    return this.owned.includes(id);
  }

  grant(id: string): boolean {
    if (this.grantResult === false) return false;
    if (this.has(id) || this.owned.length >= this.maxPerks) return false;
    this.owned.push(id);
    this.granted.push(id);
    return true;
  }
}

export class FakeWeapons implements InteractableWeapons {
  readonly carried: string[];
  readonly given: string[] = [];
  full = false;

  constructor(carried: string[] = ['pistol']) {
    this.carried = carried;
  }

  owns(id: string): boolean {
    return this.carried.includes(id);
  }

  give(id: string): void {
    this.given.push(id);
    if (!this.carried.includes(id)) this.carried.push(id);
  }

  ammoFull(_id: string): boolean {
    return this.full;
  }
}

/** InputApi subset with a frame model: press() sets the edge for the current frame. */
export class FakeInput {
  held = false;
  private edge = false;

  press(): void {
    this.held = true;
    this.edge = true;
  }

  release(): void {
    this.held = false;
  }

  /** End of frame: edges are per frame. */
  endFrame(): void {
    this.edge = false;
  }

  isDown(action: string): boolean {
    return action === 'interact' && this.held;
  }

  pressed(action: string): boolean {
    return action === 'interact' && this.edge;
  }
}

export interface ColliderRecord {
  center: Vec3Like;
  half: Vec3Like;
  removed: boolean;
}

export class FakePhysics {
  readonly colliders: ColliderRecord[] = [];

  addStaticBox(center: Vec3Like, half: Vec3Like): never {
    const rec: ColliderRecord = { center: { ...center }, half: { ...half }, removed: false };
    this.colliders.push(rec);
    return rec as never;
  }

  removeCollider(c: unknown): void {
    (c as ColliderRecord).removed = true;
  }

  get live(): number {
    return this.colliders.filter((c) => !c.removed).length;
  }
}

export class FakeNav {
  readonly calls: { center: Vec3Like; half: Vec3Like; blocked: boolean }[] = [];

  setAreaBlocked(center: Vec3Like, half: Vec3Like, blocked: boolean): void {
    this.calls.push({ center: { ...center }, half: { ...half }, blocked });
  }

  /** Last blocked state per area center key. */
  state(center: Vec3Like): boolean | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i]!;
      if (c.center.x === center.x && c.center.y === center.y && c.center.z === center.z) return c.blocked;
    }
    return undefined;
  }
}

export class FakeCombat {
  readonly meshes: { name: string; materialId: string; mesh: { position: { y: number } } }[] = [];

  addStaticMesh(mesh: { name: string; position: { y: number } }, materialId: string): void {
    this.meshes.push({ name: mesh.name, materialId, mesh });
  }
}
