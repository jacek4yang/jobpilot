/**
 * Lightweight watchdog.
 *
 * Watches for a state that has not advanced within its budget, which is the
 * signature of a stalled DOM action, a target element that vanished, or an
 * unexpected route change. Recovery is deliberately conservative: it either
 * reports a stall so the machine can pause, or performs one bounded recovery
 * step. There are no infinite retry loops.
 */
import type { Clock } from "../../domain/support/shared";

export interface WatchdogBudget {
  /** State name this budget applies to. */
  readonly state: string;
  /** Milliseconds allowed in the state before a stall is reported. */
  readonly timeoutMs: number;
}

export interface WatchdogOptions {
  readonly clock: Clock;
  readonly budgets: readonly WatchdogBudget[];
  /** Invoked when a state exceeds its budget. Must be cheap and non-throwing. */
  readonly onStall: (state: string, elapsedMs: number) => void;
  /** How often the watchdog checks. Defaults to 1000ms. */
  readonly intervalMs?: number;
  /** Maximum consecutive stalls reported for the same state. Defaults to 2. */
  readonly maxStallsPerState?: number;
}

export interface Watchdog {
  /** Records that the machine entered a new state. */
  watch(state: string): void;
  /** Clears all tracking. Called on dispose. */
  reset(): void;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_STALLS = 2;

/**
 * Creates a watchdog. `start()` begins polling; `stop()` is idempotent and
 * always safe to call from a dispose path.
 */
export const createWatchdog = (options: WatchdogOptions): Watchdog => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxStalls = options.maxStallsPerState ?? DEFAULT_MAX_STALLS;

  let currentState: string | undefined;
  let stateEnteredAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stallCounts = new Map<string, number>();

  const check = (): void => {
    if (currentState === undefined) return;
    const budget = options.budgets.find((entry) => entry.state === currentState);
    if (budget === undefined) return;

    const elapsed = options.clock.now() - stateEnteredAt;
    if (elapsed < budget.timeoutMs) return;

    // Report at most `maxStalls` times per state, then stop nagging and wait
    // for the machine itself to fail closed.
    const reported = stallCounts.get(currentState) ?? 0;
    if (reported >= maxStalls) return;

    stallCounts.set(currentState, reported + 1);
    // Re-arm the budget so the next report measures a fresh interval.
    stateEnteredAt = options.clock.now();
    options.onStall(currentState, elapsed);
  };

  return {
    watch(state) {
      if (state === currentState) return;
      currentState = state;
      stateEnteredAt = options.clock.now();
      stallCounts.delete(state);
    },

    reset() {
      currentState = undefined;
      stallCounts.clear();
    },

    start() {
      if (timer !== undefined) return;
      timer = setInterval(check, intervalMs);
      // Never hold a Node.js process open because of the watchdog.
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
    },

    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },

    get running() {
      return timer !== undefined;
    },
  };
};

/** Default budgets, expressed per automation state. */
export const DEFAULT_WATCHDOG_BUDGETS: readonly WatchdogBudget[] = [
  { state: "scanning", timeoutMs: 30_000 },
  { state: "evaluating", timeoutMs: 10_000 },
  { state: "opening", timeoutMs: 30_000 },
  { state: "validating", timeoutMs: 10_000 },
  { state: "contacting", timeoutMs: 60_000 },
  { state: "cooldown", timeoutMs: 120_000 },
];
