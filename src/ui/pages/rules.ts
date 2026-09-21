/**
 * Rules page renderer.
 *
 * Explains JobPilot's two-stage matching model clearly and calmly.
 */

import { el } from "../components/chips";
import { t } from "../i18n";

export const renderRulesPage = (doc: Document): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-rules");

  const intro = el(doc, "div", "jobpilot-card");
  const title = el(doc, "h3", undefined, t("rules.title"));
  title.style.margin = "0 0 4px";
  title.style.fontSize = "14px";
  const sub = el(doc, "p", "jobpilot-field-hint", t("rules.subtitle"));
  sub.style.margin = "0";
  intro.append(title, sub);
  container.append(intro);

  const hardCard = el(doc, "div", "jobpilot-card");
  const hardTitle = el(doc, "h4", undefined, t("rules.hardFiltersTitle"));
  hardTitle.style.margin = "0 0 6px";
  hardTitle.style.fontSize = "13px";
  hardTitle.style.color = "var(--jp-text)";
  const hardDesc = el(doc, "p", undefined, t("rules.hardFiltersDesc"));
  hardDesc.style.margin = "0";
  hardDesc.style.fontSize = "12px";
  hardDesc.style.color = "var(--jp-text-secondary)";
  hardDesc.style.lineHeight = "1.6";
  hardCard.append(hardTitle, hardDesc);
  container.append(hardCard);

  const softCard = el(doc, "div", "jobpilot-card");
  const softTitle = el(doc, "h4", undefined, t("rules.softScoringTitle"));
  softTitle.style.margin = "0 0 6px";
  softTitle.style.fontSize = "13px";
  softTitle.style.color = "var(--jp-text)";
  const softDesc = el(doc, "p", undefined, t("rules.softScoringDesc"));
  softDesc.style.margin = "0";
  softDesc.style.fontSize = "12px";
  softDesc.style.color = "var(--jp-text-secondary)";
  softDesc.style.lineHeight = "1.6";
  softCard.append(softTitle, softDesc);
  container.append(softCard);

  const privacyCard = el(doc, "div", "jobpilot-card");
  const privTitle = el(doc, "h4", undefined, t("rules.privacyTitle"));
  privTitle.style.margin = "0 0 6px";
  privTitle.style.fontSize = "13px";
  privTitle.style.color = "var(--jp-text)";
  const privDesc = el(doc, "p", undefined, t("rules.privacyDesc"));
  privDesc.style.margin = "0";
  privDesc.style.fontSize = "12px";
  privDesc.style.color = "var(--jp-text-secondary)";
  privDesc.style.lineHeight = "1.6";
  privacyCard.append(privTitle, privDesc);
  container.append(privacyCard);

  return container;
};
