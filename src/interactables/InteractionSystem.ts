/**
 * InteractionApi: which interactable the player may use right now, and the 'interact' action.
 *
 * Every fixed tick (after the player moved – see integration notes in placeInteractables.ts):
 * 1. sample input: `interact` held + its pressed() edge, latched once per frame (update() latches
 *    edges of frames without a tick – CLAUDE.md input rule),
 * 2. focus: the best registered interactable in range, inside the view cone and in line of sight
 *    (selection.ts); interactables with an empty prompt (a door that is opening, a rolling box) are
 *    not focusable,
 * 3. use: press interactables (holdTime 0) fire on the press edge, hold interactables after the
 *    button was held for holdTime on the same focus (then the button must be released),
 * 4. interact:focus is emitted when the focus, its prompt, its cost or its affordability changed.
 *
 * Disabled (dead / dying player, no run): no focus, no use. Paused: no ticks at all.
 * Allocation-free per tick (scratch arrays grow on register only; prompts are cached strings).
 */
import type { EconomyApi, InputApi, Interactable, InteractionApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createSelectionConfig, pickBest, scoreAnchor, viewForward, type SelectionConfig } from './selection';

export interface InteractionViewer {
  /** Eye position (interpolated eye of the player). */
  readonly eyePosition: Vec3Like;
  /** PlayerApi convention: yaw 0 looks down −Z, positive turns left; pitch positive looks up. */
  readonly yaw: number;
  readonly pitch: number;
}

export interface InteractionDeps {
  events: EventBus<GameEvents>;
  input: Pick<InputApi, 'isDown' | 'pressed'>;
  viewer: InteractionViewer;
  economy: Pick<EconomyApi, 'canAfford'>;
  /** Static-world line of sight (CombatWorld.lineOfSight). */
  lineOfSight(from: Vec3Like, to: Vec3Like): boolean;
  /** False while the player cannot interact (dead, death sequence, no run). Default: always. */
  enabled?: () => boolean;
  config?: SelectionConfig;
}

const INITIAL_CAPACITY = 64;

export class InteractionSystem implements InteractionApi {
  private readonly items: Interactable[] = [];
  private scores = new Float64Array(INITIAL_CAPACITY);
  private order = new Int32Array(INITIAL_CAPACITY);
  private readonly cfg: SelectionConfig;
  private readonly forward = { x: 0, y: 0, z: -1 };
  private readonly eye = { x: 0, y: 0, z: 0 };
  private readonly losTest = (i: number): boolean => this.deps.lineOfSight(this.eye, this.items[i]!.position);

  private _focused: Interactable | null = null;
  private holdTimer = 0;
  private holdArmed = true;
  private held = false;
  private pressLatched = false;
  /** Frame counter (advanced by update) so a frame's pressed() edge is latched only once. */
  private inputFrame = 0;
  private edgeFrame = -1;
  private edgeSeen = false;

  // Last emitted focus (interact:focus is only sent on change).
  private readonly payload: GameEvents['interact:focus'] = {
    id: null,
    prompt: null,
    cost: null,
    affordable: true,
  };
  private emittedOnce = false;

  constructor(private readonly deps: InteractionDeps) {
    this.cfg = deps.config ?? createSelectionConfig();
  }

  get focused(): Interactable | null {
    return this._focused;
  }

  get holdProgress(): number {
    const f = this._focused;
    if (!f) return 0;
    const h = f.holdTime();
    return h > 0 ? Math.min(1, this.holdTimer / h) : 0;
  }

  /**
   * An interaction is on offer (focus that can be used now). Pad X is shared by reload and
   * interact (defs/input.ts): the weapon system may skip reload presses while this is true.
   */
  get offering(): boolean {
    const f = this._focused;
    return f !== null && f.canInteract();
  }

  /** Registered interactables (dev console, tests). */
  get all(): readonly Interactable[] {
    return this.items;
  }

  register(i: Interactable): void {
    if (this.items.includes(i)) return;
    this.items.push(i);
    if (this.items.length > this.scores.length) {
      const cap = this.scores.length * 2;
      this.scores = new Float64Array(cap);
      this.order = new Int32Array(cap);
    }
  }

  unregister(i: Interactable): void {
    const idx = this.items.indexOf(i);
    if (idx < 0) return;
    this.items.splice(idx, 1);
    if (this._focused === i) this.setFocus(null);
  }

  /** Per frame (after the ticks): latch the edge of a frame that ran no tick; advance the frame. */
  update(_dt: number): void {
    this.sampleInput();
    this.inputFrame++;
  }

  fixedUpdate(dt: number): void {
    this.sampleInput();
    const press = this.pressLatched;
    this.pressLatched = false;
    if (this.deps.enabled && !this.deps.enabled()) {
      this.setFocus(null);
      this.syncFocusEvent();
      return;
    }
    const focus = this.select();
    this.setFocus(focus);
    if (focus && focus.canInteract()) {
      const hold = focus.holdTime();
      if (hold <= 0) {
        if (press) focus.interact();
      } else if (this.held && this.holdArmed) {
        this.holdTimer += dt;
        if (this.holdTimer >= hold) {
          this.holdTimer = 0;
          // One use per hold (release before the next) unless it repeats while held (seal bars).
          this.holdArmed = focus.repeatHold?.() === true;
          focus.interact();
        }
      } else if (!this.held) {
        this.holdTimer = 0;
        this.holdArmed = true;
      }
    } else {
      this.holdTimer = 0;
      if (!this.held) this.holdArmed = true;
    }
    this.syncFocusEvent();
  }

  /** New run: drop the focus and any hold (emits a cleared focus). */
  reset(): void {
    this.setFocus(null);
    this.holdArmed = true;
    this.pressLatched = false;
    this.syncFocusEvent();
  }

  // -------------------------------------------------------------------------

  private sampleInput(): void {
    const input = this.deps.input;
    this.held = input.isDown('interact');
    if (this.edgeFrame !== this.inputFrame) {
      this.edgeFrame = this.inputFrame;
      this.edgeSeen = false;
    }
    if (!this.edgeSeen && input.pressed('interact')) {
      this.edgeSeen = true;
      this.pressLatched = true;
    }
  }

  private select(): Interactable | null {
    const items = this.items;
    const n = items.length;
    if (n === 0) return null;
    const v = this.deps.viewer;
    const e = v.eyePosition;
    this.eye.x = e.x;
    this.eye.y = e.y;
    this.eye.z = e.z;
    const f = this.forward;
    viewForward(v.yaw, v.pitch, f);
    const scores = this.scores;
    let current = -1;
    for (let i = 0; i < n; i++) {
      const it = items[i]!;
      const p = it.position;
      // Empty prompt: nothing to offer right now (opening door, rolling box).
      scores[i] =
        it.prompt() === ''
          ? -1
          : scoreAnchor(p.x - e.x, p.y - e.y, p.z - e.z, it.range, f.x, f.y, f.z, this.cfg);
      if (it === this._focused) current = i;
    }
    const best = pickBest(scores, n, this.order, current, this.cfg, this.losTest);
    return best >= 0 ? items[best]! : null;
  }

  private setFocus(next: Interactable | null): void {
    if (next === this._focused) return;
    this._focused = next;
    this.holdTimer = 0;
    this.holdArmed = true;
  }

  private syncFocusEvent(): void {
    const f = this._focused;
    const p = this.payload;
    const id = f ? f.id : null;
    const prompt = f ? f.prompt() : null;
    const cost = f ? f.cost() : null;
    const affordable = cost === null || this.deps.economy.canAfford(cost);
    if (
      this.emittedOnce &&
      id === p.id &&
      prompt === p.prompt &&
      cost === p.cost &&
      affordable === p.affordable
    ) {
      return;
    }
    this.emittedOnce = true;
    p.id = id;
    p.prompt = prompt;
    p.cost = cost;
    p.affordable = affordable;
    this.deps.events.emit('interact:focus', p);
  }
}
