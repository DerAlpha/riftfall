/**
 * Power-up widgets: a timer per running timed power-up (top center, above the intermission
 * countdown; icon + shrinking ring +
 * seconds, flashing during the last ECONOMY_HUD.powerUps.warnSeconds), the nuke flash and the
 * slow-motion tint.
 *
 * Timers start on powerup:collected with a duration (a re-collect refreshes), end on
 * powerup:expired. The time left comes from the power-up system when a source is set (fixed-tick
 * clock, frozen while paused), else it counts down with the HUD's frame time. One slot per timed
 * type in table order (stable positions); writes happen only when a quantized value changes.
 *
 * The tint is a luminance-preserving `mix-blend-mode: color` overlay: it must blend with the canvas,
 * so it sits in the HUD's parent (#app) right below the HUD layer – inside the HUD layer (its own
 * stacking context) it could not reach the scene. Hidden (no compositing cost) while 0.
 */
import { POWERUP_DEFS, POWERUP_GLYPHS, POWERUP_IDS } from '../../defs/powerups';
import { ECONOMY_HUD } from '../../defs/ui';
import { glyphIcon, h, restartAnim, setText, svgEl } from './dom';
import { timerRing, type TimerRing } from './economyModel';

const PU = ECONOMY_HUD.powerUps;
/** Ring radius in its 48×48 view box. */
const RING_R = 21;
const RING_C = 2 * Math.PI * RING_R;

/** What the timers read of the power-up system (PowerUpSystem fits). */
export interface PowerUpTimerSource {
  remaining(type: string): number;
  duration(type: string): number;
}

interface TimerView {
  type: string;
  el: HTMLDivElement;
  fill: SVGCircleElement;
  time: HTMLSpanElement;
  active: boolean;
  /** Own countdown without a source. */
  left: number;
  full: number;
  /** Seconds left of the leaving animation (<0: none). */
  leaving: number;
  shownFraction: number;
  shownSeconds: number;
  ending: boolean;
  phase: boolean;
}

const _ring: TimerRing = { fraction: 0, seconds: 0, ending: false };

export class PowerUpHud {
  readonly el: HTMLDivElement;
  private readonly timers: TimerView[] = [];
  private readonly flash: HTMLDivElement;
  private readonly tint: HTMLDivElement;
  private source: PowerUpTimerSource | null = null;
  private flashPhase = false;
  private flashLeft = 0;
  private shownTint = 0;
  private reduced = false;

  /** `layer`: the HUD root; `tintParent`/`tintBefore`: where the blend overlay goes (see header). */
  constructor(layer: HTMLElement, tintParent: HTMLElement | null, tintBefore: HTMLElement | null) {
    // First in the layer: the intermission countdown (a later sibling) moves down while timers show.
    this.el = h('div', 'hud-powerups');
    this.el.hidden = true;
    layer.prepend(this.el);
    for (const id of POWERUP_IDS) {
      const def = POWERUP_DEFS[id]!;
      if (!(def.duration > 0)) continue;
      const el = h('div', 'hud-pu', this.el);
      el.style.setProperty('--pu', `#${def.hudColor.toString(16).padStart(6, '0')}`);
      el.dataset.type = id;
      const ring = svgEl('svg', { class: 'hud-pu__ring', viewBox: '0 0 48 48', 'aria-hidden': 'true' }, el);
      svgEl('circle', { class: 'hud-pu__track', cx: 24, cy: 24, r: RING_R }, ring);
      const fill = svgEl(
        'circle',
        { class: 'hud-pu__fill', cx: 24, cy: 24, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2) },
        ring,
      );
      glyphIcon('hud-pu__glyph', el, POWERUP_GLYPHS[def.glyph]);
      const time = h('span', 'hud-pu__time', el);
      el.hidden = true;
      this.timers.push({
        type: id,
        el,
        fill,
        time,
        active: false,
        left: 0,
        full: 0,
        leaving: -1,
        shownFraction: -1,
        shownSeconds: -1,
        ending: false,
        phase: false,
      });
    }
    this.flash = h('div', 'hud-nukeflash', layer);
    this.flash.hidden = true;
    this.tint = h('div', 'hud-timetint');
    this.tint.hidden = true;
    this.tint.setAttribute('aria-hidden', 'true');
    if (tintParent) tintParent.insertBefore(this.tint, tintBefore);
    else layer.appendChild(this.tint);
  }

  /** Running timers (types, table order). Allocates – tests/debug only. */
  get active(): string[] {
    return this.timers.filter((t) => t.active).map((t) => t.type);
  }

  /** Tint overlay opacity currently shown (0 = hidden). */
  get tintShown(): number {
    return this.shownTint;
  }

  setSource(source: PowerUpTimerSource | null): void {
    this.source = source;
  }

  configure(reduceFlashing: boolean): void {
    this.reduced = reduceFlashing;
  }

  /** powerup:collected: timed ones (duration > 0) start / refresh their timer. */
  onCollected(type: string, duration: number): void {
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    const t = this.timers.find((x) => x.type === type);
    if (!t) return;
    const fresh = !t.active;
    t.active = true;
    t.left = duration;
    t.full = duration;
    t.leaving = -1;
    t.el.hidden = false;
    t.el.classList.remove('is-leaving');
    // Pop on start and on refresh (the ring jumps back to full).
    t.phase = restartAnim(t.el, 'is-in', t.phase);
    if (fresh) {
      t.shownFraction = -1;
      t.shownSeconds = -1;
    }
    this.el.hidden = false;
  }

  onExpired(type: string): void {
    const t = this.timers.find((x) => x.type === type);
    if (!t || !t.active) return;
    this.endTimer(t);
  }

  /** Nuke collected: a short full-screen flash (dimmer and slower with reduced flashing). */
  nukeFlash(): void {
    this.flashLeft = this.reduced ? PU.reducedNukeFlashSeconds : PU.nukeFlashSeconds;
    this.flash.classList.toggle('is-reduced', this.reduced);
    this.flash.style.setProperty('--flash-dur', `${this.flashLeft}s`);
    this.flash.hidden = false;
    this.flashPhase = restartAnim(this.flash, 'is-on', this.flashPhase);
  }

  /** Slow-motion tint 0..1 (PowerUpSystem fx.timeTint, eased there). */
  setTint(amount: number): void {
    const q = PU.tintQuantum;
    const a = Number.isFinite(amount) ? Math.round(Math.min(1, Math.max(0, amount)) / q) * q : 0;
    if (a === this.shownTint) return;
    this.shownTint = a;
    this.tint.hidden = a <= 0;
    if (a > 0) this.tint.style.opacity = a.toFixed(2);
  }

  update(dt: number): void {
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) this.flash.hidden = true;
    }
    let any = false;
    for (const t of this.timers) {
      if (t.leaving >= 0) {
        t.leaving -= dt;
        if (t.leaving < 0) t.el.hidden = true;
        else any = true;
        continue;
      }
      if (!t.active) continue;
      any = true;
      const src = this.source;
      if (src) {
        t.left = src.remaining(t.type);
        const full = src.duration(t.type);
        if (full > 0) t.full = full;
      } else if (dt > 0) {
        t.left = Math.max(0, t.left - dt);
      }
      this.renderTimer(t);
      // Safety net: the expiry event is authoritative, but a timer at 0 never lingers.
      if (!src && t.left <= 0) this.endTimer(t);
    }
    if (!any && !this.el.hidden) this.el.hidden = true;
  }

  reset(): void {
    for (const t of this.timers) {
      t.active = false;
      t.leaving = -1;
      t.el.hidden = true;
      t.el.classList.remove('is-leaving', 'is-ending');
      t.ending = false;
    }
    this.el.hidden = true;
    this.flashLeft = 0;
    this.flash.hidden = true;
    this.setTint(0);
  }

  dispose(): void {
    this.tint.remove();
  }

  private renderTimer(t: TimerView): void {
    const r = timerRing(t.left, t.full, PU.warnSeconds, _ring);
    if (
      Math.abs(r.fraction - t.shownFraction) >= PU.ringQuantum ||
      (r.fraction === 0) !== (t.shownFraction === 0)
    ) {
      t.shownFraction = r.fraction;
      t.fill.setAttribute('stroke-dashoffset', (RING_C * (1 - r.fraction)).toFixed(2));
    }
    if (r.seconds !== t.shownSeconds) {
      t.shownSeconds = r.seconds;
      setText(t.time, String(r.seconds));
    }
    if (r.ending !== t.ending) {
      t.ending = r.ending;
      t.el.classList.toggle('is-ending', r.ending);
    }
  }

  private endTimer(t: TimerView): void {
    t.active = false;
    t.ending = false;
    t.el.classList.remove('is-ending');
    t.el.classList.add('is-leaving');
    t.leaving = PU.removeSeconds;
  }
}
