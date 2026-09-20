/**
 * Privacy gate.
 *
 * This is the test that has to be boring and absolute: an exported bundle must
 * never contain a secret, no matter which path the value took to get there.
 *
 * The method is deliberately end-to-end rather than unit-level. Asserting that
 * `redactDiagnostic` returns the right shape would pass while a *different*
 * path — a section the exporter forgets to redact, a ZIP entry built from an
 * unredacted buffer, the manifest — still leaked. So the fixtures are seeded
 * with unique sentinel strings and every byte of the finished archive is
 * searched for them.
 */
import { describe, expect, it } from "vitest";
import { createBuildInfo } from "../../../src/diagnostics/build-info";
import {
  type BundleInputs,
  type BundleResult,
  buildBundle,
} from "../../../src/diagnostics/bundle/bundle";
import { readZip } from "../../../src/diagnostics/bundle/zip";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";

/** Sentinel values. Distinctive enough that a substring match is meaningful. */
const MARKERS = {
  cookie: "FAKE_COOKIE_SECRET",
  authToken: "FAKE_AUTH_TOKEN",
  resume: "FAKE_RESUME_TEXT",
  chat: "FAKE_PRIVATE_CHAT_TEXT",
  password: "FAKE_PASSWORD",
} as const;

const ALL_MARKERS: readonly string[] = Object.values(MARKERS);

/** Values that carry no secret and must survive, so redaction is not a blanket drop. */
const INNOCUOUS = {
  jobId: "job-42",
  score: 87,
  accepted: true,
  city: "Shanghai",
} as const;

const NOW = 1_700_000_000_000;
const SESSION_ID = "s20260101000000-abcdef";

/**
 * A realistic diagnostic payload.
 *
 * Nested two levels deep with plausible key names, because the realistic
 * failure mode is a value hidden below the top level rather than one at it.
 */
const sensitivePayload = (): Record<string, unknown> => ({
  job: {
    id: INNOCUOUS.jobId,
    city: INNOCUOUS.city,
    score: INNOCUOUS.score,
    accepted: INNOCUOUS.accepted,
  },
  request: {
    headers: {
      cookie: MARKERS.cookie,
      authorization: `Bearer ${MARKERS.authToken}`,
      token: MARKERS.authToken,
    },
    body: {
      // Not a key the redactor recognises by name: this exercises the
      // string-scanning path rather than the key-name path.
      note: `session token=${MARKERS.authToken}`,
      password: MARKERS.password,
    },
  },
  profile: {
    resumeText: MARKERS.resume,
    summary: `candidate resume: ${MARKERS.resume}`,
  },
  conversation: {
    chatContent: MARKERS.chat,
    messageBody: MARKERS.chat,
    draftText: MARKERS.chat,
  },
  userDraft: MARKERS.chat,
});

const makeRecorder = () =>
  createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 1_000,
    capacity: 500,
    minLevel: "trace",
  });

/** Assembles a bundle from a recorder's retained events. */
const bundleFrom = (recorder: ReturnType<typeof makeRecorder>, config: unknown): BundleResult => {
  const events = recorder.events();
  const input: BundleInputs = {
    build: createBuildInfo({ channel: "diagnostic", gitCommit: "unknown" }),
    session: undefined,
    sessionId: SESSION_ID,
    events,
    criticalEvents: recorder.criticalEvents(),
    stats: recorder.stats(),
    sections: {},
    health: { storageHealthy: true, humanVerificationEncountered: false },
    config,
    environment: { userAgent: "test", viewport: { width: 1280, height: 720 } },
    createdAt: NOW,
  };
  return buildBundle(input);
};

/** Every text file in the bundle, plus the ZIP entry list. */
const allContent = (bundle: BundleResult): string =>
  bundle.files.map((file) => `${file.path}\n${file.content}`).join("\n");

describe("diagnostic privacy", () => {
  describe("write-time redaction", () => {
    it("does not retain any seeded marker in the recorder's event stream", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());

      const serialised = JSON.stringify(recorder.events());
      for (const marker of ALL_MARKERS) {
        expect(serialised, `marker leaked into events(): ${marker}`).not.toContain(marker);
      }
    });

    it("does not retain the auth token nested inside an object", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());

      // Checked separately from the loop above: this is the specific nesting
      // the brief calls out, and it must not be covered only incidentally.
      const serialised = JSON.stringify(recorder.events());
      expect(serialised).not.toContain(MARKERS.authToken);
      // The enclosing key survives as evidence, so we know it was inspected.
      expect(serialised).toContain("headers");
    });

    it("keeps innocuous values, so redaction is not a blanket drop", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());

      const serialised = JSON.stringify(recorder.events());
      expect(serialised).toContain(INNOCUOUS.jobId);
      expect(serialised).toContain(INNOCUOUS.city);
      expect(serialised).toContain(String(INNOCUOUS.score));
    });
  });

  describe("exported bundle", () => {
    it("contains no marker in any bundle file", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());
      const bundle = bundleFrom(recorder, sensitivePayload());

      const content = allContent(bundle);
      for (const marker of ALL_MARKERS) {
        expect(content, `marker leaked into a bundle file: ${marker}`).not.toContain(marker);
      }
    });

    it("contains no marker in the ZIP bytes themselves", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());
      const bundle = bundleFrom(recorder, sensitivePayload());

      // Catches an entry that escaped the file-level assertions — for example a
      // buffer assembled from unredacted data and never exposed via `files`.
      const latin1 = Buffer.from(bundle.bytes).toString("latin1");
      for (const marker of ALL_MARKERS) {
        expect(latin1, `marker leaked into the raw zip bytes: ${marker}`).not.toContain(marker);
      }
    });

    it("contains no marker in config.redacted.json", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());
      const bundle = bundleFrom(recorder, sensitivePayload());

      const entry = bundle.files.find((file) => file.path.endsWith("config.redacted.json"));
      expect(entry).toBeDefined();
      for (const marker of ALL_MARKERS) {
        expect(
          entry?.content ?? "",
          `marker leaked into config.redacted.json: ${marker}`,
        ).not.toContain(marker);
      }
    });

    it("still exports innocuous config values", () => {
      const recorder = makeRecorder();
      const bundle = bundleFrom(recorder, {
        automation: { mode: "assist", minActionDelayMs: 1200 },
        jobId: INNOCUOUS.jobId,
      });

      const entry = bundle.files.find((file) => file.path.endsWith("config.redacted.json"));
      // A redaction pass that dropped the entire config would pass the leak
      // assertions above while making the bundle useless.
      expect(entry?.content ?? "").toContain("assist");
      expect(entry?.content ?? "").toContain("1200");
    });

    it("is readable back from its own ZIP bytes without exposing a marker", () => {
      const recorder = makeRecorder();
      recorder.infoEvent("communication", "send.attempt", sensitivePayload());
      const bundle = bundleFrom(recorder, sensitivePayload());

      const entries = readZip(bundle.bytes);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        for (const marker of ALL_MARKERS) {
          expect(
            entry.content,
            `marker leaked via zip entry ${entry.path}: ${marker}`,
          ).not.toContain(marker);
        }
      }
    });
  });
});
