import type { Clock } from "../domain/support/shared";
import type { Watchdog } from "../infrastructure/watchdog/watchdog";
import type { Logger } from "../ports/logger";
import type { AutomationEvent, Effect } from "./events";
import type { ApplicationHistory } from "./history";
import type { Orchestrator } from "./orchestrator";
import { reduce } from "./reducer";
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
  /** Persists state; awaited after transitions that mark `persist`. */
  readonly onPersist: () => Promise<void>;
}

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
  let current: AutomationContext = initialContext(options.clock.now());
  let disposed = false;
  let draining = false;
  const pending: AutomationEvent[] = [];

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
        const result = reduce(current, next, {
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

        // Effects are awaited together so persistence ordering is stable.
        void (async () => {
          await runEffects(result.effects);
          await persistIfNeeded(result.effects);
        })();

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
