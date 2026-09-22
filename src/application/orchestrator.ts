import type { RuleEngine } from "../domain/engine";
import type { Evaluation, RuleContext, RuleEngineConfig } from "../domain/rule";
import type { Clock, Random } from "../domain/support/shared";
import { evaluateSessionLimits, nextDelayMs } from "../infrastructure/rate-limit/rate-limiter";
import type { BlockReason, JobPlatform, PageKind } from "../ports/job-platform";
import type { Logger } from "../ports/logger";
import type { Storage } from "../ports/storage";
import type { CommunicationService } from "./communication-service";
import type { Effect } from "./events";
import type { ApplicationHistory } from "./history";
import type { AutomationContext, PauseReason } from "./state";

/**
 * Collaborators the orchestrator needs. Passed explicitly (constructor-style
 * injection) rather than resolved through a container.
 */
export interface OrchestratorDeps {
  readonly platform: JobPlatform;
  /** The single authoritative owner of contact navigation and message send. */
  readonly communication: Pick<CommunicationService, "communicate">;
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
}

/** Pending timers created by effects, so they can be cancelled on dispose. */
export interface Orchestrator {
  runEffect(effect: Effect, context: AutomationContext): Promise<void>;
  /** Immediately cancels timers and the in-flight DOM/storage operation. */
  abortCurrent(): void;
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
  let activeOperation: AbortController | undefined;

  const beginOperation = (): AbortController => {
    activeOperation?.abort();
    const operation = new AbortController();
    activeOperation = operation;
    return operation;
  };

  const finishOperation = (operation: AbortController): void => {
    if (activeOperation === operation) activeOperation = undefined;
  };

  const abortCurrent = (): void => {
    activeOperation?.abort();
    activeOperation = undefined;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

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
        const operation = beginOperation();
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
          finishOperation(operation);
          return;
        }

        try {
          const summaries = await deps.platform.scanJobs({ limit: 50, signal: operation.signal });
          if (operation.signal.aborted) return;
          deps.dispatch({ type: "SCAN_COMPLETED", summaries, skipped: 0 });
        } catch (error) {
          if (operation.signal.aborted) return;
          deps.logger.error("orchestrator", "scan failed", { error });
          deps.dispatch({
            type: "SCAN_FAILED",
            error: error instanceof Error ? error.message : String(error),
            pageKind,
          });
        }
        finishOperation(operation);
        return;
      }

      case "load-job": {
        const operation = beginOperation();
        try {
          // Enter `opening` before touching the platform so the watchdog and
          // the UI observe the load, not just its result.
          deps.dispatch({ type: "JOB_LOADING", summary: effect.summary });
          const detail = await deps.platform.loadJob(effect.summary, { signal: operation.signal });
          if (operation.signal.aborted) return;
          deps.dispatch({ type: "JOB_LOADED", job: detail });
        } catch (error) {
          if (operation.signal.aborted) return;
          deps.dispatch({
            type: "JOB_LOAD_FAILED",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        finishOperation(operation);
        return;
      }

      case "evaluate-job": {
        const engineEvaluation: Evaluation = deps.engine.evaluate({
          job: effect.job,
          context: ruleContext(),
        });
        // Every job reaching this effect came from the operator's frozen
        // current-page selection. Selection authorises proceeding past soft
        // preference scoring, but never past a hard rejection.
        const evaluation: Evaluation =
          !engineEvaluation.accepted && engineEvaluation.rejections.length === 0
            ? { ...engineEvaluation, accepted: true }
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
          schedule(delay, () => deps.dispatch({ type: "CONTACT_STARTED", job: effect.job }));
        }
        return;
      }

      case "contact-job": {
        const operation = beginOperation();
        try {
          const outcome = await deps.communication.communicate({
            job: effect.job,
            signal: operation.signal,
          });
          if (operation.signal.aborted && outcome.kind !== "uncertain") return;

          switch (outcome.kind) {
            case "sent":
              deps.history.transition(effect.job.id, "submitted", { now: deps.clock.now() });
              deps.history.transition(effect.job.id, "verified", { now: deps.clock.now() });
              deps.dispatch({ type: "CONTACT_CONFIRMED", evidence: outcome.evidence });
              return;
            case "uncertain":
              deps.dispatch({ type: "CONTACT_UNCERTAIN", evidence: outcome.detail });
              return;
            case "aborted":
              deps.dispatch({
                type: "BLOCKED",
                reason: "ambiguous-state",
                evidence: outcome.detail,
              });
              return;
            case "blocked":
              deps.dispatch({
                type: "BLOCKED",
                reason: outcome.reason,
                evidence: outcome.evidence,
              });
              return;
            case "needs-human-click":
              // The contact control was highlighted and never clicked (the site
              // rejects synthetic clicks), and the operator did not produce the
              // conversation within the human-scale budget. Fail closed into a
              // paused state carrying the actionable message. This goes through
              // PAUSE, not BLOCKED, because BLOCKED carries only a platform
              // BlockReason — the reducer's BLOCKED map has no slot for this
              // reason, and PAUSE passes a full PauseReason to the same
              // fail-closed blockFor path.
              deps.dispatch({
                type: "PAUSE",
                reason: { kind: "needs-human-click", evidence: outcome.detail },
              });
              return;
            case "refused":
              deps.dispatch({
                type: "BLOCKED",
                reason: "ambiguous-state",
                evidence: outcome.message,
              });
              return;
          }
        } catch (error) {
          if (operation.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.error("orchestrator", "communication threw", { error: message });
          // An exception during communication leaves the outcome unknown.
          deps.dispatch({ type: "CONTACT_UNCERTAIN", evidence: `exception: ${message}` });
        }
        finishOperation(operation);
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
        abortCurrent();
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
    abortCurrent,
    dispose() {
      abortCurrent();
    },
  };
};

export { pageKindToPauseReason, UNSCANNABLE_PAGES };
