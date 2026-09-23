// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { createLogger } from '../../core/log';
import { DEV_CONSOLE } from '../../defs/ui';
import { DevConsole } from './DevConsole';

function lines(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.dev-console__line')].map((l) => l.textContent ?? '');
}

function pressKey(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('DevConsole', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let dc: DevConsole;
  let input: HTMLInputElement;

  beforeEach(() => {
    sessionStorage.clear();
    root = document.createElement('div');
    document.body.appendChild(root);
    events = new EventBus<GameEvents>();
    dc = new DevConsole(root, events);
    input = root.querySelector('input')!;
  });

  afterEach(() => {
    dc.dispose();
    root.remove();
  });

  it('toggles with the physical ^ key (dead key) and emits ui:console', () => {
    const states: boolean[] = [];
    events.on('ui:console', ({ open }) => states.push(open));
    const e = pressKey(window, { code: 'Backquote', key: 'Dead' });
    expect(e.defaultPrevented).toBe(true);
    expect(dc.open).toBe(true);
    expect(document.activeElement).toBe(input);
    pressKey(input, { key: 'Escape', code: 'Escape' });
    expect(dc.open).toBe(false);
    pressKey(window, { code: 'IntlBackslash', key: '^' });
    expect(dc.open).toBe(true);
    pressKey(window, { code: 'IntlBackslash', key: '<' }); // German "<" key must not toggle
    expect(dc.open).toBe(true);
    expect(states).toEqual([true, false, true]);
  });

  it('runs commands incl. quoting, async commands, errors and unknown commands', async () => {
    const got: string[][] = [];
    dc.register({ name: 'foo', aliases: ['f'], description: 'Test', run: (args) => void got.push(args) });
    dc.register({ name: 'later', description: 'Async', run: async () => 'fertig' });
    dc.register({
      name: 'boom',
      description: 'Fehler',
      usage: 'boom',
      run: () => {
        throw new Error('kaputt');
      },
    });
    await dc.execute('foo "a b" c; F x');
    expect(got).toEqual([['a b', 'c'], ['x']]);
    await dc.execute('later');
    await dc.execute('boom');
    await dc.execute('nope');
    await dc.execute('echo hallo   welt');
    const out = lines(root);
    expect(out).toContain('fertig');
    expect(out.some((l) => l.includes('kaputt') && l.includes('Verwendung'))).toBe(true);
    expect(out.some((l) => l.includes('Unbekannter Befehl') && l.includes('nope'))).toBe(true);
    expect(out).toContain('hallo welt');
  });

  it('lists commands with help and clears the output', async () => {
    dc.register({ name: 'noclip', description: 'Durch Wände', usage: 'noclip [on|off]', run: () => {} });
    await dc.execute('help');
    expect(lines(root).some((l) => l.includes('noclip [on|off]') && l.includes('echo'))).toBe(true);
    await dc.execute('help noclip');
    expect(lines(root).some((l) => l.startsWith('noclip – Durch Wände'))).toBe(true);
    await dc.execute('clear');
    expect(lines(root)).toEqual([]);
  });

  it('completes command names and arguments with Tab', () => {
    dc.register({
      name: 'preset',
      description: 'P',
      complete: () => ['low', 'medium', 'high', 'ultra'],
      run: () => {},
    });
    dc.toggle(true);
    input.value = 'pre';
    pressKey(input, { key: 'Tab' });
    expect(input.value).toBe('preset ');
    input.value = 'preset u';
    pressKey(input, { key: 'Tab' });
    expect(input.value).toBe('preset ultra ');
    // Only the last command of a chain is completed.
    input.value = 'echo a; pre';
    pressKey(input, { key: 'Tab' });
    expect(input.value).toBe('echo a; preset ');
    input.value = 'echo a;preset h';
    pressKey(input, { key: 'Tab' });
    expect(input.value).toBe('echo a; preset high ');
  });

  it('returns focus to the previously focused element when closing', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    dc.toggle(true);
    expect(document.activeElement).toBe(input);
    dc.toggle(false);
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it('keeps a history (Up/Down) persisted in sessionStorage', async () => {
    dc.toggle(true);
    for (const cmd of ['echo eins', 'echo zwei']) {
      input.value = cmd;
      pressKey(input, { key: 'Enter' });
    }
    await Promise.resolve();
    expect(JSON.parse(sessionStorage.getItem(DEV_CONSOLE.historyStorageKey)!)).toEqual([
      'echo eins',
      'echo zwei',
    ]);
    input.value = 'entwurf';
    pressKey(input, { key: 'ArrowUp' });
    expect(input.value).toBe('echo zwei');
    pressKey(input, { key: 'ArrowUp' });
    expect(input.value).toBe('echo eins');
    pressKey(input, { key: 'ArrowDown' });
    pressKey(input, { key: 'ArrowDown' });
    expect(input.value).toBe('entwurf');

    // A new console instance restores the session history.
    const root2 = document.createElement('div');
    const dc2 = new DevConsole(root2, events);
    const input2 = root2.querySelector('input')!;
    dc2.toggle(true);
    pressKey(input2, { key: 'ArrowUp' });
    expect(input2.value).toBe('echo zwei');
    dc2.dispose();
  });

  it('shows warnings from the core log as they arrive and collapses repeats', () => {
    const logger = createLogger('TestTag');
    logger.warn('Asset fehlt: foo');
    expect(lines(root).some((l) => l === '[TestTag] Asset fehlt: foo')).toBe(true);
    const before = lines(root).length;
    logger.warn('Asset fehlt: foo');
    logger.warn('Asset fehlt: foo');
    expect(lines(root).length).toBe(before);
    expect(lines(root).at(-1)).toBe('[TestTag] Asset fehlt: foo  (×3)');
  });
});
