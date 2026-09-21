/**
 * Matches page renderer.
 *
 * Displays evaluated jobs with calm, non-stressful scoring and clear explanations.
 */

import { createReasonChip, createScoreBadge, el } from "../components/chips";
import { t } from "../i18n";
import type { MatchRowView, UiCallbacks } from "../view-model";

export interface MatchesPageInput {
  readonly matches: readonly MatchRowView[];
  readonly callbacks: UiCallbacks;
}

export const renderMatchesPage = (doc: Document, input: MatchesPageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-matches");

  if (input.matches.length === 0) {
    const empty = el(doc, "div", "jobpilot-empty-state");
    empty.append(
      el(doc, "h4", "jobpilot-empty-title", t("matches.emptyTitle")),
      el(doc, "p", "jobpilot-empty-sub", t("matches.emptySubtitle")),
    );
    container.append(empty);
    return container;
  }

  const summary = el(
    doc,
    "div",
    "jobpilot-section-title",
    t("matches.countSummary", { count: input.matches.length }),
  );
  container.append(summary);

  const list = el(doc, "div", "jobpilot-matches-list");

  for (const match of input.matches) {
    const card = el(doc, "div", "jobpilot-match-card");

    const header = el(doc, "div", "jobpilot-match-header");
    const title = el(doc, "div", "jobpilot-match-title", match.title);
    const score = createScoreBadge(doc, match.score, match.accepted);

    header.append(title, score);

    const meta = el(
      doc,
      "div",
      "jobpilot-match-meta",
      match.meta ? `${match.company} · ${match.meta}` : match.company,
    );

    card.append(header, meta);

    if (match.reasons.length > 0) {
      const reasonsContainer = el(doc, "div", "jobpilot-match-reasons");
      for (const reason of match.reasons) {
        reasonsContainer.append(createReasonChip(doc, reason));
      }
      card.append(reasonsContainer);
    }

    list.append(card);
  }

  container.append(list);
  return container;
};
