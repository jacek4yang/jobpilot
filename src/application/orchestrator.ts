import type { RuleEngine } from "../domain/engine";
import type { Evaluation, RuleContext, RuleEngineConfig } from "../domain/rule";
import type { Clock, Random } from "../domain/support/shared";
import { evaluateSessionLimits, nextDelayMs } from "../infrastructure/rate-limit/rate-limiter";
import type { BlockReason, JobPlatform, PageKind } from "../ports/job-platform";
import type { Logger } from "../ports/logger";
import type { Storage } from "../ports/storage";
import type { Effect } from "./events";
import type { ApplicationHistory } from "./history";
import type { AutomationContext, PauseReason } from "./state";

/**
 * Collaborators the orchestrator needs. Passed explicitly (constructor-style
 * injection) rather than resolved through a container.
 */
export interface OrchestratorDeps {
  readonly platform: JobPlatform;
  readonly engine: RuleEngine;
  readonly history: ApplicationHistory;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
  readonly config: RuleEngineConfig;
  readonly version: string;
  /** Persists the current persisted root. */
  readonly persist: () => Promise<void>;
  /** Emits an event back into the state machine. */
  readonly dispatch: (event: import("./events").AutomationEvent) => void;
  /** Surfaces a user-facing notification. */
  readonly notify: (level: "info" | "warn" | "error", message: string) => void;
  /** Observes a diagnostics-worthy failure. */
  readonly onDiagnostic: (reason: PauseReason, context: AutomationContext) => void;
  /** Resolves the delay to apply before the next action. */
  readonly delayPolicy: { readonly minActionDelayMs: number; readonly maxActionDelayMs: number };
  readonly sessionPolicy: {
    readonly maxApplicationsPerSession: number;
    readonly maxApplicationsPerHour: number;
    readonly maxRetries: number;
  };
  /**
   * True when the operator explicitly selected this job for the batch run.
   * Selection IS the acceptance: a selected job bypasses scoring.
   */
  readonly isOperatorSelected: (jobId: string) => boolean;
}

/** Pending timers created by effects, so they can be cancelled on dispose. */
export interface Orchestrator {
  runEffect(effect: Effect, context: AutomationContext): Promise<void>;
  /** Cancels every pending timer. Safe to call repeatedly. */
  dispose(): void;
}

/**
 * Converts a platform `BlockReason` into the machine's `PauseReason`.
 * Kept as an explicit mapping so a new block reason cannot be silently ignored.
 */
export const pauseReasonFromBlock = (reason: BlockReason, evidence: string): PauseReason => {
  switch (reason) {
    case "captcha":
      return { kind: "captcha", evidence };
    case "risk-control":
      return { kind: "risk-control", evidence };
    case "login-expired":
      return { kind: "login-expired", evidence };
    case "unknown-dom":
      return { kind: "unknown-dom", evidence };
    case "selector-missing":
      return { kind: "selector-missing", selector: evidence };
    case "ambiguous-state":
      return { kind: "ambiguous-state", evidence };
    case "rate-limited":
      return { kind: "rate-limited", retryAt: 0 };
  }
};

/** Pages on which scanning is meaningless. Detected before any DOM work. */
const UNSCANNABLE_PAGES: readonly PageKind[] = [
  "captcha",
  "login-required",
  "unsupported",
  "unknown",
];

const pageKindToPauseReason = (pageKind: PageKind): PauseReason => {
  switch (pageKind) {
    case "captcha":
      return { kind: "captcha", evidence: "page detected as captcha" };
    case "login-required":
      return { kind: "login-expired", evidence: "page detected as login" };
    case "unsupported":
      return { kind: "unknown-dom", evidence: "unsupported page layout" };
    default:
      return { kind: "unknown-dom", evidence: `unexpected page kind: ${pageKind}` };
  }
};

export const createOrchestrator = (deps: OrchestratorDeps): Orchestrator => {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const schedule = (delayMs: number, action: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, delayMs);
    timers.add(timer);
  };

  const ruleContext = (): RuleContext => ({
    now: deps.clock.now(),
    processedJobIds: deps.history.submittedJobIds(),
    config: deps.config,
  });

  /**
   * Guards the session policy before any application action.
   * Returns true when it is legal to continue.
   */
  const checkSessionPolicy = (context: AutomationContext): boolean => {
    const verdict = evaluateSessionLimits(
      {
        sessionApplications: context.sessionApplications,
        applicationTimestamps: context.applicationTimestamps,
      },
      deps.sessionPolicy,
      { clock: deps.clock, maxPerHour: deps.sessionPolicy.maxApplicationsPerHour },
    );

    if (verdict.allowed) return true;

    if (verdict.reason === "session") {
      deps.dispatch({
        type: "SESSION_LIMIT_REACHED",
        limit: deps.sessionPolicy.maxApplicationsPerSession,
      });
      return false;
    }

    deps.dispatch({
      type: "BLOCKED",
      reason: "rate-limited",
      evidence: "hourly application cap reached",
    });
    return false;
  };

  const runEffect = async (effect: Effect, context: AutomationContext): Promise<void> => {
    switch (effect.type) {
      case "scan-jobs": {
        const pageKind = deps.platform.detectPage();
        if (UNSCANNABLE_PAGES.includes(pageKind)) {
          // Fail closed before touching the DOM.
          deps.dispatch({
            type: "BLOCKED",
            reason:
              pageKind === "captcha"
                ? "captcha"
                : pageKind === "login-required"
                  ? "login-expired"
                  : "unknown-dom",
            evidence: `page kind: ${pageKind}`,
          });
          return;
        }

        try {
          const summaries = await deps.platform.scanJobs({ limit: 50 });
          deps.dispatch({ type: "SCAN_COMPLETED", summaries, skipped: 0 });
        } catch (error) {
          deps.logger.error("orchestrator", "scan failed", { error });
          deps.dispatch({
            type: "SCAN_FAILED",
            error: error instanceof Error ? error.message : String(error),
            pageKind,
          });
        }
        return;
      }

      case "load-job": {
        try {
          // Enter `opening` before touching the platform so the watchdog and
          // the UI observe the load, not just its result.
          deps.dispatch({ type: "JOB_LOADING", summary: effect.summary });
          const detail = await deps.platform.loadJob(effect.summary);
          deps.dispatch({ type: "JOB_LOADED", job: detail });
        } catch (error) {
          deps.dispatch({
            type: "JOB_LOAD_FAILED",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "evaluate-job": {
        const engineEvaluation: Evaluation = deps.engine.evaluate({
          job: effect.job,
          context: ruleContext(),
        });

        // The operator's explicit selection is acceptance: it bypasses scoring
        // entirely. The manual reason is appended so the recorded decision
        // stays explainable.
        const evaluation: Evaluation = deps.isOperatorSelected(String(effect.job.id))
          ? {
              ...engineEvaluation,
              accepted: true,
              reasons: [
                ...engineEvaluation.reasons,
                {
                  ruleId: "manual.select",
                  kind: "soft",
                  delta: 0,
                  message: "手动选择（勾选）",
                },
              ],
            }
          : engineEvaluation;

        // Record the decision in history before acting on it.
        deps.history.discover(effect.job.platform, effect.job.id, deps.clock.now());
        deps.history.transition(effect.job.id, "evaluated", {
          now: deps.clock.now(),
          score: evaluation.score,
          reasons: evaluation.reasons.map((reason) => reason.message),
        });
        deps.history.transition(effect.job.id, evaluation.accepted ? "approved" : "rejected", {
          now: deps.clock.now(),
        });

        await deps.persist();
        deps.dispatch({ type: "EVALUATED", evaluation });

        // In assist/automatic mode an accepted job proceeds after a delay.
        if (evaluation.accepted && checkSessionPolicy(context)) {
          const delay = nextDelayMs(deps.delayPolicy, deps.random);
          schedule(delay, () => deps.dispatch({ type: "APPLY_STARTED", job: effect.job }));
        }
        return;
      }

      case "apply-job": {
        try {
          const result = await deps.platform.apply(effect.job);
          const outcome = result.outcome;

          switch (outcome.kind) {
            case "submitted":
              deps.dispatch({ type: "APPLY_SUBMITTED", evidence: outcome.evidence });
              return;
            case "already-applied":
              deps.dispatch({ type: "APPLY_ALREADY_DONE", evidence: outcome.evidence });
              return;
            case "needs-confirmation":
              // Ambiguous: never retry, always escalate to the user.
              deps.dispatch({ type: "APPLY_NEEDS_CONFIRMATION", evidence: outcome.evidence });
              return;
            case "rejected-by-form":
              deps.dispatch({ type: "APPLY_FAILED", error: outcome.evidence, retryable: false });
              return;
            case "blocked":
              deps.dispatch({
                type: "BLOCKED",
                reason: outcome.reason,
                evidence: outcome.evidence,
              });
              return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.error("orchestrator", "apply threw", { error: message });
          // An exception during apply leaves the outcome unknown: fail closed.
          deps.dispatch({ type: "APPLY_NEEDS_CONFIRMATION", evidence: `exception: ${message}` });
        }
        return;
      }

      case "verify-application": {
        try {
          const result = await deps.platform.verifyApplication(effect.job);
          switch (result.outcome.kind) {
            case "confirmed":
              deps.history.transition(effect.job.id, "submitted", { now: deps.clock.now() });
              deps.history.transition(effect.job.id, "verified", { now: deps.clock.now() });
              deps.dispatch({ type: "VERIFICATION_CONFIRMED", evidence: result.outcome.evidence });
              return;
            case "not-applied":
              deps.dispatch({ type: "VERIFICATION_NEGATIVE", evidence: result.outcome.evidence });
              return;
            case "indeterminate":
              deps.dispatch({
                type: "VERIFICATION_INDETERMINATE",
                evidence: result.outcome.evidence,
              });
              return;
          }
        } catch (error) {
          deps.dispatch({
            type: "VERIFICATION_INDETERMINATE",
            evidence: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "schedule-cooldown": {
        schedule(effect.delayMs, () => deps.dispatch({ type: "COOLDOWN_ELAPSED" }));
        return;
      }

      case "notify": {
        deps.notify(effect.level, effect.message);
        return;
      }

      case "persist": {
        await deps.persist();
        return;
      }

      case "record-diagnostics": {
        deps.onDiagnostic(effect.reason, context);
        return;
      }

      case "stop": {
        // Nothing to tear down here: the runtime owns the abort controller and
        // stops the watchdog when the machine leaves an active state.
        return;
      }

      default: {
        const exhaustive: never = effect;
        deps.logger.warn("orchestrator", "unhandled effect", { effect: exhaustive });
        return;
      }
    }
  };

  return {
    runEffect,
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
};

export { pageKindToPauseReason, UNSCANNABLE_PAGES };
