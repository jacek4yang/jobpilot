/**
 * Diagnostics panel section.
 *
 * Shown only in the diagnostic build (or when advanced diagnostics are
 * explicitly enabled), because a normal user should never see a developer
 * console bolted onto their job search.
 *
 * Everything it displays is read from live state it is handed, so it cannot
 * drift from the runtime: there is no parallel bookkeeping here.
 */

import type { VerificationState } from "../application/human-verification";
import type { BuildInfo } from "../diagnostics/build-info";
import type { DiagnosticRecorder } from "../diagnostics/recorder";
import type { StorageHealth } from "../diagnostics/trace";

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
  readonly currentJob?: string;
  readonly currentTransaction?: string;
  readonly lastError?: string;
  readonly lastSelectorFailure?: string;
}

/** Read-only status block plus the operator controls. */
export const renderDiagnostics = (
  doc: Document,
  input: DiagnosticsViewInput,
  callbacks: DiagnosticsCallbacks,
): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", "Diagnostics"));

  const stats = input.recorder.stats();
  const session = input.recorder.currentSession();

  const rows: readonly (readonly [string, string])[] = [
    ["Build", `${input.build.appVersion} (${input.build.channel})`],
    ["Commit", input.build.gitCommit],
    ["Session ID", input.recorder.sessionId()],
    [
      "Scenario",
      session === undefined ? "(none started)" : `${session.scenarioId} ${session.scenarioName}`,
    ],
    ["Session status", session?.status ?? "not started"],
    ["Route", input.route],
    ["State", input.state],
    ["Queue owner", input.isQueueOwner ? "this tab" : "another tab"],
    ["Storage", input.storageHealth.healthy ? "healthy" : "DEGRADED — read-only"],
    ["Human verification", input.verification.phase],
    ["Current job", input.currentJob ?? "none"],
    ["Current transaction", input.currentTransaction ?? "none"],
    ["Events recorded", String(stats.recorded)],
    ["Events retained", String(input.recorder.events().length)],
    [
      "Events dropped",
      // Surfaced prominently: an absence of evidence is only meaningful when
      // nothing was lost.
      stats.dropped > 0 ? `${stats.dropped} (${stats.truncatedBatches} batch(es))` : "0",
    ],
    ["Last error", input.lastError ?? "none"],
    ["Last selector failure", input.lastSelectorFailure ?? "none"],
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
  wrapper.append(grid);

  const actions = el(doc, "div", "jobpilot-diag-actions");
  const button = (label: string, action: () => void, variant?: string): HTMLButtonElement => {
    const node = el(doc, "button", "jobpilot-btn", label);
    node.type = "button";
    if (variant !== undefined) node.setAttribute("data-variant", variant);
    node.addEventListener("click", action);
    return node;
  };

  actions.append(
    button("Start Test Session", callbacks.startSession),
    button("Finish Test & Export", callbacks.finishAndExport, "primary"),
    button("Export Now", callbacks.exportNow),
    button("Copy Session ID", callbacks.copySessionId),
    button("Re-check Page", callbacks.recheckPage),
    button("Reset Buffers", callbacks.resetBuffers),
  );
  wrapper.append(actions);

  wrapper.append(
    el(
      doc,
      "p",
      "jobpilot-hint",
      "Reset Buffers clears diagnostic memory only. It does not touch your queue, history or settings.",
    ),
  );

  return wrapper;
};

/**
 * Reports the outcome of an export attempt.
 *
 * A failed export must never discard diagnostic memory — the operator's next
 * action depends on knowing that the evidence is still in the buffer.
 */
export const renderExportResult = (
  doc: Document,
  result: { readonly ok: boolean; readonly fileName?: string; readonly error?: string },
): HTMLElement => {
  if (result.ok) {
    const node = el(
      doc,
      "p",
      "jobpilot-message",
      `Diagnostic bundle exported: ${result.fileName ?? "downloads"} — place it in your test-results folder.`,
    );
    node.setAttribute("data-tone", "success");
    return node;
  }
  const node = el(
    doc,
    "p",
    "jobpilot-message",
    `Export failed: ${result.error ?? "unknown error"}. Diagnostic memory has been kept — retry, or use the raw JSON export.`,
  );
  node.setAttribute("data-tone", "error");
  return node;
};
