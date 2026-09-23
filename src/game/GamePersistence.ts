/**
 * Save wiring of the composition root (kept out of Game so it is unit-testable):
 * - the SettingsStore persist callback (writes the whole SaveData),
 * - a session-only graphics override (`?preset=`) that never reaches storage,
 * - profile writes and the in-place reset behind the dev console's `resetsave`.
 *
 * Every write serializes `data`, the one SaveData object Game mutates. reset() therefore replaces
 * its sections in place: later writes (debounced settings, the unload flush) then persist the
 * defaults instead of resurrecting the wiped save.
 */
import type { SaveData, SaveSystemApi, SettingsStore } from '../core/contracts';
import { createDefaultSave } from '../save/defaults';
import type { GraphicsSettings, Settings } from '../save/settingsSchema';

export class GamePersistence {
  /** Graphics shown this session (`live`) vs. the graphics storage keeps (`saved`). */
  private sessionGraphics: { live: Readonly<GraphicsSettings>; saved: Readonly<GraphicsSettings> } | null =
    null;

  constructor(
    readonly data: SaveData,
    private readonly save: SaveSystemApi,
  ) {}

  /** SettingsStore persist callback (the store debounces it). */
  readonly persistSettings = (s: Settings): void => {
    const o = this.sessionGraphics;
    // Sections are replaced immutably: identity means graphics are untouched since the override.
    this.data.settings = o && s.graphics === o.live ? { ...s, graphics: { ...o.saved } } : s;
    void this.save.save(this.data);
  };

  /**
   * Apply graphics for this session only (`?preset=`). Storage keeps the previous graphics until the
   * player changes a graphics option – that explicit choice is then saved as usual.
   */
  overrideGraphicsForSession(settings: SettingsStore, patch: Partial<GraphicsSettings>): void {
    const saved = settings.current.graphics;
    settings.update('graphics', patch);
    this.sessionGraphics = { live: settings.current.graphics, saved };
  }

  /** Write the current data (profile changes are saved right away, settings via the store). */
  saveNow(): Promise<void> {
    return this.save.save(this.data);
  }

  /** Dev console `resetsave`: wipe storage and continue with default settings and profile. */
  async reset(settings: SettingsStore): Promise<void> {
    const fresh = createDefaultSave();
    this.sessionGraphics = null;
    this.data.profile = fresh.profile;
    this.data.settings = fresh.settings;
    await this.save.clear();
    // Applies the defaults live and schedules their (debounced) save.
    settings.replace(fresh.settings);
  }
}
