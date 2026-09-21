/**
 * Support-bundle assembly.
 *
 * Produces a self-describing ZIP an offline analyzer can read without knowing
 * anything about this build. Three properties matter:
 *
 *  - **Self-describing.** `manifest.json` carries the format version and a
 *    checksum per file, so a bundle can be validated before it is trusted, and
 *    a future format change is detectable rather than silently misread.
 *  - **Readable first.** `summary.txt` answers "what went wrong" without
 *    opening the event log. Thousands of NDJSON lines are for the analyzer, not
 *    for the person triaging a failure.
 *  - **Safe to share.** Everything written here has already passed write-time
 *    redaction, and the config is redacted again on the way out as defence in
 *    depth.
 */

import { type BuildInfo, buildTag } from "../build-info";
import type { DiagnosticEvent } from "../event";
import { EVENTS } from "../event";
import { redactForBundle } from "../redact";
import type { DiagnosticSession } from "../session";
import { bundleFileName } from "../session";
import { sha256Hex } from "./hash";
import { createZip, type ZipResult } from "./zip";

/** Format version of the bundle layout. Mirrors `diagnosticSchemaVersion`. */
export const BUNDLE_FORMAT_VERSION = 1;

/** Version of the redaction policy, so a bundle records how it was sanitised. */
export const REDACTION_POLICY_VERSION = 1;

export const BUNDLE_ROOT = "jobpilot-diagnostic";

export interface BundleHealthSummary {
  readonly storageHealthy: boolean;
  readonly storageFailure?: string;
  readonly lockOwner?: string;
  readonly humanVerificationEncountered: boolean;
}

export interface BundleInputs {
  readonly build: BuildInfo;
  readonly session: DiagnosticSession | undefined;
  readonly sessionId: string;
  readonly events: readonly DiagnosticEvent[];
  readonly criticalEvents: readonly DiagnosticEvent[];
  readonly stats: {
    readonly recorded: number;
    readonly dropped: number;
    readonly truncatedBatches: number;
    readonly criticalDropped: number;
  };
  /** Free-form sections produced by subsystems (queue, transactions, DOM...). */
  readonly sections: Readonly<Record<string, unknown>>;
  readonly health: BundleHealthSummary;
  readonly config: unknown;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  /** Populated when a fatal error ended the session. */
  readonly fatalError?: Readonly<Record<string, unknown>>;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string;
}

export interface BundleResult {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly files: readonly BundleFile[];
  readonly manifest: Readonly<Record<string, unknown>>;
}

const stringify = (value: unknown): string => JSON.stringify(value, null, 2);

const ndjson = (rows: readonly unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");

/** Derives the single most important line of the summary. */
export const primaryFailure = (events: readonly DiagnosticEvent[]): DiagnosticEvent | undefined => {
  // Prefer an explicit fatal, then an invariant violation, then the first error.
  // The first error is the useful one: later errors are usually consequences.
  const fatal = events.find((event) => event.level === "fatal");
  if (fatal !== undefined) return fatal;
  const violation = events.find((event) => event.event === EVENTS.invariantViolation);
  if (violation !== undefined) return violation;
  return events.find((event) => event.level === "error");
};

/**
 * Builds `summary.txt`.
 *
 * Deliberately plain text: it is the file a developer opens first, often in a
 * viewer with no JSON support.
 */
export const buildSummary = (input: BundleInputs, events: readonly DiagnosticEvent[]): string => {
  const session = input.session;
  const failure = primaryFailure(events);
  const lastState = [...events].reverse().find((event) => event.state !== undefined)?.state;
  const lastRoute = [...events].reverse().find((event) => event.routeId !== undefined)?.routeId;

  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.category, (counts.get(event.category) ?? 0) + 1);
  }
  const categoryLines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `  ${category.padEnd(18)} ${count}`)
    .join("\n");

  const lines = [
    "JobPilot diagnostic summary",
    "===========================",
    "",
    `version          ${input.build.appVersion}`,
    `commit           ${input.build.gitCommit}`,
    `channel          ${input.build.channel}`,
    `built            ${input.build.buildTimestamp}`,
    `schema           ${input.build.schemaVersion} (diagnostic format ${input.build.diagnosticSchemaVersion})`,
    "",
    `scenario         ${session?.scenarioId ?? "(none)"} ${session?.scenarioName ?? ""}`.trimEnd(),
    `session          ${input.sessionId}`,
    `status           ${session?.status ?? "unknown"}`,
    `started          ${session === undefined ? "n/a" : new Date(session.startedAt).toISOString()}`,
    `exported         ${new Date(input.createdAt).toISOString()}`,
    "",
    `final state      ${lastState ?? "unknown"}`,
    `current route    ${lastRoute ?? "unknown"}`,
    `current job      ${events.filter((e) => e.jobId !== undefined).at(-1)?.jobId ?? "none"}`,
    "",
    "Health",
    `  storage        ${input.health.storageHealthy ? "healthy" : `DEGRADED_READ_ONLY (${input.health.storageFailure ?? "unknown"})`}`,
    `  queue owner    ${input.health.lockOwner ?? "none"}`,
    `  human verify   ${input.health.humanVerificationEncountered ? "encountered" : "not encountered"}`,
    "",
    "Events",
    `  recorded       ${input.stats.recorded}`,
    `  retained       ${events.length}`,
    `  dropped        ${input.stats.dropped} (${input.stats.truncatedBatches} truncation batch(es))`,
    `  critical kept  ${input.criticalEvents.length}`,
    "",
    "Categories",
    categoryLines.length > 0 ? categoryLines : "  (none)",
    "",
    "Primary failure",
  ];

  if (failure === undefined) {
    lines.push("  none recorded");
  } else {
    lines.push(
      `  event        ${failure.event}`,
      `  category     ${failure.category}`,
      `  level        ${failure.level}`,
      `  sequence     ${failure.sequence}`,
      `  wall time    ${new Date(failure.wallTime).toISOString()}`,
      `  monotonic    ${failure.monotonicTime.toFixed(1)}ms`,
      `  state        ${failure.state ?? "unknown"}`,
      `  job          ${failure.jobId ?? "none"}`,
      `  transaction  ${failure.transactionId ?? "none"}`,
      `  data         ${JSON.stringify(failure.data ?? {})}`,
    );
  }

  if (input.fatalError !== undefined) {
    lines.push("", "Fatal error", `  ${JSON.stringify(input.fatalError)}`);
  }

  lines.push(
    "",
    "See events.ndjson for the full stream, state-transitions.ndjson for the",
    "state machine trace, and run `pnpm diag:analyze <bundle.zip>` for a report.",
    "",
  );

  return lines.join("\n");
};

const README = `JobPilot diagnostic bundle
==========================

This archive contains diagnostic evidence exported by JobPilot. It is safe to
share: secrets are removed at write time, before anything reaches a buffer.

Contents
  manifest.json              format version, build identity, file checksums
  summary.txt                start here
  build.json                 exact artifact identity
  environment.json           browser and page context (no fingerprints)
  session.json               the test session that produced this bundle
  events.ndjson              the full event stream, oldest first
  state-transitions.ndjson   state machine trace
  transactions.json          communication transactions and their evidence
  selector-diagnostics.json  per-candidate selector outcomes
  dom-diagnostics.json       bounded semantic DOM evidence (no full HTML)
  storage-summary.json       persistence health and operations
  errors.json                captured errors and invariant violations
  config.redacted.json       configuration with sensitive values removed
  checksums.json             SHA-256 per file

Analysing
  pnpm diag:analyze <bundle.zip>
  pnpm diag:compare <a.zip> <b.zip>

Privacy
  Never recorded: cookies, tokens, credentials, resume text, chat content, user
  drafts, full message bodies, complete page HTML.
`;

export const buildBundle = (input: BundleInputs): BundleResult => {
  const events = input.events;

  const sections: Record<string, unknown> = {
    "build.json": {
      ...input.build,
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
    },
    "environment.json": redactForBundle(input.environment),
    "session.json": {
      sessionId: input.sessionId,
      session: input.session ?? null,
      stats: input.stats,
    },
    "events.ndjson": events,
    "state-transitions.ndjson": events.filter((event) =>
      event.event.startsWith("state.transition"),
    ),
    "errors.json": events.filter(
      (event) =>
        event.category === "error" ||
        event.level === "fatal" ||
        event.event === EVENTS.invariantViolation,
    ),
    "storage-summary.json": redactForBundle(
      input.sections["storage"] ?? { health: input.health.storageHealthy },
    ),
    "config.redacted.json": redactForBundle(input.config),
  };

  // Subsystem-supplied sections fill in queue, transactions, selectors and DOM.
  // They are redacted on the way out as a second line of defence.
  for (const [name, value] of Object.entries(input.sections)) {
    if (sections[name] !== undefined) continue;
    sections[name] = redactForBundle(value);
  }

  const files: BundleFile[] = [
    { path: `${BUNDLE_ROOT}/summary.txt`, content: buildSummary(input, events) },
    { path: `${BUNDLE_ROOT}/README.txt`, content: README },
  ];

  for (const [name, value] of Object.entries(sections)) {
    const content =
      name.endsWith(".ndjson") && Array.isArray(value) ? ndjson(value) : stringify(value);
    files.push({ path: `${BUNDLE_ROOT}/${name}`, content });
  }

  // Checksums cover every non-metadata file, so a consumer can verify that the
  // evidence it analysed is the evidence that was exported.
  const checksums: Record<string, string> = {};
  for (const file of files) {
    checksums[file.path.replace(`${BUNDLE_ROOT}/`, "")] = sha256Hex(file.content);
  }
  files.push({
    path: `${BUNDLE_ROOT}/checksums.json`,
    content: stringify({
      algorithm: "sha256",
      files: checksums,
    }),
  });

  const manifest = {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    diagnosticSchemaVersion: input.build.diagnosticSchemaVersion,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    appVersion: input.build.appVersion,
    gitCommit: input.build.gitCommit,
    buildTimestamp: input.build.buildTimestamp,
    channel: input.build.channel,
    schemaVersion: input.build.schemaVersion,
    sessionId: input.sessionId,
    scenarioId: input.session?.scenarioId ?? null,
    scenarioName: input.session?.scenarioName ?? null,
    sessionStatus: input.session?.status ?? null,
    createdAt: input.createdAt,
    files: files.map((file) => file.path.replace(`${BUNDLE_ROOT}/`, "")),
    checksums,
  };

  const allFiles: BundleFile[] = [
    { path: `${BUNDLE_ROOT}/manifest.json`, content: stringify(manifest) },
    ...files,
  ];

  const zip: ZipResult = createZip(
    allFiles.map((file) => ({
      path: file.path,
      content: file.content,
      modifiedAt: input.createdAt,
    })),
  );

  return {
    bytes: zip.bytes,
    // Deterministic, runbook-spelled filename: the operator is told exactly
    // which file to expect, so a mismatch is visible before analysis starts.
    fileName: bundleFileName({
      scenarioId: input.session?.scenarioId ?? "pre-session",
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      buildTag: buildTag(input.build),
    }),
    files: allFiles,
    manifest,
  };
};

/** Entry paths a consumer should expect. Used by schema tests and the analyzer. */
export const REQUIRED_BUNDLE_FILES: readonly string[] = [
  "manifest.json",
  "summary.txt",
  "README.txt",
  "build.json",
  "environment.json",
  "session.json",
  "events.ndjson",
  "state-transitions.ndjson",
  "errors.json",
  "storage-summary.json",
  "config.redacted.json",
  "checksums.json",
];
