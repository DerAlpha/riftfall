// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { ABILITIES, type AbilityDef } from '../../defs/abilities';
import { createDefaultSettings } from '../../save/settingsSchema';
import { ArsenalHud, type ArsenalAbilitySource } from './ArsenalHud';

function makeSettings(): SettingsStore {
  const current = createDefaultSettings();
  return { current, update: () => {}, replace: () => {}, resetSection: () => {} };
}

describe('ArsenalHud', () => {
  let events: EventBus<GameEvents>;
  let corner: HTMLElement;
  let layer: HTMLElement;
  let hud: ArsenalHud;
  let src: { -readonly [K in keyof ArsenalAbilitySource]: ArsenalAbilitySource[K] };
  let prime = 0;

  beforeEach(() => {
    document.body.innerHTML = '';
    events = new EventBus<GameEvents>();
    layer = document.createElement('div');
    corner = document.createElement('div');
    layer.appendChild(corner);
    document.body.appendChild(layer);
    hud = new ArsenalHud(corner, layer, events, makeSettings());
    src = {
      equippedDef: ABILITIES.schockwelle as AbilityDef,
      cooldownLeft: 0,
      cooldown: ABILITIES.schockwelle.cooldown,
      active: false,
      activeTimeLeft: 0,
      activeDuration: 0,
    };
    prime = 0;
    hud.setSources(src, {
      get primeAmount() {
        return prime;
      },
    });
  });

  const q = (sel: string): HTMLElement => corner.querySelector(sel) as HTMLElement;

  it('shows the grenade type, count and pips from grenade:changed, empty in red', () => {
    events.emit('grenade:changed', { grenadeId: 'frag', count: 2, max: 4 });
    const gr = q('.hud-gr');
    expect(gr.hidden).toBe(false);
    expect(gr.dataset.grenade).toBe('frag');
    expect(q('.hud-gr__count').textContent).toBe('2');
    const pips = [...corner.querySelectorAll<HTMLElement>('.hud-gr__pip')].filter((p) => !p.hidden);
    expect(pips).toHaveLength(4);
    expect(pips.filter((p) => p.classList.contains('is-full'))).toHaveLength(2);
    events.emit('grenade:changed', { grenadeId: 'frag', count: 0, max: 4 });
    expect(gr.classList.contains('is-empty')).toBe(true);
    events.emit('grenade:changed', { grenadeId: 'nope', count: 1, max: 1 });
    expect(gr.hidden).toBe(true);
  });

  it('shows the wind-up while a throw is primed', () => {
    events.emit('grenade:changed', { grenadeId: 'kryo', count: 1, max: 3 });
    hud.update(0.016);
    expect(q('.hud-gr__prime').hidden).toBe(true);
    prime = 0.5;
    hud.update(0.016);
    expect(q('.hud-gr__prime').hidden).toBe(false);
    expect(q('.hud-gr__primefill').style.transform).toBe('scaleX(0.50)');
  });

  it('ability ring: ready → cooling (seconds) → active, with key caps', () => {
    hud.update(0.016);
    const ab = q('.hud-ab');
    expect(ab.hidden).toBe(false);
    expect(ab.dataset.ability).toBe('schockwelle');
    expect(ab.classList.contains('is-ready')).toBe(true);
    expect(q('.hud-ab__time').textContent).toBe('');
    expect(corner.querySelectorAll('.hud-arsenal__key')[0]!.textContent).toBe('E');
    expect(corner.querySelectorAll('.hud-arsenal__key')[1]!.textContent).toBe('G');
    src.cooldownLeft = 12.3;
    hud.update(0.016);
    expect(ab.classList.contains('is-cooling')).toBe(true);
    expect(q('.hud-ab__time').textContent).toBe('13');
    const offset = Number(q('.hud-ab__fill').getAttribute('stroke-dashoffset'));
    expect(offset).toBeGreaterThan(0);
    src.active = true;
    src.activeTimeLeft = 3;
    src.activeDuration = 6;
    hud.update(0.016);
    expect(ab.classList.contains('is-active')).toBe(true);
    expect(q('.hud-ab__time').textContent).toBe('');
    src.equippedDef = null;
    hud.update(0.016);
    expect(ab.hidden).toBe(true);
  });

  it('running abilities show their screen overlay until ability:ended / reset', () => {
    const overlay = layer.querySelector('.hud-abfx') as HTMLElement;
    expect(overlay.hidden).toBe(true);
    events.emit('ability:used', { abilityId: 'schockwelle', cooldown: 18, duration: 0 });
    expect(hud.overlayShown).toBeNull();
    events.emit('ability:used', { abilityId: 'phasenbarriere', cooldown: 30, duration: 7 });
    expect(hud.overlayShown).toBe('shield');
    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains('hud-abfx--shield')).toBe(true);
    events.emit('player:damaged', { amount: 10, healthFraction: 0.9 });
    expect(overlay.classList.contains('is-hit-a') || overlay.classList.contains('is-hit-b')).toBe(true);
    events.emit('ability:ended', { abilityId: 'phasenbarriere' });
    expect(overlay.hidden).toBe(true);
    expect(overlay.classList.contains('hud-abfx--shield')).toBe(false);
    events.emit('ability:used', { abilityId: 'chronofeld', cooldown: 36, duration: 7 });
    expect(hud.overlayShown).toBe('chrono');
    hud.reset();
    expect(hud.overlayShown).toBeNull();
  });

  it('deny() shakes the widget', () => {
    events.emit('grenade:changed', { grenadeId: 'frag', count: 0, max: 4 });
    hud.deny('grenade');
    const gr = q('.hud-gr');
    expect(gr.classList.contains('is-deny-a') || gr.classList.contains('is-deny-b')).toBe(true);
  });
});
