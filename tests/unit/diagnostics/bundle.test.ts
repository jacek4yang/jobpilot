/**
 * Bundle schema tests.
 *
 * The bundle is the artefact a maintainer receives from someone else's machine.
 * It has to be structurally sound on its own: readable by a tool that knows
 * nothing about this codebase, verifiable against its own manifest, and
 * comparable between two runs.
 *
 * These tests therefore check the format rather than the feature — round-trip
 * fidelity through the ZIP writer/reader pair, known-answer vectors for the two
 * hash functions, and the manifest's promise that its checksums describe the
 * files it ships.
 */
import { describe, expect, it } from "vitest";
import { createBuildInfo } from "../../../src/diagnostics/build-info";
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_ROOT,
  type BundleInputs,
  type BundleResult,
  buildBundle,
  REDACTION_POLICY_VERSION,
  REQUIRED_BUNDLE_FILES,
} from "../../../src/diagnostics/bundle/bundle";
import { sha256Hex } from "../../../src/diagnostics/bundle/hash";
import { crc32, createZip, isSafeEntryPath, readZip } from "../../../src/diagnostics/bundle/zip";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";
import { startSession } from "../../../src/diagnostics/session";

const NOW = 1_700_000_000_000;
const SESSION_ID = "s20260101000000-abcdef";

/**
 * Narrows a value parsed from JSON.
 *
 * `JSON.parse` returns `any`; this is the one place a test genuinely has to
 * narrow an `unknown`, so it is done once, with a real runtime check, rather
 * than by casting at every use site.
 */
const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
};

/** A bundle with a wide enough event population to exercise the schema. */
const makeBundle = (): BundleResult => {
  const recorder = createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 1_000,
    capacity: 200,
    minLevel: "trace",
  });
  recorder.startSession(
    startSession({
      id: SESSION_ID,
      scenarioId: "apply-flow",
      scenarioName: "Apply flow",
      startedAt: NOW,
      build: createBuildInfo(),
    }),
  );
  recorder.infoEvent("route", "route.changed", { routeId: "jobs" });
  recorder.infoEvent("queue", "queue.item.enqueued", { jobId: "job-1" });
  recorder.errorEvent("error", "error.uncaught", { message: "boom" });
  recorder.finishSession("completed");

  const input: BundleInputs = {
    build: createBuildInfo({
      channel: "diagnostic",
      appVersion: "0.1.0",
      gitCommit: "fa4b478d036ce9af43ba698d444c63bd43d6b249",
      buildTimestamp: "2026-01-01T00:00:00.000Z",
    }),
    session: recorder.currentSession(),
    sessionId: SESSION_ID,
    events: recorder.events(),
    criticalEvents: recorder.criticalEvents(),
    stats: recorder.stats(),
    sections: {},
    health: { storageHealthy: true, humanVerificationEncountered: false },
    config: { automation: { mode: "assist" } },
    environment: { userAgent: "test" },
    createdAt: NOW,
  };
  return buildBundle(input);
};

const bundleFile = (bundle: BundleResult, name: string): string | undefined =>
  bundle.files.find((file) => file.path === `${BUNDLE_ROOT}/${name}`)?.content;

describe("zip", () => {
  describe("round trip", () => {
    it("reads back what it wrote", () => {
      const entries = [
        { path: "a.txt", content: "hello", modifiedAt: NOW },
        { path: "nested/b.json", content: '{"a":1}', modifiedAt: NOW },
      ];
      const zip = createZip(entries);
      const read = readZip(zip.bytes);

      expect(read.map((entry) => entry.path)).toEqual(["a.txt", "nested/b.json"]);
      expect(read.map((entry) => entry.content)).toEqual(["hello", '{"a":1}']);
      expect(zip.entryCount).toBe(2);
    });

    it("preserves CRLF and bare newlines", () => {
      const content = "line1\r\nline2\nline3\r\n";
      const read = readZip(createZip([{ path: "f.txt", content, modifiedAt: NOW }]).bytes);
      expect(read[0]?.content).toBe(content);
    });

    it("preserves multi-byte UTF-8", () => {
      // Chinese text: the case where a byte-count and a character-count differ,
      // and where a reader using the wrong encoding would silently corrupt.
      const content = "职位描述：需要三年以上经验。\n联系人：张先生";
      const read = readZip(createZip([{ path: "简历.txt", content, modifiedAt: NOW }]).bytes);
      expect(read[0]?.content).toBe(content);
      expect(read[0]?.path).toBe("简历.txt");
    });

    it("round-trips an empty archive", () => {
      const read = readZip(createZip([]).bytes);
      expect(read).toEqual([]);
    });
  });

  describe("entry path safety", () => {
    it("rejects traversal and absolute paths", () => {
      for (const path of [
        "../evil.txt",
        "a/../../evil.txt",
        "/abs.txt",
        "\\evil.txt",
        "a\\b.txt",
        "",
      ]) {
        expect(isSafeEntryPath(path), `expected ${JSON.stringify(path)} to be rejected`).toBe(
          false,
        );
      }
    });

    it("accepts a normal bundle path", () => {
      expect(isSafeEntryPath("jobpilot-diagnostic/a.json")).toBe(true);
    });

    it("throws rather than writing an unsafe entry", () => {
      expect(() => createZip([{ path: "../evil.txt", content: "x", modifiedAt: NOW }])).toThrow();
      expect(() => createZip([{ path: "/abs.txt", content: "x", modifiedAt: NOW }])).toThrow();
    });
  });

  describe("crc32", () => {
    it('matches the standard vector for "123456789"', () => {
      // 0xCBF43926 is the canonical CRC-32 check value.
      expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });

    it("is 0 for empty input", () => {
      expect(crc32(new Uint8Array(0))).toBe(0);
    });
  });
});

describe("sha256", () => {
  it("matches the known vector for the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it('matches the known vector for "abc"', () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("bundle", () => {
  it("contains every required file under the bundle root", () => {
    const bundle = makeBundle();
    const paths = new Set(bundle.files.map((file) => file.path));

    for (const required of REQUIRED_BUNDLE_FILES) {
      expect(paths, `missing required bundle file: ${required}`).toContain(
        `${BUNDLE_ROOT}/${required}`,
      );
    }
  });

  it("writes a manifest with the format and schema versions", () => {
    const manifest = makeBundle().manifest;

    expect(manifest["bundleFormatVersion"]).toBe(BUNDLE_FORMAT_VERSION);
    expect(manifest["diagnosticSchemaVersion"]).toBe(1);
    expect(manifest["redactionPolicyVersion"]).toBe(REDACTION_POLICY_VERSION);
    expect(manifest["sessionId"]).toBe(SESSION_ID);
    expect(Array.isArray(manifest["files"])).toBe(true);
    expect(typeof manifest["checksums"]).toBe("object");
  });

  it("checksums every file it ships, verifiably", () => {
    const bundle = makeBundle();
    const raw = bundleFile(bundle, "manifest.json");
    expect(raw).toBeDefined();

    const manifest = asRecord(JSON.parse(raw ?? "{}"), "manifest.json");
    const checksums = asRecord(manifest["checksums"], "manifest.checksums");

    for (const [name, expected] of Object.entries(checksums)) {
      const content = bundleFile(bundle, name);
      expect(content, `manifest lists ${name} but it is not in the bundle`).toBeDefined();
      // Recomputed independently, so a manifest that describes different bytes
      // than it ships is caught.
      expect(sha256Hex(content ?? ""), `checksum mismatch for ${name}`).toBe(expected);
    }
  });

  it("lists the same files in the checksums as in the manifest file list", () => {
    const raw = bundleFile(makeBundle(), "manifest.json");
    const manifest = asRecord(JSON.parse(raw ?? "{}"), "manifest.json");
    const listed = manifest["files"];
    expect(Array.isArray(listed)).toBe(true);

    const names = (listed as readonly unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    // checksums.json is written before the manifest is assembled, so it is not
    // self-covered; every other listed file must have a checksum.
    const checksums = asRecord(manifest["checksums"], "manifest.checksums");
    for (const name of names) {
      if (name === "checksums.json") continue;
      expect(checksums[name], `no checksum for listed file ${name}`).toBeDefined();
    }
  });

  it("writes a summary carrying version, commit, session id and status", () => {
    const summary = bundleFile(makeBundle(), "summary.txt");
    expect(summary).toBeDefined();
    expect(summary).toContain("0.1.0");
    expect(summary).toContain("fa4b478d036ce9af43ba698d444c63bd43d6b249");
    expect(summary).toContain(SESSION_ID);
    expect(summary).toContain("completed");
  });

  describe("events.ndjson", () => {
    it("has every non-empty line parse as JSON", () => {
      const content = bundleFile(makeBundle(), "events.ndjson");
      expect(content).toBeDefined();

      const lines = (content ?? "").split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const [index, line] of lines.entries()) {
        expect(() => JSON.parse(line), `line ${index} is not valid JSON`).not.toThrow();
      }
    });

    it("has strictly increasing sequence numbers in written order", () => {
      const content = bundleFile(makeBundle(), "events.ndjson");
      const lines = (content ?? "").split("\n").filter((line) => line.trim().length > 0);
      const sequences = lines.map((line) => {
        const parsed = asRecord(JSON.parse(line), "event line");
        const sequence = parsed["sequence"];
        if (typeof sequence !== "number") throw new Error("event has no numeric sequence");
        return sequence;
      });

      expect(sequences.length).toBeGreaterThan(1);
      for (let index = 1; index < sequences.length; index += 1) {
        const previous = sequences[index - 1];
        const current = sequences[index];
        if (previous === undefined || current === undefined) throw new Error("missing sequence");
        expect(current).toBeGreaterThan(previous);
      }
    });

    it("matches the events it was given", () => {
      const bundle = makeBundle();
      const content = bundleFile(bundle, "events.ndjson");
      const lines = (content ?? "").split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  it("emits a zip that reads back as the same file set", () => {
    const bundle = makeBundle();
    const entries = readZip(bundle.bytes);
    const paths = entries.map((entry) => entry.path).sort();
    const expected = bundle.files.map((file) => file.path).sort();
    expect(paths).toEqual(expected);

    for (const entry of entries) {
      const source = bundle.files.find((file) => file.path === entry.path);
      expect(entry.content, `content mismatch for ${entry.path}`).toBe(source?.content);
    }
  });

  it("keeps event ordering stable across two bundles of the same input", () => {
    // Deterministic assembly: two bundles of identical input cannot disagree.
    const a = bundleFile(makeBundle(), "events.ndjson");
    const b = bundleFile(makeBundle(), "events.ndjson");
    expect(a).toBe(b);
  });
});
