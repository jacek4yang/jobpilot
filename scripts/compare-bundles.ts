#!/usr/bin/env tsx
/**
 * Cross-session bundle comparison.
 *
 *   pnpm diag:compare <a.zip> <b.zip> [--out <dir>]
 *
 * Answers the questions the iterative live-testing loop actually asks:
 *
 *   - did the selector failure disappear?
 *   - did the workflow progress further?
 *   - did a new failure appear?
 *   - did timing regress?
 *
 * Deliberately conservative: it reports differences, and only labels a change
 * as an improvement or a regression where the evidence supports that reading.
 * A change in event counts is not by itself progress.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiagnosticEvent, DiagnosticLevel } from "../src/diagnostics/event";
import { analyzeEvents, type Finding } from "./diagnostics/analyze";
import { loadBundle, parseNdjson } from "./diagnostics/bundle-reader";

export interface CompareOptions {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly outputDir: string;
}

export interface SessionSnapshot {
  readonly label: string;
  readonly sessionId: string;
  readonly scenarioId: string | null;
  readonly appVersion: string;
  readonly gitCommit: string;
  readonly events: readonly DiagnosticEvent[];
  readonly findings: readonly Finding[];
  readonly durationMs: number;
  readonly firstFailure?: DiagnosticEvent;
  readonly stateSequence: readonly string[];
}

export type ChangeKind = "improved" | "regressed" | "changed" | "unchanged";

export interface Comparison {
  readonly kind: ChangeKind;
  readonly aspect: string;
  readonly detail: string;
}

/** Narrows a row into an event, keeping `data` because findings depend on it. */
const toEvent = (row: Record<string, unknown>): DiagnosticEvent | undefined => {
  const sequence = row["sequence"];
  const event = row["event"];
  const category = row["category"];
  const level = row["level"];
  if (typeof sequence !== "number" || typeof event !== "string") return undefined;
  if (typeof category !== "string" || typeof level !== "string") return undefined;

  const raw = row["data"];
  const data =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as NonNullable<DiagnosticEvent["data"]>)
      : undefined;

  return {
    sequence,
    sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : "",
    wallTime: typeof row["wallTime"] === "number" ? row["wallTime"] : 0,
    monotonicTime: typeof row["monotonicTime"] === "number" ? row["monotonicTime"] : 0,
    level: level as DiagnosticLevel,
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

export const loadSnapshot = (path: string, label: string): SessionSnapshot => {
  const loaded = loadBundle(new Uint8Array(readFileSync(path)));
  if (!loaded.ok) throw new Error(`${label}: ${loaded.error}`);

  const parsed = parseNdjson(loaded.bundle.files.get("events.ndjson"));
  const events = parsed.rows
    .map(toEvent)
    .filter((event): event is DiagnosticEvent => event !== undefined)
    .sort((a, b) => a.sequence - b.sequence);

  const first = events[0];
  const last = events[events.length - 1];

  return {
    label,
    sessionId: loaded.bundle.manifest.sessionId,
    scenarioId: loaded.bundle.manifest.scenarioId,
    appVersion: loaded.bundle.manifest.appVersion,
    gitCommit: loaded.bundle.manifest.gitCommit,
    events,
    findings: analyzeEvents(events).findings,
    durationMs:
      first !== undefined && last !== undefined ? last.monotonicTime - first.monotonicTime : 0,
    ...(analyzeEvents(events).firstFailure === undefined
      ? {}
      : { firstFailure: analyzeEvents(events).firstFailure }),
    stateSequence: events
      .filter((event) => event.event === "state.transition")
      .map((event) => String(event.data?.["to"] ?? ""))
      .filter((value) => value.length > 0),
  };
};

/** Compares findings by id, which is what the detectors key on. */
const compareFindings = (left: SessionSnapshot, right: SessionSnapshot): Comparison[] => {
  const leftIds = new Set(left.findings.map((finding) => finding.id));
  const rightIds = new Set(right.findings.map((finding) => finding.id));
  const out: Comparison[] = [];

  for (const id of leftIds) {
    if (rightIds.has(id)) continue;
    out.push({
      kind: "improved",
      aspect: "finding cleared",
      detail: `"${id}" was present before and is absent now. Confirm it is genuinely fixed rather than merely not exercised.`,
    });
  }

  for (const id of rightIds) {
    if (leftIds.has(id)) continue;
    const finding = right.findings.find((entry) => entry.id === id);
    out.push({
      kind: "regressed",
      aspect: "new finding",
      detail: `"${id}" (${finding?.confidence ?? "unknown"}) is new: ${finding?.title ?? ""}`,
    });
  }

  // A finding that changed confidence is worth surfacing even if the id matches.
  for (const finding of right.findings) {
    const before = left.findings.find((entry) => entry.id === finding.id);
    if (before === undefined || before.confidence === finding.confidence) continue;
    out.push({
      kind: "changed",
      aspect: "confidence changed",
      detail: `"${finding.id}" went from ${before.confidence} to ${finding.confidence}`,
    });
  }

  if (out.length === 0) {
    out.push({
      kind: "unchanged",
      aspect: "findings",
      detail: "The same findings are present in both sessions.",
    });
  }

  return out;
};

/** Progress is judged by how far through the documented lifecycle the run got. */
const LIFECYCLE: readonly string[] = [
  "idle",
  "scanning",
  "evaluating",
  "opening",
  "validating",
  "applying",
  "verifying",
  "cooldown",
];

const furthestState = (snapshot: SessionSnapshot): number => {
  let index = 0;
  for (const state of snapshot.stateSequence) {
    const found = LIFECYCLE.indexOf(state);
    if (found > index) index = found;
  }
  return index;
};

const compareProgress = (left: SessionSnapshot, right: SessionSnapshot): Comparison[] => {
  const leftReach = furthestState(left);
  const rightReach = furthestState(right);

  if (rightReach > leftReach) {
    return [
      {
        kind: "improved",
        aspect: "workflow progress",
        detail: `Reached state "${LIFECYCLE[rightReach] ?? "?"}" where the earlier run stopped at "${LIFECYCLE[leftReach] ?? "?"}".`,
      },
    ];
  }
  if (rightReach < leftReach) {
    return [
      {
        kind: "regressed",
        aspect: "workflow progress",
        detail: `Stopped at state "${LIFECYCLE[rightReach] ?? "?"}" where the earlier run reached "${LIFECYCLE[leftReach] ?? "?"}".`,
      },
    ];
  }
  return [
    {
      kind: "unchanged",
      aspect: "workflow progress",
      detail: `Both runs reached "${LIFECYCLE[rightReach] ?? "?"}".`,
    },
  ];
};

/**
 * Timing comparison.
 *
 * A 50% threshold keeps this from flagging ordinary variance as a regression;
 * the brief's point is spotting genuine timing regressions, not noise.
 */
const compareTiming = (left: SessionSnapshot, right: SessionSnapshot): Comparison[] => {
  if (left.durationMs === 0) {
    return [
      {
        kind: "unchanged",
        aspect: "timing",
        detail: "The earlier session has no measurable duration.",
      },
    ];
  }
  const delta = (right.durationMs - left.durationMs) / left.durationMs;
  const percent = `${(delta * 100).toFixed(0)}%`;

  if (delta > 0.5) {
    return [
      {
        kind: "regressed",
        aspect: "timing",
        detail: `Session duration grew ${percent} (${left.durationMs.toFixed(0)}ms to ${right.durationMs.toFixed(0)}ms).`,
      },
    ];
  }
  if (delta < -0.5) {
    return [
      {
        kind: "improved",
        aspect: "timing",
        detail: `Session duration fell ${percent} (${left.durationMs.toFixed(0)}ms to ${right.durationMs.toFixed(0)}ms).`,
      },
    ];
  }
  return [
    {
      kind: "unchanged",
      aspect: "timing",
      detail: `Session duration changed by ${percent}, within the 50% threshold.`,
    },
  ];
};

export const compareBundles = (options: CompareOptions): readonly Comparison[] => {
  const left = loadSnapshot(options.leftPath, "earlier");
  const right = loadSnapshot(options.rightPath, "later");

  const comparisons: Comparison[] = [
    ...compareFindings(left, right),
    ...compareProgress(left, right),
    ...compareTiming(left, right),
  ];

  // Different builds invalidate a direct comparison of behaviour.
  if (left.gitCommit !== right.gitCommit) {
    comparisons.push({
      kind: "changed",
      aspect: "build",
      detail: `The artifacts differ (${left.gitCommit} vs ${right.gitCommit}). Compare only where the change is expected.`,
    });
  }

  const render = (): string => {
    const lines = [
      "# Bundle comparison",
      "",
      "| | earlier | later |",
      "| --- | --- | --- |",
      `| session | ${left.sessionId} | ${right.sessionId} |`,
      `| scenario | ${left.scenarioId ?? "n/a"} | ${right.scenarioId ?? "n/a"} |`,
      `| commit | ${left.gitCommit} | ${right.gitCommit} |`,
      `| events | ${left.events.length} | ${right.events.length} |`,
      `| findings | ${left.findings.length} | ${right.findings.length} |`,
      `| duration | ${left.durationMs.toFixed(0)}ms | ${right.durationMs.toFixed(0)}ms |`,
      "",
      "## Differences",
      "",
    ];

    for (const comparison of comparisons) {
      lines.push(
        `- **${comparison.kind.toUpperCase()}** — ${comparison.aspect}: ${comparison.detail}`,
      );
    }

    lines.push(
      "",
      "## Reading this",
      "",
      "`improved` and `regressed` are assigned only where the evidence supports it.",
      "A finding that disappears may mean a fix, or merely that the scenario did not",
      "exercise it this time — check the event counts before concluding.",
      "",
    );

    return lines.join("\n");
  };

  mkdirSync(options.outputDir, { recursive: true });
  writeFileSync(join(options.outputDir, "comparison.md"), render(), "utf8");
  writeFileSync(
    join(options.outputDir, "comparison.json"),
    JSON.stringify(
      { left: { sessionId: left.sessionId }, right: { sessionId: right.sessionId }, comparisons },
      null,
      2,
    ),
    "utf8",
  );

  return comparisons;
};

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");

if (positional.length === 2) {
  const [leftPath, rightPath] = positional as [string, string];
  const outputDir = resolve(
    outIndex >= 0
      ? (args[outIndex + 1] ?? "diagnostic-analysis/compare")
      : "diagnostic-analysis/compare",
  );
  try {
    const comparisons = compareBundles({ leftPath, rightPath, outputDir });
    process.stdout.write("JobPilot bundle comparison\n");
    for (const comparison of comparisons) {
      process.stdout.write(
        `  ${comparison.kind.toUpperCase().padEnd(10)} ${comparison.aspect}: ${comparison.detail}\n`,
      );
    }
    process.stdout.write(`\nWrote ${join(outputDir, "comparison.md")}\n`);
  } catch (error) {
    process.stderr.write(
      `comparison failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export { compareFindings, compareProgress, compareTiming };
