/**
 * Visible enemy beams (M6): healing tethers, laser telegraphs, summon channels.
 *
 * Attack executors open ONE beam per enemy from one of its sockets to an ally (that ally's aim
 * point, followed every tick) or to a world point. The host samples the endpoints once per tick
 * after the enemies moved (sample(): the same tick state the renderer snapshots) and draws them
 * every frame interpolated like the enemy instances (prev → cur by alpha) through the VFX system's
 * arsenal beams (defs/arsenalVfx BEAM_STYLES; a beam not refreshed in a frame vanishes there).
 * One-shot rays (a fired laser) are queued and handed over with the next frame.
 *
 * Preallocated slots (ENEMY_AI.beams), no allocations per tick or frame. Without a sink (tests,
 * headless) the bookkeeping runs and nothing is drawn.
 */
import { Vector3 } from 'three';
import type { Vec3Like } from '../core/events';
import { ENEMY_AI } from '../defs/enemies';
import type { Enemy } from './Enemy';

/** Where beams are drawn: the VFX system's arsenal visuals (ArsenalVfx satisfies it). */
export interface EnemyBeamSink {
  /** Per frame while the beam is up; `arcs`: chain arcs (unused here). */
  beam(visual: string, from: Vec3Like, to: Vec3Like, arcs: readonly Vec3Like[], arcCount: number): void;
  /** One-shot ray that lingers and fades on its own. */
  shot(visual: string, to: Vec3Like, from: Vec3Like): void;
}

/** What executors see (AiHost.beams). */
export interface EnemyBeamsApi {
  /** Open (or re-style) the enemy's beam from `socket`; false when every slot is taken. */
  open(e: Enemy, visual: string, socket: string): boolean;
  /** Aim the open beam at an ally (its aim point, followed every tick)... */
  toEnemy(e: Enemy, ally: Enemy): void;
  /** ... or at a world point (copied). */
  toPoint(e: Enemy, point: Vec3Like): void;
  setVisual(e: Enemy, visual: string): void;
  close(e: Enemy): void;
  isOpen(e: Enemy): boolean;
  /** One-shot ray from → to (drawn with the next frame, fades on its own). */
  shot(visual: string, from: Vec3Like, to: Vec3Like): void;
}

/** Socket lookup of the host (AiHost.socket). */
export interface BeamSocketSource {
  socket(e: Enemy, name: string, out: Vector3): boolean;
}

const NO_ARCS: readonly Vec3Like[] = [];
const _from = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

class BeamSlot {
  owner: Enemy | null = null;
  ownerId = 0;
  visual = '';
  socket = '';
  ally: Enemy | null = null;
  allyId = 0;
  readonly point = new Vector3();
  readonly prevFrom = new Vector3();
  readonly curFrom = new Vector3();
  readonly prevTo = new Vector3();
  readonly curTo = new Vector3();
  /** Ticks sampled since opened (drawn from the first one). */
  samples = 0;
}

class QueuedShot {
  visual = '';
  readonly from = new Vector3();
  readonly to = new Vector3();
}

export class EnemyBeams implements EnemyBeamsApi {
  private readonly slots: BeamSlot[] = [];
  private readonly queue: QueuedShot[] = [];
  private queued = 0;
  private _open = 0;

  constructor(
    capacity: number = ENEMY_AI.beams.capacity,
    shotQueue: number = ENEMY_AI.beams.shotQueue,
  ) {
    for (let i = 0; i < Math.max(1, capacity); i++) this.slots.push(new BeamSlot());
    for (let i = 0; i < Math.max(1, shotQueue); i++) this.queue.push(new QueuedShot());
  }

  /** Beams currently open. */
  get openCount(): number {
    return this._open;
  }

  open(e: Enemy, visual: string, socket: string): boolean {
    let s = this.find(e);
    if (!s) {
      s = this.free();
      if (!s) return false;
      s.owner = e;
      s.ownerId = e.id;
      s.samples = 0;
      s.ally = null;
      s.allyId = 0;
      s.point.copy(e.position);
      this._open++;
    }
    s.visual = visual;
    s.socket = socket;
    return true;
  }

  toEnemy(e: Enemy, ally: Enemy): void {
    const s = this.find(e);
    if (!s) return;
    s.ally = ally;
    s.allyId = ally.id;
  }

  toPoint(e: Enemy, point: Vec3Like): void {
    const s = this.find(e);
    if (!s) return;
    s.ally = null;
    s.allyId = 0;
    s.point.set(point.x, point.y, point.z);
  }

  setVisual(e: Enemy, visual: string): void {
    const s = this.find(e);
    if (s) s.visual = visual;
  }

  close(e: Enemy): void {
    const s = this.find(e);
    if (s) this.release(s);
  }

  isOpen(e: Enemy): boolean {
    return this.find(e) !== null;
  }

  shot(visual: string, from: Vec3Like, to: Vec3Like): void {
    const q = this.queue;
    // Full: the oldest queued shot is dropped (it would have faded within a frame or two anyway).
    if (this.queued >= q.length) {
      const first = q[0]!;
      for (let i = 1; i < q.length; i++) q[i - 1] = q[i]!;
      q[q.length - 1] = first;
      this.queued = q.length - 1;
    }
    const s = q[this.queued++]!;
    s.visual = visual;
    s.from.set(from.x, from.y, from.z);
    s.to.set(to.x, to.y, to.z);
  }

  /**
   * Once per tick after the enemies moved and posed: the endpoints of this tick (socket →
   * ally aim point / world point). Beams of freed records close.
   */
  sample(host: BeamSocketSource): void {
    for (const s of this.slots) {
      const e = s.owner;
      if (!e) continue;
      if (e.id !== s.ownerId || e.state === 'free') {
        this.release(s);
        continue;
      }
      if (!host.socket(e, s.socket, _from)) {
        _from.set(e.position.x, e.position.y + e.def.perception.eyeHeight * e.pose.scale, e.position.z);
      }
      const ally = s.ally;
      if (ally && ally.id === s.allyId && ally.state !== 'free') s.point.copy(ally.aimPoint);
      if (s.samples === 0) {
        s.prevFrom.copy(_from);
        s.prevTo.copy(s.point);
      } else {
        s.prevFrom.copy(s.curFrom);
        s.prevTo.copy(s.curTo);
      }
      s.curFrom.copy(_from);
      s.curTo.copy(s.point);
      s.samples++;
    }
  }

  /** Per frame: open beams between the last two tick samples, then the queued one-shot rays. */
  draw(alpha: number, sink: EnemyBeamSink | null): void {
    const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    for (const s of this.slots) {
      if (!s.owner || s.samples === 0 || !sink) continue;
      _a.lerpVectors(s.prevFrom, s.curFrom, t);
      _b.lerpVectors(s.prevTo, s.curTo, t);
      sink.beam(s.visual, _a, _b, NO_ARCS, 0);
    }
    for (let i = 0; i < this.queued; i++) {
      const q = this.queue[i]!;
      sink?.shot(q.visual, q.to, q.from);
    }
    this.queued = 0;
  }

  clear(): void {
    for (const s of this.slots) if (s.owner) this.release(s);
    this.queued = 0;
  }

  /** Endpoints of the enemy's beam at the latest sample (tests / debug); false when none. */
  endpoints(e: Enemy, from: Vector3, to: Vector3): boolean {
    const s = this.find(e);
    if (!s || s.samples === 0) return false;
    from.copy(s.curFrom);
    to.copy(s.curTo);
    return true;
  }

  /** Visual id of the enemy's open beam ('' when none). */
  visualOf(e: Enemy): string {
    return this.find(e)?.visual ?? '';
  }

  private find(e: Enemy): BeamSlot | null {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (s.owner === e && s.ownerId === e.id) return s;
    }
    return null;
  }

  private free(): BeamSlot | null {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) if (!slots[i]!.owner) return slots[i]!;
    return null;
  }

  private release(s: BeamSlot): void {
    s.owner = null;
    s.ownerId = 0;
    s.ally = null;
    s.allyId = 0;
    s.samples = 0;
    this._open = Math.max(0, this._open - 1);
  }
}
