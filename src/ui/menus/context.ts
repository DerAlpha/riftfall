/** Shared types and hooks of the Preact menus. */
import { useEffect, useState } from 'preact/hooks';
import type { InputApi, SaveBackend, SettingsStore } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { learnedLayout, type KeyboardLayout } from '../../input/bindings';
import type { PointerLockProblem } from '../../input/InputSystem';
import type { Settings } from '../../save/settingsSchema';

export interface MenuInfo {
  gpuName: string;
  saveBackend: SaveBackend['name'];
  version: string;
  /** Player-facing name of the map being played (pause menu subtitle); default: the calibration hall. */
  mapName?: string;
  /**
   * Id of the loaded map: the start screen preselects it (maps are switched by a reload onto the
   * start screen – preselecting another map would switch straight back).
   */
  mapId?: string;
}

/** A playable map on the start screen (M3 map selection). */
export interface MapChoice {
  readonly id: string;
  /** Player-facing name (German). */
  readonly name: string;
  readonly description: string;
  /** Preselected (the first recommended map) and marked "Empfohlen". */
  readonly recommended?: boolean;
}

/**
 * What the game over screen shows. modes/RunFlow's RunSummary fits as is; optional fields are
 * derived (accuracy from the shots) or hidden when missing.
 */
export interface GameOverStats {
  readonly wave: number;
  readonly kills: number;
  readonly headshots: number;
  readonly shotsFired: number;
  readonly shotsHit: number;
  /** Seconds. */
  readonly timeSurvived: number;
  readonly score: number;
  /** 0..1 (default shotsHit / shotsFired). */
  readonly accuracy?: number;
  readonly weakpointKills?: number;
  /** Economy points credited during the run (M4); hidden when missing. */
  readonly pointsEarned?: number;
  /** Map id (its MapChoice name is shown) or an explicit name. */
  readonly mapId?: string;
  readonly mapName?: string;
  /** Mode id (RUN_MENU.gameOver.modeLabels). */
  readonly mode?: string;
}

/**
 * InputApi plus optional extras of InputSystem: the capture abort (menus cancel a pending capture
 * on unmount) and the pointer lock availability (menus explain a refused lock and offer lock-less play).
 */
export type MenuInput = InputApi & {
  cancelCapture?(): void;
  readonly pointerLockSupported?: boolean;
  readonly pointerLockProblem?: PointerLockProblem | null;
};

export interface PlayOptions {
  /** Play without pointer lock (it is unavailable or refused); mouse look uses plain movement. */
  lockless?: boolean;
  /** onStart: the map selected on the start screen (only when `MenuDeps.maps` lists maps). */
  mapId?: string;
}

export interface MenuDeps {
  settings: SettingsStore;
  input: MenuInput;
  events: EventBus<GameEvents>;
  /** Start click (user gesture): requests pointer lock (unless lock-less) + unlocks audio. */
  onStart(opts?: PlayOptions): void;
  /** Resume click (user gesture): re-requests pointer lock (unless lock-less). */
  onResume(opts?: PlayOptions): void;
  getInfo(): MenuInfo;
  /** Maps for the start screen's selection cards (none: the plain M1 start screen). */
  maps?: readonly MapChoice[];
  /**
   * Game over "Neu starten" (user gesture, like onResume: request pointer lock unless lock-less).
   * The game over screen is already closed when it runs, so a refused lock can open the pause
   * menu. Default: onStart with the finished run's map.
   */
  onRestart?(opts?: PlayOptions): void;
  /** Game over "Hauptmenü". Default: the start screen is shown. */
  onMainMenu?(): void;
}

export type SettingsTab = 'graphics' | 'audio' | 'controls' | 'accessibility';

/** UI state that survives closing/reopening the menus. */
export interface MenuMemory {
  tab: SettingsTab;
  /** Map selected on the start screen (kept for the next visit, e.g. after a game over). */
  mapId?: string;
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

/**
 * Physical-code → printed-character map of the user's keyboard. Without getLayoutMap (Firefox,
 * Safari) the map learned from keydowns is used (it grows as keys are pressed – a captured key is
 * always learned); null while neither knows anything.
 */
export function useKeyboardLayout(): KeyboardLayout | null {
  const [layout, setLayout] = useState<KeyboardLayout | null>(layoutCache);
  useEffect(() => {
    let alive = true;
    if (!layoutCache) void loadLayout().then((m) => alive && m && setLayout(m));
    return () => {
      alive = false;
    };
  }, []);
  return layout ?? (learnedLayout.size > 0 ? learnedLayout : null);
}

/** Why pointer lock is unavailable (null when it works or was never needed); re-renders on lock changes. */
export function usePointerLockProblem(deps: MenuDeps): PointerLockProblem | null {
  const read = (): PointerLockProblem | null =>
    deps.input.pointerLockProblem ?? (deps.input.pointerLockSupported === false ? 'unsupported' : null);
  const [problem, setProblem] = useState(read);
  useEffect(() => {
    setProblem(read());
    // The input system records the problem before it reports the failed lock.
    return deps.events.on('input:pointerLock', () => setProblem(read()));
  }, [deps.events, deps.input]);
  return problem;
}
