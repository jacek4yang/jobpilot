/**
 * Queue page renderer.
 *
 * Displays queued applications with Chinese status labels, phase info, and safe controls.
 */

import { createStatusChip, el } from "../components/chips";
import { t } from "../i18n";
import type { QueueRowView, UiCallbacks } from "../view-model";

export interface QueuePageInput {
  readonly queue: readonly QueueRowView[];
  readonly running: boolean;
  readonly paused: boolean;
  readonly callbacks: UiCallbacks;
}

export const renderQueuePage = (doc: Document, input: QueuePageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-queue");

  if (input.queue.length === 0) {
    const empty = el(doc, "div", "jobpilot-empty-state");
    empty.append(
      el(doc, "h4", "jobpilot-empty-title", t("queue.emptyTitle")),
      el(doc, "p", "jobpilot-empty-sub", t("queue.emptySubtitle")),
    );
    container.append(empty);
    return container;
  }

  const header = el(
    doc,
    "div",
    "jobpilot-section-title",
    t("queue.countText", { count: input.queue.length }),
  );
  container.append(header);

  const list = el(doc, "ul", "jobpilot-list");

  for (const item of input.queue) {
    const row = el(doc, "li", "jobpilot-item-row");
    const chip = createStatusChip(doc, item.status);
    const main = el(doc, "div", "jobpilot-item-main");

    const title = el(doc, "div", "jobpilot-item-title", item.title);
    const meta = el(
      doc,
      "div",
      "jobpilot-item-meta",
      item.detail ? `${item.company} · ${item.detail}` : item.company,
    );

    main.append(title, meta);
    row.append(chip, main);
    list.append(row);
  }

  container.append(list);
  return container;
};
