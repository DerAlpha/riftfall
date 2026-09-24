/**
 * Keyboard / mouse / gamepad → Actions.
 *
 * DOM events only record raw state (held keys, press events, mouse delta, wheel steps). Once per
 * frame `beginFrame` polls gamepads and evaluates every action from its bindings, producing
 * per-frame edges. A press and release inside one frame still yields `pressed` (taps are never
 * lost). `endFrame` clears the per-frame state.
 *
 * Browser limits (documented, not fixable from JS): reserved shortcuts such as Ctrl+W / Ctrl+T /
 * Ctrl+N / Ctrl+Tab / Cmd+Q cannot be prevented outside fullscreen + Keyboard Lock. As a mitigation,
 * crouch is not on Ctrl by default and closing the tab while Ctrl/Meta is held during gameplay asks
 * for confirmation (beforeunload); Ctrl+Tab switches the tab and the game pauses on visibility.
 * Escape always leaves pointer lock and the browser refuses to re-lock for ~1 s afterwards.
 *
 * Without pointer lock (API missing, or the request is refused – e.g. an iframe without
 * `allow-pointer-lock`) `pointerLockProblem` says why; gameplay then reads plain (unlocked) mouse
 * movement so lock-less play keeps mouse look.
 */
import type { InputApi, LookOut, SettingsStore, Vec2Out } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD, clamp01 } from '../core/math';
import { CAMERA } from '../defs/camera';
import { ACTIONS, GAMEPAD, INPUT, POINTER, type Action, type Binding, type BindingMap } from '../defs/input';
import { isFixedKeyCode, isReservedKey, learnPrintedKey, sanitizeBindings } from './bindings';
import { axisDeflection, clampLength1, shapeStick } from './gamepadMath';
import { MouseSpikeFilter } from './MouseSpikeFilter';

const log = createLogger('Input');

const ACTION_COUNT = ACTIONS.length;
const ACTION_INDEX: ReadonlyMap<Action, number> = new Map(ACTIONS.map((a, i) => [a, i] as const));
const IDX_FORWARD = ACTION_INDEX.get('moveForward')!;
const IDX_BACK = ACTION_INDEX.get('moveBack')!;
const IDX_LEFT = ACTION_INDEX.get('moveLeft')!;
const IDX_RIGHT = ACTION_INDEX.get('moveRight')!;

// Compiled binding kinds (plain numbers: no const enums under isolatedModules).
const K_KEY = 0;
const K_MOUSE = 1;
const K_WHEEL = 2;
const K_PAD = 3;
const K_AXIS = 4;

interface CompiledBinding {
  kind: number;
  code: string;
  index: number;
  /** Wheel: 1 = up, -1 = down. Axis: +1 / -1. */
  dir: number;
}

interface CaptureState {
  resolve: (b: Binding | null) => void;
  armed: boolean;
  timer: number;
  padBaseline: Uint8Array;
  axisBaseline: Uint8Array;
}

const PREVENT_CODES: ReadonlySet<string> = new Set(INPUT.preventDefaultCodes);
const NAVIGATION_BUTTONS: ReadonlySet<number> = new Set(INPUT.navigationMouseButtons);
/** Keys that stay held while Cmd is released on macOS (everything else lost its keyup). */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);
const WHEEL_CAPTURE_OPTS: AddEventListenerOptions = { capture: true, passive: false };
const TRIGGER_BUTTONS: ReadonlySet<number> = new Set(GAMEPAD.triggerButtons);

type Listener = [EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined];

/** Why pointer lock is not available: the API is missing, or the browser refused the request. */
export type PointerLockProblem = 'unsupported' | 'denied';

function isTextEntry(t: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return !(
      type === 'range' ||
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'button' ||
      type === 'color'
    );
  }
  return false;
}

/** Elements whose own keyboard behaviour (Space/Enter/arrows/Tab) must keep working. */
function isInteractive(t: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  if (isTextEntry(t)) return true;
  return (
    t instanceof HTMLButtonElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLInputElement ||
    t instanceof HTMLAnchorElement ||
    t.getAttribute('role') !== null
  );
}

function hasGamepadApi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export class InputSystem implements InputApi {
  private _device: 'kbm' | 'gamepad' = 'kbm';
  private _enabled = true;
  private lockedState = false;

  // --- raw state (written by DOM events) ---
  private readonly keysDown = new Set<string>();
  private readonly keysPressed = new Set<string>();
  private readonly mouseDown = new Uint8Array(INPUT.maxMouseButtons);
  private readonly mousePressed = new Uint8Array(INPUT.maxMouseButtons);
  private mouseAccX = 0;
  private mouseAccY = 0;
  private wheelAccUp = 0;
  private wheelAccDown = 0;
  private wheelPixelAcc = 0;

  // --- per-frame snapshot ---
  private frameDt = 0;
  private mouseFrameX = 0;
  private mouseFrameY = 0;
  private wheelUp = 0;
  private wheelDown = 0;

  // --- gamepad ---
  private padsConnected = 0;
  private padIndex = -1;
  private padPresent = false;
  private readonly padValues = new Float32Array(GAMEPAD.maxButtons);
  private padDownNow = new Uint8Array(GAMEPAD.maxButtons);
  private padDownPrev = new Uint8Array(GAMEPAD.maxButtons);
  private readonly padAxes = new Float32Array(GAMEPAD.maxAxes);
  private readonly moveStick: Vec2Out = { x: 0, y: 0 };
  private readonly lookStick: Vec2Out = { x: 0, y: 0 };
  private readonly warnedPadIds = new Set<string>();
  /** Pressed-button bitmask of every connected pad (by index) in the previous poll. */
  private readonly padMasks = new Map<number, number>();
  /** Per pad index: bitmask of axes never read as stick axes (see nonStickAxes), fixed at first sight. */
  private readonly padNonStickAxes = new Map<number, number>();
  /** padNonStickAxes of the active pad. */
  private padIgnoredAxes = 0;

  // --- actions ---
  private activeMap: BindingMap = sanitizeBindings(undefined);
  private compiled: CompiledBinding[][] = [];
  private boundCodes = new Set<string>();
  private readonly down = new Uint8Array(ACTION_COUNT);
  private readonly pressedEdge = new Uint8Array(ACTION_COUNT);
  private readonly releasedEdge = new Uint8Array(ACTION_COUNT);
  private readonly values = new Float32Array(ACTION_COUNT);

  // --- pointer lock ---
  private readonly spikeFilter = new MouseSpikeFilter(POINTER);
  private lastUnlockAt = Number.NEGATIVE_INFINITY;
  private unadjustedSupported: boolean = POINTER.unadjustedMovement;
  private lockPromiseFlow = false;
  /** A promise-based lock request is in flight (double clicks must not stack requests). */
  private lockPending = false;
  private lockRetryTimer = 0;
  private lockRetried = false;
  private _lockProblem: PointerLockProblem | null = null;

  // --- keyboard ---
  /** timeStamp of the last ControlLeft keydown (AltGr on Windows is ControlLeft + AltRight). */
  private lastCtrlLeftDownAt = Number.NEGATIVE_INFINITY;

  // --- rebinding ---
  private capture: CaptureState | null = null;
  /** A captured ControlLeft waits INPUT.altGrPairMs for an AltRight that would make it AltGr. */
  private pendingCtrlTimer = 0;
  private suppressClickUntil = 0;
  /** The non-passive window wheel listener only exists while a capture is running (keeps menu scrolling fast). */
  private wheelCaptureActive = false;

  private readonly listeners: Listener[] = [];
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly events: EventBus<GameEvents>,
    private readonly settings: SettingsStore,
  ) {
    this.rebuildBindings();
    this.unsubs.push(
      events.on('settings:changed', ({ sections }) => {
        if (sections.includes('controls')) this.rebuildBindings();
      }),
    );

    const win = window;
    const doc = document;
    // Capture-phase listeners for rebinding run before anything else (menus, console).
    this.listen(win, 'keydown', this.onCaptureKey as EventListener, true);
    this.listen(win, 'mousedown', this.onCaptureMouse as EventListener, true);
    this.listen(win, 'click', this.onSuppressClick as EventListener, true);
    this.listen(win, 'auxclick', this.onSuppressClick as EventListener, true);
    this.listen(win, 'contextmenu', this.onSuppressClick as EventListener, true);
    // Back/forward mouse buttons must never navigate away – in gameplay, menus or a capture.
    this.listen(win, 'mousedown', this.onNavigationButton as EventListener, true);
    this.listen(win, 'mouseup', this.onNavigationButton as EventListener, true);
    this.listen(win, 'auxclick', this.onNavigationButton as EventListener, true);

    this.listen(win, 'keydown', this.onKeyDown as EventListener);
    this.listen(win, 'keyup', this.onKeyUp as EventListener);
    this.listen(target, 'mousedown', this.onMouseDown as EventListener);
    this.listen(win, 'mouseup', this.onMouseUp as EventListener);
    this.listen(target, 'contextmenu', this.onContextMenu as EventListener);
    this.listen(target, 'auxclick', this.onAuxClick as EventListener);
    this.listen(target, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(doc, 'mousemove', this.onMouseMove as EventListener);
    this.listen(doc, 'pointerlockchange', this.onLockChange);
    this.listen(doc, 'pointerlockerror', this.onLockError);
    this.listen(win, 'blur', this.onBlur);
    this.listen(doc, 'visibilitychange', this.onVisibility);
    this.listen(win, 'beforeunload', this.onBeforeUnload as EventListener);
    this.listen(win, 'gamepadconnected', this.onPadConnected as EventListener);
    this.listen(win, 'gamepaddisconnected', this.onPadDisconnected as EventListener);

    this.lockedState = doc.pointerLockElement === target;
    this.scanExistingPads();
  }

  // -------------------------------------------------------------------------
  // InputApi
  // -------------------------------------------------------------------------

  get device(): 'kbm' | 'gamepad' {
    return this._device;
  }

  get pointerLocked(): boolean {
    return this.lockedState;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (v) {
      // Everything pressed while disabled (e.g. Space activating "Fortsetzen") becomes the held
      // baseline: it must not fire `pressed` now, but a genuine press after this point does.
      this.keysPressed.clear();
      this.mousePressed.fill(0);
      this.evaluateActions(true);
      // Gameplay resumed (menu closed): a rebinding capture left running would swallow game input.
      this.cancelCapture();
    }
  }

  beginFrame(dt: number): void {
    this.frameDt = dt > 0 && Number.isFinite(dt) ? dt : 0;
    this.mouseFrameX = this.mouseAccX;
    this.mouseFrameY = this.mouseAccY;
    this.mouseAccX = 0;
    this.mouseAccY = 0;
    this.wheelUp = this.wheelAccUp;
    this.wheelDown = this.wheelAccDown;
    this.wheelAccUp = 0;
    this.wheelAccDown = 0;

    this.pollGamepads();
    if (this.capture?.armed) this.capturePad(this.capture);
    this.evaluateActions();

    this.keysPressed.clear();
    this.mousePressed.fill(0);
  }

  endFrame(): void {
    this.mouseFrameX = 0;
    this.mouseFrameY = 0;
    this.wheelUp = 0;
    this.wheelDown = 0;
    this.pressedEdge.fill(0);
    this.releasedEdge.fill(0);
  }

  isDown(action: Action): boolean {
    const i = ACTION_INDEX.get(action);
    return this._enabled && i !== undefined && this.down[i] === 1;
  }

  pressed(action: Action): boolean {
    const i = ACTION_INDEX.get(action);
    return this._enabled && i !== undefined && this.pressedEdge[i] === 1;
  }

  /**
   * Swallow this frame's press of `action` (M5: the Werkbank menu took the wheel / D-pad step):
   * pressed() reads false for the rest of the frame, held state is untouched. Call it before the
   * ticks (beginFrame) so no system saw the edge yet.
   */
  consume(action: Action): void {
    const i = ACTION_INDEX.get(action);
    if (i !== undefined) this.pressedEdge[i] = 0;
  }

  released(action: Action): boolean {
    const i = ACTION_INDEX.get(action);
    return this._enabled && i !== undefined && this.releasedEdge[i] === 1;
  }

  value(action: Action): number {
    const i = ACTION_INDEX.get(action);
    return this._enabled && i !== undefined ? this.values[i]! : 0;
  }

  getMove(out: Vec2Out): Vec2Out {
    if (!this._enabled) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    const v = this.values;
    out.x = v[IDX_RIGHT]! - v[IDX_LEFT]! + this.moveStick.x;
    out.y = v[IDX_FORWARD]! - v[IDX_BACK]! + this.moveStick.y;
    return clampLength1(out);
  }

  getLook(out: LookOut): LookOut {
    if (!this._enabled) {
      out.yaw = 0;
      out.pitch = 0;
      return out;
    }
    const c = this.settings.current.controls;
    const k = CAMERA.mouseRadiansPerCount * finiteOr(c.mouseSensitivity, 1);
    out.yaw = this.mouseFrameX * k;
    // Mouse up = negative movementY = look up (positive pitch).
    out.pitch = -this.mouseFrameY * k * (c.invertY ? -1 : 1);
    if (this.lookStick.x !== 0 || this.lookStick.y !== 0) {
      const rate = CAMERA.gamepadLookSpeedDeg * DEG2RAD * this.frameDt;
      out.yaw += this.lookStick.x * rate * finiteOr(c.gamepadSensitivityX, 1);
      out.pitch += this.lookStick.y * rate * finiteOr(c.gamepadSensitivityY, 1) * (c.gamepadInvertY ? -1 : 1);
    }
    return out;
  }

  requestPointerLock(): void {
    if (this.disposed || this.lockedState || this.lockPending) return;
    if (!this.pointerLockSupported) {
      if (this._lockProblem !== 'unsupported') log.warn('Pointer Lock API nicht verfügbar');
      this._lockProblem = 'unsupported';
      this.events.emit('input:pointerLock', { locked: false });
      return;
    }
    this.lockRetried = false;
    this.attemptLock(this.unadjustedSupported);
  }

  exitPointerLock(): void {
    this.cancelLockRetry();
    if (this.lockedState && typeof document.exitPointerLock === 'function') document.exitPointerLock();
  }

  captureBinding(timeoutMs: number = INPUT.captureTimeoutMs): Promise<Binding | null> {
    this.finishCapture(null);
    return new Promise<Binding | null>((resolve) => {
      const cap: CaptureState = {
        resolve,
        armed: false,
        timer: 0,
        padBaseline: Uint8Array.from(this.padDownNow),
        axisBaseline: new Uint8Array(GAMEPAD.maxAxes),
      };
      for (let a = 0; a < GAMEPAD.maxAxes; a++) {
        cap.axisBaseline[a] = Math.abs(this.padAxes[a]!) >= GAMEPAD.captureAxisThreshold ? 1 : 0;
      }
      this.capture = cap;
      this.setWheelCapture(true);
      const ms = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : INPUT.captureTimeoutMs;
      cap.timer = window.setTimeout(() => this.finishCapture(null, cap), ms);
      // Arm on the next task: the click/keypress that started the capture must not be captured itself.
      window.setTimeout(() => {
        if (this.capture === cap) cap.armed = true;
      }, 0);
    });
  }

  rumble(strong: number, weak: number, durationMs: number): void {
    if (!this.settings.current.controls.vibration || !hasGamepadApi() || this.padIndex < 0) return;
    let pad: Gamepad | null;
    try {
      pad = navigator.getGamepads()[this.padIndex] ?? null;
    } catch {
      return;
    }
    // Typed non-null in lib.dom but missing in Firefox/Safari for many pads.
    const act = pad?.vibrationActuator as GamepadHapticActuator | null | undefined;
    if (!act || typeof act.playEffect !== 'function') return;
    try {
      act
        .playEffect('dual-rumble', {
          startDelay: 0,
          duration: Math.min(GAMEPAD.maxRumbleMs, Math.max(0, finiteOr(durationMs, 0))),
          strongMagnitude: clamp01(finiteOr(strong, 0)),
          weakMagnitude: clamp01(finiteOr(weak, 0)),
        })
        .catch(() => {
          /* unsupported effect: ignore */
        });
    } catch {
      /* some implementations throw synchronously for unsupported effects */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishCapture(null);
    this.setWheelCapture(false);
    this.cancelLockRetry();
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.clearHeld();
  }

  // -------------------------------------------------------------------------
  // Extras (not part of InputApi)
  // -------------------------------------------------------------------------

  /** Abort a running captureBinding() (resolves it with null). Menus call this when they unmount. */
  cancelCapture(): void {
    this.finishCapture(null);
  }

  /** True while captureBinding() waits for input. */
  get capturing(): boolean {
    return this.capture !== null;
  }

  /** The Pointer Lock API exists on the target (it can still be refused, see pointerLockProblem). */
  get pointerLockSupported(): boolean {
    return typeof this.target.requestPointerLock === 'function';
  }

  /** Why the last lock request failed (null once a lock was granted, or before any request). */
  get pointerLockProblem(): PointerLockProblem | null {
    return this._lockProblem;
  }

  /**
   * `pressed` that also reports while disabled, so a paused game (menus) can react to the binding
   * that paused it. Edges are evaluated every frame regardless of `enabled`.
   */
  pressedIgnoringEnabled(action: Action): boolean {
    const i = ACTION_INDEX.get(action);
    return i !== undefined && this.pressedEdge[i] === 1;
  }

  /** Raw gamepad button (W3C standard index) held this frame, independent of bindings and `enabled` (menus). */
  padButtonDown(button: number): boolean {
    return this.padPresent && this.padDownNow[button] === 1;
  }

  /** Raw gamepad button went down this frame, independent of bindings and `enabled` (menus). */
  padButtonPressed(button: number): boolean {
    return this.padPresent && this.padDownNow[button] === 1 && this.padDownPrev[button] !== 1;
  }

  /** True while a gamepad is connected and polled. */
  get gamepadConnected(): boolean {
    return this.padPresent;
  }

  /** Number of mouse events rejected by the spike filter (debug overlay / console). */
  get droppedMouseEvents(): number {
    return this.spikeFilter.droppedEvents;
  }

  /** Bindings currently used for evaluation (sanitized copy of the settings map). */
  get activeBindings(): Readonly<BindingMap> {
    return this.activeMap;
  }

  // -------------------------------------------------------------------------
  // Bindings / evaluation
  // -------------------------------------------------------------------------

  private rebuildBindings(): void {
    const map = sanitizeBindings(this.settings.current.controls.bindings);
    this.activeMap = map;
    const compiled: CompiledBinding[][] = [];
    const codes = new Set<string>();
    for (const action of ACTIONS) {
      const list: CompiledBinding[] = [];
      for (const b of map[action]) {
        switch (b.device) {
          case 'key':
            list.push({ kind: K_KEY, code: b.code, index: 0, dir: 0 });
            codes.add(b.code);
            break;
          case 'mouse':
            if (b.button < INPUT.maxMouseButtons)
              list.push({ kind: K_MOUSE, code: '', index: b.button, dir: 0 });
            break;
          case 'wheel':
            list.push({ kind: K_WHEEL, code: '', index: 0, dir: b.direction === 'up' ? 1 : -1 });
            break;
          case 'pad':
            if (b.button < GAMEPAD.maxButtons) list.push({ kind: K_PAD, code: '', index: b.button, dir: 0 });
            break;
          case 'padAxis':
            if (b.axis < GAMEPAD.maxAxes)
              list.push({ kind: K_AXIS, code: '', index: b.axis, dir: b.direction });
            break;
        }
      }
      compiled.push(list);
    }
    this.compiled = compiled;
    this.boundCodes = codes;
  }

  /** `suppressEdges`: only update the held baseline (re-enable), report no edges. */
  private evaluateActions(suppressEdges = false): void {
    const c = this.settings.current.controls;
    const dz = finiteOr(c.gamepadDeadzone, GAMEPAD.stickDeadzone);
    for (let i = 0; i < ACTION_COUNT; i++) {
      const list = this.compiled[i]!;
      let value = 0;
      let isDown = false;
      let tap = false;
      for (let j = 0; j < list.length; j++) {
        const b = list[j]!;
        let v = 0;
        let d = false;
        switch (b.kind) {
          case K_KEY:
            d = this.keysDown.has(b.code);
            v = d ? 1 : 0;
            if (this.keysPressed.has(b.code)) tap = true;
            break;
          case K_MOUSE:
            d = this.mouseDown[b.index] === 1;
            v = d ? 1 : 0;
            if (this.mousePressed[b.index] === 1) tap = true;
            break;
          case K_WHEEL:
            d = (b.dir > 0 ? this.wheelUp : this.wheelDown) > 0;
            v = d ? 1 : 0;
            // Every frame with wheel steps is a fresh press (no held state for a wheel).
            if (d) tap = true;
            break;
          case K_PAD:
            d = this.padDownNow[b.index] === 1;
            v = TRIGGER_BUTTONS.has(b.index) ? this.padValues[b.index]! : d ? 1 : 0;
            if (d && this.padDownPrev[b.index] === 0) tap = true;
            break;
          case K_AXIS:
            v = axisDeflection(this.padAxes[b.index]!, b.dir > 0 ? 1 : -1, dz, GAMEPAD.outerDeadzone);
            d = v >= GAMEPAD.axisPressThreshold;
            break;
        }
        if (v > value) value = v;
        if (d) isDown = true;
      }
      const prev = this.down[i] === 1;
      this.down[i] = isDown ? 1 : 0;
      this.values[i] = value;
      if (suppressEdges) {
        this.pressedEdge[i] = 0;
        this.releasedEdge[i] = 0;
      } else {
        this.pressedEdge[i] = (isDown && !prev) || tap ? 1 : 0;
        this.releasedEdge[i] = (!isDown && prev) || (tap && !isDown) ? 1 : 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------------

  private scanExistingPads(): void {
    if (!hasGamepadApi()) return;
    try {
      const pads = navigator.getGamepads();
      let n = 0;
      for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) n++;
      this.padsConnected = n;
    } catch {
      this.padsConnected = 0;
    }
  }

  private pollGamepads(): void {
    if (this.padsConnected <= 0 || !hasGamepadApi()) {
      if (this.padPresent) this.clearPad();
      return;
    }
    let pads: readonly (Gamepad | null)[];
    try {
      pads = navigator.getGamepads(); // allocates in Chrome; only polled while a pad is connected
    } catch {
      return;
    }
    let pad: Gamepad | null = null;
    const current = this.padIndex >= 0 ? (pads[this.padIndex] ?? null) : null;
    if (current?.connected) pad = current;
    let connected = 0;
    let switched = false;
    let switchedPrevMask = 0;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      connected++;
      const mask = padButtonMask(p);
      const known = this.padMasks.get(i);
      // First sight: what is held now is no press on another pad's behalf; the axes are at rest.
      if (known === undefined) this.padNonStickAxes.set(i, this.nonStickAxes(p));
      const prevMask = known ?? mask;
      this.padMasks.set(i, mask);
      if (p === pad || switched) continue;
      // Another controller takes over on a NEW press – a button that stays held (a stuck or toggle
      // switch, a resting thumb) must not steal the active pad every frame.
      if (!pad || (mask & ~prevMask) !== 0) {
        // A pad taking over from none that was never polled starts from nothing held (its held
        // buttons are presses, as on connect); otherwise from its own previous state.
        switchedPrevMask = known ?? 0;
        pad = p;
        this.padIndex = i;
        switched = true;
      }
    }
    // Self-correcting count (connect events and the initial scan can overlap): stop polling when none remain.
    this.padsConnected = connected;
    if (!pad) {
      if (this.padPresent) this.clearPad();
      return;
    }
    this.padIgnoredAxes = this.padNonStickAxes.get(this.padIndex) ?? 0;
    this.padPresent = true;

    const prev = this.padDownPrev;
    this.padDownPrev = this.padDownNow;
    this.padDownNow = prev;
    if (switched) {
      // Edges of the new pad compare against its own previous state, never another device's.
      for (let i = 0; i < GAMEPAD.maxButtons; i++) this.padDownPrev[i] = (switchedPrevMask >> i) & 1;
    }
    const now = this.padDownNow;
    const buttons = pad.buttons;
    const nb = Math.min(buttons.length, GAMEPAD.maxButtons);
    let newPress = false;
    for (let i = 0; i < GAMEPAD.maxButtons; i++) {
      if (i >= nb) {
        now[i] = 0;
        this.padValues[i] = 0;
        continue;
      }
      const btn = buttons[i]!;
      const value = finiteOr(btn.value, btn.pressed ? 1 : 0);
      const isDown = TRIGGER_BUTTONS.has(i) ? value >= GAMEPAD.triggerThreshold : btn.pressed;
      now[i] = isDown ? 1 : 0;
      this.padValues[i] = value;
      if (isDown && this.padDownPrev[i] === 0) newPress = true;
    }
    const axes = pad.axes;
    for (let a = 0; a < GAMEPAD.maxAxes; a++) this.padAxes[a] = a < axes.length ? finiteOr(axes[a]!, 0) : 0;

    const dz = finiteOr(this.settings.current.controls.gamepadDeadzone, GAMEPAD.stickDeadzone);
    const ax = GAMEPAD.axes;
    shapeStick(
      this.stickAxis(ax.leftX),
      this.stickAxis(ax.leftY),
      dz,
      GAMEPAD.outerDeadzone,
      1,
      this.moveStick,
    );
    shapeStick(
      this.stickAxis(ax.rightX),
      this.stickAxis(ax.rightY),
      dz,
      GAMEPAD.outerDeadzone,
      GAMEPAD.lookCurveExponent,
      this.lookStick,
    );
    // Stick up reports negative Y; our convention is forward / look-up positive.
    this.moveStick.y = -this.moveStick.y;
    this.lookStick.y = -this.lookStick.y;

    const act = GAMEPAD.activityThreshold;
    if (
      newPress ||
      Math.abs(this.moveStick.x) + Math.abs(this.moveStick.y) > act ||
      Math.abs(this.lookStick.x) + Math.abs(this.lookStick.y) > act
    ) {
      this.setDevice('gamepad');
    }
  }

  /** Raw axis value for stick shaping; 0 for axes that are not sticks (see nonStickAxes). */
  private stickAxis(a: number): number {
    return (this.padIgnoredAxes >> a) & 1 ? 0 : this.padAxes[a]!;
  }

  /**
   * Once per pad, when first seen (at rest): without the standard mapping the stick axis indices are
   * guesses, and an XInput layout (LX, LY, LT, RX, RY, RT) puts a trigger resting at -1 on the
   * "right stick X" axis – a permanent full deflection that would spin the camera. Axes resting far
   * from 0 are never read as sticks (padAxis bindings still see them).
   */
  private nonStickAxes(pad: Gamepad): number {
    if (pad.mapping === 'standard') return 0;
    const axes = pad.axes;
    const n = Math.min(axes.length, GAMEPAD.maxAxes);
    let mask = 0;
    for (let a = 0; a < n; a++) {
      if (Math.abs(finiteOr(axes[a]!, 0)) > GAMEPAD.nonStandardTriggerRest) mask |= 1 << a;
    }
    if (!this.warnedPadIds.has(pad.id)) {
      this.warnedPadIds.add(pad.id);
      const ignored = mask
        ? ` – Achsen ohne Ruhelage 0 werden nicht als Stick gelesen (Maske ${mask.toString(2)})`
        : '';
      log.warn(`Gamepad ohne Standard-Belegung („${pad.id}“) – Tasten können abweichen${ignored}`);
    }
    return mask;
  }

  private clearPad(): void {
    this.padPresent = false;
    this.padDownNow.fill(0);
    this.padDownPrev.fill(0);
    this.padValues.fill(0);
    this.padAxes.fill(0);
    this.moveStick.x = this.moveStick.y = 0;
    this.lookStick.x = this.lookStick.y = 0;
  }

  private readonly onPadConnected = (e: GamepadEvent): void => {
    this.padsConnected++;
    log.info(`Gamepad verbunden: ${e.gamepad?.id ?? 'unbekannt'}`);
  };

  private readonly onPadDisconnected = (e: GamepadEvent): void => {
    this.padsConnected = Math.max(0, this.padsConnected - 1);
    if (e.gamepad) {
      // Another device may take this index: it gets a fresh baseline and calibration.
      this.padMasks.delete(e.gamepad.index);
      this.padNonStickAxes.delete(e.gamepad.index);
    }
    if (e.gamepad && e.gamepad.index === this.padIndex) {
      this.padIndex = -1;
      this.clearPad();
    }
    log.info(`Gamepad getrennt: ${e.gamepad?.id ?? 'unbekannt'}`);
    if (this.padsConnected === 0 && this._device === 'gamepad') this.setDevice('kbm');
  };

  // -------------------------------------------------------------------------
  // Keyboard / mouse
  // -------------------------------------------------------------------------

  /** Gameplay owns the keyboard: suppress browser defaults for game keys. */
  private ownsKeyboard(target: EventTarget | null): boolean {
    return this.lockedState || (this._enabled && !isInteractive(target));
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    if (!code || isReservedKey(code, e.key)) return;
    if (isTextEntry(e.target)) return;
    if (code === 'ControlLeft') {
      this.lastCtrlLeftDownAt = e.timeStamp;
    } else if (code === 'AltRight' && e.timeStamp - this.lastCtrlLeftDownAt <= INPUT.altGrPairMs) {
      // The ControlLeft right before was Windows' synthetic half of AltGr (also on auto-repeat).
      this.keysDown.delete('ControlLeft');
      this.keysPressed.delete('ControlLeft');
    }
    if (!this.keysDown.has(code)) {
      // Auto-repeat after a cleared state (blur) re-holds the key without a fresh press edge.
      if (!e.repeat) this.keysPressed.add(code);
      this.keysDown.add(code);
    }
    if (!e.repeat) this.setDevice('kbm');
    if (this.ownsKeyboard(e.target) && (this.boundCodes.has(code) || PREVENT_CODES.has(code)))
      e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    if (!code) return;
    this.keysDown.delete(code);
    if (code === 'MetaLeft' || code === 'MetaRight') {
      // macOS sends no keyup for keys released while Cmd is held: they would stay down forever.
      // Deleting during Set iteration is safe (deleted entries are skipped).
      for (const c of this.keysDown) if (!MODIFIER_CODES.has(c)) this.keysDown.delete(c);
    }
    if (isFixedKeyCode(code)) return;
    if (this.ownsKeyboard(e.target) && (this.boundCodes.has(code) || PREVENT_CODES.has(code)))
      e.preventDefault();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const b = e.button;
    if (b < 0 || b >= INPUT.maxMouseButtons) return;
    if (this.mouseDown[b] === 0) {
      this.mouseDown[b] = 1;
      this.mousePressed[b] = 1;
    }
    this.setDevice('kbm');
    // Middle-click autoscroll, focus changes and text selection are never wanted on the canvas.
    if (this.lockedState || this._enabled) e.preventDefault();
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const b = e.button;
    if (b >= 0 && b < INPUT.maxMouseButtons) this.mouseDown[b] = 0;
  };

  /** Chromium navigates back/forward on the side buttons' mouseup (others on mousedown/auxclick). */
  private readonly onNavigationButton = (e: MouseEvent): void => {
    if (NAVIGATION_BUTTONS.has(e.button)) e.preventDefault();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (this.lockedState || this._enabled) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.lockedState || this._enabled) e.preventDefault();
    const dy = e.deltaY;
    if (!Number.isFinite(dy) || dy === 0) return;
    this.setDevice('kbm');
    if (e.deltaMode !== 0) {
      // Line/page mode (classic mouse wheels in Firefox): one step per event.
      if (dy < 0) this.wheelAccUp++;
      else this.wheelAccDown++;
      return;
    }
    // Pixel mode: accumulate so trackpads do not produce a step per tiny event.
    if (Math.sign(dy) !== Math.sign(this.wheelPixelAcc)) this.wheelPixelAcc = 0;
    this.wheelPixelAcc += dy;
    const step = INPUT.wheelPixelsPerStep;
    while (this.wheelPixelAcc <= -step) {
      this.wheelAccUp++;
      this.wheelPixelAcc += step;
    }
    while (this.wheelPixelAcc >= step) {
      this.wheelAccDown++;
      this.wheelPixelAcc -= step;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    // Unlocked movement only counts when pointer lock is unavailable and the game plays lock-less.
    if (!this.lockedState && !(this._enabled && (this._lockProblem !== null || !this.pointerLockSupported)))
      return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    if (!this.spikeFilter.accept(dx, dy, performance.now())) return;
    this.mouseAccX += dx;
    this.mouseAccY += dy;
    if (Math.abs(dx) + Math.abs(dy) >= POINTER.deviceSwitchCounts) this.setDevice('kbm');
  };

  private readonly onBlur = (): void => {
    this.clearHeld();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.clearHeld();
  };

  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!this._enabled) return;
    for (const code of INPUT.unloadGuardCodes) {
      if (this.keysDown.has(code)) {
        // Likely Ctrl+W while crouching – ask before closing (the shortcut itself cannot be prevented).
        e.preventDefault();
        e.returnValue = 'RIFTFALL läuft noch.';
        return;
      }
    }
  };

  /** Release everything (blur, tab hidden, lock lost): no stuck keys. Edges follow on the next frame. */
  private clearHeld(): void {
    this.keysDown.clear();
    this.keysPressed.clear();
    this.mouseDown.fill(0);
    this.mousePressed.fill(0);
    this.mouseAccX = 0;
    this.mouseAccY = 0;
    this.wheelAccUp = 0;
    this.wheelAccDown = 0;
    this.wheelPixelAcc = 0;
  }

  private setDevice(d: 'kbm' | 'gamepad'): void {
    if (d === this._device) return;
    this._device = d;
    this.events.emit('input:deviceChanged', { device: d });
  }

  // -------------------------------------------------------------------------
  // Pointer lock
  // -------------------------------------------------------------------------

  private attemptLock(unadjusted: boolean): void {
    let result: Promise<void> | undefined;
    try {
      result = unadjusted
        ? this.target.requestPointerLock({ unadjustedMovement: true })
        : this.target.requestPointerLock();
    } catch (err) {
      this.onLockFailed(err);
      return;
    }
    // Older Safari/Firefox return undefined and only report errors via `pointerlockerror`.
    this.lockPromiseFlow = !!result && typeof (result as Promise<void>).then === 'function';
    if (!this.lockPromiseFlow) return;
    this.lockPending = true;
    (result as Promise<void>).then(
      () => {
        this.lockPending = false;
      },
      (err: unknown) => {
        this.lockPending = false;
        this.onLockRejected(err, unadjusted);
      },
    );
  }

  private onLockRejected(err: unknown, unadjusted: boolean): void {
    if (this.disposed) return;
    if (unadjusted && err instanceof Error && err.name === 'NotSupportedError') {
      log.info('Rohe Mauseingabe nicht unterstützt – nutze Standard-Pointer-Lock');
      this.unadjustedSupported = false;
      this.attemptLock(false);
      return;
    }
    this.onLockFailed(err);
  }

  private readonly onLockChange = (): void => {
    const locked = document.pointerLockElement === this.target;
    if (locked) this.lockPending = false;
    if (locked === this.lockedState) return;
    this.lockedState = locked;
    const now = performance.now();
    this.mouseAccX = 0;
    this.mouseAccY = 0;
    if (locked) {
      this._lockProblem = null;
      this.cancelLockRetry();
      this.spikeFilter.onLock(now);
      // Gameplay owns the mouse again: never keep a rebinding capture armed.
      this.cancelCapture();
    } else {
      this.lastUnlockAt = now;
      // mouseup may never arrive after the lock is gone.
      this.mouseDown.fill(0);
    }
    this.events.emit('input:pointerLock', { locked });
  };

  private readonly onLockError = (): void => {
    // Never let a promise that fails to settle block later requests.
    this.lockPending = false;
    if (this.lockPromiseFlow) return; // handled by the promise rejection
    this.onLockFailed(new Error('pointerlockerror'));
  };

  private onLockFailed(err: unknown): void {
    if (this.disposed || this.lockedState) return;
    const now = performance.now();
    const cooldownEnd = this.lastUnlockAt + POINTER.escapeCooldownMs;
    if (POINTER.retryAfterCooldown && !this.lockRetried && now < cooldownEnd) {
      // Refused because the user just left the lock with Escape: retry once after the cooldown
      // (the click's transient activation is still valid for a few seconds).
      this.lockRetried = true;
      this.cancelLockRetry();
      this.lockRetryTimer = window.setTimeout(
        () => {
          this.lockRetryTimer = 0;
          if (!this.lockedState && !this.disposed) this.attemptLock(this.unadjustedSupported);
        },
        cooldownEnd - now + POINTER.retryMarginMs,
      );
      return;
    }
    // Logged once per episode: lock-less play requests the lock again on every canvas click.
    if (this._lockProblem !== 'denied') log.warn('Pointer Lock verweigert', err);
    this._lockProblem = 'denied';
    this.events.emit('input:pointerLock', { locked: false });
  }

  private cancelLockRetry(): void {
    if (this.lockRetryTimer) window.clearTimeout(this.lockRetryTimer);
    this.lockRetryTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Rebinding capture
  // -------------------------------------------------------------------------

  private finishCapture(b: Binding | null, only?: CaptureState): void {
    const cap = this.capture;
    if (!cap || (only && cap !== only)) return;
    this.capture = null;
    window.clearTimeout(this.pendingCtrlTimer);
    this.pendingCtrlTimer = 0;
    this.setWheelCapture(false);
    window.clearTimeout(cap.timer);
    cap.resolve(b);
  }

  private setWheelCapture(on: boolean): void {
    if (on === this.wheelCaptureActive || typeof window === 'undefined') return;
    this.wheelCaptureActive = on;
    if (on) window.addEventListener('wheel', this.onCaptureWheel, WHEEL_CAPTURE_OPTS);
    else window.removeEventListener('wheel', this.onCaptureWheel, WHEEL_CAPTURE_OPTS);
  }

  private readonly onCaptureKey = (e: KeyboardEvent): void => {
    // Runs first for every keydown: learn what the key prints (labels without getLayoutMap).
    // Unmodified only (digits must not be learned as their Shift symbols); AltGr reports Ctrl+Alt.
    if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && typeof e.key === 'string') {
      learnPrintedKey(e.code, e.key);
    }
    const cap = this.capture;
    if (!cap?.armed) return;
    const code = e.code;
    // Console / debug keys keep working and can never be bound; typing into the console is not a binding.
    if (!code || isReservedKey(code, e.key) || isTextEntry(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (this.pendingCtrlTimer) {
      // AltRight right after ControlLeft is AltGr (Windows); any other key: Ctrl came first.
      this.finishCapture({ device: 'key', code: code === 'AltRight' ? 'AltRight' : 'ControlLeft' });
      return;
    }
    if (code === 'ControlLeft') {
      this.pendingCtrlTimer = window.setTimeout(() => {
        this.pendingCtrlTimer = 0;
        this.finishCapture({ device: 'key', code: 'ControlLeft' }, cap);
      }, INPUT.altGrPairMs);
      return;
    }
    this.finishCapture(code === 'Escape' ? null : { device: 'key', code });
  };

  private readonly onCaptureMouse = (e: MouseEvent): void => {
    const cap = this.capture;
    if (!cap?.armed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.suppressClickUntil = performance.now() + POINTER.captureClickSuppressMs;
    // Buttons beyond the tracked range could never be evaluated (and the settings sanitizer drops them).
    if (e.button < 0 || e.button >= INPUT.maxMouseButtons) return;
    this.finishCapture({ device: 'mouse', button: e.button });
  };

  private readonly onCaptureWheel = (e: WheelEvent): void => {
    const cap = this.capture;
    if (!cap?.armed || !Number.isFinite(e.deltaY) || e.deltaY === 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.finishCapture({ device: 'wheel', direction: e.deltaY < 0 ? 'up' : 'down' });
  };

  /** Swallows the click/contextmenu that follows a captured mouse button. */
  private readonly onSuppressClick = (e: MouseEvent): void => {
    if (this.capture?.armed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (performance.now() < this.suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click' || e.type === 'contextmenu') this.suppressClickUntil = 0;
    }
  };

  private capturePad(cap: CaptureState): void {
    if (!this.padPresent) return;
    for (let i = 0; i < GAMEPAD.maxButtons; i++) {
      const isDown = this.padDownNow[i] === 1;
      if (cap.padBaseline[i] === 1) {
        // Buttons held when the capture started must be released first.
        if (!isDown) cap.padBaseline[i] = 0;
      } else if (isDown) {
        this.finishCapture({ device: 'pad', button: i });
        return;
      }
    }
    for (let a = 0; a < GAMEPAD.maxAxes; a++) {
      const v = this.padAxes[a]!;
      const deflected = Math.abs(v) >= GAMEPAD.captureAxisThreshold;
      if (cap.axisBaseline[a] === 1) {
        if (!deflected) cap.axisBaseline[a] = 0;
      } else if (deflected) {
        this.finishCapture({ device: 'padAxis', axis: a, direction: v < 0 ? -1 : 1 });
        return;
      }
    }
  }

  private listen(
    t: EventTarget,
    type: string,
    fn: EventListener,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    t.addEventListener(type, fn, opts);
    this.listeners.push([t, type, fn, opts]);
  }
}

/** Held buttons as a bitmask (bit i = standard button i; triggers use the trigger threshold). */
function padButtonMask(p: Gamepad): number {
  const b = p.buttons;
  const n = Math.min(b.length, GAMEPAD.maxButtons);
  let mask = 0;
  for (let i = 0; i < n; i++) {
    const btn = b[i]!;
    const down = TRIGGER_BUTTONS.has(i)
      ? finiteOr(btn.value, btn.pressed ? 1 : 0) >= GAMEPAD.triggerThreshold
      : btn.pressed;
    if (down) mask |= 1 << i;
  }
  return mask;
}
