/**
 * Retry with idempotency awareness.
 *
 * The central safety rule: retries only ever apply to operations declared
 * `idempotent`. Submitting an application is NOT idempotent and must never be
 * retried blindly — the caller has to verify the outcome first.
 */
import type { Clock } from "../../domain/support/shared";
import { sleep } from "../rate-limit/rate-limiter";

/** How safe it is to run an operation more than once. */
export type OperationSafety = "idempotent" | "unsafe";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface RetryAttemptInfo {
  readonly attempt: number;
  readonly error: unknown;
  readonly nextDelayMs: number;
}

export interface RetryOptions {
  readonly clock: Clock;
  readonly policy: RetryPolicy;
  readonly safety: OperationSafety;
  /** Consulted after a failure to decide whether retrying could help. */
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (info: RetryAttemptInfo) => void;
  readonly signal?: AbortSignal;
}

export type RetryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly attempts: number;
      /** True when the operation was never retried because it is unsafe. */
      readonly refusedUnsafeRetry: boolean;
    };

/** Exponential backoff with a hard ceiling. */
export const backoffDelayMs = (attempt: number, policy: RetryPolicy): number => {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
};

/**
 * Runs `operation`, retrying only when the operation is idempotent and the
 * error is classified as retryable.
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> => {
  const { policy, safety } = options;
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation();
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      lastError = error;

      const retryable = options.isRetryable?.(error) ?? true;
      const attemptsLeft = attempt < maxAttempts;

      // Refuse to retry anything that could duplicate a real-world action.
      if (safety === "unsafe" || !retryable || !attemptsLeft) {
        return {
          ok: false,
          error,
          attempts: attempt,
          refusedUnsafeRetry: safety === "unsafe",
        };
      }

      const delay = backoffDelayMs(attempt, policy);
      options.onRetry?.({ attempt, error, nextDelayMs: delay });

      if (delay > 0) {
        await sleep(delay, options.signal === undefined ? {} : { signal: options.signal });
      }
    }
  }

  return { ok: false, error: lastError, attempts: maxAttempts, refusedUnsafeRetry: false };
};

export { sleep };
