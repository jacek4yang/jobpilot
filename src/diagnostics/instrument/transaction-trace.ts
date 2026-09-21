/**
 * Communication transaction tracing.
 *
 * The communication transaction is the safety-critical path, so it gets the
 * densest tracing in the system: every phase edge is recorded against a stable
 * `transactionId`, so a bundle can reconstruct exactly what happened to one
 * send without reading the whole stream.
 *
 * Two rules are enforced here rather than left to call sites:
 *
 *  - **Never record message content.** Only the template id, length and a
 *    digest. A bundle must stay safe to hand over, and the message body is the
 *    one field that would make it unsafe.
 *  - **Record before acting.** For an irreversible step the intent is recorded
 *    BEFORE the action, so a crash mid-action still leaves evidence that it was
 *    about to happen. Recording after would lose precisely the case worth
 *    diagnosing.
 */
import type { CommunicationIntent } from "../../domain/communication/intent";
import { EVENTS, type JsonValue } from "../event";
import type { DiagnosticRecorder } from "../recorder";
import { fingerprint } from "../redact";

export interface TransactionContext {
  readonly transactionId: string;
  readonly jobId: string;
}

const base = (context: TransactionContext): Record<string, JsonValue> => ({
  transactionId: context.transactionId,
  jobId: context.jobId,
});

/**
 * Records the creation of an intent.
 *
 * The message is summarised, never stored: templateId, length and digest are
 * enough to tell whether the same message was prepared twice without exposing
 * what it said.
 */
export const recordIntentCreated = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  details: {
    readonly templateId: string;
    readonly messageText: string;
    readonly variablesUsed: readonly string[];
    readonly outgoingBaseline: number;
    readonly expiresAt: number;
  },
): void => {
  recorder.record({
    level: "info",
    category: "communication",
    event: EVENTS.intentCreated,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: {
      ...base(context),
      templateId: details.templateId,
      messageLength: details.messageText.length,
      messageDigest: fingerprint(details.messageText).sha256OrFnv,
      variablesUsed: [...details.variablesUsed],
      outgoingBaseline: details.outgoingBaseline,
      expiresAt: details.expiresAt,
    },
  });
};

/**
 * Records that the point of no return was persisted.
 *
 * Separate from `recordSendClicked` on purpose. The gap between them is the
 * window that a reload could fall into, and the analyzer needs to see both to
 * judge whether recovery behaved correctly.
 */
export const recordSendAttemptPersisted = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  intent: CommunicationIntent,
): void => {
  recorder.record({
    level: "info",
    category: "communication",
    event: EVENTS.sendAttemptPersisted,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: {
      ...base(context),
      phase: intent.phase,
      sendAttemptedAt: intent.sendAttemptedAt ?? null,
      clickDispatched: intent.clickDispatched ?? null,
    },
  });
};

/** Records the moment the click is dispatched. Must never precede the persist. */
export const recordSendClicked = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
): void => {
  recorder.record({
    level: "info",
    category: "communication",
    event: EVENTS.sendClicked,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: base(context),
  });
};

/** Records the identity evidence that justified a chat match or rejection. */
export const recordIdentityCheck = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  verdict: {
    readonly kind: "match" | "mismatch" | "insufficient";
    /** Which signals were compared, and whether each agreed. */
    readonly signals: Readonly<Record<string, JsonValue>>;
  },
): void => {
  recorder.record({
    level: verdict.kind === "match" ? "info" : "warn",
    category: "chat-identity",
    event:
      verdict.kind === "match"
        ? EVENTS.identityMatched
        : verdict.kind === "mismatch"
          ? EVENTS.identityRejected
          : EVENTS.identityEvaluated,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: { ...base(context), verdict: verdict.kind, ...verdict.signals },
  });
};

/** Records the verification outcome, including the evidence that produced it. */
export const recordVerification = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  outcome: {
    readonly kind: "verified" | "uncertain" | "negative";
    readonly outgoingCount: number;
    readonly baseline: number;
  },
): void => {
  const uncertain = outcome.kind === "uncertain";
  recorder.record({
    // Uncertainty is a warning, not an error: nothing is known to have failed,
    // but a human has to resolve it, and the bundle must make that obvious.
    level: outcome.kind === "verified" ? "info" : "warn",
    category: "verification",
    event: uncertain
      ? EVENTS.sendUncertain
      : outcome.kind === "verified"
        ? EVENTS.sendVerified
        : EVENTS.transactionFailed,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: {
      ...base(context),
      outcome: outcome.kind,
      outgoingCount: outcome.outgoingCount,
      baseline: outcome.baseline,
      delta: outcome.outgoingCount - outcome.baseline,
    },
  });
};

/** Records the terminal outcome of a transaction. */
export const recordTransactionTerminal = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  outcome: {
    readonly kind: "completed" | "uncertain" | "failed";
    readonly reason?: string;
  },
): void => {
  recorder.record({
    level: outcome.kind === "completed" ? "info" : "warn",
    category: "communication",
    event:
      outcome.kind === "completed"
        ? EVENTS.transactionCommitted
        : outcome.kind === "uncertain"
          ? EVENTS.transactionUncertain
          : EVENTS.transactionFailed,
    jobId: context.jobId,
    transactionId: context.transactionId,
    data: { ...base(context), outcome: outcome.kind, reason: outcome.reason ?? null },
  });
};

/** Records the draft check, which decides whether JobPilot may touch the editor. */
export const recordDraftCheck = (
  recorder: DiagnosticRecorder,
  context: TransactionContext,
  present: boolean,
): void => {
  recorder.record({
    level: present ? "warn" : "trace",
    category: "message",
    event: EVENTS.draftChecked,
    jobId: context.jobId,
    transactionId: context.transactionId,
    // The draft's CONTENT is never recorded — only whether it exists.
    data: { ...base(context), draftPresent: present },
  });
};
