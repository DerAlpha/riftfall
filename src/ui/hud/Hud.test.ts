// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { HUD } from '../../defs/ui';
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

function rotationDeg(el: HTMLElement): number {
  const m = /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform);
  return m ? Number(m[1]) : NaN;
}

describe('Hud', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let hud: Hud;

  beforeEach(() => {
    root = document.createElement('div');
    events = new EventBus<GameEvents>();
    settings = makeSettings(events);
    hud = new Hud(root, events, settings);
  });

  afterEach(() => hud.dispose());

  it('shows health/armor from player:healthChanged and flags low health', () => {
    events.emit('player:healthChanged', { health: 80.2, maxHealth: 100, armor: 0, maxArmor: 100 });
    const values = [...root.querySelectorAll('.hud-bar__value')].map((e) => e.textContent);
    expect(values).toEqual(['0', '81']);
    const fill = root.querySelector('.hud-bar--health .hud-bar__fill') as HTMLElement;
    expect(fill.style.transform).toBe('scaleX(0.8020)');
    events.emit('player:healthChanged', { health: 20, maxHealth: 100, armor: 0, maxArmor: 100 });
    expect(root.querySelector('.hud-bar--health')!.classList.contains('is-low')).toBe(true);
  });

  it('applies crosshair style/colour and HUD scale from settings', () => {
    const xh = root.querySelector('.hud-crosshair') as HTMLElement;
    expect(xh.classList.contains('xh--cross')).toBe(true);
    settings.update('gameplay', { crosshair: 'circle', crosshairColor: '#ff00aa' });
    expect(xh.classList.contains('xh--circle')).toBe(true);
    expect(xh.classList.contains('xh--cross')).toBe(false);
    expect(xh.style.getPropertyValue('--xh-color')).toBe('#ff00aa');
    settings.update('gameplay', { crosshairColor: 'url(javascript:1)' });
    expect(xh.style.getPropertyValue('--xh-color')).toBe(HUD.crosshair.defaultColor);
    settings.update('accessibility', { hudScale: 1.25 });
    expect((root.firstElementChild as HTMLElement).style.getPropertyValue('--hud-scale')).toBe('1.25');
  });

  it('writes the crosshair spread only when it changes noticeably', () => {
    const xh = root.querySelector('.hud-crosshair') as HTMLElement;
    hud.setSpread(1);
    expect(xh.style.getPropertyValue('--xh-spread')).toBe(`${HUD.crosshair.spreadMaxPx.toFixed(1)}px`);
    xh.style.setProperty('--xh-spread', 'sentinel');
    hud.setSpread(1 - HUD.crosshair.spreadQuantum / 2);
    expect(xh.style.getPropertyValue('--xh-spread')).toBe('sentinel');
  });

  it('points the damage indicator towards the source relative to the camera yaw', () => {
    const arcs = [...root.querySelectorAll('.hud-damage__arc')] as HTMLElement[];
    // Source to the +X side; camera yaw 0 looks down -Z, so +X is to the right.
    events.emit('player:damaged', { amount: 30, healthFraction: 0.7, direction: { x: 1, y: 0, z: 0 } });
    hud.update(1 / 60, 0);
    const arc = arcs.find((a) => a.style.opacity !== '0')!;
    expect(rotationDeg(arc)).toBeCloseTo(90, 0);
    // Turn left by 90° (positive yaw): the source is now behind.
    hud.update(1 / 60, Math.PI / 2);
    expect(Math.abs(rotationDeg(arc))).toBeCloseTo(180, 0);
    // It fades out completely.
    hud.update(HUD.damageIndicator.durationSeconds, Math.PI / 2);
    expect(Number(arc.style.opacity)).toBe(0);
  });

  it('flashes the hit vignette, capped lower with reduce flashing', () => {
    const hit = root.querySelector('.hud-hit') as HTMLElement;
    events.emit('player:damaged', { amount: 1000, healthFraction: 0.1 });
    hud.update(0, 0);
    expect(Number(hit.style.opacity)).toBeCloseTo(HUD.hitFlash.max, 3);
    hud.update(10, 0);
    expect(Number(hit.style.opacity)).toBe(0);
    settings.update('accessibility', { reduceFlashing: true });
    events.emit('player:damaged', { amount: 1000, healthFraction: 0.1 });
    hud.update(0, 0);
    expect(Number(hit.style.opacity)).toBeCloseTo(HUD.hitFlash.reducedMax, 3);
  });

  it('renders dash pips and hides them when the dash is locked', () => {
    const wrap = root.querySelector('.hud-dash') as HTMLElement;
    hud.setDash(1, 2, 0.5);
    expect(wrap.hidden).toBe(false);
    const pips = [...root.querySelectorAll('.hud-dash__pip')] as HTMLElement[];
    expect(pips.filter((p) => !p.hidden).length).toBe(2);
    expect(pips[0]!.classList.contains('is-full')).toBe(true);
    expect((pips[1]!.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.500)');
    hud.setDash(0, 0, 0);
    expect(wrap.hidden).toBe(true);
  });

  it('updates the movement readout at a throttled rate', () => {
    const speed = root.querySelector('.hud-movement__speed')!;
    const readout = root.querySelector('.hud-movement') as HTMLElement;
    // Never shows stale placeholder values before the first setMovement().
    hud.update(1, 0);
    expect(readout.hidden).toBe(true);
    hud.setMovement(9.42, 'slide');
    expect(readout.hidden).toBe(false);
    hud.update(1 / 60, 0); // first values appear immediately
    expect(speed.textContent).toBe('9.4 m/s');
    expect(root.querySelector('.hud-movement__state')!.textContent).toBe('RUTSCHEN');
    hud.setMovement(3, 'ground');
    hud.update(0.001, 0);
    expect(speed.textContent).toBe('9.4 m/s');
    hud.setMovementReadoutVisible(false);
    expect((root.querySelector('.hud-movement') as HTMLElement).hidden).toBe(true);
  });
});
