/**
 * BOSS Zhipin chat readers.
 *
 * ============================ HONESTY NOTICE ============================
 * Read-only DOM extraction for the communication flow. The real BOSS chat DOM
 * was never inspected; every reader here is validated only against the
 * synthetic fixtures under `tests/fixtures/boss/`. A reader that returns a value
 * proves the parsing plumbing, not that the live site was understood.
 * =======================================================================
 *
 * Contract for every exported reader:
 *   - READ-ONLY. No writes, no clicks, no focus changes.
 *   - TOTAL. Never throws. A hostile or renamed DOM yields `null` / `""` / `[]`
 *     rather than an exception escaping into the queue runner.
 *   - HONEST. Absence of evidence is reported as absence — never as a
 *     plausible-looking default. In particular `classifyModal` treats anything
 *     it does not positively recognise as `"unknown"`, never as `"success"`:
 *     misreading an unrelated dialog as a successful send is the exact failure
 *     mode that would make the adapter send a second message.
 */

import type { ChatIdentity } from "../../../domain/communication/identity";
import { extractJobIds, isPlausibleJobId } from "./job-id";
import { COMMUNICATION_SELECTORS, normalizeText, queryAll, queryFirst } from "./selectors";

export { extractJobIds, isPlausibleJobId } from "./job-id";

/** Body text of an element, whitespace-normalised. Never throws. */
const textOf = (element: Element | null): string => normalizeText(element?.textContent);

/** Concatenated text of every element matched by a group. */
const joinedTextOf = (within: ParentNode, candidate: string): string => {
  let parts: readonly string[] = [];
  try {
    parts = Array.from(within.querySelectorAll(candidate)).map((element) => textOf(element));
  } catch {
    return "";
  }
  return normalizeText(parts.filter((part) => part.length > 0).join(" "));
};

/** Charset of the failure/sending status markers, matched on visible text. */
const SEND_FAILED_TOKENS: readonly string[] = ["发送失败", "发送中"];

/**
 * Reports whether an outgoing bubble is failed or still in flight.
 *
 * Checks the status attribute/class first, then falls back to visible text. The
 * fallback exists because a renamed attribute would otherwise silently promote a
 * failed message into evidence of success — the one direction of error that must
 * never happen here.
 *
 * Failure mode: over-reports (a bubble whose text merely *mentions* 发送失败 is
 * excluded from counts). Under-reporting would be the dangerous direction, so the
 * bias is deliberate.
 */
export const isFailedOutgoing = (bubble: Element): boolean => {
  if (queryFirst(bubble, COMMUNICATION_SELECTORS.messageSendFailed) !== null) return true;
  if (bubble.matches(COMMUNICATION_SELECTORS.messageSendFailed.candidates.join(","))) return true;
  const text = textOf(bubble);
  return SEND_FAILED_TOKENS.some((token) => text.includes(token));
};

/**
 * Resolves the chat root, or `null` when the page has none.
 *
 * Failure mode: `null` means "this is not a conversation surface". Callers must
 * fail closed; in particular they must NOT fall back to the document, because
 * scanning the whole page for message bubbles would pick up recommended-job
 * cards and job-description text.
 */
export const findChatRoot = (root: ParentNode): Element | null =>
  queryFirst(root, COMMUNICATION_SELECTORS.chatRoot)?.element ?? null;

/**
 * Resolves the message editor, either inside `chatRoot` or, when no chat root is
 * present, directly under `root`.
 *
 * Failure mode: `null` when neither scope yields an editor.
 */
export const findEditor = (root: ParentNode): Element | null => {
  const chatRoot = findChatRoot(root);
  if (chatRoot !== null) {
    const scoped = queryFirst(chatRoot, COMMUNICATION_SELECTORS.chatEditor);
    if (scoped !== null) return scoped.element;
  }
  return queryFirst(root, COMMUNICATION_SELECTORS.chatEditor)?.element ?? null;
};

/** Duck-typed view of an element that exposes a string `value`. */
interface HasValue {
  readonly value: unknown;
}

/**
 * Tag names whose `value` really is their editable text.
 *
 * A narrow allow-list, NOT `"value" in element`: a `<button>` and a `<li>` also
 * expose a `value` property, and treating those as editors would let the writer
 * "successfully" write a message into a send button. That is a harmless-looking
 * bug here and a serious one the moment a caller trusts `ok: true`.
 */
const EDITABLE_VALUE_TAGS: readonly string[] = ["textarea", "input"];

/**
 * Reports whether an element is a text control whose `value` is its content.
 *
 * Duck-typed rather than `instanceof HTMLTextAreaElement`, because the global
 * constructors are not guaranteed to exist outside a browser realm and
 * cross-realm nodes would fail the check anyway. The tag check is what keeps
 * buttons and list items out.
 *
 * Failure mode: returns `false` for anything that is not a `textarea`/`input`
 * carrying a string `value`. Callers that see `false` must fall through to the
 * contenteditable path and then to an explicit failure — never to a plain
 * assignment on an unknown node type.
 */
export const hasValueProperty = (element: Element): element is Element & HasValue => {
  const tag = element.tagName.toLowerCase();
  if (!EDITABLE_VALUE_TAGS.includes(tag)) return false;
  const candidate: unknown = Reflect.get(element, "value");
  return typeof candidate === "string";
};

/** True when the element is a `contenteditable` region. */
export const isContentEditable = (element: Element): boolean =>
  element.getAttribute("contenteditable") === "true";

/**
 * Reads the current text of an editor.
 *
 * Handles both shapes: a form control (`value`) and a contenteditable region
 * (`innerText` when the environment provides it, else `textContent`).
 *
 * Failure mode: returns `""` for `null`, for a missing node, and for any element
 * that is neither shape. `""` is reported as-is and never converted into a
 * fabricated "empty means safe to type" claim by this function — that decision
 * belongs to `isEditorEmpty`'s caller.
 */
export const readEditorText = (editor: Element | null): string => {
  if (editor === null) return "";
  if (hasValueProperty(editor)) return normalizeText(editor.value as string);
  const innerText: unknown = (editor as { innerText?: unknown }).innerText;
  if (typeof innerText === "string" && innerText.length > 0) return normalizeText(innerText);
  return textOf(editor);
};

/**
 * Reports whether the editor holds no meaningful content.
 *
 * Failure mode: a `null` editor is reported as EMPTY, which is the unsafe
 * direction. Callers must therefore check that an editor exists before treating
 * "empty" as permission to type; `prepareMessage` in the action adapter does
 * exactly that and returns `selector-missing` instead.
 */
export const isEditorEmpty = (editor: Element | null): boolean =>
  readEditorText(editor).length === 0;

/** Every element under a node, in document order. Empty for a non-element node. */
const elementDescendants = (parent: ParentNode): readonly Element[] => {
  try {
    return Array.from(parent.querySelectorAll("*"));
  } catch {
    return [];
  }
};

/** The element itself, when the node is one. `ParentNode` may not be. */
const asElement = (node: ParentNode): Element | null => {
  const candidate: unknown = node;
  if (candidate instanceof Object && "getAttribute" in candidate) return candidate as Element;
  return null;
};

/**
 * Collects the raw strings inside ONE scope that might identify the job.
 *
 * Scope discipline: the chat root's own attributes and the job link inside it are
 * read first and, when that yields an id, the search does NOT widen — so a
 * recommendation rail or a stale detail pane elsewhere on the page cannot
 * contribute a competing id. Widening only happens when the chat root carried no
 * id at all, in which case the extra candidates are a strictly better fallback
 * than "no evidence".
 *
 * Failure mode: returns `[]` for a root with nothing id-shaped in it.
 */
const collectIdentityHints = (root: ParentNode, chatRoot: Element | null): readonly string[] => {
  const attributes = COMMUNICATION_SELECTORS.chatJobIdAttribute.candidates;

  /** Scope-local hints: this node's own attributes plus the job link inside it. */
  const hintsWithin = (scope: ParentNode): readonly string[] => {
    const hints: string[] = [];
    const self = asElement(scope);
    if (self !== null) {
      for (const attribute of attributes) {
        const value = self.getAttribute(attribute);
        if (value !== null) hints.push(value);
      }
    }
    const link = queryFirst(scope, COMMUNICATION_SELECTORS.jobTitleInChat);
    if (link !== null) {
      const href = link.element.getAttribute("href");
      if (href !== null) hints.push(href);
    }
    for (const element of elementDescendants(scope)) {
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute);
        if (value !== null) hints.push(value);
      }
    }
    return hints;
  };

  if (chatRoot === null) return hintsWithin(root);

  const scoped = hintsWithin(chatRoot);
  if (extractJobIds(scoped).length > 0) return scoped;
  // No id inside the conversation region. Widening to the whole document is
  // weaker evidence, so the widened hints are additionally filtered down to the
  // ones that at least *look* like ids — a page-level `data-job-id` on an
  // unrelated recommendation card must not become authoritative identity.
  return [...scoped, ...hintsWithin(root).filter((hint) => isPlausibleJobId(hint))];
};

/**
 * Reads the identity of the conversation currently on screen.
 *
 * Scope rules: `jobIds` come from links and `data-*id` attributes *inside the
 * chat root* first; header text is always read from inside the chat root. Only
 * when no chat root exists does the lookup widen to `root`, and that widening is
 * reported by the lower-quality text it yields rather than by a flag.
 *
 * Failure mode: returns `null` when there is neither a chat root nor an editor,
 * i.e. this is not a conversation surface at all. `matchChatIdentity` then
 * receives nothing and the caller must fail closed (`unknown-dom`), NOT send.
 */
export const readChatIdentity = (root: ParentNode): ChatIdentity | null => {
  const chatRoot = findChatRoot(root);
  const scope: ParentNode = chatRoot ?? root;
  if (chatRoot === null && findEditor(root) === null) return null;

  const jobIds = extractJobIds(collectIdentityHints(root, chatRoot));

  const header = queryFirst(scope, COMMUNICATION_SELECTORS.chatHeader);
  const title = queryFirst(scope, COMMUNICATION_SELECTORS.jobTitleInChat);
  const company = queryFirst(scope, COMMUNICATION_SELECTORS.companyInChat);

  const parts = [
    textOf(header?.element ?? null),
    textOf(title?.element ?? null),
    textOf(company?.element ?? null),
  ];
  const text = normalizeText(parts.filter((part) => part.length > 0).join(" "));

  return { jobIds, text };
};

/**
 * Collects the bodies of outgoing messages that actually went out.
 *
 * Excludes, by construction:
 *   - bubbles matched by `messageSendFailed` (发送失败 / 发送中);
 *   - bubbles whose own text contains those tokens, which covers a renamed
 *     status attribute.
 *
 * The outer bubble is filtered BEFORE its body is read, so a failed bubble can
 * never contribute body text to a success count.
 *
 * Failure mode: returns `[]` when nothing matches — indistinguishable from a
 * conversation with no outgoing messages. That is intentional: the caller
 * compares counts before and after a click, so "still empty" yields
 * `unobserved` rather than a fabricated success.
 */
export const readOutgoingMessageBodies = (root: ParentNode): readonly string[] => {
  const scope = findChatRoot(root) ?? root;
  const bubbles = queryAll(scope, COMMUNICATION_SELECTORS.outgoingMessage);
  const bodies: string[] = [];

  for (const bubble of bubbles) {
    if (isFailedOutgoing(bubble)) continue;
    const body = queryFirst(bubble, COMMUNICATION_SELECTORS.outgoingMessageBody);
    const text = normalizeText(body?.element.textContent) || textOf(bubble);
    if (text.length > 0) bodies.push(text);
  }
  return bodies;
};

/**
 * Finds the send control.
 *
 * Only an ENABLED element whose *entire* normalised label is exactly `发送` is
 * returned. Substring matching is rejected on purpose: `发送中`, `重新发送`,
 * `发送简历` and any wrapper containing a send icon must never be clicked, and a
 * wrong click here sends an irreversible message.
 *
 * Failure mode: `null` when nothing matches, when the only match is disabled, or
 * when the label differs. There is deliberately no text-similar fallback; a miss
 * becomes `BlockReason: "selector-missing"`.
 */
export const findSendButton = (root: ParentNode): Element | null => {
  const scope = findChatRoot(root) ?? root;
  for (const candidate of COMMUNICATION_SELECTORS.sendButton.candidates) {
    let matches: readonly Element[] = [];
    try {
      matches = Array.from(scope.querySelectorAll(candidate));
    } catch {
      continue;
    }
    for (const element of matches) {
      const disabled =
        element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
      if (disabled) continue;
      const label = normalizeText(element.getAttribute("aria-label")) || textOf(element);
      if (label === SEND_LABEL) return element;
    }
  }
  return null;
};

/** The one acceptable visible label for the send control. */
const SEND_LABEL = "发送";

/** Tokens that identify a successful-send confirmation dialog. */
const SUCCESS_TOKENS: readonly string[] = ["已向BOSS发送消息", "已向 BOSS 发送消息"];

/** Discriminated result of inspecting the page for a dialog. */
export type ModalClassification =
  | { readonly kind: "success"; readonly evidence: string }
  | { readonly kind: "unknown"; readonly evidence: string }
  | { readonly kind: "none" };

/** Reports whether a dialog element is perceivable, not merely present in the DOM. */
const isVisible = (element: Element): boolean => {
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = element.getAttribute("style");
  if (style === null) return true;
  const normalized = style.replace(/\s+/g, "").toLowerCase();
  return !normalized.includes("display:none") && !normalized.includes("visibility:hidden");
};

/**
 * Classifies whatever dialog is on screen.
 *
 * Precedence: a *visible* recognised success dialog wins; ANY other visible
 * dialog is `unknown`; nothing visible is `none`.
 *
 * Failure mode: the critical property is that an unrecognised dialog can never
 * be reported as `success` — an 实名认证 prompt, a rate-limit notice or a
 * completely new dialog shape all land in `unknown`, and the caller must pause
 * rather than conclude that a message was delivered. The success branch requires
 * BOTH the structural anchor and the visible text token 已向BOSS发送消息, so a
 * skin class alone is not enough.
 */
export const classifyModal = (root: ParentNode): ModalClassification => {
  const success = queryFirst(root, COMMUNICATION_SELECTORS.successModal);
  if (success !== null && isVisible(success.element)) {
    const text = textOf(success.element);
    if (SUCCESS_TOKENS.some((token) => text.includes(normalizeText(token)))) {
      return {
        kind: "success",
        evidence: `visible success dialog matched ${success.matchedBy}`,
      };
    }
    return {
      kind: "unknown",
      evidence: `visible dialog matched ${success.matchedBy} but does not carry the success text`,
    };
  }

  for (const candidate of COMMUNICATION_SELECTORS.unknownModal.candidates) {
    let matches: readonly Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(candidate));
    } catch {
      continue;
    }
    const visible = matches.find((element) => isVisible(element));
    if (visible !== undefined) {
      return {
        kind: "unknown",
        evidence: `visible dialog matched ${candidate}; not a recognised success dialog`,
      };
    }
  }

  return { kind: "none" };
};

/** Evidence of a risk/login/captcha signal, or `null` when the chat looks clean. */
export interface RiskEvidence {
  readonly reason: "captcha" | "risk-control" | "login-expired";
  readonly evidence: string;
}

/** Visible text tokens that indicate the chat region is not usable. */
const RISK_TEXT_TOKENS: readonly {
  readonly reason: RiskEvidence["reason"];
  readonly token: string;
}[] = [
  { reason: "captcha", token: "请完成安全验证" },
  { reason: "captcha", token: "滑动验证" },
  { reason: "risk-control", token: "操作过于频繁" },
  { reason: "risk-control", token: "当前操作存在风险" },
  { reason: "login-expired", token: "请先登录" },
  { reason: "login-expired", token: "登录后查看" },
];

/**
 * Detects risk/login indicators NEAR the conversation.
 *
 * Scoped on purpose: the search is limited to the chat region so that a footer
 * 安全中心 link or a cookie banner cannot pause every run. The page-level guards
 * in `guards.ts` stay the authority for blocking; this only adds chat-scoped
 * evidence for diagnostics.
 *
 * Failure mode: returns `null` when the chat looks clean, and ALSO when there is
 * no chat region at all — absence of a chat root is not evidence of safety, and
 * it is the caller's job (via `guards.ts`) to block separately. Never throws.
 */
export const detectRiskBanner = (root: ParentNode): RiskEvidence | null => {
  const chatRoot = findChatRoot(root);
  const scope: ParentNode = chatRoot ?? root;

  const structural = queryFirst(scope, COMMUNICATION_SELECTORS.riskBanner);
  if (structural !== null) {
    const chatScoped = chatRoot !== null || structural.matchedBy.includes("chat");
    if (chatScoped) {
      const guard = structural.element.getAttribute("data-jobpilot-guard") ?? "unknown";
      const reason: RiskEvidence["reason"] =
        guard === "captcha"
          ? "captcha"
          : guard === "risk-control"
            ? "risk-control"
            : guard === "login-required" || guard === "login-expired"
              ? "login-expired"
              : "risk-control";
      return { reason, evidence: `chat-scoped banner matched ${structural.matchedBy}` };
    }
  }

  const text = textOf(chatRoot);
  if (text.length === 0) return null;
  for (const entry of RISK_TEXT_TOKENS) {
    if (text.includes(entry.token)) {
      return { reason: entry.reason, evidence: `chat text contains "${entry.token}"` };
    }
  }
  return null;
};

/**
 * Text of the common-phrase panel, used to decide whether a draft is present.
 *
 * Failure mode: returns `""` when the panel is closed or absent, which the
 * caller reads as "no panel contribution" rather than "no phrases exist".
 */
export const readCommonPhrasePanelText = (root: ParentNode): string => {
  const scope = findChatRoot(root) ?? root;
  let parts: readonly string[] = [];
  try {
    parts = COMMUNICATION_SELECTORS.commonPhrasePanel.candidates.flatMap((candidate) =>
      Array.from(scope.querySelectorAll(candidate)).map((element) => textOf(element)),
    );
  } catch {
    return "";
  }
  return normalizeText(parts.filter((part) => part.length > 0).join(" "));
};

/** Text of the header block only, for diagnostics (never used for matching alone). */
export const readHeaderText = (root: ParentNode): string => {
  const scope = findChatRoot(root) ?? root;
  const header = queryFirst(scope, COMMUNICATION_SELECTORS.chatHeader);
  if (header === null) return "";
  return joinedTextOf(header.element, "*");
};
