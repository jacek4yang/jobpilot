/**
 * Execution gates.
 *
 * Every precondition that must hold before JobPilot takes an irreversible
 * action. Centralised deliberately: a gate checked at the click is not a gate,
 * because the state it guards can change between the check and the action. All
 * of these are evaluated at the moment an action is *armed*, and the result is
 * carried forward.
 *
 * The invariant this file exists to enforce:
 *
 *   No send without persisted intent, verified chat, healthy storage,
 *   queue ownership, and an empty editor.
 */

import type { AutomationMode } from "../config/schema";
import { EVENTS } from "../diagnostics/event";
import type { DiagnosticRecorder } from "../diagnostics/recorder";
import type { StorageHealth } from "../diagnostics/trace";

/** Why execution is currently refused. Ordered by how early it applies. */
export type GateReason =
  | "mode"
  | "human-verification"
  | "storage-unhealthy"
  | "not-owner"
  | "session-limit"
  | "hourly-limit"
  | "rate-limited"
  | "draft-present"
  | "chat-unverified"
  | "no-intent"
  | "already-attempted";

export interface GateInput {
  readonly mode: AutomationMode;
  readonly humanVerificationActive: boolean;
  readonly storage: StorageHealth;
  readonly isQueueOwner: boolean;
  readonly sessionLimitReached: boolean;
  readonly hourlyLimitReached: boolean;
  readonly rateLimited: boolean;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly reason?: GateReason;
  /** Operator-facing explanation. Plain language, no jargon. */
  readonly message?: string;
}

const ALLOWED: GateResult = { allowed: true };

/**
 * Evaluates the gates that apply to starting any automated work.
 *
 * Order is significant and asserted by test: the cheapest and most safety
 * critical checks run first, and the reported reason is the first failure
 * rather than an arbitrary one.
 */
export const evaluateExecutionGates = (input: GateInput): GateResult => {
  if (input.mode === "manual") {
    return {
      allowed: false,
      reason: "mode",
      message: "JobPilot 处于手动模式，不会自动执行任何操作。",
    };
  }

  if (input.humanVerificationActive) {
    return {
      allowed: false,
      reason: "human-verification",
      message: "BOSS 需要人工验证。请在页面中完成验证，然后重新检查。",
    };
  }

  if (!input.storage.healthy) {
    return {
      allowed: false,
      reason: "storage-unhealthy",
      message: "本地存储不可用。为防止重复投递记录无法保存，JobPilot 不会执行新的自动沟通。",
    };
  }

  if (!input.isQueueOwner) {
    return {
      allowed: false,
      reason: "not-owner",
      message: "JobPilot 正在另一个标签页运行。",
    };
  }

  if (input.sessionLimitReached) {
    return { allowed: false, reason: "session-limit", message: "已达到本次任务的数量上限。" };
  }

  if (input.hourlyLimitReached) {
    return { allowed: false, reason: "hourly-limit", message: "已达到每小时的数量上限。" };
  }

  if (input.rateLimited) {
    return { allowed: false, reason: "rate-limited", message: "已达到安全频次上限，请稍后再试。" };
  }

  return ALLOWED;
};

export interface SendGateInput extends GateInput {
  readonly draftPresent: boolean;
  readonly chatVerified: boolean;
  readonly hasPersistedIntent: boolean;
  readonly sendAlreadyAttempted: boolean;
}

/**
 * Evaluates the additional gates specific to sending a message.
 *
 * `sendAlreadyAttempted` is checked last and is absolute: once a click has been
 * dispatched, no gate ordering or state change can authorise another.
 */
export const evaluateSendGates = (input: SendGateInput): GateResult => {
  const execution = evaluateExecutionGates(input);
  if (!execution.allowed) return execution;

  if (input.sendAlreadyAttempted) {
    return {
      allowed: false,
      reason: "already-attempted",
      message: "这个职位可能已经发送过消息，请先确认对话后再继续。",
    };
  }

  if (!input.hasPersistedIntent) {
    return {
      allowed: false,
      reason: "no-intent",
      message: "没有已保存的发送记录，一旦中断将无法恢复本次发送。",
    };
  }

  if (!input.chatVerified) {
    return {
      allowed: false,
      reason: "chat-unverified",
      message: "无法确认当前对话就是这个职位的聊天窗口。",
    };
  }

  if (input.draftPresent) {
    return {
      allowed: false,
      reason: "draft-present",
      message: "对话输入框中有未发送的内容，JobPilot 不会改动它。",
    };
  }

  return ALLOWED;
};

/**
 * Records the gate outcome.
 *
 * Both the allow and the refuse path are recorded: "why did nothing happen" is
 * as important to diagnose as a failure.
 */
export const recordGateOutcome = (
  recorder: DiagnosticRecorder,
  gate: string,
  result: GateResult,
  correlation: { readonly jobId?: string; readonly transactionId?: string } = {},
): void => {
  recorder.record({
    level: result.allowed ? "trace" : "info",
    category: "state-machine",
    event: result.allowed ? "gate.passed" : "gate.blocked",
    ...(correlation.jobId === undefined ? {} : { jobId: correlation.jobId }),
    ...(correlation.transactionId === undefined
      ? {}
      : { transactionId: correlation.transactionId }),
    data: {
      gate,
      allowed: result.allowed,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    },
  });
};

/**
 * Asserts a production invariant.
 *
 * A violation is fatal by design: continuing past one of these would mean
 * sending into an unverified conversation or sending twice, which is exactly
 * what the whole safety model exists to prevent.
 */
export const INVARIANTS = {
  noSendWithoutPersistedIntent: "NO_SEND_WITHOUT_PERSISTED_INTENT",
  noSendWithoutVerifiedChat: "NO_SEND_WITHOUT_VERIFIED_CHAT",
  noSendWhileStorageUnhealthy: "NO_SEND_WHILE_STORAGE_UNHEALTHY",
  noSendWithoutQueueOwnership: "NO_SEND_WITHOUT_QUEUE_OWNERSHIP",
  noSendWithDraftPresent: "NO_SEND_WITH_DRAFT_PRESENT",
  noSecondSendAfterAttempt: "NO_SECOND_SEND_AFTER_ATTEMPT",
  noAutomaticActionDuringHumanVerification: "NO_AUTOMATIC_ACTION_DURING_HUMAN_VERIFICATION",
  noContinuationThroughUnknownModal: "NO_CONTINUATION_THROUGH_UNKNOWN_MODAL",
  noAutomaticSendAfterAmbiguousReload: "NO_AUTOMATIC_SEND_AFTER_AMBIGUOUS_RELOAD",
  noSecondTabExecutingQueue: "NO_SECOND_TAB_EXECUTING_QUEUE",
} as const;

export type InvariantId = (typeof INVARIANTS)[keyof typeof INVARIANTS];

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly detail: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Reports a violated invariant.
 *
 * Returns a violation rather than throwing: the caller decides how to fail
 * closed (pausing, blocking the queue), and a throw inside an effect would be
 * swallowed by the controller's recovery path and lose the evidence.
 */
export const reportInvariantViolation = (
  recorder: DiagnosticRecorder,
  violation: InvariantViolation,
): InvariantViolation => {
  recorder.record({
    level: "fatal",
    category: "error",
    event: EVENTS.invariantViolation,
    data: {
      invariant: violation.invariant,
      detail: violation.detail,
      ...(violation.context ?? {}),
    },
  });
  return violation;
};
