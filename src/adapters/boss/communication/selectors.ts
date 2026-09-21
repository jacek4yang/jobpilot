/**
 * BOSS Zhipin communication-flow selector registry.
 *
 * ============================ HONESTY NOTICE ============================
 * The real BOSS Zhipin chat DOM was NOT inspected while writing this file;
 * on 2026-09-21 a read-only recon harness captured the live chat list and an
 * open conversation (`test-results/live/2026-09-21/recon/result/008-chat.json`,
 * `012-chat.json`), which grounds the entries marked "recon-verified".
 * Additional agents are working on a minimal *scrape* extraction; this module
 * deliberately does not depend on their work and does not import it.
 *
 * Every group carries an explicit `confidence` field, using exactly the same
 * ladder as `src/adapters/boss/selectors.ts`:
 *   - "fixture-only"   — asserted by the synthetic fixtures under
 *     `tests/fixtures/boss/`, which were authored to match this file. Matching
 *     a fixture proves the reader plumbing works; it says NOTHING about the
 *     real site.
 *   - "unverified"     — a heuristic guess about real BOSS markup. It may match
 *     nothing, or match the wrong element, on the live site.
 *   - "recon-verified" — observed in the 2026-09-21 read-only live-site capture.
 *     The element exists and looks as described there; coverage is partial and
 *     the site may drift (see each group's note).
 *   - "verified"       — NOT USED. Reserved for shipped-diagnostic evidence.
 *
 * Sending a message is irreversible, so the risk profile here is worse than for
 * a read-only scan. Two consequences run through the whole module:
 *   1. `sendButton` must resolve to a control whose *entire* visible label is
 *      `发送`. Never a substring match, never an icon, never a group.
 *   2. Anything ambiguous (an unrecognised dialog, an unreadable header) has to
 *      surface as "unknown"/blocked rather than as a best guess.
 * =======================================================================
 */

import type { LocatedElement } from "../../../ports/job-platform";
import { queryFirstBy, type SelectorEntry } from "../selectors";

/** Keys of the `communication` selector group. Enumerated for type-safety. */
export type CommunicationSelectorKey =
  | "chatRoot"
  | "chatEditor"
  | "chatHeader"
  | "jobTitleInChat"
  | "companyInChat"
  | "chatJobIdAttribute"
  | "commonPhraseToggle"
  | "commonPhrasePanel"
  | "commonPhraseItem"
  | "sendButton"
  | "outgoingMessage"
  | "outgoingMessageBody"
  | "messageSendFailed"
  | "successModal"
  | "successModalStayButton"
  | "unknownModal"
  | "riskBanner";

const FIXTURE_ONLY = "fixture-only" as const;
const UNVERIFIED = "unverified" as const;
const RECON_VERIFIED = "recon-verified" as const;

/**
 * Communication-flow selectors.
 *
 * All chat-scoped entries are written as *scope-relative* selectors (`.x`, not
 * `body .x`) so that they compose when `readChatIdentity` re-scopes a lookup
 * into the chat root, and so `:scope >` relationships stay meaningful.
 */
export const COMMUNICATION_SELECTORS = {
  /**
   * The conversation container. Everything chat-related is read *inside* this
   * node so that page furniture (recommendations, job-detail panels, other
   * panes) cannot be mistaken for conversation content.
   */
  chatRoot: {
    candidates: [".chat-conversation", "[data-jobpilot-chat]", ".chat-panel", ".chat-content"],
    confidence: RECON_VERIFIED,
    note: "Recon-verified 2026-09-21: the right-hand conversation panel is `div.chat-conversation` (012-chat.json, one open conversation on /web/geek/chat). Without a chat root, job ids and job title/company fall back to scanning the whole root — so a missing anchor degrades evidence quality rather than blocking outright.",
  },
  /**
   * The message input. Both shapes are listed because BOSS has shipped both a
   * plain `<textarea>` and a rich `contenteditable` box historically; the
   * readers probe the element's own tag/attributes and handle either.
   */
  chatEditor: {
    candidates: [
      "#chat-input",
      "[data-jobpilot-editor]",
      "[contenteditable='true'][role='textbox']",
      "textarea.chat-editor",
      ".chat-editor [contenteditable='true']",
    ],
    confidence: RECON_VERIFIED,
    note: 'Recon-verified 2026-09-21: the live editor is `div#chat-input.chat-input` with contenteditable="true" (012-chat.json). The textarea fallback is retained from the old dual-shape note; the fixture asserts [data-jobpilot-editor]. The reader handles textarea/input and contenteditable differently, so a *wrong* match here could write text into an unrelated contenteditable region.',
  },
  /** Header of the conversation, which carries the recruiter/company identity. */
  chatHeader: {
    candidates: ["[data-jobpilot-chat-header]", ".chat-header", "header.chat-panel__header"],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-chat-header]. Its text is folded into ChatIdentity.text, which drives matchChatIdentity.",
  },
  jobTitleInChat: {
    candidates: [
      "[data-jobpilot-chat-title]",
      "a.job-card-title",
      ".chat-header__job-title",
      ".chat-panel__job-title",
      "a[href*='/job_detail/']",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-chat-title]. a.job-card-title is the fixture's real-shape class (2026-09-21 fixture rewrite) — NOT live-observed; promote only on capture evidence. The detail-link fallback works wherever a /job_detail/ link is present.",
  },
  companyInChat: {
    candidates: [
      "[data-jobpilot-chat-company]",
      ".company-name",
      ".chat-header__company",
      ".chat-panel__company",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-chat-title]'s sibling [data-jobpilot-chat-company]. .company-name is the fixture's real-shape class — NOT live-observed. Absence is tolerated: matchChatIdentity then requires a recruiter or title corroboration.",
  },
  /**
   * Attributes that may carry a platform job id inside the chat region.
   *
   * These are ATTRIBUTE NAMES, not CSS selectors — `readChatIdentity` reads them
   * directly. The first attribute present wins.
   */
  chatJobIdAttribute: {
    candidates: ["data-job-id", "data-jobid", "data-jid"],
    confidence: FIXTURE_ONLY,
    note: "Fixture sets data-job-id on the chat panel and data-job-id on the job link. If none is present, ChatIdentity.jobIds is empty and matching falls back to text, which is weaker.",
  },
  /** The 常用语 (common phrase) trigger. */
  commonPhraseToggle: {
    candidates: [
      "[data-jobpilot-action='common-phrases']",
      ".phrase-toggle",
      ".chat-editor__phrase-toggle",
      ".chat-tools__phrase",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-action='common-phrases']. .phrase-toggle is the fixture's real-shape class — NOT live-observed. Clicking this opens a panel; the adapter treats its text as user-authored and refuses to overwrite a draft containing it.",
  },
  commonPhrasePanel: {
    candidates: ["[data-jobpilot-common-phrases]", ".common-phrase-panel"],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-common-phrases]. .common-phrase-panel is the fixture's real-shape class — NOT live-observed. A panel rendered into a portal outside the chat root will not be found here.",
  },
  commonPhraseItem: {
    candidates: [
      ".common-phrase-panel li.phrase-item",
      "[data-jobpilot-common-phrases] li",
      "[data-jobpilot-common-phrase]",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture puts each phrase in li.phrase-item under .common-phrase-panel (fixture-shape, NOT live-observed). Order is document order, so 'the first common phrase' is well defined but is only as trustworthy as BOSS's own ordering.",
  },
  /**
   * SAFETY-CRITICAL. The send control.
   *
   * This is the ONE group that is allowed to be narrowed by text, because
   * clicking the wrong control here sends an irreversible message. The label
   * filter in `chat-reader.findSendButton` re-checks that the button's
   * *entire* normalised label is exactly `发送`, which rejects decorative
   * icons, `发送中`, `重新发送` and any container whose text merely contains
   * the word.
   */
  sendButton: {
    candidates: [
      ".btn-send",
      "button[data-jobpilot-action='send']",
      "button.chat-editor__send",
      ".chat-editor button[type='button']",
    ],
    confidence: RECON_VERIFIED,
    note: "Recon-verified 2026-09-21: the live send control is `button.btn-send` (also `btn-v2 btn-sure-v2`, with a `.disabled` class when not sendable) labelled exactly 发送 (012-chat.json). The `filter` in chat-reader re-checks that the *entire* normalised label is exactly 发送 — rejecting 发送中, 重新发送 and icon containers. A miss yields BlockReason 'selector-missing' and there is NO fallback that clicks a text-similar node.",
  },
  /** An outgoing bubble. Used only to enumerate; text is read from the body. */
  outgoingMessage: {
    candidates: [
      ".message-item.item-myself",
      "[data-jobpilot-outgoing]",
      ".message-item.is-outgoing",
    ],
    confidence: RECON_VERIFIED,
    note: "Recon-verified 2026-09-21: outgoing messages are `li.message-item.item-myself` carrying `data-mid` (e.g. 388458078278148); incoming are `li.message-item.item-friend` (012-chat.json). This group must NOT be used to count successes on its own — failed bubbles are also outgoing, so callers must filter through messageSendFailed.",
  },
  /** The text node inside an outgoing bubble. */
  outgoingMessageBody: {
    candidates: [
      ".message-item.item-myself .item-message-body",
      "[data-jobpilot-outgoing] [data-jobpilot-body]",
      ".message-item.is-outgoing .message-item__body",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture-shape: li.message-item.item-myself > .item-message-body (NOT live-observed — the 2026-09-21 capture did not isolate a body node). If the body selector misses, the outer bubble text is used (which includes the 发送失败 marker) — so the failure filter is applied to the OUTER element, not to the body.",
  },
  /**
   * Failure markers. MUST be excluded from success counts: a bubble that says
   * 发送失败 is the opposite of evidence that a message was delivered, and a
   * bubble that says 发送中 has not been delivered yet.
   */
  messageSendFailed: {
    candidates: [
      ".message-item.item-myself.send-failed",
      "[data-jobpilot-status='failed']",
      "[data-jobpilot-status='sending']",
      ".message-item__status--failed",
      ".message-item__status--sending",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture-shape: a failed outgoing item carries the extra class .send-failed plus the visible text 发送失败 (NOT live-observed). The reader additionally falls back to the visible text 发送失败 / 发送中 so a renamed attribute does not silently turn a failure into a success.",
  },
  /** Confirmation dialog shown after a successful first contact. */
  successModal: {
    candidates: [
      "[data-jobpilot-modal='success']",
      "[role='dialog'][data-jobpilot-modal]",
      ".dialog-container.success",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts [data-jobpilot-modal='success'] AND the visible text 已向BOSS发送消息. The reader requires the text token as well, so a bare skin class alone can never classify as success.",
  },
  /** The 留在此页 / 继续沟通 button inside the success dialog. */
  successModalStayButton: {
    candidates: [
      "[data-jobpilot-modal='success'] [data-jobpilot-action='stay']",
      ".dialog-container.success .dialog__footer button",
    ],
    confidence: FIXTURE_ONLY,
    note: "Reported as evidence only. The adapter NEVER clicks a dialog button on the user's behalf, because the choice between 留在此页 and 继续沟通 is the user's.",
  },
  /**
   * Any visible dialog. Used to prove that something is on screen when no
   * recognised success dialog matched — which classifies as "unknown", never as
   * success. Broad on purpose: over-detection here only costs a pause.
   */
  unknownModal: {
    candidates: [
      "[role='dialog']",
      "[role='alertdialog']",
      ".dialog-container",
      ".modal-wrapper",
      ".boss-dialog",
    ],
    confidence: UNVERIFIED,
    note: "Heuristic. On the real site these class names may match cookie banners or ad overlays, which would classify as 'unknown' and pause automation. That is the safe direction.",
  },
  /**
   * Scoped risk / login indicators near the editor.
   *
   * Deliberately narrow: a whole-page text scan would match the 安全中心 link in
   * the footer and pause on every page. The page-level guards in `guards.ts`
   * remain the authority for blocking; this group only reports extra evidence.
   */
  riskBanner: {
    candidates: [
      "[data-jobpilot-guard='risk-control']",
      "[data-jobpilot-guard='captcha']",
      "[data-jobpilot-chat] [data-jobpilot-guard]",
    ],
    confidence: FIXTURE_ONLY,
    note: "Fixture asserts data-jobpilot-guard inside the chat panel. Real BOSS risk banners inside the chat are UNVERIFIED; the textual fallback looks for 安全验证 / 操作过于频繁 / 请先登录 in the chat region only.",
  },
} as const satisfies Readonly<Record<CommunicationSelectorKey, SelectorEntry>>;

/** Every communication selector key, in declaration order. */
export const COMMUNICATION_SELECTOR_KEYS: readonly CommunicationSelectorKey[] = [
  "chatRoot",
  "chatEditor",
  "chatHeader",
  "jobTitleInChat",
  "companyInChat",
  "chatJobIdAttribute",
  "commonPhraseToggle",
  "commonPhrasePanel",
  "commonPhraseItem",
  "sendButton",
  "outgoingMessage",
  "outgoingMessageBody",
  "messageSendFailed",
  "successModal",
  "successModalStayButton",
  "unknownModal",
  "riskBanner",
];

/** Normalises whitespace, so text comparisons are layout-insensitive. */
export const normalizeText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/**
 * Resolves the first candidate of a communication group that matches `within`.
 *
 * Thin wrapper over the shared `queryFirstBy` so this module reuses the exact
 * matching/annotation semantics of `src/adapters/boss/selectors.ts` instead of
 * inventing a parallel one.
 *
 * Failure mode: returns `null` when nothing matches, and never throws — a
 * malformed candidate is skipped, not propagated. Callers must treat `null` as
 * a hard failure and fail closed (`selector-missing`), never as "try something
 * else".
 */
export const queryFirst = (within: ParentNode, group: SelectorEntry): LocatedElement | null =>
  queryFirstBy(within, group, (candidate, scope) => scope.querySelector(candidate));

/**
 * All matches for a group's first matching candidate.
 *
 * Returns `[]` — never `null`, never a throw — when nothing matches, so callers
 * can treat "no outgoing messages" and "unreadable conversation" identically
 * (both are "no evidence of a send").
 */
export const queryAll = (within: ParentNode, group: SelectorEntry): readonly Element[] => {
  for (const candidate of group.candidates) {
    try {
      const found = Array.from(within.querySelectorAll(candidate));
      if (found.length > 0) return found;
    } catch {}
  }
  return [];
};

/** Reports whether a communication group is a pure heuristic guess. */
export const isHeuristic = (group: SelectorEntry): boolean => group.confidence === "unverified";

/** Machine-readable summary of every communication selector, for diagnostics. */
export const communicationSelectorEntries = (): readonly {
  readonly key: CommunicationSelectorKey;
  readonly entry: SelectorEntry;
}[] =>
  COMMUNICATION_SELECTOR_KEYS.map((key) => ({
    key,
    entry: COMMUNICATION_SELECTORS[key],
  }));
