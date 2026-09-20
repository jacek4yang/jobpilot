import type { ApplicationStatus } from "../domain/application/application";
import type { JobDetail } from "../domain/job/job";

/** Explicit automation states. Every state is observable and testable. */
export type AutomationState =
  | "idle"
  | "scanning"
  | "evaluating"
  | "opening"
  | "validating"
  | "applying"
  | "verifying"
  | "cooldown"
  | "paused"
  | "blocked"
  | "failed";

/** The subset of states in which the machine is actively doing work. */
export const ACTIVE_STATES: readonly AutomationState[] = [
  "scanning",
  "evaluating",
  "opening",
  "validating",
  "applying",
  "verifying",
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
  | { readonly kind: "session-limit"; readonly limit: number }
  | { readonly kind: "rate-limited"; readonly retryAt: number }
  | { readonly kind: "watchdog"; readonly evidence: string }
  | { readonly kind: "page-changed"; readonly evidence: string };

/** Short human-readable pause explanation, safe to show in the panel. */
export const describePauseReason = (reason: PauseReason): string => {
  switch (reason.kind) {
    case "user":
      return "Paused by user";
    case "captcha":
      return "CAPTCHA detected — resolve it manually, then resume";
    case "risk-control":
      return "Risk control triggered — automation stopped";
    case "login-expired":
      return "Login expired — sign in again, then resume";
    case "unknown-dom":
      return "Unrecognised page structure — automation stopped";
    case "selector-missing":
      return `Expected element not found (${reason.selector})`;
    case "ambiguous-state":
      return `Application outcome unclear — verify manually (${reason.evidence})`;
    case "session-limit":
      return `Session limit reached (${reason.limit})`;
    case "rate-limited":
      return "Rate limit reached — waiting before continuing";
    case "watchdog":
      return `Watchdog recovered from a stalled action (${reason.evidence})`;
    case "page-changed":
      return `Page changed unexpectedly (${reason.evidence})`;
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
  stateSince: now,
});
