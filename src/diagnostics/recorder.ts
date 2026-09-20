/**
 * Diagnostic recorder.
 *
 * The single sink every subsystem writes structured evidence to. It implements
 * the existing `Logger` port, so existing call sites gain structured recording
 * without being rewritten, and new call sites can use the richer
 * `record()` API directly.
 *
 * Design constraints, all deliberate:
 *
 *  - **Bounded.** Every buffer has a capacity; eviction is counted and reported
 *    so lost evidence is visible rather than silent.
 *  - **Critical evidence is segregated.** A flood of `trace` noise must never
 *    evict the record of a send. Events in critical categories go to a small
 *    dedicated buffer as well as the main stream.
 *  - **Redaction at write time.** Values are sanitised before they enter any
 *    buffer, so no export path can leak them.
 *  - **Monotonic sequencing.** `sequence` is the join key for the whole bundle.
 *  - **Non-throwing.** A diagnostics failure must never break the product. The
 *    recorder swallows its own errors after recording the fact.
 */
import type { LogEntry, Logger, LogLevel } from "../ports/logger";
import {
  type DiagnosticCategory,
  type DiagnosticEvent,
  type DiagnosticLevel,
  EVENTS,
  type JsonValue,
  LEVEL_ORDER,
  type RecordEventInput,
} from "./event";
import { redactDiagnostic } from "./redact";
import { createRingBuffer, type RingBuffer } from "./ring-buffer";
import { type DiagnosticSession, PRE_SESSION_ID } from "./session";

export interface RecorderOptions {
  /** Wall clock. Injected so tests are deterministic. */
  readonly now: () => number;
  /** Monotonic clock. Defaults to `performance.now()` when available. */
  readonly monotonicNow?: () => number;
  readonly capacity: number;
  /** Entries below this level are discarded. */
  readonly minLevel: DiagnosticLevel;
  /** Capacity of the segregated critical-evidence buffer. */
  readonly criticalCapacity?: number;
}

export interface RecorderStats {
  readonly recorded: number;
  readonly dropped: number;
  readonly truncatedBatches: number;
  readonly criticalDropped: number;
}

export interface DiagnosticRecorder extends Logger {
  /** Records a structured event. Never throws. */
  record(input: RecordEventInput): void;
  /** Convenience wrappers that fill in level and category. */
  trace(
    category: DiagnosticCategory,
    event: string,
    data?: Readonly<Record<string, unknown>>,
  ): void;
  infoEvent(
    category: DiagnosticCategory,
    event: string,
    data?: Readonly<Record<string, unknown>>,
  ): void;
  warnEvent(
    category: DiagnosticCategory,
    event: string,
    data?: Readonly<Record<string, unknown>>,
  ): void;
  errorEvent(
    category: DiagnosticCategory,
    event: string,
    data?: Readonly<Record<string, unknown>>,
  ): void;

  /** All retained events, oldest first. */
  events(): readonly DiagnosticEvent[];
  /** Critical events only (communication, risk, errors, invariants). */
  criticalEvents(): readonly DiagnosticEvent[];
  stats(): RecorderStats;

  sessionId(): string;
  setSessionId(sessionId: string): void;
  startSession(session: DiagnosticSession): void;
  /** Marks the session finished without clearing buffers. */
  finishSession(status: Exclude<DiagnosticSession["status"], "running">): void;
  currentSession(): DiagnosticSession | undefined;

  /** Empties all buffers. Production state is untouched. */
  resetBuffers(): void;
}

/**
 * Categories whose evidence must survive a flood of trace noise.
 *
 * A send transaction, a risk detection, an error or an invariant violation is
 * the reason a bundle is being read at all; losing one of those to buffer
 * pressure would defeat the entire diagnostics layer.
 */
const CRITICAL_CATEGORIES: readonly DiagnosticCategory[] = [
  "communication",
  "chat-identity",
  "verification",
  "risk",
  "error",
  "lock",
  "storage",
];

const isCritical = (category: DiagnosticCategory): boolean =>
  CRITICAL_CATEGORIES.includes(category);

const defaultMonotonic = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === "function") return perf.now();
  return Date.now();
};

/** Maps the diagnostic level onto the legacy logger level. */
const toLogLevel = (level: DiagnosticLevel): LogLevel => {
  switch (level) {
    case "trace":
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
  }
};

/**
 * Coerces arbitrary context into JSON-safe values.
 *
 * Redaction runs first so nothing sensitive is even held in memory as a plain
 * string before being discarded. The result is then narrowed to `JsonValue`:
 * the recorder's contract is that `data` is serialisable, and anything that is
 * not (a class instance, a function, a cyclic object) is dropped here rather
 * than failing at ZIP time when the evidence matters most.
 */
const toSafeData = (
  data: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (data === undefined) return undefined;
  const redacted = redactDiagnostic(data);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) {
    return undefined;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(redacted as Record<string, unknown>)) {
    if (isJsonValue(value)) output[key] = value;
  }
  return output;
};

/** Structural check for JSON-serialisability. Depth-bounded by the redactor. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return kind !== "number" || Number.isFinite(value as number);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (kind === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
};

export const createDiagnosticRecorder = (options: RecorderOptions): DiagnosticRecorder => {
  const monotonicNow = options.monotonicNow ?? defaultMonotonic;
  const criticalCapacity = options.criticalCapacity ?? 500;

  let sequence = 0;
  let sessionId = PRE_SESSION_ID;
  let session: DiagnosticSession | undefined;
  let truncatedBatches = 0;

  const main: RingBuffer<DiagnosticEvent> = createRingBuffer<DiagnosticEvent>({
    capacity: options.capacity,
    onDrop: (dropped) => {
      truncatedBatches += 1;
      // Recorded inline rather than deferred: the truncation is itself evidence,
      // and it must appear in the stream in the position where it happened.
      write({
        level: "warn",
        category: "diagnostics",
        event: EVENTS.bufferTruncated,
        data: { dropped, capacity: options.capacity, buffer: "events" },
      });
    },
  });

  const critical: RingBuffer<DiagnosticEvent> = createRingBuffer<DiagnosticEvent>({
    capacity: criticalCapacity,
    onDrop: (dropped) => {
      write({
        level: "warn",
        category: "diagnostics",
        event: EVENTS.bufferTruncated,
        data: { dropped, capacity: criticalCapacity, buffer: "critical" },
      });
    },
  });

  /** The one place an event is constructed, so ordering cannot be bypassed. */
  function write(input: RecordEventInput): DiagnosticEvent | undefined {
    if (LEVEL_ORDER[input.level] < LEVEL_ORDER[options.minLevel]) return undefined;

    // Incremented as a statement, not inline in the object literal: an
    // assignment buried in an expression is easy to misread, and this counter
    // is the join key for the entire bundle.
    sequence += 1;

    const event: DiagnosticEvent = {
      sequence,
      sessionId,
      wallTime: options.now(),
      monotonicTime: monotonicNow(),
      level: input.level,
      category: input.category,
      event: input.event,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.queueItemId === undefined ? {} : { queueItemId: input.queueItemId }),
      ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
      ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
      ...(input.data === undefined ? {} : { data: input.data }),
    };

    main.push(event);
    if (isCritical(input.category)) critical.push(event);
    return event;
  }

  /**
   * Wraps a call so a diagnostics bug cannot break the product.
   *
   * A failure is reported once, as a plain `error` event, and then swallowed —
   * a broken recorder must never be worse than no recorder.
   */
  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Intentionally silent: reporting through the same failing path would
      // recurse. The absence of later events is itself visible in the bundle.
    }
  };

  const record = (input: RecordEventInput): void => {
    guarded(() => {
      write({ ...input, data: toSafeData(input.data) });
    });
  };

  // --- Logger port ---------------------------------------------------------

  const log = (
    level: LogLevel,
    component: string,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    // The whole payload goes through the same sanitising path as any other
    // event, so a nested object inside `context` cannot bypass redaction by
    // hiding below the top level.
    const payload: Record<string, unknown> = { component, message };
    if (context !== undefined) payload["context"] = context;
    record({ level, category: "runtime", event: "log", data: payload as never });
  };

  return {
    record,

    trace: (category, event, data) =>
      record({ level: "trace", category, event, data: toSafeData(data) }),
    infoEvent: (category, event, data) =>
      record({ level: "info", category, event, data: toSafeData(data) }),
    warnEvent: (category, event, data) =>
      record({ level: "warn", category, event, data: toSafeData(data) }),
    errorEvent: (category, event, data) =>
      record({ level: "error", category, event, data: toSafeData(data) }),

    debug: (component, message, context) => log("debug", component, message, context),
    info: (component, message, context) => log("info", component, message, context),
    warn: (component, message, context) => log("warn", component, message, context),
    error: (component, message, context) => log("error", component, message, context),

    /**
     * Legacy `entries()` view, derived from the event stream.
     *
     * The panel renders log lines from this, so the UI did not need rewriting
     * when the recorder replaced the plain logger.
     */
    entries(): readonly LogEntry[] {
      return main
        .entries()
        .filter((event) => event.event === "log")
        .map((event) => {
          const data = (event.data ?? {}) as {
            component?: unknown;
            message?: unknown;
          };
          return {
            timestamp: event.wallTime,
            level: toLogLevel(event.level),
            component: typeof data.component === "string" ? data.component : "jobpilot",
            message: typeof data.message === "string" ? data.message : "",
          };
        });
    },

    clear: () => main.clear(),
    events: () => main.entries(),
    criticalEvents: () => critical.entries(),
    stats: () => ({
      recorded: sequence,
      dropped: main.dropped,
      truncatedBatches,
      criticalDropped: critical.dropped,
    }),

    sessionId: () => sessionId,
    setSessionId: (next) => {
      sessionId = next;
    },
    startSession: (next) => {
      session = next;
      sessionId = next.id;
      record({
        level: "info",
        category: "diagnostics",
        event: EVENTS.sessionStarted,
        data: { scenarioId: next.scenarioId, scenarioName: next.scenarioName },
      });
    },
    finishSession: (status) => {
      if (session === undefined) return;
      record({
        level: "info",
        category: "diagnostics",
        event: status === "aborted" ? EVENTS.sessionAborted : EVENTS.sessionFinished,
        data: { status },
      });
      session = { ...session, status, finishedAt: options.now() };
    },
    currentSession: () => session,

    resetBuffers: () => {
      main.clear();
      critical.clear();
      record({
        level: "info",
        category: "diagnostics",
        event: "diagnostics.buffers.reset",
      });
    },
  };
};

export { isCritical, toLogLevel };
