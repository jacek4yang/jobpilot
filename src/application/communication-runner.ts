/**
 * Communication runner.
 *
 * Drives one `CommunicationIntent` through the adapter, applying the rules from
 * `docs/product/boss-workflows.md`. This is the only place that is allowed to
 * click send, and it does so at most once per intent.
 *
 * Safety rules enforced here, in order:
 *  1. A block signal (CAPTCHA / risk / login) stops before anything is touched.
 *  2. A message is never written into a non-empty editor.
 *  3. The conversation must match the job's identity before writing.
 *  4. `dispatchSend` is called only when `canClickSend` allows it, and the
 *     adapter enforces the same guard independently.
 *  5. `send-attempted` is persisted BEFORE the click, so a crash cannot lead to
 *     a second send.
 *  6. The outcome is decided by observing an outgoing-message delta. Anything
 *     else is `uncertain`, never success.
 */

import type { CommunicationAction } from "../adapters/boss/communication";
import { type JobIdentity, matchChatIdentity } from "../domain/communication/identity";
import {
  type CommunicationFailure,
  type CommunicationIntent,
  canClickSend,
  reduceIntent,
} from "../domain/communication/intent";
import type { Clock } from "../domain/support/shared";
import type { BlockReason } from "../ports/job-platform";
import type { Logger } from "../ports/logger";

export type CommunicationOutcome =
  | { readonly kind: "sent"; readonly evidence: string }
  /** Nothing was sent and nothing was clicked; safe to retry later. */
  | {
      readonly kind: "aborted";
      readonly failure: CommunicationFailure;
      readonly detail: string;
    }
  /** A send was attempted and the result could not be observed. Needs a human. */
  | { readonly kind: "uncertain"; readonly detail: string }
  | { readonly kind: "blocked"; readonly reason: BlockReason; readonly evidence: string };

export interface CommunicationRunnerDeps {
  readonly action: CommunicationAction;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Persists the intent so a reload cannot lose the point of no return. */
  readonly persistIntent: (intent: CommunicationIntent) => Promise<void>;
  /** Clears the persisted intent once it reaches a terminal phase. */
  readonly clearIntent: () => Promise<void>;
}

export interface RunOptions {
  /** Polling budget for observing the send. */
  readonly observeTimeoutMs?: number;
  readonly observeIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface CommunicationRunner {
  run(intent: CommunicationIntent, options?: RunOptions): Promise<CommunicationOutcome>;
}

const DEFAULT_OBSERVE_TIMEOUT_MS = 10_000;
const DEFAULT_OBSERVE_INTERVAL_MS = 250;

const failureForBlock = (reason: BlockReason): CommunicationFailure => {
  switch (reason) {
    case "captcha":
      return "RISK_CONTROL";
    case "risk-control":
      return "RISK_CONTROL";
    case "login-expired":
      return "LOGIN_REQUIRED";
    case "ambiguous-state":
      return "SEND_UNCERTAIN";
    default:
      return "DOM_CHANGED";
  }
};

export const createCommunicationRunner = (deps: CommunicationRunnerDeps): CommunicationRunner => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const run = async (
    initial: CommunicationIntent,
    options: RunOptions = {},
  ): Promise<CommunicationOutcome> => {
    let intent = initial;
    let attemptStarted = false;

    /** Applies a local transition through the domain reducer, keeping the trail consistent. */
    const transition = async (result: ReturnType<typeof reduceIntent>): Promise<void> => {
      intent = result.intent;
      if (result.diagnostic !== undefined) {
        deps.logger.warn("communication", result.diagnostic, { jobId: intent.jobId });
      }
      await deps.persistIntent(intent);
    };

    // --- 1. Refuse to proceed on a blocked page ---------------------------
    const block = deps.action.detectBlock();
    if (block !== null) {
      deps.logger.warn("communication", "blocked before starting", {
        reason: block.reason,
        evidence: block.evidence,
      });
      return { kind: "blocked", reason: block.reason, evidence: block.evidence };
    }

    // --- 2. The conversation must be the right one ------------------------
    const chat = deps.action.readCurrentChat();
    if (chat === null) {
      return { kind: "aborted", failure: "CHAT_MISMATCH", detail: "no conversation is open" };
    }

    // The transaction starts `armed`, meaning "we have not yet committed to a
    // specific conversation". Reaching a rendered chat is that navigation, so
    // record it before any identity claim is made.
    await transition(reduceIntent(intent, { type: "NAVIGATED" }, { now: deps.clock.now() }));

    const jobIdentity: JobIdentity = {
      ...(intent.expectedJobTitle === undefined ? {} : { title: intent.expectedJobTitle }),
      ...(intent.expectedCompany === undefined ? {} : { company: intent.expectedCompany }),
      ...(intent.expectedRecruiter === undefined ? {} : { recruiter: intent.expectedRecruiter }),
    };

    const identity = matchChatIdentity(jobIdentity, chat);
    if (identity.kind !== "match") {
      // `insufficient` is treated exactly like `mismatch` here: without positive
      // evidence this is not the conversation we were told to write into.
      const detail =
        identity.kind === "mismatch" ? identity.reason : `identity unconfirmed: ${identity.reason}`;
      deps.logger.warn("communication", "conversation identity not confirmed", {
        jobId: intent.jobId,
        verdict: identity.kind,
      });
      return { kind: "aborted", failure: "CHAT_MISMATCH", detail };
    }

    await transition(reduceIntent(intent, { type: "CHAT_VERIFIED" }, { now: deps.clock.now() }));

    // --- 3. Prepare, which refuses to overwrite a draft -------------------
    const prepared = await deps.action.prepareMessage(
      intent,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    switch (prepared.kind) {
      case "blocked":
        return { kind: "blocked", reason: prepared.reason, evidence: prepared.evidence };
      case "draft-present": {
        await transition(
          reduceIntent(
            intent,
            { type: "DRAFT_DETECTED", detail: "the conversation already contains text" },
            { now: deps.clock.now() },
          ),
        );
        await deps.clearIntent();
        return {
          kind: "aborted",
          failure: "DRAFT_PRESENT",
          detail: "an existing draft was left untouched",
        };
      }
      case "chat-mismatch":
        return { kind: "aborted", failure: "CHAT_MISMATCH", detail: prepared.detail };
      case "ready":
        break;
    }

    await transition(reduceIntent(intent, { type: "MESSAGE_PREPARED" }, { now: deps.clock.now() }));

    // --- 4. Dispatch, guarded on both sides ------------------------------
    if (!canClickSend(intent)) {
      // Reaching here would mean `prepareMessage` produced a sendable state
      // without the intent agreeing. Refuse rather than guess.
      deps.logger.error("communication", "refusing to send: intent is not sendable", {
        jobId: intent.jobId,
        phase: intent.phase,
      });
      return { kind: "uncertain", detail: "intent was not in a sendable phase" };
    }

    // Persist `send-attempted` BEFORE the click. If the page reloads between
    // these two statements the transaction is recoverable as uncertain, which
    // is exactly what must happen: the click may or may not have landed.
    await transition(
      reduceIntent(
        intent,
        { type: "SEND_DISPATCHED", now: deps.clock.now() },
        { now: deps.clock.now() },
      ),
    );

    const dispatched = await deps.action.dispatchSend(
      intent,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    attemptStarted = true;

    if (dispatched.kind === "blocked") {
      return { kind: "blocked", reason: dispatched.reason, evidence: dispatched.evidence };
    }
    if (dispatched.kind === "refused") {
      // The adapter's own guard fired. Nothing was clicked, so this is safe to
      // report as uncertain rather than pretending it succeeded.
      deps.logger.warn("communication", "adapter refused the send", {
        jobId: intent.jobId,
        detail: dispatched.detail,
      });
      return { kind: "uncertain", detail: dispatched.detail };
    }

    // --- 5. Verify by observation, never by assumption -------------------
    const baseline = intent.outgoingBaseline;
    const timeoutMs = options.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;
    const intervalMs = options.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS;
    const deadline = deps.clock.now() + timeoutMs;

    while (deps.clock.now() < deadline) {
      if (options.signal?.aborted === true) {
        return { kind: "uncertain", detail: "aborted while waiting for send confirmation" };
      }

      const observed = await deps.action.observeSend(
        intent,
        baseline,
        options.signal === undefined ? {} : { signal: options.signal },
      );

      if (observed.kind === "blocked") {
        return { kind: "blocked", reason: observed.reason, evidence: observed.evidence };
      }
      if (observed.kind === "observed") {
        await transition(
          reduceIntent(
            intent,
            { type: "SEND_OBSERVED", outgoingCount: observed.count },
            { now: deps.clock.now() },
          ),
        );
        await deps.clearIntent();
        return { kind: "sent", evidence: observed.evidence };
      }

      await sleep(intervalMs);
    }

    // Not observed within budget. This is the ambiguous case: report it as
    // uncertain so the user checks, and never retry it automatically.
    await transition(
      reduceIntent(
        intent,
        { type: "SEND_UNOBSERVED", detail: "no outgoing message appeared within the budget" },
        { now: deps.clock.now() },
      ),
    );
    await deps.clearIntent();

    deps.logger.warn("communication", "send outcome could not be confirmed", {
      jobId: intent.jobId,
      attemptStarted,
    });
    return {
      kind: "uncertain",
      detail: "the send click was dispatched but no outgoing message was observed",
    };
  };

  return { run };
};

/** Maps a block reason to the failure code recorded in history. */
export { failureForBlock };
