/**
 * Structured logger with a bounded ring buffer.
 *
 * Design notes:
 * - The buffer is capped so a long-running session cannot exhaust memory.
 * - Every entry is redacted on the way in, so credentials and private
 *   message content can never be persisted, exported or rendered.
 * - Zero telemetry: nothing is ever sent anywhere. The buffer is local-only.
 */

import type { Clock } from "../../domain/support/shared";
import type { LogEntry, Logger, LogLevel } from "../../ports/logger";
import { redact } from "../../ports/logger";

export interface LoggerOptions {
  readonly clock: Clock;
  /** Maximum retained entries. Older entries are dropped. */
  readonly capacity?: number;
  /** Entries below this level are discarded. */
  readonly minLevel?: LogLevel;
  /** Optional sink, e.g. the browser console during development. */
  readonly sink?: (entry: LogEntry) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_LOG_CAPACITY = 500;

export const createLogger = (options: LoggerOptions): Logger => {
  const capacity = options.capacity ?? DEFAULT_LOG_CAPACITY;
  const minLevel = options.minLevel ?? "info";
  const buffer: LogEntry[] = [];

  const record = (
    level: LogLevel,
    component: string,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const entry: LogEntry = {
      timestamp: options.clock.now(),
      level,
      component,
      message: redact(message) as string,
      ...(context === undefined ? {} : { context: redact(context) as Record<string, unknown> }),
    };

    buffer.push(entry);
    if (buffer.length > capacity) {
      buffer.splice(0, buffer.length - capacity);
    }
    options.sink?.(entry);
  };

  return {
    debug: (component, message, context) => record("debug", component, message, context),
    info: (component, message, context) => record("info", component, message, context),
    warn: (component, message, context) => record("warn", component, message, context),
    error: (component, message, context) => record("error", component, message, context),
    entries: () => [...buffer],
    clear: () => {
      buffer.length = 0;
    },
  };
};

/** Logger that discards everything. Used in tests and in `manual` mode. */
export const createNullLogger = (): Logger => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: () => [],
  clear: () => {},
});
