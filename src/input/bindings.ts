/**
 * Pure binding helpers: German labels, rebinding with swap semantics and repair of stored maps.
 * No DOM access – shared by InputSystem, menus and tests. The only state is the learned keyboard
 * layout (fed by InputSystem from keydown events where getLayoutMap is unavailable).
 */
import {
  ACTIONS,
  CONSOLE_KEY,
  DEFAULT_BINDINGS,
  FIXED_KEYS,
  GAMEPAD,
  INPUT,
  PAD,
  type Action,
  type Binding,
  type BindingMap,
} from '../defs/input';

/** Keyboard + mouse (+ wheel) share one family; gamepad buttons and axes the other. */
export type BindingFamily = 'kbm' | 'pad';

export interface BindingSlot {
  family: BindingFamily;
  /** 0 = primary, 1 = secondary. */
  index: number;
}

export interface BindingConflict {
  /** Action that previously owned the binding. */
  action: Action;
  binding: Binding;
  /** Binding the other action received instead (swap), or null when it simply lost the binding. */
  swappedIn: Binding | null;
}

export interface SetBindingResult {
  map: BindingMap;
  conflicts: BindingConflict[];
}

/** Optional physical-code → printed-character map (navigator.keyboard.getLayoutMap()). */
export type KeyboardLayout = ReadonlyMap<string, string>;

const FIXED_CODES: ReadonlySet<string> = new Set(Object.values(FIXED_KEYS));
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

// ---------------------------------------------------------------------------
// Classification / equality
// ---------------------------------------------------------------------------

export function bindingFamily(b: Binding): BindingFamily {
  return b.device === 'pad' || b.device === 'padAxis' ? 'pad' : 'kbm';
}

export function bindingEquals(a: Binding, b: Binding): boolean {
  switch (a.device) {
    case 'key':
      return b.device === 'key' && a.code === b.code;
    case 'mouse':
      return b.device === 'mouse' && a.button === b.button;
    case 'wheel':
      return b.device === 'wheel' && a.direction === b.direction;
    case 'pad':
      return b.device === 'pad' && a.button === b.button;
    case 'padAxis':
      return b.device === 'padAxis' && a.axis === b.axis && a.direction === b.direction;
  }
}

export function cloneBinding(b: Binding): Binding {
  return { ...b };
}

export function cloneBindingMap(map: BindingMap): BindingMap {
  const out = {} as BindingMap;
  for (const a of ACTIONS) out[a] = (map[a] ?? []).map(cloneBinding);
  return out;
}

/** Codes handled outside the rebindable map (console, debug overlay). */
export function isFixedKeyCode(code: string): boolean {
  return FIXED_CODES.has(code);
}

/**
 * True when a keydown should toggle the dev console: the physical Backquote key ("^" on German,
 * "`" on US layouts, often reported as key "Dead"), or a fallback code that produces the caret.
 * Backquote printing "<" / ">" is the Mac ISO key next to left Shift: an ordinary key.
 */
export function isConsoleToggleKey(code: string, key: string): boolean {
  if (code === FIXED_KEYS.console) return !(CONSOLE_KEY.notOnBackquote as readonly string[]).includes(key);
  if ((CONSOLE_KEY.fallbackCodes as readonly string[]).includes(code)) {
    return (CONSOLE_KEY.keys as readonly string[]).includes(key);
  }
  if (code === '' || code === 'Unidentified')
    return (CONSOLE_KEY.unidentifiedKeys as readonly string[]).includes(key);
  return false;
}

/** Keydowns that never reach gameplay or a rebinding capture: the debug key and the console toggle. */
export function isReservedKey(code: string, key: string): boolean {
  return code === FIXED_KEYS.debugOverlay || isConsoleToggleKey(code, key);
}

const KEY_CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
// Same limits as the input system tracks (and the settings sanitizer keeps): anything beyond could
// never be evaluated.
const MAX_MOUSE_BUTTON = INPUT.maxMouseButtons - 1;
const MAX_PAD_BUTTON = GAMEPAD.maxButtons - 1;
const MAX_PAD_AXIS = GAMEPAD.maxAxes - 1;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validates an unknown value as a Binding and returns a clean copy (or null). The debug key is
 * rejected; Backquote is allowed because on Mac ISO keyboards it is the "<" key (see CONSOLE_KEY) –
 * on other layouts it toggles the console, so such a binding simply never fires there.
 */
export function parseBinding(raw: unknown): Binding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.device) {
    case 'key':
      return typeof r.code === 'string' && KEY_CODE_RE.test(r.code) && r.code !== FIXED_KEYS.debugOverlay
        ? { device: 'key', code: r.code }
        : null;
    case 'mouse':
      return isInt(r.button, 0, MAX_MOUSE_BUTTON) ? { device: 'mouse', button: r.button } : null;
    case 'wheel':
      return r.direction === 'up' || r.direction === 'down'
        ? { device: 'wheel', direction: r.direction }
        : null;
    case 'pad':
      return isInt(r.button, 0, MAX_PAD_BUTTON) ? { device: 'pad', button: r.button } : null;
    case 'padAxis':
      return isInt(r.axis, 0, MAX_PAD_AXIS) && (r.direction === 1 || r.direction === -1)
        ? { device: 'padAxis', axis: r.axis, direction: r.direction }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** Bindings of one family in stored order. */
export function familyBindings(list: readonly Binding[], family: BindingFamily): Binding[] {
  const out: Binding[] = [];
  for (const b of list) if (bindingFamily(b) === family) out.push(b);
  return out;
}

export function getSlotBinding(map: BindingMap, action: Action, slot: BindingSlot): Binding | null {
  return familyBindings(map[action] ?? [], slot.family)[slot.index] ?? null;
}

function joinFamilies(kbm: Binding[], pad: Binding[]): Binding[] {
  const max = INPUT.maxBindingsPerFamily;
  return [...kbm.slice(0, max), ...pad.slice(0, max)];
}

function withFamily(list: readonly Binding[], family: BindingFamily, fam: Binding[]): Binding[] {
  return family === 'kbm'
    ? joinFamilies(fam, familyBindings(list, 'pad'))
    : joinFamilies(familyBindings(list, 'kbm'), fam);
}

/**
 * Assign `binding` to `slot` of `action` (null clears the slot). Returns a new map; the input is
 * not mutated. If another action already uses the binding it receives the slot's previous binding
 * instead (swap) – or loses it when the slot was empty – and is reported as a conflict. The
 * previous binding is handed to at most one action and only while no action owns it any more, so a
 * swap never puts one button on two actions (defaults share pad X between reload and interact).
 * A binding of a different family than the slot is rejected (map returned unchanged).
 */
export function setBinding(
  map: BindingMap,
  action: Action,
  slot: BindingSlot,
  binding: Binding | null,
): SetBindingResult {
  const next = cloneBindingMap(map);
  const conflicts: BindingConflict[] = [];
  const index = Math.max(0, Math.min(INPUT.maxBindingsPerFamily - 1, Math.floor(slot.index)));
  if (binding && (bindingFamily(binding) !== slot.family || parseBinding(binding) === null)) {
    return { map: next, conflicts };
  }
  const fam = familyBindings(next[action], slot.family);
  const old = fam[index] ?? null;

  if (!binding) {
    if (index < fam.length) fam.splice(index, 1);
    next[action] = withFamily(next[action], slot.family, fam);
    return { map: next, conflicts };
  }
  if (old && bindingEquals(old, binding)) return { map: next, conflicts };

  const b = cloneBinding(binding);
  const dup = fam.findIndex((x, i) => i !== index && bindingEquals(x, b));
  if (index < fam.length) fam[index] = b;
  else fam.push(b);
  if (dup >= 0) {
    // Same action, other slot: the two slots trade places.
    if (old) fam[dup] = cloneBinding(old);
    else fam.splice(dup, 1);
  }
  next[action] = withFamily(next[action], slot.family, fam);

  for (const other of ACTIONS) {
    if (other === action) continue;
    const ofam = familyBindings(next[other], slot.family);
    const k = ofam.findIndex((x) => bindingEquals(x, b));
    if (k < 0) continue;
    // Checked against the updated map: once one action took `old`, it is owned again.
    const swapped = old && !isBindingOwned(next, old) ? cloneBinding(old) : null;
    if (swapped) ofam[k] = swapped;
    else ofam.splice(k, 1);
    next[other] = withFamily(next[other], slot.family, ofam);
    conflicts.push({ action: other, binding: cloneBinding(b), swappedIn: swapped });
  }
  return { map: next, conflicts };
}

function isBindingOwned(map: BindingMap, b: Binding): boolean {
  for (const a of ACTIONS) if (map[a].some((x) => bindingEquals(x, b))) return true;
  return false;
}

/**
 * Repair a stored binding map: unknown actions are dropped, actions missing entirely (or not an
 * array) are restored from DEFAULT_BINDINGS, invalid/duplicate entries are removed and each
 * family is capped at primary + secondary. An explicitly empty list stays empty (user unbound it).
 */
export function sanitizeBindings(raw: unknown): BindingMap {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as BindingMap;
  for (const action of ACTIONS) {
    const list = Object.prototype.hasOwnProperty.call(src, action) ? src[action] : undefined;
    if (!Array.isArray(list)) {
      out[action] = DEFAULT_BINDINGS[action].map(cloneBinding);
      continue;
    }
    const clean: Binding[] = [];
    for (const entry of list) {
      const b = parseBinding(entry);
      if (b && !clean.some((x) => bindingEquals(x, b))) clean.push(b);
    }
    out[action] = joinFamilies(familyBindings(clean, 'kbm'), familyBindings(clean, 'pad'));
  }
  return out;
}

/** True if the value only contains known actions with valid bindings (no repair needed). */
export function isValidBindingMap(raw: unknown): raw is BindingMap {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!ACTION_SET.has(k)) return false;
  for (const a of ACTIONS) {
    const list = r[a];
    if (!Array.isArray(list)) return false;
    for (const b of list) if (parseBinding(b) === null) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Labels (German, player facing)
// ---------------------------------------------------------------------------

const KEY_NAMES: Readonly<Record<string, string>> = {
  Space: 'Leertaste',
  Enter: 'Eingabe',
  NumpadEnter: 'Num Eingabe',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Rücktaste',
  CapsLock: 'Feststelltaste',
  ShiftLeft: 'Umschalt links',
  ShiftRight: 'Umschalt rechts',
  ControlLeft: 'Strg links',
  ControlRight: 'Strg rechts',
  AltLeft: 'Alt',
  AltRight: 'Alt Gr',
  MetaLeft: 'Meta links',
  MetaRight: 'Meta rechts',
  ContextMenu: 'Menütaste',
  ArrowUp: 'Pfeil hoch',
  ArrowDown: 'Pfeil runter',
  ArrowLeft: 'Pfeil links',
  ArrowRight: 'Pfeil rechts',
  Insert: 'Einfg',
  Delete: 'Entf',
  Home: 'Pos1',
  End: 'Ende',
  PageUp: 'Bild auf',
  PageDown: 'Bild ab',
  PrintScreen: 'Druck',
  ScrollLock: 'Rollen',
  Pause: 'Pause',
  NumLock: 'Num',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num ,',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '^',
  IntlBackslash: '<',
};

const MOUSE_NAMES: readonly string[] = [
  'Linke Maustaste',
  'Mittlere Maustaste',
  'Rechte Maustaste',
  'Maustaste 4',
  'Maustaste 5',
];

const PAD_NAMES: Readonly<Record<number, string>> = {
  [PAD.A]: 'A',
  [PAD.B]: 'B',
  [PAD.X]: 'X',
  [PAD.Y]: 'Y',
  [PAD.LB]: 'LB',
  [PAD.RB]: 'RB',
  [PAD.LT]: 'LT',
  [PAD.RT]: 'RT',
  [PAD.SELECT]: 'Ansicht',
  [PAD.START]: 'Menü',
  [PAD.LS]: 'L-Stick drücken',
  [PAD.RS]: 'R-Stick drücken',
  [PAD.UP]: 'Steuerkreuz ↑',
  [PAD.DOWN]: 'Steuerkreuz ↓',
  [PAD.LEFT]: 'Steuerkreuz ←',
  [PAD.RIGHT]: 'Steuerkreuz →',
  16: 'Home',
};

const learned = new Map<string, string>();

/**
 * Code → printed character learned from keydown events. Fallback for browsers without
 * navigator.keyboard.getLayoutMap() (Firefox, Safari): captured keys then show what the key prints
 * (Z/Y, umlauts) instead of the US name of the physical position.
 */
export const learnedLayout: KeyboardLayout = learned;

/**
 * Record what an unmodified keydown printed (`key` of a KeyboardEvent without Shift/Ctrl/Alt/Meta,
 * so digits are not learned as their shifted symbols). Dead keys and named keys are ignored.
 */
export function learnPrintedKey(code: string, key: string): void {
  if (code === '' || key.length !== 1 || key === ' ') return;
  const printed = key.toLowerCase();
  if (learned.get(code) !== printed) learned.set(code, printed);
}

function keyLabel(code: string, layout?: KeyboardLayout): string {
  const named = KEY_NAMES[code];
  // Named keys keep their German name; character keys show what the user's layout prints
  // (codes are physical US positions: KeyZ prints "Y" on a German keyboard).
  const isCharKey =
    code.startsWith('Key') || code.startsWith('Digit') || (named !== undefined && named.length === 1);
  if (isCharKey && layout) {
    const printed = layout.get(code);
    if (printed && printed.trim() !== '') {
      // 'ß'.toUpperCase() is 'SS' – keep characters whose upper case is not a single character.
      const upper = printed.toUpperCase();
      return upper.length === printed.length ? upper : printed;
    }
  }
  if (named) return named;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

function axisLabel(axis: number, direction: 1 | -1): string {
  const stick = axis < 2 ? 'L-Stick' : axis < 4 ? 'R-Stick' : `Achse ${axis}`;
  if (axis >= 4) return `Pad ${stick} ${direction > 0 ? '+' : '−'}`;
  const vertical = axis % 2 === 1;
  const dir = vertical ? (direction < 0 ? 'hoch' : 'runter') : direction < 0 ? 'links' : 'rechts';
  return `Pad ${stick} ${dir}`;
}

/** Player-facing German label, e.g. 'Leertaste', 'Linke Maustaste', 'Mausrad hoch', 'Pad A'. */
export function bindingLabel(b: Binding, layout?: KeyboardLayout): string {
  switch (b.device) {
    case 'key':
      return keyLabel(b.code, layout);
    case 'mouse':
      return MOUSE_NAMES[b.button] ?? `Maustaste ${b.button + 1}`;
    case 'wheel':
      return b.direction === 'up' ? 'Mausrad hoch' : 'Mausrad runter';
    case 'pad':
      return `Pad ${PAD_NAMES[b.button] ?? `Taste ${b.button}`}`;
    case 'padAxis':
      return axisLabel(b.axis, b.direction);
  }
}

const ACTION_LABELS: Readonly<Record<Action, string>> = {
  moveForward: 'Vorwärts',
  moveBack: 'Rückwärts',
  moveLeft: 'Links',
  moveRight: 'Rechts',
  jump: 'Springen',
  crouch: 'Ducken / Rutschen',
  sprint: 'Sprinten',
  dash: 'Dash',
  fire: 'Feuern',
  ads: 'Zielen',
  reload: 'Nachladen',
  interact: 'Interagieren',
  melee: 'Nahkampf',
  grenade: 'Granate',
  ability: 'Fähigkeit',
  weaponNext: 'Nächste Waffe',
  weaponPrev: 'Vorherige Waffe',
  weapon1: 'Waffe 1',
  weapon2: 'Waffe 2',
  weapon3: 'Waffe 3',
  weapon4: 'Waffe 4',
  inspect: 'Waffe inspizieren',
  pause: 'Pause',
  scoreboard: 'Punktestand',
};

export function actionLabel(action: Action): string {
  return ACTION_LABELS[action] ?? action;
}

/** Grouping of actions for the keybinding list (German headings). */
export const ACTION_GROUPS: readonly { label: string; actions: readonly Action[] }[] = [
  {
    label: 'Bewegung',
    actions: ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'jump', 'crouch', 'sprint', 'dash'],
  },
  { label: 'Kampf', actions: ['fire', 'ads', 'reload', 'melee', 'grenade', 'ability'] },
  {
    label: 'Waffen',
    actions: ['weaponNext', 'weaponPrev', 'weapon1', 'weapon2', 'weapon3', 'weapon4', 'inspect'],
  },
  { label: 'Sonstiges', actions: ['interact', 'scoreboard', 'pause'] },
];

/** Joined labels of all bindings of an action in one family ('—' when unbound). */
export function actionBindingSummary(
  map: BindingMap,
  action: Action,
  family: BindingFamily,
  layout?: KeyboardLayout,
): string {
  const list = familyBindings(map[action] ?? [], family);
  return list.length > 0 ? list.map((b) => bindingLabel(b, layout)).join(' / ') : '—';
}
