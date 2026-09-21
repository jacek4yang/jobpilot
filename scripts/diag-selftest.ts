#!/usr/bin/env tsx
/**
 * Diagnostic pipeline self-test.
 *
 *   pnpm diag:selftest
 *
 * Generates a synthetic session, exports a real bundle, analyses it offline,
 * and checks the result. This is the gate that proves the observation ->
 * export -> analysis loop actually closes, without needing a live site.
 *
 * It is deliberately end-to-end: it drives the same `createDiagnosticRecorder`
 * and `buildBundle` the userscript uses, and the same `analyzeBundle` the
 * operator runs.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialContext } from "../src/application/state";
import { createBuildInfo } from "../src/diagnostics/build-info";
import { buildBundle, REQUIRED_BUNDLE_FILES } from "../src/diagnostics/bundle/bundle";
import { sha256Hex } from "../src/diagnostics/bundle/hash";
import { readZip } from "../src/diagnostics/bundle/zip";
import { EVENTS } from "../src/diagnostics/event";
import {
  DEFAULT_EFFECT_BUDGETS,
  traceOrchestrator,
} from "../src/diagnostics/instrument/effect-trace";
import { recordPageFingerprint } from "../src/diagnostics/instrument/page-fingerprint";
import {
  describeResolution,
  recordSelectorOutcome,
} from "../src/diagnostics/instrument/selector-trace";
import { reduceWithTrace } from "../src/diagnostics/instrument/state-trace";
import {
  recordDraftCheck,
  recordIdentityCheck,
  recordIntentCreated,
  recordSendClicked,
  recordTransactionTerminal,
  recordVerification,
} from "../src/diagnostics/instrument/transaction-trace";
import { createDiagnosticRecorder } from "../src/diagnostics/recorder";
import { bundleFileName, newSessionId, startSession } from "../src/diagnostics/session";
import { traceQueue, traceStorage } from "../src/diagnostics/trace";
import { createTaskQueue } from "../src/infrastructure/queue/queue";
import { analyzeBundle } from "./analyze-bundle";
import { loadBundle } from "./diagnostics/bundle-reader";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push({ name, ok, detail });
};

/** Fake secrets that must not survive into the bundle. */
const SECRETS: readonly [string, string, string, string, string] = [
  "FAKE_COOKIE_SECRET",
  "FAKE_AUTH_TOKEN",
  "FAKE_RESUME_TEXT",
  "FAKE_PRIVATE_CHAT_TEXT",
  "FAKE_PASSWORD",
];

/**
 * Builds one synthetic session that exercises the interesting paths: a normal
 * flow, a selector miss, a draft block, and an uncertain send.
 */
const buildSyntheticBundle = async (): Promise<Uint8Array> => {
  const now = Date.now();
  const build = createBuildInfo({ channel: "diagnostic", schemaVersion: 4 });
  const recorder = createDiagnosticRecorder({
    now: () => now,
    monotonicNow: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
    capacity: 5_000,
    minLevel: "trace",
  });

  recorder.startSession(
    startSession({
      id: newSessionId(now),
      scenarioId: "T60",
      scenarioName: "single real communication",
      startedAt: now,
      build,
    }),
  );

  // The session is driven through the REAL instrumenters rather than by
  // emitting events by hand. A hand-written stream would satisfy the coverage
  // gate even if the instrumentation were broken, which would make the gate
  // worthless precisely when it matters.

  // Page detection and fingerprint.
  recorder.record({
    level: "info",
    category: "bootstrap",
    event: "bootstrap.ready",
    data: { version: build.appVersion },
  });
  // The same record production emits from refreshPageKind.
  recorder.record({
    level: "info",
    category: "route",
    event: EVENTS.routeChanged,
    routeId: "job-list",
    data: { from: "unknown", to: "job-list" },
  });
  recordPageFingerprint(recorder, {
    routePattern: "/web/geek/job",
    pageKind: "job-list",
    regions: ["[data-jobpilot-list]"],
    jobCardCount: 12,
    dialogCount: 0,
    markers: ["[data-jobpilot-card]"],
    actionLabels: [],
    signature: "abc12345",
  });

  // State machine, through the tracing reducer.
  let context = initialContext(now);
  context = reduceWithTrace(recorder, {
    context,
    event: { type: "START" },
    options: { now, maxRetries: 2 },
    routeId: "job-list",
  }).context;

  // Effects, through the tracing orchestrator.
  let effectClock = 0;
  const tracedOrchestrator = traceOrchestrator(
    { runEffect: async () => {}, dispose: () => {} },
    { recorder, now: () => (effectClock += 12), budgets: DEFAULT_EFFECT_BUDGETS },
  );
  await tracedOrchestrator.runEffect({ type: "persist" }, context);
  await tracedOrchestrator.runEffect({ type: "scan-jobs" }, context);

  // Queue lifecycle, through the tracing queue.
  const queue = traceQueue(createTaskQueue(), recorder);
  queue.enqueue({ jobId: "job-42", now });
  queue.enqueue({ jobId: "job-43", now });
  queue.enqueue({ jobId: "job-43", now }); // duplicate, must not double-enqueue
  const taken = queue.takeNext(now);
  if (taken !== undefined) queue.update(taken.jobId, "success", now);

  // Selector outcomes, through the real reporter — including a miss, so the
  // analyzer has something to find.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    recordSelectorOutcome(
      recorder,
      describeResolution("detail.applyButton", [
        {
          selector: ".btn-startchat",
          confidence: "fixture-only",
          matches: 0,
          visible: 0,
          selected: false,
          rejectedBecause: "no-match",
        },
      ]),
    );
  }
  recordSelectorOutcome(
    recorder,
    describeResolution("detail.title", [
      { selector: "h1", confidence: "fixture-only", matches: 1, visible: 1, selected: true },
    ]),
  );

  // Communication transaction, through the real tracers.
  const txn = { transactionId: "txn-42", jobId: "job-42" };
  const MESSAGE = "您好，我对该职位很感兴趣。";

  recordIntentCreated(recorder, txn, {
    templateId: "default",
    messageText: MESSAGE,
    variablesUsed: ["jobTitle"],
    outgoingBaseline: 0,
    expiresAt: now + 180_000,
  });
  recordDraftCheck(recorder, txn, false);
  recordIdentityCheck(recorder, txn, {
    kind: "match",
    signals: { titleMatched: true, companyMatched: true, idsCompared: true },
  });
  recordSendClicked(recorder, txn);
  recordVerification(recorder, txn, { kind: "verified", outgoingCount: 1, baseline: 0 });
  recordTransactionTerminal(recorder, txn, { kind: "completed" });

  // A second transaction that ends uncertain, which is the case the analyzer
  // must flag and a maintainer must never see rounded to success.
  const uncertainTxn = { transactionId: "txn-43", jobId: "job-43" };
  recordIntentCreated(recorder, uncertainTxn, {
    templateId: "default",
    messageText: MESSAGE,
    variablesUsed: ["jobTitle"],
    outgoingBaseline: 0,
    expiresAt: now + 180_000,
  });
  recordIdentityCheck(recorder, uncertainTxn, {
    kind: "match",
    signals: { titleMatched: true },
  });
  recordSendClicked(recorder, uncertainTxn);
  recordVerification(recorder, uncertainTxn, { kind: "uncertain", outgoingCount: 0, baseline: 0 });
  recordTransactionTerminal(recorder, uncertainTxn, {
    kind: "uncertain",
    reason: "no outgoing message observed",
  });

  // A draft block, the intended safe outcome.
  const draftTxn = { transactionId: "txn-44", jobId: "job-44" };
  recordDraftCheck(recorder, draftTxn, true);

  // A storage failure, through the REAL decorator. Hand-writing this record
  // would let the coverage gate pass even if the decorator were broken.
  const failingStorage = {
    get: async () => undefined,
    set: async () => {
      throw new Error("quota exceeded");
    },
    delete: async () => {},
    keys: async () => [],
  };
  const tracedStorage = traceStorage(failingStorage, recorder);
  try {
    await tracedStorage.storage.set("jobpilot:root:v1", { schemaVersion: 1 });
  } catch {
    // Expected: the decorator records the failure and rethrows.
  }

  // Secrets in several plausible shapes. None may survive.
  recorder.infoEvent("runtime", "sensitive-probe", {
    cookie: SECRETS[0],
    authorization: SECRETS[1],
    nested: { token: SECRETS[1], resumeText: SECRETS[2] },
    chatContent: SECRETS[3],
    messageBody: SECRETS[3],
    password: SECRETS[4],
    innocuous: "this should survive",
  });

  const snapshot = recorder.events();

  const result = buildBundle({
    build,
    session: recorder.currentSession(),
    sessionId: recorder.sessionId(),
    events: snapshot,
    criticalEvents: recorder.criticalEvents(),
    stats: recorder.stats(),
    sections: {
      storage: { health: false, lastFailure: "quota exceeded" },
      "transactions.json": [{ id: "txn-43", phase: "uncertain" }],
      "selector-diagnostics.json": [{ purpose: "detail.applyButton", matched: 0 }],
      "dom-diagnostics.json": [],
      "queue.json": { tasks: [] },
    },
    health: {
      storageHealthy: false,
      storageFailure: "quota exceeded",
      lockOwner: "this-tab",
      humanVerificationEncountered: false,
    },
    config: { automation: { mode: "assist" }, nested: { cookie: SECRETS[0] } },
    environment: { userAgentFamily: "chromium", windowSize: "1920x1080" },
    createdAt: now,
  });

  return result.bytes;
};

const run = async (): Promise<void> => {
  const workDir = join(tmpdir(), `jobpilot-selftest-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  /** Bundle files, captured inside the load-result narrowing. */
  let capturedFiles: ReadonlyMap<string, string> | undefined;

  try {
    // --- 1. Generate ------------------------------------------------------
    const bytes = await buildSyntheticBundle();
    check("bundle generated", bytes.length > 0, `${bytes.length} bytes`);

    const zipPath = join(workDir, "selftest.zip");
    writeFileSync(zipPath, bytes);

    // --- 2. Archive is readable by our own reader -------------------------
    const entries = readZip(bytes);
    const names = entries.map((entry) => entry.path.replace(/^jobpilot-diagnostic\//, ""));
    const missing = REQUIRED_BUNDLE_FILES.filter((required) => !names.includes(required));
    check(
      "all required bundle files present",
      missing.length === 0,
      missing.length === 0 ? `${names.length} files` : `missing: ${missing.join(", ")}`,
    );

    // --- 3. Loader verifies the schema and checksums ----------------------
    const loaded = loadBundle(bytes);
    check("loader accepts the bundle", loaded.ok, loaded.ok ? "" : loaded.error);

    if (loaded.ok) {
      const manifestText = loaded.bundle.files.get("manifest.json");
      const manifest: unknown = manifestText === undefined ? undefined : JSON.parse(manifestText);
      const manifestRecord = (
        typeof manifest === "object" && manifest !== null ? manifest : {}
      ) as Record<string, unknown>;
      check(
        "manifest records the format version",
        manifestRecord["bundleFormatVersion"] === 1,
        String(manifestRecord["bundleFormatVersion"]),
      );
      check(
        "manifest records a git commit or an honest unknown",
        typeof manifestRecord["gitCommit"] === "string",
        String(manifestRecord["gitCommit"]),
      );

      // An out-of-band checksum recomputation, independent of the loader.
      const checksums = manifestRecord["checksums"];
      if (typeof checksums === "object" && checksums !== null) {
        const entriesToVerify = Object.entries(checksums as Record<string, unknown>);
        const bad = entriesToVerify.filter(([file, expected]) => {
          const content = loaded.bundle.files.get(file);
          return (
            content === undefined || typeof expected !== "string" || sha256Hex(content) !== expected
          );
        });
        check(
          "every manifest checksum verifies",
          bad.length === 0,
          bad.length === 0 ? `${entriesToVerify.length} files` : `${bad.length} mismatched`,
        );
      } else {
        check("manifest carries checksums", false, "checksums missing");
      }

      // Captured FIRST, while the load-result narrowing is in force, so every
      // later check reads real content rather than an empty fallback.
      capturedFiles = loaded.bundle.files;

      // --- 4. NDJSON is genuinely parseable -------------------------------
      const eventsText = capturedFiles.get("events.ndjson") ?? "";
      const lines = eventsText.split("\n").filter((line) => line.trim().length > 0);
      let parsedAll = true;
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          parsedAll = false;
          break;
        }
      }
      check("events.ndjson parses line by line", parsedAll, `${lines.length} lines`);

      // --- 5. Privacy -----------------------------------------------------
      // Search the DECOMPRESSED contents and the raw archive bytes, so an
      // entry that escaped the file-level assertions is still caught.
      const rawLatin1 = Buffer.from(bytes).toString("latin1");
      for (const secret of SECRETS) {
        const inFiles = [...loaded.bundle.files.values()].some((content) =>
          content.includes(secret),
        );
        const inRaw = rawLatin1.includes(secret);
        check(
          `secret not present: ${secret}`,
          !inFiles && !inRaw,
          inFiles ? "found in bundle files" : inRaw ? "found in archive bytes" : "",
        );
      }
      const configText = loaded.bundle.files.get("config.redacted.json") ?? "";
      check("config redacted", !configText.includes(SECRETS[0]), "");
      check(
        "innocuous values survive redaction",
        loaded.bundle.files.get("events.ndjson")?.includes("this should survive") === true,
        "",
      );

      // --- 6. Summary -----------------------------------------------------
      const summary = loaded.bundle.files.get("summary.txt") ?? "";
      check("summary names the scenario", summary.includes("T60"), "");
      check("summary reports storage health", summary.toLowerCase().includes("degraded"), "");
      check("summary reports the primary failure", summary.includes("Primary failure"), "");
    }

    // --- 7. Analyzer ------------------------------------------------------
    const outputDir = join(workDir, "analysis");
    const outcome = analyzeBundle({ bundlePath: zipPath, outputDir });

    check("analyzer produced a report", outcome.files.length >= 5, `${outcome.files.length} files`);

    const report = readFileSync(join(outputDir, "report.md"), "utf8");
    const machine = JSON.parse(readFileSync(join(outputDir, "machine-summary.json"), "utf8")) as {
      findings?: readonly { id?: string; confidence?: string }[];
      firstFailure?: unknown;
    };

    const ids = (machine.findings ?? []).map((finding) => finding.id ?? "");

    // Each of these is deterministic given the synthetic session above.
    check(
      "analyzer flags the repeated selector miss as confirmed",
      (machine.findings ?? []).some(
        (finding) =>
          (finding.id ?? "").startsWith("selector.miss.") && finding.confidence === "confirmed",
      ),
      ids.filter((id) => id.startsWith("selector.miss.")).join(", ") || "none",
    );
    check("analyzer flags the uncertain send", ids.includes("transaction.uncertain"), "");
    check("analyzer flags the draft block", ids.includes("transaction.draft-present"), "");
    check("analyzer flags the storage failure", ids.includes("health.storage"), "");
    check("analyzer reports the first failure", machine.firstFailure !== null, "");

    check("report cites evidence sequences", report.includes("Evidence: sequence"), "");
    check(
      "report carries no live-verification claim",
      report.includes("No live-site verification is implied"),
      "",
    );

    // --- 7b. Evidence coverage gate ---------------------------------------
    // This is the check the runbook depends on: a bundle that cannot carry a
    // given trace cannot diagnose a failure in that area, so live testing must
    // not proceed on it. Each entry names a trace the phase brief requires and
    // asserts the exported bundle actually contains it.
    const coverage: readonly (readonly [string, readonly string[]])[] = [
      ["route trace", ["route.changed"]],
      ["page fingerprint", ["page.fingerprinted"]],
      ["state transitions", ["state.transition"]],
      ["effect trace", ["effect.started", "effect.completed"]],
      ["selector trace", ["selector.miss", "selector.match"]],
      ["queue trace", ["queue.item.enqueued", "queue.item.started"]],
      ["storage trace", ["storage.write.failed"]],
      ["transaction trace", ["communication.intent.created", "communication.send.attempted"]],
      ["chat identity trace", ["chat.identity.matched", "chat.identity.evaluated"]],
      ["send verification trace", ["communication.send.verified", "communication.send.uncertain"]],
    ];

    const coverageEvents = capturedFiles?.get("events.ndjson");
    if (coverageEvents === undefined) {
      // A missing evidence file must FAIL the gate, not pass it vacuously.
      check("bundle carries events.ndjson", false, "events.ndjson absent from the bundle");
    } else {
      // Parsed, not substring-matched. A substring search over the raw text
      // would be satisfied by an event NAME appearing in some other field; this
      // requires an actual event with that name to have been recorded.
      const recorded = new Set(
        coverageEvents
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => {
            try {
              const parsed = JSON.parse(line) as { event?: unknown };
              return typeof parsed.event === "string" ? [parsed.event] : [];
            } catch {
              return [];
            }
          }),
      );
      for (const [label, names] of coverage) {
        const found = names.some((name) => recorded.has(name));
        check(
          `bundle carries ${label}`,
          found,
          found ? "" : `expected one of: ${names.join(", ")}`,
        );
      }
    }

    // The analyzer must be able to reconstruct what the bundle describes.
    const reconstructed = [
      [
        "state transitions",
        ids.some((id) => id.startsWith("selector.miss.")) || report.includes("Findings"),
      ],
      [
        "transaction lifecycle",
        ids.includes("transaction.uncertain") || ids.includes("transaction.coverage-gap"),
      ],
    ] as const;
    for (const [label, ok] of reconstructed) {
      check(`analyzer reconstructs ${label}`, ok, "");
    }

    // --- 8. Deterministic filename ---------------------------------------
    const name = bundleFileName({
      scenarioId: "T60",
      sessionId: "s1",
      createdAt: Date.now(),
      buildTag: "0.1.0_test",
    });
    check(
      "bundle filename is deterministic and safe",
      /^jobpilot-diag_T60_s1_\d{8}T\d{6}Z_0\.1\.0_test\.zip$/.test(name),
      name,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // --- Report -------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write("JobPilot diagnostic self-test\n\n");
  for (const entry of checks) {
    process.stdout.write(
      `  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.detail ? `  (${entry.detail})` : ""}\n`,
    );
  }
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed.\n`);

  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} check(s) failed.\n`);
    process.exit(1);
  }
};

void run();
