/**
 * One-time recast-navigation initialization. The package's default wasm build is the
 * "wasm-compat" variant (wasm embedded in JS), so it loads in browsers, workers and node alike.
 */
import { init } from 'recast-navigation';
import { createLogger } from '../core/log';

const log = createLogger('nav');

let ready: Promise<boolean> | null = null;

/** Resolves true once recast is usable; false (logged) if the wasm module failed to load. */
export function ensureRecast(): Promise<boolean> {
  if (!ready) {
    ready = init().then(
      () => true,
      (err: unknown) => {
        log.error('recast-navigation init failed', err);
        // Allow a later retry (e.g. a transient network error while fetching the chunk).
        ready = null;
        return false;
      },
    );
  }
  return ready;
}
