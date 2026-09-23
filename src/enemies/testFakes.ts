/**
 * Test doubles for enemy tests (imported by *.test.ts only; never by game code):
 * - FakeNav: NavApi with straight-line agents, deterministic random points and optional wall
 *   segments that make `walkable` fail (agents themselves walk through walls),
 * - FakeVisuals: EnemyVisualsApi whose hitboxes / sockets are the REST pose of the real visual defs
 *   (defs/enemyVisuals) placed with the instance transform – no bones, no GPU,
 * - FakePlayer: EnemyTargetApi recording the damage it takes,
 * - createEnemyHarness: CombatWorld (optional BVH boxes) + fakes + EnemyManager.
 */
import { Group, Vector3, type Mesh } from 'three';
import type { EnemyTargetApi, Hitbox, NavAgentParams, NavApi } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { getEnemyVisualDef, type Vec3 } from '../defs/enemyVisuals';
import { CombatWorld } from '../combat/CombatWorld';
import { buildTestLevel } from '../combat/testFakes';
import { EnemyManager, type EnemyManagerDeps } from './EnemyManager';
import type { EnemyInstanceHandle, EnemyPose, EnemyTypeId, EnemyVisualsApi } from './types';

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

interface FakeAgent {
  pos: Vector3;
  vel: Vector3;
  target: Vector3 | null;
  maxSpeed: number;
  radius: number;
}

export interface WallSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

function segmentsIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export class FakeNav implements NavApi {
  ready = true;
  readonly stats = { agents: 0, polys: 0, buildMs: 0 };
  readonly agents: (FakeAgent | null)[] = [];
  readonly walls: WallSegment[] = [];
  floorY = 0;
  pathCalls = 0;
  walkableCalls = 0;
  teleports = 0;
  updates = 0;
  private readonly rng = new Rng('fake-nav');

  async build(_sources: readonly Mesh[]): Promise<boolean> {
    return true;
  }

  closestPoint(p: Vec3Like, out: Vector3): boolean {
    out.set(p.x, this.floorY, p.z);
    return true;
  }

  randomPointAround(center: Vec3Like, radius: number, out: Vector3): boolean {
    const a = this.rng.next() * Math.PI * 2;
    const d = Math.max(0, radius) * Math.sqrt(this.rng.next());
    out.set(center.x + Math.cos(a) * d, this.floorY, center.z + Math.sin(a) * d);
    return true;
  }

  findPath(from: Vec3Like, to: Vec3Like, out: Vector3[]): number {
    this.pathCalls++;
    while (out.length < 2) out.push(new Vector3());
    out[0]!.set(from.x, this.floorY, from.z);
    out[1]!.set(to.x, this.floorY, to.z);
    return 2;
  }

  walkable(from: Vec3Like, to: Vec3Like): boolean {
    this.walkableCalls++;
    for (const w of this.walls) {
      if (segmentsIntersect(from.x, from.z, to.x, to.z, w.ax, w.az, w.bx, w.bz)) return false;
    }
    return true;
  }

  addAgent(position: Vec3Like, params: NavAgentParams): number {
    const a: FakeAgent = {
      pos: new Vector3(position.x, this.floorY, position.z),
      vel: new Vector3(),
      target: null,
      maxSpeed: params.maxSpeed,
      radius: params.radius,
    };
    let i = this.agents.indexOf(null);
    if (i < 0) {
      i = this.agents.length;
      this.agents.push(a);
    } else this.agents[i] = a;
    this.stats.agents++;
    return i;
  }

  removeAgent(id: number): void {
    if (this.agents[id]) {
      this.agents[id] = null;
      this.stats.agents--;
    }
  }

  setAgentTarget(id: number, target: Vec3Like): void {
    const a = this.agents[id];
    if (a) a.target = new Vector3(target.x, this.floorY, target.z);
  }

  stopAgent(id: number): void {
    const a = this.agents[id];
    if (a) {
      a.target = null;
      a.vel.set(0, 0, 0);
    }
  }

  setAgentMaxSpeed(id: number, speed: number): void {
    const a = this.agents[id];
    if (a) a.maxSpeed = speed;
  }

  teleportAgent(id: number, position: Vec3Like): void {
    const a = this.agents[id];
    if (a) {
      a.pos.set(position.x, this.floorY, position.z);
      a.vel.set(0, 0, 0);
      this.teleports++;
    }
  }

  getAgentPosition(id: number, out: Vector3): Vector3 {
    const a = this.agents[id];
    return a ? out.copy(a.pos) : out;
  }

  getAgentVelocity(id: number, out: Vector3): Vector3 {
    const a = this.agents[id];
    return a ? out.copy(a.vel) : out.set(0, 0, 0);
  }

  update(dt: number): void {
    this.updates++;
    for (const a of this.agents) {
      if (!a) continue;
      if (!a.target) {
        a.vel.set(0, 0, 0);
        continue;
      }
      const dx = a.target.x - a.pos.x;
      const dz = a.target.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      const step = a.maxSpeed * dt;
      if (d <= Math.max(1e-3, step)) {
        a.vel.set(dx / dt, 0, dz / dt);
        a.pos.x = a.target.x;
        a.pos.z = a.target.z;
      } else {
        a.vel.set((dx / d) * a.maxSpeed, 0, (dz / d) * a.maxSpeed);
        a.pos.x += (dx / d) * step;
        a.pos.z += (dz / d) * step;
      }
    }
  }

  setDebugVisible(): void {}

  dispose(): void {
    this.agents.length = 0;
  }

  liveAgents(): number {
    return this.agents.filter((a) => a !== null).length;
  }
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

interface FakeSlot {
  used: boolean;
  pos: Vector3;
  yaw: number;
  pose: Omit<EnemyPose, 'rimColor'>;
}

/** Rest-pose model point (visual def frame: +Z forward, +X left) → world. */
function toWorld(p: Vec3, pos: Vector3, yaw: number, scale: number, mirror: boolean, out: Vector3): Vector3 {
  const x = (mirror ? -p[0] : p[0]) * scale;
  const y = p[1] * scale;
  const z = p[2] * scale;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return out.set(pos.x + x * c + z * s, pos.y + y, pos.z - x * s + z * c);
}

export class FakeVisuals implements EnemyVisualsApi {
  readonly stats = { instances: 0, drawCalls: 0 };
  commits = 0;
  updates = 0;
  acquired = 0;
  released = 0;
  hitboxCalls = 0;
  readonly slots = new Map<string, FakeSlot[]>();

  constructor(private readonly capacity = 64) {}

  acquire(type: EnemyTypeId): EnemyInstanceHandle {
    if (!getEnemyVisualDef(type)) return -1;
    let list = this.slots.get(type);
    if (!list) {
      list = [];
      this.slots.set(type, list);
    }
    let i = list.findIndex((s) => !s.used);
    if (i < 0) {
      if (list.length >= this.capacity) return -1;
      i = list.length;
      list.push({ used: false, pos: new Vector3(), yaw: 0, pose: {} as FakeSlot['pose'] });
    }
    list[i]!.used = true;
    this.acquired++;
    this.stats.instances++;
    return i;
  }

  release(type: EnemyTypeId, handle: EnemyInstanceHandle): void {
    const s = this.slots.get(type)?.[handle];
    if (s?.used) {
      s.used = false;
      this.released++;
      this.stats.instances--;
    }
  }

  slot(type: string, handle: number): FakeSlot | undefined {
    return this.slots.get(type)?.[handle];
  }

  setTransform(type: EnemyTypeId, handle: EnemyInstanceHandle, position: Vector3, yaw: number): void {
    const s = this.slot(type, handle);
    if (!s) return;
    s.pos.copy(position);
    s.yaw = yaw;
  }

  setPose(type: EnemyTypeId, handle: EnemyInstanceHandle, pose: Readonly<EnemyPose>): void {
    const s = this.slot(type, handle);
    if (!s) return;
    const { rimColor: _rim, ...rest } = pose;
    Object.assign(s.pose, rest);
  }

  commitTick(): void {
    this.commits++;
  }

  computeHitboxes(type: EnemyTypeId, handle: EnemyInstanceHandle, out: Hitbox[]): number {
    this.hitboxCalls++;
    const s = this.slot(type, handle);
    const def = getEnemyVisualDef(type);
    if (!s || !def) return 0;
    const scale = s.pose.scale ?? 1;
    let n = 0;
    for (const hb of def.hitboxes) {
      const twins = hb.mirror ? 2 : 1;
      for (let m = 0; m < twins; m++) {
        let box = out[n];
        if (!box) {
          box = { shape: 'sphere', zone: 'body', a: new Vector3(), b: new Vector3(), radius: 0 };
          out.push(box);
        }
        box.shape = hb.shape;
        box.zone = hb.zone;
        box.radius = hb.radius * scale;
        toWorld(hb.a, s.pos, s.yaw, scale, m === 1, box.a);
        toWorld(hb.b ?? hb.a, s.pos, s.yaw, scale, m === 1, box.b);
        n++;
      }
    }
    return n;
  }

  computeBounds(type: EnemyTypeId, handle: EnemyInstanceHandle, outCenter: Vector3): number {
    const s = this.slot(type, handle);
    if (!s) return 0;
    const scale = s.pose.scale ?? 1;
    const def = getEnemyVisualDef(type);
    let top = 1;
    for (const hb of def?.hitboxes ?? [])
      top = Math.max(top, hb.a[1] + hb.radius, (hb.b?.[1] ?? 0) + hb.radius);
    outCenter.set(s.pos.x, s.pos.y + (top * scale) / 2, s.pos.z);
    return top * scale;
  }

  computeAimPoint(type: EnemyTypeId, handle: EnemyInstanceHandle, out: Vector3): Vector3 {
    const def = getEnemyVisualDef(type);
    return this.computeSocket(type, handle, def?.aimSocket ?? 'chest', out);
  }

  computeSocket(type: EnemyTypeId, handle: EnemyInstanceHandle, socket: string, out: Vector3): Vector3 {
    const s = this.slot(type, handle);
    const anchors = getEnemyVisualDef(type)?.sockets[socket];
    if (!s || !anchors || anchors.length === 0) return out;
    const scale = s.pose.scale ?? 1;
    const acc = new Vector3();
    const p = new Vector3();
    for (const a of anchors) acc.add(toWorld(a.point, s.pos, s.yaw, scale, false, p));
    return out.copy(acc.multiplyScalar(1 / anchors.length));
  }

  update(): void {
    this.updates++;
  }

  dispose(): void {
    this.slots.clear();
  }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export class FakePlayer implements EnemyTargetApi {
  readonly position = new Vector3();
  readonly eyePosition = new Vector3();
  readonly velocity = new Vector3();
  alive = true;
  yaw = 0;
  health = 100000;
  eyeHeight = 1.62;
  readonly hits: { amount: number; direction: Vec3Like | undefined; time: number }[] = [];
  clock = 0;

  constructor(x = 0, y = 0, z = 0) {
    this.setPosition(x, y, z);
  }

  setPosition(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.eyePosition.set(x, y + this.eyeHeight, z);
  }

  damage(amount: number, direction?: Vec3Like): number {
    if (!this.alive || !(amount > 0)) return 0;
    this.hits.push({ amount, direction: direction ? { ...direction } : undefined, time: this.clock });
    this.health -= amount;
    if (this.health <= 0) this.alive = false;
    return amount;
  }

  get totalDamage(): number {
    return this.hits.reduce((s, h) => s + h.amount, 0);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Static BVH boxes (bullet/LOS blockers). A floor slab is always added. */
  boxes?: { center: Vec3Like; size: Vec3Like }[];
  player?: Vec3Like;
  manager?: Partial<EnemyManagerDeps>;
  nav?: NavApi;
}

export const DT = 1 / 60;

export function createEnemyHarness(opts: HarnessOptions = {}) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events });
  const level = buildTestLevel([
    { material: 'floor_concrete', center: { x: 0, y: -0.25, z: 0 }, size: { x: 200, y: 0.5, z: 200 } },
    ...(opts.boxes ?? []).map((b) => ({ material: 'concrete_wall', center: b.center, size: b.size })),
  ]);
  const root = new Group();
  root.add(level);
  combat.setLevel(root);
  const nav = (opts.nav as FakeNav | undefined) ?? new FakeNav();
  const visuals = new FakeVisuals();
  const p = opts.player ?? { x: 0, y: 0, z: 0 };
  const player = new FakePlayer(p.x, p.y, p.z);
  const manager = new EnemyManager({
    events,
    combat,
    nav,
    visuals,
    target: player,
    seed: 'test',
    ...opts.manager,
  });
  const recorded: { type: keyof GameEvents; payload: unknown }[] = [];
  const record = <K extends keyof GameEvents>(type: K): void => {
    events.on(type, (payload) => recorded.push({ type, payload: JSON.parse(JSON.stringify(payload)) }));
  };
  for (const t of [
    'enemy:spawned',
    'enemy:alert',
    'enemy:attack',
    'enemy:staggered',
    'enemy:died',
    'combat:kill',
    'combat:impact',
    'camera:shake',
  ] as const) {
    record(t);
  }
  let time = 0;
  const tick = (n = 1, before?: (t: number) => void): void => {
    for (let i = 0; i < n; i++) {
      time += DT;
      player.clock = time;
      before?.(time);
      manager.fixedUpdate(DT);
    }
  };
  const byType = (type: keyof GameEvents) => recorded.filter((r) => r.type === type).map((r) => r.payload);
  return { events, combat, nav, visuals, player, manager, tick, recorded, byType, level: root };
}
