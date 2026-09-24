// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { PROGRESSION_TOASTS } from '../../defs/progression';
import { ProgressionToasts } from './ProgressionToasts';

const T = PROGRESSION_TOASTS;

describe('ProgressionToasts', () => {
  let layer: HTMLElement;
  let events: EventBus<GameEvents>;
  let toasts: ProgressionToasts;

  beforeEach(() => {
    layer = document.createElement('div');
    document.body.appendChild(layer);
    events = new EventBus<GameEvents>();
    toasts = new ProgressionToasts(layer, events);
  });

  afterEach(() => {
    toasts.dispose();
    layer.remove();
  });

  const visible = (): HTMLElement[] =>
    [...layer.querySelectorAll<HTMLElement>('.hud-ptoast')].filter((e) => !e.hidden);

  it('shows level ups, achievements, challenges and unlocks with German text', () => {
    events.emit('progression:levelUp', { level: 7, previous: 6, prestige: 0, skillPoints: 2 });
    events.emit('achievement:unlocked', {
      id: 'first_blood',
      name: 'Erstes Blut',
      description: 'Töte deinen ersten Gegner.',
      tier: 'bronze',
      hidden: false,
      xp: 250,
    });
    events.emit('challenge:completed', {
      id: 'd:1',
      period: 'daily',
      name: 'Kopfgeld',
      xp: 1800,
      currency: 12,
    });
    expect(toasts.shown).toEqual(['Stufe 7', 'Erstes Blut', 'Kopfgeld']);
    const [level, ach, ch] = visible();
    expect(level!.querySelector('.hud-ptoast__sub')!.textContent).toBe('2 Fertigkeitspunkte verfügbar');
    expect(ach!.querySelector('.hud-ptoast__kicker')!.textContent).toBe('Erfolg · Bronze');
    expect(ch!.querySelector('.hud-ptoast__sub')!.textContent).toBe('+1.800 XP · +12 Splitter');
    expect(ch!.classList.contains('hud-ptoast--challenge')).toBe(true);
  });

  it('queues beyond the visible slots and advances on game time', () => {
    for (let i = 0; i < T.visible + 2; i++) {
      events.emit('progression:unlock', {
        kind: 'charm',
        id: `c${i}`,
        name: `Anhänger ${i}`,
        weaponId: null,
      });
    }
    expect(visible()).toHaveLength(T.visible);
    expect(toasts.pending).toBe(T.visible + 2);
    toasts.update(T.duration + 0.01);
    expect(visible()[0]!.classList.contains('is-out')).toBe(true);
    toasts.update(T.outSeconds);
    expect(toasts.shown).toEqual(['Anhänger 3', 'Anhänger 4']);
    toasts.update(0); // paused frames change nothing
    expect(toasts.pending).toBe(2);
  });

  it('drops the oldest queued toasts beyond the queue limit', () => {
    for (let i = 0; i < T.visible + T.maxQueued + 3; i++) {
      events.emit('progression:levelUp', { level: i + 2, previous: i + 1, prestige: 0, skillPoints: 0 });
    }
    expect(toasts.pending).toBe(T.visible + T.maxQueued);
  });

  it('toasts weapon levels only at milestones and names camo weapons', () => {
    events.emit('progression:weaponLevelUp', { weaponId: 'rifle', level: 3, maxLevel: 30 });
    expect(toasts.pending).toBe(0);
    events.emit('progression:weaponLevelUp', { weaponId: 'rifle', level: T.weaponLevelStep, maxLevel: 30 });
    events.emit('progression:unlock', { kind: 'camo', id: 'camo.gold', name: 'Gold', weaponId: 'rifle' });
    expect(toasts.shown).toHaveLength(2);
    expect(visible()[1]!.querySelector('.hud-ptoast__kicker')!.textContent).toBe('Freigeschaltet · Tarnung');
    expect(visible()[1]!.querySelector('.hud-ptoast__sub')!.textContent).not.toBe('');
    toasts.clear();
    expect(visible()).toHaveLength(0);
  });
});
