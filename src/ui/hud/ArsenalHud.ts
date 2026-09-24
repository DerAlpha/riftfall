/**
 * Arsenal HUD (M5, bottom left, between the perk row and the vitals): the equipped ability as an
 * icon in a cooldown ring and the selected grenade type with its count, plus the full-screen
 * overlays of running abilities (Phasenbarriere shield shimmer, Überladung heat, Chronofeld time
 * tint). Plain DOM like the other widgets: built once, patched when a shown value changes.
 *
 * Ability ring: ready = full ring that breathes (ability:ready flashes it), running = the effect's
 * time left in full colour, cooling down = the refill in a dim colour with the seconds left.
 * Grenade chip: glyph in the type's colour, count, one pip per grenade up to the max, a wind-up
 * bar while a throw is primed; grenade:thrown pops it, an empty press shakes it (deny()).
 * Key caps show the first binding of 'ability' / 'grenade' for the active device.
 *
 * Events: grenade:changed, grenade:thrown, ability:used, ability:ready, ability:ended,
 * player:damaged (shield hit flash), input:deviceChanged + controls settings (key caps). Per frame
 * (update) it reads the sources (setSources) for the ring and the wind-up.
 */
import type { SettingsStore } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { ABILITY_GLYPHS, abilityCssColor, getAbilityDef, type AbilityDef } from '../../defs/abilities';
import { GRENADE_GLYPHS, getGrenadeDef, grenadeCssColor } from '../../defs/grenades';
import type { Action, BindingMap } from '../../defs/input';
import { ECONOMY_HUD } from '../../defs/ui';
import { bindingLabel, familyBindings } from '../../input/bindings';
import { glyphIcon, h, restartAnim, setText, svgEl } from './dom';
import './hud-arsenal.css';

/** Ring radius in its 48×48 view box. */
const RING_R = 21;
const RING_C = 2 * Math.PI * RING_R;
/** Ring changes smaller than this (fraction) are not written. */
const RING_QUANTUM = 0.004;
/** Most grenade pips shown. */
const MAX_PIPS = 6;

/** What the widget reads per frame of the ability system (AbilitySystem fits). */
export interface ArsenalAbilitySource {
  readonly equippedDef: AbilityDef | null;
  readonly cooldownLeft: number;
  readonly cooldown: number;
  readonly active: boolean;
  readonly activeTimeLeft: number;
  readonly activeDuration: number;
}

/** What the widget reads per frame of the grenade system (GrenadeSystem fits). */
export interface ArsenalGrenadeSource {
  readonly primeAmount: number;
}

type RingState = 'ready' | 'active' | 'cooling' | 'none';

export class ArsenalHud {
  readonly el: HTMLDivElement;
  private readonly ability: HTMLDivElement;
  private readonly abilityFill: SVGCircleElement;
  private readonly abilityGlyph: SVGPathElement;
  private readonly abilityTime: HTMLSpanElement;
  private readonly abilityKey: HTMLSpanElement;
  private readonly grenade: HTMLDivElement;
  private readonly grenadeGlyph: SVGPathElement;
  private readonly grenadeCount: HTMLSpanElement;
  private readonly grenadePips: HTMLElement[] = [];
  private readonly grenadeKey: HTMLSpanElement;
  private readonly prime: HTMLDivElement;
  private readonly primeFill: HTMLDivElement;
  private readonly overlay: HTMLDivElement;

  private abilitySource: ArsenalAbilitySource | null = null;
  private grenadeSource: ArsenalGrenadeSource | null = null;
  private bindings: BindingMap | null;
  private device: 'kbm' | 'gamepad' = 'kbm';

  // shown state
  private shownAbility: string | null | undefined = undefined;
  private ringState: RingState = 'none';
  private shownFraction = -1;
  private shownSeconds = -1;
  private shownPrime = -1;
  private shownGrenade = '';
  private shownCount = -1;
  private shownMax = -1;
  private overlayFx: string | null = null;
  private readonly phases = {
    abFlash: false,
    abUse: false,
    grPop: false,
    deny: false,
    shieldHit: false,
    overlayIn: false,
  };
  private readonly unsubs: (() => void)[] = [];

  /** `corner`: the HUD's bottom-left corner; `layer`: the HUD root (full-screen overlays). */
  constructor(
    corner: HTMLElement,
    layer: HTMLElement,
    events: EventBus<GameEvents>,
    settings: SettingsStore,
  ) {
    this.el = h('div', 'hud-arsenal');

    // --- ability: icon in a cooldown ring ---
    this.ability = h('div', 'hud-ab', this.el);
    const ring = svgEl(
      'svg',
      { class: 'hud-ab__ring', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
      this.ability,
    );
    svgEl('circle', { class: 'hud-ab__track', cx: 24, cy: 24, r: RING_R }, ring);
    this.abilityFill = svgEl(
      'circle',
      { class: 'hud-ab__fill', cx: 24, cy: 24, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2) },
      ring,
    );
    this.abilityGlyph = glyphIcon('hud-ab__glyph', this.ability);
    this.abilityTime = h('span', 'hud-ab__time', this.ability);
    this.abilityKey = h('span', 'hud-arsenal__key', this.ability);
    this.ability.hidden = true;

    // --- grenade: glyph chip, count + pips, wind-up bar ---
    this.grenade = h('div', 'hud-gr', this.el);
    const chip = h('div', 'hud-gr__chip', this.grenade);
    this.grenadeGlyph = glyphIcon('hud-gr__glyph', chip);
    const info = h('div', 'hud-gr__info', this.grenade);
    this.grenadeCount = h('span', 'hud-gr__count', info);
    const pips = h('div', 'hud-gr__pips', info);
    for (let i = 0; i < MAX_PIPS; i++) {
      const pip = h('i', 'hud-gr__pip', pips);
      pip.hidden = true;
      this.grenadePips.push(pip);
    }
    this.grenadeKey = h('span', 'hud-arsenal__key', this.grenade);
    this.prime = h('div', 'hud-gr__prime', this.grenade);
    this.primeFill = h('div', 'hud-gr__primefill', this.prime);
    this.prime.hidden = true;
    this.grenade.hidden = true;

    // Right below the perk row (EconomyHud prepends it), above the dash pips and the vitals.
    const perks = corner.querySelector('.hud-perks');
    corner.insertBefore(this.el, perks ? perks.nextSibling : corner.firstChild);

    // --- full-screen ability overlay (first in the layer: below the crosshair and prompts) ---
    this.overlay = h('div', 'hud-abfx');
    this.overlay.hidden = true;
    layer.prepend(this.overlay);

    this.bindings = settings.current.controls.bindings;
    this.refreshKeys();

    this.unsubs.push(
      events.on('grenade:changed', (e) => this.setGrenade(e.grenadeId, e.count, e.max)),
      events.on('grenade:thrown', () => {
        this.phases.grPop = restartAnim(this.grenade, 'is-pop', this.phases.grPop);
      }),
      events.on('ability:used', (e) => this.onAbilityUsed(e.abilityId, e.duration)),
      events.on('ability:ready', () => {
        this.phases.abFlash = restartAnim(this.ability, 'is-flash', this.phases.abFlash);
      }),
      events.on('ability:ended', () => this.setOverlay(null)),
      events.on('player:damaged', () => {
        if (this.overlayFx === 'shield') {
          this.phases.shieldHit = restartAnim(this.overlay, 'is-hit', this.phases.shieldHit);
        }
      }),
      events.on('input:deviceChanged', (e) => {
        this.device = e.device;
        this.refreshKeys();
      }),
      events.on('settings:changed', ({ settings: s, sections }) => {
        if (!sections.includes('controls')) return;
        this.bindings = s.controls.bindings;
        this.refreshKeys();
      }),
    );
  }

  /** Per-frame sources: the ability ring and the grenade wind-up. */
  setSources(abilities: ArsenalAbilitySource | null, grenades: ArsenalGrenadeSource | null): void {
    this.abilitySource = abilities;
    this.grenadeSource = grenades;
    this.shownFraction = -1;
    this.shownSeconds = -1;
  }

  setInputDevice(device: 'kbm' | 'gamepad'): void {
    if (device === this.device) return;
    this.device = device;
    this.refreshKeys();
  }

  /** A press with nothing to throw / an ability still cooling down: shake the widget red. */
  deny(what: 'grenade' | 'ability'): void {
    const el = what === 'grenade' ? this.grenade : this.ability;
    if (el.hidden) return;
    this.phases.deny = restartAnim(el, 'is-deny', this.phases.deny);
  }

  configure(reduceFlashing: boolean): void {
    this.el.classList.toggle('is-reduced', reduceFlashing);
    this.overlay.classList.toggle('is-reduced', reduceFlashing);
  }

  update(_dt: number): void {
    this.updateAbility();
    this.updatePrime();
  }

  /** New run: overlays off, shown values re-read. */
  reset(): void {
    this.setOverlay(null);
    this.shownFraction = -1;
    this.shownSeconds = -1;
    this.shownAbility = undefined;
    this.ringState = 'none';
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
    this.overlay.remove();
  }

  /** Overlay shown (tests / debug): the running ability's `screen` fx or null. */
  get overlayShown(): string | null {
    return this.overlayFx;
  }

  // -------------------------------------------------------------------------

  private setGrenade(id: string, count: number, max: number): void {
    const def = getGrenadeDef(id);
    if (!def) {
      this.grenade.hidden = true;
      return;
    }
    this.grenade.hidden = false;
    if (id !== this.shownGrenade) {
      this.shownGrenade = id;
      this.grenade.style.setProperty('--gr', grenadeCssColor(def));
      this.grenadeGlyph.setAttribute('d', GRENADE_GLYPHS[def.icon] ?? '');
      this.grenade.dataset.grenade = id;
    }
    if (count !== this.shownCount || max !== this.shownMax) {
      this.shownCount = count;
      this.shownMax = max;
      setText(this.grenadeCount, String(Math.max(0, count)));
      const pips = Math.min(MAX_PIPS, Math.max(0, max));
      for (let i = 0; i < this.grenadePips.length; i++) {
        const pip = this.grenadePips[i]!;
        pip.hidden = i >= pips;
        pip.classList.toggle('is-full', i < count);
      }
      this.grenade.classList.toggle('is-empty', count <= 0);
    }
  }

  private onAbilityUsed(id: string, duration: number): void {
    this.phases.abUse = restartAnim(this.ability, 'is-used', this.phases.abUse);
    const def = getAbilityDef(id);
    if (def && duration > 0) this.setOverlay(def.screen);
  }

  private setOverlay(fx: string | null): void {
    if (fx === this.overlayFx) return;
    if (this.overlayFx) this.overlay.classList.remove(`hud-abfx--${this.overlayFx}`);
    this.overlayFx = fx;
    if (fx) {
      this.overlay.classList.add(`hud-abfx--${fx}`);
      this.overlay.hidden = false;
      this.phases.overlayIn = restartAnim(this.overlay, 'is-in', this.phases.overlayIn);
    } else {
      this.overlay.hidden = true;
      this.overlay.classList.remove('is-hit-a', 'is-hit-b');
    }
  }

  private updateAbility(): void {
    const src = this.abilitySource;
    const def = src?.equippedDef ?? null;
    const id = def?.id ?? null;
    if (id !== this.shownAbility) {
      this.shownAbility = id;
      this.ability.hidden = def === null;
      if (def) {
        this.ability.style.setProperty('--ab', abilityCssColor(def));
        this.abilityGlyph.setAttribute('d', ABILITY_GLYPHS[def.icon] ?? '');
        this.ability.dataset.ability = def.id;
      }
      this.ringState = 'none';
      this.shownFraction = -1;
    }
    if (!src || !def) return;
    let state: RingState;
    let fraction: number;
    let seconds = -1;
    if (src.active && src.activeDuration > 0) {
      state = 'active';
      fraction = src.activeTimeLeft / src.activeDuration;
    } else if (src.cooldownLeft > 0 && src.cooldown > 0) {
      state = 'cooling';
      fraction = 1 - src.cooldownLeft / src.cooldown;
      seconds = Math.ceil(src.cooldownLeft);
    } else {
      state = 'ready';
      fraction = 1;
    }
    if (state !== this.ringState) {
      this.ringState = state;
      this.ability.classList.toggle('is-ready', state === 'ready');
      this.ability.classList.toggle('is-active', state === 'active');
      this.ability.classList.toggle('is-cooling', state === 'cooling');
    }
    const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 1));
    if (Math.abs(f - this.shownFraction) >= RING_QUANTUM || (f === 1 && this.shownFraction !== 1)) {
      this.shownFraction = f;
      this.abilityFill.setAttribute('stroke-dashoffset', (RING_C * (1 - f)).toFixed(2));
    }
    if (seconds !== this.shownSeconds) {
      this.shownSeconds = seconds;
      setText(this.abilityTime, seconds > 0 ? String(seconds) : '');
    }
  }

  private updatePrime(): void {
    const a = this.grenadeSource?.primeAmount ?? 0;
    const v = a > 0 ? Math.round(Math.min(1, a) * 50) / 50 : 0;
    if (v === this.shownPrime) return;
    this.shownPrime = v;
    this.prime.hidden = v <= 0;
    this.primeFill.style.transform = `scaleX(${v.toFixed(2)})`;
    this.grenade.classList.toggle('is-primed', v > 0);
  }

  private refreshKeys(): void {
    setText(this.abilityKey, this.keyLabel('ability'));
    setText(this.grenadeKey, this.keyLabel('grenade'));
    const pad = this.device === 'gamepad';
    this.abilityKey.classList.toggle('is-pad', pad);
    this.grenadeKey.classList.toggle('is-pad', pad);
  }

  private keyLabel(action: Action): string {
    const P = ECONOMY_HUD.prompt;
    const b = familyBindings(this.bindings?.[action] ?? [], this.device === 'gamepad' ? 'pad' : 'kbm')[0];
    if (!b) return P.unbound;
    switch (b.device) {
      case 'key':
        return bindingLabel(b);
      case 'mouse':
        return P.mouseLabels[b.button] ?? `M${b.button + 1}`;
      case 'wheel':
        return P.wheelLabels[b.direction];
      case 'pad':
        return P.padLabels[b.button] ?? String(b.button);
      case 'padAxis':
        return bindingLabel(b).replace(/^Pad /, '');
    }
  }
}
