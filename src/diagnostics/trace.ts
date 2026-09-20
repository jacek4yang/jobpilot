/**
 * Tracing decorators.
 *
 * The queue, the lock and storage are observed from the outside rather than
 * instrumented internally. Two reasons:
 *
 *  1. Those modules stay free of any diagnostics dependency, so they remain
 *     pure enough to unit-test with no recorder at all.
 *  2. Every traced operation goes through one place, so the event shape is
 *     uniform and a new call site cannot accidentally skip tracing.
 *
 * Each decorator returns the same interface it wraps, so nothing downstream
 * needs to know diagnostics exist.
 */
import type { AcquireResult, Lock } from "../ports/lock";
import type { Storage } from "../ports/storage";
import { EVENTS } from "./event";
import type { DiagnosticRecorder } from "./recorder";

// --- Lock ------------------------------------------------------------------

export interface TracedLockOptions {
  /** Identifies this tab. Kept opaque; no browser fingerprinting. */
  readonly tabId: string;
}

/**
 * Wraps a `Lock` so ownership changes are reconstructable.
 *
 * Ownership is the thing that prevents two tabs driving the same queue, so the
 * full requested/acquired/rejected/renewed/released sequence matters when
 * diagnosing a duplicate-processing report.
 */
export const traceLock = (
  inner: Lock,
  recorder: DiagnosticRecorder,
  options: TracedLockOptions,
): Lock => ({
  async acquire(input) {
    recorder.record({
      level: "debug",
      category: "lock",
      event: EVENTS.lockRequested,
      data: { tabId: options.tabId, ownerId: input.ownerId, ttlMs: input.ttlMs },
    });

    const result: AcquireResult = await inner.acquire(input);

    recorder.record({
      level: result.ok ? "info" : "debug",
      category: "lock",
      event: result.ok ? EVENTS.lockAcquired : EVENTS.lockRejected,
      data: {
        tabId: options.tabId,
        ownerId: input.ownerId,
        ...(result.ok
          ? { expiresAt: result.handle.expiresAt }
          : { reason: result.reason, holder: result.holder ?? null }),
      },
    });

    return result;
  },

  async renew(input) {
    const renewed = await inner.renew(input);
    recorder.record({
      level: renewed ? "trace" : "warn",
      category: "lock",
      event: renewed ? EVENTS.lockRenewed : EVENTS.lockLeaseExpired,
      data: { tabId: options.tabId, token: input.token },
    });
    return renewed;
  },

  async release(token) {
    await inner.release(token);
    recorder.record({
      level: "debug",
      category: "lock",
      event: EVENTS.lockReleased,
      data: { tabId: options.tabId, token },
    });
  },

  async currentHolder() {
    const holder = await inner.currentHolder();
    recorder.record({
      level: "trace",
      category: "lock",
      event: EVENTS.lockOwnershipChanged,
      data: { tabId: options.tabId, holder: holder ?? null, isOwner: holder === options.tabId },
    });
    return holder;
  },
});

// --- Storage ---------------------------------------------------------------

export interface StorageHealth {
  readonly healthy: boolean;
  readonly lastFailure?: string;
}

export interface TracedStorage {
  readonly storage: Storage;
  health(): StorageHealth;
  /** Clears a recorded failure after a successful retry. */
  retry(): Promise<StorageHealth>;
}

/**
 * Wraps `Storage` so persistence problems stop being silent.
 *
 * Records only safe metadata: the key namespace, success/failure, the
 * serialised size and a duration. Never the stored value itself, and never raw
 * user data — a bundle must stay safe to share.
 */
export const traceStorage = (inner: Storage, recorder: DiagnosticRecorder): TracedStorage => {
  let lastFailure: string | undefined;

  const record = (
    operation: "read" | "write" | "delete" | "keys",
    key: string,
    outcome:
      | { readonly ok: true; readonly bytes?: number }
      | { readonly ok: false; readonly error: string },
    durationMs: number,
  ): void => {
    const base = { operation, key, durationMs };
    if (outcome.ok) {
      recorder.record({
        level: "trace",
        category: "storage",
        event: operation === "read" ? EVENTS.storageRead : EVENTS.storageWrite,
        data: { ...base, ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }) },
      });
      return;
    }
    recorder.record({
      level: "error",
      category: "storage",
      event: operation === "read" ? EVENTS.storageReadFailed : EVENTS.storageWriteFailed,
      data: { ...base, error: outcome.error },
    });
  };

  const healthyNow = (): boolean => lastFailure === undefined;

  const markHealthy = (): void => {
    if (lastFailure === undefined) return;
    lastFailure = undefined;
    recorder.record({
      level: "info",
      category: "storage",
      event: EVENTS.storageHealthChanged,
      data: { healthy: true },
    });
  };

  const markUnhealthy = (error: string): void => {
    const wasHealthy = healthyNow();
    lastFailure = error;
    if (wasHealthy) {
      recorder.record({
        level: "error",
        category: "storage",
        event: EVENTS.storageHealthChanged,
        data: { healthy: false, error },
      });
    }
  };

  const storage: Storage = {
    async get<T>(key: string): Promise<T | undefined> {
      const started = Date.now();
      try {
        const value = await inner.get<T>(key);
        record("read", key, { ok: true }, Date.now() - started);
        markHealthy();
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record("read", key, { ok: false, error: message }, Date.now() - started);
        markUnhealthy(message);
        // Re-thrown, not swallowed: storage health is enforced by the caller,
        // and hiding the failure here would defeat that.
        throw error;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      const started = Date.now();
      let bytes: number | undefined;
      try {
        // Size only. The value is never inspected or logged.
        bytes = JSON.stringify(value)?.length;
      } catch {
        bytes = undefined;
      }
      try {
        await inner.set(key, value);
        record(
          "write",
          key,
          bytes === undefined ? { ok: true } : { ok: true, bytes },
          Date.now() - started,
        );
        markHealthy();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record("write", key, { ok: false, error: message }, Date.now() - started);
        markUnhealthy(message);
        throw error;
      }
    },

    async delete(key: string): Promise<void> {
      const started = Date.now();
      try {
        await inner.delete(key);
        record("delete", key, { ok: true }, Date.now() - started);
        markHealthy();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record("delete", key, { ok: false, error: message }, Date.now() - started);
        markUnhealthy(message);
        throw error;
      }
    },

    async keys(): Promise<readonly string[]> {
      const started = Date.now();
      try {
        const result = await inner.keys();
        record("keys", "*", { ok: true }, Date.now() - started);
        markHealthy();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record("keys", "*", { ok: false, error: message }, Date.now() - started);
        markUnhealthy(message);
        throw error;
      }
    },
  };

  return {
    storage,
    health: () => (lastFailure === undefined ? { healthy: true } : { healthy: false, lastFailure }),
    async retry() {
      // A probe read is the cheapest way to find out whether storage recovered.
      try {
        await inner.get("jobpilot:health:probe");
        markHealthy();
      } catch (error) {
        markUnhealthy(error instanceof Error ? error.message : String(error));
      }
      return lastFailure === undefined ? { healthy: true } : { healthy: false, lastFailure };
    },
  };
};

// --- Queue -----------------------------------------------------------------

/** Minimal shape the queue tracer needs. Kept structural on purpose. */
export interface TraceableQueue {
  enqueue(options: { readonly jobId: string; readonly now: number }): boolean;
  takeNext(now: number): { readonly jobId: string; readonly attempts: number } | undefined;
  update(jobId: string, status: string, now: number, error?: string): void;
  remove(jobId: string): boolean;
  clearPending(): void;
}

/**
 * Wraps a queue so its lifecycle is reconstructable.
 *
 * The queue decides what gets contacted, so "why did job X run before job Y"
 * and "why did job X never run" must both be answerable from the bundle.
 */
export const traceQueue = <Q extends TraceableQueue>(inner: Q, recorder: DiagnosticRecorder): Q => {
  const traced: TraceableQueue = {
    enqueue(options) {
      const accepted = inner.enqueue(options);
      recorder.record({
        level: accepted ? "info" : "debug",
        category: "queue",
        event: accepted ? EVENTS.queueItemEnqueued : "queue.item.duplicate",
        queueItemId: options.jobId,
        data: { accepted },
      });
      return accepted;
    },

    takeNext(now) {
      const task = inner.takeNext(now);
      if (task !== undefined) {
        recorder.record({
          level: "info",
          category: "queue",
          event: EVENTS.queueItemStarted,
          queueItemId: task.jobId,
          data: { attempts: task.attempts },
        });
      }
      return task;
    },

    update(jobId, status, now, error) {
      inner.update(jobId, status, now, error);
      recorder.record({
        level: status === "failed" || status === "blocked" ? "warn" : "info",
        category: "queue",
        event: queueEventFor(status),
        queueItemId: jobId,
        data: { status, ...(error === undefined ? {} : { error }) },
      });
    },

    remove(jobId) {
      const removed = inner.remove(jobId);
      if (removed) {
        recorder.record({
          level: "debug",
          category: "queue",
          event: EVENTS.queueItemRemoved,
          queueItemId: jobId,
        });
      }
      return removed;
    },

    clearPending() {
      inner.clearPending();
      recorder.record({ level: "info", category: "queue", event: EVENTS.queueCleared });
    },
  };

  // The cast is required because the generic preserves the concrete queue's
  // extra members, which the tracer passes through untouched by construction.
  return Object.assign(inner, traced) as Q;
};

const queueEventFor = (status: string): string => {
  switch (status) {
    case "success":
      return EVENTS.queueItemCompleted;
    case "skipped":
      return EVENTS.queueItemSkipped;
    case "failed":
      return EVENTS.queueItemFailed;
    case "blocked":
      return EVENTS.queueItemBlocked;
    default:
      return "queue.item.updated";
  }
};
