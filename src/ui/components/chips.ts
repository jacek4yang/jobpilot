/**
 * Reusable chip components (status labels, score badges, reason tags).
 */

import { t } from "../i18n";

export const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Maps raw backend status to human-readable localized label.
 */
export const localizeStatus = (status: string): string => {
  const normalized = status.toLowerCase();
  switch (normalized) {
    case "pending":
    case "waiting":
      return t("queue.statusWaiting");
    case "opening":
      return t("queue.statusOpening");
    case "validating":
    case "checking":
      return t("queue.statusChecking");
    case "contacting":
    case "preparing":
      return t("queue.statusApplying");
    case "chatting":
      return t("queue.statusChatting");
    case "completed":
    case "submitted":
      return t("queue.statusCompleted");
    case "skipped":
      return t("queue.statusSkipped");
    case "uncertain":
    case "action-required":
      return t("queue.statusUncertain");
    case "paused":
      return t("queue.statusPaused");
    case "failed":
    case "blocked":
      return t("queue.statusFailed");
    default:
      return status;
  }
};

/**
 * Creates a localized status chip element.
 */
export const createStatusChip = (doc: Document, status: string): HTMLElement => {
  const chip = el(doc, "span", "jobpilot-status-chip", localizeStatus(status));
  chip.setAttribute("data-status", status.toLowerCase());
  return chip;
};

/**
 * Creates a soft score badge.
 */
export const createScoreBadge = (doc: Document, score: number, accepted: boolean): HTMLElement => {
  const band = !accepted ? "low" : score >= 80 ? "high" : "normal";
  const label = accepted ? t("matches.scoreBadge", { score }) : t("common.none");
  const badge = el(doc, "span", "jobpilot-match-score-badge", label);
  badge.setAttribute("data-band", band);
  return badge;
};

/**
 * Creates a reason chip with +/- semantic styling.
 */
export const createReasonChip = (doc: Document, reason: string): HTMLElement => {
  const chip = el(doc, "span", "jobpilot-reason-chip", reason);
  if (reason.startsWith("+")) chip.setAttribute("data-sign", "plus");
  else if (reason.startsWith("-")) chip.setAttribute("data-sign", "minus");
  return chip;
};
