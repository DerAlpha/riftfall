/**
 * TrapSystem (TrapApi, M7): every trap of the map from its TrapSlotDefs (the level's `trapSlots`,
 * else TRAP_SLOTS[mapId] – maps/kit/levelData), their activation panels registered with the
 * InteractionSystem, and one merged mesh per material for every static trap body (PropBuilder).
 *
 * Fixed tick (Game: fixedTick after the fields – this tick's hitboxes, before the status effects
 * resolve the build-up): active traps deal damage; timers run. Frame: visuals, panel screens,
 * positional loops near the listener. Trap damage has source 'trap' (no points); kills are counted
 * per trap and for the run (`kills`, the run's `trap kills`). Power: panels refuse while the map
 * is unpowered; running traps keep going until their time is up.
 */
import { Group, type Object3D } from 'three';
import type { EconomyApi, InteractionApi, TrapApi, TrapReadout } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import type { TrapSlotDef } from '../defs/traps';
import type { KitAudio, KitBlockers, KitCombat, KitPlayer, KitVfx, KitVisuals } from '../maps/kit/kitTypes';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { FanTrap } from './FanTrap';
import { FenceTrap } from './FenceTrap';
import { FlameTrap } from './FlameTrap';
import type { Trap, TrapContext } from './Trap';
import { TurretTrap } from './TurretTrap';

const log = createLogger('traps');

export interface TrapSystemDeps {
  slots: readonly TrapSlotDef[];
  events: EventBus<GameEvents>;
  combat: KitCombat;
  economy: Pick<EconomyApi, 'spend'>;
  interaction: Pick<InteractionApi, 'register' | 'unregister'> | null;
  power: { readonly powered: boolean };
  player?: KitPlayer | null;
  vfx?: KitVfx | null;
  audio?: KitAudio | null;
  /** Null: logic only (tests, headless). */
  visuals?: KitVisuals | null;
  blockers?: KitBlockers | null;
  seed?: string | number;
}

export class TrapSystem implements TrapApi {
  readonly list: readonly Trap[];
  private _kills = 0;
  private readonly root: Group | null;
  private readonly propMeshes: Object3D[] = [];
  private rng: Rng;
  private readonly ctx: TrapContext;
  private readonly visuals: KitVisuals | null;
  private readonly interaction: Pick<InteractionApi, 'register' | 'unregister'> | null;
  private time = 0;
  private disposed = false;

  constructor(deps: TrapSystemDeps) {
    this.rng = new Rng(`traps:${deps.seed ?? 'default'}`);
    this.interaction = deps.interaction;
    const v = deps.visuals ?? null;
    let root: Group | null = null;
    let visuals: KitVisuals | null = null;
    if (v) {
      root = new Group();
      root.name = 'traps';
      v.root.add(root);
      visuals = { ...v, root };
    }
    this.root = root;
    this.visuals = visuals;
    const props = visuals ? new PropBuilder() : null;
    const ctx: TrapContext = (this.ctx = {
      events: deps.events,
      combat: deps.combat,
      player: deps.player ?? null,
      vfx: deps.vfx ?? null,
      audio: deps.audio ?? null,
      rng: this.rng,
      power: deps.power,
      economy: deps.economy,
      visuals,
      props,
      blockers: deps.blockers ?? null,
      onKill: () => {
        this._kills++;
      },
    });
    const traps: Trap[] = [];
    const ids = new Set<string>();
    for (const slot of deps.slots) {
      if (ids.has(slot.id)) {
        log.warn(`Trap slot "${slot.id}" is defined twice – the second one is skipped`);
        continue;
      }
      ids.add(slot.id);
      const trap = createTrap(slot, ctx);
      if (!trap) continue;
      traps.push(trap);
      deps.interaction?.register(trap.panel);
    }
    this.list = traps;
    if (props && visuals && root) {
      const mats = visuals.materials;
      this.propMeshes.push(...props.meshes((key) => mats.get(key), root, true));
      props.dispose();
      root.updateMatrixWorld(true);
    }
    if (traps.length > 0) log.info(`Traps: ${traps.map((t) => `${t.id} (${t.kind})`).join(', ')}`);
  }

  get traps(): readonly TrapReadout[] {
    return this.list;
  }

  get kills(): number {
    return this._kills;
  }

  /** Draws on the volumetric layer (arcs, flames, streaks, lasers, screens, glow pools). */
  get hasVolumetricContent(): boolean {
    return !this.disposed && this.list.length > 0 && this.root !== null;
  }

  get(id: string): Trap | undefined {
    return this.list.find((t) => t.id === id);
  }

  activate(id: string, free = false): boolean {
    const t = this.get(id);
    if (!t) return false;
    return free ? t.activate() : t.purchase();
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    for (let i = 0; i < this.list.length; i++) this.list[i]!.fixedUpdate(dt);
  }

  /** Per frame; `listener` (camera) starts / stops the positional loops. */
  update(dt: number, listener: Vec3Like | null = null): void {
    if (this.disposed) return;
    this.time += dt;
    const reduced = this.visuals?.reduceFlashing ?? false;
    for (let i = 0; i < this.list.length; i++) this.list[i]!.update(dt, this.time, listener, reduced);
  }

  /** New run: every trap ready, kills cleared; `seed` restarts the turret spread stream. */
  reset(seed?: string | number): void {
    this._kills = 0;
    if (seed !== undefined) {
      this.rng = new Rng(`traps:${seed}`);
      this.ctx.rng = this.rng;
    }
    for (const t of this.list) t.reset();
  }

  setReducedFlashing(reduced: boolean): void {
    if (this.visuals) this.visuals.reduceFlashing = reduced;
  }

  /** Visual roots of the traps' power-dependent parts (not used for dimming: panels show it). */
  get objects(): readonly Object3D[] {
    return this.root ? [this.root] : [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.list) {
      this.interaction?.unregister(t.panel);
      t.dispose();
    }
    for (const m of this.propMeshes) {
      m.removeFromParent();
      (m as { geometry?: { dispose(): void } }).geometry?.dispose();
    }
    this.root?.removeFromParent();
  }
}

function createTrap(slot: TrapSlotDef, ctx: TrapContext): Trap | null {
  switch (slot.kind) {
    case 'fence':
      return new FenceTrap(slot, ctx);
    case 'turret':
      return new TurretTrap(slot, ctx);
    case 'fan':
      return new FanTrap(slot, ctx);
    case 'flame':
      return new FlameTrap(slot, ctx);
    default: {
      const kind = (slot as { kind?: unknown }).kind;
      log.warn(`Trap slot "${(slot as { id?: string }).id}": unknown kind "${String(kind)}" – skipped`);
      return null;
    }
  }
}
