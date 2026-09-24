/**
 * MusicSystem against fake Web Audio (Node has none): silent without a context, no work at music
 * volume 0, the lookahead timer only while something plays, routes and the context hold, the
 * legacy sting fallback while a theme is not rendered yet.
 */
import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { INSTRUMENT_RECIPES, MUSIC, MUSIC_STINGS, MUSIC_THEMES, type InstrumentSlot, type MusicRoute } from '../../defs/music';
import { createDefaultSettings, type AudioSettings } from '../../save/settingsSchema';
import type { SampleSet, ThemeSamples } from './MusicBank';
import { MusicSystem, type MusicBankLike, type MusicHost } from './MusicSystem';
import { FakeAudioContext, FakeGain, fakeBuffer } from './testFakes';

function fakeTheme(id: string): ThemeSamples {
  const def = MUSIC_THEMES[id]!;
  const slots: Partial<Record<InstrumentSlot, SampleSet>> = {};
  for (const [slot, inst] of Object.entries(def.palette) as [InstrumentSlot, NonNullable<(typeof def.palette)[InstrumentSlot]>][]) {
    const info = INSTRUMENT_RECIPES[inst.recipe];
    slots[slot] = {
      slot,
      pitched: info.pitched,
      loop: info.loop,
      gain: inst.gain,
      samples: [
        {
          buffer: fakeBuffer(1, 48000, 48000) as unknown as AudioBuffer,
          hz: info.pitched ? 261.63 : 0,
          midi: 60,
          loop: info.loop,
        },
      ],
    };
  }
  return { themeId: id, slots, bytes: 0 };
}

class FakeBank implements MusicBankLike {
  readonly supported = true;
  readonly loads: string[] = [];
  readonly ready = new Map<string, ThemeSamples>();
  get(themeId: string): ThemeSamples | null {
    return this.ready.get(themeId) ?? null;
  }
  load(themeId: string): Promise<ThemeSamples | null> {
    this.loads.push(themeId);
    return Promise.resolve(this.get(themeId));
  }
  get stats(): { themes: number; bytes: number } {
    return { themes: this.ready.size, bytes: 0 };
  }
  dispose(): void {}
}

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup(o: { context?: boolean; audio?: Partial<AudioSettings>; themes?: string[]; mapId?: string } = {}) {
  const events = new EventBus<GameEvents>();
  const ctx = o.context === false ? null : new FakeAudioContext();
  if (ctx) ctx.state = 'running';
  const outs: Record<MusicRoute, FakeGain> = { game: new FakeGain(), menu: new FakeGain(), ui: new FakeGain() };
  const holds: boolean[] = [];
  const plays: { id: string; opts: PlayOptions }[] = [];
  const host: MusicHost = {
    get context() {
      return ctx as unknown as AudioContext | null;
    },
    musicOutput: (route) => (ctx ? (outs[route] as unknown as AudioNode) : null),
    setMusicHold: (hold) => holds.push(hold),
    registerBuffer: () => undefined,
    play: (id, opts) => plays.push({ id, opts: { ...opts } }),
  };
  const bank = new FakeBank();
  for (const id of o.themes ?? ['menu', 'lab', 'ui']) bank.ready.set(id, fakeTheme(id));
  const timers: Timer[] = [];
  const settings = { ...createDefaultSettings().audio, ...o.audio };
  const music = new MusicSystem({
    events,
    host,
    settings,
    mapId: o.mapId ?? 'lab',
    bank,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as Timer).cleared = true;
    },
    now: () => (ctx?.currentTime ?? 0) + 100,
  });
  /** Run due scheduler ticks while advancing the fake audio clock. */
  const play = (seconds: number): void => {
    const step = MUSIC.scheduler.interval;
    for (let t = 0; t < seconds; t += step) {
      if (ctx) ctx.currentTime += step;
      const due = timers.splice(0).filter((x) => !x.cleared);
      for (const x of due) x.fn();
    }
  };
  const scheduler = (): Timer[] => timers.filter((t) => !t.cleared && t.ms === MUSIC.scheduler.interval * 1000);
  return { events, ctx, music, bank, holds, plays, play, timers, scheduler, settings };
}

describe('MusicSystem', () => {
  it('is a silent no-op without an AudioContext (before the first gesture / no Web Audio)', () => {
    const { events, music, plays, scheduler } = setup({ context: false });
    events.emit('ui:menu', { open: true, menu: 'start' });
    events.emit('game:resumed', {});
    events.emit('wave:start', { wave: 1, total: 5 });
    events.emit('player:died', { position: { x: 0, y: 0, z: 0 } });
    music.update(1 / 60, { x: 0, y: 0, z: 0 });
    expect(music.state).toBe('gameover');
    expect(music.status.context).toBe('locked');
    expect(music.status.playing).toBeNull();
    expect(scheduler()).toHaveLength(0);
    expect(plays).toHaveLength(0);
    music.dispose();
  });

  it('does no work at music volume 0: no theme renders, no scheduler, no voices', () => {
    const { events, ctx, music, bank, play, scheduler } = setup({ audio: { music: 0 } });
    events.emit('game:ready', {});
    events.emit('ui:menu', { open: true, menu: 'start' });
    events.emit('game:resumed', {});
    events.emit('wave:start', { wave: 1, total: 5 });
    play(2);
    expect(music.enabled).toBe(false);
    expect(bank.loads.filter((id) => id !== MUSIC.uiTheme)).toEqual([]);
    expect(scheduler()).toHaveLength(0);
    expect(ctx!.sources).toHaveLength(0);
    expect(music.status.timer).toBe(false);
  });

  it('plays the menu theme on the menu route and holds the context awake for it', () => {
    const { events, ctx, music, holds, play, scheduler } = setup();
    events.emit('ui:menu', { open: true, menu: 'start' });
    expect(music.status.playing).toBe('menu');
    expect(music.status.route).toBe('menu');
    expect(holds.at(-1)).toBe(true);
    expect(scheduler()).toHaveLength(1);
    play(4);
    expect(ctx!.sources.length).toBeGreaterThan(5);
    for (const s of ctx!.sources) expect(s.startedAt).toBeGreaterThanOrEqual(0);
    // The run starts: the map theme on the game route, no hold any more.
    events.emit('game:resumed', {});
    expect(music.state).toBe('intermission');
    expect(music.status.playing).toBe('lab');
    expect(music.status.route).toBe('game');
    play(3);
    expect(holds.at(-1)).toBe(false);
  });

  it('stops the scheduler and every voice when the music volume goes to 0, and comes back', () => {
    const { events, ctx, music, play, scheduler, settings } = setup();
    events.emit('game:resumed', {});
    play(2);
    expect(scheduler()).toHaveLength(1);
    const audio = { ...settings, music: 0 };
    events.emit('settings:changed', {
      settings: { ...createDefaultSettings(), audio },
      sections: ['audio'],
    });
    expect(music.enabled).toBe(false);
    play(MUSIC.fades.stop + 1);
    expect(scheduler()).toHaveLength(0);
    const count = ctx!.sources.length;
    play(3);
    expect(ctx!.sources.length).toBe(count);
    events.emit('settings:changed', {
      settings: { ...createDefaultSettings(), audio: { ...settings, music: 0.5 } },
      sections: ['audio'],
    });
    expect(music.enabled).toBe(true);
    expect(music.status.playing).toBe('lab');
    play(2);
    expect(ctx!.sources.length).toBeGreaterThan(count);
  });

  it('pauses with the context: no ticks while suspended, resumed on statechange', () => {
    const { events, ctx, play, scheduler } = setup();
    events.emit('game:resumed', {});
    play(1);
    ctx!.setState('suspended');
    play(1);
    expect(scheduler()).toHaveLength(0);
    ctx!.setState('running');
    expect(scheduler()).toHaveLength(1);
  });

  it('plays stings in the theme, the pause sting on the menu route with a hold, legacy one-shots while not rendered', () => {
    const { events, ctx, music, holds, plays, play } = setup();
    events.emit('game:resumed', {});
    play(1);
    const before = ctx!.sources.length;
    events.emit('wave:start', { wave: 1, total: 5 });
    expect(ctx!.sources.length).toBeGreaterThan(before);
    expect(plays).toHaveLength(0);
    // Pause: the sting holds the context until it has played.
    events.emit('game:paused', { reason: 'menu' });
    events.emit('ui:menu', { open: true, menu: 'pause' });
    expect(holds.at(-1)).toBe(true);
    play(8);
    expect(holds.at(-1)).toBe(false);
    music.dispose();

    // A map whose theme is not rendered yet: the legacy sting plays instead.
    const cold = setup({ themes: [], mapId: 'reactor' });
    cold.events.emit('game:resumed', {});
    expect(cold.music.status.pendingTheme).toBe('reactor');
    cold.events.emit('wave:start', { wave: 1, total: 5 });
    expect(cold.plays.map((p) => p.id)).toEqual([MUSIC_STINGS.waveStart.fallback!.id]);
    expect(cold.plays[0]!.opts.bus).toBe('music');
  });

  it('exposes the MusicApi hooks: director intensity, boss theme, map theme, forced state', () => {
    const { events, music } = setup({ themes: ['menu', 'lab', 'boss', 'ui'] });
    events.emit('game:resumed', {});
    events.emit('wave:start', { wave: 1, total: 5 });
    music.setIntensity(0.9, 'director');
    music.update(1);
    expect(music.status.source).toBe('director');
    expect(music.intensity).toBeGreaterThan(0.5);
    music.setBossTheme('boss');
    expect(music.state).toBe('boss');
    expect(music.status.playing).toBe('boss');
    music.setBossTheme(null);
    expect(music.status.playing).toBe('lab');
    music.forceState('menu');
    expect(music.status.playing).toBe('menu');
    music.forceState(null);
    music.setMapTheme('arctic');
    expect(music.themeId).toBe('arctic');
    music.dispose();
  });
});
