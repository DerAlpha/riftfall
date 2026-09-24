import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { Action } from '../defs/input';
import { PauseController, type PauseDeps } from './PauseController';

class FakeInput {
  enabled = true;
  pointerLocked = false;
  device: 'kbm' | 'gamepad' = 'kbm';
  capturing = false;
  lockRequests = 0;
  exits = 0;
  /** Edges of the current frame (reported regardless of `enabled`, like InputSystem). */
  readonly edges = new Set<Action>();
  pressed(a: Action): boolean {
    return this.enabled && this.edges.has(a);
  }
  pressedIgnoringEnabled(a: Action): boolean {
    return this.edges.has(a);
  }
  requestPointerLock(): void {
    this.lockRequests++;
  }
  exitPointerLock(): void {
    this.exits++;
    this.pointerLocked = false;
  }
}

class FakeMenus {
  current: 'start' | 'pause' | null = null;
  showPause(): void {
    this.current = 'pause';
  }
  hide(): void {
    this.current = null;
  }
}

describe('PauseController', () => {
  let input: FakeInput;
  let menus: FakeMenus;
  let loop: { paused: boolean; resetAccumulator(): void };
  let audioPaused: boolean[];
  let consoleOpen: boolean;
  let events: EventBus<GameEvents>;
  let ctl: PauseController;

  const make = (noPointerLock = false): PauseController =>
    new PauseController({
      input,
      menus,
      loop,
      audio: {
        setPaused: (p) => audioPaused.push(p),
        unlock: () => Promise.resolve(),
      },
      events,
      consoleOpen: () => consoleOpen,
      noPointerLock,
    } satisfies PauseDeps);

  /** One frame of the loop: edges of `pressed` are visible to onFrame only. */
  const frame = (pressed: Action[] = [], wasCapturing = false): void => {
    for (const a of pressed) input.edges.add(a);
    ctl.onFrame(wasCapturing);
    input.edges.clear();
  };

  /** The browser granted pointer lock. */
  const lock = (): void => {
    input.pointerLocked = true;
    ctl.onPointerLock(true);
  };
  const unlock = (): void => {
    input.pointerLocked = false;
    ctl.onPointerLock(false);
  };

  beforeEach(() => {
    input = new FakeInput();
    menus = new FakeMenus();
    loop = { paused: false, resetAccumulator: () => {} };
    audioPaused = [];
    consoleOpen = false;
    events = new EventBus<GameEvents>();
    ctl = make();
    // Boot: start screen.
    ctl.pause('menu');
    menus.current = 'start';
  });

  it('starts with a mouse click via pointer lock and pauses on lock loss', () => {
    expect(loop.paused).toBe(true);
    expect(input.enabled).toBe(false);
    ctl.start(false);
    expect(input.lockRequests).toBe(1);
    expect(loop.paused).toBe(true); // until the lock is granted
    lock();
    expect(loop.paused).toBe(false);
    expect(input.enabled).toBe(true);
    expect(menus.current).toBeNull();
    unlock();
    expect(loop.paused).toBe(true);
    expect(menus.current).toBe('pause');
    expect(audioPaused).toEqual([true, false, true]);
  });

  it('gamepad: START pauses and START resumes without pointer lock', () => {
    input.device = 'gamepad';
    ctl.start(true);
    expect(input.lockRequests).toBe(0);
    expect(loop.paused).toBe(false);
    expect(ctl.lockless).toBe(true);
    frame(['pause']);
    expect(loop.paused).toBe(true);
    expect(menus.current).toBe('pause');
    // Still held next frame: no new edge, no resume.
    frame();
    expect(loop.paused).toBe(true);
    frame(['pause']);
    expect(loop.paused).toBe(false);
    expect(menus.current).toBeNull();
    expect(input.lockRequests).toBe(0);
    expect(input.enabled).toBe(true);
  });

  it('keyboard P resumes through a lock request; Escape never resumes', () => {
    ctl.start(false);
    lock();
    frame(['pause']); // P during play
    expect(menus.current).toBe('pause');
    unlock(); // exitPointerLock → pointerlockchange
    expect(loop.paused).toBe(true);
    // Escape in the menu (e.g. leaving the settings page) must not resume.
    ctl.noteEscape();
    frame(['pause']);
    expect(input.lockRequests).toBe(1);
    // P again: a real key press may take the lock.
    frame(['pause']);
    expect(input.lockRequests).toBe(2);
    lock();
    expect(loop.paused).toBe(false);
    expect(menus.current).toBeNull();
  });

  it('the Escape that released the lock does not resume on the next frame', () => {
    ctl.start(false);
    lock();
    ctl.noteEscape();
    unlock(); // browser left pointer lock on Esc
    frame(['pause']); // the Esc keydown reaches the next input poll
    expect(loop.paused).toBe(true);
    expect(menus.current).toBe('pause');
    expect(input.lockRequests).toBe(1);
  });

  it('does not resume while hidden, while the console is open, or from a finished rebinding capture', () => {
    input.device = 'gamepad';
    ctl.start(true);
    ctl.onVisibility(true);
    expect(ctl.has('visibility')).toBe(true);
    frame(['pause']);
    expect(loop.paused).toBe(true);
    ctl.onVisibility(false);
    expect(loop.paused).toBe(true); // the menu stays
    frame(['pause'], true); // START was just captured as a binding
    expect(loop.paused).toBe(true);
    consoleOpen = true;
    frame(['pause']);
    expect(loop.paused).toBe(true);
    consoleOpen = false;
    frame(['pause']);
    expect(loop.paused).toBe(false);
  });

  it('ignores the pause binding on the start screen', () => {
    frame(['pause']);
    expect(menus.current).toBe('start');
    expect(loop.paused).toBe(true);
  });

  it('lock-less play: a refused lock does not pause, a canvas click takes the lock', () => {
    input.device = 'gamepad';
    ctl.start(true);
    ctl.onCanvasPointerDown();
    expect(input.lockRequests).toBe(1);
    ctl.onPointerLock(false); // request refused
    expect(loop.paused).toBe(false);
    lock();
    expect(ctl.lockless).toBe(false);
    unlock();
    expect(loop.paused).toBe(true);
  });

  it('closing the console without pointer lock falls back to the pause menu (kbm only)', () => {
    ctl.start(false);
    lock();
    ctl.onConsole(true);
    expect(input.enabled).toBe(false);
    input.pointerLocked = false; // Esc in the console released the lock; the handler skipped the menu
    ctl.onConsole(false);
    expect(menus.current).toBe('pause');

    const pad = make();
    loop.paused = false;
    menus.current = null;
    pad.start(true);
    pad.onConsole(true);
    pad.onConsole(false);
    expect(menus.current).toBeNull();
    expect(loop.paused).toBe(false);
    expect(input.enabled).toBe(true);
  });

  it('noPointerLock mode resumes without any lock', () => {
    ctl = make(true);
    ctl.pause('menu');
    ctl.start(false);
    expect(loop.paused).toBe(false);
    expect(input.lockRequests).toBe(0);
    frame(['pause']);
    expect(menus.current).toBe('pause');
    expect(input.exits).toBe(0);
    ctl.resume(false);
    expect(loop.paused).toBe(false);
  });

  it('a mouse start after lock-less play shows the pause menu when the lock is refused', () => {
    // Played with a pad, died: game over → "Hauptmenü" → start screen.
    input.device = 'gamepad';
    ctl.start(true);
    ctl.pause('menu');
    menus.current = 'start';
    // Now a mouse click on the start screen; the browser refuses the lock.
    input.device = 'kbm';
    ctl.start(false);
    expect(input.lockRequests).toBe(1);
    ctl.onPointerLock(false);
    expect(menus.current).toBe('pause'); // hints + the lock-less option instead of a dead click
    expect(loop.paused).toBe(true);
  });

  it('death sequence: gameplay input off without pausing, restored however the run goes on', () => {
    input.device = 'gamepad';
    ctl.start(true);
    ctl.setInputLocked(true);
    expect(input.enabled).toBe(false);
    expect(loop.paused).toBe(false);
    // No pausing during the death sequence (the pause binding is gameplay input).
    frame(['pause']);
    expect(loop.paused).toBe(false);
    // The console closing does not hand the input back mid-sequence.
    ctl.onConsole(true);
    ctl.onConsole(false);
    expect(input.enabled).toBe(false);
    // Pause menu + resume (lost lock, tab switch) neither.
    ctl.openMenu('visibility');
    ctl.onVisibility(false);
    ctl.resume(true);
    expect(loop.paused).toBe(false);
    expect(input.enabled).toBe(false);
    // `run restart` straight out of the death sequence (dev console / smoke handle): no pause
    // transition re-enables it – releasing the lock must.
    ctl.setInputLocked(false);
    expect(input.enabled).toBe(true);
    // Released while paused (game over → restart): the resume enables it.
    ctl.setInputLocked(true);
    ctl.pause('menu');
    ctl.setInputLocked(false);
    expect(input.enabled).toBe(false);
    ctl.resume(true);
    expect(input.enabled).toBe(true);
  });

  it('emits paused/resumed events with the reason', () => {
    const seen: string[] = [];
    events.on('game:paused', ({ reason }) => seen.push(`paused:${reason}`));
    events.on('game:resumed', () => seen.push('resumed'));
    input.device = 'gamepad';
    ctl.start(true);
    ctl.onVisibility(true);
    expect(seen).toEqual(['resumed', 'paused:visibility']);
  });
});
