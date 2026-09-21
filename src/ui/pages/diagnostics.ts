/**
 * Diagnostics page renderer.
 *
 * Available in the diagnostic build and for advanced inspection.
 * Displays build info, session status, events stats, and technical operator actions.
 */

import type { VerificationState } from "../../application/human-verification";
import type { BuildInfo } from "../../diagnostics/build-info";
import type { DiagnosticRecorder } from "../../diagnostics/recorder";
import type { StorageHealth } from "../../diagnostics/trace";
import { el } from "../components/chips";
import { t } from "../i18n";

export interface DiagnosticsCallbacks {
  readonly startSession: () => void;
  readonly finishAndExport: () => void;
  readonly exportNow: () => void;
  readonly copySessionId: () => void;
  readonly recheckPage: () => void;
  readonly resetBuffers: () => void;
}

export interface DiagnosticsViewInput {
  readonly build: BuildInfo;
  readonly recorder: DiagnosticRecorder;
  readonly verification: VerificationState;
  readonly storageHealth: StorageHealth;
  readonly isQueueOwner: boolean;
  readonly route: string;
  readonly state: string;
  readonly currentJob?: string | undefined;
  readonly currentTransaction?: string | undefined;
  readonly lastError?: string | undefined;
  readonly lastSelectorFailure?: string | undefined;
  /** Outcome of the most recent export attempt, rendered until the next one. */
  readonly exportResult?:
    | { readonly ok: boolean; readonly fileName?: string; readonly error?: string }
    | undefined;
}

export const renderDiagnosticsPage = (
  doc: Document,
  input: DiagnosticsViewInput,
  callbacks: DiagnosticsCallbacks,
): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-diagnostics");

  if (input.exportResult !== undefined) {
    container.append(renderExportResult(doc, input.exportResult));
  }

  const headerCard = el(doc, "div", "jobpilot-card");
  const title = el(doc, "h3", undefined, t("diagnostics.title"));
  title.style.margin = "0 0 4px";
  title.style.fontSize = "14px";
  const sub = el(doc, "p", "jobpilot-field-hint", t("diagnostics.subtitle"));
  sub.style.margin = "0";
  headerCard.append(title, sub);
  container.append(headerCard);

  const stats = input.recorder.stats();
  const session = input.recorder.currentSession();

  const rows: readonly (readonly [string, string])[] = [
    [t("diagnostics.buildLabel"), `${input.build.appVersion} (${input.build.channel})`],
    [t("diagnostics.commitLabel"), input.build.gitCommit],
    [t("diagnostics.sessionIdLabel"), input.recorder.sessionId()],
    [
      t("diagnostics.scenarioLabel"),
      session === undefined ? t("common.none") : `${session.scenarioId} ${session.scenarioName}`,
    ],
    [t("diagnostics.sessionStatusLabel"), session?.status ?? t("common.unknown")],
    [t("diagnostics.routeLabel"), input.route],
    [t("diagnostics.stateLabel"), input.state],
    [
      t("diagnostics.queueOwnerLabel"),
      input.isQueueOwner ? `${t("diagnostics.queueOwnerLabel")} (this tab)` : "another tab",
    ],
    [
      t("diagnostics.storageLabel"),
      input.storageHealth.healthy ? "healthy" : "DEGRADED — read-only",
    ],
    [t("diagnostics.verificationLabel"), input.verification.phase],
    [t("diagnostics.currentJobLabel"), input.currentJob ?? t("common.none")],
    [t("diagnostics.currentTransactionLabel"), input.currentTransaction ?? t("common.none")],
    [t("diagnostics.eventsRecordedLabel"), String(stats.recorded)],
    [t("diagnostics.eventsRetainedLabel"), String(input.recorder.events().length)],
    [
      t("diagnostics.eventsDroppedLabel"),
      stats.dropped > 0 ? `${stats.dropped} (${stats.truncatedBatches} batch(es))` : "0",
    ],
    [t("diagnostics.lastErrorLabel"), input.lastError ?? t("common.none")],
    [t("diagnostics.lastSelectorLabel"), input.lastSelectorFailure ?? t("common.none")],
  ];

  const grid = el(doc, "div", "jobpilot-diag-grid");
  for (const [label, value] of rows) {
    const row = el(doc, "div", "jobpilot-diag-row");
    row.append(
      el(doc, "span", "jobpilot-diag-label", label),
      el(doc, "span", "jobpilot-diag-value", value),
    );
    grid.append(row);
  }
  container.append(grid);

  const actions = el(doc, "div", "jobpilot-diag-actions");
  const btn = (label: string, action: () => void, variant?: string): HTMLButtonElement => {
    const node = el(doc, "button", "jobpilot-btn", label);
    node.type = "button";
    if (variant !== undefined) node.setAttribute("data-variant", variant);
    node.addEventListener("click", action);
    return node;
  };

  actions.append(
    btn(t("diagnostics.startSessionBtn"), callbacks.startSession),
    btn(t("diagnostics.finishExportBtn"), callbacks.finishAndExport, "primary"),
    btn(t("diagnostics.exportNowBtn"), callbacks.exportNow),
    btn(t("diagnostics.copySessionBtn"), callbacks.copySessionId),
    btn(t("diagnostics.recheckPageBtn"), callbacks.recheckPage),
    btn(t("diagnostics.resetBuffersBtn"), callbacks.resetBuffers),
  );
  container.append(actions);

  const hint = el(doc, "p", "jobpilot-field-hint", t("diagnostics.privacyHint"));
  container.append(hint);

  return container;
};

export const renderExportResult = (
  doc: Document,
  result: { readonly ok: boolean; readonly fileName?: string; readonly error?: string },
): HTMLElement => {
  const node = el(
    doc,
    "div",
    "jobpilot-card",
    result.ok
      ? `Diagnostic bundle exported: ${result.fileName ?? "downloads"}`
      : `Export failed: ${result.error ?? "unknown error"}`,
  );
  node.style.borderLeft = `4px solid ${result.ok ? "var(--jp-success)" : "var(--jp-danger)"}`;
  return node;
};
