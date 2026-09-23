// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents, HitZone } from '../../core/events';
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

function damage(
  events: EventBus<GameEvents>,
  opts: {
    targetId?: number;
    amount?: number;
    zone?: HitZone;
    killed?: boolean;
    source?: 'player' | 'enemy';
    z?: number;
  } = {},
): void {
  events.emit('combat:damage', {
    targetId: opts.targetId ?? 1,
    amount: opts.amount ?? 25,
    zone: opts.zone ?? 'body',
    point: { x: 0, y: 1.7, z: opts.z ?? -8 },
    killed: opts.killed ?? false,
    weaponId: 'rifle',
    element: 'physical',
    source: opts.source ?? 'player',
  });
}

describe('Hud – combat feedback', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let hud: Hud;
  let camera: PerspectiveCamera;

  beforeEach(() => {
    root = document.createElement('div');
    events = new EventBus<GameEvents>();
    settings = makeSettings(events);
    hud = new Hud(root, events, settings);
    camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
    camera.position.set(0, 1.7, 0);
    hud.setCamera(camera);
  });

  afterEach(() => hud.dispose());

  const marker = (): HTMLElement => root.querySelector('.hud-hitmarker') as HTMLElement;
  const visibleNumbers = (): HTMLElement[] =>
    ([...root.querySelectorAll('.hud-dmgnum')] as HTMLElement[]).filter((e) => Number(e.style.opacity) > 0);

  it('shows the hitmarker variant for the player’s hits only', () => {
    damage(events, { source: 'enemy' });
    hud.update(1 / 60, 0);
    expect(Number(marker().style.opacity)).toBe(0);
    damage(events, { zone: 'head' });
    hud.update(1 / 60, 0);
    expect(marker().classList.contains('hm--crit')).toBe(true);
    expect(Number(marker().style.opacity)).toBeGreaterThan(0.9);
    damage(events, { killed: true });
    hud.update(1 / 60, 0);
    expect(marker().classList.contains('hm--kill')).toBe(true);
    expect(marker().classList.contains('hm--crit')).toBe(false);
    hud.update(1, 0);
    expect(Number(marker().style.opacity)).toBe(0);
  });

  it('ignores hits that did no damage (immune zone, depleted target)', () => {
    damage(events, { amount: 0 });
    hud.update(1 / 60, 0);
    expect(Number(marker().style.opacity)).toBe(0);
    expect(visibleNumbers().length).toBe(0);
  });

  it('floats merged damage numbers above the hit point, projected with the camera', () => {
    damage(events, { amount: 14 });
    damage(events, { amount: 14 });
    damage(events, { amount: 14, zone: 'head' });
    hud.update(1 / 60, 0);
    const nums = visibleNumbers();
    expect(nums.length).toBe(1);
    expect(nums[0]!.textContent).toBe('42');
    expect(nums[0]!.classList.contains('is-crit')).toBe(true);
    const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(nums[0]!.style.transform)!;
    // Straight ahead: horizontally near the center (± jitter), just above the center (rising).
    expect(Math.abs(Number(m[1]) - window.innerWidth / 2)).toBeLessThanOrEqual(
      HUD.damageNumbers.jitterPx + 1,
    );
    const above = window.innerHeight / 2 - Number(m[2]);
    expect(above).toBeGreaterThan(0);
    expect(above).toBeLessThan(HUD.damageNumbers.risePx * 0.1);
    // A hit behind the camera is hidden.
    damage(events, { targetId: 2, z: 8 });
    hud.update(1 / 60, 0);
    expect(visibleNumbers().length).toBe(1);
    hud.update(HUD.damageNumbers.lifetime, 0);
    expect(visibleNumbers().length).toBe(0);
  });

  it('follows the hitmarker / damage number settings', () => {
    settings.update('gameplay', { hitmarkers: false, damageNumbers: false });
    damage(events);
    hud.update(1 / 60, 0);
    expect(marker().hidden).toBe(true);
    expect(visibleNumbers().length).toBe(0);
    settings.update('gameplay', { hitmarkers: true, damageNumbers: true });
    damage(events);
    hud.update(1 / 60, 0);
    expect(marker().hidden).toBe(false);
    expect(visibleNumbers().length).toBe(1);
  });

  it('confirms kills with a label and a streak counter', () => {
    const kill = root.querySelector('.hud-kill') as HTMLElement;
    const emitKill = (zone: HitZone): void =>
      events.emit('combat:kill', {
        targetId: 1,
        zone,
        weaponId: 'pistol',
        position: { x: 0, y: 0, z: -5 },
        source: 'player',
      });
    emitKill('body');
    hud.update(1 / 60, 0);
    expect(Number(kill.style.opacity)).toBeGreaterThan(0.9);
    expect(kill.querySelector('.hud-kill__label')!.textContent).toBe(HUD.killConfirm.labels.kill);
    expect(kill.classList.contains('has-streak')).toBe(false);
    emitKill('head');
    hud.update(1 / 60, 0);
    expect(kill.querySelector('.hud-kill__label')!.textContent).toBe(HUD.killConfirm.labels.head);
    expect(kill.querySelector('.hud-kill__count')!.textContent).toBe('×2');
    expect(kill.classList.contains('has-streak')).toBe(true);
    hud.update(HUD.killConfirm.duration, 0);
    expect(Number(kill.style.opacity)).toBe(0);
  });

  it('shows ammo with low / empty states and the reload prompts', () => {
    const ammo = root.querySelector('.hud-ammo') as HTMLElement;
    const prompt = root.querySelector('.hud-prompt') as HTMLElement;
    const ammoEvt = (mag: number, reserve: number): void =>
      events.emit('weapon:ammoChanged', { weaponId: 'rifle', mag, reserve, magSize: 32 });
    expect(ammo.classList.contains('hud-placeholder')).toBe(true);
    ammoEvt(20, 100);
    expect(ammo.querySelector('.hud-ammo__mag')!.textContent).toBe('20');
    expect(ammo.querySelector('.hud-ammo__reserve')!.textContent).toBe('100');
    expect(ammo.classList.contains('hud-placeholder')).toBe(false);
    expect((ammo.querySelector('.hud-ammo__fill') as HTMLElement).style.transform).toBe('scaleX(0.625)');
    expect(prompt.hidden).toBe(true);
    ammoEvt(5, 100);
    expect(ammo.classList.contains('is-low')).toBe(true);
    ammoEvt(0, 100);
    expect(ammo.classList.contains('is-empty')).toBe(true);
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toBe(HUD.ammo.prompts.reload);
    events.emit('weapon:reloadStart', { weaponId: 'rifle', empty: true, duration: 2 });
    expect(prompt.hidden).toBe(true);
    events.emit('weapon:reloadEnd', { weaponId: 'rifle', completed: false });
    expect(prompt.hidden).toBe(false);
    ammoEvt(0, 0);
    expect(prompt.textContent).toBe(HUD.ammo.prompts.empty);
    expect(prompt.classList.contains('is-empty')).toBe(true);
    events.emit('weapon:dryFire', { weaponId: 'rifle' });
    expect(ammo.classList.contains('is-dry')).toBe(true);
    // Every click restarts the shake: the animation class alternates.
    const phaseA = ammo.classList.contains('is-dry-a');
    expect(phaseA || ammo.classList.contains('is-dry-b')).toBe(true);
    events.emit('weapon:dryFire', { weaponId: 'rifle' });
    expect(ammo.classList.contains('is-dry-a')).toBe(!phaseA);
    expect(ammo.classList.contains('is-dry-b')).toBe(phaseA);
    hud.update(HUD.ammo.dryFlashSeconds + 0.01, 0);
    expect(ammo.classList.contains('is-dry')).toBe(false);
    expect(ammo.classList.contains('is-dry-a') || ammo.classList.contains('is-dry-b')).toBe(false);
  });

  it('shows the weapon name and highlights the current slot', () => {
    events.emit('weapon:inventoryChanged', { slots: ['pistol', 'rifle', null], current: 0 });
    events.emit('weapon:equipStart', { weaponId: 'rifle', slot: 1, duration: 0.5, previous: 'pistol' });
    const name = root.querySelector('.hud-weapon__name')!;
    expect(name.textContent).toContain('KR-7');
    const slots = [...root.querySelectorAll('.hud-slot')] as HTMLElement[];
    expect(slots.length).toBe(3);
    expect(slots[1]!.classList.contains('is-current')).toBe(true);
    expect(slots[0]!.classList.contains('is-current')).toBe(false);
    expect(slots[2]!.classList.contains('is-empty')).toBe(true);
    expect(slots[0]!.querySelector('.hud-slot__name')!.textContent).toBe('VX-9');
    expect((root.querySelector('.hud-weapon') as HTMLElement).hidden).toBe(false);
  });

  it('fades the crosshair while aiming down sights', () => {
    const xh = root.querySelector('.hud-crosshair') as HTMLElement;
    hud.setAds(0);
    expect(xh.style.opacity).toBe('');
    hud.setAds(1);
    expect(Number(xh.style.opacity)).toBe(0);
    hud.setAds(0.5);
    const mid = Number(xh.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    hud.setAds(0);
    expect(xh.style.opacity).toBe('');
  });
});
