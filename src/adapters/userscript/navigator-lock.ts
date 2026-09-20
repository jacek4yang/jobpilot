/**
 * Browser lock adapter.
 *
 * Implements the `Lock` port on top of `navigator.locks` plus a small lease
 * record so that a tab which crashes or is closed without releasing cannot
 * wedge the queue forever.
 *
 * Why both mechanisms:
 *  - `navigator.locks` gives us a real mutual-exclusion primitive that the
 *    browser cleans up when a tab dies. We take it with `ifAvailable` so a
 *    second tab finds out immediately instead of blocking.
 *  - The lease record carries `expiresAt` so the *application* can decide
 *    whether an apparently-held lock is stale, and so tests can drive expiry
 *    with a fake clock.
 *
 * `navigator.locks` is unavailable in some contexts (older browsers, some
 * embedded webviews). In that case `acquire` reports `unsupported` rather than
 * pretending the lock was taken, and the caller can choose to run single-tab
 * mode explicitly.
 */
import type { Clock } from "../../domain/support/shared";
import type { AcquireResult, Lock } from "../../ports/lock";

export interface NavigatorLockDeps {
  readonly clock: Clock;
  /** Defaults to `globalThis.navigator`. Injected for tests. */
  readonly navigator?: Navigator;
}

/** Minimal structural view of the LockManager we depend on. */
interface LockManagerLike {
  request(
    name: string,
    options: { readonly ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
}

interface HeldLock {
  readonly token: string;
  expiresAt: number;
}

const locksOf = (nav: Navigator | undefined): LockManagerLike | undefined => {
  if (nav === undefined) return undefined;
  const candidate = (nav as Navigator & { locks?: unknown }).locks;
  if (candidate === undefined || candidate === null) return undefined;
  const request = (candidate as { request?: unknown }).request;
  if (typeof request !== "function") return undefined;
  return candidate as LockManagerLike;
};

/**
 * Creates a lock backed by `navigator.locks`.
 *
 * The in-memory `held` record is per-tab and mirrors what this tab believes it
 * owns; it is never used to *authorise* another tab.
 *
 * Lifecycle note: `navigator.locks.request` only settles once its callback
 * returns, so we cannot `await` it to learn whether the lock was granted. The
 * request is therefore started in the background and the grant is reported
 * through a signal that the callback sets. This keeps `acquire` prompt while
 * the browser still holds the lock for the page's lifetime, which is what the
 * caller needs. The lease record bounds how long a stale claim is honoured.
 */
export const createNavigatorLock = (deps: NavigatorLockDeps): Lock => {
  const manager = locksOf(deps.navigator ?? globalThis.navigator);
  let held: HeldLock | undefined;
  /** Resolves the parked `request` callback, releasing the browser lock. */
  let holdOpen: (() => void) | undefined;

  const expired = (record: HeldLock): boolean => record.expiresAt <= deps.clock.now();

  /** Forgets a lapsed lease so another tab may take over after a crash. */
  const reapIfExpired = (): void => {
    if (held === undefined || !expired(held)) return;
    held = undefined;
    holdOpen?.();
    holdOpen = undefined;
  };

  return {
    async acquire({ ownerId, ttlMs }): Promise<AcquireResult> {
      if (manager === undefined) return { ok: false, reason: "unsupported" };

      reapIfExpired();
      // Reuse our own live lease rather than re-entering the lock, which would
      // deadlock a tab against itself.
      if (held !== undefined && held.token === ownerId) {
        held.expiresAt = deps.clock.now() + ttlMs;
        return { ok: true, handle: { token: ownerId, expiresAt: held.expiresAt } };
      }

      // The callback runs for `ifAvailable` without waiting for the lock, so we
      // learn the outcome through a signal rather than by awaiting the request
      // (which would only settle when the lock is finally released).
      //
      // The signal is a deferred promise, NOT a microtask yield: per spec the
      // request callback is invoked in a later TASK, so a single
      // `await Promise.resolve()` can return before the callback has run. That
      // mistake made `acquire` report "held-by-other" while the lock had in fact
      // been granted and was being held — the inverse of the intended meaning.
      let settleGrant: (value: "granted" | "refused") => void = () => {};
      const granted = new Promise<"granted" | "refused">((resolve) => {
        settleGrant = resolve;
      });

      const requestPromise = manager.request(
        "jobpilot-execution",
        { ifAvailable: true },
        async (lock) => {
          if (lock === null || lock === undefined) {
            settleGrant("refused");
            return;
          }
          held = { token: ownerId, expiresAt: deps.clock.now() + ttlMs };
          settleGrant("granted");
          // Park until released or reaped, so the browser keeps holding it.
          await new Promise<void>((resolve) => {
            holdOpen = resolve;
          });
        },
      );
      // Never let a rejection surface as an unhandled error.
      void requestPromise.catch(() => {
        settleGrant("refused");
      });

      const outcome = await granted;

      if (outcome === "refused" || held === undefined) {
        return { ok: false, reason: "held-by-other" };
      }
      return { ok: true, handle: { token: held.token, expiresAt: held.expiresAt } };
    },

    async renew({ token, ttlMs }) {
      reapIfExpired();
      if (held === undefined || held.token !== token) return false;
      held.expiresAt = deps.clock.now() + ttlMs;
      return true;
    },

    async release(token) {
      if (held !== undefined && held.token === token) {
        held = undefined;
        holdOpen?.();
        holdOpen = undefined;
      }
    },

    async currentHolder() {
      reapIfExpired();
      return held?.token;
    },
  };
};

/** True when this environment can provide a real cross-tab lock. */
export const isNavigatorLockSupported = (
  nav: Navigator | undefined = globalThis.navigator,
): boolean => locksOf(nav) !== undefined;
