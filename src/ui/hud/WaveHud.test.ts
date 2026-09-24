// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { HUD } from '../../defs/ui';
import { createDefaultSettings, type Settings, type SettingsSection } from '../../save/settingsSchema';
import { Hud } from './Hud';
import { WaveHud } from './WaveHud';

const W = HUD.wave;

describe('WaveHud', () => {
  let corner: HTMLElement;
  let layer: HTMLElement;
  let events: EventBus<GameEvents>;
  let hud: WaveHud;

  const q = (sel: string): HTMLElement => layer.querySelector<HTMLElement>(sel)!;
  const marksOn = (): number => layer.querySelectorAll('.hud-wave__mark.is-on').length;

  beforeEach(() => {
    layer = document.createElement('div');
    corner = document.createElement('div');
    layer.appendChild(corner);
    document.body.appendChild(layer);
    events = new EventBus<GameEvents>();
    hud = new WaveHud(corner, layer, events);
  });

  afterEach(() => {
    hud.dispose();
    layer.remove();
  });

  it('starts as a placeholder with nothing else shown', () => {
    expect(hud.wave).toBeNull();
    expect(q('.hud-wave').classList.contains('hud-placeholder')).toBe(true);
    expect(q('.hud-wave__value').textContent).toBe('—');
    expect(q('.hud-wave__remaining').hidden).toBe(true);
    expect(q('.hud-countdown').hidden).toBe(true);
    expect(q('.hud-banner').hidden).toBe(true);
  });

  it('counts the intermission down ("NÄCHSTE WELLE IN n") and turns urgent at the end', () => {
    events.emit('wave:intermission', { nextWave: 1, duration: 8 });
    expect(q('.hud-countdown').hidden).toBe(false);
    expect(q('.hud-countdown__label').textContent).toBe(W.labels.countdown);
    expect(q('.hud-countdown__value').textContent).toBe('8');
    expect(q('.hud-countdown').classList.contains('is-urgent')).toBe(false);
    hud.update(2.5);
    expect(q('.hud-countdown__value').textContent).toBe('6');
    hud.update(1.5);
    expect(q('.hud-countdown__value').textContent).toBe(String(W.countdownUrgentSeconds - 1));
    expect(q('.hud-countdown').classList.contains('is-urgent')).toBe(true);
    const value = q('.hud-countdown__value');
    const tick = value.classList.contains('is-tick-a') ? 'is-tick-a' : 'is-tick-b';
    hud.update(1);
    // Every urgent second restarts the pulse with the other class.
    expect(value.classList.contains(tick)).toBe(false);
    hud.update(10);
    expect(q('.hud-countdown__value').textContent).toBe('0');
  });

  it('shows the wave with tally marks, remaining enemies and the start banner', () => {
    events.emit('wave:intermission', { nextWave: 1, duration: 5 });
    events.emit('wave:start', { wave: 1, total: 8, kind: 'normal' });
    expect(hud.wave).toBe(1);
    expect(q('.hud-countdown').hidden).toBe(true);
    expect(q('.hud-wave').classList.contains('hud-placeholder')).toBe(false);
    expect(q('.hud-wave__tally').hidden).toBe(false);
    expect(q('.hud-wave__value').hidden).toBe(true);
    expect(marksOn()).toBe(1);
    const first = layer.querySelectorAll('.hud-wave__mark')[0]!;
    expect(first.classList.contains('is-fresh-a') || first.classList.contains('is-fresh-b')).toBe(true);
    expect(q('.hud-wave__remaining').hidden).toBe(false);
    expect(q('.hud-wave__count').textContent).toBe('8');
    expect(q('.hud-banner').hidden).toBe(false);
    expect(q('.hud-banner__title').textContent).toBe(`${W.labels.wave} 1`);
    expect(q('.hud-banner__sub').hidden).toBe(true);

    events.emit('wave:progress', { wave: 1, remaining: 5, alive: 3 });
    expect(q('.hud-wave__count').textContent).toBe('5');
    hud.update(W.bannerStartSeconds + 0.01);
    expect(q('.hud-banner').hidden).toBe(true);
  });

  it('announces special waves and the completed wave', () => {
    events.emit('wave:start', { wave: 5, total: 24, kind: 'tank' });
    expect(q('.hud-banner__sub').textContent).toBe(W.kindLabels.tank);
    expect(q('.hud-banner').classList.contains('hud-banner--tank')).toBe(true);
    events.emit('wave:complete', { wave: 5, duration: 60 });
    expect(q('.hud-banner__title').textContent).toBe(`${W.labels.wave} 5`);
    expect(q('.hud-banner__sub').textContent).toBe(W.labels.complete);
    expect(q('.hud-banner').classList.contains('hud-banner--complete')).toBe(true);
    expect(q('.hud-banner').classList.contains('hud-banner--tank')).toBe(false);
    expect(q('.hud-wave__remaining').hidden).toBe(true);
    events.emit('wave:start', { wave: 6, total: 36, kind: 'swarm' });
    expect(q('.hud-banner__sub').textContent).toBe(W.kindLabels.swarm);
  });

  it('switches from tally marks to a slammed-in numeral after the fifth wave', () => {
    for (let w = 1; w <= W.tallyMax; w++) events.emit('wave:start', { wave: w, total: 10 });
    expect(marksOn()).toBe(W.tallyMax);
    events.emit('wave:start', { wave: W.tallyMax + 1, total: 10 });
    expect(q('.hud-wave__tally').hidden).toBe(true);
    const value = q('.hud-wave__value');
    expect(value.hidden).toBe(false);
    expect(value.textContent).toBe(String(W.tallyMax + 1));
    const fresh = value.classList.contains('is-fresh-a') ? 'is-fresh-a' : 'is-fresh-b';
    events.emit('wave:start', { wave: W.tallyMax + 2, total: 10 });
    // The other animation class restarts the slam.
    expect(value.classList.contains(fresh)).toBe(false);
    // A jump back (dev console) shows the marks without drawing the old ones again.
    hud.setWave(3);
    expect(marksOn()).toBe(3);
  });

  it('resets on run:restart and hides countdown + banner on run:over', () => {
    events.emit('wave:intermission', { nextWave: 2, duration: 10 });
    events.emit('wave:start', { wave: 2, total: 10 });
    events.emit('run:over', {
      mapId: 'lab',
      mode: 'classic',
      wave: 2,
      kills: 3,
      headshots: 1,
      shotsFired: 10,
      shotsHit: 5,
      timeSurvived: 60,
      score: 100,
    });
    expect(q('.hud-banner').hidden).toBe(true);
    expect(q('.hud-countdown').hidden).toBe(true);
    events.emit('run:restart', {});
    expect(hud.wave).toBeNull();
    expect(marksOn()).toBe(0);
    expect(q('.hud-wave__value').textContent).toBe('—');
    expect(q('.hud-wave__remaining').hidden).toBe(true);
  });

  it("keeps the new run's countdown whatever order the run:restart listeners run in", () => {
    // The composition root's restart listener was registered first: it restarts the waves.
    const other = new EventBus<GameEvents>();
    const layer2 = document.createElement('div');
    const corner2 = document.createElement('div');
    layer2.appendChild(corner2);
    document.body.appendChild(layer2);
    other.on('run:restart', () => other.emit('wave:intermission', { nextWave: 1, duration: 6 }));
    const hud2 = new WaveHud(corner2, layer2, other);
    other.emit('wave:start', { wave: 4, total: 20 });
    other.emit('run:restart', {});
    expect(hud2.wave).toBeNull();
    expect(layer2.querySelector<HTMLElement>('.hud-countdown')!.hidden).toBe(false);
    expect(layer2.querySelector('.hud-countdown__value')!.textContent).toBe('6');
    expect(layer2.querySelector<HTMLElement>('.hud-banner')!.hidden).toBe(true);
    hud2.dispose();
    layer2.remove();
  });

  it('follows the director clock instead of its own frame count (dropped ticks, frozen director)', () => {
    let left = 8;
    hud.setCountdownSource(() => left);
    events.emit('wave:intermission', { nextWave: 2, duration: 8 });
    // A long frame: the HUD got 1 s of frame time, the tick-capped director only advanced 0.4 s.
    left = 7.6;
    hud.update(1);
    expect(q('.hud-countdown__value').textContent).toBe('8');
    // The player died: the director freezes, so does the countdown.
    left = 3.2;
    hud.update(0.5);
    hud.update(0.5);
    expect(q('.hud-countdown__value').textContent).toBe('4');
    left = -0.01;
    hud.update(1 / 60);
    expect(q('.hud-countdown__value').textContent).toBe('0');
    // Without a source the HUD counts frame time again.
    hud.setCountdownSource(null);
    events.emit('wave:intermission', { nextWave: 3, duration: 5 });
    hud.update(2);
    expect(q('.hud-countdown__value').textContent).toBe('3');
  });

  it('reset() clears a finished run (main menu → start emits no run:restart)', () => {
    events.emit('wave:start', { wave: 7, total: 40 });
    events.emit('wave:progress', { wave: 7, remaining: 12, alive: 9 });
    events.emit('wave:intermission', { nextWave: 8, duration: 14 });
    hud.reset();
    expect(hud.wave).toBeNull();
    expect(q('.hud-wave__value').textContent).toBe('—');
    expect(q('.hud-wave__remaining').hidden).toBe(true);
    expect(q('.hud-countdown').hidden).toBe(true);
    expect(q('.hud-banner').hidden).toBe(true);
  });

  it('writes nothing to the DOM while shown values stay the same', async () => {
    events.emit('wave:intermission', { nextWave: 3, duration: 9.5 });
    hud.update(0.2); // 9.3 s → still "10"
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(layer, { subtree: true, childList: true, attributes: true, characterData: true });
    for (let i = 0; i < 20; i++) hud.update(0.01); // 9.1 s → "10"
    events.emit('wave:progress', { wave: 2, remaining: 4, alive: 4 });
    events.emit('wave:progress', { wave: 2, remaining: 4, alive: 4 });
    await Promise.resolve();
    const writes = records.length;
    events.emit('wave:progress', { wave: 2, remaining: 4, alive: 3 }); // same remaining
    for (let i = 0; i < 20; i++) hud.update(0.001);
    await Promise.resolve();
    observer.disconnect();
    expect(records.length).toBe(writes);
    expect(writes).toBeLessThanOrEqual(3); // remaining shown once (text + hidden)
  });
});

describe('Hud damage direction with enemy hits', () => {
  function settings(events: EventBus<GameEvents>): SettingsStore {
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

  it('points at the enemy (EnemyManager direction convention, reused payload vector)', () => {
    const events = new EventBus<GameEvents>();
    const root = document.createElement('div');
    const hud = new Hud(root, events, settings(events));
    // EnemyManager.hitTarget: normalized (enemy − player eye), one shared vector for every hit.
    const shared = { x: 0, y: 0, z: 0 };
    const enemyAt = (x: number, z: number): void => {
      const len = Math.hypot(x, z);
      shared.x = x / len;
      shared.y = 0;
      shared.z = z / len;
      events.emit('player:damaged', { amount: 20, healthFraction: 0.8, direction: shared });
      // The emitter rewrites its vector for the next hit: the HUD must have copied what it needs.
      shared.x = 0;
      shared.z = 0;
    };
    const rotations = (): number[] =>
      [...root.querySelectorAll<HTMLElement>('.hud-damage__arc')]
        .map((el) => /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
    // Yaw 0 looks down −Z: an enemy in front is at 0°, one on the right (+X) at 90°.
    enemyAt(0, -5);
    enemyAt(4, 0);
    hud.update(1 / 60, 0);
    const r = rotations();
    expect(r.some((v) => Math.abs(v) < 1)).toBe(true);
    expect(r.some((v) => Math.abs(v - 90) < 1)).toBe(true);
    hud.dispose();
  });

  it('resetRun() clears the wave widgets and the hit feedback of the last run', () => {
    const events = new EventBus<GameEvents>();
    const root = document.createElement('div');
    const hud = new Hud(root, events, settings(events));
    events.emit('wave:start', { wave: 9, total: 60 });
    events.emit('wave:progress', { wave: 9, remaining: 30, alive: 20 });
    events.emit('player:damaged', { amount: 60, healthFraction: 0, direction: { x: 1, y: 0, z: 0 } });
    hud.update(1 / 60, 0);
    const visibleArcs = (): number =>
      [...root.querySelectorAll<HTMLElement>('.hud-damage__arc')].filter((el) => Number(el.style.opacity) > 0)
        .length;
    const flash = (): number => Number(root.querySelector<HTMLElement>('.hud-hit')!.style.opacity);
    expect(visibleArcs()).toBe(1);
    expect(flash()).toBeGreaterThan(0);
    hud.resetRun();
    hud.update(1 / 60, 0);
    expect(root.querySelector('.hud-wave__value')!.textContent).toBe('—');
    expect(root.querySelector<HTMLElement>('.hud-wave__remaining')!.hidden).toBe(true);
    expect(visibleArcs()).toBe(0);
    expect(flash()).toBe(0);
    hud.dispose();
  });
});
