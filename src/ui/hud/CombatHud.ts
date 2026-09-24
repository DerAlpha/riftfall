/**
 * Hit feedback widgets (DOM): hitmarker X, floating damage numbers, kill confirmation + streak.
 * Logic lives in hitFeedback.ts; this class only renders it. Per frame it writes transforms and
 * opacity of animated elements (compositor-only), text/classes only when they change, and nothing
 * at all while idle.
 */
import type { Camera } from 'three';
import { Matrix4 } from 'three';
import type { HitZone, Vec3Like } from '../../core/events';
import { HUD } from '../../defs/ui';
import {
  DamageNumberModel,
  HitmarkerState,
  KillStreak,
  damageNumberMotion,
  distanceScale,
  formatDamage,
  hitmarkerVariant,
  projectToScreen,
  type DamageNumber,
  type HitmarkerVariant,
  type MarkerSample,
  type ScreenPoint,
} from './hitFeedback';

const VARIANTS: readonly HitmarkerVariant[] = ['shield', 'hit', 'crit', 'kill'];

interface NumberView {
  el: HTMLDivElement;
  shownVersion: number;
  shownText: string;
  shownClass: string;
  shownX: number;
  shownY: number;
  shownScale: number;
  shownOpacity: number;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent?.appendChild(el);
  return el;
}

const _vp = new Matrix4();
const _pt: ScreenPoint = { x: 0, y: 0, w: 0 };
const _sample: MarkerSample = { scale: 1, opacity: 0 };
const _motion = { scale: 1, rise: 0, opacity: 1 };

export class CombatHud {
  readonly marker = new HitmarkerState();
  readonly numbers = new DamageNumberModel();
  readonly streak = new KillStreak();

  private readonly markerEl: HTMLDivElement;
  private readonly numbersEl: HTMLDivElement;
  private readonly views: NumberView[] = [];
  private readonly killEl: HTMLDivElement;
  private readonly killLabel: HTMLSpanElement;
  private readonly killCount: HTMLSpanElement;

  private camera: Camera | null = null;
  private markersEnabled = true;
  private numbersEnabled = true;
  private reduced = false;
  private hudScale = 1;

  private shownVariant: HitmarkerVariant | null = null;
  private shownMarkerScale = -1;
  private shownMarkerOpacity = -1;

  private killAge = Number.POSITIVE_INFINITY;
  private shownKillScale = -1;
  private shownKillOpacity = -1;
  private shownKillText = '';
  private shownKillCount = '';

  constructor(parent: HTMLElement) {
    this.numbersEl = h('div', 'hud-dmgnums', parent);
    for (let i = 0; i < this.numbers.items.length; i++) {
      const el = h('div', 'hud-dmgnum', this.numbersEl);
      el.style.opacity = '0';
      this.views.push({
        el,
        shownVersion: -1,
        shownText: '',
        shownClass: '',
        shownX: NaN,
        shownY: NaN,
        shownScale: NaN,
        shownOpacity: 0,
      });
    }

    this.markerEl = h('div', 'hud-hitmarker', parent);
    for (const corner of ['tl', 'tr', 'bl', 'br']) h('i', `hm-arm hm-arm--${corner}`, this.markerEl);
    this.markerEl.style.opacity = '0';

    this.killEl = h('div', 'hud-kill', parent);
    h('span', 'hud-kill__icon', this.killEl);
    this.killLabel = h('span', 'hud-kill__label', this.killEl);
    this.killCount = h('span', 'hud-kill__count', this.killEl);
    this.killEl.style.opacity = '0';
  }

  setCamera(camera: Camera | null): void {
    this.camera = camera;
  }

  configure(opts: {
    hitmarkers: boolean;
    damageNumbers: boolean;
    reduceFlashing: boolean;
    hudScale: number;
  }): void {
    this.markersEnabled = opts.hitmarkers;
    this.numbersEnabled = opts.damageNumbers;
    this.reduced = opts.reduceFlashing;
    this.hudScale = opts.hudScale;
    this.markerEl.hidden = !opts.hitmarkers;
    this.numbersEl.hidden = !opts.damageNumbers;
    if (!opts.damageNumbers) this.numbers.clear();
    // Force a rewrite of cached values (scale changed / elements re-shown).
    this.shownMarkerScale = -1;
    this.shownKillScale = -1;
    for (const v of this.views) v.shownScale = NaN;
  }

  /**
   * New run: hitmarker, damage numbers, kill confirmation and streak of the last run gone (the next
   * update() writes the hidden state). The death sequence runs little game time and the game over
   * screen freezes the HUD, so they would otherwise still be up when the next run starts.
   */
  reset(): void {
    this.marker.age = Number.POSITIVE_INFINITY;
    this.numbers.clear();
    this.streak.count = 0;
    this.streak.sinceKill = Number.POSITIVE_INFINITY;
    this.killAge = Number.POSITIVE_INFINITY;
  }

  /** The player's damage landed (combat:damage from source 'player'). */
  onDamage(targetId: number, amount: number, zone: HitZone, killed: boolean, point: Vec3Like): void {
    // A hit that did nothing (immune zone, already dead) must not read as a hit.
    if (!(amount > 0) && !killed) return;
    if (this.markersEnabled) this.marker.trigger(hitmarkerVariant(zone, killed));
    if (this.numbersEnabled) this.numbers.add(targetId, amount, zone, killed, point.x, point.y, point.z);
  }

  /** The player killed something (combat:kill from source 'player'). */
  onKill(zone: HitZone): void {
    const n = this.streak.onKill();
    const L = HUD.killConfirm.labels;
    const label = zone === 'head' ? L.head : zone === 'weakpoint' ? L.weakpoint : L.kill;
    if (label !== this.shownKillText) {
      this.shownKillText = label;
      this.killLabel.textContent = label;
    }
    const count = n >= 2 ? `×${n}` : '';
    if (count !== this.shownKillCount) {
      this.shownKillCount = count;
      this.killCount.textContent = count;
      this.killEl.classList.toggle('has-streak', n >= 2);
    }
    this.killAge = 0;
  }

  update(dt: number, width: number, height: number): void {
    this.marker.step(dt);
    this.numbers.step(dt);
    this.streak.step(dt);
    this.renderMarker();
    this.renderNumbers(width, height);
    this.renderKill(dt);
  }

  // -------------------------------------------------------------------------

  private renderMarker(): void {
    const m = this.marker;
    if (!m.active && this.shownMarkerOpacity === 0) return;
    const s = m.sample(this.reduced, _sample);
    if (this.shownVariant !== m.variant) {
      this.shownVariant = m.variant;
      for (const v of VARIANTS) this.markerEl.classList.toggle(`hm--${v}`, v === m.variant);
    }
    const eps = HUD.hitmarker.epsilon;
    const scale = s.scale * this.hudScale;
    if (Math.abs(scale - this.shownMarkerScale) >= eps) {
      this.shownMarkerScale = scale;
      this.markerEl.style.transform = `scale(${scale.toFixed(3)})`;
    }
    const op = s.opacity < eps ? 0 : s.opacity;
    if (Math.abs(op - this.shownMarkerOpacity) >= eps || (op === 0 && this.shownMarkerOpacity !== 0)) {
      this.shownMarkerOpacity = op;
      this.markerEl.style.opacity = op.toFixed(3);
    }
  }

  private renderNumbers(width: number, height: number): void {
    const items = this.numbers.items;
    const cam = this.camera;
    let haveVp = false;
    const D = HUD.damageNumbers;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const v = this.views[i]!;
      if (!it.active) {
        if (v.shownOpacity !== 0) {
          v.shownOpacity = 0;
          v.el.style.opacity = '0';
        }
        continue;
      }
      if (!haveVp) {
        if (!cam || !(width > 0) || !(height > 0)) {
          this.hide(v);
          continue;
        }
        cam.updateMatrixWorld();
        _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        haveVp = true;
      }
      if (!projectToScreen(_vp.elements, it.x, it.y, it.z, width, height, _pt)) {
        this.hide(v);
        continue;
      }
      this.syncContent(it, v);
      damageNumberMotion(it, _motion);
      const x = _pt.x + it.jitter * D.jitterPx * this.hudScale;
      const y = _pt.y - _motion.rise * this.hudScale;
      const scale = _motion.scale * distanceScale(_pt.w) * this.hudScale;
      if (
        !(Math.abs(x - v.shownX) < D.pxEpsilon) ||
        !(Math.abs(y - v.shownY) < D.pxEpsilon) ||
        !(Math.abs(scale - v.shownScale) < HUD.hitmarker.epsilon)
      ) {
        v.shownX = x;
        v.shownY = y;
        v.shownScale = scale;
        v.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
      }
      const op = _motion.opacity;
      if (Math.abs(op - v.shownOpacity) >= HUD.hitmarker.epsilon || (op === 0 && v.shownOpacity !== 0)) {
        v.shownOpacity = op;
        v.el.style.opacity = op.toFixed(3);
      }
    }
  }

  private syncContent(it: DamageNumber, v: NumberView): void {
    if (v.shownVersion === it.version) return;
    v.shownVersion = it.version;
    const text = formatDamage(it.amount);
    if (text !== v.shownText) {
      v.shownText = text;
      v.el.textContent = text;
    }
    const cls = it.kill ? 'is-kill' : it.crit ? 'is-crit' : it.shield ? 'is-shield' : '';
    if (cls !== v.shownClass) {
      if (v.shownClass) v.el.classList.remove(v.shownClass);
      if (cls) v.el.classList.add(cls);
      v.shownClass = cls;
    }
  }

  private hide(v: NumberView): void {
    if (v.shownOpacity === 0) return;
    v.shownOpacity = 0;
    v.el.style.opacity = '0';
  }

  private renderKill(dt: number): void {
    const K = HUD.killConfirm;
    if (!(this.killAge < K.duration)) {
      if (this.shownKillOpacity !== 0) {
        this.shownKillOpacity = 0;
        this.killEl.style.opacity = '0';
      }
      return;
    }
    this.killAge += dt;
    const t = this.killAge;
    const pop = this.reduced ? 1 : K.popScale;
    const k = t < K.popTime ? 1 - t / K.popTime : 0;
    const scale = (1 + (pop - 1) * k * k) * this.hudScale;
    const fadeStart = K.duration - K.fade;
    const op = t <= fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / K.fade);
    const eps = HUD.hitmarker.epsilon;
    if (Math.abs(scale - this.shownKillScale) >= eps) {
      this.shownKillScale = scale;
      this.killEl.style.transform = `translateX(-50%) scale(${scale.toFixed(3)})`;
    }
    if (Math.abs(op - this.shownKillOpacity) >= eps || (op === 0 && this.shownKillOpacity !== 0)) {
      this.shownKillOpacity = op;
      this.killEl.style.opacity = op.toFixed(3);
    }
  }
}
