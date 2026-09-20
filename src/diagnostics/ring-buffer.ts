/**
 * Bounded ring buffer.
 *
 * Diagnostics must never grow without limit during a long live test. Every
 * buffer in this layer is bounded, and the number of entries dropped is tracked
 * so the loss is visible rather than silent.
 */

export interface RingBufferOptions {
  /** Maximum retained entries. Older entries are evicted first. */
  readonly capacity: number;
  /** Called once per eviction batch with how many entries were dropped. */
  readonly onDrop?: (dropped: number) => void;
}

export interface RingBuffer<T> {
  push(value: T): void;
  /** Oldest first. */
  entries(): readonly T[];
  readonly size: number;
  readonly capacity: number;
  /** Total entries ever dropped, across the buffer's lifetime. */
  readonly dropped: number;
  clear(): void;
}

/** Prevents a nonsense capacity from silently disabling the buffer. */
const MIN_CAPACITY = 1;

export const createRingBuffer = <T>(options: RingBufferOptions): RingBuffer<T> => {
  const capacity = Math.max(MIN_CAPACITY, Math.floor(options.capacity));
  let items: T[] = [];
  let dropped = 0;
  /**
   * Re-entrancy guard.
   *
   * The drop callback is allowed to write (the recorder reports truncation as
   * an event, which lands back in this buffer). Without this guard, a small
   * capacity makes that recursion self-sustaining: evicting one entry lets the
   * nested push evict one more, forever. The count is still accumulated during
   * the nested call; only the *notification* is deferred, so nothing is lost.
   */
  let evicting = false;
  /** Notifications suppressed while a nested call was in progress. */
  let deferredNotifications = 0;

  return {
    push(value) {
      items.push(value);
      if (items.length <= capacity) return;

      // Evict down to the high-water mark in one step. `batch` is clamped to
      // what is actually evictable, so a large overflow cannot slice past the
      // target and silently discard more than intended.
      const highWater = Math.max(1, Math.floor(capacity * 0.9));
      const evictable = items.length - highWater;
      const batch = Math.min(Math.max(1, Math.ceil(capacity * 0.1)), evictable);
      items = items.slice(batch);
      dropped += batch;

      if (evicting) {
        deferredNotifications += batch;
        return;
      }

      evicting = true;
      try {
        options.onDrop?.(batch);
        // Flush anything the nested call suppressed, so a caller that only
        // observes the callback still sees the true total.
        if (deferredNotifications > 0) {
          const deferred = deferredNotifications;
          deferredNotifications = 0;
          options.onDrop?.(deferred);
        }
      } finally {
        evicting = false;
      }
    },

    entries: () => [...items],
    get size() {
      return items.length;
    },
    capacity,
    get dropped() {
      return dropped;
    },
    clear() {
      items = [];
      // `dropped` is intentionally not reset: it is a lifetime counter, and
      // hiding a previous truncation after a "clear buffers" action would
      // misrepresent whether evidence was lost.
    },
  };
};
