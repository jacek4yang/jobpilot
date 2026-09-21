/**
 * BOSS Zhipin page classification.
 *
 * ============================ HONESTY NOTICE ============================
 * Classification here is tuned against the synthetic fixtures in
 * `tests/fixtures/boss/`, not against the real site. Passing every unit test
 * proves the ordering logic is internally consistent — it does NOT prove the
 * classifier recognises live BOSS pages. Real-site DOM recognition is
 * unverified.
 * =======================================================================
 *
 * The ordering below is a precedence chain, not a set of independent checks:
 * a CAPTCHA page also contains a login link, and an empty-result page also
 * contains a job-list root. Evaluating them out of order would misclassify.
 *
 *     unsupported-host   (safety gate: checked before ALL structural evidence)
 *       -> captcha
 *         -> risk-control
 *           -> login-required
 *             -> job-detail
 *               -> job-list
 *                 -> empty-result
 *                   -> unknown
 */

import type { PageKind } from "../../../ports/job-platform";
import { isSupportedHost } from "../guards";
import { queryFirst, SELECTORS } from "../selectors";

/**
 * Minimal, DOM-free evidence set driving classification.
 *
 * Kept as a plain object so the precedence chain can be unit-tested
 * exhaustively (2^n combinations) with no DOM at all.
 */
export interface PageKindSignals {
  readonly captcha: boolean;
  readonly riskControl: boolean;
  readonly loginRequired: boolean;
  readonly hasJobDetailRoot: boolean;
  readonly hasJobListRoot: boolean;
  /** Number of job cards parsed from the list root. */
  readonly cardCount: number;
  readonly emptyResultMarker: boolean;
  readonly supportedHost: boolean;
}

/** Which inputs produced a decision, for diagnostics and template debugging. */
export type PageKindReason =
  | "captcha-guard"
  | "risk-control-guard"
  | "login-guard"
  | "detail-root-present"
  | "list-root-with-cards"
  | "empty-result-marker"
  | "zero-cards-with-empty-marker-and-no-list-root"
  | "unsupported-host"
  | "no-evidence"
  | "list-root-without-cards";

/** A classification plus the reason and evidence behind it. */
export interface PageKindDecision {
  readonly kind: PageKind;
  readonly reason: PageKindReason;
}

/**
 * Pure precedence chain over `PageKindSignals`.
 *
 * Failure mode: when no branch matches, the result is `"unknown"` — never a
 * guess. `"unknown"` and `"unsupported"` are first-class, blocking outcomes.
 */
export const detectBossPageKindFromSignals = (signals: PageKindSignals): PageKindDecision => {
  // Host support is checked FIRST, before any structural evidence. A page that
  // merely *looks* like BOSS (a clone, a mirror, a saved copy served from
  // another origin) must never be treated as BOSS, because every downstream
  // action would then run against a document we do not trust at all.
  if (!signals.supportedHost) return { kind: "unsupported", reason: "unsupported-host" };

  if (signals.captcha) return { kind: "captcha", reason: "captcha-guard" };
  if (signals.riskControl) return { kind: "unknown", reason: "risk-control-guard" };
  if (signals.loginRequired) return { kind: "login-required", reason: "login-guard" };
  if (signals.hasJobDetailRoot) return { kind: "job-detail", reason: "detail-root-present" };

  if (signals.hasJobListRoot) {
    // A list root with cards is a real result page even if a stale "no results"
    // banner is still on screen; cards always win over emptiness.
    return signals.cardCount > 0
      ? { kind: "job-list", reason: "list-root-with-cards" }
      : { kind: "empty-result", reason: "list-root-without-cards" };
  }

  if (signals.cardCount > 0) {
    // Cards without a recognised container: still unambiguously a list page.
    return { kind: "job-list", reason: "list-root-with-cards" };
  }

  if (signals.emptyResultMarker) {
    return { kind: "empty-result", reason: "zero-cards-with-empty-marker-and-no-list-root" };
  }

  return { kind: "unknown", reason: "no-evidence" };
};

/**
 * Exhaustive switch over the precedence chain.
 *
 * This exists purely as a second, independent encoding of the ordering so the
 * two can be cross-checked by tests: any future edit that reorders one without
 * the other will fail. Do NOT "simplify" it into a call to the function above —
 * that would remove the cross-check.
 */
export const classifyBySwitch = (signals: PageKindSignals): PageKindDecision => {
  const primary: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = signals.supportedHost
    ? signals.captcha
      ? 0
      : signals.riskControl
        ? 1
        : signals.loginRequired
          ? 2
          : signals.hasJobDetailRoot
            ? 3
            : signals.hasJobListRoot
              ? signals.cardCount > 0
                ? 4
                : 5
              : signals.cardCount > 0
                ? 4
                : signals.emptyResultMarker
                  ? 6
                  : 7
    : 8;

  switch (primary) {
    case 0:
      return { kind: "captcha", reason: "captcha-guard" };
    case 1:
      return { kind: "unknown", reason: "risk-control-guard" };
    case 2:
      return { kind: "login-required", reason: "login-guard" };
    case 3:
      return { kind: "job-detail", reason: "detail-root-present" };
    case 4:
      return { kind: "job-list", reason: "list-root-with-cards" };
    case 5:
      return { kind: "empty-result", reason: "list-root-without-cards" };
    case 6:
      return { kind: "empty-result", reason: "zero-cards-with-empty-marker-and-no-list-root" };
    case 7:
      return { kind: "unknown", reason: "no-evidence" };
    default:
      return { kind: "unsupported", reason: "unsupported-host" };
  }
};

/**
 * Gathers DOM evidence and classifies the page.
 *
 * Failure mode: any unreadable structure degrades to `"unknown"`. This function
 * performs no DOM writes and does not throw.
 */
export const detectBossPageKind = (root: Document, location: Location): PageKind => {
  const cardNodes = safeQueryAll(root, SELECTORS.list.card.candidates);
  const emptyMarker = queryFirst(root, SELECTORS.guards.emptyResult) !== null;

  const signals: PageKindSignals = {
    captcha: queryFirst(root, SELECTORS.guards.captcha) !== null || textHas(root, CAPTCHA_TEXT),
    riskControl:
      queryFirst(root, SELECTORS.guards.riskControl) !== null || textHas(root, RISK_TEXT),
    loginRequired:
      queryFirst(root, SELECTORS.guards.loginRequired) !== null || textHas(root, LOGIN_TEXT),
    hasJobDetailRoot: queryFirst(root, SELECTORS.guards.jobDetailRoot) !== null,
    hasJobListRoot: queryFirst(root, SELECTORS.guards.jobListRoot) !== null,
    cardCount: cardNodes.length,
    // An empty-result marker only counts when nothing else claimed the page.
    emptyResultMarker: emptyMarker,
    supportedHost: isSupportedHost(location),
  };

  return detectBossPageKindFromSignals(signals).kind;
};

/** CAPTCHA phrases, mirrored from `guards.ts` so signals stay self-contained. */
const CAPTCHA_TEXT: readonly string[] = ["请完成安全验证", "请完成验证", "滑动验证", "拖动滑块"];
const RISK_TEXT: readonly string[] = ["操作过于频繁", "当前操作存在风险", "访问受限"];
const LOGIN_TEXT: readonly string[] = ["登录后查看", "请先登录", "登录/注册"];

/** Case-insensitive text probe that never throws. */
const textHas = (root: ParentNode, needles: readonly string[]): boolean => {
  const haystack = (root.textContent ?? "").toLowerCase();
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
};

/** `querySelectorAll` across candidates, swallowing malformed-selector errors. */
const safeQueryAll = (root: ParentNode, candidates: readonly string[]): readonly Element[] => {
  for (const candidate of candidates) {
    try {
      const found = Array.from(root.querySelectorAll(candidate));
      if (found.length > 0) return found;
    } catch {}
  }
  return [];
};

export type BossPageKind =
  | "public-home"
  | "login-required"
  | "home"
  | "search"
  | "job-list"
  | "job-detail"
  | "chat"
  | "human-verification"
  | "blocked"
  | "unknown";

export interface BossDetailedPageDecision {
  readonly kind: BossPageKind;
  readonly baseKind: PageKind;
  readonly reason: string;
}

/**
 * Enhanced contextual page classifier for personal workspace.
 * Builds upon the base safety-gated `detectBossPageKind` and enriches with
 * high-level user context (chat, search, public home, human verification).
 */
export const detectBossDetailedPageKind = (
  root: Document,
  location: Location,
): BossDetailedPageDecision => {
  const baseKind = detectBossPageKind(root, location);
  const pathname = location.pathname || "";

  if (baseKind === "captcha") {
    return { kind: "human-verification", baseKind, reason: "captcha-detected" };
  }
  if (baseKind === "login-required") {
    return { kind: "login-required", baseKind, reason: "login-wall" };
  }
  if (baseKind === "unsupported") {
    return { kind: "unknown", baseKind, reason: "unsupported-host" };
  }
  if (baseKind === "job-detail") {
    return { kind: "job-detail", baseKind, reason: "job-detail-root" };
  }

  // Check chat URL or DOM
  if (
    pathname.includes("/chat") ||
    pathname.includes("/geek/chat") ||
    root.querySelector(".chat-conversation, .chat-message-list, [data-jobpilot-chat]") !== null
  ) {
    return { kind: "chat", baseKind, reason: "chat-url-or-dom" };
  }

  // Check search vs job-list
  if (baseKind === "job-list" || baseKind === "empty-result") {
    if (
      pathname.includes("/job_detail") ||
      location.search.includes("query=") ||
      pathname.includes("/web/geek/job")
    ) {
      return { kind: "search", baseKind, reason: "search-query-or-path" };
    }
    return { kind: "job-list", baseKind, reason: "list-cards" };
  }

  // Check home / public-home
  if (pathname === "/" || pathname === "" || pathname === "/web/geek/") {
    const isLoggedOut = queryFirst(root, SELECTORS.guards.loginRequired) !== null;
    return {
      kind: isLoggedOut ? "public-home" : "home",
      baseKind: isLoggedOut ? "login-required" : "unknown",
      reason: "root-home-page",
    };
  }

  return { kind: "unknown", baseKind, reason: "no-specific-evidence" };
};
