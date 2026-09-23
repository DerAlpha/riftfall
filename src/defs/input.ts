/**
 * Input actions and default bindings. Every gameplay input goes through an Action –
 * never read raw keys in gameplay code. Bindings are user-rebindable and persisted
 * in Settings.controls.bindings.
 */
export const ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'crouch',
  'sprint',
  'dash',
  'fire',
  'ads',
  'reload',
  'interact',
  'melee',
  'grenade',
  'ability',
  'weaponNext',
  'weaponPrev',
  'weapon1',
  'weapon2',
  'weapon3',
  'inspect',
  'pause',
  'scoreboard',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Actions that are handled outside the rebindable gameplay map (fixed keys). */
export const FIXED_KEYS = {
  /** `code` values; Backquote is the physical "^" key on German layouts and "`" on US. */
  console: 'Backquote',
  debugOverlay: 'F3',
} as const;

export type Binding =
  | { device: 'key'; code: string }
  | { device: 'mouse'; button: number }
  | { device: 'wheel'; direction: 'up' | 'down' }
  | { device: 'pad'; button: number }
  | { device: 'padAxis'; axis: number; direction: 1 | -1 };

/** Up to two bindings per action per device family (primary/secondary). */
export type BindingMap = Record<Action, Binding[]>;

/** W3C "standard" gamepad mapping button indices. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const key = (code: string): Binding => ({ device: 'key', code });
const mouse = (button: number): Binding => ({ device: 'mouse', button });
const pad = (button: number): Binding => ({ device: 'pad', button });

export const DEFAULT_BINDINGS: BindingMap = {
  moveForward: [key('KeyW'), key('ArrowUp')],
  moveBack: [key('KeyS'), key('ArrowDown')],
  moveLeft: [key('KeyA'), key('ArrowLeft')],
  moveRight: [key('KeyD'), key('ArrowRight')],
  jump: [key('Space'), pad(PAD.A)],
  // Not on Ctrl by default: Ctrl+Tab / Ctrl+W (scoreboard on Tab, W to move) are reserved browser
  // shortcuts that switch or close the tab. Players can add Ctrl as the secondary key themselves.
  crouch: [key('KeyC'), pad(PAD.B)],
  sprint: [key('ShiftLeft'), pad(PAD.LS)],
  dash: [key('KeyQ'), pad(PAD.RB)],
  fire: [mouse(0), pad(PAD.RT)],
  ads: [mouse(2), pad(PAD.LT)],
  // Pad X is deliberately shared: reload, and interact where an interaction is offered (M4).
  reload: [key('KeyR'), pad(PAD.X)],
  interact: [key('KeyF'), pad(PAD.X)],
  melee: [key('KeyV'), pad(PAD.RS)],
  grenade: [key('KeyG'), pad(PAD.LB)],
  ability: [key('KeyE'), pad(PAD.UP)],
  weaponNext: [{ device: 'wheel', direction: 'down' }, pad(PAD.Y)],
  weaponPrev: [{ device: 'wheel', direction: 'up' }],
  weapon1: [key('Digit1')],
  weapon2: [key('Digit2')],
  weapon3: [key('Digit3')],
  inspect: [key('KeyI'), pad(PAD.RIGHT)],
  pause: [key('Escape'), key('KeyP'), pad(PAD.START)],
  scoreboard: [key('Tab'), pad(PAD.SELECT)],
};

export const GAMEPAD = {
  /** Radial deadzone for sticks (0..1). */
  stickDeadzone: 0.15,
  /** Outer deadzone: deflection above (1 - value) counts as full. */
  outerDeadzone: 0.04,
  triggerThreshold: 0.35,
  /** Response curve exponent for look stick (1 = linear). */
  lookCurveExponent: 2.2,
  /** Axis indices of the standard mapping. */
  axes: { leftX: 0, leftY: 1, rightX: 2, rightY: 3 },
  /**
   * Pads without the standard mapping: an axis that rests beyond this magnitude when the pad is
   * first polled is an analog trigger (resting at -1), not a stick axis, and is never read as one.
   */
  nonStandardTriggerRest: 0.5,
  /** Standard-mapping buttons that are analog triggers (use `triggerThreshold`). */
  triggerButtons: [6, 7],
  /** padAxis bindings count as held above this deflection (after the deadzone). */
  axisPressThreshold: 0.5,
  /** Rebinding: stick deflection required to capture a padAxis binding. */
  captureAxisThreshold: 0.7,
  /** Stick deflection / trigger value that marks the gamepad as the active device. */
  activityThreshold: 0.35,
  /** Tracked button/axis counts (standard mapping: 17 buttons, 4 axes). */
  maxButtons: 20,
  maxAxes: 8,
  /** Rumble requests are clamped to this duration (ms). */
  maxRumbleMs: 2500,
  /** Aim assist (gamepad only; used from M2). */
  aimAssist: {
    slowdownRadiusDeg: 4,
    slowdownFactor: 0.45,
    magnetismDeg: 2.5,
    magnetismStrength: 0.35,
    maxRange: 45,
  },
} as const;

/** Pointer lock + raw mouse handling. */
export const POINTER = {
  /** Request raw (un-accelerated) mouse input; falls back automatically where unsupported. */
  unadjustedMovement: true,
  /** Mouse events within this window after locking are dropped (they carry the cursor-to-center jump). */
  lockSettleMs: 50,
  /** Additionally drop at least this many events after locking. */
  skipEventsAfterLock: 1,
  /** A single event is treated as a spike if its magnitude (|dx|+|dy|) exceeds this many counts … */
  spikeMinCounts: 600,
  /** … and this multiple of the recent average magnitude (genuine flicks ramp up). */
  spikeRatio: 10,
  /** EMA factor for the recent average event magnitude. */
  spikeEmaAlpha: 0.25,
  /** After this many consecutive rejections the movement is accepted (sustained fast flick, high-DPI mice). */
  maxConsecutiveSpikes: 1,
  /** Browsers refuse re-locking for about a second after the user left the lock with Escape. */
  escapeCooldownMs: 1100,
  /** Retry once after the cooldown when a request inside it was refused (the click activation is still valid). */
  retryAfterCooldown: true,
  retryMarginMs: 80,
  /** Mouse movement (|dx|+|dy| counts per event) needed to switch the active device back to mouse. */
  deviceSwitchCounts: 3,
  /** After a mouse button was captured for rebinding, the following click is swallowed for this long. */
  captureClickSuppressMs: 600,
} as const;

/** Keyboard/mouse handling not covered by bindings. */
export const INPUT = {
  /** Default timeout of captureBinding (ms). */
  captureTimeoutMs: 8000,
  /** Max bindings per action per device family (keyboard+mouse / gamepad): primary + secondary. */
  maxBindingsPerFamily: 2,
  /** Tracked mouse buttons (0 left, 1 middle, 2 right, 3 back, 4 forward). */
  maxMouseButtons: 5,
  /** Back/forward mouse buttons: the browser navigates the page on them unless cancelled. */
  navigationMouseButtons: [3, 4],
  /** Pixel-mode wheel deltas (trackpads) are accumulated; one wheel step per this many pixels. */
  wheelPixelsPerStep: 40,
  /**
   * Windows emulates AltGr as a synthetic ControlLeft keydown immediately followed by AltRight
   * ("AltGraph"). A ControlLeft keydown followed by AltRight within this window (ms) is that phantom
   * Ctrl: it is dropped in gameplay, and a rebinding capture waits this long before taking Ctrl.
   */
  altGrPairMs: 40,
  /**
   * Codes whose browser default is suppressed while gameplay owns the keyboard (page scrolling,
   * focus traversal, Firefox quick find, menu bar on Alt). Bound codes are always suppressed too.
   * Reserved browser shortcuts (Ctrl+W/T/N, Cmd+Q, …) can NOT be suppressed outside fullscreen.
   */
  preventDefaultCodes: [
    'Tab',
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'Backspace',
    'AltLeft',
    'AltRight',
    'Slash',
    'Quote',
    'F1',
    'ContextMenu',
  ],
  /**
   * While one of these is held during gameplay, closing the tab asks for confirmation
   * (beforeunload). Mitigates Ctrl+W for players who crouch on Ctrl – that shortcut cannot be
   * prevented. Ctrl+Tab / Ctrl+Shift+Tab (switch tab) cannot be prevented or guarded at all; the
   * game pauses on the visibility change.
   */
  unloadGuardCodes: ['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'],
} as const;

/**
 * Console toggle. FIXED_KEYS.console (Backquote) toggles unless it prints one of `notOnBackquote`;
 * the fallback codes toggle only when they produce one of `keys`. Mac ISO layouts swap the two
 * codes: the "^" key left of "1" reports IntlBackslash and the "<" key next to left Shift reports
 * Backquote – that "<" key is an ordinary, bindable key.
 */
export const CONSOLE_KEY = {
  fallbackCodes: ['IntlBackslash'],
  keys: ['^', '`', '°', '~', 'Dead'],
  /** Keys accepted when the browser reports no usable code at all. */
  unidentifiedKeys: ['^', '`'],
  /** Characters of the Mac ISO "<" key, which reports the Backquote code. */
  notOnBackquote: ['<', '>'],
} as const;
