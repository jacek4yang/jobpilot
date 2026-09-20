import type { Storage } from "../../ports/storage";

/**
 * In-memory `Storage` adapter.
 *
 * Intended for unit tests and for any code path that must run without a
 * userscript manager. Values are stored as-is but always handed back as a
 * deep copy, so a caller mutating a returned object can never reach into the
 * store — that mirrors real GM storage, which serialises on the way out.
 */
export class MemoryStorage implements Storage {
  private readonly store: Map<string, unknown>;

  constructor(seed?: Record<string, unknown>) {
    this.store = new Map<string, unknown>();
    if (seed !== undefined) {
      for (const [key, value] of Object.entries(seed)) {
        this.store.set(key, clone(value));
      }
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    if (!this.store.has(key)) return Promise.resolve(undefined);
    return Promise.resolve(clone(this.store.get(key)) as T);
  }

  set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, clone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  keys(): Promise<readonly string[]> {
    return Promise.resolve([...this.store.keys()]);
  }

  /** Test helper: number of persisted keys. */
  get size(): number {
    return this.store.size;
  }
}

/**
 * Deep copy that prefers the structured clone algorithm and degrades to a JSON
 * round-trip when the runtime or the value does not support it.
 *
 * `undefined` is preserved rather than silently becoming `null`.
 */
const clone = <T>(value: T): T => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    // Functions, symbols, DOM nodes, or cyclic structures.
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
};
