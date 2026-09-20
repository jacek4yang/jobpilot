/**
 * Rate limiter and delay centralisation.
 *
 * Every wait in JobPilot goes through here so that timing behaviour is
 * configurable in one place and deterministic under test. Scattering
 * `setTimeout` calls across the codebase is explicitly avoided.
 */
import type { Clock, Random } from "../../domain/support/shared";

export interface SleepOptions {
  readonly signal?: AbortSignal;
}

/** Promise-based sleep that rejects on abort. */
export const sleep = (ms: number, options: SleepOptions = {}): Promise<void> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface DelayPolicy {
  readonly minActionDelayMs: number;
  readonly maxActionDelayMs: number;
}

/**
 * Draws a random delay inside the configured window.
 *
 * Randomised delays avoid a mechanically regular request cadence, which is
 * both politer to the platform and more robust. The randomness is injected so
 * tests are deterministic.
 */
export const nextDelayMs = (policy: DelayPolicy, random: Random): number => {
  const min = Math.max(0, policy.minActionDelayMs);
  const max = Math.max(min, policy.maxActionDelayMs);
  if (min === max) return min;
  return Math.round(min + random.next() * (max - min));
};

export interface RateLimitOptions {
  readonly clock: Clock;
  readonly maxPerHour: number;
  /** Safety margin subtracted from the window, in ms. */
  readonly windowMs?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** When not allowed, the timestamp at which the next action becomes legal. */
  readonly retryAt?: number;
}

const ONE_HOUR_MS = 3_600_000;

/**
 * Sliding-window limiter over a list of past action timestamps.
 *
 * State is passed in and returned, never held internally, so the limiter
 * cannot drift from what the caller persisted.
 */
export const evaluateRateLimit = (
  timestamps: readonly number[],
  options: RateLimitOptions,
): RateLimitDecision => {
  if (options.maxPerHour <= 0) return { allowed: true };

  const windowMs = options.windowMs ?? ONE_HOUR_MS;
  const now = options.clock.now();
  const cutoff = now - windowMs;
  const recent = timestamps.filter((timestamp) => timestamp > cutoff);

  if (recent.length < options.maxPerHour) return { allowed: true };

  // The earliest timestamp in the window frees a slot when it ages out.
  const oldest = recent.reduce((min, value) => (value < min ? value : min), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(oldest)) return { allowed: true };
  return { allowed: false, retryAt: oldest + windowMs };
};

export interface SessionLimitState {
  readonly sessionApplications: number;
  readonly applicationTimestamps: readonly number[];
}

export type SessionLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "session" | "hourly"; readonly retryAt?: number };

/** Combines the per-session and per-hour caps into a single verdict. */
export const evaluateSessionLimits = (
  state: SessionLimitState,
  policy: { readonly maxApplicationsPerSession: number; readonly maxApplicationsPerHour: number },
  options: RateLimitOptions,
): SessionLimitVerdict => {
  if (
    policy.maxApplicationsPerSession > 0 &&
    state.sessionApplications >= policy.maxApplicationsPerSession
  ) {
    return { allowed: false, reason: "session" };
  }

  const rate = evaluateRateLimit(state.applicationTimestamps, {
    clock: options.clock,
    maxPerHour: policy.maxApplicationsPerHour,
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
  });

  if (!rate.allowed) {
    return {
      allowed: false,
      reason: "hourly",
      ...(rate.retryAt === undefined ? {} : { retryAt: rate.retryAt }),
    };
  }

  return { allowed: true };
};
