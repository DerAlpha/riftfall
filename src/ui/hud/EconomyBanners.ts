/**
 * Economy banners (center, the wave banner's slot – CSS moves them below a visible wave banner):
 * zone unlocked, perk acquired (name + slogan in its neon colour), power-up collected (German
 * name), box result, Phoenix revive. One at a time through BannerQueue; the DOM is rewritten only
 * when the queue's current banner changes. Entry/exit are CSS keyframes over `--eb-dur`.
 */
import { glyphIcon, h, restartAnim, setText } from './dom';
import { BannerQueue, type EconomyBanner } from './economyModel';

export class EconomyBanners {
  readonly queue = new BannerQueue();
  readonly el: HTMLDivElement;
  private readonly kicker: HTMLDivElement;
  private readonly glyph: SVGPathElement;
  private readonly glyphSvg: SVGSVGElement;
  private readonly title: HTMLSpanElement;
  private readonly sub: HTMLDivElement;
  private shownVersion = 0;
  private shown: EconomyBanner | null = null;
  private kindClass = '';
  private phase = false;

  constructor(layer: HTMLElement) {
    this.el = h('div', 'hud-ebanner', layer);
    this.kicker = h('div', 'hud-ebanner__kicker', this.el);
    const titleRow = h('div', 'hud-ebanner__title', this.el);
    this.glyph = glyphIcon('hud-ebanner__glyph', titleRow);
    this.glyphSvg = this.glyph.ownerSVGElement!;
    this.title = h('span', 'hud-ebanner__text', titleRow);
    this.sub = h('div', 'hud-ebanner__sub', this.el);
    this.el.hidden = true;
  }

  /** Banner on screen (null = none). */
  get current(): EconomyBanner | null {
    return this.queue.current;
  }

  push(b: EconomyBanner): void {
    this.queue.push(b);
    this.render();
  }

  update(dt: number): void {
    this.queue.update(dt);
    this.render();
  }

  reset(): void {
    this.queue.clear();
    this.render();
  }

  private render(): void {
    if (this.queue.version === this.shownVersion) return;
    this.shownVersion = this.queue.version;
    const b = this.queue.current;
    if (!b) {
      this.shown = null;
      this.el.hidden = true;
      return;
    }
    const fresh = b !== this.shown;
    this.shown = b;
    setText(this.kicker, b.kicker);
    this.kicker.hidden = b.kicker === '';
    setText(this.title, b.title);
    setText(this.sub, b.sub);
    this.sub.hidden = b.sub === '';
    if (b.glyph) this.glyph.setAttribute('d', b.glyph);
    this.glyphSvg.style.display = b.glyph ? '' : 'none';
    const kind = `hud-ebanner--${b.kind}`;
    if (kind !== this.kindClass) {
      if (this.kindClass) this.el.classList.remove(this.kindClass);
      this.el.classList.add(kind);
      this.kindClass = kind;
    }
    if (!fresh) return;
    this.el.style.setProperty('--eb', b.color);
    this.el.style.setProperty('--eb-dur', `${b.seconds}s`);
    this.el.hidden = false;
    this.phase = restartAnim(this.el, 'is-in', this.phase);
  }
}
