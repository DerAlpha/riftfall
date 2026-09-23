// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CAMERA } from '../defs/camera';
import { PAD } from '../defs/input';
import { createDefaultSettings, type Settings, type SettingsSection } from '../save/settingsSchema';
import { InputSystem } from './InputSystem';

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

function key(type: 'keydown' | 'keyup', code: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...opts });
  window.dispatchEvent(e);
  return e;
}

function mouseMove(dx: number, dy: number): void {
  const e = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(e, 'movementX', { value: dx });
  Object.defineProperty(e, 'movementY', { value: dy });
  document.dispatchEvent(e);
}

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  buttons: { pressed: boolean; value: number; touched: boolean }[];
  axes: number[];
}

function fakePad(): FakePad {
  return {
    id: 'Test Pad',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    axes: [0, 0, 0, 0],
  };
}

describe('InputSystem', () => {
  let events: EventBus<GameEvents>;
  let settings: SettingsStore;
  let canvas: HTMLCanvasElement;
  let input: InputSystem;
  let now = 1000;

  const frame = (dt = 1 / 60): void => {
    input.endFrame();
    input.beginFrame(dt);
  };

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    events = new EventBus<GameEvents>();
    settings = makeSettings(events);
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    input = new InputSystem(canvas, events, settings);
    input.beginFrame(1 / 60);
  });

  afterEach(() => {
    input.dispose();
    canvas.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'getGamepads');
    Reflect.deleteProperty(document, 'pointerLockElement');
  });

  it('produces pressed / held / released edges from bindings', () => {
    key('keydown', 'Space');
    frame();
    expect(input.pressed('jump')).toBe(true);
    expect(input.isDown('jump')).toBe(true);
    frame();
    expect(input.pressed('jump')).toBe(false);
    expect(input.isDown('jump')).toBe(true);
    key('keyup', 'Space');
    frame();
    expect(input.released('jump')).toBe(true);
    expect(input.isDown('jump')).toBe(false);
  });

  it('never loses a tap inside one frame', () => {
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ');
    frame();
    expect(input.pressed('dash')).toBe(true);
    expect(input.isDown('dash')).toBe(false);
  });

  it('combines keyboard movement and clamps the diagonal', () => {
    key('keydown', 'KeyW');
    key('keydown', 'KeyD');
    frame();
    const m = input.getMove({ x: 0, y: 0 });
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(1, 6);
    expect(m.x).toBeGreaterThan(0);
    expect(m.y).toBeGreaterThan(0);
  });

  it('zeros everything when disabled and does not fire edges for keys held while re-enabling', () => {
    key('keydown', 'KeyW');
    frame();
    input.enabled = false;
    frame();
    expect(input.isDown('moveForward')).toBe(false);
    expect(input.getMove({ x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
    key('keydown', 'Space');
    frame();
    input.enabled = true;
    frame();
    expect(input.isDown('jump')).toBe(true);
    expect(input.pressed('jump')).toBe(false);
    expect(input.isDown('moveForward')).toBe(true);
  });

  it('ignores presses made while disabled but reports the first genuine press after re-enabling', () => {
    input.enabled = false;
    frame();
    // Space activating a menu button in the same frame the game resumes.
    key('keydown', 'Space');
    key('keyup', 'Space');
    input.enabled = true;
    frame();
    expect(input.pressed('jump')).toBe(false);
    key('keydown', 'Space');
    frame();
    expect(input.pressed('jump')).toBe(true);
  });

  it('prevents browser defaults for game keys but ignores fixed console/debug keys', () => {
    expect(key('keydown', 'Space').defaultPrevented).toBe(true);
    expect(key('keydown', 'Backquote', { key: 'Dead' }).defaultPrevented).toBe(false);
    expect(key('keydown', 'F3').defaultPrevented).toBe(false);
    frame();
    expect(input.pressed('jump')).toBe(true);
  });

  it('ignores typing into text fields', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    frame();
    expect(input.isDown('moveForward')).toBe(false);
    field.remove();
  });

  it('clears held keys on blur (no stuck keys)', () => {
    key('keydown', 'KeyW');
    frame();
    window.dispatchEvent(new Event('blur'));
    frame();
    expect(input.isDown('moveForward')).toBe(false);
    expect(input.released('moveForward')).toBe(true);
  });

  it('reacts to rebinding through settings:changed', () => {
    const bindings = structuredClone(settings.current.controls.bindings);
    bindings.jump = [{ device: 'key', code: 'KeyJ' }];
    settings.update('controls', { bindings });
    key('keydown', 'KeyJ');
    frame();
    expect(input.pressed('jump')).toBe(true);
    key('keydown', 'Space');
    frame();
    expect(input.isDown('jump')).toBe(true); // still via J
    key('keyup', 'KeyJ');
    frame();
    expect(input.isDown('jump')).toBe(false); // Space no longer bound
  });

  it('applies mouse look only while pointer locked, with sensitivity and spike filtering', () => {
    mouseMove(10, 0);
    frame();
    expect(input.getLook({ yaw: 0, pitch: 0 }).yaw).toBe(0);

    const locks: boolean[] = [];
    events.on('input:pointerLock', ({ locked }) => locks.push(locked));
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => canvas });
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(input.pointerLocked).toBe(true);
    expect(locks).toEqual([true]);

    mouseMove(800, 300); // first event after lock: the cursor jump
    now += 100;
    mouseMove(10, -5);
    frame();
    const look = input.getLook({ yaw: 0, pitch: 0 });
    const k = CAMERA.mouseRadiansPerCount * settings.current.controls.mouseSensitivity;
    expect(look.yaw).toBeCloseTo(10 * k, 9);
    expect(look.pitch).toBeCloseTo(5 * k, 9); // mouse up = look up
    settings.update('controls', { invertY: true });
    mouseMove(0, -5);
    frame();
    expect(input.getLook({ yaw: 0, pitch: 0 }).pitch).toBeCloseTo(-5 * k, 9);
    frame();
    expect(input.getLook({ yaw: 1, pitch: 1 })).toEqual({ yaw: 0, pitch: 0 });
  });

  it('captures a binding, ignores the triggering event and cancels with Escape', async () => {
    const p = input.captureBinding(1000);
    key('keydown', 'KeyK'); // same task as the call: must not be captured
    await new Promise((r) => setTimeout(r, 0));
    key('keydown', 'Backquote'); // fixed key: ignored
    const e = key('keydown', 'KeyL');
    expect(e.defaultPrevented).toBe(true);
    await expect(p).resolves.toEqual({ device: 'key', code: 'KeyL' });

    const p2 = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    key('keydown', 'Escape');
    await expect(p2).resolves.toBeNull();

    const p3 = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
    await expect(p3).resolves.toEqual({ device: 'mouse', button: 2 });
  });

  it('cancels a pending capture when gameplay resumes or on request, and captures the wheel only meanwhile', async () => {
    input.enabled = false; // menu open
    const p = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    input.enabled = true; // menu closed mid-capture
    await expect(p).resolves.toBeNull();
    expect(input.capturing).toBe(false);
    // Gameplay input works again (the capture no longer swallows it).
    key('keydown', 'Space');
    frame();
    expect(input.pressed('jump')).toBe(true);
    // Without a capture the wheel is never prevented at window level.
    const idle = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    const p2 = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    window.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    await expect(p2).resolves.toEqual({ device: 'wheel', direction: 'up' });

    const p3 = input.captureBinding(1000);
    input.cancelCapture();
    await expect(p3).resolves.toBeNull();
  });

  it('ignores mouse buttons it cannot track while capturing', async () => {
    const p = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 7, bubbles: true, cancelable: true }));
    expect(input.capturing).toBe(true);
    window.dispatchEvent(new MouseEvent('mousedown', { button: 4, bubbles: true, cancelable: true }));
    await expect(p).resolves.toEqual({ device: 'mouse', button: 4 });
  });

  it('does not stack pointer lock requests while one is pending', async () => {
    let resolveLock: () => void = () => {};
    const request = vi.fn(() => new Promise<void>((r) => (resolveLock = r)));
    Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: request });
    input.requestPointerLock();
    input.requestPointerLock(); // double click
    expect(request).toHaveBeenCalledTimes(1);
    resolveLock();
    await Promise.resolve();
    await Promise.resolve();
    input.requestPointerLock(); // settled but not locked (no pointerlockchange): a new request is allowed
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('falls back to a standard lock when raw mouse input is not supported', async () => {
    const calls: unknown[] = [];
    const request = vi.fn((opts?: unknown) => {
      calls.push(opts);
      if (opts) {
        const err = new Error('unadjustedMovement unsupported');
        err.name = 'NotSupportedError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
    Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: request });
    const locks: boolean[] = [];
    events.on('input:pointerLock', ({ locked }) => locks.push(locked));
    input.requestPointerLock();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(locks).toEqual([]); // no failure reported
  });

  it('polls the gamepad: stick movement, buttons, triggers, device switching and capture', async () => {
    const pad = fakePad();
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
    const devices: string[] = [];
    events.on('input:deviceChanged', ({ device }) => devices.push(device));
    const ev = new Event('gamepadconnected');
    Object.defineProperty(ev, 'gamepad', { value: pad });
    window.dispatchEvent(ev);

    pad.axes[1] = -1; // left stick fully up
    pad.buttons[PAD.A] = { pressed: true, value: 1, touched: true };
    pad.buttons[PAD.RT] = { pressed: true, value: 0.2, touched: true }; // below trigger threshold
    frame();
    expect(input.device).toBe('gamepad');
    expect(devices).toEqual(['gamepad']);
    const m = input.getMove({ x: 0, y: 0 });
    expect(m.y).toBeCloseTo(1, 5);
    expect(input.pressed('jump')).toBe(true);
    expect(input.isDown('fire')).toBe(false);
    expect(input.value('fire')).toBeCloseTo(0.2, 5);

    pad.buttons[PAD.RT] = { pressed: true, value: 0.9, touched: true };
    pad.axes[2] = 1; // right stick right → turn right
    frame(0.5);
    expect(input.isDown('fire')).toBe(true);
    const look = input.getLook({ yaw: 0, pitch: 0 });
    expect(look.yaw).toBeGreaterThan(0);
    expect(look.yaw).toBeCloseTo(
      CAMERA.gamepadLookSpeedDeg * (Math.PI / 180) * 0.5 * settings.current.controls.gamepadSensitivityX,
      5,
    );

    // Capture: held A must be released first, then B is captured.
    const p = input.captureBinding(1000);
    await new Promise((r) => setTimeout(r, 0));
    frame();
    pad.buttons[PAD.A] = { pressed: false, value: 0, touched: false };
    frame();
    pad.buttons[PAD.B] = { pressed: true, value: 1, touched: true };
    frame();
    await expect(p).resolves.toEqual({ device: 'pad', button: PAD.B });

    key('keydown', 'KeyW');
    expect(input.device).toBe('kbm');
  });
});
