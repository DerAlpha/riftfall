/**
 * Rift seals (M4, the barricade equivalent): one energy lattice ("Riss-Siegel") of
 * SEALS.segments bars per spawn point of a wave map (defs/seals.ts).
 *
 * - Enemies (EnemyBreachApi, wired into EnemyManager.setBreach): enemies spawning at a sealed point
 *   are confined to the pen behind the seal and tear it down bar by bar ('breach' state); every
 *   fallen bar emits `seal:broken`. Once no bar stands they enter normally.
 * - Player: every seal is an Interactable (register through InteractionApi, `attach`): holding
 *   'interact' restores one bar per hold (SEALS.repair.holdTime), pays points through the
 *   RepairRewardsApi (economy/PointsRules: ECONOMY.repair per bar, capped per wave) and emits
 *   `seal:repaired`.
 * - Carpenter power-up: repairAll() restores every bar (no repair points: the power-up pays its own).
 * - reset(): new run, every seal intact, silently.
 *
 * Event payloads are reused objects (copy what you keep). `seal:repaired.planks` = bars restored
 * by that action. Visuals: SealView (only with a scene); logic works without (tests).
 */
import { Vector3, type Material, type Object3D } from 'three';
import type { InteractionApi, SpawnPointDef, VfxApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { SEALS, sealGateDef } from '../defs/seals';
import type { EnemyBreachApi } from '../enemies/ai/breach';
import { Seal, type SealHost } from './Seal';
import {
  alongPlane,
  barHeight,
  buildSealFrame,
  confineToPen,
  frontDistance,
  planePoint,
  type SealProbe,
} from './sealGeometry';
import { SealView } from './SealView';

/**
 * Points for restored bars (economy/PointsRules implements it: ECONOMY.repair.perPlank per bar
 * through EconomyApi.earn 'repair', at most ECONOMY.repair.capPerWave per wave – anti-farming).
 */
export interface RepairRewardsApi {
  /** Pay for `segments` restored bars within the per-wave cap; returns the points credited. */
  awardRepair(segments: number, position?: Vec3Like): number;
  /** Points (before the multiplier) still payable this wave (prompt hint); optional. */
  readonly repairAllowance?: number;
}

/** InteractionApi as the seals use it (focus / hold progress drive the repair ghost). */
export type SealInteraction = Pick<InteractionApi, 'register' | 'unregister'> &
  Partial<Pick<InteractionApi, 'focused' | 'holdProgress'>>;

export interface SealSystemDeps {
  events: EventBus<GameEvents>;
  /** The map's spawn points: one seal each. */
  spawnPoints: readonly SpawnPointDef[];
  /** World scene for the visuals (null: logic only). */
  scene?: Object3D | null;
  /** Lit pylons → render.setupMaterial. */
  setupMaterial?: ((m: Material) => void) | null;
  vfx?: Pick<VfxApi, 'spawn'> | null;
  /** Repair points (PointsRules); null = repairs pay nothing. */
  rewards?: RepairRewardsApi | null;
  /** Static-world ray probe: fits each gate into its room at build time (null: def sizes). */
  probe?: SealProbe | null;
  reduceFlashing?: boolean;
  /** Bars per seal (default SEALS.segments). */
  segments?: number;
}

const _p = new Vector3();
const _n = { x: 0, y: 0, z: 0 };

export class SealSystem implements EnemyBreachApi, SealHost {
  readonly view: SealView | null;
  private readonly _seals: Seal[] = [];
  private readonly byPoint = new Map<string, Seal>();
  private readonly byId = new Map<string, Seal>();
  private readonly events: EventBus<GameEvents>;
  private readonly vfx: Pick<VfxApi, 'spawn'> | null;
  private rewards: RepairRewardsApi | null;
  private interaction: SealInteraction | null = null;
  private readonly brokenPayload: GameEvents['seal:broken'] = { sealId: '', position: { x: 0, y: 0, z: 0 } };
  private readonly repairedPayload: GameEvents['seal:repaired'] = {
    sealId: '',
    planks: 0,
    position: { x: 0, y: 0, z: 0 },
  };
  private disposed = false;

  constructor(deps: SealSystemDeps) {
    this.events = deps.events;
    this.vfx = deps.vfx ?? null;
    this.rewards = deps.rewards ?? null;
    const segments = deps.segments ?? SEALS.segments;
    for (const sp of deps.spawnPoints) {
      if (this.byPoint.has(sp.id)) continue;
      const frame = buildSealFrame(sp, sealGateDef(sp.kind), deps.probe ?? null);
      const seal = new Seal(sp, frame, segments, this);
      this._seals.push(seal);
      this.byPoint.set(sp.id, seal);
      this.byId.set(seal.id, seal);
    }
    this.view = deps.scene
      ? new SealView(deps.scene, this._seals, {
          setupMaterial: deps.setupMaterial ?? null,
          reduceFlashing: deps.reduceFlashing ?? false,
        })
      : null;
  }

  get seals(): readonly Seal[] {
    return this._seals;
  }

  /** The seals draw on the volumetric layer (OR into the render's volumetric content probe). */
  get hasVolumetricContent(): boolean {
    return this.view !== null && this.view.visible;
  }

  /** Seal of a spawn point (or by its `seal:` id). */
  seal(id: string): Seal | undefined {
    return this.byPoint.get(id) ?? this.byId.get(id);
  }

  /** Bars down over all seals (carpenter drop condition). */
  get brokenSegments(): number {
    let n = 0;
    for (const s of this._seals) n += s.broken;
    return n;
  }

  setRewards(rewards: RepairRewardsApi | null): void {
    this.rewards = rewards;
  }

  /** Register every seal as an Interactable (and read the focus for the repair ghost). */
  attach(interaction: SealInteraction | null): void {
    if (this.interaction === interaction) return;
    this.detach();
    this.interaction = interaction;
    if (interaction) for (const s of this._seals) interaction.register(s);
  }

  detach(): void {
    const i = this.interaction;
    if (!i) return;
    for (const s of this._seals) i.unregister(s);
    this.interaction = null;
  }

  // -------------------------------------------------------------------------
  // EnemyBreachApi
  // -------------------------------------------------------------------------

  segmentsLeft(spawnPointId: string): number {
    return this.byPoint.get(spawnPointId)?.up ?? 0;
  }

  confine(spawnPointId: string, position: Vector3, radius: number): boolean {
    const s = this.byPoint.get(spawnPointId);
    if (!s) return false;
    confineToPen(s.frame, position, radius);
    return true;
  }

  frontDistance(spawnPointId: string, p: Vec3Like): number {
    const s = this.byPoint.get(spawnPointId);
    return s ? frontDistance(s.frame, p) : Number.POSITIVE_INFINITY;
  }

  strike(spawnPointId: string, segments: number, from: Vec3Like): number {
    const s = this.byPoint.get(spawnPointId);
    if (!s || s.up <= 0) return 0;
    const f = s.frame;
    const u = Math.min(f.right, Math.max(-f.left, alongPlane(f, from)));
    const span = f.left + f.right;
    s.hit(span > 0 ? (u + f.left) / span : 0.5);
    if (segments > 0) {
      this.breakBars(s, segments);
    } else if (this.vfx) {
      planePoint(f, u, barHeight(f, s.up - 1, s.segments), _p);
      this.vfx.spawn(SEALS.vfx.hit, _p, this.normal(s), SEALS.vfx.hitScale);
    }
    return s.up;
  }

  // -------------------------------------------------------------------------
  // SealHost (the Interactable side)
  // -------------------------------------------------------------------------

  promptFor(_seal: Seal): string {
    const left = this.rewards?.repairAllowance;
    return left !== undefined && left <= 0 ? SEALS.prompts.repairNoPoints : SEALS.prompts.repair;
  }

  repairFromPlayer(seal: Seal): void {
    this.repairBars(seal, 1, true);
  }

  // -------------------------------------------------------------------------
  // Commands (power-ups, dev console, run flow)
  // -------------------------------------------------------------------------

  /** Restore `count` bars of a seal (no points unless `pay`); returns bars restored. */
  repair(id: string, count = Number.POSITIVE_INFINITY, pay = false): number {
    const s = this.seal(id);
    return s ? this.repairBars(s, count, pay) : 0;
  }

  /** Carpenter: every seal fully restored (no repair points). Returns bars restored. */
  repairAll(): number {
    let n = 0;
    for (const s of this._seals) n += this.repairBars(s, s.segments, false);
    return n;
  }

  /** Break `count` bars of a seal (dev console); returns bars broken. */
  breakSeal(id: string, count = Number.POSITIVE_INFINITY): number {
    const s = this.seal(id);
    return s ? this.breakBars(s, count) : 0;
  }

  breakAll(): number {
    let n = 0;
    for (const s of this._seals) n += this.breakBars(s, s.segments);
    return n;
  }

  /** Seal nearest to a point (dev console), or null. */
  nearest(p: Vec3Like): Seal | null {
    let best: Seal | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of this._seals) {
      const d = (s.position.x - p.x) ** 2 + (s.position.z - p.z) ** 2 + (s.position.y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** New run: every seal intact at once, no events (the view too: a reset runs behind a menu). */
  reset(): void {
    for (const s of this._seals) s.resetFull();
    this.view?.update(0);
  }

  /** Per frame: bar animations, the repair ghost of the focused seal, the view. */
  update(dt: number): void {
    if (this.disposed) return;
    const i = this.interaction;
    const focus = i?.focused ?? null;
    const progress = i?.holdProgress ?? 0;
    for (const s of this._seals) {
      s.preview = s === focus && s.canInteract() ? progress : 0;
      s.updateVisual(dt);
    }
    this.view?.update(dt);
  }

  setReducedFlashing(on: boolean): void {
    this.view?.setReducedFlashing(on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.view?.dispose();
  }

  // -------------------------------------------------------------------------

  private breakBars(s: Seal, count: number): number {
    const before = s.up;
    const k = s.take(count);
    const f = s.frame;
    const mid = (f.right - f.left) / 2;
    for (let i = before - 1; i >= before - k; i--) {
      planePoint(f, mid, barHeight(f, i, s.segments), _p);
      this.vfx?.spawn(SEALS.vfx.break, _p, this.normal(s), SEALS.vfx.breakScale);
      const e = this.brokenPayload;
      e.sealId = s.id;
      copy(_p, e.position);
      this.events.emit('seal:broken', e);
    }
    return k;
  }

  private repairBars(s: Seal, count: number, pay: boolean): number {
    const first = s.up;
    const k = s.restore(count);
    if (k === 0) return 0;
    const f = s.frame;
    const mid = (f.right - f.left) / 2;
    // Effect and event at the (lowest) restored bar.
    planePoint(f, mid, barHeight(f, first, s.segments), _p);
    this.vfx?.spawn(SEALS.vfx.repair, _p, this.normal(s), SEALS.vfx.repairScale);
    if (pay) this.rewards?.awardRepair(k, _p);
    const e = this.repairedPayload;
    e.sealId = s.id;
    e.planks = k;
    copy(_p, e.position);
    this.events.emit('seal:repaired', e);
    return k;
  }

  private normal(s: Seal): Vec3Like {
    _n.x = s.frame.fx;
    _n.y = 0;
    _n.z = s.frame.fz;
    return _n;
  }
}

function copy(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
