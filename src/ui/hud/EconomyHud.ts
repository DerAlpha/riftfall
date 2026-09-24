/**
 * Economy HUD (M4): points counter, interaction prompt, perk row, power-up timers, banners and the
 * slow-motion tint. Built and driven by Hud (it passes the corners and forwards update/reset);
 * subscribes itself to:
 * - `economy:points` (reused payload: roll + popup; delta 0 sets the total without a popup),
 *   `economy:purchase` ok=false (denial shake + red flash),
 * - `interact:focus` (prompt, cost, affordability), `input:deviceChanged` and control settings
 *   (key cap of the interact binding),
 * - `perk:acquired` / `perk:lost` (row + perk banner), `player:revived` (Phoenix banner),
 * - `powerup:collected` / `powerup:expired` (timers, multiplier badge, banner, nuke flash),
 * - `zone:activated` (zone banner, display names via setZoneNames), `box:resolved` (box banner).
 * Game feeds per frame: setHold(interaction.holdProgress, focus is a hold interaction); once:
 * setPowerUpSource(powerUps), setZoneNames(level zones), setInputDevice(input.device); the
 * PowerUpSystem's fx.timeTint → setTimeTint.
 */
import type { SettingsStore } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import type { BindingMap } from '../../defs/input';
import { PERK_GLYPHS, PERKS, getPerkDef, perkCssColor } from '../../defs/perks';
import { POWERUP_GLYPHS, getPowerUpDef, type PowerUpDef } from '../../defs/powerups';
import { ECONOMY_HUD } from '../../defs/ui';
import { getWeaponDef } from '../../defs/weapons';
import { learnedLayout, type KeyboardLayout } from '../../input/bindings';
import { EconomyBanners } from './EconomyBanners';
import { interactKeyCap, type KeyCap } from './economyModel';
import { InteractPrompt } from './InteractPrompt';
import { PerkRow } from './PerkRow';
import { PointsCounter } from './PointsCounter';
import { PowerUpHud, type PowerUpTimerSource } from './PowerUpHud';
import './hud-economy.css';

const BN = ECONOMY_HUD.banners;

export interface EconomyHudParts {
  /** HUD root element (centered widgets). */
  layer: HTMLElement;
  /** Bottom-left corner (perk row above the vitals). */
  bottomLeft: HTMLElement;
  /** Bottom-right corner (points above the weapon block). */
  bottomRight: HTMLElement;
  /** Where the tint overlay goes: the HUD layer's parent, right before the layer. */
  tintParent: HTMLElement | null;
  tintBefore: HTMLElement | null;
}

function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** The points multiplier a power-up applies (Double Points: 2), or 0 for others. */
function pointsMultiplierOf(def: PowerUpDef | undefined): number {
  const fx = def?.effect;
  return fx && fx.kind === 'stat' && fx.stat === 'pointsMultiplier' && fx.op === 'mul' ? fx.value : 0;
}

interface KeyboardApi {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

export class EconomyHud {
  readonly points: PointsCounter;
  readonly prompt: InteractPrompt;
  readonly perks: PerkRow;
  readonly powerUps: PowerUpHud;
  readonly banners: EconomyBanners;

  private readonly offs: (() => void)[] = [];
  private readonly cap: KeyCap = { label: '', pad: false, face: '' };
  private bindings: BindingMap | null;
  private device: 'kbm' | 'gamepad' = 'kbm';
  private layout: KeyboardLayout | null = null;
  private zoneNames: ReadonlyMap<string, string> = new Map();
  private disposed = false;

  constructor(parts: EconomyHudParts, events: EventBus<GameEvents>, settings: SettingsStore) {
    // Top/bottom order inside the corners: the widgets prepend themselves.
    this.points = new PointsCounter(parts.bottomRight);
    this.perks = new PerkRow(parts.bottomLeft);
    this.powerUps = new PowerUpHud(parts.layer, parts.tintParent, parts.tintBefore);
    this.banners = new EconomyBanners(parts.layer);
    this.prompt = new InteractPrompt(parts.layer);
    this.bindings = settings.current.controls.bindings;
    this.refreshKeyCap();
    this.loadLayout();

    this.offs.push(
      events.on('economy:points', (e) => this.points.onPoints(e.delta, e.total, e.reason)),
      events.on('economy:purchase', (e) => {
        if (e.ok) return;
        this.prompt.onDenied();
        this.points.onDenied();
      }),
      events.on('interact:focus', (e) => {
        // The learned layout grows with every keypress: refresh the cap with each new focus.
        if (e.id !== null && this.device === 'kbm' && this.layout === null) this.refreshKeyCap();
        this.prompt.setFocus(e.id, e.prompt, e.cost, e.affordable);
      }),
      events.on('input:deviceChanged', (e) => this.setInputDevice(e.device)),
      events.on('settings:changed', ({ settings: s, sections }) => {
        if (!sections.includes('controls')) return;
        this.bindings = s.controls.bindings;
        this.refreshKeyCap();
      }),
      events.on('perk:acquired', (e) => this.onPerk(e.perkId)),
      events.on('perk:lost', (e) => this.perks.remove(e.perkId)),
      events.on('player:revived', () => {
        const phoenix = PERKS.phoenix;
        this.banners.push({
          kind: 'revive',
          kicker: phoenix.name.toUpperCase(),
          title: BN.labels.revive,
          sub: phoenix.tagline,
          color: cssHex(BN.colors.revive),
          glyph: PERK_GLYPHS[phoenix.icon],
          seconds: BN.seconds.revive,
        });
      }),
      events.on('powerup:collected', (e) => this.onPowerUp(e.type, e.duration)),
      events.on('powerup:expired', (e) => {
        this.powerUps.onExpired(e.type);
        if (pointsMultiplierOf(getPowerUpDef(e.type)) > 0) this.points.setMultiplier(1);
      }),
      events.on('zone:activated', (e) => {
        const name = this.zoneNames.get(e.zone) ?? e.zone;
        this.banners.push({
          kind: 'zone',
          kicker: BN.labels.zone,
          title: name,
          sub: '',
          color: cssHex(BN.colors.zone),
          glyph: null,
          seconds: BN.seconds.zone,
        });
      }),
      events.on('box:resolved', (e) => {
        const anomaly = e.weaponId === null;
        const weapon = e.weaponId ? getWeaponDef(e.weaponId) : undefined;
        this.banners.push({
          kind: 'box',
          kicker: BN.labels.box,
          title: anomaly ? BN.labels.anomaly : (weapon?.name ?? e.weaponId ?? ''),
          sub: anomaly ? BN.labels.anomalySub : '',
          color: cssHex(anomaly ? BN.colors.anomaly : BN.colors.box),
          glyph: null,
          seconds: BN.seconds.box,
        });
      }),
    );
  }

  configure(reduceFlashing: boolean): void {
    this.points.configure(reduceFlashing);
    this.powerUps.configure(reduceFlashing);
  }

  setInputDevice(device: 'kbm' | 'gamepad'): void {
    if (device === this.device) return;
    this.device = device;
    this.refreshKeyCap();
  }

  /** Display names of the map's zones (zone banners); unknown ids show the id. */
  setZoneNames(zones: readonly { readonly id: string; readonly name: string }[]): void {
    this.zoneNames = new Map(zones.map((z) => [z.id, z.name] as const));
  }

  setPowerUpSource(source: PowerUpTimerSource | null): void {
    this.powerUps.setSource(source);
  }

  /** Per frame: hold progress of the focused interactable and whether it is a hold interaction. */
  setHold(progress: number, hold: boolean): void {
    this.prompt.setHold(progress, hold);
  }

  setTimeTint(amount: number): void {
    this.powerUps.setTint(amount);
  }

  update(dt: number): void {
    const d = dt > 0 && Number.isFinite(dt) ? dt : 0;
    this.points.update(d);
    this.prompt.update(d);
    this.perks.update(d);
    this.powerUps.update(d);
    this.banners.update(d);
  }

  /**
   * New run: popups, perks, timers, banners, prompt and tint cleared. The balance stays: the new
   * run's economy.reset() already announced it (delta 0) before the HUD reset runs.
   */
  reset(): void {
    this.points.reset();
    this.prompt.reset();
    this.perks.clear();
    this.powerUps.reset();
    this.banners.reset();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.powerUps.dispose();
  }

  // -------------------------------------------------------------------------

  private onPerk(perkId: string): void {
    const def = getPerkDef(perkId);
    if (!def) return;
    this.perks.add(perkId);
    this.banners.push({
      kind: 'perk',
      kicker: BN.labels.perk,
      title: def.name,
      sub: def.tagline,
      color: perkCssColor(def),
      glyph: PERK_GLYPHS[def.icon] ?? null,
      seconds: BN.seconds.perk,
    });
  }

  private onPowerUp(type: string, duration: number): void {
    const def = getPowerUpDef(type);
    if (!def) return;
    this.powerUps.onCollected(type, duration);
    const mult = pointsMultiplierOf(def);
    if (mult > 0 && duration > 0) this.points.setMultiplier(mult);
    if (def.effect.kind === 'nuke') this.powerUps.nukeFlash();
    // Perk scraps (uncounted, small) only refill ammo quietly – no banner for every one of them.
    if (!def.counted) return;
    this.banners.push({
      kind: 'powerUp',
      kicker: BN.labels.powerUp,
      title: def.name,
      sub: def.description,
      color: cssHex(def.hudColor),
      glyph: POWERUP_GLYPHS[def.glyph] ?? null,
      seconds: BN.seconds.powerUp,
    });
  }

  private refreshKeyCap(): void {
    const layout = this.layout ?? (learnedLayout.size > 0 ? learnedLayout : undefined);
    interactKeyCap(this.bindings, this.device, layout, this.cap);
    this.prompt.setKeyCap(this.cap);
  }

  /** Chromium: the keyboard layout map prints character keys as the user's keyboard does. */
  private loadLayout(): void {
    if (typeof navigator === 'undefined') return;
    const kb = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
    if (!kb || typeof kb.getLayoutMap !== 'function') return;
    kb.getLayoutMap()
      .then((m) => {
        if (this.disposed || m.size === 0) return;
        this.layout = m;
        this.refreshKeyCap();
      })
      .catch(() => undefined);
  }
}
