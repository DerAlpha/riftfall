/**
 * Validation/repair of persisted settings and profile data.
 *
 * Every settings field has a rule in SETTINGS_SPEC (typed so a new field in settingsSchema.ts
 * without a rule is a compile error). Values are deep-merged onto a fallback (defaults, or the
 * current settings when the SettingsStore applies a patch): numbers are clamped, enums/booleans
 * validated, unknown keys dropped. Bindings are validated per entry and missing actions filled
 * from DEFAULT_BINDINGS. Pure module – no browser APIs.
 *
 * The binding validator intentionally does not import src/input (the input system owns its own
 * repair helper); both agree on the Binding shape from defs/input.ts.
 */
import type { ProfileData } from '../core/contracts';
import { clamp } from '../core/math';
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  FIXED_KEYS,
  GAMEPAD,
  INPUT,
  type Action,
  type Binding,
  type BindingMap,
} from '../defs/input';
import { MENU } from '../defs/ui';
import { createDefaultProfile } from './defaults';
import { sanitizeProgressionFields } from './sanitizeProgression';
import {
  createDefaultSettings,
  type AccessibilitySettings,
  type AudioSettings,
  type ControlSettings,
  type GameplaySettings,
  type GraphicsSettings,
  type QualityLevel,
  type Settings,
  type SettingsSection,
} from './settingsSchema';

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

interface BoolSpec {
  readonly kind: 'boolean';
}
interface NumberSpec {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
  /** Values <= 0 are kept as 0 ("off", e.g. the frame limiter) instead of being clamped to min. */
  readonly zeroMeansOff?: boolean;
}
/** Numeric value snapped to the nearest allowed option (anisotropy, target FPS). */
interface ChoiceSpec {
  readonly kind: 'choice';
  readonly options: readonly number[];
}
interface EnumSpec<T extends string> {
  readonly kind: 'enum';
  readonly values: readonly T[];
}
interface ColorSpec {
  readonly kind: 'color';
}
interface BindingsSpec {
  readonly kind: 'bindings';
}

type AnySpec = BoolSpec | NumberSpec | ChoiceSpec | EnumSpec<string> | ColorSpec | BindingsSpec;

/** Tuple wrapping prevents distribution over union members (`'a' | 'b'` must map to ONE enum spec). */
type FieldSpec<T> = [T] extends [boolean]
  ? BoolSpec
  : [T] extends [number]
    ? NumberSpec | ChoiceSpec
    : [T] extends [BindingMap]
      ? BindingsSpec
      : [T] extends [string]
        ? string extends T
          ? ColorSpec
          : EnumSpec<T>
        : never;

type SectionSpec<S> = { readonly [K in keyof S]-?: FieldSpec<S[K]> };
type SettingsSpec = { readonly [S in SettingsSection]: SectionSpec<Settings[S]> };

/** Enum rule whose value list must cover every member of T (missing members fail to compile). */
function enumOf<T extends string>() {
  return <const A extends readonly T[]>(
    values: A & (Exclude<T, A[number]> extends never ? unknown : never),
  ): EnumSpec<T> => ({
    kind: 'enum',
    values,
  });
}

const BOOL: BoolSpec = { kind: 'boolean' };
const COLOR: ColorSpec = { kind: 'color' };

function range(r: { readonly min: number; readonly max: number }, integer = false): NumberSpec {
  return { kind: 'number', min: r.min, max: r.max, integer };
}

function choice(options: readonly number[]): ChoiceSpec {
  return { kind: 'choice', options };
}

/** Limits that have no menu range (the menus only offer discrete options for these). */
export const SETTINGS_LIMITS = {
  /** Frame limiter: 0 = unlimited, otherwise clamped to this range. */
  fpsLimit: { min: 15, max: 1000 },
  volume: MENU.ranges.volume,
} as const;

const QUALITY_LEVEL = enumOf<QualityLevel>()(['off', 'low', 'medium', 'high', 'ultra']);
const R = MENU.ranges;

export const SETTINGS_SPEC: SettingsSpec = {
  graphics: {
    preset: enumOf<GraphicsSettings['preset']>()(['low', 'medium', 'high', 'ultra', 'custom']),
    renderScale: range(R.renderScale),
    maxPixelRatio: range(R.maxPixelRatio),
    dynamicResolution: BOOL,
    targetFps: choice(MENU.targetFpsOptions),
    fpsLimit: { kind: 'number', ...SETTINGS_LIMITS.fpsLimit, integer: true, zeroMeansOff: true },
    shadows: QUALITY_LEVEL,
    ambientOcclusion: QUALITY_LEVEL,
    bloom: QUALITY_LEVEL,
    volumetrics: QUALITY_LEVEL,
    antialiasing: enumOf<GraphicsSettings['antialiasing']>()(['off', 'fxaa', 'smaa']),
    motionBlur: BOOL,
    depthOfField: BOOL,
    filmGrain: BOOL,
    chromaticAberration: BOOL,
    vignette: BOOL,
    particles: QUALITY_LEVEL,
    textureQuality: enumOf<GraphicsSettings['textureQuality']>()(['low', 'medium', 'high']),
    anisotropy: choice(MENU.anisotropyOptions),
    toneMapping: enumOf<GraphicsSettings['toneMapping']>()(['agx', 'aces', 'neutral']),
    exposure: range(R.exposure),
    showFps: BOOL,
  } satisfies SectionSpec<GraphicsSettings>,
  audio: {
    master: range(SETTINGS_LIMITS.volume),
    music: range(SETTINGS_LIMITS.volume),
    sfx: range(SETTINGS_LIMITS.volume),
    voice: range(SETTINGS_LIMITS.volume),
    ui: range(SETTINGS_LIMITS.volume),
    muteInBackground: BOOL,
  } satisfies SectionSpec<AudioSettings>,
  controls: {
    mouseSensitivity: range(R.mouseSensitivity),
    adsSensitivityMultiplier: range(R.adsSensitivity),
    invertY: BOOL,
    fov: range(R.fov),
    toggleSprint: BOOL,
    toggleCrouch: BOOL,
    autoSprint: BOOL,
    gamepadSensitivityX: range(R.gamepadSensitivity),
    gamepadSensitivityY: range(R.gamepadSensitivity),
    gamepadInvertY: BOOL,
    gamepadDeadzone: range(R.gamepadDeadzone),
    aimAssist: BOOL,
    vibration: BOOL,
    bindings: { kind: 'bindings' },
  } satisfies SectionSpec<ControlSettings>,
  accessibility: {
    colorblindMode: enumOf<AccessibilitySettings['colorblindMode']>()([
      'none',
      'protanopia',
      'deuteranopia',
      'tritanopia',
    ]),
    subtitles: BOOL,
    screenShake: range(R.screenShake),
    reduceFlashing: BOOL,
    cameraMotion: range(R.cameraMotion),
    hudScale: range(R.hudScale),
  } satisfies SectionSpec<AccessibilitySettings>,
  gameplay: {
    damageNumbers: BOOL,
    minimap: BOOL,
    crosshair: enumOf<GameplaySettings['crosshair']>()(['dot', 'cross', 'circle', 'chevron']),
    crosshairColor: COLOR,
    hitmarkers: BOOL,
  } satisfies SectionSpec<GameplaySettings>,
};

export const SETTINGS_SECTIONS = Object.keys(SETTINGS_SPEC) as readonly SettingsSection[];

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Finite number, or a numeric string (hand-edited / legacy saves); null otherwise. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

function toColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (HEX6.test(s)) return s.toLowerCase();
  if (HEX3.test(s)) {
    const r = s[1] ?? '0';
    const g = s[2] ?? '0';
    const b = s[3] ?? '0';
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function nearestOption(n: number, options: readonly number[], fallback: number): number {
  let best = fallback;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const o of options) {
    const d = Math.abs(o - n);
    if (d < bestDist) {
      best = o;
      bestDist = d;
    }
  }
  return best;
}

/** Deep structural equality for JSON-like data (settings snapshots). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) if (!hasOwn(bo, k) || !jsonEqual(ao[k], bo[k])) return false;
  return true;
}

/** Deep copy of JSON-safe data. */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const FIXED_CODES: ReadonlySet<string> = new Set<string>(Object.values(FIXED_KEYS));

function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Clean copy of a valid binding, or null. Limits follow what the input system tracks. */
export function parseStoredBinding(raw: unknown): Binding | null {
  if (!isRecord(raw)) return null;
  switch (raw.device) {
    case 'key':
      return typeof raw.code === 'string' && KEY_CODE.test(raw.code) && !FIXED_CODES.has(raw.code)
        ? { device: 'key', code: raw.code }
        : null;
    case 'mouse':
      return isIntIn(raw.button, 0, INPUT.maxMouseButtons - 1)
        ? { device: 'mouse', button: raw.button }
        : null;
    case 'wheel':
      return raw.direction === 'up' || raw.direction === 'down'
        ? { device: 'wheel', direction: raw.direction }
        : null;
    case 'pad':
      return isIntIn(raw.button, 0, GAMEPAD.maxButtons - 1) ? { device: 'pad', button: raw.button } : null;
    case 'padAxis':
      return isIntIn(raw.axis, 0, GAMEPAD.maxAxes - 1) && (raw.direction === 1 || raw.direction === -1)
        ? { device: 'padAxis', axis: raw.axis, direction: raw.direction }
        : null;
    default:
      return null;
  }
}

function isPadFamily(b: Binding): boolean {
  return b.device === 'pad' || b.device === 'padAxis';
}

function defaultBindingsFor(action: Action): Binding[] {
  return DEFAULT_BINDINGS[action].map((b) => ({ ...b }));
}

function sanitizeBindingList(list: readonly unknown[], action: Action): Binding[] {
  const kbm: Binding[] = [];
  const pad: Binding[] = [];
  let valid = 0;
  for (const entry of list) {
    const b = parseStoredBinding(entry);
    if (!b) continue;
    valid++;
    const family = isPadFamily(b) ? pad : kbm;
    if (family.length >= INPUT.maxBindingsPerFamily) continue;
    if (family.some((x) => jsonEqual(x, b))) continue;
    family.push(b);
  }
  // A list that had entries but none survived is corruption, not a deliberate "unbound" – restore defaults.
  if (list.length > 0 && valid === 0) return defaultBindingsFor(action);
  return [...kbm, ...pad];
}

/** Validate every action's bindings; unknown actions are dropped, missing ones get the defaults. */
export function sanitizeBindingMap(raw: unknown): BindingMap {
  const src = isRecord(raw) ? raw : {};
  const out = {} as BindingMap;
  for (const action of ACTIONS) {
    const list = hasOwn(src, action) ? src[action] : undefined;
    out[action] = Array.isArray(list) ? sanitizeBindingList(list, action) : defaultBindingsFor(action);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function sanitizeField(spec: AnySpec, raw: unknown, fallback: unknown): unknown {
  switch (spec.kind) {
    case 'boolean':
      return toBoolean(raw) ?? fallback;
    case 'number': {
      const n = toNumber(raw);
      if (n === null) return fallback;
      if (spec.zeroMeansOff && n <= 0) return 0;
      const v = spec.integer ? Math.round(n) : n;
      return clamp(v, spec.min, spec.max);
    }
    case 'choice': {
      const n = toNumber(raw);
      return n === null ? fallback : nearestOption(n, spec.options, fallback as number);
    }
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? raw : fallback;
    case 'color':
      return toColor(raw) ?? fallback;
    case 'bindings':
      return raw === undefined ? cloneJson(fallback) : sanitizeBindingMap(raw);
  }
}

/**
 * Sanitize one section: every known key is validated against its rule, falling back to
 * `fallback[key]` (defaults unless given) when missing or invalid; unknown keys are dropped.
 */
export function sanitizeSection<S extends SettingsSection>(
  section: S,
  raw: unknown,
  fallback?: Readonly<Settings[S]>,
): Settings[S] {
  const spec = SETTINGS_SPEC[section] as unknown as Record<string, AnySpec>;
  const base = (fallback ?? createDefaultSettings()[section]) as unknown as Record<string, unknown>;
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const rule = spec[key];
    if (!rule) continue;
    out[key] = sanitizeField(rule, hasOwn(src, key) ? src[key] : undefined, base[key]);
  }
  return out as unknown as Settings[S];
}

/** Full settings object from anything (corrupt, partial, legacy, hand-edited). Never throws. */
export function sanitizeSettings(raw: unknown): Settings {
  const defaults = createDefaultSettings();
  const src = isRecord(raw) ? raw : {};
  const out = {} as Record<SettingsSection, unknown>;
  for (const section of SETTINGS_SECTIONS) {
    out[section] = sanitizeSection(section, src[section], defaults[section]);
  }
  return out as Settings;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function toTimestamp(v: unknown, fallback: number): number {
  const n = toNumber(v);
  return n !== null && n >= 0 ? Math.floor(n) : fallback;
}

export function sanitizeProfile(raw: unknown, now: number = Date.now()): ProfileData {
  const d = createDefaultProfile(now);
  const src = isRecord(raw) ? raw : {};
  const unlocks = isRecord(src.unlocks) ? src.unlocks : {};
  return {
    createdAt: toTimestamp(src.createdAt, d.createdAt),
    lastPlayedAt: toTimestamp(src.lastPlayedAt, d.lastPlayedAt),
    unlocks: {
      doubleJump: toBoolean(unlocks.doubleJump) ?? d.unlocks.doubleJump,
      dash: toBoolean(unlocks.dash) ?? d.unlocks.dash,
    },
    qualityAutoDetected: toBoolean(src.qualityAutoDetected) ?? d.qualityAutoDetected,
    qualityBenchmarked: toBoolean(src.qualityBenchmarked) ?? d.qualityBenchmarked,
    // M9 meta progression (save v2): sanitizeProgression.ts.
    ...sanitizeProgressionFields(src),
  };
}
