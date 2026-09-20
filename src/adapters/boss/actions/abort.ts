/**
 * Abort-signal helpers shared by the BOSS adapter.
 *
 * `AbortSignal.throwIfAborted` exists in modern browsers, but JobPilot runs in
 * userscript managers with heterogeneous engine versions, so the check is
 * implemented here against the stable `aborted` flag only.
 */

/**
 * Throws the signal's abort reason when the signal has already fired.
 *
 * Failure mode: throws the abort reason (an `AbortError` `DOMException` in
 * practice). Callers that must not throw use `withinLimit` instead.
 */
export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal === undefined || !signal.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  // Environment-specific abort reasons (string, DOMException, undefined) are
  // normalised into a standard AbortError so callers can branch on `name`.
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
};

/**
 * Returns `true` while the signal has not fired.
 *
 * Used as a loop guard so long scans bail out between cards rather than
 * mid-parse.
 */
export const withinLimit = (signal: AbortSignal | undefined): boolean =>
  signal === undefined || !signal.aborted;

/** True when the signal is present and aborted. */
export const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
