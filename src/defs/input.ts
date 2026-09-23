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
  crouch: [key('ControlLeft'), key('KeyC'), pad(PAD.B)],
  sprint: [key('ShiftLeft'), pad(PAD.LS)],
  dash: [key('KeyQ'), pad(PAD.RB)],
  fire: [mouse(0), pad(PAD.RT)],
  ads: [mouse(2), pad(PAD.LT)],
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
  /** Aim assist (gamepad only; used from M2). */
  aimAssist: {
    slowdownRadiusDeg: 4,
    slowdownFactor: 0.45,
    magnetismDeg: 2.5,
    magnetismStrength: 0.35,
    maxRange: 45,
  },
} as const;
