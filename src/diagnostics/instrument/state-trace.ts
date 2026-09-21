/**
 * State-machine tracing.
 *
 * Wraps the pure reducer with an observer. The reducer itself stays pure: it
 * takes a context and an event and returns a context plus effects, with no
 * knowledge of diagnostics. Everything here is observation, applied at the call
 * site, so the domain remains testable without a recorder.
 *
 * Two things are recorded that are easy to omit and expensive to miss:
 *
 *  - **Rejected transitions.** The reducer returns the context unchanged for an
 *    event that is illegal in the current state. "Nothing happened" is a real
 *    diagnostic finding — it is how a stray async callback shows up — and a
 *    trace that only records state CHANGES hides it.
 *  - **Dwell time.** How long the machine sat in the previous state is what
 *    distinguishes "slow" from "stuck", and it cannot be reconstructed reliably
 *    from wall-clock timestamps alone when other events interleave.
 */
import type { AutomationEvent, Effect } from "../../application/events";
import { type ReduceOptions, type ReduceResult, reduce } from "../../application/reducer";
import type { AutomationContext } from "../../application/state";
import { EVENTS, type JsonValue } from "../../diagnostics/event";
import type { DiagnosticRecorder } from "../../diagnostics/recorder";

export interface TracedReduceInput {
  readonly context: AutomationContext;
  readonly event: AutomationEvent;
  readonly options: ReduceOptions;
  /** Route correlation, when the caller knows it. */
  readonly routeId?: string;
}

/** Correlation ids lifted out of the context so every trace line carries them. */
const correlationOf = (
  context: AutomationContext,
  routeId: string | undefined,
): {
  readonly jobId?: string;
  readonly transactionId?: string;
  readonly routeId?: string;
} => {
  const jobId = context.currentJob?.id;
  return {
    ...(jobId === undefined ? {} : { jobId: String(jobId) }),
    ...(routeId === undefined ? {} : { routeId }),
  };
};

/** The effect types an event produced, for the trace line. */
const effectTypes = (effects: readonly Effect[]): readonly string[] =>
  effects.map((effect) => effect.type);

/**
 * Reduces with tracing.
 *
 * Returns exactly what `reduce` returns, so it is a drop-in replacement. The
 * only difference is the side effect of recording — which never throws, so a
 * diagnostics failure cannot alter the machine's behaviour.
 */
export const reduceWithTrace = (
  recorder: DiagnosticRecorder,
  input: TracedReduceInput,
): ReduceResult => {
  const { context, event, options } = input;
  const from = context.state;
  const startedAt = options.now;

  const result = reduce(context, event, options);
  const to = result.context.state;
  const changed = from !== to;

  // Dwell time is measured from the context's own `stateSince`, which the
  // reducer maintains, rather than from a timestamp this wrapper keeps. A
  // second source of truth would drift.
  const dwellMs = Math.max(0, startedAt - context.stateSince);

  const correlation = correlationOf(context, input.routeId);
  const data: Record<string, JsonValue> = {
    from,
    trigger: event.type,
    to,
    changed,
    dwellMs,
    effects: effectTypes(result.effects),
  };

  recorder.record({
    level: changed ? "info" : "debug",
    category: "state-machine",
    event: changed ? EVENTS.stateTransition : EVENTS.stateTransitionRejected,
    state: to,
    ...correlation,
    data,
  });

  return result;
};

/**
 * Records the effects a transition produced, before any of them run.
 *
 * Kept separate from `reduceWithTrace` so a caller that wants transition
 * tracing without effect tracing can have it, and so the ordering requirement
 * is explicit: irreversible effects must be recorded BEFORE they execute.
 */
export const recordEffectsScheduled = (
  recorder: DiagnosticRecorder,
  effects: readonly Effect[],
  context: AutomationContext,
  routeId?: string,
): void => {
  for (const effect of effects) {
    recorder.record({
      level: "trace",
      category: "effect",
      event: "effect.scheduled",
      ...correlationOf(context, routeId),
      data: { effect: effect.type },
    });
  }
};

export { correlationOf };
