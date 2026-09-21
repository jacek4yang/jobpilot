import type { Clock } from "../domain/support/shared";
import type { Watchdog } from "../infrastructure/watchdog/watchdog";
import type { Logger } from "../ports/logger";
import type { AutomationEvent, Effect } from "./events";
import type { ApplicationHistory } from "./history";
import type { Orchestrator } from "./orchestrator";
import { type ReduceOptions, type ReduceResult, reduce } from "./reducer";
import type { AutomationContext } from "./state";
import { initialContext, isActive } from "./state";

export interface ControllerOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly orchestrator: Orchestrator;
  readonly history: ApplicationHistory;
  readonly watchdog: Watchdog;
  readonly maxRetries: number;
  /** Called after every transition so the UI can re-render. */
  readonly onChange: (context: AutomationContext) => void;
  /**
   * The reducer to drive the machine with.
   *
   * Defaults to the pure `reduce`. Production injects a tracing wrapper, which
   * is how state transitions reach the diagnostic stream without the reducer
   * gaining a diagnostics dependency.
   */
  readonly reducer?: Reducer;
  /** Persists state; awaited after transitions that mark `persist`. */
  readonly onPersist: () => Promise<void>;
}

/** Signature shared by the pure reducer and any tracing wrapper. */
export type Reducer = (
  context: AutomationContext,
  event: AutomationEvent,
  options: ReduceOptions,
) => ReduceResult;

export interface Controller {
  dispatch(event: AutomationEvent): void;
  context(): AutomationContext;
  /** Runs effects for the current context. Exposed for tests. */
  drain(effects: readonly Effect[]): Promise<void>;
  dispose(): void;
}

/**
 * Drives the state machine.
 *
 * Responsibilities are deliberately narrow: feed events through the pure
 * reducer, keep the current context, run the returned effects, and keep the
 * watchdog in sync. All automation logic lives in the reducer; all I/O lives
 * in the orchestrator.
 */
export const createController = (options: ControllerOptions): Controller => {
  const activeReducer: Reducer = options.reducer ?? reduce;
  let current: AutomationContext = initialContext(options.clock.now());
  let disposed = false;
  let draining = false;
  const pending: AutomationEvent[] = [];

  /**
   * Serialises effect execution across dispatches.
   *
   * Effects are not awaited by `dispatch` (a slow effect must not block the
   * state machine), but they must not run concurrently either: two overlapping
   * effect batches could interleave DOM actions and writes. Chaining each batch
   * onto this promise keeps them strictly ordered while remaining non-blocking
   * from the caller's perspective.
   */
  let effects: Promise<void> = Promise.resolve();

  const runEffects = async (effects: readonly Effect[]): Promise<void> => {
    for (const effect of effects) {
      if (disposed) return;
      try {
        await options.orchestrator.runEffect(effect, current);
      } catch (error) {
        // An effect throwing must never wedge the machine: log and fail closed
        // by pausing, which is the same path every other safety signal takes.
        options.logger.error("controller", "effect failed", { effect: effect.type, error });
        dispatch({
          type: "PAUSE",
          reason: {
            kind: "ambiguous-state",
            evidence: `effect ${effect.type} threw`,
          },
        });
      }
    }
  };

  const persistIfNeeded = async (effects: readonly Effect[]): Promise<void> => {
    if (!effects.some((effect) => effect.type === "persist")) return;
    try {
      await options.onPersist();
    } catch (error) {
      options.logger.error("controller", "persist failed", { error });
    }
  };

  function dispatch(event: AutomationEvent): void {
    if (disposed) return;

    const expectedChatTransition =
      event.type === "PAGE_CHANGED" && current.state === "contacting" && event.pageKind === "chat";
    if (
      !expectedChatTransition &&
      (event.type === "STOP" ||
        event.type === "PAUSE" ||
        event.type === "PAGE_CHANGED" ||
        event.type === "WATCHDOG_TIMEOUT" ||
        event.type === "BLOCKED")
    ) {
      options.orchestrator.abortCurrent();
    }

    // Reentrancy guard: effects dispatch follow-up events, so a naive
    // implementation would recurse. Queue instead and drain iteratively.
    if (draining) {
      pending.push(event);
      return;
    }

    draining = true;
    try {
      let queue: AutomationEvent[] = [event];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;

        const previousState = current.state;
        // The reducer is injected so tracing can wrap it without the reducer
        // itself gaining any diagnostics dependency. It stays pure and remains
        // testable with no recorder at all.
        const result = activeReducer(current, next, {
          now: options.clock.now(),
          maxRetries: options.maxRetries,
        });

        current = result.context;

        if (current.state !== previousState) {
          options.watchdog.watch(current.state);
          // The watchdog only makes sense while work is in flight.
          if (isActive(current.state)) options.watchdog.start();
          else options.watchdog.stop();
        }

        options.onChange(current);

        // Effects run outside the reducer, deliberately un-awaited so a slow
        // effect cannot block the state machine. Concurrency is bounded by the
        // effect queue below: effects are chained rather than run in parallel,
        // so two dispatches cannot interleave their DOM work or their writes.
        effects = effects.then(async () => {
          // Re-check after the chain hop: a dispose may have landed while this
          // batch waited for the previous one to finish.
          if (disposed) return;
          await runEffects(result.effects);
          await persistIfNeeded(result.effects);
        });

        queue = queue.concat(pending.splice(0, pending.length));
      }
    } finally {
      draining = false;
    }
  }

  return {
    dispatch,
    context: () => current,
    drain: runEffects,
    dispose() {
      disposed = true;
      pending.length = 0;
      options.watchdog.stop();
      options.orchestrator.dispose();
    },
  };
};
