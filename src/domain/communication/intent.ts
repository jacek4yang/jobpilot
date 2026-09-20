/**
 * Communication transaction.
 *
 * Sending a first message to a recruiter is irreversible. This module models it
 * as a transaction with a persisted intent, so that no reload, timeout or retry
 * can ever cause a second send.
 *
 * The machine is pure: it takes an intent and an event and returns a new intent
 * plus a decision. No DOM, no storage, no clocks except the ones passed in.
 *
 * Critical rule, encoded in `canClickSend`: once an intent reaches
 * `send-attempted`, the send may never be attempted again. The only legal
 * continuations are verification outcomes.
 */
import type { JobId } from "../support/ids";

/**
 * Transaction phases.
 *
 * `send-attempted` is the point of no return. Everything before it is safely
 * abandonable; everything after it must be resolved by observation or by the
 * user, never by retrying.
 */
export type IntentPhase =
  | "armed"
  | "navigating"
  | "chat-verified"
  | "prepared"
  | "send-attempted"
  | "verified"
  | "uncertain"
  | "failed";

/** Phases from which the transaction may still be abandoned without a send. */
export const SAFE_TO_ABANDON: readonly IntentPhase[] = [
  "armed",
  "navigating",
  "chat-verified",
  "prepared",
];

/** Terminal phases. */
export const TERMINAL_PHASES: readonly IntentPhase[] = ["verified", "uncertain", "failed"];

export const isTerminalPhase = (phase: IntentPhase): boolean => TERMINAL_PHASES.includes(phase);

/**
 * True when the message may still be sent.
 *
 * The precondition is `prepared`: the conversation is verified, the message is
 * in the editor, and nothing has been clicked yet. Once the phase advances to
 * `send-attempted` this returns false forever, which is what makes a second
 * send impossible.
 *
 * Callers holding a *post-transition* intent (i.e. the adapter, which the
 * runner hands a `send-attempted` intent) must not use this predicate — see
 * `mayDispatchClick`.
 */
export const canClickSend = (intent: CommunicationIntent): boolean =>
  intent.phase === "prepared" && intent.sendAttemptedAt === undefined;

/**
 * True when a click may still be dispatched for this intent.
 *
 * This is the guard the adapter consults, and it encodes a distinction the
 * phase alone cannot express:
 *
 *  - `sendAttemptedAt` is stamped when the runner records the POINT OF NO
 *    RETURN, which deliberately happens BEFORE the click. Its presence means
 *    "this transaction is committed to a single send", not "a click happened".
 *  - `clickDispatched` is stamped by the adapter at the moment it actually
 *    clicks.
 *
 * So a click is permitted exactly when the transaction is committed
 * (`send-attempted`) and the adapter has not yet clicked. After that it is
 * forbidden forever, including across a reload, because `clickDispatched`
 * survives persistence.
 */
export const mayDispatchClick = (intent: CommunicationIntent): boolean =>
  intent.phase === "send-attempted" &&
  intent.sendAttemptedAt !== undefined &&
  intent.clickDispatched === undefined;

/** Records that the adapter has dispatched the click. */
export const markClickDispatched = (
  intent: CommunicationIntent,
  now: number,
): CommunicationIntent => ({ ...intent, clickDispatched: now });

/** True when this transaction has already had its one permitted click. */
export const hasSendBeenAttempted = (intent: CommunicationIntent): boolean =>
  intent.clickDispatched !== undefined;

/** Why the transaction ended, in the failure taxonomy. */
export type CommunicationFailure =
  | "DOM_CHANGED"
  | "JOB_DISAPPEARED"
  | "ALREADY_CONTACTED"
  | "CHAT_MISMATCH"
  | "DRAFT_PRESENT"
  | "SEND_UNCERTAIN"
  | "RISK_CONTROL"
  | "LOGIN_REQUIRED"
  | "UNKNOWN_MODAL"
  | "USER_INTERRUPTED"
  | "RATE_LIMIT_REACHED"
  | "DAILY_LIMIT_REACHED";

export interface CommunicationIntent {
  readonly id: string;
  readonly jobId: JobId;
  /** Where to return after a successful contact. */
  readonly sourceUrl: string;

  /** Identity expectations, used to confirm we are in the right conversation. */
  readonly expectedJobTitle?: string;
  readonly expectedCompany?: string;
  readonly expectedRecruiter?: string;

  readonly phase: IntentPhase;

  /** The exact text we intend to send. Recorded so post-crash verification works. */
  readonly messageText: string;
  /**
   * Outgoing-message count for `messageText` observed before sending.
   *
   * Without this baseline, "did my message appear?" is unanswerable after a
   * reload, and the transaction would have to guess.
   */
  readonly outgoingBaseline: number;

  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Set when the runner commits to sending — BEFORE the click is dispatched.
   * Its presence marks the point of no return, not the click itself.
   */
  readonly sendAttemptedAt?: number;
  /**
   * Set by the adapter at the instant it dispatches the click.
   *
   * Distinct from `sendAttemptedAt` on purpose: the runner commits before
   * clicking, so only this field proves a click actually happened. It is what
   * makes "never click twice" enforceable across a reload.
   */
  readonly clickDispatched?: number;
  /** Populated on a failed or uncertain termination. */
  readonly failure?: CommunicationFailure;
  /** Explanation shown to the user, e.g. the mismatch that was detected. */
  readonly detail?: string;
}

export interface CreateIntentInput {
  readonly id: string;
  readonly jobId: JobId;
  readonly sourceUrl: string;
  readonly messageText: string;
  readonly outgoingBaseline: number;
  readonly now: number;
  readonly ttlMs: number;
  readonly expectedJobTitle?: string;
  readonly expectedCompany?: string;
  readonly expectedRecruiter?: string;
}

export const createIntent = (input: CreateIntentInput): CommunicationIntent => ({
  id: input.id,
  jobId: input.jobId,
  sourceUrl: input.sourceUrl,
  phase: "armed",
  messageText: input.messageText,
  outgoingBaseline: input.outgoingBaseline,
  createdAt: input.now,
  expiresAt: input.now + input.ttlMs,
  ...(input.expectedJobTitle === undefined ? {} : { expectedJobTitle: input.expectedJobTitle }),
  ...(input.expectedCompany === undefined ? {} : { expectedCompany: input.expectedCompany }),
  ...(input.expectedRecruiter === undefined ? {} : { expectedRecruiter: input.expectedRecruiter }),
});

/** Events that drive the transaction forward. */
export type IntentEvent =
  | { readonly type: "NAVIGATED" }
  | { readonly type: "CHAT_VERIFIED" }
  | { readonly type: "DRAFT_DETECTED"; readonly detail: string }
  | { readonly type: "MESSAGE_PREPARED" }
  | { readonly type: "SEND_DISPATCHED"; readonly now: number }
  | { readonly type: "SEND_OBSERVED"; readonly outgoingCount: number }
  | { readonly type: "SEND_UNOBSERVED"; readonly detail: string }
  | { readonly type: "CHAT_CHANGED"; readonly detail: string }
  | { readonly type: "ABORTED"; readonly failure: CommunicationFailure; readonly detail: string }
  | { readonly type: "EXPIRED" };

export interface IntentTransition {
  readonly intent: CommunicationIntent;
  /** True when the caller must stop the queue rather than continue silently. */
  readonly requiresUserAction: boolean;
  /** Set when the transition should surface a diagnostic. */
  readonly diagnostic?: string;
}

const withFailure = (
  intent: CommunicationIntent,
  failure: CommunicationFailure,
  detail: string,
): CommunicationIntent => ({ ...intent, phase: "failed", failure, detail });

/**
 * Advances the transaction.
 *
 * Illegal events are ignored (the intent is returned unchanged) rather than
 * throwing: a late async callback from a previous phase must never be able to
 * push a completed transaction backwards.
 */
export const reduceIntent = (
  intent: CommunicationIntent,
  event: IntentEvent,
  options: { readonly now: number },
): IntentTransition => {
  const unchanged: IntentTransition = { intent, requiresUserAction: false };

  // A terminal transaction accepts no further events.
  if (isTerminalPhase(intent.phase)) return unchanged;

  switch (event.type) {
    case "NAVIGATED": {
      if (intent.phase !== "armed") return unchanged;
      return { intent: { ...intent, phase: "navigating" }, requiresUserAction: false };
    }

    case "CHAT_VERIFIED": {
      if (intent.phase !== "navigating") return unchanged;
      return { intent: { ...intent, phase: "chat-verified" }, requiresUserAction: false };
    }

    case "DRAFT_DETECTED": {
      // User content always wins. Stop this item and ask the user.
      return {
        intent: withFailure(intent, "DRAFT_PRESENT", event.detail),
        requiresUserAction: true,
        diagnostic: "draft present in conversation; automation did not touch it",
      };
    }

    case "MESSAGE_PREPARED": {
      if (intent.phase !== "chat-verified") return unchanged;
      return { intent: { ...intent, phase: "prepared" }, requiresUserAction: false };
    }

    case "SEND_DISPATCHED": {
      // Only legal from `prepared`, and only once.
      if (!canClickSend(intent)) {
        return {
          intent,
          requiresUserAction: false,
          diagnostic: "send dispatch refused: transaction is not sendable",
        };
      }
      return {
        intent: { ...intent, phase: "send-attempted", sendAttemptedAt: event.now },
        requiresUserAction: false,
      };
    }

    case "SEND_OBSERVED": {
      if (intent.phase !== "send-attempted") return unchanged;
      const observed = event.outgoingCount > intent.outgoingBaseline;
      if (observed) {
        return { intent: { ...intent, phase: "verified" }, requiresUserAction: false };
      }
      // The click produced no visible message. This is NOT a safe retry: the
      // click may have registered and rendered differently, or the count may
      // be stale. Never auto-retry; hand it to the user.
      return {
        intent: {
          ...intent,
          phase: "uncertain",
          failure: "SEND_UNCERTAIN",
          detail: "no outgoing message observed after the send click",
        },
        requiresUserAction: true,
        diagnostic: "send outcome unobservable; will not retry",
      };
    }

    case "SEND_UNOBSERVED": {
      if (intent.phase !== "send-attempted") return unchanged;
      return {
        intent: {
          ...intent,
          phase: "uncertain",
          failure: "SEND_UNCERTAIN",
          detail: event.detail,
        },
        requiresUserAction: true,
        diagnostic: "send outcome unobservable; will not retry",
      };
    }

    case "CHAT_CHANGED": {
      // The conversation changed underneath us.
      if (intent.phase === "send-attempted") {
        return {
          intent: {
            ...intent,
            phase: "uncertain",
            failure: "CHAT_MISMATCH",
            detail: event.detail,
          },
          requiresUserAction: true,
        };
      }
      return {
        intent: withFailure(intent, "CHAT_MISMATCH", event.detail),
        requiresUserAction: true,
      };
    }

    case "ABORTED": {
      return {
        intent: withFailure(intent, event.failure, event.detail),
        requiresUserAction: true,
      };
    }

    case "EXPIRED": {
      if (options.now < intent.expiresAt) return unchanged;
      // Expiry before a send is harmless; after a send it is never "failed".
      if (intent.phase === "send-attempted") {
        return {
          intent: {
            ...intent,
            phase: "uncertain",
            failure: "SEND_UNCERTAIN",
            detail: "transaction expired after the send click",
          },
          requiresUserAction: true,
        };
      }
      return {
        intent: withFailure(intent, "USER_INTERRUPTED", "transaction expired before sending"),
        requiresUserAction: false,
      };
    }

    default: {
      // Exhaustiveness guard: adding an event without handling it is a
      // compile-time error here.
      const exhaustive: never = event;
      return { intent: exhaustive, requiresUserAction: false };
    }
  }
};

/** Plain snapshot for persistence. */
export const serializeIntent = (intent: CommunicationIntent): Record<string, unknown> => ({
  id: intent.id,
  jobId: intent.jobId,
  sourceUrl: intent.sourceUrl,
  phase: intent.phase,
  messageText: intent.messageText,
  outgoingBaseline: intent.outgoingBaseline,
  createdAt: intent.createdAt,
  expiresAt: intent.expiresAt,
  ...(intent.expectedJobTitle === undefined ? {} : { expectedJobTitle: intent.expectedJobTitle }),
  ...(intent.expectedCompany === undefined ? {} : { expectedCompany: intent.expectedCompany }),
  ...(intent.expectedRecruiter === undefined
    ? {}
    : { expectedRecruiter: intent.expectedRecruiter }),
  ...(intent.sendAttemptedAt === undefined ? {} : { sendAttemptedAt: intent.sendAttemptedAt }),
  ...(intent.clickDispatched === undefined ? {} : { clickDispatched: intent.clickDispatched }),
  ...(intent.failure === undefined ? {} : { failure: intent.failure }),
  ...(intent.detail === undefined ? {} : { detail: intent.detail }),
});

const PHASE_SET: ReadonlySet<string> = new Set([
  "armed",
  "navigating",
  "chat-verified",
  "prepared",
  "send-attempted",
  "verified",
  "uncertain",
  "failed",
]);

/**
 * Rehydrates an intent from untrusted persisted JSON.
 *
 * Returns `undefined` rather than a best-effort object when the record is
 * malformed. A corrupt intent must never be able to authorise a send, and an
 * intent that claims `send-attempted` must survive reload intact — so anything
 * unparseable is discarded and the job is treated as un-contacted, which errs
 * toward asking the user.
 */
export const deserializeIntent = (input: unknown): CommunicationIntent | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;

  const id = raw["id"];
  const jobId = raw["jobId"];
  const sourceUrl = raw["sourceUrl"];
  const phase = raw["phase"];
  const messageText = raw["messageText"];
  const outgoingBaseline = raw["outgoingBaseline"];
  const createdAt = raw["createdAt"];
  const expiresAt = raw["expiresAt"];

  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof jobId !== "string" || jobId.length === 0) return undefined;
  if (typeof sourceUrl !== "string") return undefined;
  if (typeof phase !== "string" || !PHASE_SET.has(phase)) return undefined;
  if (typeof messageText !== "string") return undefined;
  if (typeof outgoingBaseline !== "number" || !Number.isFinite(outgoingBaseline)) return undefined;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;

  const sendAttemptedAt = raw["sendAttemptedAt"];
  const clickDispatched = raw["clickDispatched"];
  const expectedJobTitle = raw["expectedJobTitle"];
  const expectedCompany = raw["expectedCompany"];
  const expectedRecruiter = raw["expectedRecruiter"];
  const failure = raw["failure"];
  const detail = raw["detail"];

  return {
    id,
    jobId: jobId as JobId,
    sourceUrl,
    phase: phase as IntentPhase,
    messageText,
    outgoingBaseline,
    createdAt,
    expiresAt,
    ...(typeof expectedJobTitle === "string" ? { expectedJobTitle } : {}),
    ...(typeof expectedCompany === "string" ? { expectedCompany } : {}),
    ...(typeof expectedRecruiter === "string" ? { expectedRecruiter } : {}),
    ...(typeof sendAttemptedAt === "number" && Number.isFinite(sendAttemptedAt)
      ? { sendAttemptedAt }
      : {}),
    ...(typeof clickDispatched === "number" && Number.isFinite(clickDispatched)
      ? { clickDispatched }
      : {}),
    ...(typeof failure === "string" ? { failure: failure as CommunicationFailure } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
};
