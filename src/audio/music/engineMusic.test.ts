/**
 * The audio engine's M10 additions (fake Web Audio): music outputs per route and the music hold
 * that keeps the context running while paused (menu theme, pause / UI stings).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { AUDIO } from '../../defs/audio';
import { createDefaultSettings } from '../../save/settingsSchema';
import { AudioEngine } from '../AudioEngine';
import { FakeAudioContext } from './testFakes';

const SUSPEND_MS = AUDIO.pauseSuspendDelay * 1000;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('AudioEngine music routes and hold (fake Web Audio)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    FakeAudioContext.instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(paused: boolean) {
    const engine = new AudioEngine(new EventBus<GameEvents>(), createDefaultSettings().audio);
    engine.setPaused(paused);
    const unlocked = engine.unlock();
    const ctx = FakeAudioContext.instances[0]!;
    ctx.settle();
    await unlocked;
    await flush();
    return { engine, ctx };
  }

  it('offers a node per music route once unlocked', async () => {
    const engine = new AudioEngine(new EventBus<GameEvents>(), createDefaultSettings().audio);
    expect(engine.musicOutput('game')).toBeNull();
    void engine.unlock();
    const game = engine.musicOutput('game');
    const menu = engine.musicOutput('menu');
    const ui = engine.musicOutput('ui');
    expect(game).not.toBeNull();
    expect(menu).not.toBeNull();
    expect(ui).not.toBeNull();
    expect(new Set([game, menu, ui]).size).toBe(3);
    engine.dispose();
  });

  it('keeps the context running while paused as long as the music holds it', async () => {
    const { engine, ctx } = await setup(true);
    engine.setMusicHold(true);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS * 3);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
    engine.setMusicHold(false);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('suspended');
    // A hold while suspended (a UI sting in the paused menu) wakes the context.
    engine.setMusicHold(true);
    expect(ctx.resumeCalls).toBe(2);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('running');
    engine.dispose();
  });

  it('resumes a suspend that raced with a new hold', async () => {
    const { engine, ctx } = await setup(true);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    engine.setMusicHold(true);
    ctx.settle(); // the suspend completes after the hold arrived
    await flush();
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('running');
    engine.dispose();
  });
});
