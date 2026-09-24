// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents, PointsReason } from '../../core/events';
import { DEFAULT_BINDINGS, PAD } from '../../defs/input';
import { PERKS, PERK_GLYPHS } from '../../defs/perks';
import { POWERUP_DEFS } from '../../defs/powerups';
import { ECONOMY_HUD } from '../../defs/ui';
import { WEAPONS } from '../../defs/weapons';
import { cloneBindingMap } from '../../input/bindings';
import { createDefaultSettings, type Settings, type SettingsSection } from '../../save/settingsSchema';
import { Hud } from './Hud';

function makeSettings(events: EventBus<GameEvents>): SettingsStore {
  const current = createDefaultSettings();
  return {
    current,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
      Object.assign(current[section], patch);
      events.emit('settings:changed', { settings: current, sections: [section] });
    },
    replace(): void {},
    resetSection(): void {},
  };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

describe('EconomyHud (through Hud)', () => {
  let app: HTMLElement;
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let hud: Hud;
  const points = (delta: number, total: number, reason: PointsReason = 'kill'): void => {
    events.emit('economy:points', { delta, total, reason });
  };

  beforeEach(() => {
    app = document.createElement('div');
    root = document.createElement('div');
    app.appendChild(root);
    events = new EventBus<GameEvents>();
    settings = makeSettings(events);
    hud = new Hud(root, events, settings);
  });

  afterEach(() => hud.dispose());

  describe('points counter', () => {
    it('sits on top of the bottom-right corner and replaces the placeholder with the balance', () => {
      const br = q(root, '.hud-corner--br');
      expect(br.firstElementChild?.classList.contains('hud-points')).toBe(true);
      const value = q(root, '.hud-points__value');
      expect(value.textContent).toBe(ECONOMY_HUD.points.placeholder);
      points(0, 500, 'dev');
      expect(value.textContent).toBe('500');
      expect(q(root, '.hud-points').classList.contains('hud-placeholder')).toBe(false);
      // delta 0 (reset / announce): no popup.
      hud.update(0.016, 0);
      const visible = [...root.querySelectorAll<HTMLElement>('.hud-pop')].filter(
        (p) => p.style.opacity !== '0',
      );
      expect(visible).toHaveLength(0);
    });

    it('rolls the number and floats a coloured popup per earning', () => {
      points(0, 500, 'dev');
      points(100, 600, 'headshot');
      hud.update(0.016, 0);
      const value = q(root, '.hud-points__value');
      expect(Number(value.textContent!.replace('.', ''))).toBeLessThan(600);
      const pop = [...root.querySelectorAll<HTMLElement>('.hud-pop')].find((p) => p.textContent === '+100')!;
      expect(pop).toBeDefined();
      expect(pop.classList.contains('hud-pop--head')).toBe(true);
      expect(Number(pop.style.opacity)).toBeGreaterThan(0.5);
      expect(value.classList.contains('is-bump-a') || value.classList.contains('is-bump-b')).toBe(true);
      for (let i = 0; i < 90; i++) hud.update(1 / 60, 0);
      expect(value.textContent).toBe('600');
      expect(pop.style.opacity).toBe('0');
    });

    it('shows spending as a red popup and flashes the balance', () => {
      points(0, 2000, 'dev');
      points(-1500, 500, 'purchase');
      hud.update(0.016, 0);
      const pop = [...root.querySelectorAll<HTMLElement>('.hud-pop')].find(
        (p) => p.textContent === '−1.500',
      )!;
      expect(pop.classList.contains('hud-pop--spend')).toBe(true);
      expect(q(root, '.hud-points').classList.contains('is-spending')).toBe(true);
      hud.update(ECONOMY_HUD.points.spendFlashSeconds + 0.01, 0);
      expect(q(root, '.hud-points').classList.contains('is-spending')).toBe(false);
    });

    it('keeps a fixed pool of popup elements under a flood of earnings', () => {
      points(0, 0, 'dev');
      const count = root.querySelectorAll('.hud-pop').length;
      expect(count).toBe(ECONOMY_HUD.popups.pool);
      let total = 0;
      for (let i = 0; i < 60; i++) {
        total += 10;
        points(10, total, i % 2 ? 'hit' : 'repair');
        hud.update(ECONOMY_HUD.popups.mergeWindow + 0.01, 0);
      }
      expect(root.querySelectorAll('.hud-pop').length).toBe(count);
    });

    it('shows the multiplier badge while Double Points runs', () => {
      const badge = q(root, '.hud-points__mult');
      expect(badge.hidden).toBe(true);
      events.emit('powerup:collected', {
        type: 'doublePoints',
        position: { x: 0, y: 0, z: 0 },
        duration: 30,
      });
      expect(badge.hidden).toBe(false);
      expect(badge.textContent).toBe('×2');
      events.emit('powerup:expired', { type: 'doublePoints' });
      expect(badge.hidden).toBe(true);
    });
  });

  describe('interaction prompt', () => {
    const focus = (cost: number | null, affordable = true, id = 'door:a'): void => {
      events.emit('interact:focus', { id, prompt: 'Tür öffnen: Atrium', cost, affordable });
    };

    it('shows the key cap, prompt and price; red when unaffordable; hides without a focus', () => {
      const el = q(root, '.hud-interact');
      expect(el.hidden).toBe(true);
      focus(750);
      expect(el.hidden).toBe(false);
      expect(q(el, '.hud-key__label').textContent).toBe('F');
      expect(q(el, '.hud-interact__text').textContent).toBe('Tür öffnen: Atrium');
      const cost = q(el, '.hud-interact__cost');
      expect(cost.hidden).toBe(false);
      expect(q(el, '.hud-interact__price').textContent).toBe('750');
      expect(cost.classList.contains('is-short')).toBe(false);
      focus(1500, false);
      expect(q(el, '.hud-interact__price').textContent).toBe('1.500');
      expect(cost.classList.contains('is-short')).toBe(true);
      focus(null);
      expect(cost.hidden).toBe(true);
      events.emit('interact:focus', { id: null, prompt: null, cost: null, affordable: true });
      expect(el.hidden).toBe(true);
      events.emit('interact:focus', { id: 'seal:1', prompt: '', cost: null, affordable: true });
      expect(el.hidden).toBe(true);
    });

    it('follows the active device and rebinding', () => {
      focus(750);
      const key = q(root, '.hud-key');
      events.emit('input:deviceChanged', { device: 'gamepad' });
      expect(q(key, '.hud-key__label').textContent).toBe('X');
      expect(key.classList.contains('is-pad')).toBe(true);
      expect(key.classList.contains('hud-key--x')).toBe(true);
      const bindings = cloneBindingMap(DEFAULT_BINDINGS);
      bindings.interact = [
        { device: 'key', code: 'KeyE' },
        { device: 'pad', button: PAD.Y },
      ];
      settings.update('controls', { bindings });
      expect(q(key, '.hud-key__label').textContent).toBe('Y');
      hud.setInputDevice('kbm');
      expect(q(key, '.hud-key__label').textContent).toBe('E');
      expect(key.classList.contains('is-pad')).toBe(false);
    });

    it('shakes with "Nicht genug Punkte" on a refused purchase, then recovers', () => {
      focus(5000, false);
      events.emit('economy:purchase', { item: 'door:a', kind: 'door', cost: 5000, ok: false });
      const deny = q(root, '.hud-interact__deny');
      expect(deny.hidden).toBe(false);
      expect(deny.textContent).toBe(ECONOMY_HUD.prompt.deny);
      const row = q(root, '.hud-interact__row');
      expect(row.classList.contains('is-deny-a') || row.classList.contains('is-deny-b')).toBe(true);
      expect(q(root, '.hud-points').classList.contains('is-spending')).toBe(true);
      hud.update(ECONOMY_HUD.prompt.denySeconds + 0.01, 0);
      expect(deny.hidden).toBe(true);
      // A successful purchase shows nothing.
      events.emit('economy:purchase', { item: 'door:a', kind: 'door', cost: 750, ok: true });
      expect(deny.hidden).toBe(true);
    });

    it('draws the hold ring for hold interactions only', () => {
      events.emit('interact:focus', {
        id: 'seal:1',
        prompt: 'Riss-Siegel reparieren',
        cost: null,
        affordable: true,
      });
      const key = q(root, '.hud-key');
      const fill = q<SVGCircleElement>(root, '.hud-key__fill');
      const full = Number(fill.getAttribute('stroke-dasharray'));
      hud.setInteractHold(0, true);
      expect(key.classList.contains('is-hold')).toBe(true);
      expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(full, 1);
      hud.setInteractHold(0.5, true);
      expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(full / 2, 1);
      const before = fill.getAttribute('stroke-dashoffset');
      hud.setInteractHold(0.502, true); // below the quantum: no write
      expect(fill.getAttribute('stroke-dashoffset')).toBe(before);
      hud.setInteractHold(0, false);
      expect(key.classList.contains('is-hold')).toBe(false);
    });
  });

  describe('perk row', () => {
    it('pops acquired perks in above the vitals and removes lost ones after their animation', () => {
      const bl = q(root, '.hud-corner--bl');
      const row = q(root, '.hud-perks');
      expect(bl.firstElementChild).toBe(row);
      expect(row.hidden).toBe(true);
      events.emit('perk:acquired', { perkId: 'titan', slot: 0 });
      events.emit('perk:acquired', { perkId: 'quickload', slot: 1 });
      const shown = [...row.querySelectorAll<HTMLElement>('.hud-perk')].filter((p) => !p.hidden);
      expect(shown).toHaveLength(2);
      expect(shown[0]!.dataset.perk).toBe('titan');
      expect(shown[0]!.style.getPropertyValue('--perk')).toBe('#ff2d3a');
      expect(q(shown[0]!, 'path').getAttribute('d')).toBe(PERK_GLYPHS[PERKS.titan.icon]);
      expect(shown[1]!.classList.contains('is-new-a') || shown[1]!.classList.contains('is-new-b')).toBe(true);
      events.emit('perk:lost', { perkId: 'titan' });
      hud.update(0.05, 0);
      expect(shown[0]!.classList.contains('is-leaving')).toBe(true);
      hud.update(ECONOMY_HUD.perks.removeSeconds, 0);
      // The row closed up: the first slot now shows the remaining perk, without replaying its pop.
      const after = [...row.querySelectorAll<HTMLElement>('.hud-perk')].filter((p) => !p.hidden);
      expect(after.map((p) => p.dataset.perk)).toEqual(['quickload']);
      expect(after[0]!.classList.contains('is-new-a') || after[0]!.classList.contains('is-new-b')).toBe(
        false,
      );
      expect(after[0]!.classList.contains('is-leaving')).toBe(false);
    });

    it('announces the perk with its name, slogan and colour', () => {
      events.emit('perk:acquired', { perkId: 'phoenix', slot: 0 });
      const banner = q(root, '.hud-ebanner');
      expect(banner.hidden).toBe(false);
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(PERKS.phoenix.name);
      expect(q(banner, '.hud-ebanner__sub').textContent).toBe(PERKS.phoenix.tagline);
      expect(banner.style.getPropertyValue('--eb')).toBe('#ff6a1f');
    });
  });

  describe('power-up timers', () => {
    it('runs a ring per timed power-up from the system clock, flashes at the end and leaves on expiry', () => {
      let left = 30;
      hud.setPowerUpSource({ remaining: () => left, duration: () => 30 });
      events.emit('powerup:collected', { type: 'instakill', position: { x: 0, y: 0, z: 0 }, duration: 30 });
      hud.update(0.016, 0);
      const timer = q(root, '.hud-pu[data-type="instakill"]');
      expect(timer.hidden).toBe(false);
      expect(q(timer, '.hud-pu__time').textContent).toBe('30');
      expect(timer.style.getPropertyValue('--pu')).toBe('#ff3344');
      left = 12;
      hud.update(0.016, 0);
      const fill = q<SVGCircleElement>(timer, '.hud-pu__fill');
      const full = Number(fill.getAttribute('stroke-dasharray'));
      expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(full * (1 - 12 / 30), 1);
      left = 2.5;
      hud.update(0.016, 0);
      expect(timer.classList.contains('is-ending')).toBe(true);
      expect(q(timer, '.hud-pu__time').textContent).toBe('3');
      events.emit('powerup:expired', { type: 'instakill' });
      expect(timer.classList.contains('is-leaving')).toBe(true);
      hud.update(ECONOMY_HUD.powerUps.removeSeconds + 0.01, 0);
      expect(timer.hidden).toBe(true);
      expect(q(root, '.hud-powerups').hidden).toBe(true);
    });

    it('sits above the intermission countdown and pushes it down only while a timer runs', () => {
      const timers = q(root, '.hud-powerups');
      const countdown = q(root, '.hud-countdown');
      expect(timers.hidden).toBe(true);
      // DOM order drives the CSS sibling rule (.hud-powerups:not([hidden]) ~ .hud-countdown).
      expect(timers.compareDocumentPosition(countdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      events.emit('powerup:collected', { type: 'slowmo', position: { x: 0, y: 0, z: 0 }, duration: 10 });
      expect(timers.hidden).toBe(false);
    });

    it('counts down on its own without a source and ignores instant power-ups', () => {
      events.emit('powerup:collected', { type: 'maxAmmo', position: { x: 0, y: 0, z: 0 }, duration: 0 });
      hud.update(0.016, 0);
      expect(hud.economy.powerUps.active).toEqual([]);
      events.emit('powerup:collected', { type: 'slowmo', position: { x: 0, y: 0, z: 0 }, duration: 10 });
      hud.update(4, 0);
      const timer = q(root, '.hud-pu[data-type="slowmo"]');
      expect(q(timer, '.hud-pu__time').textContent).toBe('6');
      // A re-collect refreshes the timer.
      events.emit('powerup:collected', { type: 'slowmo', position: { x: 0, y: 0, z: 0 }, duration: 10 });
      hud.update(0.5, 0);
      expect(q(timer, '.hud-pu__time').textContent).toBe('10');
    });

    it('announces every counted collection with its German name, not the perk scraps', () => {
      const banner = q(root, '.hud-ebanner');
      events.emit('powerup:collected', { type: 'ammoScrap', position: { x: 0, y: 0, z: 0 }, duration: 0 });
      expect(banner.hidden).toBe(true);
      events.emit('powerup:collected', { type: 'maxAmmo', position: { x: 0, y: 0, z: 0 }, duration: 0 });
      expect(banner.hidden).toBe(false);
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(POWERUP_DEFS.maxAmmo!.name);
      expect(banner.classList.contains('hud-ebanner--powerUp')).toBe(true);
    });

    it('flashes on a nuke (calmer with reduced flashing)', () => {
      const flash = q(root, '.hud-nukeflash');
      events.emit('powerup:collected', { type: 'nuke', position: { x: 0, y: 0, z: 0 }, duration: 0 });
      expect(flash.hidden).toBe(false);
      expect(flash.classList.contains('is-reduced')).toBe(false);
      hud.update(ECONOMY_HUD.powerUps.nukeFlashSeconds + 0.01, 0);
      expect(flash.hidden).toBe(true);
      settings.update('accessibility', { reduceFlashing: true });
      events.emit('powerup:collected', { type: 'nuke', position: { x: 0, y: 0, z: 0 }, duration: 0 });
      expect(flash.classList.contains('is-reduced')).toBe(true);
    });

    it('puts the slow-motion tint right below the HUD layer and shows it only while > 0', () => {
      const tint = root.previousElementSibling as HTMLElement;
      expect(tint.classList.contains('hud-timetint')).toBe(true);
      expect(tint.parentElement).toBe(app);
      expect(tint.hidden).toBe(true);
      hud.setTimeTint(0.5);
      expect(tint.hidden).toBe(false);
      expect(Number(tint.style.opacity)).toBeCloseTo(0.5);
      hud.setTimeTint(0);
      expect(tint.hidden).toBe(true);
    });
  });

  describe('banners', () => {
    it('names unlocked zones and merges the zones of one door', () => {
      hud.setZoneNames([
        { id: 'labs', name: 'Laborflügel' },
        { id: 'server', name: 'Serverraum' },
      ]);
      events.emit('zone:activated', { zone: 'labs' });
      const banner = q(root, '.hud-ebanner');
      expect(q(banner, '.hud-ebanner__kicker').textContent).toBe(ECONOMY_HUD.banners.labels.zone);
      expect(q(banner, '.hud-ebanner__text').textContent).toBe('Laborflügel');
      events.emit('zone:activated', { zone: 'server' });
      expect(q(banner, '.hud-ebanner__text').textContent).toBe('Laborflügel · Serverraum');
    });

    it('holds a banner for its game time, then fades it out before hiding it', () => {
      events.emit('perk:acquired', { perkId: 'titan', slot: 0 });
      const banner = q(root, '.hud-ebanner');
      hud.update(ECONOMY_HUD.banners.seconds.perk - 0.1, 0);
      expect(banner.hidden).toBe(false);
      expect(banner.classList.contains('is-out')).toBe(false);
      hud.update(0.2, 0);
      expect(banner.hidden).toBe(false);
      expect(banner.classList.contains('is-out')).toBe(true);
      hud.update(ECONOMY_HUD.banners.outSeconds, 0);
      expect(banner.hidden).toBe(true);
      // A new banner during the fade replaces it at once.
      events.emit('perk:acquired', { perkId: 'quickload', slot: 1 });
      hud.update(ECONOMY_HUD.banners.seconds.perk + 0.01, 0);
      events.emit('perk:acquired', { perkId: 'nova', slot: 2 });
      expect(banner.hidden).toBe(false);
      expect(banner.classList.contains('is-out')).toBe(false);
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(PERKS.nova.name);
    });

    it('shows box results and the Phoenix revive one after another', () => {
      const weaponId = Object.keys(WEAPONS)[0]!;
      events.emit('box:resolved', { boxId: 'rift_box', weaponId });
      const banner = q(root, '.hud-ebanner');
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(
        (WEAPONS as Record<string, { name: string }>)[weaponId]!.name,
      );
      events.emit('player:revived', { health: 50, chargesLeft: 0, invulnerability: 3 });
      // Queued behind the box result, shown once that one had its minimum time.
      hud.update(ECONOMY_HUD.banners.minSeconds + 0.01, 0);
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(ECONOMY_HUD.banners.labels.revive);
      hud.update(ECONOMY_HUD.banners.seconds.revive + 0.01, 0);
      expect(banner.hidden).toBe(true);
      events.emit('box:resolved', { boxId: 'rift_box', weaponId: null });
      expect(q(banner, '.hud-ebanner__text').textContent).toBe(ECONOMY_HUD.banners.labels.anomaly);
    });
  });

  it('resets popups, perks, timers, banners and the prompt for a new run but keeps the balance', () => {
    points(0, 500, 'dev');
    points(60, 560);
    events.emit('perk:acquired', { perkId: 'titan', slot: 0 });
    events.emit('powerup:collected', { type: 'doublePoints', position: { x: 0, y: 0, z: 0 }, duration: 30 });
    events.emit('interact:focus', { id: 'door:a', prompt: 'Tür öffnen', cost: 750, affordable: true });
    hud.update(0.016, 0);
    // The new run's economy.reset() announces its start balance before the HUD reset.
    points(0, 500, 'dev');
    hud.resetRun();
    hud.update(0.016, 0);
    expect(q(root, '.hud-points__value').textContent).toBe('500');
    const visible = [...root.querySelectorAll<HTMLElement>('.hud-pop')].filter(
      (p) => p.style.opacity !== '0',
    );
    expect(visible).toHaveLength(0);
    expect(q(root, '.hud-perks').hidden).toBe(true);
    expect(q(root, '.hud-powerups').hidden).toBe(true);
    expect(q(root, '.hud-ebanner').hidden).toBe(true);
    expect(q(root, '.hud-interact').hidden).toBe(true);
    expect(q(root, '.hud-points__mult').hidden).toBe(true);
  });

  it('removes its listeners and the tint overlay on dispose', () => {
    hud.dispose();
    expect(app.querySelector('.hud-timetint')).toBeNull();
    points(10, 10);
    hud = new Hud(root, events, settings);
  });
});
