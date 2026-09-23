/**
 * In-game HUD (plain DOM, no framework). All per-frame setters compare against cached values and
 * only touch the DOM when something visible changed; animated values are written as transforms /
 * opacity so the browser can composite them without layout.
 */
import type { SettingsStore } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents, MovementState, Vec3Like } from '../../core/events';
import { DEG2RAD, RAD2DEG, clamp01, lerp, wrapAngle } from '../../core/math';
import { PLAYER } from '../../defs/player';
import { HUD } from '../../defs/ui';
import type { Settings } from '../../save/settingsSchema';

const CROSSHAIR_STYLES = ['dot', 'cross', 'circle', 'chevron'] as const;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLORBLIND_CLASSES = ['cb-protanopia', 'cb-deuteranopia', 'cb-tritanopia'] as const;

const STATE_LABELS: Readonly<Record<MovementState, string>> = {
  ground: 'LAUFEN',
  air: 'LUFT',
  slide: 'RUTSCHEN',
  dash: 'DASH',
  mantle: 'KLETTERN',
  noclip: 'NOCLIP',
};

interface DamageIndicator {
  el: HTMLDivElement;
  /** World-space angle (atan2(x, z)) of the direction towards the damage source. */
  worldAngle: number;
  age: number;
  strength: number;
  active: boolean;
  shownRotation: number;
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

export class Hud {
  private readonly el: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly hitVignette: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthTrail: HTMLDivElement;
  private readonly healthValue: HTMLSpanElement;
  private readonly healthBar: HTMLDivElement;
  private readonly armorFill: HTMLDivElement;
  private readonly armorTrail: HTMLDivElement;
  private readonly armorValue: HTMLSpanElement;
  private readonly dashWrap: HTMLDivElement;
  private readonly dashPips: { el: HTMLDivElement; fill: HTMLDivElement }[] = [];
  private readonly movementEl: HTMLDivElement;
  private readonly movementSpeed: HTMLSpanElement;
  private readonly movementState: HTMLSpanElement;
  private readonly fpsEl: HTMLDivElement;
  private readonly ammoMag: HTMLSpanElement;
  private readonly ammoReserve: HTMLSpanElement;
  private readonly pointsValue: HTMLSpanElement;
  private readonly waveValue: HTMLSpanElement;
  private readonly indicators: DamageIndicator[] = [];

  // cached shown values
  private spread = -1;
  private health = -1;
  private maxHealth = -1;
  private armor = -1;
  private maxArmor = -1;
  private lowHealth = false;
  private dashCharges = -1;
  private dashMax = -1;
  private dashProgress = -1;
  private flash = 0;
  private shownFlash = -1;
  private movementVisible: boolean = HUD.movementReadout.defaultVisible;
  /** The readout stays hidden until setMovement() delivered data (never shows a stale "0.0 m/s"). */
  private movementFed = false;
  private movementTimer = 0;
  private shownSpeed = '';
  private shownState: MovementState | null = null;
  private pendingSpeed = 0;
  private pendingState: MovementState = 'ground';
  private fpsVisible = false;
  private fpsFrames = 0;
  private fpsTime = 0;
  private lastFrameAt = -1;
  private reduceFlashing = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(root: HTMLElement, events: EventBus<GameEvents>, settings: SettingsStore) {
    this.el = h('div', 'hud');
    this.el.setAttribute('aria-hidden', 'true');

    // --- crosshair ---
    this.crosshair = h('div', 'hud-crosshair', this.el);
    h('span', 'xh-dot', this.crosshair);
    for (const side of ['t', 'r', 'b', 'l']) h('span', `xh-line xh-line--${side}`, this.crosshair);
    h('span', 'xh-ring', this.crosshair);
    h('span', 'xh-chevron', this.crosshair);

    // --- damage direction indicators ---
    const dmg = h('div', 'hud-damage', this.el);
    for (let i = 0; i < HUD.damageIndicator.slots; i++) {
      const el = h('div', 'hud-damage__arc', dmg);
      el.style.opacity = '0';
      this.indicators.push({
        el,
        worldAngle: 0,
        age: 0,
        strength: 0,
        active: false,
        shownRotation: NaN,
        shownOpacity: 0,
      });
    }
    this.hitVignette = h('div', 'hud-hit', this.el);
    this.hitVignette.style.opacity = '0';

    // --- top left: wave ---
    const tl = h('div', 'hud-corner hud-corner--tl', this.el);
    const wave = h('div', 'hud-wave hud-placeholder', tl);
    h('span', 'hud-label', wave).textContent = 'WELLE';
    this.waveValue = h('span', 'hud-wave__value', wave);
    this.waveValue.textContent = '—';

    // --- top right: fps ---
    const tr = h('div', 'hud-corner hud-corner--tr', this.el);
    this.fpsEl = h('div', 'hud-fps', tr);
    this.fpsEl.hidden = true;

    // --- bottom left: dash + vitals ---
    const bl = h('div', 'hud-corner hud-corner--bl', this.el);
    this.dashWrap = h('div', 'hud-dash', bl);
    h('span', 'hud-label', this.dashWrap).textContent = 'DASH';
    const pipRow = h('div', 'hud-dash__pips', this.dashWrap);
    for (let i = 0; i < HUD.dash.maxPips; i++) {
      const el = h('div', 'hud-dash__pip', pipRow);
      const fill = h('div', 'hud-dash__fill', el);
      el.hidden = true;
      this.dashPips.push({ el, fill });
    }
    this.dashWrap.hidden = true;

    const vitals = h('div', 'hud-vitals', bl);
    const armorBar = h('div', 'hud-bar hud-bar--armor', vitals);
    h('span', 'hud-label', armorBar).textContent = 'RÜSTUNG';
    const armorTrack = h('div', 'hud-bar__track', armorBar);
    this.armorTrail = h('div', 'hud-bar__trail', armorTrack);
    this.armorFill = h('div', 'hud-bar__fill', armorTrack);
    this.armorValue = h('span', 'hud-bar__value', armorBar);

    this.healthBar = h('div', 'hud-bar hud-bar--health', vitals);
    h('span', 'hud-label', this.healthBar).textContent = 'VITAL';
    const healthTrack = h('div', 'hud-bar__track', this.healthBar);
    this.healthTrail = h('div', 'hud-bar__trail', healthTrack);
    this.healthFill = h('div', 'hud-bar__fill', healthTrack);
    this.healthValue = h('span', 'hud-bar__value', this.healthBar);

    // --- bottom right: points + ammo (placeholders in M1) ---
    const br = h('div', 'hud-corner hud-corner--br', this.el);
    const points = h('div', 'hud-points hud-placeholder', br);
    h('span', 'hud-label', points).textContent = 'PUNKTE';
    this.pointsValue = h('span', 'hud-points__value', points);
    this.pointsValue.textContent = '—';
    const ammo = h('div', 'hud-ammo hud-placeholder', br);
    this.ammoMag = h('span', 'hud-ammo__mag', ammo);
    this.ammoMag.textContent = '—';
    h('span', 'hud-ammo__sep', ammo).textContent = '/';
    this.ammoReserve = h('span', 'hud-ammo__reserve', ammo);
    this.ammoReserve.textContent = '—';

    // --- bottom center: movement readout ---
    this.movementEl = h('div', 'hud-movement', this.el);
    this.movementSpeed = h('span', 'hud-movement__speed', this.movementEl);
    this.movementState = h('span', 'hud-movement__state', this.movementEl);
    this.movementEl.hidden = true;

    root.appendChild(this.el);

    this.applySettings(settings.current);
    this.setSpread(0);
    // Start values until the first player:healthChanged arrives (PlayerHealth.announce()).
    const ph = PLAYER.health;
    this.setHealth(ph.startHealth, ph.maxHealth, ph.startArmor, ph.maxArmor);

    this.unsubs.push(
      events.on('settings:changed', ({ settings: s, sections }) => {
        if (
          sections.includes('gameplay') ||
          sections.includes('accessibility') ||
          sections.includes('graphics')
        ) {
          this.applySettings(s);
        }
      }),
      events.on('player:healthChanged', ({ health, maxHealth, armor, maxArmor }) =>
        this.setHealth(health, maxHealth, armor, maxArmor),
      ),
      events.on('player:damaged', ({ amount, direction }) => this.onDamaged(amount, direction)),
      events.on('ui:menu', ({ open }) => this.el.classList.toggle('hud--menu', open)),
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Crosshair spread 0..1 (weapon bloom / movement). */
  setSpread(spread: number): void {
    const s = clamp01(Number.isFinite(spread) ? spread : 0);
    if (Math.abs(s - this.spread) < HUD.crosshair.spreadQuantum && this.spread >= 0) return;
    this.spread = s;
    const px = lerp(HUD.crosshair.spreadMinPx, HUD.crosshair.spreadMaxPx, s);
    this.crosshair.style.setProperty('--xh-spread', `${px.toFixed(1)}px`);
  }

  /** Dash charges; `max` 0 hides the widget (dash locked). `progress` 0..1 of the next charge. */
  setDash(charges: number, max: number, progress: number): void {
    const m = Math.max(0, Math.min(HUD.dash.maxPips, Math.floor(max)));
    const c = Math.max(0, Math.min(m, Math.floor(charges)));
    const q = HUD.dash.progressQuantum;
    const p = c >= m ? 1 : Math.round(clamp01(progress) / q) * q;
    if (m !== this.dashMax) {
      this.dashMax = m;
      this.dashWrap.hidden = m === 0;
      for (let i = 0; i < this.dashPips.length; i++) this.dashPips[i]!.el.hidden = i >= m;
      this.dashCharges = -1;
    }
    if (c === this.dashCharges && p === this.dashProgress) return;
    const chargesChanged = c !== this.dashCharges;
    this.dashCharges = c;
    this.dashProgress = p;
    for (let i = 0; i < m; i++) {
      const pip = this.dashPips[i]!;
      if (chargesChanged) {
        pip.el.classList.toggle('is-full', i < c);
        pip.el.classList.toggle('is-charging', i === c);
      }
      if (i === c || chargesChanged) {
        const fill = i < c ? 1 : i === c ? p : 0;
        pip.fill.style.transform = `scaleX(${fill.toFixed(3)})`;
      }
    }
  }

  /** Movement readout values (throttled internally; call every frame). */
  setMovement(speed: number, state: MovementState): void {
    this.pendingSpeed = speed;
    this.pendingState = state;
    if (!this.movementFed) {
      this.movementFed = true;
      this.movementTimer = Number.POSITIVE_INFINITY; // show the first values on the next update
      this.movementEl.hidden = !this.movementVisible;
    }
  }

  setMovementReadoutVisible(visible: boolean): void {
    this.movementVisible = visible;
    this.movementEl.hidden = !(visible && this.movementFed);
    if (visible) this.movementTimer = Number.POSITIVE_INFINITY;
  }

  get movementReadoutVisible(): boolean {
    return this.movementVisible;
  }

  /** M2+: ammo in magazine / reserve (null shows the placeholder). */
  setAmmo(mag: number | null, reserve: number | null): void {
    this.setPlaceholderText(this.ammoMag, mag === null ? '—' : String(mag));
    this.setPlaceholderText(this.ammoReserve, reserve === null ? '—' : String(reserve));
    this.ammoMag.parentElement?.classList.toggle('hud-placeholder', mag === null);
  }

  /** M4+: points (null shows the placeholder). */
  setPoints(points: number | null): void {
    this.setPlaceholderText(this.pointsValue, points === null ? '—' : points.toLocaleString('de-DE'));
    this.pointsValue.parentElement?.classList.toggle('hud-placeholder', points === null);
  }

  /** M3+: wave number (null shows the placeholder). */
  setWave(wave: number | null): void {
    this.setPlaceholderText(this.waveValue, wave === null ? '—' : String(wave));
    this.waveValue.parentElement?.classList.toggle('hud-placeholder', wave === null);
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  /** Per frame: animates hit flash + damage indicators (relative to `cameraYaw`), refreshes readouts. */
  update(dt: number, cameraYaw: number): void {
    const d = dt > 0 && Number.isFinite(dt) ? dt : 0;
    this.updateFlash(d);
    this.updateIndicators(d, Number.isFinite(cameraYaw) ? cameraYaw : 0);
    this.updateMovement(d);
    this.updateFps();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private setPlaceholderText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  private applySettings(s: Readonly<Settings>): void {
    const g = s.gameplay;
    const style = (CROSSHAIR_STYLES as readonly string[]).includes(g.crosshair) ? g.crosshair : 'cross';
    for (const st of CROSSHAIR_STYLES) this.crosshair.classList.toggle(`xh--${st}`, st === style);
    const color = COLOR_RE.test(g.crosshairColor) ? g.crosshairColor : HUD.crosshair.defaultColor;
    this.crosshair.style.setProperty('--xh-color', color);

    const a = s.accessibility;
    const scale = Number.isFinite(a.hudScale) && a.hudScale > 0 ? a.hudScale : 1;
    this.el.style.setProperty('--hud-scale', String(scale));
    this.reduceFlashing = a.reduceFlashing;
    this.el.classList.toggle('hud--reduce-flashing', a.reduceFlashing);
    for (const cls of COLORBLIND_CLASSES) this.el.classList.toggle(cls, cls === `cb-${a.colorblindMode}`);

    const showFps = s.graphics.showFps;
    if (showFps !== this.fpsVisible) {
      this.fpsVisible = showFps;
      this.fpsEl.hidden = !showFps;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      this.lastFrameAt = -1;
    }
  }

  private setHealth(health: number, maxHealth: number, armor: number, maxArmor: number): void {
    const hp = Math.max(0, health);
    const ap = Math.max(0, armor);
    if (hp !== this.health || maxHealth !== this.maxHealth) {
      this.health = hp;
      this.maxHealth = maxHealth;
      const f = maxHealth > 0 ? clamp01(hp / maxHealth) : 0;
      const t = `scaleX(${f.toFixed(4)})`;
      this.healthFill.style.transform = t;
      this.healthTrail.style.transform = t;
      this.setPlaceholderText(this.healthValue, String(Math.ceil(hp)));
      const low = f < HUD.lowHealthFraction;
      if (low !== this.lowHealth) {
        this.lowHealth = low;
        this.healthBar.classList.toggle('is-low', low);
        this.el.classList.toggle('hud--low-health', low);
      }
    }
    if (ap !== this.armor || maxArmor !== this.maxArmor) {
      this.armor = ap;
      this.maxArmor = maxArmor;
      const f = maxArmor > 0 ? clamp01(ap / maxArmor) : 0;
      const t = `scaleX(${f.toFixed(4)})`;
      this.armorFill.style.transform = t;
      this.armorTrail.style.transform = t;
      this.setPlaceholderText(this.armorValue, String(Math.ceil(ap)));
      this.armorFill.parentElement?.parentElement?.classList.toggle('is-empty', ap <= 0);
    }
  }

  private onDamaged(amount: number, direction: Vec3Like | undefined): void {
    const cfg = HUD.hitFlash;
    const max = this.reduceFlashing ? cfg.reducedMax : cfg.max;
    this.flash = Math.min(max, Math.max(this.flash, 0) + Math.max(0, amount) * cfg.perDamage);
    if (!direction) return;
    const len = Math.hypot(direction.x, direction.z);
    if (!(len > 1e-6)) return;
    const worldAngle = Math.atan2(direction.x, direction.z);
    const di = HUD.damageIndicator;
    const strength = clamp01(amount / di.fullAmount);
    // Refresh an indicator pointing the same way, else reuse the oldest / a free one.
    let slot: DamageIndicator | null = null;
    let oldest: DamageIndicator | null = null;
    for (const ind of this.indicators) {
      if (ind.active && Math.abs(wrapAngle(ind.worldAngle - worldAngle)) < di.mergeAngleDeg * DEG2RAD) {
        slot = ind;
        break;
      }
      if (!ind.active && !slot) slot = ind;
      if (!oldest || ind.age > oldest.age) oldest = ind;
    }
    const target = slot ?? oldest!;
    target.strength = target.active ? Math.max(target.strength, strength) : strength;
    target.worldAngle = worldAngle;
    target.age = 0;
    target.active = true;
  }

  private updateFlash(dt: number): void {
    if (this.flash <= 0 && this.shownFlash === 0) return;
    const cfg = HUD.hitFlash;
    const decay = this.reduceFlashing ? cfg.reducedDecayPerSecond : cfg.decayPerSecond;
    this.flash = Math.max(0, this.flash - decay * dt);
    const v = this.flash < cfg.epsilon ? 0 : this.flash;
    if (Math.abs(v - this.shownFlash) >= cfg.epsilon || (v === 0 && this.shownFlash !== 0)) {
      this.shownFlash = v;
      this.hitVignette.style.opacity = v.toFixed(3);
    }
  }

  private updateIndicators(dt: number, cameraYaw: number): void {
    const di = HUD.damageIndicator;
    // Camera forward is (-sin yaw, 0, -cos yaw); its atan2(x, z) is yaw + PI.
    const forwardAngle = cameraYaw + Math.PI;
    for (const ind of this.indicators) {
      if (!ind.active) continue;
      ind.age += dt;
      let opacity = 0;
      if (ind.age >= di.durationSeconds) {
        ind.active = false;
      } else {
        const fadeStart = di.durationSeconds - di.fadeSeconds;
        const fade = ind.age <= fadeStart ? 1 : 1 - (ind.age - fadeStart) / di.fadeSeconds;
        opacity = lerp(di.minOpacity, 1, ind.strength) * fade;
      }
      // Screen angle clockwise from "up": positive yaw turns left, so the relative angle is negated.
      const rel = -wrapAngle(ind.worldAngle - forwardAngle) * RAD2DEG;
      if (!(Math.abs(rel - ind.shownRotation) < di.angleEpsilonDeg)) {
        ind.shownRotation = rel;
        ind.el.style.transform = `rotate(${rel.toFixed(1)}deg)`;
      }
      if (
        Math.abs(opacity - ind.shownOpacity) >= di.opacityEpsilon ||
        (opacity === 0 && ind.shownOpacity !== 0)
      ) {
        ind.shownOpacity = opacity;
        ind.el.style.opacity = opacity.toFixed(3);
      }
    }
  }

  private updateMovement(dt: number): void {
    if (!this.movementVisible || !this.movementFed) return;
    this.movementTimer += dt;
    if (this.movementTimer < 1 / HUD.movementReadout.refreshHz) return;
    this.movementTimer = 0;
    const speed = Number.isFinite(this.pendingSpeed) ? this.pendingSpeed : 0;
    const text = speed.toFixed(1);
    if (text !== this.shownSpeed) {
      this.shownSpeed = text;
      this.movementSpeed.textContent = `${text} m/s`;
    }
    if (this.pendingState !== this.shownState) {
      this.shownState = this.pendingState;
      this.movementState.textContent = STATE_LABELS[this.pendingState] ?? this.pendingState;
      this.movementEl.dataset.state = this.pendingState;
    }
  }

  private updateFps(): void {
    if (!this.fpsVisible) return;
    // Real time, independent of the (possibly time-scaled) dt passed to update().
    const now = performance.now();
    if (this.lastFrameAt >= 0) {
      this.fpsTime += now - this.lastFrameAt;
      this.fpsFrames++;
    }
    this.lastFrameAt = now;
    if (this.fpsTime >= 1000 / HUD.fps.refreshHz && this.fpsFrames > 0) {
      this.fpsEl.textContent = `${Math.round((this.fpsFrames * 1000) / this.fpsTime)} FPS`;
      this.fpsTime = 0;
      this.fpsFrames = 0;
    }
  }
}
