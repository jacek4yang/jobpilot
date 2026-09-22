import type { ApplicationStatus } from "../domain/application/application";
import type { JobDetail, JobSummary } from "../domain/job/job";

/** Explicit automation states. Every state is observable and testable. */
export type AutomationState =
  | "idle"
  | "scanning"
  | "evaluating"
  | "opening"
  | "validating"
  | "contacting"
  | "cooldown"
  | "paused"
  | "blocked"
  | "failed";

/** Why the most recent finite batch stopped. */
export type BatchTerminalReason =
  | "completed"
  | "stopped"
  | "paused"
  | "blocked"
  | "failed"
  | "needs-confirmation";

/** The subset of states in which the machine is actively doing work. */
export const ACTIVE_STATES: readonly AutomationState[] = [
  "scanning",
  "evaluating",
  "opening",
  "validating",
  "contacting",
];

export const isActive = (state: AutomationState): boolean => ACTIVE_STATES.includes(state);

/** Why the machine is paused. Drives the UI message and diagnostics. */
export type PauseReason =
  | { readonly kind: "user" }
  | { readonly kind: "captcha"; readonly evidence: string }
  | { readonly kind: "risk-control"; readonly evidence: string }
  | { readonly kind: "login-expired"; readonly evidence: string }
  | { readonly kind: "unknown-dom"; readonly evidence: string }
  | { readonly kind: "selector-missing"; readonly selector: string }
  | { readonly kind: "ambiguous-state"; readonly evidence: string }
  | {
      /**
       * BOSS's 立即沟通 control ignores synthetic clicks (an isTrusted-class
       * guard, live-verified 2026-09-22), so the contact step is human-gated:
       * the control was highlighted and the batch waits for the operator's
       * click. Reaching this reason means the wait timed out, fail closed.
       */
      readonly kind: "needs-human-click";
      readonly evidence: string;
    }
  | { readonly kind: "session-limit"; readonly limit: number }
  | { readonly kind: "rate-limited"; readonly retryAt: number }
  | { readonly kind: "watchdog"; readonly evidence: string }
  | { readonly kind: "page-changed"; readonly evidence: string };

/** Short human-readable pause explanation, safe to show in the panel. */
export const describePauseReason = (reason: PauseReason): string => {
  switch (reason.kind) {
    case "user":
      return "已由你暂停";
    case "captcha":
      return "检测到验证码，请在页面中手动完成验证后再继续";
    case "risk-control":
      return "触发平台风控，自动化已停止";
    case "login-expired":
      return "登录已过期，请重新登录后再继续";
    case "unknown-dom":
      return "无法识别的页面结构，自动化已停止";
    case "selector-missing":
      return `未找到预期元素（${reason.selector}）`;
    case "ambiguous-state":
      return `投递结果不明确，请手动确认（${reason.evidence}）`;
    case "needs-human-click":
      return "需要点击「立即沟通」";
    case "session-limit":
      return `已达到本次任务上限（${reason.limit}）`;
    case "rate-limited":
      return "已达到安全频次上限，稍后再继续";
    case "watchdog":
      return `检测到操作停滞，已自动恢复（${reason.evidence}）`;
    case "page-changed":
      return `页面意外发生变化（${reason.evidence}）`;
  }
};

/** Runtime statistics surfaced in the UI and persisted for history. */
export interface SessionStats {
  readonly scanned: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
  readonly blocked: number;
}

export const emptyStats: SessionStats = {
  scanned: 0,
  accepted: 0,
  rejected: 0,
  applied: 0,
  skipped: 0,
  failed: 0,
  blocked: 0,
};

export interface AutomationContext {
  readonly state: AutomationState;
  /** The job currently being worked on, if any. */
  readonly currentJob?: JobDetail;
  /** Application record status of the current job, once known. */
  readonly currentStatus?: ApplicationStatus;
  readonly pauseReason?: PauseReason;
  readonly stats: SessionStats;
  readonly queueDepth: number;
  /** Number of applications submitted in this session. */
  readonly sessionApplications: number;
  /** Timestamps (ms) of applications, used for the hourly cap. */
  readonly applicationTimestamps: readonly number[];
  readonly consecutiveFailures: number;
  /**
   * Runtime-only queue of the current scan: the summaries waiting for their
   * per-job load/evaluate/apply cycle. Entered on SCAN_COMPLETED, drained one
   * job per COOLDOWN_ELAPSED. Deliberately NOT persisted: it is a live view of
   * the listing, rebuilt by every fresh scan.
   */
  readonly pendingSummaries: readonly JobSummary[];
  /** Explicit outcome of the latest finite operator-selected batch. */
  readonly lastTerminalReason?: BatchTerminalReason;
  /** Last state-change timestamp, used by the watchdog. */
  readonly stateSince: number;
  /** Non-fatal message for the UI, e.g. the last rejection reason. */
  readonly lastMessage?: string;
  readonly lastError?: string;
}

export const initialContext = (now: number): AutomationContext => ({
  state: "idle",
  stats: emptyStats,
  queueDepth: 0,
  sessionApplications: 0,
  applicationTimestamps: [],
  consecutiveFailures: 0,
  pendingSummaries: [],
  stateSince: now,
});
