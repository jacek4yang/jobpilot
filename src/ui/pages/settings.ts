/**
 * Settings page renderer.
 *
 * Organizes settings into clear, calm sections:
 * - 个人化 (Personalization with displayName)
 * - 语言 (Language switcher)
 * - 界面 (Reset layout button, compact mode)
 * - 自动化 (Mode selection and acknowledgment)
 * - 安全限制 (Safety rate limits)
 * - 高级 (Reset diagnostic buffers)
 */

import type { JobPilotConfig } from "../../config/schema";
import { el } from "../components/chips";
import { getLocale, SUPPORTED_LOCALES, setLocale, t } from "../i18n";
import type { UiCallbacks } from "../view-model";

export interface SettingsPageInput {
  readonly config?: JobPilotConfig | undefined;
  readonly callbacks: UiCallbacks;
  readonly onSaveDisplayName?: ((name: string) => void) | undefined;
  readonly onResetLayout?: (() => void) | undefined;
}

export const renderSettingsPage = (doc: Document, input: SettingsPageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-settings");

  // --- 1. 个人化 (Personalization) ----------------------------------------
  const personCard = el(doc, "div", "jobpilot-card");
  const personTitle = el(doc, "h4", undefined, t("settings.personalizationTitle"));
  personTitle.style.margin = "0 0 8px";
  personTitle.style.fontSize = "13px";

  const nameLabel = el(doc, "label", "jobpilot-field-label", t("settings.displayNameLabel"));
  const nameInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  nameInput.placeholder = t("settings.displayNamePlaceholder");
  nameInput.value = input.config?.general?.displayName ?? "";

  const nameHint = el(doc, "p", "jobpilot-field-hint", t("settings.displayNameHint"));

  nameInput.addEventListener("change", () => {
    const nextName = nameInput.value.trim();
    input.onSaveDisplayName?.(nextName);
  });

  personCard.append(personTitle, nameLabel, nameInput, nameHint);
  container.append(personCard);

  // --- 2. 语言 (Language Switcher) ----------------------------------------
  const langCard = el(doc, "div", "jobpilot-card");
  const langTitle = el(doc, "h4", undefined, t("settings.languageTitle"));
  langTitle.style.margin = "0 0 8px";
  langTitle.style.fontSize = "13px";

  const langLabel = el(doc, "label", "jobpilot-field-label", t("settings.languageLabel"));
  const langSelect = el(doc, "select", "jobpilot-select") as HTMLSelectElement;

  const currentLoc = getLocale();
  for (const loc of SUPPORTED_LOCALES) {
    const opt = el(doc, "option", undefined, loc.label);
    opt.value = loc.id;
    if (loc.id === currentLoc) opt.selected = true;
    langSelect.append(opt);
  }

  langSelect.addEventListener("change", () => {
    setLocale(langSelect.value);
  });

  langCard.append(langTitle, langLabel, langSelect);
  container.append(langCard);

  // --- 3. 界面与布局 (UI & Layout) ---------------------------------------
  const uiCard = el(doc, "div", "jobpilot-card");
  const uiTitle = el(doc, "h4", undefined, t("settings.uiTitle"));
  uiTitle.style.margin = "0 0 10px";
  uiTitle.style.fontSize = "13px";

  const resetLayoutBtn = el(doc, "button", "jobpilot-btn", t("settings.resetLayoutButton"));
  resetLayoutBtn.type = "button";
  resetLayoutBtn.setAttribute("data-action", "reset-layout");
  resetLayoutBtn.addEventListener("click", () => {
    input.onResetLayout?.();
  });

  uiCard.append(uiTitle, resetLayoutBtn);
  container.append(uiCard);

  // --- 4. 自动化模式 (Automation Mode) ------------------------------------
  const autoCard = el(doc, "div", "jobpilot-card");
  const autoTitle = el(doc, "h4", undefined, t("settings.automationTitle"));
  autoTitle.style.margin = "0 0 8px";
  autoTitle.style.fontSize = "13px";

  const modeLabel = el(doc, "label", "jobpilot-field-label", t("settings.modeLabel"));
  const modeSelect = el(doc, "select", "jobpilot-select") as HTMLSelectElement;

  const modes = [
    { value: "assist", label: t("settings.modeAssistOption") },
    { value: "manual", label: t("settings.modeManualOption") },
    { value: "automatic", label: t("settings.modeAutoOption") },
  ];

  const currentMode = input.config?.automation?.mode ?? "assist";
  for (const m of modes) {
    const opt = el(doc, "option", undefined, m.label);
    opt.value = m.value;
    if (m.value === currentMode) opt.selected = true;
    modeSelect.append(opt);
  }

  autoCard.append(autoTitle, modeLabel, modeSelect);
  container.append(autoCard);

  // --- 5. 安全限制 (Limits) -----------------------------------------------
  const limitsCard = el(doc, "div", "jobpilot-card");
  const limitsTitle = el(doc, "h4", undefined, t("settings.limitsTitle"));
  limitsTitle.style.margin = "0 0 8px";
  limitsTitle.style.fontSize = "13px";

  const perSession = el(
    doc,
    "div",
    "jobpilot-field-hint",
    `${t("settings.perSessionLabel")}: ${input.config?.automation?.maxApplicationsPerSession ?? 20}`,
  );
  const perHour = el(
    doc,
    "div",
    "jobpilot-field-hint",
    `${t("settings.perHourLabel")}: ${input.config?.automation?.maxApplicationsPerHour ?? 15}`,
  );
  const delay = el(
    doc,
    "div",
    "jobpilot-field-hint",
    `${t("settings.delayLabel")}: ${input.config?.automation?.minActionDelayMs ?? 4000} - ${input.config?.automation?.maxActionDelayMs ?? 9000}`,
  );

  limitsCard.append(limitsTitle, perSession, perHour, delay);
  container.append(limitsCard);

  return container;
};
