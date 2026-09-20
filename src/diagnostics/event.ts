/**
 * Diagnostic event model.
 *
 * Events are the raw evidence. Everything else in the diagnostics layer — the
 * timeline, the transaction report, the analyzer's findings — is derived from
 * this stream, so the shape here is deliberately narrow and stable.
 *
 * Two design choices matter:
 *
 *  - `sequence` is the join key, never a timestamp. Wall clocks jump (NTP,
 *    timezone, user edits) and two events can share a millisecond; a monotonic
 *    sequence cannot be ambiguous.
 *  - `monotonicTime` accompanies `wallTime`. Reconstructing a race needs a
 *    clock that only moves forward, which `performance.now()` provides.
 */

export type DiagnosticLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Ordering for level filtering. Lower is noisier. */
export const LEVEL_ORDER: Readonly<Record<DiagnosticLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Event categories.
 *
 * Kept as a closed union so a typo is a compile error and the analyzer can
 * enumerate what it understands.
 */
export type DiagnosticCategory =
  | "runtime"
  | "bootstrap"
  | "route"
  | "page-detection"
  | "selector"
  | "dom"
  | "discovery"
  | "parser"
  | "filter"
  | "scoring"
  | "queue"
  | "state-machine"
  | "effect"
  | "communication"
  | "chat-identity"
  | "message"
  | "verification"
  | "storage"
  | "migration"
  | "lock"
  | "rate-limit"
  | "retry"
  | "watchdog"
  | "observer"
  | "user-action"
  | "risk"
  | "error"
  | "recovery"
  | "diagnostics";

export const DIAGNOSTIC_CATEGORIES: readonly DiagnosticCategory[] = [
  "runtime",
  "bootstrap",
  "route",
  "page-detection",
  "selector",
  "dom",
  "discovery",
  "parser",
  "filter",
  "scoring",
  "queue",
  "state-machine",
  "effect",
  "communication",
  "chat-identity",
  "message",
  "verification",
  "storage",
  "migration",
  "lock",
  "rate-limit",
  "retry",
  "watchdog",
  "observer",
  "user-action",
  "risk",
  "error",
  "recovery",
  "diagnostics",
];

/** JSON-safe value. Keeps `data` from smuggling in class instances. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export interface DiagnosticEvent {
  /** Monotonic within a session, starting at 1. */
  readonly sequence: number;
  readonly sessionId: string;
  /** `Date.now()` at record time. */
  readonly wallTime: number;
  /** `performance.now()` at record time. Only differences are meaningful. */
  readonly monotonicTime: number;
  readonly level: DiagnosticLevel;
  readonly category: DiagnosticCategory;
  /** Stable, machine-readable, dot-namespaced, e.g. `queue.item.enqueued`. */
  readonly event: string;

  readonly state?: string;
  readonly jobId?: string;
  readonly queueItemId?: string;
  readonly transactionId?: string;
  readonly routeId?: string;

  readonly data?: Readonly<Record<string, JsonValue>>;
}

export interface RecordEventInput {
  readonly level: DiagnosticLevel;
  readonly category: DiagnosticCategory;
  readonly event: string;
  readonly state?: string;
  readonly jobId?: string;
  readonly queueItemId?: string;
  readonly transactionId?: string;
  readonly routeId?: string;
  /**
   * Structured payload.
   *
   * Declared as `| undefined` deliberately: callers routinely pass the result of
   * a sanitiser that may return `undefined`, and under
   * `exactOptionalPropertyTypes` an optional property does not accept an
   * explicit `undefined`. Omitting the key and passing `undefined` are treated
   * identically by the recorder.
   */
  readonly data?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Stable event names. Referenced by name so the analyzer and tests agree. */
export const EVENTS = {
  // session lifecycle
  sessionStarted: "diagnostics.session.started",
  sessionFinished: "diagnostics.session.finished",
  sessionAborted: "diagnostics.session.aborted",
  bufferTruncated: "diagnostics.buffer.truncated",

  // state machine
  stateTransition: "state.transition",
  stateTransitionRejected: "state.transition.rejected",

  // effects
  effectStarted: "effect.started",
  effectCompleted: "effect.completed",
  effectFailed: "effect.failed",
  effectTimedOut: "effect.timed_out",
  effectCancelled: "effect.cancelled",

  // queue
  queueItemEnqueued: "queue.item.enqueued",
  queueItemStarted: "queue.item.started",
  queueItemCompleted: "queue.item.completed",
  queueItemSkipped: "queue.item.skipped",
  queueItemFailed: "queue.item.failed",
  queueItemBlocked: "queue.item.blocked",
  queueItemRemoved: "queue.item.removed",
  queueCleared: "queue.cleared",

  // selectors
  selectorMatch: "selector.match",
  selectorMiss: "selector.miss",
  selectorAmbiguous: "selector.ambiguous",

  // route / page
  routeChanged: "route.changed",
  pageClassified: "page.detected",
  pageFingerprinted: "page.fingerprinted",

  // communication
  intentCreated: "communication.intent.created",
  intentArmed: "communication.intent.armed",
  actionDiscovered: "communication.action.discovered",
  preconditionsChecked: "communication.preconditions.checked",
  navigationStarted: "communication.navigation.started",
  modalObserved: "communication.modal.observed",
  chatCandidateDetected: "chat.candidate.detected",
  identityEvaluated: "chat.identity.evaluated",
  identityMatched: "chat.identity.matched",
  identityRejected: "chat.identity.rejected",
  messageSourceSelected: "message.source.selected",
  editorInspected: "message.editor.inspected",
  draftChecked: "message.draft.checked",
  messagePrepared: "message.prepared",
  sendAttemptPersisted: "communication.send.attempt.persisted",
  sendClicked: "communication.send.clicked",
  sendAttempted: "communication.send.attempted",
  verificationStarted: "communication.verification.started",
  outgoingMessageFound: "communication.outgoing.found",
  transactionCommitted: "communication.transaction.committed",
  transactionUncertain: "communication.transaction.uncertain",
  transactionFailed: "communication.transaction.failed",
  sendVerified: "communication.send.verified",
  sendUncertain: "communication.send.uncertain",

  // storage
  storageRead: "storage.read",
  storageReadFailed: "storage.read.failed",
  storageWrite: "storage.write",
  storageWriteFailed: "storage.write.failed",
  storageReset: "storage.reset",
  storageHealthChanged: "storage.health.changed",
  migrationApplied: "migration.applied",
  migrationFailed: "migration.failed",

  // lock
  lockRequested: "lock.requested",
  lockAcquired: "lock.acquired",
  lockRejected: "lock.rejected",
  lockRenewed: "lock.renewed",
  lockReleased: "lock.released",
  lockLeaseExpired: "lock.lease.expired",
  lockOwnershipChanged: "lock.ownership.changed",

  // risk
  captchaDetected: "risk.captcha.detected",
  loginDetected: "risk.login.detected",
  securityVerificationDetected: "risk.security_verification.detected",
  riskControlDetected: "risk.risk_control.detected",
  tooFrequentDetected: "risk.too_frequent.detected",
  unknownModalDetected: "risk.unknown_modal.detected",
  humanVerificationRecheck: "risk.human_verification.recheck",
  humanVerificationResolved: "risk.human_verification.resolved",

  // user actions
  userStart: "user.start",
  userPause: "user.pause",
  userResume: "user.resume",
  userStop: "user.stop",
  userSkip: "user.skip",
  userRetry: "user.retry",
  userModeChanged: "user.mode_changed",
  userOpenedJob: "user.opened_job",
  userChangedRoute: "user.changed_route",
  userEditedMessage: "user.edited_message",
  userCompletedVerification: "user.completed_verification",
  userExportedDiagnostics: "user.exported_diagnostics",

  // errors
  errorUncaught: "error.uncaught",
  errorUnhandledRejection: "error.unhandled_rejection",
  invariantViolation: "error.invariant_violation",
  crashCaptured: "error.crash.captured",
} as const;
