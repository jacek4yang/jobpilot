/**
 * Cross-tab execution lock.
 *
 * Two BOSS tabs must never drive the same queue. The port is intentionally
 * narrow — acquire, renew, release — so that a deterministic in-memory
 * implementation can stand in during tests while the browser uses
 * `navigator.locks` plus a storage-backed lease.
 */
export interface LockHandle {
  /** Opaque owner token; only the holder may renew or release. */
  readonly token: string;
  /** When the lease lapses if not renewed. */
  readonly expiresAt: number;
}

export type AcquireResult =
  | { readonly ok: true; readonly handle: LockHandle }
  | {
      readonly ok: false;
      readonly reason: "held-by-other" | "unsupported";
      readonly holder?: string;
    };

export interface Lock {
  /**
   * Attempts to take the lock. Never blocks waiting for a holder.
   *
   * A tab that cannot acquire the lock must render read-only rather than queue
   * work it cannot perform.
   */
  acquire(options: { readonly ownerId: string; readonly ttlMs: number }): Promise<AcquireResult>;
  /** Extends the lease. Returns false when the lock was lost. */
  renew(options: { readonly token: string; readonly ttlMs: number }): Promise<boolean>;
  /** Releases the lock if still held. Safe to call when not held. */
  release(token: string): Promise<void>;
  /** Current holder token, when one is present and unexpired. */
  currentHolder(): Promise<string | undefined>;
}

/** Lease/heartbeat defaults: a 3× margin between renewal and expiry. */
export const DEFAULT_LOCK_TTL_MS = 30_000;
export const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;

/**
 * In-memory lock for tests.
 *
 * Optionally seeded with a foreign holder so the "another tab owns it" path can
 * be exercised deterministically.
 */
export const createMemoryLock = (
  options: { readonly clock: { now(): number }; readonly seedHolder?: string } = {
    clock: { now: () => Date.now() },
  },
): Lock => {
  let holder: { token: string; expiresAt: number } | undefined =
    options.seedHolder === undefined
      ? undefined
      : { token: options.seedHolder, expiresAt: Number.POSITIVE_INFINITY };

  const live = (): { token: string; expiresAt: number } | undefined => {
    if (holder === undefined) return undefined;
    if (holder.expiresAt <= options.clock.now()) {
      holder = undefined;
      return undefined;
    }
    return holder;
  };

  return {
    async acquire({ ownerId, ttlMs }) {
      const existing = live();
      if (existing !== undefined) {
        return { ok: false, reason: "held-by-other", holder: existing.token };
      }
      holder = { token: ownerId, expiresAt: options.clock.now() + ttlMs };
      return { ok: true, handle: { token: ownerId, expiresAt: holder.expiresAt } };
    },

    async renew({ token, ttlMs }) {
      const existing = live();
      if (existing === undefined || existing.token !== token) return false;
      existing.expiresAt = options.clock.now() + ttlMs;
      return true;
    },

    async release(token) {
      const existing = live();
      if (existing !== undefined && existing.token === token) holder = undefined;
    },

    async currentHolder() {
      return live()?.token;
    },
  };
};
