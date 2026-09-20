import type { AutomationEvent, Effect } from "./events";
import {
  type AutomationContext,
  type AutomationState,
  describePauseReason,
  isActive,
  type PauseReason,
  type SessionStats,
} from "./state";

export interface ReduceResult {
  readonly context: AutomationContext;
  readonly effects: readonly Effect[];
}

export interface ReduceOptions {
  readonly now: number;
  /** Maximum automatic retries for a retryable failure, from SessionPolicy. */
  readonly maxRetries: number;
}

/** States from which an event must not silently continue the workflow. */
const HALTED_STATES: readonly AutomationState[] = ["blocked", "failed", "paused"];

const withStats = (
  context: AutomationContext,
  patch: Partial<SessionStats>,
  now: number,
): AutomationContext => {
  const {
    scanned = context.stats.scanned,
    accepted = context.stats.accepted,
    rejected = context.stats.rejected,
    applied = context.stats.applied,
    skipped = context.stats.skipped,
    failed = context.stats.failed,
    blocked = context.stats.blocked,
  } = patch;
  return {
    ...context,
    stats: { scanned, accepted, rejected, applied, skipped, failed, blocked },
    stateSince: now,
  };
};

const enter = (
  context: AutomationContext,
  state: AutomationState,
  now: number,
  extra: Partial<AutomationContext> = {},
): AutomationContext => ({ ...context, ...extra, state, stateSince: now });

/**
 * Rebuilds a context with the listed optional fields removed.
 *
 * Explicit omission keeps `exactOptionalPropertyTypes` honest: assigning
 * `undefined` to an optional property is a type error, so clearing a field
 * means leaving it out of the new object entirely.
 */
const clearFields = (
  context: AutomationContext,
  fields: readonly (keyof AutomationContext)[],
): AutomationContext => {
  const next: Record<string, unknown> = { ...context };
  for (const field of fields) delete next[field];
  return next as unknown as AutomationContext;
};

/**
 * Moves to `paused` with a recorded reason and stops all further work.
 *
 * This is the single fail-closed path: every safety signal (CAPTCHA, risk
 * control, unknown DOM, ambiguous outcome, watchdog) funnels through here so
 * that the behaviour is uniform and auditable.
 */
const blockFor = (
  context: AutomationContext,
  reason: PauseReason,
  now: number,
): ReduceResult => {
  const next = enter(context, "paused", now, {
    pauseReason: reason,
    lastMessage: describePauseReason(reason),
  });
  return {
    context: next,
    effects: [
      { type: "notify", level: "warn", message: describePauseReason(reason) },
      { type: "record-diagnostics", reason },
      { type: "persist" },
    ],
  };
};

const isRetryableFailure = (
  retryable: boolean,
  consecutiveFailures: number,
  maxRetries: number,
): boolean => retryable && consecutiveFailures < maxRetries;

/**
 * Pure state machine.
 *
 * Contract:
 * - Never mutates the incoming context.
 * - Never performs I/O; all side effects are returned as `Effect` values.
 * - Fail-closed: any safety signal transitions to `paused` and stops work.
 * - Illegal events for the current state are ignored (context returned
 *   unchanged) rather than throwing, so a stray async callback cannot crash
 *   the automation.
 */
export const reduce = (
  context: AutomationContext,
  event: AutomationEvent,
  options: ReduceOptions,
): ReduceResult => {
  const { now } = options;
  const noEffects: readonly Effect[] = [];

  switch (event.type) {
    case "START": {
      if (isActive(context.state)) return { context, effects: noEffects };
      const started = clearFields(
        enter(context, "scanning", now, {
          lastMessage: "Scanning for jobs",
          consecutiveFailures: 0,
        }),
        ["pauseReason"],
      );
      return {
        context: started,
        effects: [{ type: "scan-jobs" }, { type: "persist" }],
      };
    }

    case "PAUSE":
      return blockFor(context, event.reason, now);

    case "RESUME": {
      if (context.state !== "paused" && context.state !== "blocked" && context.state !== "failed") {
        return { context, effects: noEffects };
      }
      // Resuming always restarts from scanning: we never resume mid-action,
      // because a half-completed apply must be re-verified from the top.
      const resumed = clearFields(
        enter(context, "scanning", now, {
          lastMessage: "Resumed",
          consecutiveFailures: 0,
        }),
        ["pauseReason", "lastError", "currentJob", "currentStatus"],
      );
      return {
        context: resumed,
        effects: [{ type: "scan-jobs" }, { type: "persist" }],
      };
    }

    case "STOP": {
      const stopped = clearFields(
        enter(context, "idle", now, { lastMessage: "Stopped" }),
        ["pauseReason", "currentJob", "currentStatus"],
      );
      return { context: stopped, effects: [{ type: "stop" }, { type: "persist" }] };
    }

    case "SCAN_STARTED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      return { context: enter(context, "scanning", now), effects: noEffects };
    }

    case "SCAN_COMPLETED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const stats = withStats(context, { scanned: context.stats.scanned + event.summaries.length }, now);
      const next = enter(stats, "evaluating", now, {
        queueDepth: event.summaries.length,
        lastMessage:
          event.skipped > 0
            ? `Scanned ${event.summaries.length} jobs (${event.skipped} cards unparsed)`
            : `Scanned ${event.summaries.length} jobs`,
      });
      if (event.summaries.length === 0) {
        return {
          context: enter(next, "idle", now, { lastMessage: "No jobs found on this page" }),
          effects: [{ type: "persist" }],
        };
      }
      return { context: next, effects: [{ type: "persist" }] };
    }

    case "SCAN_FAILED": {
      const next = enter(context, "failed", now, {
        lastError: event.error,
        lastMessage: `Scan failed on a ${event.pageKind} page`,
      });
      return { context: next, effects: [{ type: "persist" }, { type: "stop" }] };
    }

    case "JOB_LOADING": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      return { context: enter(context, "opening", now), effects: noEffects };
    }

    case "JOB_LOADED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const next = enter(context, "evaluating", now, { currentJob: event.job });
      return { context: next, effects: [{ type: "evaluate-job", job: event.job }] };
    }

    case "JOB_LOAD_FAILED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      return {
        context: enter(context, "failed", now, {
          lastError: event.error,
          lastMessage: `Failed to open job detail: ${event.error}`,
          consecutiveFailures: context.consecutiveFailures + 1,
        }),
        effects: [{ type: "persist" }, { type: "stop" }],
      };
    }

    case "EVALUATED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const { evaluation } = event;
      const base = withStats(
        context,
        evaluation.accepted
          ? { accepted: context.stats.accepted + 1 }
          : { rejected: context.stats.rejected + 1, skipped: context.stats.skipped + 1 },
        now,
      );

      if (!evaluation.accepted && evaluation.rejections.length > 0) {
        return blockFor(base, { kind: "ambiguous-state", evidence: "rejected" }, now);
      }

      if (!evaluation.accepted) {
        const reasonText =
          evaluation.reasons.find((reason) => reason.ruleId === "score.threshold")?.message ??
          "below accept threshold";
        return {
          context: enter(base, "cooldown", now, {
            lastMessage: `Skipped: ${reasonText}`,
          }),
          effects: [
            { type: "notify", level: "info", message: `Skipped job: ${reasonText}` },
            { type: "persist" },
          ],
        };
      }

      if (context.currentJob === undefined) {
        return { context: enter(base, "cooldown", now), effects: [{ type: "persist" }] };
      }

      const approved = enter(base, "validating", now, {
        lastMessage: `Approved (score ${evaluation.score})`,
      });
      return {
        context: approved,
        effects: [
          { type: "notify", level: "info", message: `Approved job with score ${evaluation.score}` },
          { type: "persist" },
        ],
      };
    }

    case "APPLY_STARTED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const next = enter(context, "applying", now, { currentJob: event.job });
      return { context: next, effects: [{ type: "apply-job", job: event.job }] };
    }

    case "APPLY_SUBMITTED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      // The platform reported success, but we still verify before trusting it.
      const next = enter(context, "verifying", now, {
        currentStatus: "submitted",
        lastMessage: "Submitted — verifying",
      });
      if (context.currentJob === undefined) return { context: next, effects: [{ type: "persist" }] };
      return {
        context: next,
        effects: [
          { type: "verify-application", job: context.currentJob },
          { type: "persist" },
        ],
      };
    }

    case "APPLY_ALREADY_DONE": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const base = withStats(context, { skipped: context.stats.skipped + 1 }, now);
      const next = enter(base, "cooldown", now, {
        currentStatus: "verified",
        lastMessage: `Already applied: ${event.evidence}`,
      });
      return { context: next, effects: [{ type: "persist" }] };
    }

    case "APPLY_NEEDS_CONFIRMATION": {
      // The click may or may not have registered. We must not retry blindly.
      return blockFor(context, { kind: "ambiguous-state", evidence: event.evidence }, now);
    }

    case "APPLY_FAILED": {
      const shouldRetry = isRetryableFailure(
        event.retryable,
        context.consecutiveFailures,
        options.maxRetries,
      );
      const failures = context.consecutiveFailures + 1;
      const base = withStats(context, { failed: context.stats.failed + 1 }, now);

      if (shouldRetry) {
        return {
          context: enter(base, "cooldown", now, {
            consecutiveFailures: failures,
            lastError: event.error,
            lastMessage: `Attempt failed, retrying: ${event.error}`,
          }),
          effects: [{ type: "persist" }],
        };
      }

      return {
        context: enter(base, "failed", now, {
          consecutiveFailures: failures,
          lastError: event.error,
          lastMessage: `Application failed: ${event.error}`,
        }),
        effects: [
          { type: "notify", level: "error", message: `Application failed: ${event.error}` },
          { type: "persist" },
          { type: "stop" },
        ],
      };
    }

    case "VERIFICATION_CONFIRMED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const appliedAt = now;
      const base = withStats(context, { applied: context.stats.applied + 1 }, now);
      const next = clearFields(
        enter(base, "cooldown", now, {
          sessionApplications: context.sessionApplications + 1,
          applicationTimestamps: [...context.applicationTimestamps, appliedAt],
          consecutiveFailures: 0,
          lastMessage: `Applied and verified (${event.evidence})`,
        }),
        ["currentJob", "currentStatus"],
      );
      return {
        context: next,
        effects: [
          { type: "notify", level: "info", message: "Application confirmed" },
          { type: "persist" },
        ],
      };
    }

    case "VERIFICATION_NEGATIVE": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      // The platform never received the application. Safe to treat as a
      // non-event so the job can be retried within the session policy.
      const next = enter(context, "cooldown", now, {
        lastMessage: `Not applied: ${event.evidence}`,
        currentStatus: "approved",
      });
      return { context: next, effects: [{ type: "persist" }] };
    }

    case "VERIFICATION_INDETERMINATE":
      return blockFor(context, { kind: "ambiguous-state", evidence: event.evidence }, now);

    case "BLOCKED": {
      const reasonMap = {
        captcha: { kind: "captcha", evidence: event.evidence },
        "risk-control": { kind: "risk-control", evidence: event.evidence },
        "login-expired": { kind: "login-expired", evidence: event.evidence },
        "unknown-dom": { kind: "unknown-dom", evidence: event.evidence },
        "selector-missing": { kind: "selector-missing", selector: event.evidence },
        "ambiguous-state": { kind: "ambiguous-state", evidence: event.evidence },
        "rate-limited": { kind: "rate-limited", retryAt: now },
      } as const;
      const base = withStats(context, { blocked: context.stats.blocked + 1 }, now);
      return blockFor(base, reasonMap[event.reason], now);
    }

    case "COOLDOWN_ELAPSED":
    case "RETRY_ELAPSED": {
      if (context.state !== "cooldown") return { context, effects: noEffects };
      // Deliberately returns to scanning: the queue decides what runs next,
      // which keeps a single scheduling path instead of many.
      return { context: enter(context, "scanning", now), effects: [{ type: "scan-jobs" }] };
    }

    case "QUEUE_CHANGED": {
      if (context.queueDepth === event.depth) return { context, effects: noEffects };
      return { context: { ...context, queueDepth: event.depth }, effects: noEffects };
    }

    case "PAGE_CHANGED": {
      if (!isActive(context.state)) return { context, effects: noEffects };
      // A route change mid-action invalidates the page we were driving.
      return blockFor(context, { kind: "page-changed", evidence: event.pageKind }, now);
    }

    case "WATCHDOG_TIMEOUT":
      return blockFor(context, { kind: "watchdog", evidence: event.evidence }, now);

    case "SESSION_LIMIT_REACHED":
      return blockFor(context, { kind: "session-limit", limit: event.limit }, now);

    case "CLEAR_ERROR": {
      if (context.lastError === undefined && context.lastMessage === undefined) {
        return { context, effects: noEffects };
      }
      return {
        context: clearFields({ ...context, lastMessage: "Cleared" }, ["lastError"]),
        effects: noEffects,
      };
    }

    default: {
      // Exhaustiveness guard: adding an event without handling it is a
      // compile-time error here.
      const exhaustive: never = event;
      return { context: exhaustive, effects: noEffects };
    }
  }
};
