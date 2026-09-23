/**
 * Tagged logger. Keeps a small in-memory history so the dev console and debug
 * overlay can show recent warnings (e.g. missing assets replaced by placeholders).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  tag: string;
  message: string;
  time: number;
}

const HISTORY_LIMIT = 200;
const history: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();
let debugEnabled = import.meta.env?.DEV ?? false;

function push(level: LogLevel, tag: string, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a)))
    .join(' ');
  const entry: LogEntry = { level, tag, message, time: performance.now() };
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
  for (const l of listeners) l(entry);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => {
      if (!debugEnabled) return;
      push('debug', tag, args);
      console.debug(prefix, ...args); // eslint-disable-line no-console
    },
    info: (...args) => {
      push('info', tag, args);
      console.info(prefix, ...args);
    },
    warn: (...args) => {
      push('warn', tag, args);
      console.warn(prefix, ...args);
    },
    error: (...args) => {
      push('error', tag, args);
      console.error(prefix, ...args);
    },
  };
}

export function getLogHistory(): readonly LogEntry[] {
  return history;
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}
