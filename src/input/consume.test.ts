// @vitest-environment jsdom
/** InputSystem.consume (M5 Werkbank menu): a swallowed press reads as not pressed for the frame. */
import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createDefaultSettings } from '../save/settingsSchema';
import { InputSystem } from './InputSystem';

describe('InputSystem.consume', () => {
  let input: InputSystem | null = null;
  afterEach(() => input?.dispose());

  it('clears the frame edge only, held state stays; the next press comes through', () => {
    const events = new EventBus<GameEvents>();
    const settings = { current: createDefaultSettings(), update() {}, replace() {}, resetSection() {} };
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    input = new InputSystem(canvas, events, settings as unknown as SettingsStore);
    input.beginFrame(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
    input.endFrame();
    input.beginFrame(1 / 60);
    expect(input.pressed('ability')).toBe(true);
    input.consume('ability');
    expect(input.pressed('ability')).toBe(false);
    expect(input.isDown('ability')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
    input.endFrame();
    input.beginFrame(1 / 60);
    expect(input.pressed('ability')).toBe(true);
    canvas.remove();
  });
});
