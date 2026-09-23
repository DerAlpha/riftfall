/**
 * Pause state machine of the composition root: menu, pointer lock, tab visibility, dev console.
 *
 * - The game runs only while no PauseReason is held; pausing freezes the loop (render continues
 *   behind the menus), disables gameplay input and pauses audio.
 * - Keyboard/mouse play needs pointer lock. Losing it (Esc, alt-tab) opens the pause menu, and
 *   resuming requests it again – from a click or a key other than Escape, because only those
 *   grant the user activation the browser demands.
 * - Gamepad presses grant no user activation, so a gamepad starts/resumes WITHOUT pointer lock
 *   ("lock-less"; the right stick looks). The next mouse press on the canvas takes the lock.
 * - The `pause` binding toggles: it opens the menu during play and closes it again (START on a
 *   pad, P on the keyboard) – except Escape, which is the menus' "back" key.
 */
import type { EventBus } from '../core/EventBus';
import type { GameEvents, PauseReason } from '../core/events';
import type { Action } from '../defs/input';

export interface PauseInput {
  enabled: boolean;
  readonly pointerLocked: boolean;
  readonly device: 'kbm' | 'gamepad';
  /** A rebinding capture is waiting for input. */
  readonly capturing: boolean;
  pressed(action: Action): boolean;
  /** `pressed` regardless of `enabled` (the menu reacts to the binding that paused the game). */
  pressedIgnoringEnabled(action: Action): boolean;
  requestPointerLock(): void;
  exitPointerLock(): void;
}

export interface PauseMenus {
  showPause(): void;
  hide(): void;
  readonly current: 'start' | 'pause' | null;
}

export interface PauseDeps {
  input: PauseInput;
  menus: PauseMenus;
  loop: { paused: boolean; resetAccumulator(): void };
  audio: { setPaused(paused: boolean): void; unlock(): Promise<void> };
  events: EventBus<GameEvents>;
  /** The dev console owns the keyboard while open. */
  consoleOpen(): boolean;
  /** Play without pointer lock at all (automated tests, `?nolock`). */
  noPointerLock: boolean;
}

export class PauseController {
  private readonly reasons = new Set<PauseReason>();
  private _started = false;
  private _lockless = false;
  /** A real Escape keydown arrived since the last frame. */
  private escapeSeen = false;

  constructor(private readonly deps: PauseDeps) {}

  /** The player left the start screen. */
  get started(): boolean {
    return this._started;
  }
  get paused(): boolean {
    return this.reasons.size > 0;
  }
  /** Playing without pointer lock because a gamepad started/resumed. */
  get lockless(): boolean {
    return this._lockless;
  }
  has(reason: PauseReason): boolean {
    return this.reasons.has(reason);
  }

  /** Start screen → gameplay. `viaGamepad`: activated by a pad (no pointer lock possible). */
  start(viaGamepad: boolean): void {
    this._started = true;
    this.enterGameplay(viaGamepad);
  }

  /** Pause menu → gameplay. */
  resume(viaGamepad: boolean): void {
    this.enterGameplay(viaGamepad);
  }

  /** Pause and show the pause menu (also records `reason`, e.g. pointerlock / visibility). */
  openMenu(reason: PauseReason = 'menu'): void {
    this.reasons.add(reason);
    this.reasons.add('menu');
    this.apply();
    if (!this.deps.noPointerLock) this.deps.input.exitPointerLock();
    this.deps.menus.showPause();
  }

  pause(reason: PauseReason): void {
    this.reasons.add(reason);
    this.apply();
  }

  unpause(reason: PauseReason): void {
    this.reasons.delete(reason);
    this.apply();
  }

  /**
   * Once per frame right after input.beginFrame. `wasCapturing`: a rebinding capture was running
   * before this frame's input poll (the press that ends a capture must not also resume).
   */
  onFrame(wasCapturing: boolean): void {
    const escape = this.escapeSeen;
    this.escapeSeen = false;
    if (!this._started || this.deps.consoleOpen()) return;
    const input = this.deps.input;
    if (!this.paused) {
      if (input.pressed('pause')) this.openMenu();
      return;
    }
    // The press that opened the menu is still held next frame (no new edge), so it cannot resume.
    if (
      this.deps.menus.current === 'pause' &&
      !this.reasons.has('visibility') &&
      !escape &&
      !wasCapturing &&
      !input.capturing &&
      input.pressedIgnoringEnabled('pause')
    ) {
      this.resume(input.device === 'gamepad');
    }
  }

  onPointerLock(locked: boolean): void {
    if (locked) {
      this._lockless = false;
      if (this.reasons.has('pointerlock') || this.reasons.has('menu')) {
        this.reasons.delete('pointerlock');
        this.reasons.delete('menu');
        this.apply();
        this.deps.menus.hide();
      }
      return;
    }
    // Lock-less (gamepad) play has no lock to lose; a refused lock request must not pause it.
    if (this._started && !this.deps.noPointerLock && !this._lockless && !this.deps.consoleOpen()) {
      this.openMenu('pointerlock');
    }
  }

  onVisibility(hidden: boolean): void {
    if (hidden) {
      if (this._started) this.openMenu('visibility');
    } else {
      this.unpause('visibility');
    }
  }

  onConsole(open: boolean): void {
    this.deps.input.enabled = !open && !this.paused;
    // A real Esc while the console was open releases pointer lock without opening the menu;
    // closing the console must then fall back to the pause menu instead of lock-less gameplay.
    if (
      !open &&
      this._started &&
      !this.paused &&
      !this.deps.noPointerLock &&
      !this._lockless &&
      !this.deps.input.pointerLocked
    ) {
      this.openMenu('pointerlock');
    }
  }

  /** Mouse press on the game canvas (a user gesture): lock-less play takes the pointer lock now. */
  onCanvasPointerDown(): void {
    if (!this._started || !this._lockless || this.paused || this.deps.consoleOpen()) return;
    void this.deps.audio.unlock();
    this.deps.input.requestPointerLock();
  }

  /**
   * A real Escape keydown. Escape never closes the pause menu: it is the menus' "back" key and
   * grants no user activation (the lock request would fail – or, within a few seconds of a
   * click, resume the game while the player only wanted to leave a settings page).
   */
  noteEscape(): void {
    this.escapeSeen = true;
  }

  // ---------------------------------------------------------------------------

  private enterGameplay(viaGamepad: boolean): void {
    void this.deps.audio.unlock();
    if (this.deps.noPointerLock || viaGamepad) {
      this._lockless = !this.deps.noPointerLock;
      this.reasons.clear();
      this.apply();
      this.deps.menus.hide();
    } else {
      // The pointerlockchange handler (onPointerLock) unpauses once the lock is granted.
      this.deps.input.requestPointerLock();
    }
  }

  private apply(): void {
    const paused = this.reasons.size > 0;
    const loop = this.deps.loop;
    if (paused === loop.paused) return;
    loop.paused = paused;
    this.deps.input.enabled = !paused && !this.deps.consoleOpen();
    this.deps.audio.setPaused(paused);
    if (paused) {
      const first = this.reasons.values().next();
      this.deps.events.emit('game:paused', { reason: first.done ? 'menu' : first.value });
    } else {
      loop.resetAccumulator();
      this.deps.events.emit('game:resumed', {});
    }
  }
}
