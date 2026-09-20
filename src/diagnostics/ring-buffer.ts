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

  return {
    push(value) {
      items.push(value);
      if (items.length <= capacity) return;

      // Evict a batch rather than one item at a time: with a hot producer,
      // shifting per-push is quadratic and the drop callback would fire on
      // nearly every write.
      const overflow = items.length - capacity;
      const batch = Math.max(overflow, Math.ceil(capacity * 0.1));
      const evicted = Math.min(batch, items.length - Math.floor(capacity * 0.9));
      items = items.slice(evicted);
      dropped += evicted;
      options.onDrop?.(evicted);
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
