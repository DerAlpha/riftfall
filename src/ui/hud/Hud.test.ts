// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('sizes the crosshair gap from the real cone (viewport height, vertical FOV, HUD scale)', () => {
    const xh = root.querySelector('.hud-crosshair') as HTMLElement;
    const h = window.innerHeight;
    const vFov = 60;
    const gap = (): number => Number.parseFloat(xh.style.getPropertyValue('--xh-spread'));
    const cone = (deg: number, fov = vFov): number =>
      ((h / 2) * Math.tan((deg * Math.PI) / 180)) / Math.tan((fov * Math.PI) / 360);
    hud.setSpreadCone(4.5, vFov);
    expect(gap()).toBeCloseTo(cone(4.5) - HUD.crosshair.gapPx, 1);
    // A narrower FOV (zoom / FOV setting) widens the cone on screen.
    hud.setSpreadCone(4.5, vFov * 0.7);
    expect(gap()).toBeCloseTo(cone(4.5, vFov * 0.7) - HUD.crosshair.gapPx, 1);
    // The crosshair is scaled by the HUD scale: the gap compensates.
    settings.update('accessibility', { hudScale: 2 });
    hud.setSpreadCone(4.5, vFov);
    expect(gap()).toBeCloseTo(cone(4.5) / 2 - HUD.crosshair.gapPx, 1);
    // Tiny cones clamp at the base gap, huge ones at the readable maximum; small changes are skipped.
    hud.setSpreadCone(0, vFov);
    expect(gap()).toBe(0);
    hud.setSpreadCone(80, vFov);
    expect(gap()).toBe(HUD.crosshair.maxSpreadPx);
    xh.style.setProperty('--xh-spread', 'sentinel');
    hud.setSpreadCone(79, vFov);
    expect(xh.style.getPropertyValue('--xh-spread')).toBe('sentinel');
    // The base gap is the def value (the CSS default is only a fallback).
    expect(xh.style.getPropertyValue('--xh-gap')).toBe(`${HUD.crosshair.gapPx}px`);
  });

  it('projects the crosshair cone onto the game viewport (HUD layer size, re-measured on resize)', () => {
    const xh = root.querySelector('.hud-crosshair') as HTMLElement;
    const gap = (): number => Number.parseFloat(xh.style.getPropertyValue('--xh-spread'));
    // The HUD layer covers the canvas: its CSS height (not the window, not the drawing buffer) counts.
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 2560 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    // Default 90° horizontal FOV at 16:9 → 58.7° vertical: the shotgun's 4.5° hip cone is ~101 px at 1440p.
    const vFov = (2 * Math.atan(Math.tan(Math.PI / 4) * (9 / 16)) * 180) / Math.PI;
    hud.setSpreadCone(4.5, vFov);
    const r1440 = (720 * Math.tan((4.5 * Math.PI) / 180)) / Math.tan((vFov * Math.PI) / 360);
    expect(r1440).toBeCloseTo(100.7, 0);
    expect(gap()).toBeCloseTo(r1440 - HUD.crosshair.gapPx, 1);
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 1080 });
    window.dispatchEvent(new Event('resize'));
    hud.setSpreadCone(4.5, vFov);
    expect(gap()).toBeCloseTo((r1440 * 1080) / 1440 - HUD.crosshair.gapPx, 1);
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

  it('does not count a pause as one long frame in the FPS counter', () => {
    let now = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      settings.update('graphics', { showFps: true });
      const fps = root.querySelector('.hud-fps') as HTMLElement;
      const frameMs = 1000 / 60;
      const run = (frames: number): void => {
        for (let i = 0; i < frames; i++) {
          hud.update(frameMs / 1000, 0);
          now += frameMs;
        }
      };
      run(30);
      expect(fps.textContent).toBe('60 FPS');
      // Paused for 10 s: update() does not run, then the game resumes.
      now += 10_000;
      events.emit('game:resumed', {});
      // Without the reset the first frame after resuming would show "0 FPS" (10 s for one frame).
      run(1);
      expect(fps.textContent).toBe('60 FPS');
      run(Math.ceil(1000 / HUD.fps.refreshHz / frameMs) + 1);
      expect(fps.textContent).toBe('60 FPS');
    } finally {
      spy.mockRestore();
    }
  });
});
