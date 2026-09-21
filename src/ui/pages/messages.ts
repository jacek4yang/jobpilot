/**
 * Messages template page renderer.
 */

import { el } from "../components/chips";
import { t } from "../i18n";

export const renderMessagesPage = (doc: Document): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-messages");

  const intro = el(doc, "div", "jobpilot-card");
  const title = el(doc, "h3", undefined, t("messages.title"));
  title.style.margin = "0 0 4px";
  title.style.fontSize = "14px";
  const sub = el(doc, "p", "jobpilot-field-hint", t("messages.subtitle"));
  sub.style.margin = "0 0 12px";

  const templateLabel = el(doc, "label", "jobpilot-field-label", t("messages.templateLabel"));
  const textarea = el(doc, "textarea", "jobpilot-textarea") as HTMLTextAreaElement;
  textarea.value = t("messages.templateDefault");
  textarea.rows = 3;

  const varsHint = el(doc, "p", "jobpilot-field-hint", t("messages.variablesHint"));

  intro.append(title, sub, templateLabel, textarea, varsHint);
  container.append(intro);

  const previewCard = el(doc, "div", "jobpilot-card");
  const previewTitle = el(doc, "h4", undefined, t("messages.previewTitle"));
  previewTitle.style.margin = "0 0 8px";
  previewTitle.style.fontSize = "13px";

  const previewBox = el(doc, "div");
  previewBox.style.padding = "10px 12px";
  previewBox.style.background = "var(--jp-surface-soft)";
  previewBox.style.border = "1px solid var(--jp-border-subtle)";
  previewBox.style.borderRadius = "var(--jp-radius-sm)";
  previewBox.style.fontSize = "12px";
  previewBox.style.color = "var(--jp-text)";
  previewBox.textContent = "您好，我看到后端开发工程师这个职位很感兴趣，方便聊聊吗？";

  const safetyNote = el(doc, "p", "jobpilot-field-hint", t("messages.safetyNote"));
  safetyNote.style.marginTop = "8px";

  previewCard.append(previewTitle, previewBox, safetyNote);
  container.append(previewCard);

  return container;
};
