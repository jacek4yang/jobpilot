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
const blockFor = (context: AutomationContext, reason: PauseReason, now: number): ReduceResult => {
  const next = enter(context, "paused", now, {
    pauseReason: reason,
    lastMessage: describePauseReason(reason),
    lastTerminalReason:
      reason.kind === "user"
        ? "paused"
        : reason.kind === "ambiguous-state"
          ? "needs-confirmation"
          : "blocked",
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
          lastMessage: "正在扫描职位",
          consecutiveFailures: 0,
        }),
        ["pauseReason", "lastTerminalReason"],
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
          lastMessage: "已继续",
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
      // An explicit abort discards the batch: the pending queue is a live view
      // of one scan, not work the user asked to keep.
      const stopped = clearFields(
        enter(context, "idle", now, {
          lastMessage: "已停止",
          pendingSummaries: [],
          lastTerminalReason: "stopped",
        }),
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
      const stats = withStats(
        context,
        { scanned: context.stats.scanned + event.summaries.length },
        now,
      );
      // A fresh scan starts a new batch: whatever was pending from a previous
      // scan is overwritten, never merged.
      const next = enter(stats, "evaluating", now, {
        queueDepth: event.summaries.length,
        pendingSummaries: event.summaries,
        lastMessage:
          event.skipped > 0
            ? `已扫描 ${event.summaries.length} 个职位（${event.skipped} 张卡片无法解析）`
            : `已扫描 ${event.summaries.length} 个职位`,
      });
      const [first] = event.summaries;
      if (first === undefined) {
        return {
          context: enter(next, "idle", now, { lastMessage: "这个页面上没有找到职位" }),
          effects: [{ type: "persist" }],
        };
      }
      // Bridge the scan into the per-job pipeline: the first summary loads
      // immediately, the rest wait in pendingSummaries for the cooldown drain.
      return {
        context: next,
        effects: [{ type: "persist" }, { type: "load-job", summary: first }],
      };
    }

    case "SCAN_FAILED": {
      const next = enter(context, "failed", now, {
        lastError: event.error,
        lastMessage: `页面类型为 ${event.pageKind} 时扫描失败`,
        lastTerminalReason: "failed",
      });
      return { context: next, effects: [{ type: "persist" }, { type: "stop" }] };
    }

    case "JOB_LOADING": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      return { context: enter(context, "opening", now), effects: noEffects };
    }

    case "JOB_LOADED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      // The loaded job leaves the pending queue: the queue holds exactly the
      // jobs that have NOT started their cycle, so the cooldown drain below
      // never re-loads a job that already ran. Ids not in the queue (a load
      // that did not come from the batch scan) change nothing.
      const pendingSummaries = context.pendingSummaries.filter(
        (entry) => String(entry.id) !== String(event.job.id),
      );
      const next = enter(context, "evaluating", now, { currentJob: event.job, pendingSummaries });
      return { context: next, effects: [{ type: "evaluate-job", job: event.job }] };
    }

    case "JOB_LOAD_FAILED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      return {
        context: enter(context, "failed", now, {
          lastError: event.error,
          lastMessage: `打开职位详情失败：${event.error}`,
          consecutiveFailures: context.consecutiveFailures + 1,
          lastTerminalReason: "failed",
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

      if (!evaluation.accepted) {
        const reasonText =
          evaluation.rejections[0]?.message ??
          evaluation.reasons.find((reason) => reason.ruleId === "score.threshold")?.message ??
          "未达到接收条件";
        return {
          context: enter(base, "cooldown", now, {
            lastMessage: `已跳过：${reasonText}`,
          }),
          effects: [
            { type: "notify", level: "info", message: `已跳过职位：${reasonText}` },
            { type: "persist" },
            { type: "schedule-cooldown", delayMs: 0 },
          ],
        };
      }

      if (context.currentJob === undefined) {
        return { context: enter(base, "cooldown", now), effects: [{ type: "persist" }] };
      }

      const approved = enter(base, "validating", now, {
        lastMessage: `已符合（评分 ${evaluation.score}）`,
      });
      return {
        context: approved,
        effects: [
          {
            type: "notify",
            level: "info",
            message: `职位符合要求（评分 ${evaluation.score}）`,
          },
          { type: "persist" },
        ],
      };
    }

    case "CONTACT_STARTED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const next = enter(context, "contacting", now, { currentJob: event.job });
      return { context: next, effects: [{ type: "contact-job", job: event.job }] };
    }

    case "CONTACT_UNCERTAIN": {
      // A message may have been sent. Never retry blindly.
      return blockFor(context, { kind: "ambiguous-state", evidence: event.evidence }, now);
    }

    case "CONTACT_CONFIRMED": {
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const appliedAt = now;
      const base = withStats(context, { applied: context.stats.applied + 1 }, now);
      const next = clearFields(
        enter(base, "cooldown", now, {
          sessionApplications: context.sessionApplications + 1,
          applicationTimestamps: [...context.applicationTimestamps, appliedAt],
          consecutiveFailures: 0,
          lastMessage: `消息已发送并核实（${event.evidence}）`,
        }),
        ["currentJob", "currentStatus"],
      );
      return {
        context: next,
        effects: [
          { type: "notify", level: "info", message: "沟通消息已确认发送" },
          { type: "persist" },
          { type: "schedule-cooldown", delayMs: 0 },
        ],
      };
    }

    case "CONTACT_PLATFORM_CONFIRMED": {
      // The no-jump happy path: the operator clicked 立即沟通, the platform
      // sent the greeting and confirmed it with its own success dialog. The
      // job IS contacted, so the run settles exactly like a confirmed contact
      // (cooldown, applied counted) — but the wording must not claim the
      // message-text verification that only an observed outgoing bubble earns.
      if (HALTED_STATES.includes(context.state)) return { context, effects: noEffects };
      const appliedAt = now;
      const base = withStats(context, { applied: context.stats.applied + 1 }, now);
      const next = clearFields(
        enter(base, "cooldown", now, {
          sessionApplications: context.sessionApplications + 1,
          applicationTimestamps: [...context.applicationTimestamps, appliedAt],
          consecutiveFailures: 0,
          lastMessage: `平台已发送打招呼消息（成功弹窗已确认）：${event.evidence}`,
        }),
        ["currentJob", "currentStatus"],
      );
      return {
        context: next,
        effects: [
          { type: "notify", level: "info", message: "平台已发送打招呼消息（成功弹窗已确认）" },
          { type: "persist" },
          { type: "schedule-cooldown", delayMs: 0 },
        ],
      };
    }

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
      const [next, ...rest] = context.pendingSummaries;
      if (next !== undefined) {
        // The batch drains the pending queue one job per cooldown; each drain
        // hands the next summary to the per-job load/evaluate/apply cycle.
        return {
          context: enter(context, "evaluating", now, { pendingSummaries: rest }),
          effects: [{ type: "load-job", summary: next }],
        };
      }
      // A user-selected batch is finite. Once its snapshot is drained it must
      // terminate, never rescan the page and rediscover already-processed jobs.
      return {
        context: enter(context, "idle", now, {
          lastMessage: "本次批量任务已完成",
          lastTerminalReason: "completed",
          queueDepth: 0,
        }),
        effects: [{ type: "persist" }],
      };
    }

    case "QUEUE_CHANGED": {
      if (context.queueDepth === event.depth) return { context, effects: noEffects };
      return { context: { ...context, queueDepth: event.depth }, effects: noEffects };
    }

    case "PAGE_CHANGED": {
      if (!isActive(context.state)) return { context, effects: noEffects };
      // Opening the selected detail drawer and then the positively verified
      // chat are expected route transitions, not interruptions. The load and
      // communication layers still validate the exact job/chat identity.
      if (
        (context.state === "opening" && event.pageKind === "job-detail") ||
        (context.state === "contacting" && event.pageKind === "chat")
      ) {
        return { context, effects: noEffects };
      }
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
        context: clearFields({ ...context, lastMessage: "已清除" }, ["lastError"]),
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
