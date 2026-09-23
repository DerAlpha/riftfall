import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { SaveData } from '../core/contracts';
import { CAMERA } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { ACTIONS, DEFAULT_BINDINGS, INPUT } from '../defs/input';
import { MENU } from '../defs/ui';
import { createDefaultProfile, createDefaultSave } from './defaults';
import { MIGRATIONS, SAVE_VERSION, migrateSave } from './migrations';
import { SETTINGS_SECTIONS, sanitizeBindingMap, sanitizeProfile, sanitizeSettings } from './sanitize';
import { BACKUP_SUFFIX, FALLBACK_BACKUP_SUFFIX, SaveSystem, type IndexedDbBackend } from './SaveSystem';
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

/** IndexedDB that never answers (open times out after `timeoutMs`). */
function hangingIdb(): IDBFactory {
  return { open: () => ({}) } as unknown as IDBFactory;
}

/** Wraps a factory: collects every opened connection (to force-close it) and can fail opens. */
function controlledIdb(inner: IDBFactory) {
  const opened: IDBDatabase[] = [];
  const control = { opened, failOpen: false };
  const factory = {
    open(name: string, version?: number): IDBOpenDBRequest {
      if (control.failOpen) throw new DOMException('Internal error opening backing store', 'UnknownError');
      const req = inner.open(name, version);
      req.addEventListener('success', () => opened.push(req.result));
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, control };
}

function forceClose(db: IDBDatabase | undefined): void {
  expect(db).toBeDefined();
  forceCloseDatabase(db as unknown as Parameters<typeof forceCloseDatabase>[0]);
}

function openDb(factory: IDBFactory, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(ENGINE.saveDbName, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

function readDb(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(ENGINE.saveStoreName, 'readonly').objectStore(ENGINE.saveStoreName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('read failed'));
  });
}

function withFov(fov: number): SaveData {
  const save = sampleSave();
  save.settings.controls.fov = fov;
  return save;
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
        { device: 'key', code: 'F3' },
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

  it('never overwrites a save from a newer version: keeps it, backs it up, saves in memory only', async () => {
    const factory = new IDBFactory();
    const sys = await SaveSystem.create(idbOnly(factory));
    const future = { version: SAVE_VERSION + 1, settings: { shiny: true }, profile: { level: 42 } };
    await sys.backend.write(SLOT, future);
    const loaded = await sys.load();
    expect(sys.lastLoad).toMatchObject({ status: 'future', recovered: true });
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(sys.unavailable).toBe('future');
    expect(sys.backendName).toBe('memory');

    await sys.save(loaded);
    await sys.save(sampleSave());
    // The session keeps working in memory …
    expect(await sys.load()).toEqual(sampleSave());
    // … while storage still holds the newer build's save untouched (no .bak rotation either).
    const other = await SaveSystem.create(idbOnly(factory));
    expect(await other.backend.read(SLOT)).toEqual(future);
    expect(await other.backend.read(SLOT + BACKUP_SUFFIX)).toBeUndefined();
    expect(await other.backend.read(`${SLOT}.v${SAVE_VERSION + 1}${BACKUP_SUFFIX}`)).toEqual(future);
  });

  it('keeps a newer save in localStorage untouched as well', async () => {
    const storage = new MemoryStorage();
    const future = JSON.stringify({ version: 99, settings: { controls: { fov: 117 } }, profile: {} });
    storage.setItem(LS_PREFIX + SLOT, future);
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    await sys.load();
    await sys.save(sampleSave());
    await sys.save(withFov(90));
    await sys.clear();
    expect(storage.getItem(LS_PREFIX + SLOT)).toBe(future);
    expect(storage.getItem(LS_PREFIX + SLOT + BACKUP_SUFFIX)).toBeNull();
    expect(storage.getItem(`${LS_PREFIX}${SLOT}.v99${BACKUP_SUFFIX}`)).toBe(future);
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

  it('does not overwrite the stored save with defaults when loading fails', async () => {
    const storage = new MemoryStorage();
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    await sys.save(sampleSave());
    storage.failReads = true;
    await sys.load();
    storage.failReads = false;
    await sys.save(withFov(70));
    expect(sys.unavailable).toBe('storageLost');
    const again = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    expect(await again.load()).toEqual(sampleSave());
  });

  it('saves even when the backup copy cannot be written', async () => {
    const storage = new MemoryStorage();
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      if (k.endsWith(BACKUP_SUFFIX)) throw new DOMException('quota', 'QuotaExceededError');
      setItem(k, v);
    };
    await sys.save(withFov(100));
    await sys.save(withFov(112));
    expect((await sys.load()).settings.controls.fov).toBe(112);
  });

  it('drops the backup copy when the save itself exceeds the quota', async () => {
    const storage = new MemoryStorage();
    const sys = await SaveSystem.create({ env: { indexedDB: null, localStorage: storage } });
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      const bakExists = storage.getItem(LS_PREFIX + SLOT + BACKUP_SUFFIX) !== null;
      if (k === LS_PREFIX + SLOT && bakExists) throw new DOMException('quota', 'QuotaExceededError');
      setItem(k, v);
    };
    await sys.save(withFov(100));
    await sys.save(withFov(112));
    expect((await sys.load()).settings.controls.fov).toBe(112);
    expect(storage.getItem(LS_PREFIX + SLOT + BACKUP_SUFFIX)).toBeNull();
  });

  it('retries a transient IndexedDB open failure before falling back', async () => {
    const inner = new IDBFactory();
    let opens = 0;
    const flaky = {
      open: (name: string, version?: number) => {
        if (opens++ === 0) throw new DOMException('Internal error opening backing store', 'UnknownError');
        return inner.open(name, version);
      },
    } as unknown as IDBFactory;
    const sys = await SaveSystem.create({ env: { indexedDB: flaky, localStorage: new MemoryStorage() } });
    expect(sys.backendName).toBe('indexeddb');
    expect(opens).toBe(2);
  });

  it('reopens IndexedDB after the browser closed the connection', async () => {
    const inner = new IDBFactory();
    const { factory, control } = controlledIdb(inner);
    const sys = await SaveSystem.create(idbOnly(factory));
    await sys.save(sampleSave());

    forceClose(control.opened[0]); // fires "close"
    await sys.save(withFov(88));
    expect(sys.backendName).toBe('indexeddb');
    // Closed without a close event (older browsers): the InvalidStateError triggers the reopen.
    (sys.backend as IndexedDbBackend).close();
    await sys.save(withFov(89));
    expect(sys.backendName).toBe('indexeddb');
    expect(sys.unavailable).toBeNull();

    const fresh = await SaveSystem.create(idbOnly(inner));
    expect((await fresh.load()).settings.controls.fov).toBe(89);
  });

  it('stops saving when a newer build takes over the database instead of forking the save', async () => {
    const factory = new IDBFactory();
    const storage = new MemoryStorage();
    const env = { env: { indexedDB: factory, localStorage: storage } };
    const sys = await SaveSystem.create(env);
    await sys.save(sampleSave());

    const newer = await openDb(factory, 2); // our connection closes on versionchange
    await sys.save(withFov(77));
    expect(sys.unavailable).toBe('versionchange');
    expect(sys.backendName).toBe('memory');
    expect((await sys.load()).settings.controls.fov).toBe(77); // in-session state is kept
    expect(storage.getItem(LS_PREFIX + SLOT)).toBeNull();
    expect(((await readDb(newer, SLOT)) as SaveData).settings.controls.fov).toBe(104);

    // A later session of this (older) build cannot open the upgraded database: memory only.
    const later = await SaveSystem.create(env);
    expect(later.unavailable).toBe('versionchange');
    expect(later.backendName).toBe('memory');
    newer.close();
  });

  it('falls back to localStorage when a lost connection cannot be reopened and merges it back later', async () => {
    const inner = new IDBFactory();
    const storage = new MemoryStorage();
    const { factory, control } = controlledIdb(inner);
    const sys = await SaveSystem.create({ env: { indexedDB: factory, localStorage: storage } });
    await sys.load();
    await sys.save(sampleSave());

    control.failOpen = true;
    forceClose(control.opened[0]);
    await sys.save(withFov(112));
    expect(sys.backendName).toBe('localStorage');
    expect(storage.getItem(LS_PREFIX + SLOT)).not.toBeNull();

    const next = await SaveSystem.create({ env: { indexedDB: inner, localStorage: storage } });
    const loaded = await next.load();
    expect(loaded.settings.controls.fov).toBe(112);
    await next.save(loaded); // flush the merge write
    expect(storage.getItem(LS_PREFIX + SLOT)).toBeNull();
    const third = await SaveSystem.create(idbOnly(inner));
    expect((await third.load()).settings.controls.fov).toBe(112);
  });

  it('adopts a localStorage save when IndexedDB is empty', async () => {
    const storage = new MemoryStorage();
    const a = await SaveSystem.create({
      env: { indexedDB: hangingIdb(), localStorage: storage },
      timeoutMs: 20,
    });
    expect(a.backendName).toBe('localStorage');
    await a.load();
    await a.save(sampleSave());

    const inner = new IDBFactory();
    const b = await SaveSystem.create({ env: { indexedDB: inner, localStorage: storage } });
    const loaded = await b.load();
    expect(loaded).toEqual(sampleSave());
    await b.save(loaded);
    expect(storage.getItem(LS_PREFIX + SLOT)).toBeNull();
    const c = await SaveSystem.create(idbOnly(inner));
    expect(await c.load()).toEqual(sampleSave());
  });

  it('never lets a session that fell back at boot replace the IndexedDB save', async () => {
    const inner = new IDBFactory();
    const storage = new MemoryStorage();
    const s0 = await SaveSystem.create({ env: { indexedDB: inner, localStorage: storage } });
    await s0.load();
    await s0.save(withFov(95));

    // IndexedDB hangs: this session starts from defaults in localStorage.
    const a = await SaveSystem.create({
      env: { indexedDB: hangingIdb(), localStorage: storage },
      timeoutMs: 20,
    });
    expect(a.backendName).toBe('localStorage');
    const defaults = await a.load();
    expect(a.lastLoad?.status).toBe('empty');
    defaults.settings.controls.fov = 111;
    await a.save(defaults);

    const b = await SaveSystem.create({ env: { indexedDB: inner, localStorage: storage } });
    expect((await b.load()).settings.controls.fov).toBe(95);
    expect(b.lastLoad?.status).toBe('current');
    const kept = (await b.backend.read(SLOT + FALLBACK_BACKUP_SUFFIX)) as SaveData;
    expect(kept.settings.controls.fov).toBe(111);
    expect(storage.getItem(LS_PREFIX + SLOT)).toBeNull();
  });

  it('clear() also drops a localStorage fallback copy so it cannot come back', async () => {
    const storage = new MemoryStorage();
    const a = await SaveSystem.create({
      env: { indexedDB: hangingIdb(), localStorage: storage },
      timeoutMs: 20,
    });
    await a.save(sampleSave());
    const b = await SaveSystem.create({ env: { indexedDB: new IDBFactory(), localStorage: storage } });
    await b.clear();
    expect(storage.getItem(LS_PREFIX + SLOT)).toBeNull();
    expect((await b.load()).settings).toEqual(createDefaultSettings());
  });
});
