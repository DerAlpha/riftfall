/**
 * Wave HUD (M3): big wave counter (tally marks for waves 1–5 like chalk strokes on a wall, then a
 * slammed-in numeral), remaining enemies, the intermission countdown ("NÄCHSTE WELLE IN 5") and the
 * wave start / complete banners.
 *
 * Event driven (wave:intermission / start / progress / complete, run:restart, run:over); update(dt)
 * only runs the countdown and banner timers. The DOM is written only when a shown value changes
 * (countdown: once per second). Entry animations are CSS keyframes restarted by alternating two
 * identically shaped animation classes (no forced layout).
 */
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { HUD } from '../../defs/ui';
import './hud-wave.css';

const W = HUD.wave;

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

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

type BannerKind = 'start' | 'complete';

export class WaveHud {
  private readonly counter: HTMLDivElement;
  private readonly display: HTMLDivElement;
  private readonly tally: HTMLDivElement;
  private readonly marks: HTMLSpanElement[] = [];
  private readonly numeral: HTMLSpanElement;
  private readonly remainingWrap: HTMLDivElement;
  private readonly remainingValue: HTMLSpanElement;
  private readonly countdown: HTMLDivElement;
  private readonly countdownValue: HTMLSpanElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerTitle: HTMLDivElement;
  private readonly bannerSub: HTMLDivElement;
  private readonly offs: (() => void)[] = [];

  private shownWave: number | null = null;
  private flip = false;
  private remaining = -1;
  private countdownLeft = 0;
  private countdownActive = false;
  private shownSeconds = -1;
  private urgent = false;
  private bannerLeft = 0;
  private bannerFlip = false;
  private bannerKindClass = '';

  /**
   * `corner`: where the counter goes (top-left HUD corner); `layer`: the HUD root for the
   * centered countdown and banner.
   */
  constructor(corner: HTMLElement, layer: HTMLElement, events: EventBus<GameEvents>) {
    this.counter = h('div', 'hud-wave hud-placeholder', corner);
    h('span', 'hud-label', this.counter).textContent = W.labels.wave;
    this.display = h('div', 'hud-wave__display', this.counter);
    this.tally = h('div', 'hud-wave__tally', this.display);
    for (let i = 0; i < W.tallyMax; i++) {
      const mark = h(
        'span',
        `hud-wave__mark${i === W.tallyMax - 1 ? ' hud-wave__mark--strike' : ''}`,
        this.tally,
      );
      mark.style.setProperty('--i', String(i));
      this.marks.push(mark);
    }
    this.numeral = h('span', 'hud-wave__value', this.display);
    this.numeral.textContent = '—';
    this.tally.hidden = true;
    this.remainingWrap = h('div', 'hud-wave__remaining', this.counter);
    h('span', 'hud-label', this.remainingWrap).textContent = W.labels.remaining;
    this.remainingValue = h('span', 'hud-wave__count', this.remainingWrap);
    this.remainingWrap.hidden = true;

    this.countdown = h('div', 'hud-countdown', layer);
    h('span', 'hud-countdown__label', this.countdown).textContent = W.labels.countdown;
    this.countdownValue = h('span', 'hud-countdown__value', this.countdown);
    this.countdown.hidden = true;

    this.banner = h('div', 'hud-banner', layer);
    this.bannerTitle = h('div', 'hud-banner__title', this.banner);
    this.bannerSub = h('div', 'hud-banner__sub', this.banner);
    this.banner.hidden = true;

    this.offs.push(
      events.on('wave:intermission', (e) => this.startCountdown(e.duration)),
      events.on('wave:start', (e) => {
        this.stopCountdown();
        this.setWave(e.wave);
        this.setRemaining(e.total);
        const sub = e.kind ? (W.kindLabels[e.kind] ?? '') : '';
        this.showBanner('start', `${W.labels.wave} ${e.wave}`, sub, e.kind ?? 'normal');
      }),
      events.on('wave:progress', (e) => this.setRemaining(e.remaining)),
      events.on('wave:complete', (e) => {
        this.setRemaining(-1);
        this.showBanner('complete', `${W.labels.wave} ${e.wave}`, W.labels.complete, 'complete');
      }),
      events.on('run:over', () => {
        this.stopCountdown();
        this.hideBanner();
      }),
      events.on('run:restart', () => this.reset()),
    );
  }

  /** Wave number shown by the counter (null = placeholder). */
  get wave(): number | null {
    return this.shownWave;
  }

  /** Show `wave` (null = placeholder "—"); a change plays the tally / slam animation. */
  setWave(wave: number | null): void {
    const w = wave !== null && Number.isFinite(wave) && wave > 0 ? Math.floor(wave) : null;
    if (w === this.shownWave) return;
    const prev = this.shownWave;
    this.shownWave = w;
    this.counter.classList.toggle('hud-placeholder', w === null);
    const tally = w !== null && w <= W.tallyMax;
    this.tally.hidden = !tally;
    this.numeral.hidden = tally;
    this.flip = !this.flip;
    const fresh = this.flip ? 'is-fresh-a' : 'is-fresh-b';
    const stale = this.flip ? 'is-fresh-b' : 'is-fresh-a';
    if (tally) {
      for (let i = 0; i < this.marks.length; i++) {
        const m = this.marks[i]!;
        m.classList.toggle('is-on', i < w);
        // Only a mark added by this change is drawn in (a jump shows the others at once).
        const drawn = i === w - 1 && (prev === null || prev < w);
        m.classList.toggle(fresh, drawn);
        m.classList.remove(stale);
      }
    } else {
      setText(this.numeral, w === null ? '—' : String(w));
      this.numeral.classList.toggle(fresh, w !== null);
      this.numeral.classList.remove(stale);
    }
  }

  /** Per frame (game time): countdown + banner timers. */
  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.countdownActive) {
      this.countdownLeft = Math.max(0, this.countdownLeft - dt);
      this.writeCountdown();
    }
    if (this.bannerLeft > 0) {
      this.bannerLeft -= dt;
      if (this.bannerLeft <= 0) this.hideBanner();
    }
  }

  reset(): void {
    this.stopCountdown();
    this.hideBanner();
    this.setRemaining(-1);
    this.setWave(null);
    for (const m of this.marks) m.classList.remove('is-on', 'is-fresh-a', 'is-fresh-b');
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.counter.remove();
    this.countdown.remove();
    this.banner.remove();
  }

  // -------------------------------------------------------------------------

  private setRemaining(n: number): void {
    const v = Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
    if (v === this.remaining) return;
    this.remaining = v;
    this.remainingWrap.hidden = v < 0;
    if (v >= 0) setText(this.remainingValue, String(v));
  }

  private startCountdown(duration: number): void {
    this.countdownLeft = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this.countdownActive = true;
    this.shownSeconds = -1;
    this.countdown.hidden = false;
    this.writeCountdown();
  }

  private stopCountdown(): void {
    this.countdownActive = false;
    this.countdown.hidden = true;
    this.setUrgent(false);
  }

  private writeCountdown(): void {
    const s = Math.ceil(this.countdownLeft);
    if (s === this.shownSeconds) return;
    this.shownSeconds = s;
    setText(this.countdownValue, String(s));
    this.setUrgent(s <= W.countdownUrgentSeconds);
    // Every second in the urgent phase ticks (alternating classes restart the pulse).
    if (this.urgent) {
      const odd = s % 2 === 1;
      this.countdownValue.classList.toggle('is-tick-a', odd);
      this.countdownValue.classList.toggle('is-tick-b', !odd);
    }
  }

  private setUrgent(urgent: boolean): void {
    if (urgent === this.urgent) return;
    this.urgent = urgent;
    this.countdown.classList.toggle('is-urgent', urgent);
    if (!urgent) this.countdownValue.classList.remove('is-tick-a', 'is-tick-b');
  }

  private showBanner(kind: BannerKind, title: string, sub: string, variant: string): void {
    setText(this.bannerTitle, title);
    setText(this.bannerSub, sub);
    this.bannerSub.hidden = sub === '';
    const kindClass = `hud-banner--${variant.replace(/[^a-z0-9-]/gi, '')}`;
    if (kindClass !== this.bannerKindClass) {
      if (this.bannerKindClass) this.banner.classList.remove(this.bannerKindClass);
      this.banner.classList.add(kindClass);
      this.bannerKindClass = kindClass;
    }
    const seconds = kind === 'start' ? W.bannerStartSeconds : W.bannerCompleteSeconds;
    this.banner.style.setProperty('--banner-dur', `${seconds}s`);
    this.bannerFlip = !this.bannerFlip;
    this.banner.classList.toggle('is-in-a', this.bannerFlip);
    this.banner.classList.toggle('is-in-b', !this.bannerFlip);
    this.banner.hidden = false;
    this.bannerLeft = seconds;
  }

  private hideBanner(): void {
    this.bannerLeft = 0;
    this.banner.hidden = true;
  }
}
