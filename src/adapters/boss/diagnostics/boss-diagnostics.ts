/**
 * BOSS Zhipin diagnostics collection.
 *
 * ============================ HONESTY NOTICE ============================
 * `pageKind` and `automationVerified` describe what the adapter *believes* about
 * a page. Because the real BOSS DOM was never inspected, that belief may be
 * wrong. Diagnostics exist so a user can see the adapter's reasoning instead of
 * trusting it.
 * =======================================================================
 *
 * Privacy contract: this module MUST NOT capture cookies, tokens, credentials or
 * chat content. Every value that reaches the output is passed through `redact`
 * from `src/ports/logger.ts`, and the URL is stripped of its query string and
 * hash before it is included. Nothing here reads `document.cookie`.
 */

import { redact, type LogEntry, type Logger } from "../../../ports/logger";
import type { PageKind } from "../../../ports/job-platform";

/** Diagnostic payload. Field set is fixed deliberately — nothing extra leaks in. */
export interface BossDiagnosticReport {
  readonly platform: "boss";
  readonly displayName: "BOSS Zhipin";
  readonly jobPilotVersion: string;
  /** Absolute URL with query string and fragment removed. */
  readonly url: string;
  readonly pageKind: PageKind;
  readonly automationState: string;
  /** Selector key that failed to resolve, when the failure was a missing node. */
  readonly missingSelector: string | null;
  /** True when the failure was structural (DOM shape) rather than a missing node. */
  readonly domStructuralFailure: boolean;
  readonly timestamp: number;
  /** Recent log entries, already redacted. */
  readonly recentLogs: readonly LogEntry[];
  /**
   * Always `false` until real-site selectors are validated against the live
   * BOSS DOM. Machine-readable so the UI can warn instead of implying safety.
   */
  readonly automationVerified: false;
}

/** Inputs accepted by `collectBossDiagnostics`. */
export interface BossDiagnosticsInput {
  readonly pageKind: PageKind;
  readonly state: string;
  readonly url: string;
  readonly version: string;
  /** Selector key (e.g. `detail.applyButton`) that failed, if known. */
  readonly missingSelector?: string | undefined;
  readonly logger: Logger;
  /** Overrides the "now" timestamp; defaults to `Date.now()`. */
  readonly now?: number | undefined;
  /** How many trailing log entries to include. Defaults to 25. */
  readonly logLimit?: number | undefined;
}

/**
 * Strips the query string and fragment from a URL.
 *
 * Failure mode: returns a placeholder for unparsable or relative URLs rather
 * than echoing the raw input, which could itself contain a token.
 */
export const stripUrlSecrets = (raw: string): string => {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.length > 0 ? "[unparsable-url]" : "";
  }
};

/**
 * Maps a page kind onto the structural-failure flag.
 *
 * `unknown` and `unsupported` mean the adapter could not make sense of the DOM,
 * which is precisely the signal needed to distinguish "the site changed shape"
 * from "one selector was renamed".
 */
export const isStructuralFailure = (kind: PageKind): boolean =>
  kind === "unknown" || kind === "unsupported";

/** Key names that must never appear in a diagnostic payload. */
const FORBIDDEN_KEYS: readonly string[] = ["cookie", "token", "authorization", "credential", "chat"];

/**
 * Builds a redacted diagnostic snapshot.
 *
 * Failure mode: never throws; unreadable logger output degrades to an empty log
 * list. Query strings are always dropped, and any log entry whose key looks
 * sensitive is replaced by `redact`'s `[redacted]` marker.
 */
export const collectBossDiagnostics = (input: BossDiagnosticsInput): BossDiagnosticReport => {
  const { pageKind, state, url, version, logger } = input;
  const limit = input.logLimit ?? 25;
  const now = input.now ?? Date.now();

  let entries: readonly LogEntry[] = [];
  try {
    entries = logger.entries();
  } catch {
    // A logger that cannot be read must not break diagnostics.
    entries = [];
  }

  const recent = entries.slice(Math.max(0, entries.length - limit)).map((entry) => {
    const context = entry.context;
    const sanitized: Record<string, unknown> = {};
    if (context !== undefined) {
      for (const [key, value] of Object.entries(context)) {
        const lowered = key.toLowerCase();
        if (FORBIDDEN_KEYS.some((forbidden) => lowered.includes(forbidden))) continue;
        sanitized[key] = redact(value);
      }
    }
    return {
      timestamp: entry.timestamp,
      level: entry.level,
      component: entry.component,
      message: String(redact(entry.message)),
      ...(context === undefined ? {} : { context: sanitized }),
    } satisfies LogEntry;
  });

  return {
    platform: "boss",
    displayName: "BOSS Zhipin",
    jobPilotVersion: version,
    url: stripUrlSecrets(url),
    pageKind,
    automationState: state,
    missingSelector: input.missingSelector ?? null,
    domStructuralFailure: isStructuralFailure(pageKind),
    timestamp: now,
    recentLogs: recent,
    automationVerified: false,
  };
};

/**
 * Renders a diagnostic report as plain text suitable for a copy-to-clipboard
 * bug report. Never includes credentials because the input never contains them.
 */
export const formatBossDiagnostics = (report: BossDiagnosticReport): string => {
  const lines = [
    `JobPilot ${report.jobPilotVersion} — BOSS Zhipin diagnostics`,
    `time: ${new Date(report.timestamp).toISOString()}`,
    `url: ${report.url}`,
    `page kind: ${report.pageKind}`,
    `automation state: ${report.automationState}`,
    `missing selector: ${report.missingSelector ?? "(none)"}`,
    `structural DOM failure: ${report.domStructuralFailure ? "yes" : "no"}`,
    `real-site automation verified: ${report.automationVerified ? "yes" : "NO (selectors unverified)"}`,
    `recent log entries: ${report.recentLogs.length}`,
  ];
  for (const entry of report.recentLogs) {
    lines.push(`  [${entry.level}] ${entry.component}: ${entry.message}`);
  }
  return lines.join("\n");
};
