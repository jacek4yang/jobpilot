/**
 * Effect tracing.
 *
 * Wraps an orchestrator so every effect's lifecycle is reconstructable: when it
 * started, how long it took, whether it completed, failed, timed out or was
 * cancelled.
 *
 * The ordering rule from the brief is enforced by construction: the "started"
 * record is written BEFORE the effect runs, so an effect that hangs, crashes or
 * takes the page down still leaves evidence that it began. Recording only on
 * completion would lose exactly the cases worth diagnosing.
 */
import type { Effect } from "../../application/events";
import type { Orchestrator } from "../../application/orchestrator";
import type { AutomationContext } from "../../application/state";
import type { JsonValue } from "../event";
import { EVENTS } from "../event";
import type { DiagnosticRecorder } from "../recorder";

export interface EffectTraceOptions {
  readonly recorder: DiagnosticRecorder;
  /** Injected so durations are deterministic under test. */
  readonly now: () => number;
  /** Budget per effect type; exceeding it reports a timeout. */
  readonly budgets?: Readonly<Record<string, number>>;
}

const correlationOf = (
  context: AutomationContext,
): {
  readonly jobId?: string;
  readonly routeId?: string;
} => {
  const jobId = context.currentJob?.id;
  return jobId === undefined ? {} : { jobId: String(jobId) };
};

/** Classifies a thrown value without leaking its content into the bundle. */
const classifyFailure = (error: unknown): Record<string, JsonValue> => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      // The message is included because it is JobPilot's own text. Anything the
      // page threw is already redacted at write time.
      errorMessage: error.message.slice(0, 200),
      aborted: error.name === "AbortError",
    };
  }
  return { errorName: typeof error };
};

/**
 * Wraps an orchestrator so every effect is traced.
 *
 * Returns the same interface, so nothing downstream changes. A tracing failure
 * cannot affect the effect itself: recording never throws.
 */
export const traceOrchestrator = (
  inner: Orchestrator,
  options: EffectTraceOptions,
): Orchestrator => ({
  async runEffect(effect: Effect, context: AutomationContext): Promise<void> {
    const { recorder, now } = options;
    const startedAt = now();
    const correlation = correlationOf(context);

    recorder.record({
      level: "trace",
      category: "effect",
      event: EVENTS.effectStarted,
      ...correlation,
      data: { effect: effect.type },
    });

    try {
      await inner.runEffect(effect, context);
    } catch (error) {
      const durationMs = now() - startedAt;
      const failure = classifyFailure(error);
      // An abort is a cancellation, not a failure: it is the expected outcome
      // of pausing or disposing, and reporting it as a fault would fill the
      // bundle with noise at exactly the moment the operator stopped.
      const aborted = failure["aborted"] === true;

      recorder.record({
        level: aborted ? "debug" : "error",
        category: "effect",
        event: aborted ? EVENTS.effectCancelled : EVENTS.effectFailed,
        ...correlation,
        data: { effect: effect.type, durationMs, ...failure },
      });
      throw error;
    }

    const durationMs = now() - startedAt;
    const budget = options.budgets?.[effect.type];
    const overBudget = budget !== undefined && durationMs > budget;

    recorder.record({
      level: overBudget ? "warn" : "trace",
      category: "effect",
      event: overBudget ? EVENTS.effectTimedOut : EVENTS.effectCompleted,
      ...correlation,
      data: {
        effect: effect.type,
        durationMs,
        ...(budget === undefined ? {} : { budgetMs: budget }),
      },
    });
  },

  dispose() {
    inner.dispose();
  },
});

/**
 * Default effect budgets.
 *
 * Deliberately generous: this is an observation threshold for the bundle, not a
 * timeout that aborts anything. Aborting lives in the watchdog, which can fail
 * the machine closed; this only records that something was slow.
 */
export const DEFAULT_EFFECT_BUDGETS: Readonly<Record<string, number>> = {
  "scan-jobs": 30_000,
  "load-job": 30_000,
  "evaluate-job": 5_000,
  "apply-job": 45_000,
  "verify-application": 30_000,
  persist: 5_000,
};
