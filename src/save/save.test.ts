import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { SaveData } from '../core/contracts';
import { CAMERA } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { ACTIONS, DEFAULT_BINDINGS, INPUT } from '../defs/input';
import { MENU } from '../defs/ui';
import { createDefaultProfile, createDefaultSave } from './defaults';
import { MIGRATIONS, SAVE_VERSION, migrateSave } from './migrations';
import {
  SETTINGS_SECTIONS,
  jsonEqual,
  sanitizeBindingMap,
  sanitizeProfile,
  sanitizeSettings,
} from './sanitize';
import { BACKUP_SUFFIX, SaveSystem } from './SaveSystem';
import { createDefaultSettings } from './settingsSchema';

/** Minimal Storage implementation with switchable failures. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  failWrites = false;
  failReads = false;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
}

const LS_PREFIX = `${ENGINE.localStorageKey}/`;
const SLOT = ENGINE.saveSlotKey;

function idbOnly(factory: IDBFactory = new IDBFactory()) {
  return { env: { indexedDB: factory, localStorage: null } };
}

function sampleSave(): SaveData {
  const save = createDefaultSave(1000);
  save.settings.controls.fov = 104;
  save.settings.audio.music = 0.25;
  save.settings.controls.bindings.jump = [{ device: 'key', code: 'KeyJ' }];
  save.profile.unlocks.dash = true;
  save.profile.qualityAutoDetected = true;
  return save;
}

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

describe('sanitizeSettings', () => {
  it('returns fresh defaults for garbage input', () => {
    for (const raw of [undefined, null, 42, 'x', [], true]) {
      expect(sanitizeSettings(raw)).toEqual(createDefaultSettings());
    }
    const a = sanitizeSettings(null);
    const b = sanitizeSettings(null);
    a.controls.bindings.jump.length = 0;
    expect(b.controls.bindings.jump.length).toBeGreaterThan(0);
  });

  it('keeps valid values and is idempotent', () => {
    const s = sampleSave().settings;
    expect(sanitizeSettings(s)).toEqual(s);
    expect(sanitizeSettings(sanitizeSettings(s))).toEqual(s);
  });

  it('clamps numbers to their valid ranges', () => {
    const s = sanitizeSettings({
      controls: { fov: 200, mouseSensitivity: -3 },
      audio: { master: 3, music: -1, sfx: '0.5' },
      graphics: { renderScale: 0.1, exposure: 99 },
      accessibility: { hudScale: 0 },
    });
    expect(s.controls.fov).toBe(CAMERA.maxFov);
    expect(s.controls.mouseSensitivity).toBe(MENU.ranges.mouseSensitivity.min);
    expect(s.audio.master).toBe(1);
    expect(s.audio.music).toBe(0);
    expect(s.audio.sfx).toBe(0.5);
    expect(s.graphics.renderScale).toBe(0.5);
    expect(s.graphics.exposure).toBe(MENU.ranges.exposure.max);
    expect(s.accessibility.hudScale).toBe(MENU.ranges.hudScale.min);
    expect(sanitizeSettings({ controls: { fov: 10 } }).controls.fov).toBe(CAMERA.minFov);
  });

  it('falls back to defaults for invalid types, NaN and bad enums', () => {
    const d = createDefaultSettings();
    const s = sanitizeSettings({
      graphics: {
        preset: 'insane',
        antialiasing: 'msaa',
        shadows: 3,
        renderScale: Number.NaN,
        motionBlur: 'yes',
      },
      gameplay: { crosshair: 'banana', crosshairColor: 'red' },
      accessibility: { colorblindMode: 'protanopia' },
    });
    expect(s.graphics.preset).toBe(d.graphics.preset);
    expect(s.graphics.antialiasing).toBe(d.graphics.antialiasing);
    expect(s.graphics.shadows).toBe(d.graphics.shadows);
    expect(s.graphics.renderScale).toBe(d.graphics.renderScale);
    expect(s.graphics.motionBlur).toBe(d.graphics.motionBlur);
    expect(s.gameplay.crosshair).toBe(d.gameplay.crosshair);
    expect(s.gameplay.crosshairColor).toBe(d.gameplay.crosshairColor);
    expect(s.accessibility.colorblindMode).toBe('protanopia');
  });

  it('handles special numeric fields', () => {
    const fps = (v: unknown) => sanitizeSettings({ graphics: { fpsLimit: v } }).graphics.fpsLimit;
    expect(fps(0)).toBe(0);
    expect(fps(-5)).toBe(0);
    expect(fps(5)).toBe(15);
    expect(fps(144.4)).toBe(144);
    expect(sanitizeSettings({ graphics: { anisotropy: 7 } }).graphics.anisotropy).toBe(8);
    expect(sanitizeSettings({ graphics: { anisotropy: 100 } }).graphics.anisotropy).toBe(16);
    expect(sanitizeSettings({ graphics: { targetFps: 59 } }).graphics.targetFps).toBe(60);
    expect(sanitizeSettings({ gameplay: { crosshairColor: '#ABC' } }).gameplay.crosshairColor).toBe(
      '#aabbcc',
    );
    expect(sanitizeSettings({ gameplay: { crosshairColor: '#00E5FF' } }).gameplay.crosshairColor).toBe(
      '#00e5ff',
    );
    expect(sanitizeSettings({ controls: { invertY: 'true' } }).controls.invertY).toBe(true);
  });

  it('drops unknown keys and sections', () => {
    const s = sanitizeSettings({ graphics: { foo: 1 }, bogus: { a: 1 } }) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(s).sort()).toEqual([...SETTINGS_SECTIONS].sort());
    expect(Object.keys(s.graphics as object)).not.toContain('foo');
  });
});

describe('sanitizeBindingMap', () => {
  it('fills missing actions from the defaults and drops unknown actions', () => {
    const map = sanitizeBindingMap({
      jump: [{ device: 'key', code: 'KeyJ' }],
      teleport: [{ device: 'key', code: 'KeyT' }],
    });
    expect(map.jump).toEqual([{ device: 'key', code: 'KeyJ' }]);
    expect(map.moveForward).toEqual(DEFAULT_BINDINGS.moveForward);
    expect(Object.keys(map).sort()).toEqual([...ACTIONS].sort());
  });

  it('validates the binding shape per device', () => {
    const map = sanitizeBindingMap({
      fire: [
        { device: 'mouse', button: 0 },
        { device: 'mouse', button: 99 },
        { device: 'key', code: '' },
        { device: 'key', code: 'Backquote' },
        { device: 'laser', code: 'KeyA' },
        { device: 'padAxis', axis: 1, direction: 2 },
        { device: 'padAxis', axis: 2, direction: -1 },
        'KeyF',
      ],
    });
    expect(map.fire).toEqual([
      { device: 'mouse', button: 0 },
      { device: 'padAxis', axis: 2, direction: -1 },
    ]);
  });

  it('restores defaults when every entry is invalid but keeps deliberately empty lists', () => {
    const map = sanitizeBindingMap({ jump: [{ device: 'key' }, null], reload: [] });
    expect(map.jump).toEqual(DEFAULT_BINDINGS.jump);
    expect(map.reload).toEqual([]);
  });

  it('removes duplicates and caps bindings per device family (keyboard/mouse first)', () => {
    const map = sanitizeBindingMap({
      sprint: [
        { device: 'pad', button: 10 },
        { device: 'key', code: 'ShiftLeft' },
        { device: 'key', code: 'ShiftLeft' },
        { device: 'key', code: 'KeyZ' },
        { device: 'key', code: 'KeyX' },
      ],
    });
    const kbm = map.sprint.filter((b) => b.device !== 'pad' && b.device !== 'padAxis');
    expect(kbm).toHaveLength(INPUT.maxBindingsPerFamily);
    expect(map.sprint).toEqual([
      { device: 'key', code: 'ShiftLeft' },
      { device: 'key', code: 'KeyZ' },
      { device: 'pad', button: 10 },
    ]);
  });
});

describe('sanitizeProfile', () => {
  it('repairs fields individually', () => {
    const p = sanitizeProfile(
      {
        createdAt: -1,
        lastPlayedAt: 5000,
        unlocks: { dash: true, doubleJump: 'nope' },
        qualityBenchmarked: true,
      },
      777,
    );
    expect(p).toEqual({
      ...createDefaultProfile(777),
      lastPlayedAt: 5000,
      unlocks: { doubleJump: false, dash: true },
      qualityBenchmarked: true,
    });
  });
});

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

describe('migrateSave', () => {
  it('has a migration for every older version', () => {
    for (let v = 0; v < SAVE_VERSION; v++) expect(typeof MIGRATIONS[v]).toBe('function');
  });

  it('returns defaults (not recovered) when nothing is stored', () => {
    const r = migrateSave(undefined, 5);
    expect(r).toMatchObject({ status: 'empty', recovered: false, migratedFrom: null });
    expect(r.data).toEqual(createDefaultSave(5));
  });

  it('keeps current-version data', () => {
    const save = sampleSave();
    const r = migrateSave(JSON.parse(JSON.stringify(save)));
    expect(r).toMatchObject({
      status: 'current',
      recovered: false,
      migratedFrom: null,
      storedVersion: SAVE_VERSION,
    });
    expect(r.data).toEqual(save);
  });

  it('migrates the legacy v0 flat format into v1', () => {
    const legacy = {
      settings: { controls: { fov: 80, invertY: false }, graphics: { preset: 'low' } },
      sensitivity: 2.5,
      fov: 105,
      masterVolume: 0.4,
      invertY: true,
      createdAt: 1234,
    };
    const r = migrateSave(JSON.stringify(legacy), 9999);
    expect(r).toMatchObject({ status: 'migrated', migratedFrom: 0, recovered: false, storedVersion: 0 });
    expect(r.data.version).toBe(SAVE_VERSION);
    expect(r.data.settings.controls.mouseSensitivity).toBe(2.5);
    expect(r.data.settings.controls.fov).toBe(105);
    expect(r.data.settings.controls.invertY).toBe(true);
    expect(r.data.settings.audio.master).toBe(0.4);
    expect(r.data.settings.graphics.preset).toBe('low');
    expect(r.data.profile.createdAt).toBe(1234);
    expect(r.data.profile.qualityAutoDetected).toBe(false);
  });

  it('sanitizes migrated legacy values', () => {
    const r = migrateSave({ fov: 999, sensitivity: 'abc' });
    expect(r.data.settings.controls.fov).toBe(CAMERA.maxFov);
    expect(r.data.settings.controls.mouseSensitivity).toBe(createDefaultSettings().controls.mouseSensitivity);
  });

  it('recovers from corrupt data', () => {
    for (const raw of ['{"version":1,', 'null-ish', 17, [1, 2], { version: -1 }, { version: 'one' }]) {
      const r = migrateSave(raw);
      expect(r.recovered).toBe(true);
      expect(r.status).toBe('corrupt');
      expect(r.data.version).toBe(SAVE_VERSION);
    }
  });

  it('does not accept saves from newer versions', () => {
    const r = migrateSave({ version: SAVE_VERSION + 1, settings: {}, profile: {} });
    expect(r).toMatchObject({ status: 'future', recovered: true, storedVersion: SAVE_VERSION + 1 });
    expect(r.data).toMatchObject({ version: SAVE_VERSION });
  });
});

// ---------------------------------------------------------------------------
// SaveSystem
// ---------------------------------------------------------------------------

describe('SaveSystem', () => {
  it('round-trips through IndexedDB and survives a new instance', async () => {
    const factory = new IDBFactory();
    const a = await SaveSystem.create(idbOnly(factory));
    expect(a.backendName).toBe('indexeddb');
    const save = sampleSave();
    await a.save(save);

    const b = await SaveSystem.create(idbOnly(factory));
    const loaded = await b.load();
    expect(loaded).toEqual(save);
    expect(b.lastLoad?.status).toBe('current');
  });

  it('snapshots data at save() time and keeps the previous save as backup', async () => {
    const sys = await SaveSystem.create(idbOnly());
    const save = sampleSave();
    await sys.save(save);
    save.settings.controls.fov = 111;
    const pending = sys.save(save);
    save.settings.controls.fov = 70; // mutation after save() must not leak into the write
    await pending;
    expect((await sys.load()).settings.controls.fov).toBe(111);
    const backup = (await sys.backend.read(SLOT + BACKUP_SUFFIX)) as SaveData;
    expect(backup.settings.controls.fov).toBe(104);
  });

  it('serializes and coalesces concurrent writes (last call wins)', async () => {
    const storage = new MemoryStorage();
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    const writes: number[] = [];
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      if (k === LS_PREFIX + SLOT) writes.push((JSON.parse(v) as SaveData).settings.controls.fov);
      setItem(k, v);
    };
    const save = sampleSave();
    const promises: Promise<void>[] = [];
    for (const fov of [80, 90, 100, 110]) {
      save.settings.controls.fov = fov;
      promises.push(sys.save(save));
    }
    await Promise.all(promises);
    expect(writes[writes.length - 1]).toBe(110);
    expect(writes.length).toBeLessThan(4);
    expect((await sys.load()).settings.controls.fov).toBe(110);
  });

  it('orders clear() between saves', async () => {
    const sys = await SaveSystem.create(idbOnly());
    const save = sampleSave();
    void sys.save(save);
    void sys.clear();
    save.settings.controls.fov = 99;
    await sys.save(save);
    expect((await sys.load()).settings.controls.fov).toBe(99);
    await sys.clear();
    const after = await sys.load();
    expect(after.settings).toEqual(createDefaultSettings());
    expect(sys.lastLoad?.status).toBe('empty');
  });

  it('migrates a stored v0 save and persists the upgraded form', async () => {
    const sys = await SaveSystem.create(idbOnly());
    await sys.backend.write(SLOT, { sensitivity: 3, fov: 95 });
    const loaded = await sys.load();
    expect(sys.lastLoad).toMatchObject({ status: 'migrated', migratedFrom: 0 });
    expect(loaded.settings.controls.fov).toBe(95);
    await sys.save(loaded); // flush chain
    const stored = (await sys.backend.read(SLOT)) as SaveData;
    expect(stored.version).toBe(SAVE_VERSION);
    expect(stored.settings.controls.mouseSensitivity).toBe(3);
  });

  it('imports the legacy localStorage save when the slot is empty', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ENGINE.localStorageKey, JSON.stringify({ fov: 88, masterVolume: 0.3 }));
    const factory = new IDBFactory();
    const sys = await SaveSystem.create({ env: { indexedDB: factory, localStorage: storage } });
    const loaded = await sys.load();
    expect(loaded.settings.controls.fov).toBe(88);
    expect(loaded.settings.audio.master).toBe(0.3);
    await sys.save(loaded);
    const again = await SaveSystem.create({ env: { indexedDB: factory, localStorage: null } });
    expect((await again.load()).settings.controls.fov).toBe(88);
    await sys.clear();
    expect(storage.getItem(ENGINE.localStorageKey)).toBeNull();
  });

  it('returns defaults for corrupt JSON and keeps the corrupt data', async () => {
    const storage = new MemoryStorage();
    storage.setItem(LS_PREFIX + SLOT, '{"version":1,"settings":');
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    const loaded = await sys.load();
    expect(loaded).toEqual({ ...createDefaultSave(loaded.profile.createdAt) });
    expect(sys.lastLoad).toMatchObject({ status: 'corrupt', recovered: true });
    expect(storage.getItem(`${LS_PREFIX}${SLOT}.corrupt${BACKUP_SUFFIX}`)).not.toBeNull();
  });

  it('keeps a backup of a save from a newer version and never overwrites it', async () => {
    const sys = await SaveSystem.create(idbOnly());
    const future = { version: SAVE_VERSION + 1, settings: { shiny: true }, profile: { level: 42 } };
    await sys.backend.write(SLOT, future);
    const loaded = await sys.load();
    expect(sys.lastLoad).toMatchObject({ status: 'future', recovered: true });
    expect(loaded.version).toBe(SAVE_VERSION);
    const futureKey = `${SLOT}.v${SAVE_VERSION + 1}${BACKUP_SUFFIX}`;
    expect(await sys.backend.read(futureKey)).toEqual(future);

    await sys.save(loaded);
    await sys.save(sampleSave());
    expect(await sys.backend.read(futureKey)).toEqual(future);
    expect(jsonEqual(await sys.backend.read(SLOT), sampleSave())).toBe(true);
  });

  it('falls back to localStorage when IndexedDB is missing or broken', async () => {
    const storage = new MemoryStorage();
    const noIdb = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    expect(noIdb.backendName).toBe('localStorage');
    await noIdb.save(sampleSave());
    expect(storage.getItem(LS_PREFIX + SLOT)).not.toBeNull();
    expect(await noIdb.load()).toEqual(sampleSave());

    const broken = {
      open: () => {
        throw new Error('InvalidStateError');
      },
    } as unknown as IDBFactory;
    const sys = await SaveSystem.create({ env: { indexedDB: broken, localStorage: new MemoryStorage() } });
    expect(sys.backendName).toBe('localStorage');
  });

  it('times out on a hanging IndexedDB open', async () => {
    const hanging = { open: () => ({}) } as unknown as IDBFactory;
    const sys = await SaveSystem.create({
      env: { indexedDB: hanging, localStorage: new MemoryStorage() },
      timeoutMs: 20,
    });
    expect(sys.backendName).toBe('localStorage');
  });

  it('falls back to memory when no storage accepts writes, and still works in-session', async () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    expect(sys.backendName).toBe('memory');
    await sys.save(sampleSave());
    expect(await sys.load()).toEqual(sampleSave());
  });

  it('never throws from load() or save() when the backend fails later', async () => {
    const storage = new MemoryStorage();
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    storage.failReads = true;
    storage.failWrites = true;
    await expect(sys.load()).resolves.toMatchObject({ version: SAVE_VERSION });
    await expect(sys.save(sampleSave())).resolves.toBeUndefined();
    await expect(sys.clear()).resolves.toBeUndefined();
  });
});
