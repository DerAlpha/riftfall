/**
 * QuestSystem (QuestApi, M7): the map's easter egg – the QuestMachine plus its world objects and
 * wiring (QuestDef from the level's `questDef`, else QUESTS[mapId]):
 * - shoot steps: hidden targets are Damageables registered with CombatWorld only while their step
 *   runs (team 'neutral', ids from QUEST_VISUALS.idBase: no points, no aim assist); a player hit
 *   burns the tag out (sparks, chime),
 * - collect steps: items float at their spot (hum); walking into one picks it up (carried),
 * - interact steps: objects are Interactables whose prompt only appears while the step wants them
 *   (and the carried item is there); the socket takes the rift core,
 * - kill steps: player kills (combat:damage, killed) filtered by volume / zone / element / weapon /
 *   enemy; trap steps: trap:state 'active',
 * - defend steps: stay inside the radius (a ring fills; leaving pauses, then drains).
 * Hints are cues only (flicker, hums, pulses, the socket glowing while the core is carried) – the
 * only text is the completion banner. Rewards: a weapon given directly, a free perk, points; the
 * achievement comes from the 'quest:completed' event (Game → progression signal 'questComplete').
 * Everything resets per run.
 */
import { Group, Vector3 } from 'three';
import type {
  DamageInfo,
  DamageResult,
  Damageable,
  EconomyApi,
  Hitbox,
  Interactable,
  InteractionApi,
  PerkApi,
  QuestApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { PERK_IDS } from '../defs/perks';
import {
  QUEST_VISUALS,
  type QuestDef,
  type QuestItemDef,
  type QuestObjectDef,
  type QuestStepDef,
  type QuestTargetDef,
} from '../defs/quests';
import {
  PositionalLoop,
  type KitAudio,
  type KitBanner,
  type KitBlockers,
  type KitCombat,
  type KitPlayer,
  type KitVfx,
  type KitVisuals,
} from '../maps/kit/kitTypes';
import { SolidBlocker } from '../interactables/SolidBlocker';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { QuestMachine } from './QuestMachine';
import { propNavBox } from '../interactables/shapes';
import { CoreView, DefendView, SocketView, TagView, anchorNormal } from './questViews';

const log = createLogger('quests');
const V = QUEST_VISUALS;
const UP = { x: 0, y: 1, z: 0 };
const NO_DAMAGE: DamageResult = { applied: 0, killed: false };
const _n = new Vector3();

export interface QuestSystemDeps {
  def: QuestDef | null;
  mapId: string;
  events: EventBus<GameEvents>;
  combat: KitCombat;
  interaction: Pick<InteractionApi, 'register' | 'unregister'>;
  player: KitPlayer | null;
  weapons?: { give(weaponId: string): void } | null;
  perks?: Pick<PerkApi, 'has' | 'grant'> | null;
  economy?: Pick<EconomyApi, 'earn'> | null;
  /** Enemy type behind a damageable id (kill steps). */
  enemyType?: ((id: number) => string | null) | null;
  /** Map zone at a point (kill steps). */
  zoneAt?: ((x: number, z: number) => string | null) | null;
  audio?: KitAudio | null;
  vfx?: KitVfx | null;
  banner?: KitBanner | null;
  shockwave?: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  /** Level cue on step changes (the lab flares its rift anomaly). */
  pulse?: ((strength: number) => void) | null;
  visuals?: KitVisuals | null;
  /** Socket pedestals are solid (collider, bullets, nav area); null = not solid. */
  blockers?: KitBlockers | null;
}

/** A hidden target (Damageable): one player hit counts. */
class QuestTarget implements Damageable {
  readonly team = 'neutral' as const;
  readonly surface = 'armor' as const;
  readonly boundsCenter: Vector3;
  readonly boundsRadius: number;
  readonly hitboxes: readonly Hitbox[];
  readonly aimPoint: Vector3;
  alive = true;
  registered = false;

  constructor(
    readonly id: number,
    readonly def: QuestTargetDef,
    readonly step: number,
    readonly view: TagView | null,
    private readonly onHit: (t: QuestTarget) => void,
  ) {
    const n = anchorNormal(def.normal, _n);
    const r = V.tag.hitRadius;
    const c = new Vector3(def.position[0], def.position[1], def.position[2]).addScaledVector(n, r * 0.5);
    this.boundsCenter = c;
    this.boundsRadius = r;
    this.aimPoint = c;
    this.hitboxes = [{ shape: 'sphere', zone: 'body', a: c, b: c, radius: r }];
  }

  applyDamage(info: DamageInfo): DamageResult {
    if (!this.alive || info.source !== 'player') return NO_DAMAGE;
    this.onHit(this);
    return NO_DAMAGE;
  }
}

/** A collectible (floating item). */
interface QuestItem {
  readonly def: QuestItemDef;
  readonly step: number;
  readonly position: Vector3;
  readonly loop: PositionalLoop;
}

/** An interact object (socket, console). */
class QuestObject implements Interactable {
  readonly id: string;
  readonly position: Vector3;
  readonly range = V.socket.range;

  constructor(
    readonly def: QuestObjectDef,
    readonly step: number,
    private readonly machine: QuestMachine,
    readonly view: SocketView | null,
    private readonly onUse: (o: QuestObject) => void,
  ) {
    this.id = `quest:${def.id}`;
    const n = anchorNormal(def.normal, _n);
    const lift = def.normal === 'up' ? V.socket.anchorY : 0;
    this.position = new Vector3(def.position[0], def.position[1] + lift, def.position[2]).addScaledVector(
      n,
      def.normal === 'up' ? 0 : 0.3,
    );
  }

  prompt(): string {
    return this.machine.step === this.step && this.machine.wantsObject(this.def.id) ? this.def.prompt : '';
  }
  cost(): number | null {
    return null;
  }
  canInteract(): boolean {
    return this.prompt() !== '';
  }
  holdTime(): number {
    return this.def.hold;
  }
  interact(): void {
    if (this.machine.objectUsed(this.def.id)) this.onUse(this);
  }
}

export class QuestSystem implements QuestApi {
  readonly machine: QuestMachine | null;
  private readonly targets: QuestTarget[] = [];
  private readonly items: QuestItem[] = [];
  private readonly objects: QuestObject[] = [];
  private readonly tagLoops: PositionalLoop[] = [];
  private readonly defends: {
    step: number;
    view: DefendView;
    def: Extract<QuestStepDef, { kind: 'defend' }>;
  }[] = [];
  private readonly core: CoreView | null = null;
  private readonly blockers: SolidBlocker[] = [];
  private readonly root: Group | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly stepPayload: GameEvents['quest:step'];
  private readonly completePayload: GameEvents['quest:completed'];
  private carryLoop = 0;
  private defendLoop = 0;
  private time = 0;
  /** Where the carried core sits after feeding (socket cradle) – shown during the defend step. */
  private fed: Vector3 | null = null;
  private disposed = false;
  /** Target registration changed inside a damage call: re-synced on the next tick / frame. */
  private dirty = false;

  constructor(private readonly deps: QuestSystemDeps) {
    const def = deps.def;
    this.stepPayload = { questId: def?.id ?? '', stepId: '', step: 0, steps: def?.steps.length ?? 0 };
    this.completePayload = { questId: def?.id ?? '', mapId: deps.mapId };
    if (!def || def.steps.length === 0) {
      this.machine = null;
      return;
    }
    this.machine = new QuestMachine(def, {
      onStep: (i, s) => this.onStep(i, s),
      onComplete: () => this.onComplete(),
    });
    const v = deps.visuals ?? null;
    let visuals: KitVisuals | null = null;
    if (v) {
      const root = new Group();
      root.name = `quest:${def.id}`;
      v.root.add(root);
      this.root = root;
      visuals = { ...v, root };
    }
    const props = visuals ? new PropBuilder() : null;
    let nextId = V.idBase;
    def.steps.forEach((s, stepIndex) => {
      if (s.kind === 'shoot') {
        s.targets.forEach((t, i) => {
          const view = visuals && props ? new TagView(t.position, t.normal, i, visuals, props) : null;
          const target = new QuestTarget(nextId++, t, stepIndex, view, (q) => this.onTargetHit(q));
          this.targets.push(target);
          this.tagLoops.push(
            new PositionalLoop(
              deps.audio ?? null,
              V.audio.tagHum,
              V.audio.humGain,
              target.aimPoint,
              V.audio.humDistance,
            ),
          );
        });
      } else if (s.kind === 'collect') {
        for (const it of s.items) {
          const position = new Vector3(it.position[0], it.position[1], it.position[2]);
          this.items.push({
            def: it,
            step: stepIndex,
            position,
            loop: new PositionalLoop(
              deps.audio ?? null,
              V.audio.coreHum,
              V.audio.humGain,
              position,
              V.audio.humDistance,
            ),
          });
        }
      } else if (s.kind === 'interact') {
        for (const o of s.objects) {
          const view =
            visuals && props && o.style === 'socket' ? new SocketView(o.position, visuals, props) : null;
          const obj = new QuestObject(o, stepIndex, this.machine!, view, (u) => this.onObjectUsed(u));
          const b = deps.blockers;
          if (b && o.style === 'socket') {
            const S = V.socket;
            const box = {
              center: { x: o.position[0], y: o.position[1] + S.height / 2, z: o.position[2] },
              half: { x: S.radius, y: S.height / 2, z: S.radius },
            };
            this.blockers.push(
              new SolidBlocker(
                b,
                { collider: box, bullets: { box, materialId: S.material }, nav: propNavBox(box) },
                true,
              ),
            );
          }
          this.objects.push(obj);
          deps.interaction.register(obj);
        }
      } else if (s.kind === 'defend' && visuals) {
        this.defends.push({ step: stepIndex, view: new DefendView(s.point, s.radius, visuals), def: s });
      }
    });
    if (visuals && props && this.root) {
      props.meshes((k) => visuals!.materials.get(k), this.root, true);
      props.dispose();
      if (this.items.length > 0) this.core = new CoreView(visuals);
    }
    const ev = deps.events;
    this.unsubscribe.push(
      ev.on('combat:damage', (e) => {
        if (!e.killed || e.source !== 'player' || !this.machine || this.machine.current?.kind !== 'kill')
          return;
        this.machine.onKill({
          x: e.point.x,
          y: e.point.y,
          z: e.point.z,
          zone: this.deps.zoneAt?.(e.point.x, e.point.z) ?? null,
          element: e.element,
          weapon: e.weaponId,
          enemy: this.deps.enemyType?.(e.targetId) ?? null,
        });
      }),
      ev.on('trap:state', (e) => {
        if (e.state === 'active') this.machine?.onTrapActivated(e.trapId);
      }),
    );
    this.syncStep();
    log.info(`Quest "${def.name}" (${def.id}): ${def.steps.length} steps`);
  }

  get questId(): string | null {
    return this.machine?.def.id ?? null;
  }

  get step(): number {
    return this.machine?.step ?? 0;
  }

  get steps(): number {
    return this.machine?.steps ?? 0;
  }

  get completed(): boolean {
    return this.machine?.completed ?? false;
  }

  get hasVolumetricContent(): boolean {
    return this.root !== null && !this.disposed;
  }

  advance(): boolean {
    return this.machine?.advance() ?? false;
  }

  complete(): void {
    this.machine?.complete();
  }

  fixedUpdate(dt: number): void {
    const m = this.machine;
    if (this.dirty) {
      this.dirty = false;
      this.syncStep();
    }
    if (!m || m.completed || !(dt > 0)) return;
    const player = this.deps.player;
    const s = m.current;
    if (s?.kind === 'collect' && player && player.alive) {
      const C = V.core;
      for (const it of this.items) {
        if (it.step !== m.step) continue;
        const i = s.items.indexOf(it.def);
        if (!m.isOpen(i)) continue;
        const p = player.position;
        const dy = it.position.y - p.y;
        if (
          Math.hypot(it.position.x - p.x, it.position.z - p.z) <= C.pickupRadius &&
          dy >= -0.5 &&
          dy <= C.pickupHeight
        ) {
          m.itemCollected(it.def.id);
          this.deps.audio?.play(V.audio.pickup, { volume: V.audio.stepGain, bus: 'sfx' });
        }
      }
    }
    if (s?.kind === 'defend') m.tick(dt, player && player.alive ? player.position : null);
  }

  update(dt: number, listener: Vec3Like | null = null): void {
    const m = this.machine;
    if (!m || this.disposed) return;
    if (this.dirty) {
      this.dirty = false;
      this.syncStep();
    }
    this.time += dt;
    const reduced = this.deps.visuals?.reduceFlashing ?? false;
    const s = m.current;
    // Tags.
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      t.view?.update(dt, this.time, reduced);
      this.tagLoops[i]!.update(t.alive && t.registered, listener);
    }
    // Core: floating at its item spot during the collect step; in the socket once fed.
    const core = this.core;
    let floatingItem: QuestItem | null = null;
    if (s?.kind === 'collect') {
      for (const it of this.items)
        if (it.step === m.step && m.isOpen(s.items.indexOf(it.def))) floatingItem = it;
    }
    for (const it of this.items) it.loop.update(it === floatingItem, listener);
    if (core) {
      if (floatingItem) {
        core.place(floatingItem.position.x, floatingItem.position.y, floatingItem.position.z);
        core.show(true);
        core.boost = 0;
      } else if (this.fed && (s?.kind === 'defend' || m.completed)) {
        core.place(this.fed.x, this.fed.y, this.fed.z);
        core.show(!m.completed);
        core.boost = s?.kind === 'defend' ? m.progress * 2 : 0;
      } else {
        core.show(false);
      }
      core.update(dt, this.time, floatingItem !== null);
    }
    // Sockets: glow when they want the carried item.
    for (const o of this.objects) {
      if (!o.view) continue;
      const wants = m.step === o.step && m.wantsObject(o.def.id);
      const active = this.fed !== null && s?.kind === 'defend';
      o.view.update(this.time, active ? 'active' : wants ? 'want' : 'idle', reduced);
    }
    // Defend zones.
    const player = this.deps.player?.position ?? null;
    for (const d of this.defends) {
      const on = m.step === d.step;
      d.view.update(on, on ? m.progress : 0, on && m.defending(player));
    }
    this.updateLoops(m, player);
  }

  reset(): void {
    const m = this.machine;
    if (!m) return;
    m.reset();
    this.fed = null;
    for (const t of this.targets) t.alive = true;
    this.stopLoop('carry');
    this.stopLoop('defend');
    for (const l of this.tagLoops) l.stop(0);
    for (const it of this.items) it.loop.stop(0);
    this.syncStep();
  }

  setReducedFlashing(reduced: boolean): void {
    if (this.deps.visuals) this.deps.visuals.reduceFlashing = reduced;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    for (const t of this.targets) {
      if (t.registered) this.deps.combat.unregister(t);
      t.view?.dispose();
    }
    for (const o of this.objects) {
      this.deps.interaction.unregister(o);
      o.view?.dispose();
    }
    for (const d of this.defends) d.view.dispose();
    for (const b of this.blockers) b.dispose();
    this.core?.dispose();
    for (const l of this.tagLoops) l.stop(0);
    for (const it of this.items) it.loop.stop(0);
    this.stopLoop('carry');
    this.stopLoop('defend');
    this.root?.removeFromParent();
  }

  // -------------------------------------------------------------------------

  private onTargetHit(t: QuestTarget): void {
    const m = this.machine;
    if (!m || m.step !== t.step || !t.alive) return;
    if (!m.targetHit(t.def.id)) return;
    t.alive = false;
    t.view?.burnOut();
    // Unregistered on the next tick / frame: we are inside CombatWorld.dealDamage (its loops).
    this.dirty = true;
    this.deps.vfx?.spawn(V.tag.hitEffect, t.aimPoint, anchorNormal(t.def.normal, new Vector3()), 0.8);
    this.deps.audio?.play(V.audio.tagHit, { position: t.aimPoint, volume: V.audio.hitGain });
  }

  private onObjectUsed(o: QuestObject): void {
    if (o.view) this.fed = o.view.cradle.clone();
    this.deps.audio?.play(V.audio.socket, { position: o.position, volume: V.audio.stepGain });
  }

  private onStep(index: number, s: QuestStepDef): void {
    this.syncStep();
    this.deps.audio?.play(V.audio.step, { volume: V.audio.stepGain, bus: 'sfx' });
    this.deps.pulse?.(1);
    if (s.kind === 'collect' && this.core) {
      const it = this.items.find((x) => x.step === index);
      if (it) this.deps.vfx?.spawn(V.core.appearEffect, it.position, UP, V.core.appearScale);
    }
    const p = this.stepPayload;
    p.stepId = s.id;
    p.step = index;
    this.deps.events.emit('quest:step', p);
  }

  private onComplete(): void {
    const m = this.machine!;
    const def = m.def;
    this.syncStep();
    const at = this.fed ?? this.deps.player?.position ?? null;
    if (at) {
      this.deps.vfx?.spawn(V.completeEffect, at, UP, V.completeScale);
      this.deps.shockwave?.(at, V.completeShockwaveRadius, V.completeShockwave);
    }
    this.deps.events.emit('camera:shake', { trauma: V.completeShake });
    this.deps.audio?.play(V.audio.complete, { volume: V.audio.completeGain, bus: 'sfx' });
    for (const r of def.rewards) {
      if (r.kind === 'weapon') this.deps.weapons?.give(r.weapon);
      else if (r.kind === 'points') this.deps.economy?.earn(r.amount, 'wave');
      else if (r.kind === 'perk') {
        const perks = this.deps.perks;
        const id = r.perk ?? PERK_IDS.find((p) => !perks?.has(p));
        if (perks && id) perks.grant(id);
      }
    }
    this.deps.banner?.(V.banner.kicker, def.name, def.rewardText, V.banner.color, V.banner.seconds);
    this.completePayload.questId = def.id;
    this.deps.events.emit('quest:completed', this.completePayload);
    log.info(`Quest "${def.name}" completed`);
  }

  /** Register exactly the targets of the running step with CombatWorld; show their tags. */
  private syncStep(): void {
    const m = this.machine;
    if (!m) return;
    for (const t of this.targets) {
      const want = t.alive && m.step === t.step && !m.completed;
      if (want && !t.registered) {
        this.deps.combat.register(t);
        t.registered = true;
      } else if (!want && t.registered) {
        this.deps.combat.unregister(t);
        t.registered = false;
      }
      // A burning tag finishes its flash on its own.
      if (want) t.view?.show(true);
      else if (t.alive || m.step !== t.step) t.view?.show(false);
    }
  }

  private updateLoops(m: QuestMachine, player: Vec3Like | null): void {
    const audio = this.deps.audio;
    if (!audio) return;
    // Carrying: a quiet heartbeat hum (2D).
    if (m.carrying !== null && this.carryLoop === 0) {
      this.carryLoop = audio.startLoop(V.audio.coreHum, {
        volume: V.audio.humGain * V.audio.carryGain,
        bus: 'sfx',
        pitch: V.audio.carryPitch,
      });
    } else if (m.carrying === null) {
      this.stopLoop('carry');
    }
    const s = m.current;
    if (s?.kind === 'defend') {
      if (this.defendLoop === 0)
        this.defendLoop = audio.startLoop(V.audio.defend, { volume: V.audio.defendGain, bus: 'sfx' });
      const [p0, p1] = V.defend.pitch;
      const inside = m.defending(player);
      audio.updateLoop?.(this.defendLoop, {
        pitch: p0 + (p1 - p0) * m.progress,
        volume: V.audio.defendGain * (inside ? 1 : 0.5),
      });
    } else {
      this.stopLoop('defend');
    }
  }

  private stopLoop(which: 'carry' | 'defend'): void {
    const audio = this.deps.audio;
    if (which === 'carry' && this.carryLoop > 0) {
      audio?.stopLoop(this.carryLoop);
      this.carryLoop = 0;
    }
    if (which === 'defend' && this.defendLoop > 0) {
      audio?.stopLoop(this.defendLoop);
      this.defendLoop = 0;
    }
  }
}
