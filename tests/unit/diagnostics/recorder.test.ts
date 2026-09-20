import { describe, expect, it } from "vitest";
import { buildTag, createBuildInfo, resolveBuildInfo } from "../../../src/diagnostics/build-info";
import { EVENTS } from "../../../src/diagnostics/event";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";
import {
  fingerprint,
  fingerprintText,
  redactDiagnostic,
  redactString,
} from "../../../src/diagnostics/redact";
import { createRingBuffer } from "../../../src/diagnostics/ring-buffer";
import {
  bundleFileName,
  finishSession,
  isSessionOpen,
  localDateDirectory,
  newSessionId,
  startSession,
} from "../../../src/diagnostics/session";

const NOW = 1_700_000_000_000;

const recorder = (overrides: Partial<Parameters<typeof createDiagnosticRecorder>[0]> = {}) =>
  createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 1_000,
    capacity: 100,
    minLevel: "trace",
    ...overrides,
  });

describe("ring buffer", () => {
  it("retains up to capacity", () => {
    const buffer = createRingBuffer<number>({ capacity: 3 });
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.entries()).toEqual([1, 2, 3]);
  });

  it("evicts the oldest and reports the drop count", () => {
    const dropped: number[] = [];
    const buffer = createRingBuffer<number>({ capacity: 10, onDrop: (n) => dropped.push(n) });
    for (let i = 0; i < 100; i += 1) buffer.push(i);
    expect(buffer.size).toBeLessThanOrEqual(10);
    expect(buffer.dropped).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    // The most recent values survive.
    expect(buffer.entries().at(-1)).toBe(99);
  });

  it("keeps a lifetime drop counter across clears", () => {
    const buffer = createRingBuffer<number>({ capacity: 5 });
    for (let i = 0; i < 50; i += 1) buffer.push(i);
    const droppedBefore = buffer.dropped;
    buffer.clear();
    // Clearing must not erase the fact that evidence was previously lost.
    expect(buffer.dropped).toBe(droppedBefore);
    expect(buffer.entries()).toEqual([]);
  });

  it("handles a capacity of zero without breaking", () => {
    const buffer = createRingBuffer<number>({ capacity: 0 });
    buffer.push(1);
    expect(buffer.capacity).toBeGreaterThanOrEqual(1);
  });
});

describe("diagnostic recorder", () => {
  describe("sequencing", () => {
    it("assigns strictly increasing sequence numbers", () => {
      const r = recorder();
      r.infoEvent("runtime", "a");
      r.infoEvent("runtime", "b");
      r.infoEvent("runtime", "c");
      const sequences = r.events().map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((x, y) => x - y));
      expect(new Set(sequences).size).toBe(sequences.length);
    });

    it("records both wall and monotonic time", () => {
      const r = recorder({ now: () => NOW, monotonicNow: () => 42 });
      r.infoEvent("runtime", "a");
      const event = r.events()[0];
      expect(event?.wallTime).toBe(NOW);
      expect(event?.monotonicTime).toBe(42);
    });
  });

  describe("level filtering", () => {
    it("discards events below the minimum level", () => {
      const r = recorder({ minLevel: "warn" });
      r.trace("runtime", "noise");
      r.infoEvent("runtime", "also noise");
      r.warnEvent("runtime", "kept");
      expect(r.events()).toHaveLength(1);
    });

    it("keeps everything at trace level", () => {
      const r = recorder({ minLevel: "trace" });
      r.trace("runtime", "a");
      expect(r.events()).toHaveLength(1);
    });
  });

  describe("bounded memory", () => {
    it("never exceeds capacity and records the truncation", () => {
      const r = recorder({ capacity: 20 });
      for (let i = 0; i < 500; i += 1) r.infoEvent("runtime", `e${i}`);
      expect(r.events().length).toBeLessThanOrEqual(20);
      expect(r.stats().dropped).toBeGreaterThan(0);
    });

    it("emits a truncation event so lost evidence is visible", () => {
      const r = recorder({ capacity: 20 });
      for (let i = 0; i < 500; i += 1) r.infoEvent("runtime", `e${i}`);
      expect(r.events().some((e) => e.event === EVENTS.bufferTruncated)).toBe(true);
    });
  });

  describe("critical evidence is segregated", () => {
    it("retains communication events even under heavy trace pressure", () => {
      const r = recorder({ capacity: 20, criticalCapacity: 100 });

      // One send event...
      r.infoEvent("communication", EVENTS.sendAttempted, { a: 1 });
      // ...then bury it in noise.
      for (let i = 0; i < 2_000; i += 1) r.trace("runtime", `noise${i}`);

      // The main buffer has long since evicted it; the critical buffer has not.
      expect(r.events().some((e) => e.event === EVENTS.sendAttempted)).toBe(false);
      expect(r.criticalEvents().some((e) => e.event === EVENTS.sendAttempted)).toBe(true);
    });

    it("retains risk and error events the same way", () => {
      const r = recorder({ capacity: 10 });
      r.errorEvent("risk", EVENTS.captchaDetected);
      r.errorEvent("error", EVENTS.invariantViolation);
      for (let i = 0; i < 500; i += 1) r.trace("runtime", `n${i}`);
      const criticalEvents = r.criticalEvents().map((e) => e.event);
      expect(criticalEvents).toContain(EVENTS.captchaDetected);
      expect(criticalEvents).toContain(EVENTS.invariantViolation);
    });

    it("does not treat ordinary runtime noise as critical", () => {
      const r = recorder();
      r.infoEvent("runtime", "hello");
      expect(r.criticalEvents()).toHaveLength(0);
    });
  });

  describe("never throws", () => {
    it("survives a cyclic payload", () => {
      const r = recorder();
      const cyclic: Record<string, unknown> = { name: "loop" };
      cyclic["self"] = cyclic;
      expect(() => r.infoEvent("runtime", "cyclic", cyclic)).not.toThrow();
      expect(r.events()).toHaveLength(1);
    });

    it("survives a payload with functions and symbols", () => {
      const r = recorder();
      expect(() =>
        r.infoEvent("runtime", "weird", { fn: () => 1, sym: Symbol("s"), big: 1n }),
      ).not.toThrow();
    });
  });

  describe("redaction at write time", () => {
    it("drops sensitive keys before they reach the buffer", () => {
      const r = recorder();
      r.infoEvent("runtime", "e", { cookie: "session=abc", token: "xyz", safe: "visible" });
      const data = r.events()[0]?.data as Record<string, unknown>;
      expect(data["cookie"]).toBe("[redacted]");
      expect(data["token"]).toBe("[redacted]");
      expect(data["safe"]).toBe("visible");
    });

    it("fingerprints content-bearing fields instead of storing them", () => {
      const r = recorder();
      r.infoEvent("runtime", "e", { messageBody: "hello recruiter" });
      const data = r.events()[0]?.data as Record<string, unknown>;
      const entry = data["messageBody"] as { length: number; sha256OrFnv: string };
      expect(entry.length).toBe("hello recruiter".length);
      expect(JSON.stringify(data)).not.toContain("hello recruiter");
    });

    it("redacts secrets nested below the top level", () => {
      const r = recorder();
      r.infoEvent("runtime", "e", {
        outer: { inner: { authorization: "Bearer abcdefghijklmnop" } },
      });
      expect(JSON.stringify(r.events())).not.toContain("abcdefghijklmnop");
    });
  });

  describe("logger compatibility", () => {
    it("exposes entries() for the existing panel renderer", () => {
      const r = recorder();
      r.info("bootstrap", "started");
      const entries = r.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.component).toBe("bootstrap");
      expect(entries[0]?.message).toBe("started");
      expect(entries[0]?.level).toBe("info");
    });

    it("maps fatal to the error log level", () => {
      const r = recorder();
      r.record({ level: "fatal", category: "error", event: "boom" });
      expect(r.entries()).toHaveLength(0);
      expect(r.criticalEvents().some((e) => e.event === "boom")).toBe(true);
    });
  });

  describe("session", () => {
    it("starts under a placeholder session id so startup crashes are captured", () => {
      const r = recorder();
      expect(r.sessionId()).toBe("pre-session");
    });

    it("stamps the session id onto events", () => {
      const r = recorder();
      r.startSession(
        startSession({
          id: "s1",
          scenarioId: "T01",
          scenarioName: "bootstrap",
          startedAt: NOW,
          build: createBuildInfo(),
        }),
      );
      r.infoEvent("runtime", "after");
      const after = r.events().filter((e) => e.event === "after");
      expect(after[0]?.sessionId).toBe("s1");
    });

    it("records the session lifecycle", () => {
      const r = recorder();
      r.startSession(
        startSession({
          id: "s1",
          scenarioId: "T01",
          scenarioName: "bootstrap",
          startedAt: NOW,
          build: createBuildInfo(),
        }),
      );
      r.finishSession("completed");
      const names = r.events().map((e) => e.event);
      expect(names).toContain(EVENTS.sessionStarted);
      expect(names).toContain(EVENTS.sessionFinished);
      expect(r.currentSession()?.status).toBe("completed");
    });
  });

  describe("buffer reset", () => {
    it("clears buffers without touching the sequence counter", () => {
      const r = recorder();
      r.infoEvent("runtime", "a");
      const before = r.events()[0]?.sequence ?? 0;
      r.resetBuffers();
      r.infoEvent("runtime", "b");
      const after = r.events().at(-1)?.sequence ?? 0;
      // Sequence must stay monotonic across a reset, or the bundle cannot be
      // ordered by sequence alone.
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe("build info", () => {
  it("falls back to unknown rather than fabricating a commit", () => {
    const build = resolveBuildInfo(4);
    expect(build.gitCommit).toBe("unknown");
    expect(build.buildTimestamp).toBe("unknown");
  });

  it("reports the schema versions", () => {
    const build = createBuildInfo({ schemaVersion: 4 });
    expect(build.schemaVersion).toBe(4);
    expect(build.diagnosticSchemaVersion).toBe(1);
  });

  it("defaults to the production channel", () => {
    expect(resolveBuildInfo(4).channel).toBe("production");
  });

  it("produces a filesystem-safe build tag", () => {
    const tag = buildTag(createBuildInfo({ appVersion: "0.1.0", gitCommit: "abcdef1234567890" }));
    expect(tag).toBe("0.1.0_abcdef1");
    expect(tag).not.toMatch(/[/\\:*?"<>|]/);
  });

  it("handles an unknown commit in the tag", () => {
    expect(buildTag(createBuildInfo({ gitCommit: "unknown" }))).toBe("0.0.0-test_unknown");
  });
});

describe("session helpers", () => {
  it("generates sortable, unique session ids", () => {
    const a = newSessionId(NOW, () => 0.1);
    const b = newSessionId(NOW, () => 0.9);
    expect(a).not.toBe(b);
    expect(a.startsWith("s")).toBe(true);
  });

  it("builds a deterministic, safe bundle filename", () => {
    const name = bundleFileName({
      scenarioId: "T60",
      sessionId: "s1",
      createdAt: NOW,
      buildTag: "0.1.0_abc",
    });
    expect(name).toMatch(/^jobpilot-diag_T60_s1_\d{8}T\d{6}Z_0\.1\.0_abc\.zip$/);
  });

  it("sanitises a scenario id that would break a filename", () => {
    const name = bundleFileName({
      scenarioId: "T60/../evil",
      sessionId: "s1",
      createdAt: NOW,
      buildTag: "b",
    });
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
  });

  it("tracks session openness", () => {
    const session = startSession({
      id: "s1",
      scenarioId: "T",
      scenarioName: "n",
      startedAt: NOW,
      build: createBuildInfo(),
    });
    expect(isSessionOpen(session)).toBe(true);
    expect(isSessionOpen(finishSession(session, "completed", NOW))).toBe(false);
  });

  it("builds a local date directory", () => {
    expect(localDateDirectory(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("redaction", () => {
  it("fingerprints deterministically", () => {
    expect(fingerprintText("abc")).toBe(fingerprintText("abc"));
    expect(fingerprintText("abc")).not.toBe(fingerprintText("abd"));
  });

  it("exposes only a length and digest by default", () => {
    const result = fingerprint("secret message");
    expect(result.length).toBe(14);
    expect(result.preview).toBeUndefined();
  });

  it("exposes a preview only when the caller marks text safe", () => {
    const result = fingerprint("立即沟通", { safe: true, previewChars: 4 });
    expect(result.preview).toBe("立即沟通");
  });

  it("strips bearer tokens", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnop")).not.toContain(
      "abcdefghijklmnop",
    );
  });

  it("strips query-style credentials", () => {
    expect(redactString("?token=abcdef&x=1")).not.toContain("abcdef");
  });

  it("redacts long numeric identifiers", () => {
    expect(redactString("id 110101199001011234")).not.toContain("110101199001011234");
  });

  it("fingerprints strings that merely mention a sensitive concept", () => {
    // A leaked partial value is still worse than a digest.
    const result = redactString("the cookie header was present");
    expect(result.startsWith("[redacted:")).toBe(true);
  });

  it("keeps ordinary text readable", () => {
    expect(redactString("opened the job detail page")).toBe("opened the job detail page");
  });

  it("caps array length", () => {
    const redacted = redactDiagnostic(Array.from({ length: 1_000 }, (_, i) => i)) as number[];
    expect(redacted.length).toBe(50);
  });

  it("caps recursion depth", () => {
    let nested: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) nested = { nested };
    expect(JSON.stringify(redactDiagnostic(nested))).toContain("depth-limit");
  });
});
