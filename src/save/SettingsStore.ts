/**
 * Live settings with validation, change events and debounced persistence.
 *
 * Sections are replaced immutably on every change (never mutated in place), so a snapshot handed
 * out earlier stays consistent; consumers read `current` or react to `settings:changed`.
 */
import type { SettingsStore as SettingsStoreApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createLogger } from '../core/log';
import { ENGINE } from '../defs/engine';
import { SETTINGS_SECTIONS, jsonEqual, sanitizeSection, sanitizeSettings } from './sanitize';
import { createDefaultSettings, type Settings, type SettingsSection } from './settingsSchema';

const log = createLogger('Settings');

export class SettingsStore implements SettingsStoreApi {
  private settings: Settings;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly events: EventBus<GameEvents>,
    initial: Settings,
    private readonly persist: (s: Settings) => void,
    private readonly debounceMs: number = ENGINE.settingsSaveDebounceMs,
  ) {
    this.settings = sanitizeSettings(initial);
  }

  get current(): Readonly<Settings> {
    return this.settings;
  }

  /** True while a debounced save is pending. */
  get dirty(): boolean {
    return this.timer !== null;
  }

  update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
    const prev = this.settings[section];
    const next = sanitizeSection(section, { ...prev, ...patch }, prev);
    if (jsonEqual(prev, next)) return;
    this.settings = { ...this.settings, [section]: next };
    this.changed([section]);
  }

  replace(settings: Settings): void {
    this.settings = sanitizeSettings(settings);
    this.changed([...SETTINGS_SECTIONS]);
  }

  resetSection(section: SettingsSection): void {
    this.settings = { ...this.settings, [section]: createDefaultSettings()[section] };
    this.changed([section]);
  }

  /** Persist a pending change immediately (page unload / pagehide). */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.runPersist();
  }

  dispose(): void {
    this.flush();
  }

  private changed(sections: SettingsSection[]): void {
    this.events.emit('settings:changed', { settings: this.settings, sections });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runPersist();
    }, this.debounceMs);
  }

  private runPersist(): void {
    try {
      this.persist(this.settings);
    } catch (err) {
      log.error('Persisting settings failed', err);
    }
  }
}
