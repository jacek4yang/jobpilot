import type { AutomationContext } from "../application/state";
import { describePauseReason } from "../application/state";
import type { ApplicationRecord } from "../domain/application/application";
import type { LogEntry } from "../ports/logger";
import { PANEL_CSS } from "./styles";

export type PanelTab = "status" | "queue" | "rules" | "history" | "logs" | "settings";

export interface PanelCallbacks {
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onClearQueue: () => void;
  readonly onOpenSettings: () => void;
  readonly onExportConfig: () => void;
  readonly onImportConfig: (json: string) => void;
}

export interface PanelOptions {
  readonly document: Document;
  readonly version: string;
  readonly callbacks: PanelCallbacks;
}

export interface SettingsViewModel {
  readonly automationMode: string;
  readonly maxPerSession: number;
  readonly maxPerHour: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetries: number;
  readonly logLevel: string;
}

export interface Panel {
  readonly root: HTMLElement;
  update(
    context: AutomationContext,
    history: readonly ApplicationRecord[],
    logs: readonly LogEntry[],
  ): void;
  setPageKind(pageKind: string, supported: boolean): void;
  showToast(level: "info" | "warn" | "error", message: string): void;
  setSettings(settings: SettingsViewModel): void;
  dispose(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
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

const STATE_LABEL: Record<string, string> = {
  idle: "idle",
  scanning: "scanning",
  evaluating: "evaluating",
  opening: "opening",
  validating: "validating",
  applying: "applying",
  verifying: "verifying",
  cooldown: "cooldown",
  paused: "paused",
  blocked: "blocked",
  failed: "failed",
};

/**
 * Builds the control panel.
 *
 * The panel is presentation-only: it renders state it is handed and reports
 * user intent through callbacks. It never reaches into the automation
 * directly, which keeps the dependency direction UI -> Application.
 */
export const createPanel = (options: PanelOptions): Panel => {
  const { document: doc, callbacks } = options;

  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;

  const root = el(doc, "div", "jobpilot-root");
  root.setAttribute("data-collapsed", "false");

  // Header -----------------------------------------------------------------
  const header = el(doc, "div", "jobpilot-header");
  const title = el(doc, "span", "jobpilot-title", `JobPilot v${options.version}`);
  const badge = el(doc, "span", "jobpilot-badge", "idle");
  badge.setAttribute("data-state", "idle");
  const pageBadge = el(doc, "span", "jobpilot-badge", "page?");
  header.append(title, badge, pageBadge);
  header.addEventListener("click", () => {
    const collapsed = root.getAttribute("data-collapsed") === "true";
    root.setAttribute("data-collapsed", collapsed ? "false" : "true");
  });

  // Tabs -------------------------------------------------------------------
  const tabs: PanelTab[] = ["status", "queue", "rules", "history", "logs", "settings"];
  const tabBar = el(doc, "div", "jobpilot-tabs");
  tabBar.setAttribute("role", "tablist");
  const panels = new Map<PanelTab, HTMLElement>();
  const tabButtons = new Map<PanelTab, HTMLButtonElement>();

  for (const tab of tabs) {
    const button = el(doc, "button", "jobpilot-tab", tab);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab === "status" ? "true" : "false");
    tabBar.append(button);
    tabButtons.set(tab, button);
  }

  const body = el(doc, "div", "jobpilot-body");
  for (const tab of tabs) {
    const panel = el(doc, "div", "jobpilot-panel");
    panel.setAttribute("data-active", tab === "status" ? "true" : "false");
    panels.set(tab, panel);
    body.append(panel);
  }

  const selectTab = (active: PanelTab): void => {
    for (const [tab, button] of tabButtons) {
      button.setAttribute("aria-selected", tab === active ? "true" : "false");
      panels.get(tab)?.setAttribute("data-active", tab === active ? "true" : "false");
    }
  };
  for (const [tab, button] of tabButtons) {
    button.addEventListener("click", () => selectTab(tab));
  }

  // Status panel -----------------------------------------------------------
  const statusPanel = panels.get("status");
  const message = el(doc, "p", "jobpilot-message", "Idle");
  const statsGrid = el(doc, "div", "jobpilot-grid");
  const statValues = new Map<string, HTMLElement>();
  const statDefs: readonly (readonly [string, string])[] = [
    ["scanned", "Scanned"],
    ["accepted", "Accepted"],
    ["applied", "Applied"],
    ["skipped", "Skipped"],
    ["blocked", "Blocked"],
    ["failed", "Failed"],
  ];
  for (const [key, label] of statDefs) {
    const box = el(doc, "div", "jobpilot-stat");
    box.append(
      el(doc, "span", "jobpilot-stat-label", label),
      el(doc, "span", "jobpilot-stat-value", "0"),
    );
    const value = box.querySelector(".jobpilot-stat-value");
    if (value instanceof HTMLElement) statValues.set(key, value);
    statsGrid.append(box);
  }
  const sessionLine = el(doc, "p", "jobpilot-hint", "");
  statusPanel?.append(message, statsGrid, sessionLine);

  // Queue panel ------------------------------------------------------------
  const queuePanel = panels.get("queue");
  const queueSummary = el(doc, "p", "jobpilot-hint", "Queue empty");
  const queueList = el(doc, "ul", "jobpilot-list");
  const clearQueueBtn = el(doc, "button", "jobpilot-btn", "Clear pending");
  clearQueueBtn.type = "button";
  clearQueueBtn.addEventListener("click", () => callbacks.onClearQueue());
  queuePanel?.append(queueSummary, queueList, clearQueueBtn);

  // Rules panel ------------------------------------------------------------
  const rulesPanel = panels.get("rules");
  rulesPanel?.append(
    el(
      doc,
      "p",
      "jobpilot-hint",
      "Hard filters reject outright; soft rules add weighted score. Every decision is recorded with its reasons in History.",
    ),
  );

  // History panel ----------------------------------------------------------
  const historyPanel = panels.get("history");
  const historyList = el(doc, "ul", "jobpilot-list");
  historyPanel?.append(historyList);

  // Logs panel -------------------------------------------------------------
  const logsPanel = panels.get("logs");
  const logList = el(doc, "ul", "jobpilot-log");
  logsPanel?.append(logList);

  // Settings panel ---------------------------------------------------------
  const settingsPanel = panels.get("settings");
  const settingsSummary = el(doc, "div", "jobpilot-hint", "");
  const exportBtn = el(doc, "button", "jobpilot-btn", "Export config");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", () => callbacks.onExportConfig());
  const importArea = el(doc, "textarea", "jobpilot-textarea");
  importArea.placeholder = "Paste exported config JSON here, then press Import";
  const importBtn = el(doc, "button", "jobpilot-btn", "Import config");
  importBtn.type = "button";
  importBtn.addEventListener("click", () => {
    callbacks.onImportConfig(importArea.value);
  });
  const settingsBtn = el(doc, "button", "jobpilot-btn", "Edit settings");
  settingsBtn.type = "button";
  settingsBtn.addEventListener("click", () => callbacks.onOpenSettings());
  settingsPanel?.append(settingsSummary, settingsBtn, exportBtn, importArea, importBtn);

  // Action bar -------------------------------------------------------------
  const actions = el(doc, "div", "jobpilot-actions");
  const startBtn = el(doc, "button", "jobpilot-btn", "Start");
  startBtn.type = "button";
  startBtn.setAttribute("data-variant", "primary");
  const pauseBtn = el(doc, "button", "jobpilot-btn", "Pause");
  pauseBtn.type = "button";
  const resumeBtn = el(doc, "button", "jobpilot-btn", "Resume");
  resumeBtn.type = "button";
  const stopBtn = el(doc, "button", "jobpilot-btn", "Stop");
  stopBtn.type = "button";
  stopBtn.setAttribute("data-variant", "danger");

  startBtn.addEventListener("click", () => callbacks.onStart());
  pauseBtn.addEventListener("click", () => callbacks.onPause());
  resumeBtn.addEventListener("click", () => callbacks.onResume());
  stopBtn.addEventListener("click", () => callbacks.onStop());

  actions.append(startBtn, pauseBtn, resumeBtn, stopBtn);

  root.append(header, tabBar, body, actions);

  let toast: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    root,

    update(context, history, logs) {
      const label = STATE_LABEL[context.state] ?? context.state;
      badge.textContent = label;
      badge.setAttribute("data-state", context.state);

      if (context.pauseReason !== undefined) {
        message.textContent = describePauseReason(context.pauseReason);
        message.setAttribute("data-level", "warn");
      } else {
        message.textContent = context.lastMessage ?? "Idle";
        message.setAttribute("data-level", context.lastError === undefined ? "info" : "error");
      }

      statValues.get("scanned")?.replaceChildren(String(context.stats.scanned));
      statValues.get("accepted")?.replaceChildren(String(context.stats.accepted));
      statValues.get("applied")?.replaceChildren(String(context.stats.applied));
      statValues.get("skipped")?.replaceChildren(String(context.stats.skipped));
      statValues.get("blocked")?.replaceChildren(String(context.stats.blocked));
      statValues.get("failed")?.replaceChildren(String(context.stats.failed));
      sessionLine.textContent = `Session applications: ${context.sessionApplications}`;

      const active = [
        "scanning",
        "evaluating",
        "opening",
        "validating",
        "applying",
        "verifying",
        "cooldown",
      ].includes(context.state);
      const paused =
        context.state === "paused" || context.state === "blocked" || context.state === "failed";
      startBtn.disabled = active;
      pauseBtn.disabled = !active;
      resumeBtn.disabled = !paused;
      stopBtn.disabled = context.state === "idle";

      queueSummary.textContent =
        context.queueDepth === 0 ? "Queue empty" : `${context.queueDepth} task(s) pending`;
      queueList.replaceChildren(
        ...history
          .filter((record) => record.status === "approved" || record.status === "opened")
          .slice(0, 20)
          .map((record) => {
            const item = el(doc, "li", "jobpilot-list-item");
            item.append(
              el(doc, "div", "jobpilot-mono", String(record.jobId)),
              el(doc, "div", "jobpilot-muted", `${record.status} · score ${record.score ?? "-"}`),
            );
            return item;
          }),
      );

      // Newest first, bounded so a long session cannot bloat the DOM.
      historyList.replaceChildren(
        ...history
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 30)
          .map((record) => {
            const item = el(doc, "li", "jobpilot-list-item");
            const reason = record.reasons.at(-1);
            item.append(
              el(doc, "div", "jobpilot-mono", String(record.jobId)),
              el(
                doc,
                "div",
                "jobpilot-muted",
                `${record.status} · score ${record.score ?? "-"} · ${new Date(record.updatedAt).toLocaleTimeString()}`,
              ),
            );
            if (reason !== undefined) {
              item.append(el(doc, "div", "jobpilot-hint", reason));
            }
            return item;
          }),
      );

      logList.replaceChildren(
        ...logs
          .slice(-40)
          .reverse()
          .map((entry) => {
            const item = el(doc, "li", "jobpilot-log-item");
            item.setAttribute("data-level", entry.level);
            item.append(
              el(doc, "span", "jobpilot-log-level", entry.level),
              el(
                doc,
                "span",
                undefined,
                `${new Date(entry.timestamp).toLocaleTimeString()} ${entry.component}: ${entry.message}`,
              ),
            );
            return item;
          }),
      );
    },

    setPageKind(pageKind, supported) {
      pageBadge.textContent = pageKind;
      pageBadge.setAttribute("data-state", supported ? "idle" : "blocked");
    },

    showToast(level, msg) {
      toast?.remove();
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toast = el(doc, "div", "jobpilot-toast", msg);
      toast.setAttribute("data-level", level);
      doc.body.append(toast);
      toastTimer = setTimeout(() => {
        toast?.remove();
        toast = undefined;
      }, 6_000);
    },

    setSettings(settings) {
      settingsSummary.replaceChildren();
      const rows: readonly (readonly [string, string])[] = [
        ["Automation mode", settings.automationMode],
        ["Max per session", String(settings.maxPerSession)],
        ["Max per hour", String(settings.maxPerHour)],
        ["Delay range", `${settings.minDelayMs}-${settings.maxDelayMs} ms`],
        ["Max retries", String(settings.maxRetries)],
        ["Log level", settings.logLevel],
      ];
      for (const [key, value] of rows) {
        const row = el(doc, "div");
        row.append(
          el(doc, "span", "jobpilot-field-label", key),
          el(doc, "span", "jobpilot-muted", value),
        );
        settingsSummary.append(row);
      }
    },

    dispose() {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toast?.remove();
      toast = undefined;
      style.remove();
      root.remove();
    },
  };
};

export { PANEL_CSS };
