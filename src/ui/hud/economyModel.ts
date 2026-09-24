/**
 * Pure logic of the economy HUD (M4): number formatting, the points roll, the pooled points
 * popups, interaction key caps / cost states, power-up timer rings and the banner queue. No DOM –
 * EconomyHud renders these; tests drive them directly. Per-frame paths allocate nothing (pools
 * and reused output objects).
 */
import type { PointsReason } from '../../core/events';
import { clamp01 } from '../../core/math';
import type { Binding, BindingMap } from '../../defs/input';
import { ECONOMY_HUD, type PointsPopupTone } from '../../defs/ui';
import { bindingLabel, familyBindings, type KeyboardLayout } from '../../input/bindings';

const P = ECONOMY_HUD.popups;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** German thousands grouping ("12.340"), no Intl (identical in every environment). */
export function formatPoints(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const n = Math.round(value);
  const neg = n < 0;
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits[i];
  }
  return neg ? `−${out}` : out;
}

/** Popup text: "+60" / "−950" (typographic minus). */
export function formatPopup(amount: number): string {
  const n = Math.round(amount);
  return n < 0 ? `−${formatPoints(-n)}` : `+${formatPoints(n)}`;
}

/** Popup colour of a balance change (negative deltas are always spending). */
export function popupTone(delta: number, reason: PointsReason): PointsPopupTone {
  if (delta < 0) return 'spend';
  return P.tones[reason] ?? 'normal';
}

// ---------------------------------------------------------------------------
// Points roll
// ---------------------------------------------------------------------------

/** Roll length for a change of `delta` points (s). */
export function rollDuration(delta: number): number {
  const R = ECONOMY_HUD.points.roll;
  const d = Math.abs(delta);
  if (!(d >= 1)) return 0;
  return Math.min(R.maxSeconds, Math.max(R.minSeconds, R.minSeconds + R.perDecade * Math.log10(d)));
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * The shown points value rolls towards the balance (ease-out, length by the size of the change);
 * a change mid-roll continues from the value shown right now. `set(total, false)` snaps.
 */
export class PointsRoll {
  private from = 0;
  private to = 0;
  private t = 0;
  private dur = 0;
  private value = 0;

  /** Balance the roll heads to. */
  get target(): number {
    return this.to;
  }

  /** Whole number to display this frame. */
  get shown(): number {
    return Math.round(this.value);
  }

  get rolling(): boolean {
    return this.dur > 0;
  }

  set(total: number, animate: boolean): void {
    const v = Number.isFinite(total) ? total : 0;
    this.to = v;
    this.t = 0;
    this.dur = animate ? rollDuration(v - this.value) : 0;
    this.from = this.value;
    if (this.dur <= 0) this.value = v;
  }

  update(dt: number): void {
    if (this.dur <= 0 || !(dt > 0)) return;
    this.t += dt;
    const k = Math.min(1, this.t / this.dur);
    this.value = this.from + (this.to - this.from) * easeOutCubic(k);
    if (k >= 1) {
      this.value = this.to;
      this.dur = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

export interface PointsPopup {
  active: boolean;
  amount: number;
  tone: PointsPopupTone;
  age: number;
  /** Horizontal lane offset (px). */
  lane: number;
  /** Bumped on every change of amount/tone (the view rewrites text/class only then). */
  version: number;
  /** Order of creation (the oldest is reused when the pool is full). */
  serial: number;
}

export interface PopupMotion {
  rise: number;
  scale: number;
  opacity: number;
}

/**
 * "+N" / "−N" popups next to the points counter, pooled. Earnings of one tone within
 * `mergeWindow` add up in the newest popup (rewinding its age a little) instead of stacking.
 */
export class PointsPopupModel {
  readonly items: PointsPopup[] = [];
  private serial = 0;
  private laneIndex = 0;

  constructor(size: number = P.pool) {
    const n = Math.max(1, Math.floor(size));
    for (let i = 0; i < n; i++) {
      this.items.push({ active: false, amount: 0, tone: 'normal', age: 0, lane: 0, version: 0, serial: 0 });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.items) if (p.active) n++;
    return n;
  }

  /** A balance change; 0 (a reset / announce) shows nothing. Returns the popup used. */
  push(delta: number, reason: PointsReason): PointsPopup | null {
    if (!Number.isFinite(delta) || Math.round(delta) === 0) return null;
    const amount = Math.round(delta);
    const tone = popupTone(amount, reason);
    let newest: PointsPopup | null = null;
    for (const p of this.items) if (p.active && (!newest || p.serial > newest.serial)) newest = p;
    if (newest && newest.tone === tone && newest.age < P.mergeWindow) {
      newest.amount += amount;
      newest.age = Math.min(newest.age, P.mergeAgeCap * P.lifetime);
      newest.version++;
      return newest;
    }
    let slot: PointsPopup | null = null;
    for (const p of this.items) {
      if (!p.active) {
        slot = p;
        break;
      }
      if (!slot || p.serial < slot.serial) slot = p;
    }
    const p = slot!;
    const lanes = P.lanesPx;
    p.active = true;
    p.amount = amount;
    p.tone = tone;
    p.age = 0;
    p.lane = lanes.length > 0 ? lanes[this.laneIndex++ % lanes.length]! : 0;
    p.version++;
    p.serial = ++this.serial;
    return p;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    for (const p of this.items) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= P.lifetime) p.active = false;
    }
  }

  clear(): void {
    for (const p of this.items) p.active = false;
    this.laneIndex = 0;
  }
}

/** Rise (px, upwards), pop scale and opacity of a popup at `age` (written into `out`). */
export function popupMotion(age: number, out: PopupMotion): PopupMotion {
  const a = Math.max(0, age);
  const k = clamp01(a / P.lifetime);
  // Fast start, slow drift: most of the rise happens early.
  out.rise = P.risePx * (1 - (1 - k) * (1 - k));
  out.scale = a < P.popTime ? P.popScale + (1 - P.popScale) * (a / P.popTime) : 1;
  const fadeStart = P.lifetime - P.fadeTime;
  out.opacity = a >= P.lifetime ? 0 : a <= fadeStart ? 1 : clamp01((P.lifetime - a) / P.fadeTime);
  return out;
}

// ---------------------------------------------------------------------------
// Interaction prompt
// ---------------------------------------------------------------------------

export interface KeyCap {
  label: string;
  /** Gamepad button (round cap). */
  pad: boolean;
  /** Face button id ('a' | 'b' | 'x' | 'y') for its colour, else ''. */
  face: string;
}

const PR = ECONOMY_HUD.prompt;

function capFor(b: Binding, layout: KeyboardLayout | undefined, out: KeyCap): KeyCap {
  out.pad = false;
  out.face = '';
  switch (b.device) {
    case 'key':
      out.label = bindingLabel(b, layout);
      break;
    case 'mouse':
      out.label = PR.mouseLabels[b.button] ?? `M${b.button + 1}`;
      break;
    case 'wheel':
      out.label = PR.wheelLabels[b.direction];
      break;
    case 'pad':
      out.label = PR.padLabels[b.button] ?? String(b.button);
      out.pad = true;
      out.face = PR.padFace[b.button] ?? '';
      break;
    case 'padAxis':
      out.label = bindingLabel(b).replace(/^Pad /, '');
      out.pad = true;
      break;
  }
  return out;
}

/**
 * Key cap of the interact action for the active device: the first binding of its family
 * (keyboard/mouse or pad), else the unbound mark. `layout` prints character keys as the user's
 * keyboard does (KeyZ → "Y" on German layouts).
 */
export function interactKeyCap(
  bindings: BindingMap | null | undefined,
  device: 'kbm' | 'gamepad',
  layout?: KeyboardLayout,
  out: KeyCap = { label: '', pad: false, face: '' },
): KeyCap {
  const list = bindings?.interact ?? [];
  const b = familyBindings(list, device === 'gamepad' ? 'pad' : 'kbm')[0];
  if (b) return capFor(b, layout, out);
  out.label = PR.unbound;
  out.pad = device === 'gamepad';
  out.face = '';
  return out;
}

/** 'free': no price shown; 'ok' / 'short': affordable or not. */
export type CostState = 'free' | 'ok' | 'short';

export function costState(cost: number | null, affordable: boolean): CostState {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return 'free';
  return affordable ? 'ok' : 'short';
}

// ---------------------------------------------------------------------------
// Power-up timers
// ---------------------------------------------------------------------------

export interface TimerRing {
  /** 0..1 of the full duration left (the ring's filled share). */
  fraction: number;
  /** Whole seconds shown under the icon. */
  seconds: number;
  /** In the warning window (flashing). */
  ending: boolean;
}

export function timerRing(
  remaining: number,
  duration: number,
  warnSeconds: number,
  out: TimerRing = { fraction: 0, seconds: 0, ending: false },
): TimerRing {
  const r = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  out.fraction = duration > 0 && Number.isFinite(duration) ? clamp01(r / duration) : 0;
  out.seconds = Math.max(0, Math.ceil(r - 1e-6));
  out.ending = r > 0 && r <= warnSeconds;
  return out;
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export type EconomyBannerKind = 'powerUp' | 'zone' | 'perk' | 'box' | 'revive';

export interface EconomyBanner {
  kind: EconomyBannerKind;
  kicker: string;
  title: string;
  sub: string;
  /** CSS colour (`#rrggbb`). */
  color: string;
  /** 24×24 stroke glyph path (perks, power-ups) or null. */
  glyph: string | null;
  seconds: number;
}

const MERGE_SEP = ' · ';

/**
 * One banner at a time; later ones wait (at most `capacity`, the oldest waiting one is dropped).
 * While others wait the current one ends after `minSeconds`. Zone banners arriving within
 * `mergeSeconds` of each other join into one ("A · B", at most `maxMerged` names – `door all` in
 * the dev console opens every zone at once).
 */
export class BannerQueue {
  private _current: EconomyBanner | null = null;
  private age = 0;
  private readonly waiting: EconomyBanner[] = [];
  /** Bumped whenever the current banner (or its text) changes – the view re-renders then. */
  version = 0;

  constructor(
    private readonly capacity: number = ECONOMY_HUD.banners.queue,
    private readonly minSeconds: number = ECONOMY_HUD.banners.minSeconds,
    private readonly mergeSeconds: number = ECONOMY_HUD.banners.mergeSeconds,
    private readonly maxMerged: number = ECONOMY_HUD.banners.maxMerged,
  ) {}

  get current(): EconomyBanner | null {
    return this._current;
  }

  get pending(): number {
    return this.waiting.length;
  }

  push(b: EconomyBanner): 'shown' | 'queued' | 'merged' {
    const cur = this._current;
    if (b.kind === 'zone') {
      const parts = cur ? cur.title.split(MERGE_SEP).length : 0;
      if (cur && cur.kind === 'zone' && this.age < this.mergeSeconds && parts < this.maxMerged) {
        cur.title = `${cur.title}${MERGE_SEP}${b.title}`;
        this.version++;
        return 'merged';
      }
    }
    if (!cur) {
      this.show(b);
      return 'shown';
    }
    if (this.waiting.length >= Math.max(1, this.capacity)) this.waiting.shift();
    this.waiting.push(b);
    return 'queued';
  }

  update(dt: number): void {
    const cur = this._current;
    if (!cur || !(dt > 0)) return;
    this.age += dt;
    const end = this.waiting.length > 0 ? Math.min(cur.seconds, this.minSeconds) : cur.seconds;
    if (this.age < end) return;
    const next = this.waiting.shift() ?? null;
    if (next) this.show(next);
    else {
      this._current = null;
      this.version++;
    }
  }

  clear(): void {
    this.waiting.length = 0;
    if (this._current) {
      this._current = null;
      this.version++;
    }
  }

  private show(b: EconomyBanner): void {
    this._current = b;
    this.age = 0;
    this.version++;
  }
}
