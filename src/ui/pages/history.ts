/**
 * History page renderer.
 *
 * Displays historical application records and outcomes.
 */

import { createStatusChip, el } from "../components/chips";
import { t } from "../i18n";
import type { HistoryRowView } from "../view-model";

export interface HistoryPageInput {
  readonly history: readonly HistoryRowView[];
}

export const renderHistoryPage = (doc: Document, input: HistoryPageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-history");

  if (input.history.length === 0) {
    const empty = el(doc, "div", "jobpilot-empty-state");
    empty.append(
      el(doc, "h4", "jobpilot-empty-title", t("history.emptyTitle")),
      el(doc, "p", "jobpilot-empty-sub", t("history.emptySubtitle")),
    );
    container.append(empty);
    return container;
  }

  const header = el(
    doc,
    "div",
    "jobpilot-section-title",
    t("history.countText", { count: input.history.length }),
  );
  container.append(header);

  const list = el(doc, "ul", "jobpilot-list");

  for (const row of input.history) {
    const item = el(doc, "li", "jobpilot-item-row");
    const chip = createStatusChip(doc, row.outcome);
    const main = el(doc, "div", "jobpilot-item-main");

    const title = el(doc, "div", "jobpilot-item-title", row.title);
    const meta = el(
      doc,
      "div",
      "jobpilot-item-meta",
      row.meta ? `${row.company} · ${row.meta}` : row.company,
    );

    main.append(title, meta);
    item.append(chip, main);
    list.append(item);
  }

  container.append(list);
  return container;
};
