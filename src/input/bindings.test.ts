import { describe, expect, it } from 'vitest';
import { ACTIONS, DEFAULT_BINDINGS, GAMEPAD, INPUT, PAD, type Binding, type BindingMap } from '../defs/input';
import {
  actionBindingSummary,
  actionLabel,
  ACTION_GROUPS,
  bindingEquals,
  bindingFamily,
  bindingLabel,
  cloneBindingMap,
  getSlotBinding,
  isConsoleToggleKey,
  isReservedKey,
  isValidBindingMap,
  learnedLayout,
  learnPrintedKey,
  parseBinding,
  sanitizeBindings,
  setBinding,
} from './bindings';

const key = (code: string): Binding => ({ device: 'key', code });
const pad = (button: number): Binding => ({ device: 'pad', button });

describe('bindingLabel', () => {
  it('uses German names', () => {
    expect(bindingLabel(key('Space'))).toBe('Leertaste');
    expect(bindingLabel(key('ShiftLeft'))).toBe('Umschalt links');
    expect(bindingLabel(key('ControlLeft'))).toBe('Strg links');
    expect(bindingLabel(key('KeyW'))).toBe('W');
    expect(bindingLabel(key('Digit3'))).toBe('3');
    expect(bindingLabel(key('Numpad4'))).toBe('Num 4');
    expect(bindingLabel(key('F5'))).toBe('F5');
    expect(bindingLabel({ device: 'mouse', button: 0 })).toBe('Linke Maustaste');
    expect(bindingLabel({ device: 'mouse', button: 2 })).toBe('Rechte Maustaste');
    expect(bindingLabel({ device: 'mouse', button: 7 })).toBe('Maustaste 8');
    expect(bindingLabel({ device: 'wheel', direction: 'up' })).toBe('Mausrad hoch');
    expect(bindingLabel({ device: 'wheel', direction: 'down' })).toBe('Mausrad runter');
    expect(bindingLabel(pad(PAD.A))).toBe('Pad A');
    expect(bindingLabel(pad(PAD.RT))).toBe('Pad RT');
    expect(bindingLabel({ device: 'padAxis', axis: 1, direction: -1 })).toBe('Pad L-Stick hoch');
    expect(bindingLabel({ device: 'padAxis', axis: 2, direction: 1 })).toBe('Pad R-Stick rechts');
  });

  it('prefers the printed character of the user layout for character keys', () => {
    const layout = new Map([
      ['KeyZ', 'y'],
      ['Backquote', '^'],
      ['Space', ' '],
    ]);
    expect(bindingLabel(key('KeyZ'), layout)).toBe('Y');
    expect(bindingLabel(key('Backquote'), layout)).toBe('^');
    // Named keys keep their German name.
    expect(bindingLabel(key('Space'), layout)).toBe('Leertaste');
    // German "ß" must not turn into "SS"; umlauts are upper-cased.
    const de = new Map([
      ['Minus', 'ß'],
      ['Semicolon', 'ö'],
    ]);
    expect(bindingLabel(key('Minus'), de)).toBe('ß');
    expect(bindingLabel(key('Semicolon'), de)).toBe('Ö');
  });
});

describe('actionLabel', () => {
  it('has a German label for every action and every action is grouped once', () => {
    for (const a of ACTIONS) expect(actionLabel(a)).not.toBe(a);
    const grouped = ACTION_GROUPS.flatMap((g) => g.actions);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...ACTIONS].sort());
  });
});

describe('parseBinding / sanitizeBindings', () => {
  it('validates entries', () => {
    expect(parseBinding({ device: 'key', code: 'KeyW' })).toEqual(key('KeyW'));
    expect(parseBinding({ device: 'key', code: '' })).toBeNull();
    // Backquote is the Mac ISO "<" key (on other layouts it toggles the console and never fires).
    expect(parseBinding({ device: 'key', code: 'Backquote' })).toEqual(key('Backquote'));
    expect(parseBinding({ device: 'key', code: 'F3' })).toBeNull(); // fixed debug key
    expect(parseBinding({ device: 'mouse', button: 1.5 })).toBeNull();
    // Limits match what the input system tracks (and what the settings sanitizer keeps).
    expect(parseBinding({ device: 'mouse', button: INPUT.maxMouseButtons - 1 })).not.toBeNull();
    expect(parseBinding({ device: 'mouse', button: INPUT.maxMouseButtons })).toBeNull();
    expect(parseBinding({ device: 'pad', button: GAMEPAD.maxButtons })).toBeNull();
    expect(parseBinding({ device: 'padAxis', axis: GAMEPAD.maxAxes, direction: 1 })).toBeNull();
    expect(parseBinding({ device: 'wheel', direction: 'left' })).toBeNull();
    expect(parseBinding({ device: 'padAxis', axis: 0, direction: 2 })).toBeNull();
    expect(parseBinding({ device: 'padAxis', axis: 0, direction: -1 })).toEqual({
      device: 'padAxis',
      axis: 0,
      direction: -1,
    });
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding('KeyW')).toBeNull();
  });

  it('restores missing actions, drops unknown ones and removes invalid entries', () => {
    const raw = {
      jump: [key('KeyJ'), { device: 'key' }, key('KeyJ'), 42],
      bogusAction: [key('KeyX')],
      fire: 'nope',
      melee: [],
    };
    const map = sanitizeBindings(raw);
    expect(Object.keys(map).sort()).toEqual([...ACTIONS].sort());
    expect(map.jump).toEqual([key('KeyJ')]);
    expect(map.fire).toEqual(DEFAULT_BINDINGS.fire);
    expect(map.moveForward).toEqual(DEFAULT_BINDINGS.moveForward);
    expect(map.melee).toEqual([]);
    expect((map as Record<string, unknown>).bogusAction).toBeUndefined();
    expect(isValidBindingMap(map)).toBe(true);
    expect(isValidBindingMap(raw)).toBe(false);
  });

  it('caps each family at primary + secondary and orders keyboard before gamepad', () => {
    const map = sanitizeBindings({ jump: [pad(0), key('KeyA'), key('KeyB'), key('KeyC'), pad(1), pad(2)] });
    expect(map.jump).toEqual([key('KeyA'), key('KeyB'), pad(0), pad(1)]);
  });

  it('handles garbage input', () => {
    expect(sanitizeBindings(undefined)).toEqual(DEFAULT_BINDINGS);
    expect(sanitizeBindings('x')).toEqual(DEFAULT_BINDINGS);
  });

  it('keeps the defaults valid', () => {
    expect(isValidBindingMap(DEFAULT_BINDINGS)).toBe(true);
    expect(sanitizeBindings(DEFAULT_BINDINGS)).toEqual(DEFAULT_BINDINGS);
  });
});

describe('setBinding', () => {
  const base = (): BindingMap => cloneBindingMap(DEFAULT_BINDINGS);

  it('assigns a free binding without conflicts and does not mutate the input', () => {
    const map = base();
    const before = JSON.stringify(map);
    const { map: next, conflicts } = setBinding(map, 'jump', { family: 'kbm', index: 0 }, key('KeyJ'));
    expect(conflicts).toEqual([]);
    expect(getSlotBinding(next, 'jump', { family: 'kbm', index: 0 })).toEqual(key('KeyJ'));
    // Gamepad binding untouched.
    expect(getSlotBinding(next, 'jump', { family: 'pad', index: 0 })).toEqual(pad(PAD.A));
    expect(JSON.stringify(map)).toBe(before);
  });

  it('swaps with the action that owned the binding', () => {
    const { map, conflicts } = setBinding(base(), 'jump', { family: 'kbm', index: 0 }, key('KeyQ'));
    expect(getSlotBinding(map, 'jump', { family: 'kbm', index: 0 })).toEqual(key('KeyQ'));
    // dash had Q; it receives jump's previous Space.
    expect(getSlotBinding(map, 'dash', { family: 'kbm', index: 0 })).toEqual(key('Space'));
    expect(conflicts).toEqual([{ action: 'dash', binding: key('KeyQ'), swappedIn: key('Space') }]);
  });

  it('removes the binding from the other action when the slot was empty', () => {
    const { map, conflicts } = setBinding(base(), 'jump', { family: 'kbm', index: 1 }, key('KeyQ'));
    expect(map.jump).toEqual([key('Space'), key('KeyQ'), pad(PAD.A)]);
    expect(map.dash).toEqual([pad(PAD.RB)]);
    expect(conflicts).toEqual([{ action: 'dash', binding: key('KeyQ'), swappedIn: null }]);
  });

  it('swaps primary and secondary within the same action', () => {
    const { map, conflicts } = setBinding(base(), 'moveForward', { family: 'kbm', index: 1 }, key('KeyW'));
    expect(map.moveForward).toEqual([key('ArrowUp'), key('KeyW')]);
    expect(conflicts).toEqual([]);
  });

  it('reports every action sharing a binding but hands the old binding to only one (pad X)', () => {
    const { map, conflicts } = setBinding(base(), 'melee', { family: 'pad', index: 0 }, pad(PAD.X));
    expect(getSlotBinding(map, 'melee', { family: 'pad', index: 0 })).toEqual(pad(PAD.X));
    expect(conflicts.map((c) => c.action).sort()).toEqual(['interact', 'reload']);
    expect(getSlotBinding(map, 'reload', { family: 'pad', index: 0 })).toEqual(pad(PAD.RS));
    // R-stick press must not land on two actions: interact simply loses X.
    expect(getSlotBinding(map, 'interact', { family: 'pad', index: 0 })).toBeNull();
    expect(conflicts.find((c) => c.action === 'interact')?.swappedIn).toBeNull();
  });

  it('never swaps a binding in that another action still owns', () => {
    // reload's X is shared with interact: weaponNext (had Y) must not receive X as well.
    const { map, conflicts } = setBinding(base(), 'reload', { family: 'pad', index: 0 }, pad(PAD.Y));
    expect(getSlotBinding(map, 'reload', { family: 'pad', index: 0 })).toEqual(pad(PAD.Y));
    expect(getSlotBinding(map, 'interact', { family: 'pad', index: 0 })).toEqual(pad(PAD.X));
    expect(getSlotBinding(map, 'weaponNext', { family: 'pad', index: 0 })).toBeNull();
    expect(conflicts).toEqual([{ action: 'weaponNext', binding: pad(PAD.Y), swappedIn: null }]);
    const owners = (b: Binding): number =>
      ACTIONS.filter((a) => map[a].some((x) => bindingEquals(x, b))).length;
    expect(owners(pad(PAD.X))).toBe(1);
  });

  it('clears a slot with null', () => {
    const { map } = setBinding(base(), 'moveForward', { family: 'kbm', index: 0 }, null);
    expect(map.moveForward).toEqual([key('ArrowUp')]);
  });

  it('does not put crouch on Ctrl by default (Ctrl+Tab / Ctrl+W close or switch the tab)', () => {
    const ctrl = ['ControlLeft', 'ControlRight'];
    for (const a of ACTIONS) {
      expect(DEFAULT_BINDINGS[a].some((b) => b.device === 'key' && ctrl.includes(b.code))).toBe(false);
    }
  });

  it('rejects a binding of the wrong family', () => {
    const { map, conflicts } = setBinding(base(), 'jump', { family: 'pad', index: 0 }, key('KeyJ'));
    expect(map.jump).toEqual(DEFAULT_BINDINGS.jump);
    expect(conflicts).toEqual([]);
  });

  it('is a no-op when assigning the binding already in the slot', () => {
    const { map, conflicts } = setBinding(base(), 'jump', { family: 'kbm', index: 0 }, key('Space'));
    expect(map).toEqual(DEFAULT_BINDINGS);
    expect(conflicts).toEqual([]);
  });
});

describe('helpers', () => {
  it('classifies families and equality', () => {
    expect(bindingFamily(key('KeyA'))).toBe('kbm');
    expect(bindingFamily({ device: 'wheel', direction: 'up' })).toBe('kbm');
    expect(bindingFamily({ device: 'padAxis', axis: 0, direction: 1 })).toBe('pad');
    expect(bindingEquals(key('KeyA'), key('KeyA'))).toBe(true);
    expect(bindingEquals(key('KeyA'), pad(0))).toBe(false);
  });

  it('summarises bindings per family', () => {
    expect(actionBindingSummary(DEFAULT_BINDINGS, 'moveForward', 'kbm')).toBe('W / Pfeil hoch');
    expect(actionBindingSummary(DEFAULT_BINDINGS, 'weapon1', 'pad')).toBe('—');
  });

  it('recognises the console toggle key incl. dead keys and the Mac ISO fallback', () => {
    expect(isConsoleToggleKey('Backquote', 'Dead')).toBe(true);
    expect(isConsoleToggleKey('Backquote', '`')).toBe(true);
    expect(isConsoleToggleKey('IntlBackslash', '^')).toBe(true);
    expect(isConsoleToggleKey('IntlBackslash', 'Dead')).toBe(true);
    // German PC layout: IntlBackslash is "<" and must stay usable.
    expect(isConsoleToggleKey('IntlBackslash', '<')).toBe(false);
    expect(isConsoleToggleKey('', '^')).toBe(true);
    expect(isConsoleToggleKey('Equal', 'Dead')).toBe(false);
    expect(isConsoleToggleKey('KeyA', 'a')).toBe(false);
    // Mac ISO: the "<" key next to left Shift reports Backquote – an ordinary key.
    expect(isConsoleToggleKey('Backquote', '<')).toBe(false);
    expect(isConsoleToggleKey('Backquote', '>')).toBe(false);
    // Other PC layouts print other characters on Backquote and must keep the console.
    expect(isConsoleToggleKey('Backquote', '²')).toBe(true);
    expect(isConsoleToggleKey('Backquote', '§')).toBe(true);
  });

  it('reserves only the debug key and the console toggle', () => {
    expect(isReservedKey('F3', 'F3')).toBe(true);
    expect(isReservedKey('Backquote', 'Dead')).toBe(true);
    expect(isReservedKey('Backquote', '<')).toBe(false);
    expect(isReservedKey('KeyW', 'w')).toBe(false);
  });

  it('labels keys by what they printed when no layout map exists (Firefox/Safari)', () => {
    // German QWERTZ: the physical US "Y" position prints "z", ";" prints "ö".
    learnPrintedKey('KeyY', 'z');
    learnPrintedKey('Semicolon', 'ö');
    learnPrintedKey('Minus', 'ß');
    learnPrintedKey('Space', ' '); // named keys are never learned
    learnPrintedKey('KeyQ', 'Dead');
    expect(bindingLabel(key('KeyY'), learnedLayout)).toBe('Z');
    expect(bindingLabel(key('Semicolon'), learnedLayout)).toBe('Ö');
    expect(bindingLabel(key('Minus'), learnedLayout)).toBe('ß');
    expect(bindingLabel(key('Space'), learnedLayout)).toBe('Leertaste');
    expect(learnedLayout.has('KeyQ')).toBe(false);
  });
});
