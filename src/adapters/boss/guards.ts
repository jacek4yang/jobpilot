/**
 * Fail-closed page guards for BOSS Zhipin.
 *
 * These functions answer "should automation refuse to continue?" — and they are
 * deliberately biased towards YES.
 *
 * ============================ HONESTY NOTICE ============================
 * These guards were written WITHOUT access to the real BOSS Zhipin DOM. The
 * `data-jobpilot-guard` anchors only exist in our own synthetic fixtures under
 * `tests/fixtures/boss/`. Everything else is a heuristic guess about the live
 * site. A positive result here is a *reason to pause*, never a claim that the
 * real site was understood.
 * =======================================================================
 *
 * Design rule: a false positive costs the user a manual click ("resume"), while
 * a false negative could drive automation through a CAPTCHA or risk-control
 * interstitial. Every ambiguity therefore resolves to "blocked".
 */

import { queryFirst, SELECTORS, type SelectorEntry } from "./selectors";

/**
 * Discriminated outcome of a single guard.
 *
 * `evidence` is a short, already-redacted description of *why* the guard fired
 * so diagnostics can explain the pause without leaking page content verbatim.
 */
export type GuardSignal =
  | { readonly detected: true; readonly evidence: string }
  | { readonly detected: false; readonly evidence: "" };

const FIRED = (evidence: string): GuardSignal => ({ detected: true, evidence });
const CLEAR: GuardSignal = { detected: false, evidence: "" };

/** Hostnames this adapter claims to support. */
export const SUPPORTED_HOSTS: readonly string[] = ["zhipin.com", "www.zhipin.com"];

/** Hosts that look like BOSS subdomains (e.g. `m.zhipin.com`) but were never validated. */
export const UNVERIFIED_SUBHOST_PATTERN = /(^|\.)zhipin\.com$/i;

/**
 * Normalises a matched element into short evidence.
 *
 * Only the tag name and the selector that matched are reported — never the
 * element's text content, which on a login or CAPTCHA page can include
 * account identifiers.
 */
const describeMatch = (matchedBy: string, element: Element): string => {
  const explicit = element.getAttribute("data-jobpilot-guard");
  const id = element.id;
  const parts = [`matched ${matchedBy}`, `tag=${element.tagName.toLowerCase()}`];
  if (explicit !== null) parts.push(`guard=${explicit}`);
  if (id.length > 0) parts.push(`id=${id}`);
  return parts.join(" ");
};

/** Runs one structural guard entry over the document. */
const matchStructure = (root: ParentNode, entry: SelectorEntry): GuardSignal | null => {
  const located = queryFirst(root, entry);
  return located === null ? null : FIRED(describeMatch(located.matchedBy, located.element));
};

/**
 * Case-insensitive visible-text test used as the LAST fallback of each guard.
 *
 * Text is the weakest evidence — it can appear in help copy or a footer — so it
 * is only consulted after every structural candidate has failed.
 */
const matchText = (root: ParentNode, needles: readonly string[]): GuardSignal | null => {
  const haystack = (root.textContent ?? "").toLowerCase();
  if (haystack.length === 0) return null;
  for (const needle of needles) {
    if (haystack.includes(needle.toLowerCase())) {
      return FIRED(`text contains "${needle}"`);
    }
  }
  return null;
};

/**
 * Detects a CAPTCHA / human-verification challenge.
 *
 * Failure mode: over-reports. Any structural match, or any of the challenge
 * phrases in the visible text, blocks automation. Never throws.
 */
export const detectCaptcha = (root: ParentNode): GuardSignal => {
  const structural = matchStructure(root, SELECTORS.guards.captcha);
  if (structural !== null) return structural;
  return matchText(root, ["请完成安全验证", "请完成验证", "滑动验证", "拖动滑块", "captcha"]) ?? CLEAR;
};

/**
 * Detects a risk-control interstitial ("操作过于频繁", abnormal-traffic pages).
 *
 * Failure mode: over-reports on decorative class names such as
 * `.risk-notice`. That is intentional — a pause is cheap.
 */
export const detectRiskControl = (root: ParentNode): GuardSignal => {
  const structural = matchStructure(root, SELECTORS.guards.riskControl);
  if (structural !== null) return structural;
  return (
    matchText(root, ["操作过于频繁", "当前操作存在风险", "访问受限", "安全中心", "risk control"]) ?? CLEAR
  );
};

/**
 * Detects that the user is not (or no longer) signed in.
 *
 * Failure mode: over-reports. JobPilot never signs in on the user's behalf, so
 * a false positive only asks the user to confirm they are still logged in.
 */
export const detectLoginRequired = (root: ParentNode): GuardSignal => {
  const structural = matchStructure(root, SELECTORS.guards.loginRequired);
  if (structural !== null) return structural;
  const form = matchStructure(root, SELECTORS.guards.loginForm);
  if (form !== null) return form;
  return matchText(root, ["登录后查看", "请先登录", "登录/注册", "验证码登录"]) ?? CLEAR;
};

/**
 * Detects a genuinely empty result set.
 *
 * Failure mode: over-reports an empty page. Callers MUST only consult this
 * after parsing returned zero cards, so an over-report can never hide real
 * results (`detectBossPageKindFromSignals` enforces that ordering).
 */
export const detectEmptyResult = (root: ParentNode): GuardSignal => {
  const structural = matchStructure(root, SELECTORS.guards.emptyResult);
  if (structural !== null) return structural;
  return matchText(root, ["暂无职位", "没有找到相关职位", "换个关键词试试", "无符合条件的职位"]) ?? CLEAR;
};

/**
 * Reports whether the adapter is willing to operate on a URL.
 *
 * Only `zhipin.com` and `www.zhipin.com` are accepted. Subdomains such as
 * `m.zhipin.com` are *structurally* zhipin.com but were never inspected, so
 * they are rejected — the adapter fails closed rather than guessing at a mobile
 * DOM it has never seen.
 *
 * Failure mode: returns `false` for unparsable URLs, relative URLs and every
 * host that is not an exact match. Never throws.
 */
export const isSupportedHost = (location: { readonly href: string }): boolean => {
  try {
    const host = new URL(location.href).hostname.toLowerCase();
    return SUPPORTED_HOSTS.includes(host);
  } catch {
    return false;
  }
};

/** True when the URL is *zhipin.com-shaped* but not on the verified host list. */
export const isUnverifiedZhipinSubhost = (location: { readonly href: string }): boolean => {
  try {
    const host = new URL(location.href).hostname.toLowerCase();
    return UNVERIFIED_SUBHOST_PATTERN.test(host) && !SUPPORTED_HOSTS.includes(host);
  } catch {
    return false;
  }
};

/** Compact view of every guard, used by `detectPage()` and diagnostics. */
export interface GuardSnapshot {
  readonly captcha: GuardSignal;
  readonly riskControl: GuardSignal;
  readonly loginRequired: GuardSignal;
  readonly emptyResult: GuardSignal;
  readonly supportedHost: boolean;
}

/**
 * Runs every guard once. Pure with respect to the passed nodes: reads only,
 * never mutates the DOM, never throws.
 */
export const snapshotGuards = (
  root: ParentNode,
  location: { readonly href: string },
): GuardSnapshot => ({
  captcha: detectCaptcha(root),
  riskControl: detectRiskControl(root),
  loginRequired: detectLoginRequired(root),
  emptyResult: detectEmptyResult(root),
  supportedHost: isSupportedHost(location),
});

/**
 * Maps the highest-severity fired guard onto a pause reason.
 *
 * Severity order is fixed: CAPTCHA, then risk control, then login expiry.
 * Returns `null` when no blocking guard fired, meaning the caller may proceed.
 */
export const blockingReasonFrom = (
  snapshot: GuardSnapshot,
): "captcha" | "risk-control" | "login-expired" | null => {
  if (snapshot.captcha.detected) return "captcha";
  if (snapshot.riskControl.detected) return "risk-control";
  if (snapshot.loginRequired.detected) return "login-expired";
  return null;
};
