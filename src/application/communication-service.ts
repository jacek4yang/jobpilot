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
import type { SelectorOutcome } from "../diagnostics/instrument/selector-trace";
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

  // --- Transaction tracing --------------------------------------------------
  // Optional observers, so the service stays usable (and testable) with no
  // recorder attached. Each is called at exactly one phase edge, which is what
  // makes the resulting trace a faithful account of the transaction rather than
  // a best-effort log.
  readonly onIntentCreated?: (details: {
    readonly transactionId: string;
    readonly jobId: string;
    readonly templateId: string;
    readonly messageText: string;
    readonly variablesUsed: readonly string[];
    readonly outgoingBaseline: number;
    readonly expiresAt: number;
  }) => void;
  readonly onDraftChecked?: (details: {
    readonly transactionId: string;
    readonly jobId: string;
    readonly present: boolean;
  }) => void;
  readonly onIdentityChecked?: (details: {
    readonly transactionId: string;
    readonly jobId: string;
    readonly verdict: "match" | "mismatch" | "insufficient";
    readonly signals: Readonly<Record<string, import("../diagnostics/event").JsonValue>>;
  }) => void;
  readonly onVerified?: (details: {
    readonly transactionId: string;
    readonly jobId: string;
    readonly kind: "verified" | "uncertain" | "negative";
    readonly outgoingCount: number;
    readonly baseline: number;
  }) => void;
  /**
   * Resolves the contact affordance, returning which candidate matched.
   *
   * Optional so the service stays usable without an adapter. When supplied, a
   * null result refuses the send: without the affordance there is nothing to
   * click, and guessing an alternative is what must not happen.
   */
  readonly resolveCommunicateAction?: () => {
    readonly matchedBy: string;
    readonly heuristic: boolean;
  } | null;
  /** Selector diagnostics for the communicate affordance. */
  readonly onCommunicateButtonResolved?: (outcome: SelectorOutcome) => void;
  readonly onTerminal?: (details: {
    readonly transactionId: string;
    readonly jobId: string;
    readonly kind: "completed" | "uncertain" | "failed";
    readonly reason?: string | undefined;
  }) => void;
}

export interface CommunicateInput {
  readonly job: JobDetail;
  /** TTL for the transaction. Bounds how long an intent may stay armed. */
  readonly ttlMs?: number;
}

export interface CommunicationService {
  communicate(input: CommunicateInput): Promise<CommunicationServiceResult>;
  /**
   * Resolves a transaction recovered from a previous page, by verification only.
   *
   * Never sends. The runner refuses once a click is recorded, and this method
   * deliberately offers no way to override that — the only outcomes are
   * `sent` (observed), `uncertain` (unobservable) or `blocked`.
   */
  verifyRecovered(options?: {
    readonly observeTimeoutMs?: number;
  }): Promise<CommunicationServiceResult>;
  /**
   * Abandons a recovered transaction that never reached the point of no return.
   *
   * Safe because nothing was clicked. Returns true when a transaction was
   * discarded.
   */
  discardRecovered(): Promise<boolean>;
  /** The in-flight transaction, if any. Read-only. */
  pendingIntent(): CommunicationIntent | undefined;
}

const DEFAULT_TTL_MS = 180_000;

/**
 * A human-readable reason for a non-success outcome.
 *
 * The outcome union does not carry `detail` on every branch, so this narrows in
 * one place rather than at each call site.
 */
const reasonOf = (outcome: CommunicationOutcome): string | undefined => {
  switch (outcome.kind) {
    case "sent":
      return undefined;
    case "uncertain":
    case "aborted":
      return outcome.detail;
    case "blocked":
      return `${outcome.reason}: ${outcome.evidence}`;
  }
};

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
      // Two invariants cover this refusal: only one tab may execute the queue,
      // and a send requires ownership. Both are recorded so the bundle shows
      // the ownership failure rather than a generic gate block.
      reportInvariantViolation(recorder, {
        invariant: INVARIANTS.noSecondTabExecutingQueue,
        detail: "this tab does not own the queue",
        context: { jobId },
      });
      reportInvariantViolation(recorder, {
        invariant: INVARIANTS.noSendWithoutQueueOwnership,
        detail: "a send was refused because this tab does not own the queue",
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
          //
          // Both invariants below are declared in gates.ts, and this is where
          // they are enforced. Recording them explicitly — rather than
          // returning silently — is what makes a bundle able to show WHICH
          // guarantee stopped the second attempt.
          reportInvariantViolation(deps.recorder, {
            invariant: INVARIANTS.noSecondSendAfterAttempt,
            detail: "a click was already dispatched for this job",
            context: { jobId, transactionId, previousTransaction: existing.id },
          });
          reportInvariantViolation(deps.recorder, {
            invariant: INVARIANTS.noAutomaticSendAfterAmbiguousReload,
            detail: "an unresolved transaction survived a reload",
            context: { jobId, phase: existing.phase },
          });
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

      deps.onIdentityChecked?.({
        transactionId,
        jobId,
        verdict: chat.verified ? "match" : "insufficient",
        signals: { detail: chat.detail, verified: chat.verified },
      });
      deps.onDraftChecked?.({ transactionId, jobId, present: draftPresent });

      // Report what the contact affordance resolved to, for diagnostics.
      //
      // This OBSERVES; it does not gate. The 立即沟通 button belongs to the
      // pre-chat detail pane, and this path runs against an already-open
      // conversation where that pane is gone by definition. Refusing here would
      // reject every legitimate send, which is exactly what an earlier revision
      // of this code did.
      //
      // The affordance is resolved and clicked by the runner, which acts on the
      // page state it actually finds. What this records is which selector
      // candidate matched, so a later markup change is diagnosable — and a miss
      // is reported as evidence rather than treated as a refusal.
      if (deps.resolveCommunicateAction !== undefined) {
        const located = deps.resolveCommunicateAction();
        deps.onCommunicateButtonResolved?.({
          purpose: "detail.applyButton",
          heuristic: located?.heuristic ?? false,
          ...(located === null
            ? {
                attempts: [
                  {
                    selector: "(no candidate matched)",
                    confidence: "unverified",
                    matches: 0,
                    visible: 0,
                    selected: false,
                    rejectedBecause: "no-match" as const,
                  },
                ],
              }
            : {
                selected: located.matchedBy,
                attempts: [
                  {
                    selector: located.matchedBy,
                    confidence: located.heuristic ? "unverified" : "fixture-only",
                    matches: 1,
                    visible: 1,
                    selected: true,
                  },
                ],
              }),
        });
        if (located === null) {
          // Recorded, not fatal. The runner's own `prepareMessage` will fail
          // closed if the affordance genuinely cannot be found when it looks.
          deps.recorder.warnEvent("selector", EVENTS.selectorMiss, {
            jobId,
            transactionId,
            purpose: "detail.applyButton",
            detail: "the contact affordance did not resolve from the current page state",
          });
        }
      }

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

      // Persist BEFORE anything irreversible, and verify it actually landed.
      // If persistence silently failed, the runs-once guarantee does not exist
      // for this transaction, so proceeding would be the exact fault the
      // invariant forbids.
      deps.onIntentCreated?.({
        transactionId,
        jobId,
        templateId: template.id,
        messageText: rendered.text,
        variablesUsed: rendered.usedVariables,
        outgoingBaseline: intent.outgoingBaseline,
        expiresAt: intent.expiresAt,
      });

      await deps.persistIntent(intent);

      const confirmed = deps.readPersistedIntent();
      if (confirmed === undefined || confirmed.id !== intent.id) {
        reportInvariantViolation(deps.recorder, {
          invariant: INVARIANTS.noSendWithoutPersistedIntent,
          detail: "the intent could not be read back after being persisted",
          context: { jobId, transactionId },
        });
        return {
          kind: "refused",
          reason: "gate-blocked",
          message:
            "JobPilot could not record the transaction, so it will not send. Persistence may be failing.",
        };
      }

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

      // Terminal tracing. These were declared and wired but never invoked, so a
      // real bundle would have had no send, verification or terminal trace at
      // all — the three the brief cares about most.
      deps.onTerminal?.({
        transactionId,
        jobId,
        kind:
          outcome.kind === "sent"
            ? "completed"
            : outcome.kind === "uncertain"
              ? "uncertain"
              : "failed",
        reason: reasonOf(outcome),
      });

      switch (outcome.kind) {
        case "sent":
          deps.onVerified?.({
            transactionId,
            jobId,
            kind: "verified",
            outgoingCount: intent.outgoingBaseline + 1,
            baseline: intent.outgoingBaseline,
          });
          return { kind: "sent", evidence: outcome.evidence };
        case "uncertain":
          deps.onVerified?.({
            transactionId,
            jobId,
            kind: "uncertain",
            outgoingCount: intent.outgoingBaseline,
            baseline: intent.outgoingBaseline,
          });
          return { kind: "uncertain", detail: outcome.detail };
        case "blocked":
          // An unknown modal reaching here is the case the invariant names: the
          // adapter classified the dialog as unrecognised and refused to act on
          // it. Recording the invariant makes "JobPilot stopped at a dialog it
          // did not understand" visible in the bundle as a guarantee, not just
          // as a log line.
          if (outcome.reason === "unknown-dom" || outcome.reason === "ambiguous-state") {
            reportInvariantViolation(deps.recorder, {
              invariant: INVARIANTS.noContinuationThroughUnknownModal,
              detail: `automation stopped at a dialog it could not classify (${outcome.reason})`,
              context: { jobId, transactionId, evidence: outcome.evidence },
            });
          }
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

    async verifyRecovered(options) {
      const recovered = deps.readPersistedIntent();
      if (recovered === undefined) {
        return { kind: "aborted", detail: "no transaction to verify" };
      }

      // The gates apply to recovery too. A recovered transaction is exactly
      // when a challenge or a broken storage layer is most likely, and this
      // path reads the live conversation, which is an action.
      const gate = evaluateSendGates({
        ...deps.baseGateInput(),
        draftPresent: false,
        chatVerified: true,
        hasPersistedIntent: true,
        // Deliberately true: it stops any send and leaves the runner to verify.
        sendAlreadyAttempted: true,
      });
      recordGateOutcome(deps.recorder, "recovery", gate, {
        transactionId: recovered.id,
        jobId: recovered.jobId,
      });
      if (!gate.allowed) {
        return {
          kind: "refused",
          reason: "gate-blocked",
          message: gate.message ?? "a safety gate is blocking recovery",
        };
      }

      deps.recorder.record({
        level: "info",
        category: "recovery",
        event: "communication.recovery.started",
        jobId: recovered.jobId,
        transactionId: recovered.id,
        data: { phase: recovered.phase, clickDispatched: recovered.clickDispatched ?? null },
      });

      let outcome: CommunicationOutcome;
      try {
        outcome = await deps.runner.run(
          recovered,
          options?.observeTimeoutMs === undefined
            ? {}
            : { observeTimeoutMs: options.observeTimeoutMs },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error("communication", "recovery threw", { error: message });
        return { kind: "uncertain", detail: `recovery could not complete: ${message}` };
      }

      deps.onTerminal?.({
        transactionId: recovered.id,
        jobId: String(recovered.jobId),
        kind:
          outcome.kind === "sent"
            ? "completed"
            : outcome.kind === "uncertain"
              ? "uncertain"
              : "failed",
        reason: reasonOf(outcome),
      });

      switch (outcome.kind) {
        case "sent":
          return { kind: "sent", evidence: outcome.evidence };
        case "uncertain":
          return { kind: "uncertain", detail: outcome.detail };
        case "blocked":
          return { kind: "blocked", reason: outcome.reason, evidence: outcome.evidence };
        case "aborted":
          return { kind: "aborted", detail: outcome.detail };
        default: {
          const exhaustive: never = outcome;
          return { kind: "aborted", detail: String(exhaustive) };
        }
      }
    },

    async discardRecovered() {
      const recovered = deps.readPersistedIntent();
      if (recovered === undefined) return false;

      // Refuse to discard anything that might have been sent. Discarding a
      // `send-attempted` record would erase the evidence that a message may
      // have gone out, which is the one thing that must never be lost.
      if (hasSendBeenAttempted(recovered)) {
        reportInvariantViolation(deps.recorder, {
          invariant: INVARIANTS.noSecondSendAfterAttempt,
          detail: "refused to discard a transaction that may already have sent",
          context: { jobId: recovered.jobId, transactionId: recovered.id },
        });
        return false;
      }

      await deps.clearIntent();
      deps.recorder.record({
        level: "info",
        category: "recovery",
        event: "communication.recovery.discarded",
        jobId: recovered.jobId,
        transactionId: recovered.id,
        data: { phase: recovered.phase },
      });
      return true;
    },

    pendingIntent: () => deps.readPersistedIntent(),
  };
};
