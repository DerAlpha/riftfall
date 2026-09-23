/** Shared types and hooks of the Preact menus. */
import { useEffect, useState } from 'preact/hooks';
import type { InputApi, SettingsStore } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import type { KeyboardLayout } from '../../input/bindings';
import type { Settings } from '../../save/settingsSchema';

export interface MenuInfo {
  gpuName: string;
  saveBackend: string;
  version: string;
}

/** InputApi plus the optional capture abort of InputSystem (menus cancel a pending capture on unmount). */
export type MenuInput = InputApi & { cancelCapture?(): void };

export interface MenuDeps {
  settings: SettingsStore;
  input: MenuInput;
  events: EventBus<GameEvents>;
  /** Start click (user gesture): requests pointer lock + unlocks audio. */
  onStart(): void;
  /** Resume click (user gesture): re-requests pointer lock. */
  onResume(): void;
  getInfo(): MenuInfo;
}

export type SettingsTab = 'graphics' | 'audio' | 'controls' | 'accessibility';

/** UI state that survives closing/reopening the pause menu. */
export interface MenuMemory {
  tab: SettingsTab;
}

/** Re-render on every settings change; returns the live settings object. */
export function useSettings(deps: MenuDeps): Readonly<Settings> {
  const [, setTick] = useState(0);
  useEffect(() => deps.events.on('settings:changed', () => setTick((t) => t + 1)), [deps.events]);
  return deps.settings.current;
}

/** Last used input device; re-renders when it changes (cheat sheet shows pad or keyboard bindings). */
export function useInputDevice(deps: MenuDeps): 'kbm' | 'gamepad' {
  const [device, setDevice] = useState(deps.input.device);
  useEffect(() => {
    setDevice(deps.input.device);
    return deps.events.on('input:deviceChanged', (e) => setDevice(e.device));
  }, [deps.events, deps.input]);
  return device;
}

let layoutCache: KeyboardLayout | null = null;
let layoutPromise: Promise<KeyboardLayout | null> | null = null;

interface KeyboardApi {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

function loadLayout(): Promise<KeyboardLayout | null> {
  if (layoutPromise) return layoutPromise;
  // navigator.keyboard is Chromium-only and not in lib.dom.
  const kb = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
  layoutPromise =
    kb && typeof kb.getLayoutMap === 'function'
      ? kb
          .getLayoutMap()
          .then((m) => (layoutCache = m))
          .catch(() => null)
      : Promise.resolve(null);
  return layoutPromise;
}

/** Physical-code → printed-character map of the user's keyboard (null until/unless available). */
export function useKeyboardLayout(): KeyboardLayout | null {
  const [layout, setLayout] = useState<KeyboardLayout | null>(layoutCache);
  useEffect(() => {
    let alive = true;
    if (!layoutCache) void loadLayout().then((m) => alive && m && setLayout(m));
    return () => {
      alive = false;
    };
  }, []);
  return layout;
}
