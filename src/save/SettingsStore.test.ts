import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CAMERA } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { SETTINGS_SECTIONS } from './sanitize';
import { SettingsStore } from './SettingsStore';
import { createDefaultSettings, type Settings } from './settingsSchema';

const DEBOUNCE = 250;

function setup(initial: Settings = createDefaultSettings()) {
  const events = new EventBus<GameEvents>();
  const persisted: Settings[] = [];
  const changes: GameEvents['settings:changed'][] = [];
  events.on('settings:changed', (e) => changes.push(e));
  const store = new SettingsStore(events, initial, (s) => persisted.push(s), DEBOUNCE);
  return { events, store, persisted, changes };
}

describe('SettingsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sanitizes the initial settings', () => {
    const bad = createDefaultSettings();
    bad.controls.fov = 500;
    const { store } = setup(bad);
    expect(store.current.controls.fov).toBe(CAMERA.maxFov);
  });

  it('merges a patch, sanitizes it and emits the changed section', () => {
    const { store, changes } = setup();
    store.update('controls', { fov: 999, invertY: true });
    expect(store.current.controls.fov).toBe(CAMERA.maxFov);
    expect(store.current.controls.invertY).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.sections).toEqual(['controls']);
    expect(changes[0]?.settings).toBe(store.current);
  });

  it('keeps the previous value for invalid fields in a patch', () => {
    const { store } = setup();
    store.update('audio', { music: 0.3 });
    store.update('audio', { music: Number.NaN, sfx: 0.2 });
    expect(store.current.audio.music).toBe(0.3);
    expect(store.current.audio.sfx).toBe(0.2);
  });

  it('ignores patches that change nothing', () => {
    const { store, changes, persisted } = setup();
    store.update('graphics', { preset: store.current.graphics.preset });
    store.update('audio', {});
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(changes).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });

  it('replaces sections immutably', () => {
    const { store } = setup();
    const before = store.current;
    const beforeAudio = before.audio;
    const beforeControls = before.controls;
    store.update('audio', { master: 0.1 });
    expect(before.audio.master).toBe(createDefaultSettings().audio.master);
    expect(store.current).not.toBe(before);
    expect(store.current.audio).not.toBe(beforeAudio);
    expect(store.current.controls).toBe(beforeControls);
  });

  it('debounces persistence of bursts of changes', () => {
    const { store, persisted } = setup();
    for (let i = 1; i <= 10; i++) {
      store.update('audio', { master: i / 20 });
      vi.advanceTimersByTime(DEBOUNCE / 2);
    }
    expect(persisted).toHaveLength(0);
    expect(store.dirty).toBe(true);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.audio.master).toBe(0.5);
    expect(store.dirty).toBe(false);
  });

  it('flush() persists immediately and cancels the pending timer', () => {
    const { store, persisted } = setup();
    store.update('gameplay', { minimap: true });
    store.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.gameplay.minimap).toBe(true);
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(persisted).toHaveLength(1);
    store.flush();
    expect(persisted).toHaveLength(1);
  });

  it('replace() sanitizes and emits every section', () => {
    const { store, changes, persisted } = setup();
    const next = createDefaultSettings();
    next.graphics.renderScale = 0.01;
    next.audio.voice = 0.5;
    store.replace(next);
    expect(store.current.graphics.renderScale).toBe(0.5);
    expect(store.current.audio.voice).toBe(0.5);
    expect(changes[0]?.sections).toEqual([...SETTINGS_SECTIONS]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(persisted).toHaveLength(1);
  });

  it('resetSection() restores defaults including bindings', () => {
    const { store, changes } = setup();
    store.update('controls', { fov: 75, bindings: { ...store.current.controls.bindings, jump: [] } });
    expect(store.current.controls.bindings.jump).toEqual([]);
    store.resetSection('controls');
    expect(store.current.controls).toEqual(createDefaultSettings().controls);
    expect(changes.at(-1)?.sections).toEqual(['controls']);
  });

  it('survives a throwing persist callback', () => {
    // The failure is logged on purpose; keep the test output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events = new EventBus<GameEvents>();
    const store = new SettingsStore(events, createDefaultSettings(), () => {
      throw new Error('disk full');
    });
    store.update('audio', { ui: 0.1 });
    expect(() => vi.advanceTimersByTime(ENGINE.settingsSaveDebounceMs)).not.toThrow();
    expect(store.current.audio.ui).toBe(0.1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
