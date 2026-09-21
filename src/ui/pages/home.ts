/**
 * Calm Home Dashboard page.
 *
 * Provides a gentle, reassuring overview:
 * - Localized personal greeting (without countdown or pressure)
 * - Current activity status
 * - Blocked / human verification banner when applicable
 * - Pending decisions
 * - Clean progress indicators
 */

import { el } from "../components/chips";
import { getGreeting, t } from "../i18n";
import type {
  BlockedView,
  CurrentItemView,
  PendingDecisionView,
  StatTile,
  UiCallbacks,
} from "../view-model";

export interface HomePageInput {
  readonly displayName?: string | undefined;
  readonly state: string;
  readonly running: boolean;
  readonly paused: boolean;
  readonly message?:
    | {
        readonly tone: "info" | "warn" | "error" | "success";
        readonly text: string;
      }
    | undefined;
  readonly blocked?: BlockedView | undefined;
  readonly current?: CurrentItemView | undefined;
  readonly decisions: readonly PendingDecisionView[];
  readonly stats: readonly StatTile[];
  readonly callbacks: UiCallbacks;
  readonly isDiagnostic?: boolean | undefined;
}

export const renderHomePage = (doc: Document, input: HomePageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-home");

  // --- 1. Gentle Personalized Greeting ------------------------------------
  const greetingCard = el(doc, "div", "jobpilot-greeting-card");
  const greetingText = el(doc, "p", "jobpilot-greeting-text", getGreeting(input.displayName));
  const greetingSub = el(doc, "p", "jobpilot-greeting-sub", t("search.subtitle"));
  greetingCard.append(greetingText, greetingSub);
  container.append(greetingCard);

  // --- 2. Blocked / Human Verification Card -------------------------------
  if (input.blocked !== undefined) {
    const isVerification =
      input.blocked.reason.includes("verification") ||
      input.blocked.reason.includes("challenge") ||
      input.blocked.reason.includes("验证");

    const blockedCard = el(doc, "div", "jobpilot-blocked-card");
    blockedCard.setAttribute("role", "alert");

    const title = el(
      doc,
      "h3",
      "jobpilot-blocked-title",
      isVerification ? t("blocked.verificationTitle") : input.blocked.reason,
    );

    const body = el(
      doc,
      "div",
      "jobpilot-blocked-body",
      isVerification ? t("blocked.verificationBody") : input.blocked.body,
    );

    const actionRow = el(doc, "div", "jobpilot-blocked-actions");

    const recheckBtn = el(doc, "button", "jobpilot-btn", t("blocked.recheckButton"));
    recheckBtn.type = "button";
    recheckBtn.setAttribute("data-action", "recheck");
    recheckBtn.setAttribute("data-variant", "primary");
    recheckBtn.addEventListener("click", () => input.callbacks.recheck());
    actionRow.append(recheckBtn);

    const stopBtn = el(doc, "button", "jobpilot-btn", t("blocked.stopButton"));
    stopBtn.type = "button";
    stopBtn.setAttribute("data-variant", "danger");
    stopBtn.addEventListener("click", () => input.callbacks.stop());
    actionRow.append(stopBtn);

    blockedCard.append(title, body, actionRow);
    container.append(blockedCard);
  } else if (input.message !== undefined) {
    // Message banner
    const msg = el(doc, "div", "jobpilot-card");
    msg.style.borderLeft = `4px solid ${
      input.message.tone === "error"
        ? "var(--jp-danger)"
        : input.message.tone === "warn"
          ? "var(--jp-warning)"
          : input.message.tone === "success"
            ? "var(--jp-success)"
            : "var(--jp-primary)"
    }`;
    const text = el(doc, "p", undefined, input.message.text);
    text.style.margin = "0";
    msg.append(text);
    container.append(msg);
  }

  // --- 3. Decisions Card (e.g. uncertain send, draft detected) ------------
  if (input.decisions.length > 0) {
    const decisionWrapper = el(doc, "div", "jobpilot-section");
    decisionWrapper.append(el(doc, "span", "jobpilot-section-title", t("decisions.title")));

    for (const dec of input.decisions) {
      const card = el(doc, "div", "jobpilot-decision-card");
      const decTitle = el(doc, "div", "jobpilot-decision-title", dec.title);
      const decMsg = el(doc, "div", "jobpilot-decision-message", dec.message);
      const decActions = el(doc, "div", "jobpilot-decision-actions");

      for (const act of dec.actions) {
        const btn = el(doc, "button", "jobpilot-btn", act.label);
        btn.type = "button";
        if (act.id === "skip") btn.setAttribute("data-variant", "subtle");
        btn.addEventListener("click", () => {
          // Action resolution
        });
        decActions.append(btn);
      }

      card.append(decTitle, decMsg, decActions);
      decisionWrapper.append(card);
    }
    container.append(decisionWrapper);
  }

  // --- 4. Current Activity Card -------------------------------------------
  const currentWrapper = el(doc, "div", "jobpilot-section");
  currentWrapper.append(el(doc, "span", "jobpilot-section-title", t("home.currentActionTitle")));

  if (input.current !== undefined) {
    const currentCard = el(doc, "div", "jobpilot-current-card");
    const phase = el(
      doc,
      "div",
      "jobpilot-current-phase",
      `${t("home.currentPhase")}: ${input.current.phase}`,
    );
    const jobTitle = el(doc, "div", "jobpilot-current-title", input.current.title);
    const jobMeta = el(
      doc,
      "div",
      "jobpilot-current-meta",
      input.current.score === undefined
        ? input.current.company
        : `${input.current.company} · ${t("matches.scoreBadge", { score: input.current.score })}`,
    );
    currentCard.append(phase, jobTitle, jobMeta);
    currentWrapper.append(currentCard);
  } else {
    const idleCard = el(doc, "div", "jobpilot-card");
    const idleText = el(doc, "p", undefined, t("home.currentIdle"));
    idleText.style.margin = "0";
    idleText.style.color = "var(--jp-text-secondary)";
    idleCard.append(idleText);
    currentWrapper.append(idleCard);
  }
  container.append(currentWrapper);

  // --- 5. Today's Progress Numbers ----------------------------------------
  const statsWrapper = el(doc, "div", "jobpilot-section");
  statsWrapper.append(el(doc, "span", "jobpilot-section-title", t("home.todayProgress")));

  const statsGrid = el(doc, "div", "jobpilot-stats-grid");

  const statLabelsMap: Record<string, string> = {
    Scanned: t("home.scanned"),
    Accepted: t("home.accepted"),
    Applied: t("home.applied"),
    Skipped: t("home.skipped"),
    Blocked: t("home.blocked"),
    Failed: t("home.failed"),
  };

  for (const tile of input.stats) {
    // Only display primary informational cards (found, matches, queue pending, applied)
    const card = el(doc, "div", "jobpilot-stat-card");
    card.setAttribute("data-key", tile.label.toLowerCase());

    const label = el(doc, "span", "jobpilot-stat-label", statLabelsMap[tile.label] ?? tile.label);
    const value = el(doc, "span", "jobpilot-stat-value", String(tile.value));

    card.append(label, value);
    statsGrid.append(card);
  }

  statsWrapper.append(statsGrid);
  container.append(statsWrapper);

  return container;
};
