/**
 * BOSS Zhipin communication action.
 *
 * ============================ HONESTY NOTICE ============================
 * Sending a first message to a recruiter is IRREVERSIBLE. The real BOSS chat
 * DOM, send button, success dialog, common-phrase panel and failure markers were
 * NEVER inspected. This adapter is validated only against the synthetic fixtures
 * under `tests/fixtures/boss/`. Live-site messaging is UNVERIFIED and must not be
 * described as working.
 * =======================================================================
 *
 * Safety model, in the order the guards are applied:
 *   1. Re-check the page guards (captcha / risk-control / login) BEFORE every
 *      action. Nothing is cached from page load.
 *   2. Confirm we are in the RIGHT conversation before touching the editor. A
 *      send into the wrong conversation is a privacy failure, not a glitch.
 *   3. A draft written by the user is sacred: `prepareMessage` reports it and
 *      leaves the editor untouched, even if the intent would otherwise proceed.
 *   4. `dispatchSend` consults `canClickSend(intent)` — the single, auditable
 *      never-send-twice guard — and refuses (`{kind:"refused"}`) when it says no.
 *   5. Success is only ever reported from observed evidence: the outgoing count
 *      must STRICTLY exceed the recorded baseline. A clicked button is not
 *      evidence; an unrecognised dialog is not evidence.
 */

import type { ChatIdentity } from "../../../domain/communication/identity";
import { countOutgoingMessages, matchChatIdentity } from "../../../domain/communication/identity";
import { canClickSend, type CommunicationIntent } from "../../../domain/communication/intent";
import type { Clock } from "../../../domain/support/shared";
import type { BlockReason, LocatedElement } from "../../../ports/job-platform";
import type { Logger } from "../../../ports/logger";
import { detectCaptcha, detectLoginRequired, detectRiskControl } from "../guards";
import { SELECTORS } from "../selectors";
import { queryFirst as queryBossFirst } from "../selectors";
import {
  classifyModal,
  detectRiskBanner,
  findChatRoot,
  findEditor,
  findSendButton,
  isEditorEmpty,
  readChatIdentity,
  readEditorText,
  readOutgoingMessageBodies,
  type ModalClassification,
  type RiskEvidence,
} from "./chat-reader";
import { COMMUNICATION_SELECTORS, normalizeText, queryAll } from "./selectors";
import { writeEditorText } from "./write-editor";

/** Dependencies of the communication action. All injectable. */
export interface CommunicationActionDeps {
  /**
   * Scope for every read. Production passes the `Document`; the job-detail and
   * job-list roots are located inside it with the shared `SELECTORS` registry.
   */
  readonly document: ParentNode;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A blocked outcome, carrying the typed reason and short evidence. */
export interface BlockedResult {
  readonly kind: "blocked";
  readonly reason: BlockReason;
  readonly evidence: string;
}

/** Result of preparing the editor. */
export type PrepareResult =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "draft-present"; readonly text: string }
  | { readonly kind: "chat-mismatch"; readonly detail: string }
  | BlockedResult;

/** Result of clicking send. */
export type DispatchResult =
  | { readonly kind: "dispatched" }
  | { readonly kind: "refused"; readonly detail: string }
  | BlockedResult;

/** Result of looking for evidence that the message actually went out. */
export type ObserveResult =
  | { readonly kind: "observed"; readonly count: number; readonly evidence: string }
  | { readonly kind: "unobserved"; readonly detail: string }
  | BlockedResult;

/** The communication action surface handed to the queue runner. */
export interface CommunicationAction {
  /** The 立即沟通 control, searched only inside an active job-detail root. */
  findCommunicateButton(): LocatedElement | null;
  /** Identity of the conversation currently displayed, or `null`. */
  readCurrentChat(): ChatIdentity | null;
  /** Current editor text, or `null` when there is no editor. */
  readEditor(): string | null;
  /** How many delivered outgoing messages carry `text`. */
  outgoingCount(text: string): number;
  /** Ensures the editor holds the intended message; never overwrites a draft. */
  prepareMessage(intent: CommunicationIntent, options?: ActionOptions): Promise<PrepareResult>;
  /** Clicks send exactly once, guarded by `canClickSend`. */
  dispatchSend(intent: CommunicationIntent, options?: ActionOptions): Promise<DispatchResult>;
  /** Looks for evidence that the send produced a new outgoing message. */
  observeSend(
    intent: CommunicationIntent,
    baseline: number,
    options?: ActionOptions,
  ): Promise<ObserveResult>;
  /** Classifies any dialog on screen (`success` / `unknown` / `none`). */
  classifyModal(): ModalClassification;
  /** Chat-scoped risk/login/captcha evidence, or `null`. */
  detectBlock(): { readonly reason: BlockReason; readonly evidence: string } | null;
}

/** Options accepted by the async methods. */
export interface ActionOptions {
  /**
   * Aborts the wait loops. There is deliberately NO fixed sleep as the primary
   * wait: the loops poll the DOM and bail out on an aborted signal, so a test or
   * a user cancel never has to wait out a timer.
   */
  readonly signal?: AbortSignal;
  /** Test seam: replaces the default "schedule the next poll" hook. */
  readonly scheduler?: (run: () => void) => void;
  /** How many polls before giving up. Defaults to a small, finite number. */
  readonly maxAttempts?: number;
}

/** Page guard evaluation, shared by every method. */
interface GuardOutcome {
  readonly blocked: BlockedResult | null;
  readonly chatRisk: RiskEvidence | null;
}

/**
 * Runs the page guards and the chat-scoped risk probe.
 *
 * Failure mode: returns a `blocked` result for ANY fired guard. It never returns
 * "clear" for an unreadable page — an unreadable page simply produces no
 * positive signal here, and the individual methods then block for their own
 * reasons (missing selector, missing identity).
 */
export const evaluateGuards = (deps: CommunicationActionDeps): GuardOutcome => {
  const { document: root } = deps;

  const captcha = detectCaptcha(root);
  if (captcha.detected) {
    return { blocked: { kind: "blocked", reason: "captcha", evidence: captcha.evidence }, chatRisk: null };
  }

  const risk = detectRiskControl(root);
  if (risk.detected) {
    return {
      blocked: { kind: "blocked", reason: "risk-control", evidence: risk.evidence },
      chatRisk: null,
    };
  }

  const login = detectLoginRequired(root);
  if (login.detected) {
    return {
      blocked: { kind: "blocked", reason: "login-expired", evidence: login.evidence },
      chatRisk: null,
    };
  }

  const chatRisk = detectRiskBanner(root);
  if (chatRisk !== null) {
    return {
      blocked: { kind: "blocked", reason: chatRisk.reason, evidence: chatRisk.evidence },
      chatRisk,
    };
  }

  return { blocked: null, chatRisk: null };
};

/** True when the signal is present and already aborted. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Default poll scheduler: a macrotask, NOT a fixed sleep. */
const defaultScheduler = (run: () => void): void => {
  const view = typeof globalThis === "object" ? globalThis : undefined;
  const setTimeoutFn: unknown = view === undefined ? undefined : Reflect.get(view, "setTimeout");
  if (typeof setTimeoutFn === "function") {
    (setTimeoutFn as (handler: () => void, timeout?: number) => unknown)(run, 0);
    return;
  }
  run();
};

/**
 * Polls `probe` until it returns a value, the signal aborts, or attempts run out.
 *
 * There is no fixed sleep as the primary wait: each iteration re-reads the DOM
 * and yields through the injected scheduler, so the loop is bounded by the
 * attempt count rather than by wall-clock time.
 *
 * Failure mode: returns `undefined` on timeout or abort, which callers must
 * report as `unobserved` — never as success.
 */
const pollUntil = async <T>(
  probe: () => T | undefined,
  options: ActionOptions,
): Promise<T | undefined> => {
  const scheduler = options.scheduler ?? defaultScheduler;
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isAborted(options.signal)) return undefined;
    const result = probe();
    if (result !== undefined) return result;
    if (attempt === maxAttempts - 1) return undefined;
    await new Promise<void>((resolve) => {
      scheduler(resolve);
    });
  }
  return undefined;
};

/**
 * Locates the job-detail root that is currently active.
 *
 * Only a root containing a visible, enabled 立即沟通 control counts as "active";
 * BOSS keeps detail panes mounted after they are dismissed, and clicking a stale
 * one would open the wrong conversation.
 *
 * Failure mode: `null` when nothing qualifies. Callers must not fall back to a
 * whole-document search for a button labelled 立即沟通.
 */
export const findActiveDetailRoot = (root: ParentNode): Element | null => {
  for (const candidate of SELECTORS.detail.root.candidates) {
    let matches: readonly Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(candidate));
    } catch {
      continue;
    }
    for (const element of matches) {
      if (isHiddenByStyle(element)) continue;
      const action = queryBossFirst(element, SELECTORS.detail.applyButton);
      if (action !== null) return element;
    }
  }
  return null;
};

/** Hidden-by-attribute-or-inline-style check, shared by the visibility probes. */
const isHiddenByStyle = (element: Element): boolean => {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  const style = element.getAttribute("style");
  if (style === null) return false;
  const normalized = style.replace(/\s+/g, "").toLowerCase();
  return normalized.includes("display:none") || normalized.includes("visibility:hidden");
};

/** Builds the adapter. */
export const createCommunicationAction = (
  deps: CommunicationActionDeps,
): CommunicationAction => {
  const { document: root, clock, logger } = deps;

  const blocked = (reason: BlockReason, evidence: string): BlockedResult => {
    logger.warn("boss.communication", "blocked", { reason, evidence });
    return { kind: "blocked", reason, evidence };
  };

  /** Re-checks every guard. Returns a `BlockedResult`, or `null` when clear. */
  const guard = (): BlockedResult | null => evaluateGuards(deps).blocked;

  const outgoingCount = (text: string): number =>
    countOutgoingMessages(readOutgoingMessageBodies(root), text);

  /**
   * Confirms the on-screen conversation matches the intent.
   *
   * Failure mode: returns a `BlockedResult` for a mismatch (never a send), and
   * `null` when the identity is sufficient. A conversation whose identity cannot
   * be read at all yields `unknown-dom` rather than an assumed match.
   */
  const verifyConversation = (intent: CommunicationIntent): BlockedResult | null => {
    const chat = readChatIdentity(root);
    if (chat === null) {
      return blocked("unknown-dom", "no chat root or editor found; cannot confirm the conversation");
    }
    const verdict = matchChatIdentity(
      {
        jobId: intent.jobId,
        ...(intent.expectedJobTitle === undefined ? {} : { title: intent.expectedJobTitle }),
        ...(intent.expectedCompany === undefined ? {} : { company: intent.expectedCompany }),
        ...(intent.expectedRecruiter === undefined ? {} : { recruiter: intent.expectedRecruiter }),
      },
      chat,
    );
    switch (verdict.kind) {
      case "match":
        return null;
      case "mismatch":
        return blocked("ambiguous-state", `conversation mismatch: ${verdict.reason}`);
      default:
        return blocked("ambiguous-state", `conversation identity insufficient: ${verdict.reason}`);
    }
  };

  return {
    findCommunicateButton(): LocatedElement | null {
      const detailRoot = findActiveDetailRoot(root);
      if (detailRoot === null) return null;
      return queryBossFirst(detailRoot, SELECTORS.detail.applyButton);
    },

    readCurrentChat(): ChatIdentity | null {
      return readChatIdentity(root);
    },

    readEditor(): string | null {
      const editor = findEditor(root);
      return editor === null ? null : readEditorText(editor);
    },

    outgoingCount,

    classifyModal(): ModalClassification {
      return classifyModal(root);
    },

    detectBlock(): { readonly reason: BlockReason; readonly evidence: string } | null {
      const outcome = evaluateGuards(deps);
      if (outcome.blocked === null) return null;
      return { reason: outcome.blocked.reason, evidence: outcome.blocked.evidence };
    },

    /**
     * Ensures the editor holds `intent.messageText`.
     *
     * Order of refusal:
     *   1. guards (captcha / risk / login / chat risk)
     *   2. conversation identity
     *   3. an EXISTING DRAFT — reported as `draft-present` with the text that is
     *      already there, and the editor is NOT touched. User content always wins.
     *   4. missing editor / missing send button -> `selector-missing`
     *   5. the write itself, which may fail on a detached node
     *
     * Failure mode: never writes when unsure. In particular it cannot clear or
     * overwrite an existing draft, and it cannot report `ready` for text it did
     * not verify landed in the editor (the editor is re-read after the write).
     */
    async prepareMessage(
      intent: CommunicationIntent,
      options: ActionOptions = {},
    ): Promise<PrepareResult> {
      if (isAborted(options.signal)) {
        return blocked("unknown-dom", "aborted before prepare");
      }

      const guardResult = guard();
      if (guardResult !== null) return guardResult;

      const mismatch = verifyConversation(intent);
      if (mismatch !== null) return mismatch;

      const editor = findEditor(root);
      if (editor === null) {
        return blocked(
          "selector-missing",
          `no editor matched: ${COMMUNICATION_SELECTORS.chatEditor.candidates.join(", ")}`,
        );
      }

      // A draft is checked BEFORE the send button is even located: there is no
      // point confirming a send path we must not use.
      const draft = readEditorText(editor);
      if (draft.length > 0) {
        logger.info("boss.communication", "draft present; leaving the editor untouched", {
          draftLength: draft.length,
        });
        return { kind: "draft-present", text: draft };
      }

      const send = findSendButton(root);
      if (send === null) {
        return blocked(
          "selector-missing",
          `no enabled control labelled exactly 发送 matched: ${COMMUNICATION_SELECTORS.sendButton.candidates.join(", ")}`,
        );
      }

      const text = normalizeText(intent.messageText);
      if (text.length === 0) {
        return blocked("ambiguous-state", "intent carries an empty message; refusing to type nothing");
      }

      const written = writeEditorText(editor, text);
      if (!written.ok) {
        return blocked("selector-missing", `editor write failed: ${written.detail}`);
      }

      // Verify the write instead of trusting it: a framework that rejected the
      // synthetic events leaves the editor empty, and reporting `ready` then
      // would send an empty message.
      const observed = normalizeText(readEditorText(editor));
      if (observed.length === 0) {
        return blocked(
          "ambiguous-state",
          "editor is still empty after the write; the page did not accept the text",
        );
      }
      if (observed !== text) {
        return blocked(
          "ambiguous-state",
          `editor content differs from the intended message after the write (${written.detail})`,
        );
      }

      logger.info("boss.communication", "message prepared", {
        matchedBy: COMMUNICATION_SELECTORS.chatEditor.candidates[0] ?? "",
        length: text.length,
      });
      return { kind: "ready", text };
    },

    /**
     * Clicks send, at most once.
     *
     * `canClickSend(intent)` is consulted FIRST and is the only thing that can
     * authorise the click. Once an intent has reached `send-attempted` this
     * returns `{kind:"refused"}`, so a retry, a reload or a duplicated queue
     * entry can never produce a second message.
     *
     * Failure mode: refuses (never throws) on a non-sendable intent, a fired
     * guard, a lost conversation match, an empty editor, or a missing send
     * button. A click it does dispatch is still NOT success — the caller must
     * observe the result separately.
     */
    async dispatchSend(
      intent: CommunicationIntent,
      options: ActionOptions = {},
    ): Promise<DispatchResult> {
      // The never-send-twice guard, first, before any DOM work at all.
      if (!canClickSend(intent)) {
        logger.warn("boss.communication", "send refused: intent is not sendable", {
          phase: intent.phase,
          sendAttemptedAt: intent.sendAttemptedAt ?? null,
        });
        return {
          kind: "refused",
          detail: `canClickSend is false for phase "${intent.phase}"`,
        };
      }

      if (isAborted(options.signal)) return blocked("unknown-dom", "aborted before dispatch");

      const guardResult = guard();
      if (guardResult !== null) return guardResult;

      const mismatch = verifyConversation(intent);
      if (mismatch !== null) return mismatch;

      const editor = findEditor(root);
      if (editor === null) {
        return blocked("selector-missing", "editor disappeared before the send");
      }

      // Re-check the editor on the click path too: if the user typed something
      // between prepare and dispatch, that content is theirs and must not be
      // sent under our intent.
      const current = normalizeText(readEditorText(editor));
      const expected = normalizeText(intent.messageText);
      if (current.length === 0) {
        return blocked("ambiguous-state", "editor is empty at send time; nothing to send");
      }
      if (current !== expected) {
        return blocked(
          "ambiguous-state",
          "editor content changed after prepare; refusing to send text the user may not have approved",
        );
      }

      const send = findSendButton(root);
      if (send === null) {
        return blocked(
          "selector-missing",
          `no enabled control labelled exactly 发送 matched: ${COMMUNICATION_SELECTORS.sendButton.candidates.join(", ")}`,
        );
      }

      const clickable: unknown = (send as { click?: unknown }).click;
      if (typeof clickable !== "function") {
        return blocked("ambiguous-state", "send control exposes no click() method");
      }

      if (isAborted(options.signal)) return blocked("unknown-dom", "aborted at the click boundary");

      clock.now();
      logger.info("boss.communication", "dispatching send click", { phase: intent.phase });
      (send as Element & { click: () => void }).click();
      return { kind: "dispatched" };
    },

    /**
     * Looks for evidence that the dispatched send produced a new message.
     *
     * The rule is strict: the current count of delivered outgoing messages whose
     * body equals `intent.messageText` must be STRICTLY GREATER than `baseline`.
     * Equal or lower is `unobserved`, with the observed count reported so the
     * caller can hand the transaction to the user as uncertain rather than
     * retrying it.
     *
     * A fired guard short-circuits to `blocked`. Aborting or exhausting the poll
     * budget is `unobserved`, never success.
     */
    async observeSend(
      intent: CommunicationIntent,
      baseline: number,
      options: ActionOptions = {},
    ): Promise<ObserveResult> {
      const guardResult = guard();
      if (guardResult !== null) return guardResult;

      const found = await pollUntil<number>(() => {
        const count = outgoingCount(intent.messageText);
        return count > baseline ? count : undefined;
      }, options);

      if (found === undefined) {
        const observedNow = outgoingCount(intent.messageText);
        return {
          kind: "unobserved",
          detail: `outgoing count for the intended text is ${observedNow}, which does not exceed the baseline ${baseline}`,
        };
      }

      return {
        kind: "observed",
        count: found,
        evidence: `${found} outgoing message(s) match the intended text, exceeding the baseline ${baseline}`,
      };
    },
  };
};

/** True when the editor exists and holds nothing; exported for the queue runner. */
export const isChatEditorEmpty = (root: ParentNode): boolean => isEditorEmpty(findEditor(root));

/** The chat root, or `null`. Re-exported so the runner need not import the reader. */
export const findConversationRoot = (root: ParentNode): Element | null => findChatRoot(root);

/** Every common phrase offered by the panel, for user-facing previews. */
export const readCommonPhrases = (root: ParentNode): readonly string[] =>
  queryAll(findChatRoot(root) ?? root, COMMUNICATION_SELECTORS.commonPhraseItem)
    .map((element) => normalizeText(element.textContent))
    .filter((text) => text.length > 0);
