import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { GRAPHICS_PRESETS } from '../defs/graphics';
import { SaveSystem } from '../save/SaveSystem';
import { SettingsStore } from '../save/SettingsStore';
import { GamePersistence } from './GamePersistence';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** localStorage backend: writes settle in microtasks, like inside a real unload handler. */
async function boot(storage: Storage) {
  const save = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
  const p = new GamePersistence(await save.load(), save);
  const events = new EventBus<GameEvents>();
  // Long debounce: only explicit flush() (unload) writes settings in these tests.
  const settings = new SettingsStore(events, p.data.settings, p.persistSettings, 60_000);
  return { save, p, settings };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('GamePersistence', () => {
  it('resetsave stays wiped: a later settings write or unload flush saves defaults, not the old data', async () => {
    const storage = new MemoryStorage();
    {
      const { p, settings } = await boot(storage);
      settings.update('controls', { fov: 110 });
      p.data.profile.qualityAutoDetected = true;
      p.data.profile.qualityBenchmarked = true;
      settings.flush();
      await settle();
    }
    const { p, settings } = await boot(storage);
    expect(p.data.settings.controls.fov).toBe(110);
    expect(p.data.profile.qualityBenchmarked).toBe(true);

    await p.reset(settings);
    expect(settings.current.controls.fov).not.toBe(110);
    // Unload after `resetsave`: flush the pending settings write (the old unconditional
    // save(saveData) used to put the old profile back here).
    settings.flush();
    await settle();

    const after = await boot(storage);
    expect(after.p.data.settings.controls.fov).not.toBe(110);
    expect(after.p.data.profile.qualityAutoDetected).toBe(false);
    expect(after.p.data.profile.qualityBenchmarked).toBe(false);
  });

  it('?preset= is session-only until the player changes graphics', async () => {
    const storage = new MemoryStorage();
    {
      const { p, settings } = await boot(storage);
      settings.update('graphics', { preset: 'high', ...GRAPHICS_PRESETS.high });
      p.data.profile.qualityAutoDetected = true;
      settings.flush();
      await settle();
    }
    {
      const { p, settings } = await boot(storage);
      p.overrideGraphicsForSession(settings, { preset: 'low', ...GRAPHICS_PRESETS.low });
      expect(settings.current.graphics.preset).toBe('low');
      // Other sections still save; graphics keep the stored values.
      settings.update('controls', { fov: 100 });
      settings.flush();
      await settle();
      expect(p.data.profile.qualityBenchmarked).toBe(false);
    }
    {
      const { p, settings } = await boot(storage);
      expect(p.data.settings.graphics.preset).toBe('high');
      expect(p.data.settings.controls.fov).toBe(100);
      // An explicit graphics change during a forced session is the player's choice and is saved.
      p.overrideGraphicsForSession(settings, { preset: 'low', ...GRAPHICS_PRESETS.low });
      settings.update('graphics', { preset: 'custom', shadows: 'off' });
      settings.flush();
      await settle();
    }
    const last = await boot(storage);
    expect(last.p.data.settings.graphics.preset).toBe('custom');
    expect(last.p.data.settings.graphics.shadows).toBe('off');
  });
});
