/**
 * Diagnostic bundle exporter — the panel-side export flow.
 *
 * Connects the Diagnostics page buttons ("Export Now" / "Finish Test & Export")
 * to the real pipeline: assemble the same `BundleInputs` the analyzer expects,
 * build the ZIP with `buildBundle`, and deliver the bytes to the operator.
 *
 * Delivery strategy, in order:
 *   1. File System Access API (`showSaveFilePicker`) when the browser offers
 *      it — the operator picks the exact destination the runbook asks for.
 *   2. Anchor download fallback — works in userscript managers and browsers
 *      without the picker (e.g. Firefox-based).
 *
 * Privacy: the bundle contents pass through `buildBundle`'s redaction before
 * delivery; the exporter itself never sees unredacted secrets (config is handed
 * in and redacted inside `buildBundle`).
 */

import type { BuildInfo } from "../build-info";
import type { DiagnosticRecorder } from "../recorder";
import { type BundleHealthSummary, buildBundle } from "./bundle";

export interface BundleExporterDeps {
  readonly build: BuildInfo;
  readonly recorder: DiagnosticRecorder;
  /** Current effective configuration; redacted inside buildBundle. */
  readonly config: () => unknown;
  /** Subsystem sections merged into the bundle (queue, transactions, ...). */
  readonly sections: () => Readonly<Record<string, unknown>>;
  readonly health: () => BundleHealthSummary;
  readonly environment?: () => Readonly<Record<string, unknown>> | undefined;
  readonly now: () => number;
}

export interface BundleExportResult {
  readonly ok: boolean;
  readonly fileName?: string;
  readonly error?: string;
}

/** Delivers finished bytes to the operator. Injectable for tests. */
export type BundleDeliver = (fileName: string, bytes: Uint8Array) => Promise<void>;

interface SaveFilePickerHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

/**
 * Default delivery: picker when available, anchor download otherwise.
 *
 * A picker AbortError (operator closed the dialog) is rethrown as a plain
 * Error so the caller can surface "cancelled" instead of "failed"; any other
 * picker problem falls through to the download, which is strictly more
 * reliable than a half-working picker.
 */
export const defaultDeliver: BundleDeliver = async (fileName, bytes) => {
  const picker = (
    globalThis as {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveFilePickerHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker.call(globalThis, { suggestedName: fileName });
      const writable = await handle.createWritable();
      await writable.write(new Blob([bytes.slice().buffer as ArrayBuffer]));
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("save cancelled by operator");
      }
      // Fall through to the anchor download on any other picker failure.
    }
  }

  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a macrotask: an immediate revoke can cancel the navigation the
  // click just started in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/**
 * Builds and delivers one diagnostic bundle.
 *
 * Failure mode: returns `{ ok: false, error }` and NEVER throws — a dead
 * export button is what this module exists to prevent, so the caller always
 * gets a result it can show. Diagnostic memory is left untouched on failure
 * (the recorder's buffers are the evidence; nothing here may clear them).
 */
export const createBundleExporter = (
  deps: BundleExporterDeps,
  deliver: BundleDeliver = defaultDeliver,
): { exportBundle: () => Promise<BundleExportResult> } => ({
  exportBundle: async (): Promise<BundleExportResult> => {
    let result: ReturnType<typeof buildBundle>;
    try {
      result = buildBundle({
        build: deps.build,
        session: deps.recorder.currentSession(),
        sessionId: deps.recorder.sessionId(),
        events: deps.recorder.events(),
        criticalEvents: deps.recorder.criticalEvents(),
        stats: deps.recorder.stats(),
        sections: deps.sections(),
        health: deps.health(),
        config: deps.config(),
        environment: deps.environment?.() ?? {},
        createdAt: deps.now(),
      });
    } catch (error) {
      return { ok: false, error: `bundle build failed: ${String(error)}` };
    }

    try {
      await deliver(result.fileName, result.bytes);
      return { ok: true, fileName: result.fileName };
    } catch (error) {
      return { ok: false, fileName: result.fileName, error: String(error) };
    }
  },
});
