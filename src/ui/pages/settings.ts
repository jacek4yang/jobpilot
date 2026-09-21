/**
 * Settings page renderer.
 *
 * Organizes settings into clear, calm sections:
 * - 个人化 (Personalization with displayName)
 * - 语言 (Language switcher)
 * - 界面 (Reset layout button, compact mode)
 * - 自动化 (Mode selection and acknowledgment)
 * - 安全限制 (Safety rate limits)
 * - 数据与备份 (Local storage, export/import, pruning, danger zone)
 */

import type { JobPilotConfig } from "../../config/schema";
import type { JobPilotBackupV1 } from "../../storage/backup/backup-service";
import { el } from "../components/chips";
import { getLocale, SUPPORTED_LOCALES, setLocale, t } from "../i18n";
import type { UiCallbacks } from "../view-model";

export interface SettingsPageInput {
  readonly config?: JobPilotConfig | undefined;
  readonly callbacks: UiCallbacks;
  readonly onSaveDisplayName?: ((name: string) => void) | undefined;
  readonly onResetLayout?: (() => void) | undefined;
  readonly storageStats?:
    | {
        readonly jobCount: number;
        readonly favoriteCount: number;
        readonly noteCount: number;
      }
    | undefined;
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

  // --- 6. 数据与备份 (Data & Backup Center) -------------------------------
  const backupCard = el(doc, "div", "jobpilot-card");
  backupCard.setAttribute("data-section", "backup");

  const backupTitle = el(doc, "h4", undefined, t("backup.title"));
  backupTitle.style.margin = "0 0 6px";
  backupTitle.style.fontSize = "13px";

  const backupDesc = el(doc, "p", "jobpilot-field-hint", t("backup.desc"));
  backupDesc.style.marginBottom = "10px";

  // Data stats
  const statsRow = el(doc, "div", "jobpilot-diag-grid");
  const stats = input.storageStats ?? { jobCount: 0, favoriteCount: 0, noteCount: 0 };

  const addStatRow = (label: string, value: number) => {
    const row = el(doc, "div", "jobpilot-diag-row");
    const l = el(doc, "span", "jobpilot-diag-label", label);
    const v = el(doc, "span", "jobpilot-diag-value", String(value));
    row.append(l, v);
    statsRow.append(row);
  };

  addStatRow(t("backup.jobsCount", { count: stats.jobCount }), stats.jobCount);
  addStatRow(t("backup.favoritesCount", { count: stats.favoriteCount }), stats.favoriteCount);
  addStatRow(t("backup.notesCount", { count: stats.noteCount }), stats.noteCount);

  // Action Buttons
  const actionsRow = el(doc, "div", "jobpilot-backup-actions");
  actionsRow.style.marginTop = "12px";
  actionsRow.style.gap = "8px";

  const exportBtn = el(doc, "button", "jobpilot-btn", t("backup.exportBtn"));
  exportBtn.type = "button";
  exportBtn.setAttribute("data-action", "export-backup");
  exportBtn.setAttribute("data-variant", "primary");
  exportBtn.addEventListener("click", () => {
    input.callbacks.onExportBackup?.();
  });

  const fileInput = el(doc, "input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".json";
  fileInput.style.display = "none";
  fileInput.setAttribute("data-action", "backup-file-input");

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as JobPilotBackupV1;
      // Default to merge mode for safety
      await input.callbacks.onImportBackup?.(parsed, "merge");
    } catch {
      // Handled in callback / error toast
    } finally {
      fileInput.value = "";
    }
  });

  const importBtn = el(doc, "button", "jobpilot-btn", t("backup.importBtn"));
  importBtn.type = "button";
  importBtn.setAttribute("data-action", "import-backup");
  importBtn.addEventListener("click", () => {
    fileInput.click();
  });

  const pruneBtn = el(doc, "button", "jobpilot-btn", t("backup.cleanBtn"));
  pruneBtn.type = "button";
  pruneBtn.setAttribute("data-action", "prune-data");
  pruneBtn.setAttribute("data-variant", "subtle");
  pruneBtn.addEventListener("click", () => {
    input.callbacks.onPruneData?.();
  });

  actionsRow.append(exportBtn, importBtn, pruneBtn, fileInput);

  // Danger Zone
  const dangerBox = el(doc, "div", "jobpilot-danger-zone");
  dangerBox.style.marginTop = "16px";
  dangerBox.style.paddingTop = "12px";
  dangerBox.style.borderTop = "1px solid var(--jp-border-subtle)";

  const dangerTitle = el(doc, "div", undefined, t("backup.dangerTitle"));
  dangerTitle.style.fontSize = "11px";
  dangerTitle.style.fontWeight = "600";
  dangerTitle.style.color = "var(--jp-danger)";
  dangerTitle.style.marginBottom = "6px";

  const clearAllBtn = el(doc, "button", "jobpilot-btn", t("backup.clearAllBtn"));
  clearAllBtn.type = "button";
  clearAllBtn.setAttribute("data-action", "clear-all-data");
  clearAllBtn.setAttribute("data-variant", "danger");
  clearAllBtn.addEventListener("click", () => {
    const confirmed =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(t("backup.clearConfirmPrompt"))
        : true;
    if (confirmed) {
      input.callbacks.onClearAllData?.();
    }
  });

  dangerBox.append(dangerTitle, clearAllBtn);

  backupCard.append(backupTitle, backupDesc, statsRow, actionsRow, dangerBox);
  container.append(backupCard);

  return container;
};
