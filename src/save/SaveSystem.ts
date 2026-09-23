/**
 * Persistent save storage with graceful degradation: IndexedDB → localStorage → memory.
 *
 * - Backend selection probes real writes, so private modes, disabled storage and zero quotas are
 *   detected up front instead of failing on the first save.
 * - Writes are serialized through one promise chain (never interleave) and coalesced: several
 *   save() calls before the write starts produce one write of the newest snapshot.
 * - Before overwriting, the previous save is copied to `<key>.bak`. Data from a newer build is kept
 *   in `<key>.v<N>.bak` and unreadable data in `<key>.corrupt.bak`, so nothing is ever destroyed.
 * - load() never throws; it migrates old formats (see migrations.ts) and imports the legacy v0 save
 *   from localStorage (ENGINE.localStorageKey) when the slot is empty.
 */
import type { SaveBackend, SaveData, SaveSystemApi } from '../core/contracts';
import { createLogger } from '../core/log';
import { ENGINE } from '../defs/engine';
import { createDefaultSave } from './defaults';
import { SAVE_VERSION, migrateSave, type MigrationResult } from './migrations';
import { cloneJson } from './sanitize';

const log = createLogger('Save');

export const BACKUP_SUFFIX = '.bak';
/** IndexedDB schema version (object store layout), independent of the save data version. */
const IDB_SCHEMA_VERSION = 1;
const PROBE_KEY = '__probe__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export class MemoryBackend implements SaveBackend {
  readonly name = 'memory' as const;
  /** JSON strings, so stored values are copies like with the persistent backends. */
  private readonly store = new Map<string, string>();

  read(key: string): Promise<unknown | undefined> {
    const s = this.store.get(key);
    return Promise.resolve(s === undefined ? undefined : (JSON.parse(s) as unknown));
  }

  write(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

export class LocalStorageBackend implements SaveBackend {
  readonly name = 'localStorage' as const;

  constructor(
    private readonly storage: Storage,
    /** Distinct from ENGINE.localStorageKey, which holds the legacy v0 save. */
    private readonly prefix = `${ENGINE.localStorageKey}/`,
  ) {}

  /** True if the storage accepts writes (fails in some private modes / with a zero quota). */
  static probe(storage: Storage, prefix = `${ENGINE.localStorageKey}/`): boolean {
    const key = prefix + PROBE_KEY;
    try {
      storage.setItem(key, '1');
      const ok = storage.getItem(key) === '1';
      storage.removeItem(key);
      return ok;
    } catch {
      return false;
    }
  }

  read(key: string): Promise<unknown | undefined> {
    try {
      const s = this.storage.getItem(this.prefix + key);
      if (s === null) return Promise.resolve(undefined);
      try {
        return Promise.resolve(JSON.parse(s) as unknown);
      } catch {
        // Hand the raw text to the migration so it is reported (and backed up) as corrupt.
        return Promise.resolve(s);
      }
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  write(key: string, value: unknown): Promise<void> {
    try {
      this.storage.setItem(this.prefix + key, JSON.stringify(value));
      return Promise.resolve();
    } catch (err) {
      // QuotaExceededError / SecurityError.
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  remove(key: string): Promise<void> {
    try {
      this.storage.removeItem(this.prefix + key);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export class IndexedDbBackend implements SaveBackend {
  readonly name = 'indexeddb' as const;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly storeName: string,
  ) {
    // Another tab upgrading the schema: release our connection instead of blocking it.
    db.onversionchange = () => db.close();
  }

  /** Opens (and creates) the database, then probes a write. Rejects on any failure or timeout. */
  static async open(
    factory: IDBFactory,
    dbName: string,
    storeName: string,
    timeoutMs: number,
  ): Promise<IndexedDbBackend> {
    let timedOut = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(dbName, IDB_SCHEMA_VERSION);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        if (timedOut) {
          req.result.close();
          return;
        }
        resolve(req.result);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
    });
    let db: IDBDatabase;
    try {
      db = await withTimeout(opening, timeoutMs, 'IndexedDB open');
    } catch (err) {
      timedOut = true;
      throw err;
    }
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      throw new Error(`IndexedDB store "${storeName}" missing`);
    }
    const backend = new IndexedDbBackend(db, storeName);
    try {
      await withTimeout(
        backend.write(PROBE_KEY, 1).then(() => backend.remove(PROBE_KEY)),
        timeoutMs,
        'IndexedDB probe',
      );
    } catch (err) {
      db.close();
      throw err;
    }
    return backend;
  }

  async read(key: string): Promise<unknown | undefined> {
    const tx = this.db.transaction(this.storeName, 'readonly');
    const value = await requestToPromise<unknown>(tx.objectStore(this.storeName).get(key));
    return value === undefined ? undefined : value;
  }

  async write(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(this.storeName).put(value, key);
    await done;
  }

  async remove(key: string): Promise<void> {
    const tx = this.db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(this.storeName).delete(key);
    await done;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// SaveSystem
// ---------------------------------------------------------------------------

export interface SaveEnvironment {
  indexedDB: IDBFactory | null;
  localStorage: Storage | null;
}

export interface SaveSystemOptions {
  /** Override detected browser storage (tests; `null` disables a backend). */
  env?: Partial<SaveEnvironment>;
  dbName?: string;
  storeName?: string;
  slotKey?: string;
  timeoutMs?: number;
}

/** Storage globals, tolerating browsers that throw on access (blocked site data). */
export function detectSaveEnvironment(): SaveEnvironment {
  return { indexedDB: tryGet(() => indexedDB), localStorage: tryGet(() => localStorage) };
}

function tryGet<T>(get: () => T): T | null {
  try {
    return get() ?? null;
  } catch {
    // Undefined global (ReferenceError) or SecurityError when site data is blocked.
    return null;
  }
}

interface QueuedWrite {
  data: SaveData;
  promise: Promise<void>;
}

export class SaveSystem implements SaveSystemApi {
  /** Tail of the serialized I/O chain; never rejects. */
  private tail: Promise<void> = Promise.resolve();
  /** Write that is queued but has not started yet (receives newer snapshots). */
  private queued: QueuedWrite | null = null;
  private lastResult: MigrationResult | null = null;

  private constructor(
    readonly backend: SaveBackend,
    private readonly legacyStorage: Storage | null,
    private readonly key: string,
  ) {}

  static async create(opts: SaveSystemOptions = {}): Promise<SaveSystem> {
    const env: SaveEnvironment = { ...detectSaveEnvironment(), ...opts.env };
    const timeoutMs = opts.timeoutMs ?? ENGINE.saveBackendTimeoutMs;
    let backend: SaveBackend | null = null;

    if (env.indexedDB) {
      try {
        backend = await IndexedDbBackend.open(
          env.indexedDB,
          opts.dbName ?? ENGINE.saveDbName,
          opts.storeName ?? ENGINE.saveStoreName,
          timeoutMs,
        );
      } catch (err) {
        log.warn('IndexedDB unavailable – falling back to localStorage', err);
      }
    }
    if (!backend && env.localStorage && LocalStorageBackend.probe(env.localStorage)) {
      backend = new LocalStorageBackend(env.localStorage);
    }
    if (!backend) {
      log.warn('No persistent storage available – settings and progress will not survive a reload');
      backend = new MemoryBackend();
    }
    log.info(`Save backend: ${backend.name}`);
    return new SaveSystem(backend, env.localStorage, opts.slotKey ?? ENGINE.saveSlotKey);
  }

  get backendName(): SaveBackend['name'] {
    return this.backend.name;
  }

  /** Outcome of the last load() (migration / recovery info for the debug overlay and tests). */
  get lastLoad(): Readonly<MigrationResult> | null {
    return this.lastResult;
  }

  async load(): Promise<SaveData> {
    await this.tail;
    try {
      let raw = await this.backend.read(this.key);
      let fromLegacy = false;
      if (raw === undefined) {
        raw = this.readLegacy();
        fromLegacy = raw !== undefined;
      }
      const result = migrateSave(raw);
      this.lastResult = result;
      if (result.status === 'future') {
        await this.backupRaw(`${this.key}.v${result.storedVersion ?? 'x'}${BACKUP_SUFFIX}`, raw);
      } else if (result.status === 'corrupt') {
        await this.backupRaw(`${this.key}.corrupt${BACKUP_SUFFIX}`, raw);
      } else if (result.status === 'migrated' || fromLegacy) {
        // Persist the upgraded form now; save() keeps the old data as rolling backup.
        void this.save(result.data);
      }
      return result.data;
    } catch (err) {
      log.error('Loading the save failed – using defaults', err);
      return createDefaultSave();
    }
  }

  save(data: SaveData): Promise<void> {
    let snapshot: SaveData;
    try {
      // Snapshot now: callers keep mutating their object after calling save().
      snapshot = cloneJson(data);
    } catch (err) {
      log.error('Save data is not serializable – not saved', err);
      return Promise.resolve();
    }
    snapshot.version = SAVE_VERSION;
    if (this.queued) {
      this.queued.data = snapshot;
      return this.queued.promise;
    }
    const slot: QueuedWrite = { data: snapshot, promise: Promise.resolve() };
    slot.promise = this.tail.then(() => {
      if (this.queued === slot) this.queued = null;
      return this.writeSnapshot(slot.data);
    });
    this.queued = slot;
    this.tail = slot.promise;
    return slot.promise;
  }

  clear(): Promise<void> {
    // Saves requested after clear() must be queued behind it, not merged into an earlier write.
    this.queued = null;
    const run = this.tail.then(async () => {
      try {
        await this.backend.remove(this.key);
        await this.backend.remove(this.key + BACKUP_SUFFIX);
      } catch (err) {
        log.error('Clearing the save failed', err);
      }
      try {
        this.legacyStorage?.removeItem(ENGINE.localStorageKey);
      } catch {
        // Storage access denied – nothing to clear.
      }
      log.info('Save cleared');
    });
    this.tail = run;
    return run;
  }

  private async writeSnapshot(data: SaveData): Promise<void> {
    try {
      let previous: unknown;
      try {
        previous = await this.backend.read(this.key);
      } catch {
        previous = undefined;
      }
      if (previous !== undefined) await this.backend.write(this.key + BACKUP_SUFFIX, previous);
      await this.backend.write(this.key, data);
    } catch (err) {
      log.error(`Saving failed (${this.backend.name})`, err);
    }
  }

  private async backupRaw(key: string, raw: unknown): Promise<void> {
    try {
      await this.backend.write(key, raw);
      log.warn(`Unusable save data kept as "${key}"`);
    } catch (err) {
      log.error(`Could not back up unusable save data to "${key}"`, err);
    }
  }

  private readLegacy(): unknown {
    if (!this.legacyStorage) return undefined;
    try {
      const s = this.legacyStorage.getItem(ENGINE.localStorageKey);
      return s === null ? undefined : s;
    } catch {
      return undefined;
    }
  }
}
