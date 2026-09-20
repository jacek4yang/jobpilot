import type { Evaluation } from "../domain/rule";
import type { JobDetail, JobSummary } from "../domain/job/job";
import type { BlockReason, PageKind } from "../ports/job-platform";
import type { PauseReason } from "./state";

/**
 * Events are the only inputs to the reducer.
 *
 * Effects are never executed inside the reducer: they are returned as data
 * and run by the runtime, which keeps the machine pure and unit-testable.
 */
export type AutomationEvent =
  | { readonly type: "START" }
  | { readonly type: "PAUSE"; readonly reason: PauseReason }
  | { readonly type: "RESUME" }
  | { readonly type: "STOP" }
  | { readonly type: "SCAN_STARTED" }
  | {
      readonly type: "SCAN_COMPLETED";
      readonly summaries: readonly JobSummary[];
      readonly skipped: number;
    }
  | { readonly type: "SCAN_FAILED"; readonly error: string; readonly pageKind: PageKind }
  | { readonly type: "JOB_LOADING"; readonly summary: JobSummary }
  | { readonly type: "JOB_LOADED"; readonly job: JobDetail }
  | { readonly type: "JOB_LOAD_FAILED"; readonly error: string }
  | { readonly type: "EVALUATED"; readonly evaluation: Evaluation }
  | { readonly type: "APPLY_STARTED"; readonly job: JobDetail }
  | { readonly type: "APPLY_SUBMITTED"; readonly evidence: string }
  | {
      readonly type: "APPLY_ALREADY_DONE";
      readonly evidence: string;
    }
  | { readonly type: "APPLY_NEEDS_CONFIRMATION"; readonly evidence: string }
  | { readonly type: "APPLY_FAILED"; readonly error: string; readonly retryable: boolean }
  | { readonly type: "VERIFICATION_CONFIRMED"; readonly evidence: string }
  | { readonly type: "VERIFICATION_NEGATIVE"; readonly evidence: string }
  | { readonly type: "VERIFICATION_INDETERMINATE"; readonly evidence: string }
  | { readonly type: "BLOCKED"; readonly reason: BlockReason; readonly evidence: string }
  | {
      readonly type: "COOLDOWN_ELAPSED";
    }
  | { readonly type: "QUEUE_CHANGED"; readonly depth: number }
  | { readonly type: "PAGE_CHANGED"; readonly pageKind: PageKind }
  | { readonly type: "WATCHDOG_TIMEOUT"; readonly evidence: string }
  | { readonly type: "RETRY_ELAPSED" }
  | { readonly type: "SESSION_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "CLEAR_ERROR" };

export type AutomationEventType = AutomationEvent["type"];

/** Effects the runtime must perform. Returned by the reducer, never executed by it. */
export type Effect =
  | { readonly type: "scan-jobs" }
  | { readonly type: "load-job"; readonly summary: JobSummary }
  | { readonly type: "evaluate-job"; readonly job: JobDetail }
  | { readonly type: "apply-job"; readonly job: JobDetail }
  | { readonly type: "verify-application"; readonly job: JobDetail }
  | { readonly type: "schedule-cooldown"; readonly delayMs: number }
  | { readonly type: "notify"; readonly level: "info" | "warn" | "error"; readonly message: string }
  | { readonly type: "persist" }
  | { readonly type: "record-diagnostics"; readonly reason: PauseReason }
  | { readonly type: "stop" };
