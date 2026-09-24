// @vitest-environment jsdom
/** Werkbank menu DOM: rows per entry with group headings, selection detail, fitted / short states. */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { getWeaponDef } from '../../defs/weapons';
import { WORKBENCH_MENU } from '../../defs/workshop';
import { benchEntries } from '../../interactables/benchEntries';
import { WorkbenchMenu } from './WorkbenchMenu';

describe('WorkbenchMenu', () => {
  it('lists the entries, shows the selection detail and the fitted / unaffordable states', () => {
    const events = new EventBus<GameEvents>();
    const layer = document.createElement('div');
    const menu = new WorkbenchMenu(layer, events);
    expect(menu.el.hidden).toBe(true);
    const entries = benchEntries(getWeaponDef('rifle')!);
    menu.open('KR-7 „Wächter“', entries);
    expect(menu.el.hidden).toBe(false);
    const rows = menu.el.querySelectorAll('.hud-bench__row');
    expect(rows).toHaveLength(entries.length);
    const groups = new Set(entries.map((e) => e.group));
    expect(menu.el.querySelectorAll('.hud-bench__group')).toHaveLength(groups.size);
    expect(menu.el.querySelector('.hud-bench__weapon')!.textContent).toBe('KR-7 „Wächter“');

    menu.setSelected(3);
    expect(rows[3]!.classList.contains('is-selected')).toBe(true);
    expect(menu.el.querySelector('.hud-bench__desc')!.textContent).toBe(entries[3]!.description);
    expect(menu.el.querySelectorAll('.hud-bench__stat')).toHaveLength(entries[3]!.stats.length);

    const equipped = entries.map((_, i) => i === 0);
    menu.setStates(equipped, 800);
    expect(rows[0]!.classList.contains('is-equipped')).toBe(true);
    expect(rows[0]!.querySelector('.hud-bench__price')!.textContent).toBe(WORKBENCH_MENU.equipped);
    const pricey = entries.findIndex((e) => e.cost > 800);
    expect(rows[pricey]!.classList.contains('is-short')).toBe(true);

    // The last row scrolls into the window.
    menu.setSelected(entries.length - 1);
    const list = menu.el.querySelector<HTMLElement>('.hud-bench__list')!;
    expect(list.style.transform).toMatch(/translateY\(-\d+px\)/);

    menu.flash(3);
    expect(rows[3]!.className).toMatch(/is-flash-[ab]/);
    events.emit('input:deviceChanged', { device: 'gamepad' });
    expect(menu.el.querySelector('.hud-bench__key')!.textContent).toBe(WORKBENCH_MENU.hints.keysPad);
    menu.close();
    expect(menu.el.hidden).toBe(true);
    menu.dispose();
    expect(layer.childElementCount).toBe(0);
  });
});
