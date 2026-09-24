/**
 * M5 workshop placement: the Rift Forge and the Werkbank of a map (defs/workshop.ts placements),
 * each with its solid volume (SolidBlocker: collider, bullets, nav area) and – with visuals – its
 * view. Called by placeInteractables (the shared visual context, blockers and registration);
 * without `WorkshopDeps` a map gets neither machine.
 */
import { Vector3 } from 'three';
import type { AudioApi, EconomyApi, Interactable, VfxApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { WEAPON_IDS } from '../defs/weapons';
import { RIFT_FORGE_MACHINE, WORKBENCH, type WorkshopPlacementDef } from '../defs/workshop';
import { RiftForge, type WorkshopHands, type WorkshopWeapons } from './RiftForge';
import { facingNormal, facingYaw, propBox, propNavBox } from './shapes';
import { SolidBlocker, type SolidBlockerDeps } from './SolidBlocker';
import type { VisualContext } from './visuals/context';
import { RiftForgeView } from './visuals/RiftForgeView';
import { WorkbenchView } from './visuals/WorkbenchView';
import { Workbench, type WorkbenchMenuApi } from './Workbench';

/** What the forge and the bench need beyond the shared interactable deps (Game wires them). */
export interface WorkshopDeps {
  weapons: WorkshopWeapons;
  /** Hands the held weapon to the forge and back; null = the weapon stays in hand (tests). */
  hands?: WorkshopHands | null;
  /** The interactable in focus (closes the bench menu when it moves away). */
  focused?: (() => Interactable | null) | null;
  menu?: WorkbenchMenuApi | null;
  audio?: Pick<AudioApi, 'play'> | null;
}

export interface WorkshopContext {
  mapId: string;
  events: EventBus<GameEvents>;
  /** `points` (optional) colors unaffordable bench entries. */
  economy: Pick<EconomyApi, 'spend' | 'earn'> & { readonly points?: number };
  blockerDeps: SolidBlockerDeps;
  /** Null: logic only. */
  ctx: VisualContext | null;
  vfx: Pick<VfxApi, 'spawn'> | null;
  player: { readonly position: Vec3Like } | null;
  register(i: Interactable): void;
}

export interface WorkshopHandle {
  readonly forge: RiftForge | null;
  readonly workbench: Workbench | null;
  fixedUpdate(dt: number): void;
  update(dt: number, time: number): void;
  reset(): void;
  dispose(): void;
}

interface MachinePlacement {
  /** Floor center of the machine. */
  center: Vector3;
  yaw: number;
  /** Prompt anchor. */
  anchor: Vector3;
}

function place(
  p: WorkshopPlacementDef,
  size: { width: number; depth: number },
  wallGap: number,
  anchor: { y: number; offset: number },
  anchorZ = size.depth / 2,
): MachinePlacement {
  const n = facingNormal(p.facing);
  const off = wallGap + size.depth / 2;
  const center = new Vector3(p.position[0] + n.x * off, p.position[1], p.position[2] + n.z * off);
  const a = anchorZ + anchor.offset;
  return {
    center,
    yaw: facingYaw(p.facing),
    anchor: new Vector3(center.x + n.x * a, center.y + anchor.y, center.z + n.z * a),
  };
}

function blocker(
  deps: SolidBlockerDeps,
  m: MachinePlacement,
  size: { width: number; height: number; depth: number },
  materialId: string,
): SolidBlocker {
  const box = propBox(m.center, m.yaw, size.width, size.height, size.depth);
  return new SolidBlocker(deps, { collider: box, bullets: { box, materialId }, nav: propNavBox(box) }, true);
}

export function placeWorkshop(deps: WorkshopDeps, w: WorkshopContext): WorkshopHandle {
  let forge: RiftForge | null = null;
  let workbench: Workbench | null = null;

  const forgeDef = RIFT_FORGE_MACHINE.placements[w.mapId]?.[0];
  if (forgeDef) {
    const F = RIFT_FORGE_MACHINE;
    const m = place(forgeDef, F.size, F.wallGap, F.anchor, F.layout.anvil.z + F.layout.anvil.top[2] / 2);
    const view = w.ctx ? new RiftForgeView(w.ctx, m.center, m.yaw, w.vfx) : null;
    forge = new RiftForge(forgeDef.id, m.anchor, {
      weapons: deps.weapons,
      economy: w.economy,
      hands: deps.hands ?? null,
      view,
      events: w.events,
      player: w.player,
      blocker: blocker(w.blockerDeps, m, F.size, F.blockerMaterial),
    });
    w.register(forge);
  }

  const benchDef = WORKBENCH.placements[w.mapId]?.[0];
  if (benchDef) {
    const B = WORKBENCH;
    const m = place(benchDef, B.size, B.wallGap, B.anchor);
    const view = w.ctx ? new WorkbenchView(w.ctx, m.center, m.yaw) : null;
    workbench = new Workbench(benchDef.id, m.anchor, {
      weapons: deps.weapons,
      economy: w.economy,
      focused: deps.focused ?? null,
      menu: deps.menu ?? null,
      view,
      audio: deps.audio ?? null,
      blocker: blocker(w.blockerDeps, m, B.size, B.blockerMaterial),
    });
    w.register(workbench);
  }

  // The anvil and the bench show a hologram of the weapon in hand: build them at load time.
  if (w.ctx && (forge || workbench)) w.ctx.holograms.prewarm(WEAPON_IDS);

  return {
    forge,
    workbench,
    fixedUpdate(dt: number): void {
      forge?.fixedUpdate(dt);
      workbench?.fixedUpdate(dt);
    },
    update(dt: number, time: number): void {
      forge?.update(dt, time);
      workbench?.update(dt, time);
    },
    reset(): void {
      forge?.reset();
      workbench?.reset();
    },
    dispose(): void {
      forge?.dispose();
      workbench?.dispose();
    },
  };
}
