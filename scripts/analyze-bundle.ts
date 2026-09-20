#!/usr/bin/env tsx
/**
 * Offline diagnostic bundle analyzer.
 *
 *   pnpm diag:analyze <bundle.zip> [--out <dir>]
 *
 * Reads a support bundle, verifies its checksums, reconstructs the timeline and
 * writes a readable report plus machine-readable summary.
 *
 * The design goal, from the phase brief: a developer should not need to read
 * thousands of events to find the primary failure. `report.md` opens with the
 * findings, most severe first, each citing the sequence numbers it came from.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticEvent } from "../src/diagnostics/event";
import { analyzeEvents, type Finding } from "./diagnostics/analyze";
import { type LoadedBundle, loadBundle, parseNdjson } from "./diagnostics/bundle-reader";

export interface AnalyzeOptions {
  readonly bundlePath: string;
  readonly outputDir: string;
}

export interface AnalyzeOutcome {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly files: readonly string[];
  readonly findingCount: number;
  readonly confirmedCount: number;
}

/**
 * Narrows a parsed NDJSON row into a DiagnosticEvent, defensively.
 *
 * `data` is copied through and re-validated rather than dropped: almost every
 * detector reads a field out of it (which effect timed out, whether a draft was
 * present, which selector purpose missed), so losing it would silently disable
 * most of the analysis while still producing a confident-looking report.
 */
const toEvent = (row: Record<string, unknown>): DiagnosticEvent | undefined => {
  const sequence = row["sequence"];
  const event = row["event"];
  const category = row["category"];
  const level = row["level"];
  if (typeof sequence !== "number") return undefined;
  if (typeof event !== "string") return undefined;
  if (typeof category !== "string") return undefined;
  if (typeof level !== "string") return undefined;

  const rawData = row["data"];
  // Shallow-validated only: the payload originates from our own redactor, so
  // deep re-validation would duplicate work without adding safety. What matters
  // is that a non-object does not become a phantom `data`.
  const data =
    typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
      ? (rawData as NonNullable<DiagnosticEvent["data"]>)
      : undefined;

  return {
    sequence,
    sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : "",
    wallTime: typeof row["wallTime"] === "number" ? row["wallTime"] : 0,
    monotonicTime: typeof row["monotonicTime"] === "number" ? row["monotonicTime"] : 0,
    level: level as DiagnosticEvent["level"],
    category: category as DiagnosticEvent["category"],
    event,
    ...(typeof row["state"] === "string" ? { state: row["state"] } : {}),
    ...(typeof row["jobId"] === "string" ? { jobId: row["jobId"] } : {}),
    ...(typeof row["queueItemId"] === "string" ? { queueItemId: row["queueItemId"] } : {}),
    ...(typeof row["transactionId"] === "string" ? { transactionId: row["transactionId"] } : {}),
    ...(typeof row["routeId"] === "string" ? { routeId: row["routeId"] } : {}),
    ...(data === undefined ? {} : { data }),
  };
};

const CONFIDENCE_MARK: Readonly<Record<Finding["confidence"], string>> = {
  confirmed: "CONFIRMED",
  likely: "LIKELY",
  unknown: "UNKNOWN",
};

const renderFindings = (findings: readonly Finding[]): string => {
  if (findings.length === 0) {
    return "No findings. That is not the same as a working scenario — check the coverage note below.\n";
  }
  return findings
    .map((finding, index) => {
      const evidence =
        finding.evidence.length > 0
          ? `\n- Evidence: sequence ${finding.evidence.join(", ")}`
          : "\n- Evidence: (none — derived from an absence)";
      return `### ${index + 1}. ${finding.title}\n\n- **${CONFIDENCE_MARK[finding.confidence]}**\n- ${finding.detail}${evidence}\n- Next: ${finding.nextStep}\n`;
    })
    .join("\n");
};

const renderReport = (
  bundle: LoadedBundle,
  events: readonly DiagnosticEvent[],
  findings: readonly Finding[],
  analysis: ReturnType<typeof analyzeEvents>,
): string => {
  const { manifest } = bundle;
  const confirmed = findings.filter((finding) => finding.confidence === "confirmed").length;
  const unknown = findings.filter((finding) => finding.confidence === "unknown").length;

  const categories = Object.entries(analysis.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join("\n");

  return `# Diagnostic analysis — ${manifest.scenarioId ?? "unknown scenario"}

| | |
| --- | --- |
| Bundle format | ${manifest.bundleFormatVersion} |
| JobPilot version | ${manifest.appVersion} |
| Commit | ${manifest.gitCommit} |
| Channel | ${manifest.channel} |
| Session | ${manifest.sessionId} |
| Scenario | ${manifest.scenarioId ?? "n/a"} ${manifest.scenarioName ?? ""} |
| Session status | ${manifest.sessionStatus ?? "unknown"} |
| Events | ${events.length} |
| Findings | ${findings.length} (${confirmed} confirmed, ${unknown} unknown) |

${bundle.warnings.length > 0 ? `> **Bundle warnings**\n>\n${bundle.warnings.map((warning) => `> - ${warning}`).join("\n")}\n` : ""}

## Findings

${renderFindings(findings)}

## First failure

${
  analysis.firstFailure === undefined
    ? "No error-level event was recorded."
    : `\`${analysis.firstFailure.event}\` (${analysis.firstFailure.category}) at sequence ${analysis.firstFailure.sequence}, wall time ${new Date(analysis.firstFailure.wallTime).toISOString()}.

\`\`\`json
${JSON.stringify(analysis.firstFailure.data ?? {}, null, 2)}
\`\`\``
}

## Event categories

| Category | Count |
| --- | --- |
${categories.length > 0 ? categories : "| (none) | 0 |"}

## Coverage

This report is derived only from what the bundle recorded. An absent event is
not evidence that the corresponding action did not happen unless the diagnostic
level was high enough to record it, and the buffers were not truncated. Check
\`summary.txt\` for the dropped-event count before drawing a conclusion from any
absence.

**No live-site verification is implied by this report.** It describes one
recorded session and nothing more.
`;
};

const renderTimeline = (events: readonly DiagnosticEvent[]): string => {
  const lines = [
    "# Timeline",
    "",
    "| seq | +ms | wall | level | category | event | state | job | txn | data |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const base = events[0]?.monotonicTime ?? 0;

  for (const event of events) {
    const data = event.data === undefined ? "" : JSON.stringify(event.data).slice(0, 120);
    lines.push(
      `| ${event.sequence} | ${(event.monotonicTime - base).toFixed(0)} | ${new Date(event.wallTime).toISOString()} | ${event.level} | ${event.category} | ${event.event} | ${event.state ?? ""} | ${event.jobId ?? ""} | ${event.transactionId ?? ""} | ${data.replace(/\|/g, "\\|")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
};

const renderSelectorReport = (events: readonly DiagnosticEvent[]): string => {
  const selectorEvents = events.filter((event) => event.category === "selector");
  const lines = [
    "# Selector report",
    "",
    `${selectorEvents.length} selector event(s).`,
    "",
    "| seq | result | purpose | details |",
    "| --- | --- | --- | --- |",
  ];

  for (const event of selectorEvents) {
    const purpose = String(event.data?.["purpose"] ?? "");
    const candidates = event.data?.["candidates"];
    const detail = Array.isArray(candidates)
      ? candidates.map((candidate) => JSON.stringify(candidate)).join("; ")
      : JSON.stringify(event.data ?? {});
    lines.push(
      `| ${event.sequence} | ${event.event} | ${purpose} | ${detail.slice(0, 300).replace(/\|/g, "\\|")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
};

const renderTransactionReport = (events: readonly DiagnosticEvent[]): string => {
  const txEvents = events.filter((event) => event.transactionId !== undefined);
  const byTransaction = new Map<string, DiagnosticEvent[]>();

  for (const event of txEvents) {
    const id = event.transactionId ?? "unknown";
    const bucket = byTransaction.get(id) ?? [];
    bucket.push(event);
    byTransaction.set(id, bucket);
  }

  const lines = ["# Transaction report", "", `${byTransaction.size} transaction(s) observed.`, ""];

  for (const [id, transactionEvents] of byTransaction) {
    lines.push(`## ${id}`, "");
    for (const event of transactionEvents) {
      lines.push(
        `- ${event.sequence}  ${event.event}${event.data === undefined ? "" : `  ${JSON.stringify(event.data)}`}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

export const analyzeBundle = (options: AnalyzeOptions): AnalyzeOutcome => {
  const bytes = new Uint8Array(readFileSync(options.bundlePath));
  const loaded = loadBundle(bytes);

  if (!loaded.ok) {
    throw new Error(`cannot analyze bundle: ${loaded.error}`);
  }

  const { bundle } = loaded;
  const parsed = parseNdjson(bundle.files.get("events.ndjson"));
  const events = parsed.rows
    .map(toEvent)
    .filter((event): event is DiagnosticEvent => event !== undefined)
    .sort((a, b) => a.sequence - b.sequence);

  const analysis = analyzeEvents(events);

  mkdirSync(options.outputDir, { recursive: true });

  const files: string[] = [];
  const write = (name: string, content: string): void => {
    const path = join(options.outputDir, name);
    writeFileSync(path, content, "utf8");
    files.push(path);
  };

  write("report.md", renderReport(bundle, events, analysis.findings, analysis));
  write("timeline.md", renderTimeline(events));
  write("selector-report.md", renderSelectorReport(events));
  write("transaction-report.md", renderTransactionReport(events));
  write(
    "machine-summary.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        bundle: {
          formatVersion: bundle.manifest.bundleFormatVersion,
          appVersion: bundle.manifest.appVersion,
          gitCommit: bundle.manifest.gitCommit,
          channel: bundle.manifest.channel,
          sessionId: bundle.manifest.sessionId,
          scenarioId: bundle.manifest.scenarioId,
          sessionStatus: bundle.manifest.sessionStatus,
        },
        eventCount: events.length,
        malformedLines: parsed.malformed,
        categoryCounts: analysis.counts,
        firstFailure:
          analysis.firstFailure === undefined
            ? null
            : {
                sequence: analysis.firstFailure.sequence,
                event: analysis.firstFailure.event,
                level: analysis.firstFailure.level,
              },
        findings: analysis.findings,
        warnings: bundle.warnings,
      },
      null,
      2,
    ),
  );

  return {
    sessionId: bundle.manifest.sessionId,
    outputDir: options.outputDir,
    files,
    findingCount: analysis.findings.length,
    confirmedCount: analysis.findings.filter((f) => f.confidence === "confirmed").length,
  };
};

const main = (): void => {
  const args = process.argv.slice(2);
  const bundlePath = args.find((arg) => !arg.startsWith("--"));

  if (bundlePath === undefined) {
    process.stderr.write("usage: pnpm diag:analyze <bundle.zip> [--out <dir>]\n");
    process.exit(1);
  }

  const outIndex = args.indexOf("--out");
  const explicitOut = outIndex >= 0 ? args[outIndex + 1] : undefined;

  try {
    const preview = loadBundle(new Uint8Array(readFileSync(bundlePath)));
    const sessionId = preview.ok ? preview.bundle.manifest.sessionId : "unknown";
    const outputDir = resolve(explicitOut ?? join("diagnostic-analysis", sessionId));

    const outcome = analyzeBundle({ bundlePath, outputDir });

    process.stdout.write("JobPilot diagnostic analysis\n");
    process.stdout.write(`  bundle     : ${bundlePath}\n`);
    process.stdout.write(`  session    : ${outcome.sessionId}\n`);
    process.stdout.write(`  output     : ${outcome.outputDir}\n`);
    process.stdout.write(
      `  findings   : ${outcome.findingCount} (${outcome.confirmedCount} confirmed)\n`,
    );
    for (const file of outcome.files) {
      process.stdout.write(`  wrote      : ${file}\n`);
    }
    process.stdout.write("\nOpen report.md first.\n");
  } catch (error) {
    process.stderr.write(
      `analysis failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
};

// Only run when invoked directly, so the module stays importable by the
// self-test and by tests. Comparing the resolved entry path is more reliable
// than a suffix match, which breaks under tsx and under a different cwd.
const isEntryPoint = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main();
}

export { main, renderReport, renderSelectorReport, renderTimeline, renderTransactionReport };
