/**
 * One rift seal: `segments` energy bars in front of a spawn point (logic state: how many are up)
 * plus their animation state for the view (per bar: grow 0..1 while re-forming, shatter 0..1 while
 * breaking, hit flash), and the Interactable the player repairs it through (hold 'interact': one
 * bar per hold; the prompt is empty – not focusable – while the seal is intact).
 *
 * Bars break from the top and are restored from the bottom: bars [0, up) stand.
 */
import { Vector3 } from 'three';
import type { Interactable, SpawnPointDef } from '../core/contracts';
import { SEALS } from '../defs/seals';
import type { SealFrame } from './sealGeometry';

/** What a seal asks its system (repairs pay points and emit events there). */
export interface SealHost {
  repairFromPlayer(seal: Seal): void;
  /** Prompt text while the seal is damaged (points cap hint). */
  promptFor(seal: Seal): string;
}

export class Seal implements Interactable {
  readonly id: string;
  readonly spawnPointId: string;
  readonly kind: SpawnPointDef['kind'];
  readonly zone: string;
  readonly frame: SealFrame;
  /** Prompt anchor on the plane (Interactable.position). */
  readonly position = new Vector3();
  readonly range: number = SEALS.repair.range;
  readonly segments: number;

  // View state (advanced by updateVisual).
  readonly grow: Float32Array;
  readonly shatter: Float32Array;
  readonly flash: Float32Array;
  /** Hold progress of a repair in progress (ghost of the next bar), 0..1. */
  preview = 0;
  /** Ripple of the last swing: position along the plane (0..1) and strength (decays). */
  rippleU = 0.5;
  ripple = 0;

  private _up: number;

  constructor(
    sp: Pick<SpawnPointDef, 'id' | 'kind' | 'zone'>,
    frame: SealFrame,
    segments: number,
    private readonly host: SealHost,
  ) {
    this.id = SEALS.idPrefix + sp.id;
    this.spawnPointId = sp.id;
    this.kind = sp.kind;
    this.zone = sp.zone;
    this.frame = frame;
    this.segments = Math.max(1, Math.floor(segments));
    this._up = this.segments;
    this.grow = new Float32Array(this.segments).fill(1);
    this.shatter = new Float32Array(this.segments);
    this.flash = new Float32Array(this.segments);
    const f = frame;
    const mid = (f.right - f.left) / 2;
    const R = SEALS.repair;
    this.position.set(
      f.cx + f.sx * mid + f.fx * R.anchorFront,
      f.cy + Math.min(R.anchorHeight, f.height),
      f.cz + f.sz * mid + f.fz * R.anchorFront,
    );
  }

  /** Bars standing. */
  get up(): number {
    return this._up;
  }

  get broken(): number {
    return this.segments - this._up;
  }

  get intact(): boolean {
    return this._up >= this.segments;
  }

  // --- Interactable ---

  prompt(): string {
    return this._up < this.segments ? this.host.promptFor(this) : '';
  }

  cost(): number | null {
    return null;
  }

  canInteract(): boolean {
    return this._up < this.segments;
  }

  holdTime(): number {
    return SEALS.repair.holdTime;
  }

  /** Keep repairing while the button stays held (an InteractionSystem may honour it). */
  repeatHold(): boolean {
    return true;
  }

  interact(): void {
    if (this.canInteract()) this.host.repairFromPlayer(this);
  }

  // --- state (the system emits the events) ---

  /** Break up to `n` bars from the top; returns how many fell. */
  take(n: number): number {
    const k = Math.max(0, Math.min(Math.floor(n), this._up));
    this._up -= k;
    return k;
  }

  /** Restore up to `n` bars from the bottom (they re-form); returns how many. */
  restore(n: number): number {
    const k = Math.max(0, Math.min(Math.floor(n), this.segments - this._up));
    for (let i = this._up; i < this._up + k; i++) {
      // A bar still shattering starts over from the pylons.
      this.grow[i] = 0;
      this.shatter[i] = 0;
    }
    this._up += k;
    if (k > 0) this.preview = 0;
    return k;
  }

  /** New run: every bar up at once, no animation. */
  resetFull(): void {
    this._up = this.segments;
    this.grow.fill(1);
    this.shatter.fill(0);
    this.flash.fill(0);
    this.preview = 0;
    this.ripple = 0;
  }

  /** A swing landed at `u` (0..1 along the plane): the top bar flashes, the lattice ripples. */
  hit(u: number, strength = 1): void {
    const top = this._up - 1;
    if (top >= 0) this.flash[top] = Math.min(1, this.flash[top]! + strength);
    this.rippleU = Math.min(1, Math.max(0, u));
    this.ripple = 1;
  }

  /**
   * Anything animating (a bar forming / shattering, a flash, the ripple, the repair ghost)? An idle
   * seal's view state is final: the view skips rewriting it.
   */
  get animating(): boolean {
    if (this.preview > 0 || this.ripple > 0) return true;
    for (let i = 0; i < this.segments; i++) {
      const g = this.grow[i]!;
      if (this.flash[i]! > 0 || this.shatter[i]! > 0 || (g > 0 && g < 1)) return true;
    }
    return false;
  }

  /** Advance the bar animations (frame time). */
  updateVisual(dt: number): void {
    if (!(dt > 0)) return;
    const V = SEALS.visual;
    const form = dt / V.formTime;
    const brk = dt / V.breakTime;
    const decay = Math.exp(-V.flashDecay * dt);
    const settle = V.settle;
    for (let i = 0; i < this.segments; i++) {
      if (i < this._up) {
        if (this.grow[i]! < 1) this.grow[i] = Math.min(1, this.grow[i]! + form);
        this.shatter[i] = 0;
      } else if (this.grow[i]! > 0) {
        const s = this.shatter[i]! + brk;
        if (s >= 1) {
          this.grow[i] = 0;
          this.shatter[i] = 0;
        } else this.shatter[i] = s;
      }
      const f = this.flash[i]! * decay;
      this.flash[i] = f < settle ? 0 : f;
    }
    const r = this.ripple * Math.exp(-V.rippleDecay * dt);
    this.ripple = r < settle ? 0 : r;
  }
}
