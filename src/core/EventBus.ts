/**
 * Minimal, allocation-free (on emit) typed event bus.
 *
 * Systems communicate through the bus instead of holding references to each other
 * wherever the coupling is "fire and forget" (audio reacting to a jump, HUD reacting
 * to a quality change, ...). Direct calls are still fine for hard dependencies.
 */
export type Handler<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private readonly handlers = new Map<keyof E, Handler<never>[]>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  /** Subscribe for exactly one emission. */
  once<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof E>(type: K, handler: Handler<E[K]>): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler as Handler<never>);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Emit synchronously. Handlers added/removed during emission do not affect the
   * current dispatch: the handler count is frozen up front and several handlers are
   * iterated over a copy. A single handler needs no copy (zero allocation): it is read
   * before it runs, and handlers it adds lie beyond the frozen count.
   * A throwing handler is isolated so one faulty listener cannot break the game loop.
   */
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    const n = list.length;
    const snapshot = n === 1 ? list : list.slice();
    for (let i = 0; i < n; i++) {
      try {
        (snapshot[i] as Handler<E[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(type)}" threw`, err);
      }
    }
  }

  listenerCount<K extends keyof E>(type: K): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
