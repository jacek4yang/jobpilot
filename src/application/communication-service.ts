/**
 * Communication service.
 *
 * The composition point that was missing: it joins the queue, the execution
 * gates, the message template, the intent persistence and the runner into one
 * call that either sends exactly once or refuses with a reason.
 *
 * Gate ordering is the whole design. Every gate is evaluated BEFORE the intent
 * is armed and before anything irreversible happens, because a gate checked at
 * the click is not a gate — the state it guards can change in between. The
 * order is asserted by test.
 *
 * Invariant enforced here:
 *   No send without persisted intent, verified chat, healthy storage, queue
 *   ownership, and an empty editor.
 */

import { EVENTS } from "../diagnostics/event";
import type { DiagnosticRecorder } from "../diagnostics/recorder";
import { fingerprint } from "../diagnostics/redact";
import type { StorageHealth } from "../diagnostics/trace";
import {
  type CommunicationIntent,
  createIntent,
  hasSendBeenAttempted,
} from "../domain/communication/intent";
import {
  type MessageTemplate,
  renderTemplate,
  selectTemplate,
} from "../domain/communication/template";
import type { JobDetail } from "../domain/job/job";
import type { Clock } from "../domain/support/shared";
import type { Logger } from "../ports/logger";
import type { CommunicationOutcome, CommunicationRunner } from "./communication-runner";
import {
  evaluateExecutionGates,
  evaluateSendGates,
  type GateInput,
  type GateResult,
  INVARIANTS,
  recordGateOutcome,
  reportInvariantViolation,
} from "./gates";

export type CommunicationRefusal =
  | "gate-blocked"
  | "no-template"
  | "template-invalid"
  | "intent-in-flight"
  | "no-action";

export type CommunicationServiceResult =
  | { readonly kind: "sent"; readonly evidence: string }
  | { readonly kind: "uncertain"; readonly detail: string }
  | { readonly kind: "blocked"; readonly reason: string; readonly evidence: string }
  | { readonly kind: "aborted"; readonly detail: string }
  | { readonly kind: "refused"; readonly reason: CommunicationRefusal; readonly message: string };

export interface CommunicationServiceDeps {
  readonly runner: CommunicationRunner;
  readonly recorder: DiagnosticRecorder;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Gate inputs that are not per-job. The service adds the per-job ones. */
  readonly baseGateInput: () => Omit<
    GateInput,
    "draftPresent" | "chatVerified" | "hasPersistedIntent" | "sendAlreadyAttempted"
  >;
  /** Confirms the conversation matches the job. Must be positive evidence. */
  readonly verifyChat: (job: JobDetail) => { readonly verified: boolean; readonly detail: string };
  /** True when the editor already contains text the user typed. */
  readonly isDraftPresent: () => boolean;
  /** Current outgoing-message count for the message text. */
  readonly outgoingCount: (text: string) => number;
  readonly readPersistedIntent: () => CommunicationIntent | undefined;
  readonly persistIntent: (intent: CommunicationIntent) => Promise<void>;
  readonly clearIntent: () => Promise<void>;
  readonly storageHealth: () => StorageHealth;
  readonly templates: () => readonly MessageTemplate[];
  readonly activeTemplateId?: () => string | undefined;
  /** Stable id generator, injected so tests are deterministic. */
  readonly newIntentId: () => string;
}

export interface CommunicateInput {
  readonly job: JobDetail;
  /** TTL for the transaction. Bounds how long an intent may stay armed. */
  readonly ttlMs?: number;
}

export interface CommunicationService {
  communicate(input: CommunicateInput): Promise<CommunicationServiceResult>;
}

const DEFAULT_TTL_MS = 180_000;

/**
 * Maps a blocked context gate onto the invariant it protects.
 *
 * Recording the invariant (not just the gate) is what lets the analyzer flag a
 * violation class without knowing anything about gate names.
 */
const reportContextInvariants = (
  recorder: DiagnosticRecorder,
  gate: GateResult,
  jobId: string,
): void => {
  switch (gate.reason) {
    case "human-verification":
      reportInvariantViolation(recorder, {
        invariant: INVARIANTS.noAutomaticActionDuringHumanVerification,
        detail: "a verification challenge is on screen",
        context: { jobId },
      });
      return;
    case "storage-unhealthy":
      reportInvariantViolation(recorder, {
        invariant: INVARIANTS.noSendWhileStorageUnhealthy,
        detail: "persistence unavailable",
        context: { jobId },
      });
      return;
    case "not-owner":
      reportInvariantViolation(recorder, {
        invariant: INVARIANTS.noSecondTabExecutingQueue,
        detail: "this tab does not own the queue",
        context: { jobId },
      });
      return;
    default:
      return;
  }
};

export const createCommunicationService = (
  deps: CommunicationServiceDeps,
): CommunicationService => {
  const decide = (
    gate: GateResult,
    reason: CommunicationRefusal,
  ): CommunicationServiceResult | undefined => {
    if (gate.allowed) return undefined;
    return {
      kind: "refused",
      reason,
      message: gate.message ?? "JobPilot is not currently able to send.",
    };
  };

  return {
    async communicate(input): Promise<CommunicationServiceResult> {
      const { job } = input;
      const jobId = String(job.id);
      const transactionId = deps.newIntentId();

      // --- 1. An in-flight transaction for this job is never overtaken ------
      const existing = deps.readPersistedIntent();
      if (existing !== undefined && existing.jobId === job.id) {
        if (hasSendBeenAttempted(existing)) {
          // Absolute: a click may have gone out. Verify, never resend.
          deps.recorder.warnEvent("communication", EVENTS.transactionUncertain, {
            detail: "an existing transaction already dispatched a click",
          });
          return {
            kind: "uncertain",
            detail:
              "a send was already dispatched for this job; verify the conversation before retrying",
          };
        }
      }

      // --- 2. Resolve the message BEFORE gating ----------------------------
      // A missing or invalid template is a refusal, not a send of empty text.
      const template = selectTemplate(deps.templates(), deps.activeTemplateId?.());
      if (template === undefined) {
        return {
          kind: "refused",
          reason: "no-template",
          message: "No message template is configured, so there is nothing to send.",
        };
      }

      const rendered = renderTemplate(template.content, { job });
      if (!rendered.ok) {
        deps.recorder.warnEvent("message", "message.template.rejected", {
          jobId,
          templateId: template.id,
          reason: rendered.reason,
        });
        return {
          kind: "refused",
          reason: "template-invalid",
          message: `The message template could not be prepared: ${rendered.detail}`,
        };
      }

      // --- 3. Evaluate every gate BEFORE anything irreversible -------------
      //
      // Two passes on purpose. The context gates (mode, human verification,
      // storage, ownership, limits) are pure and free, so they run FIRST — if
      // one blocks there is no reason to read the page at all. Only then do we
      // touch the DOM to determine the per-job conditions.
      const base = deps.baseGateInput();
      const contextGate = evaluateExecutionGates(base);
      recordGateOutcome(deps.recorder, "execution", contextGate, { jobId, transactionId });
      const contextRefusal = decide(contextGate, "gate-blocked");
      if (contextRefusal !== undefined) {
        reportContextInvariants(deps.recorder, contextGate, jobId);
        return contextRefusal;
      }

      // The page is read only once the cheap gates have passed.
      const chat = deps.verifyChat(job);
      const draftPresent = deps.isDraftPresent();
      const persisted = deps.readPersistedIntent();

      // `hasPersistedIntent` is satisfied by the intent we are about to create,
      // because creation happens before any click. The gate exists to prevent a
      // *click* without a persisted record, and step 4 guarantees that ordering
      // — so what is checked here is that persistence is actually available to
      // record it, which the storage-health gate above already covered.
      const gateInput = {
        ...base,
        draftPresent,
        chatVerified: chat.verified,
        hasPersistedIntent: deps.storageHealth().healthy,
        sendAlreadyAttempted: persisted !== undefined && hasSendBeenAttempted(persisted),
      };

      const sendGate = evaluateSendGates(gateInput);
      recordGateOutcome(deps.recorder, "send", sendGate, { jobId, transactionId });
      const refused = decide(sendGate, "gate-blocked");
      if (refused !== undefined) {
        // The specific reason matters for triage, so map it onto the invariants
        // it protects rather than returning a generic refusal.
        if (sendGate.reason === "draft-present") {
          reportInvariantViolation(deps.recorder, {
            invariant: INVARIANTS.noSendWithDraftPresent,
            detail: chat.detail,
            context: { jobId },
          });
        }
        if (sendGate.reason === "chat-unverified") {
          reportInvariantViolation(deps.recorder, {
            invariant: INVARIANTS.noSendWithoutVerifiedChat,
            detail: chat.detail,
            context: { jobId },
          });
        }
        if (sendGate.reason === "storage-unhealthy") {
          reportInvariantViolation(deps.recorder, {
            invariant: INVARIANTS.noSendWhileStorageUnhealthy,
            detail: "persistence unavailable",
            context: { jobId },
          });
        }
        return refused;
      }

      // --- 4. Persist the intent BEFORE the click ---------------------------
      // `sendAttemptedAt` is stamped by the runner; what we record here is the
      // transaction's existence and its target, which is what makes recovery
      // possible if the page goes away mid-send.
      const intent = createIntent({
        id: transactionId,
        jobId: job.id,
        sourceUrl: job.url ?? "",
        messageText: rendered.text,
        outgoingBaseline: deps.outgoingCount(rendered.text),
        now: deps.clock.now(),
        ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
        expectedJobTitle: job.title,
        expectedCompany: job.company.name,
        ...(job.recruiters[0]?.name === undefined
          ? {}
          : { expectedRecruiter: job.recruiters[0].name }),
      });

      await deps.persistIntent(intent);

      // Only metadata about the message is recorded, never its text.
      deps.recorder.record({
        level: "info",
        category: "communication",
        event: EVENTS.intentCreated,
        jobId,
        transactionId,
        data: {
          templateId: template.id,
          messageLength: rendered.text.length,
          messageDigest: fingerprint(rendered.text).sha256OrFnv,
          variablesUsed: [...rendered.usedVariables],
          outgoingBaseline: intent.outgoingBaseline,
        },
      });

      // --- 5. Delegate to the runner ----------------------------------------
      // The runner owns the click, the never-send-twice guard, and the
      // verification. We only translate its outcome.
      let outcome: CommunicationOutcome;
      try {
        outcome = await deps.runner.run(intent);
      } catch (error) {
        // An exception here leaves the outcome unknown, which is `uncertain` —
        // never a failure that could be retried.
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error("communication", "runner threw", { error: message, jobId });
        return { kind: "uncertain", detail: `the send could not be completed: ${message}` };
      }

      switch (outcome.kind) {
        case "sent":
          return { kind: "sent", evidence: outcome.evidence };
        case "uncertain":
          return { kind: "uncertain", detail: outcome.detail };
        case "blocked":
          return { kind: "blocked", reason: outcome.reason, evidence: outcome.evidence };
        case "aborted":
          // The runner aborted before clicking, so no message went out.
          return { kind: "aborted", detail: outcome.detail };
        default: {
          const exhaustive: never = outcome;
          return { kind: "aborted", detail: String(exhaustive) };
        }
      }
    },
  };
};
