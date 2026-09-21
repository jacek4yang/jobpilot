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
 *  4. The persisted intent is consulted first, so a caller replaying a stale
 *     in-memory intent cannot cause a second click.
 *  5. `send-attempted` is persisted BEFORE the click (the point of no return),
 *     and `clickDispatched` is persisted immediately AFTER it. The first makes
 *     a crash recoverable; the second makes a repeat click impossible.
 *  6. The adapter independently refuses any dispatch when a click is already
 *     recorded.
 *  7. The outcome is decided by observing an outgoing-message delta. Anything
 *     else is `uncertain`, never success.
 */

import type { CommunicationAction } from "../adapters/boss/communication";
import { type JobIdentity, matchChatIdentity } from "../domain/communication/identity";
import {
  type CommunicationFailure,
  type CommunicationIntent,
  canClickSend,
  isSendCommitted,
  markClickDispatched,
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
  /**
   * Reads back the persisted intent, when one exists.
   *
   * This is what makes the guard durable. A caller can hand us a stale
   * in-memory intent — one captured before an earlier attempt — and without
   * consulting the record of record we would happily click again. The persisted
   * intent is the only thing that survives a reload, so it wins.
   */
  readonly readPersistedIntent?: () => Promise<CommunicationIntent | undefined>;
}

export interface RunOptions {
  /** Polling budget for observing the send. */
  readonly observeTimeoutMs?: number;
  readonly observeIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Recovery mode: observe an existing attempt and never navigate, type or click. */
  readonly verificationOnly?: boolean;
  /**
   * Final application-level authorization, evaluated after the intended chat
   * and empty editor have been proven, but immediately before the durable
   * send boundary. A fresh run without this callback fails closed.
   */
  readonly authorizeSend?: (
    intent: CommunicationIntent,
  ) => Promise<{ readonly allowed: boolean; readonly detail: string }>;
  readonly onIdentityChecked?: (details: {
    readonly verdict: "match" | "mismatch" | "insufficient";
    readonly detail: string;
  }) => void;
  readonly onDraftChecked?: (present: boolean) => void;
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
  const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

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

    // --- 2. The persisted record wins over the caller's in-memory copy ----
    // A caller may hand us an intent it captured before a previous attempt. If
    // the durable record shows the click already went out, refuse immediately:
    // that is the entire point of persisting the transaction.
    if (deps.readPersistedIntent !== undefined) {
      const persisted = await deps.readPersistedIntent();
      if (persisted !== undefined && persisted.id === initial.id) {
        if (isSendCommitted(persisted) && options.verificationOnly !== true) {
          deps.logger.warn("communication", "refusing to run: this send is already committed", {
            jobId: initial.jobId,
            clickDispatched: persisted.clickDispatched ?? null,
          });
          return {
            kind: "uncertain",
            detail:
              "a send was already dispatched for this transaction; verify the conversation before retrying",
          };
        }
        // Adopt the durable phase so this run can never regress it.
        intent = persisted;
      }
    }

    // --- 3. Navigate to the selected job's chat, then verify identity ------
    // Recovery is observation-only: it must not click even a contact control.
    const chat =
      options.verificationOnly === true
        ? deps.action.readCurrentChat()
        : await deps.action
            .openConversation(
              intent,
              options.signal === undefined ? {} : { signal: options.signal },
            )
            .then((opened) => {
              switch (opened.kind) {
                case "ready":
                  return opened.identity;
                case "blocked":
                  return opened;
                case "chat-mismatch":
                  return {
                    kind: "aborted" as const,
                    failure: "CHAT_MISMATCH" as const,
                    detail: opened.detail,
                  };
              }
            });
    if (chat === null) {
      return { kind: "aborted", failure: "CHAT_MISMATCH", detail: "no conversation is open" };
    }
    if ("kind" in chat) {
      if (chat.kind === "blocked") {
        return { kind: "blocked", reason: chat.reason, evidence: chat.evidence };
      }
      return chat;
    }

    // The transaction starts `armed`, meaning "we have not yet committed to a
    // specific conversation". Reaching a rendered chat is that navigation, so
    // record it before any identity claim is made.
    await transition(reduceIntent(intent, { type: "NAVIGATED" }, { now: deps.clock.now() }));

    const jobIdentity: JobIdentity = {
      // The job id is the authoritative signal and MUST be passed. Without it
      // `matchChatIdentity` falls back to title+company, which would accept a
      // different posting at the same company — precisely the conflation the
      // identity rules forbid.
      jobId: intent.jobId,
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
      options.onIdentityChecked?.({ verdict: identity.kind, detail });
      return { kind: "aborted", failure: "CHAT_MISMATCH", detail };
    }

    options.onIdentityChecked?.({ verdict: "match", detail: identity.evidence.join(", ") });

    await transition(reduceIntent(intent, { type: "CHAT_VERIFIED" }, { now: deps.clock.now() }));

    // Establish the baseline only after the intended chat is positively
    // identified. Counting on the detail page would miss older identical
    // messages and could turn a no-op click into a false success.
    if (options.verificationOnly !== true) {
      intent = { ...intent, outgoingBaseline: deps.action.outgoingCount(intent.messageText) };
      await deps.persistIntent(intent);
    }

    if (options.verificationOnly === true && !isSendCommitted(intent)) {
      return {
        kind: "aborted",
        failure: "USER_INTERRUPTED",
        detail: "the recovered transaction never reached the send boundary",
      };
    }

    if (options.verificationOnly === true) {
      const observed = await deps.action.observeSend(
        intent,
        intent.outgoingBaseline,
        options.signal === undefined ? {} : { signal: options.signal },
      );
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
      if (observed.kind === "blocked") {
        return { kind: "blocked", reason: observed.reason, evidence: observed.evidence };
      }
      return { kind: "uncertain", detail: observed.detail };
    }

    // --- 3. Prepare, which refuses to overwrite a draft -------------------
    const prepared = await deps.action.prepareMessage(
      intent,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    switch (prepared.kind) {
      case "blocked":
        return { kind: "blocked", reason: prepared.reason, evidence: prepared.evidence };
      case "draft-present": {
        options.onDraftChecked?.(true);
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
        options.onDraftChecked?.(false);
        break;
    }

    await transition(reduceIntent(intent, { type: "MESSAGE_PREPARED" }, { now: deps.clock.now() }));

    // The service owns context gates (storage, ownership, limits). They must be
    // evaluated here, not before navigation: the current conversation and
    // editor only become knowable after openConversation/prepareMessage, while
    // ownership or storage health may change during that navigation.
    if (options.authorizeSend === undefined) {
      return {
        kind: "aborted",
        failure: "USER_INTERRUPTED",
        detail: "send authorization was not provided",
      };
    }
    const authorization = await options.authorizeSend(intent);
    if (!authorization.allowed) {
      return {
        kind: "aborted",
        failure: "USER_INTERRUPTED",
        detail: authorization.detail,
      };
    }

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
    if (dispatched.kind === "dispatched") {
      // Record the click itself, now that it actually happened. This is what
      // makes a second click impossible even for a caller holding a stale
      // in-memory intent, and it survives persistence.
      intent = markClickDispatched(intent, deps.clock.now());
      await deps.persistIntent(intent);
      attemptStarted = true;
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

    // Bound the loop two ways. The iteration cap is what actually guarantees
    // termination: a wall-clock condition alone is unsafe here, because the
    // clock is injected and nothing forces it to advance (a frozen or coarse
    // clock would spin this loop forever, which is the unbounded-retry
    // behaviour this project must never have).
    const maxIterations = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
    const deadline = deps.clock.now() + timeoutMs;
    let iterations = 0;

    while (iterations < maxIterations && deps.clock.now() < deadline) {
      iterations += 1;
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

      const completed = await sleep(intervalMs, options.signal);
      if (!completed) {
        await transition(
          reduceIntent(
            intent,
            { type: "SEND_UNOBSERVED", detail: "verification was cancelled after send" },
            { now: deps.clock.now() },
          ),
        );
        return { kind: "uncertain", detail: "verification was cancelled after send" };
      }
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
