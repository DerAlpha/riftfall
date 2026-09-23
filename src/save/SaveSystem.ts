/**
 * Persistent save storage with graceful degradation: IndexedDB → localStorage → memory.
 *
 * - Backend selection probes real writes, so private modes, disabled storage and zero quotas are
 *   detected up front instead of failing on the first save. A failed IndexedDB open is retried
 *   (ENGINE.saveBackendOpenAttempts) unless it timed out.
 * - Writes are serialized through one promise chain (never interleave) and coalesced: several
 *   save() calls before the write starts produce one write of the newest snapshot.
 * - Before overwriting, the previous save is copied to `<key>.bak` (best effort: a failing backup
 *   never blocks the save itself). Unreadable data is kept in `<key>.corrupt.bak`, so nothing is
 *   ever destroyed.
 * - Data from a newer build is never overwritten: load() keeps a copy in `<key>.v<N>.bak` and the
 *   session saves to memory only. The same happens when a newer build takes over the IndexedDB
 *   database (versionchange / VersionError). A connection the browser closed is reopened; if that
 *   fails, saving continues in localStorage. `backendName` reads 'memory' whenever saves no longer
 *   persist (the pause menu warns the player).
 * - Stored records carry `savedAt` (monotonic ms) and `baseSavedAt` (the newest IndexedDB record the
 *   data descends from). A localStorage copy written while IndexedDB was unavailable is merged back
 *   by the next load() with IndexedDB – only if it descends from the IndexedDB save (or that one is
 *   empty or unusable). A session that fell back at boot started from defaults; its copy is kept as
 *   `<key>.localStorage.bak` instead of replacing the real save.
 * - load() never throws; it migrates old formats (see migrations.ts) and imports the legacy v0 save
 *   from localStorage (ENGINE.localStorageKey) when the slot is empty.
 */
import type { SaveBackend, SaveData, SaveSystemApi } from '../core/contracts';
import { createLogger } from '../core/log';
import { ENGINE } from '../defs/engine';
import { createDefaultSave } from './defaults';
import { SAVE_VERSION, migrateSave, type MigrationResult, type MigrationStatus } from './migrations';
import { cloneJson, isRecord } from './sanitize';

const log = createLogger('Save');

export const BACKUP_SUFFIX = '.bak';
/** Where load() keeps a localStorage copy that must not replace the IndexedDB save. */
export const FALLBACK_BACKUP_SUFFIX = `.localStorage${BACKUP_SUFFIX}`;
/** IndexedDB schema version (object store layout), independent of the save data version. */
const IDB_SCHEMA_VERSION = 1;
const PROBE_KEY = '__probe__';

/** Why an IndexedDB connection closed: another connection upgraded/deleted the database, or the browser. */
export type IdbCloseReason = 'versionchange' | 'forced';

/**
 * Why saves stopped persisting for the rest of the session: the stored save is from a newer build,
 * a newer build took over the database, or every storage became unusable.
 */
export type SaveUnavailableReason = 'future' | 'versionchange' | 'storageLost';

const UNAVAILABLE_MESSAGES: Readonly<Record<SaveUnavailableReason, string>> = {
  future: 'The save belongs to a newer build – it stays untouched, this session saves nothing',
  versionchange:
    'A newer build (or a reset in another tab) took over the save database – this session saves nothing, reload to continue saving',
  storageLost: 'Browser storage became unavailable – this session saves nothing',
};

/** Storage metadata stored next to the SaveData fields (migrateSave ignores unknown top-level keys). */
interface SaveStamp {
  savedAt: number;
  baseSavedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string'
    ? err.name
    : '';
}

/**
 * IDBDatabase.transaction() on a closed connection (InvalidStateError), or a transaction the
 * browser aborted while force-closing the connection (AbortError, before the close event).
 */
function isConnectionLostError(err: unknown): boolean {
  const name = errorName(err);
  return name === 'InvalidStateError' || name === 'AbortError';
}

function isQuotaError(err: unknown): boolean {
  const name = errorName(err);
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function stampOf(raw: unknown, field: keyof SaveStamp): number {
  if (!isRecord(raw)) return 0;
  const v = raw[field];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function isUsable(status: MigrationStatus): boolean {
  return status === 'current' || status === 'migrated';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
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
  private closeReason: IdbCloseReason | null = null;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly storeName: string,
  ) {
    // Another tab upgrading or deleting the database: release our connection instead of blocking
    // it. The data then belongs to that version, so SaveSystem stops writing.
    db.onversionchange = () => {
      this.closeReason = 'versionchange';
      db.close();
    };
    // Closed by the browser (site data cleared, storage server lost): SaveSystem reopens it.
    db.onclose = () => {
      this.closeReason ??= 'forced';
    };
  }

  /** Set once the connection is unusable. */
  get closedBy(): IdbCloseReason | null {
    return this.closeReason;
  }

  /** A transaction failed on a closed connection that fired no event (older browsers). */
  markClosed(reason: IdbCloseReason): void {
    this.closeReason ??= reason;
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
      // The open proceeds once the other connection closes (ours close on versionchange); the
      // timeout bounds the wait.
      req.onblocked = () => log.warn('IndexedDB open waits for another tab to release the database');
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

interface IdbConfig {
  factory: IDBFactory;
  dbName: string;
  storeName: string;
  timeoutMs: number;
}

/** IndexedDbBackend.open with retries for transient failures ("Internal error opening backing store"). */
async function openIndexedDb(cfg: IdbConfig): Promise<IndexedDbBackend> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await IndexedDbBackend.open(cfg.factory, cfg.dbName, cfg.storeName, cfg.timeoutMs);
    } catch (err) {
      // A timeout already cost the whole budget; a VersionError (newer schema) is permanent.
      const name = errorName(err);
      if (attempt >= ENGINE.saveBackendOpenAttempts || name === 'TimeoutError' || name === 'VersionError')
        throw err;
      log.warn(`IndexedDB open failed (attempt ${attempt}) – retrying`, err);
    }
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
  private active: SaveBackend;
  private unavailableReason: SaveUnavailableReason | null = null;
  /** The localStorage slot SaveSystem falls back to; load() merges it back into IndexedDB. */
  private readonly fallbackSlot: LocalStorageBackend | null;
  /** savedAt of the newest IndexedDB record this session's data descends from (0: none). */
  private baseStamp = 0;
  /** Largest savedAt seen: stamps stay monotonic even if the clock goes back. */
  private lastStamp = 0;
  /** load() adopted the localStorage copy: remove it once the data is safely in IndexedDB. */
  private retireFallbackPending = false;
  /** Only the first of consecutive write failures is logged as an error. */
  private writeFailing = false;

  private constructor(
    backend: SaveBackend,
    private readonly legacyStorage: Storage | null,
    private readonly key: string,
    private readonly idb: IdbConfig | null,
  ) {
    this.active = backend;
    this.fallbackSlot = legacyStorage ? new LocalStorageBackend(legacyStorage) : null;
  }

  static async create(opts: SaveSystemOptions = {}): Promise<SaveSystem> {
    const env: SaveEnvironment = { ...detectSaveEnvironment(), ...opts.env };
    const idb: IdbConfig | null = env.indexedDB
      ? {
          factory: env.indexedDB,
          dbName: opts.dbName ?? ENGINE.saveDbName,
          storeName: opts.storeName ?? ENGINE.saveStoreName,
          timeoutMs: opts.timeoutMs ?? ENGINE.saveBackendTimeoutMs,
        }
      : null;
    let backend: SaveBackend | null = null;
    let unavailable: SaveUnavailableReason | null = null;

    if (idb) {
      try {
        backend = await openIndexedDb(idb);
      } catch (err) {
        if (errorName(err) === 'VersionError') {
          // A newer build upgraded the database: forking its save into localStorage would split it.
          unavailable = 'versionchange';
        } else {
          log.warn('IndexedDB unavailable – falling back to localStorage', err);
        }
      }
    }
    if (!backend && !unavailable && env.localStorage && LocalStorageBackend.probe(env.localStorage)) {
      backend = new LocalStorageBackend(env.localStorage);
    }
    if (!backend) {
      if (!unavailable)
        log.warn('No persistent storage available – settings and progress will not survive a reload');
      backend = new MemoryBackend();
    }
    const sys = new SaveSystem(backend, env.localStorage, opts.slotKey ?? ENGINE.saveSlotKey, idb);
    if (unavailable) sys.stopPersisting(unavailable);
    log.info(`Save backend: ${sys.backendName}`);
    return sys;
  }

  /** The backend saves currently go to (replaced when IndexedDB closes or saving stops). */
  get backend(): SaveBackend {
    return this.active;
  }

  get backendName(): SaveBackend['name'] {
    return this.active.name;
  }

  /** Why saves stopped persisting this session; null while they persist. */
  get unavailable(): SaveUnavailableReason | null {
    return this.unavailableReason;
  }

  /** Outcome of the last load() (migration / recovery info for the debug overlay and tests). */
  get lastLoad(): Readonly<MigrationResult> | null {
    return this.lastResult;
  }

  async load(): Promise<SaveData> {
    await this.tail;
    try {
      await this.ensureUsable();
      const stored = await this.active.read(this.key);
      let raw = stored;
      let result = migrateSave(stored);
      let persist = false;
      if (this.active instanceof IndexedDbBackend) {
        this.baseStamp = stampOf(stored, 'savedAt');
        const copy = await this.takeFallbackCopy(stored, result.status);
        if (copy) {
          if (result.status === 'corrupt')
            await this.backupRaw(`${this.key}.corrupt${BACKUP_SUFFIX}`, stored);
          raw = copy.raw;
          result = copy.result;
          persist = true;
        }
      } else {
        this.baseStamp = stampOf(stored, 'baseSavedAt');
      }
      this.lastStamp = Math.max(this.lastStamp, this.baseStamp, stampOf(raw, 'savedAt'));
      if (raw === undefined) {
        raw = this.readLegacy();
        if (raw !== undefined) {
          result = migrateSave(raw);
          persist = true;
        }
      }
      this.lastResult = result;
      if (result.status === 'future') {
        await this.backupRaw(`${this.key}.v${result.storedVersion ?? 'x'}${BACKUP_SUFFIX}`, raw);
        // The newer build must find its save untouched: no write may replace it (or rotate .bak).
        this.stopPersisting('future');
      } else if (result.status === 'corrupt') {
        await this.backupRaw(`${this.key}.corrupt${BACKUP_SUFFIX}`, raw);
      } else if (result.status === 'migrated' || persist) {
        // Persist the upgraded / imported form now; save() keeps the old data as rolling backup.
        void this.save(result.data);
      }
      return result.data;
    } catch (err) {
      // What is stored is unknown: saving the defaults could overwrite a perfectly good save.
      log.error('Loading the save failed – using defaults', err);
      this.stopPersisting('storageLost');
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
        await this.ensureUsable();
        await this.active.remove(this.key);
        await this.active.remove(this.key + BACKUP_SUFFIX);
      } catch (err) {
        log.error('Clearing the save failed', err);
      }
      if (this.unavailableReason) {
        // Persistent storage belongs to another build (or is gone): only the session is reset.
        log.info('Save cleared (this session only)');
        return;
      }
      // The next load() would otherwise merge a localStorage fallback copy back in.
      await this.retireFallback();
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
    const record: SaveData & SaveStamp = { ...data, savedAt: this.nextStamp(), baseSavedAt: this.baseStamp };
    for (let attempt = 0; ; attempt++) {
      await this.ensureUsable();
      const backend = this.active;
      try {
        await this.writeWithBackup(backend, record);
      } catch (err) {
        if (attempt === 0 && backend instanceof IndexedDbBackend && isConnectionLostError(err)) {
          // ensureUsable() reopens it (or falls back) and the write is issued again.
          backend.markClosed('forced');
          continue;
        }
        if (!this.writeFailing) log.error(`Saving failed (${backend.name})`, err);
        this.writeFailing = true;
        return;
      }
      if (this.writeFailing) log.info(`Saving works again (${backend.name})`);
      this.writeFailing = false;
      if (backend instanceof IndexedDbBackend) {
        this.baseStamp = record.savedAt;
        if (this.retireFallbackPending) await this.retireFallback();
      }
      return;
    }
  }

  /** Rotates the previous save into `.bak` (best effort), then writes the record. */
  private async writeWithBackup(backend: SaveBackend, record: unknown): Promise<void> {
    let previous: unknown;
    try {
      previous = await backend.read(this.key);
    } catch {
      previous = undefined;
    }
    if (previous !== undefined) {
      try {
        await backend.write(this.key + BACKUP_SUFFIX, previous);
      } catch (err) {
        if (isConnectionLostError(err)) throw err;
        log.warn('Backup write failed – saving without a fresh backup', err);
      }
    }
    try {
      await backend.write(this.key, record);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // Two full copies do not fit (e.g. a shared origin's quota): the save beats its backup.
      await backend.remove(this.key + BACKUP_SUFFIX);
      await backend.write(this.key, record);
      log.warn('Storage quota exceeded – dropped the backup copy to save');
    }
  }

  /** Replaces a closed IndexedDB connection before the next I/O. */
  private async ensureUsable(): Promise<void> {
    const current = this.active;
    if (!(current instanceof IndexedDbBackend) || current.closedBy === null) return;
    if (current.closedBy === 'versionchange') {
      this.stopPersisting('versionchange');
      return;
    }
    if (this.idb) {
      current.close(); // no-op if the browser closed it already
      try {
        this.active = await openIndexedDb(this.idb);
        log.info('IndexedDB connection was closed by the browser – reopened');
        return;
      } catch (err) {
        if (errorName(err) === 'VersionError') {
          this.stopPersisting('versionchange');
          return;
        }
        log.warn('Reopening IndexedDB failed', err);
      }
    }
    if (this.legacyStorage && LocalStorageBackend.probe(this.legacyStorage)) {
      // Records carry baseStamp, so the next load() with IndexedDB merges them back.
      this.active = new LocalStorageBackend(this.legacyStorage);
      log.warn('IndexedDB lost – saving to localStorage for the rest of the session');
      return;
    }
    this.stopPersisting('storageLost');
  }

  /** Continue the session in memory without touching persistent storage again. */
  private stopPersisting(reason: SaveUnavailableReason): void {
    if (this.unavailableReason) return;
    this.unavailableReason = reason;
    if (this.active instanceof IndexedDbBackend) this.active.close();
    this.active = new MemoryBackend();
    log.warn(UNAVAILABLE_MESSAGES[reason]);
  }

  /**
   * The localStorage slot holds a save written while IndexedDB was unavailable. Returns it when it
   * descends from the IndexedDB save (or that one is empty/unusable); otherwise the copy started
   * from defaults or an older save and is kept as a backup instead of replacing the real save.
   */
  private async takeFallbackCopy(
    stored: unknown,
    storedStatus: MigrationStatus,
  ): Promise<{ raw: unknown; result: MigrationResult } | null> {
    // A newer build's save: this session is read-only and leaves everything as it is.
    if (!this.fallbackSlot || storedStatus === 'future') return null;
    let copy: unknown;
    try {
      copy = await this.fallbackSlot.read(this.key);
    } catch {
      return null;
    }
    if (copy === undefined) return null;
    const result = migrateSave(copy);
    const base = stampOf(copy, 'baseSavedAt');
    const descends = !isUsable(storedStatus) || (base > 0 && base >= stampOf(stored, 'savedAt'));
    if (isUsable(result.status) && descends) {
      log.info('Restoring the save written to localStorage while IndexedDB was unavailable');
      this.retireFallbackPending = true;
      return { raw: copy, result };
    }
    log.warn('localStorage holds a save that diverged from the IndexedDB save – not loaded');
    if (await this.backupRaw(this.key + FALLBACK_BACKUP_SUFFIX, copy)) await this.retireFallback();
    return null;
  }

  private async retireFallback(): Promise<void> {
    this.retireFallbackPending = false;
    if (!this.fallbackSlot) return;
    try {
      await this.fallbackSlot.remove(this.key);
      await this.fallbackSlot.remove(this.key + BACKUP_SUFFIX);
    } catch (err) {
      log.warn('Could not remove the localStorage copy of the save', err);
    }
  }

  private nextStamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  private async backupRaw(key: string, raw: unknown): Promise<boolean> {
    try {
      await this.active.write(key, raw);
      log.warn(`Save data that was not loaded is kept as "${key}"`);
      return true;
    } catch (err) {
      log.error(`Could not back up unusable save data to "${key}"`, err);
      return false;
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
