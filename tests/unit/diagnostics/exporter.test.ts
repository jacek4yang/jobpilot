/**
 * Bundle exporter tests.
 *
 * The exporter is the wiring between the Diagnostics page buttons and the
 * bundle pipeline the analyzer consumes. These tests pin the contract:
 *
 *   - a successful export delivers exactly the bytes `buildBundle` produced,
 *     under the deterministic bundle filename;
 *   - redaction happens inside the pipeline (a secret planted in the config
 *     must not reach the delivered bytes);
 *   - delivery failures surface as `{ ok: false, error }` instead of throwing,
 *     and the recorder's buffers are left untouched (the evidence survives);
 *   - the build-time failure of `buildBundle` is reported the same way.
 *
 * Delivery is injected: no test touches the real picker or downloads.
 */
import { describe, expect, it } from "vitest";
import { createBuildInfo } from "../../../src/diagnostics/build-info";
import { createBundleExporter } from "../../../src/diagnostics/bundle/exporter";
import { readZip } from "../../../src/diagnostics/bundle/zip";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";
import { startSession } from "../../../src/diagnostics/session";

const NOW = 1_700_000_000_000;

const makeRecorder = (): ReturnType<typeof createDiagnosticRecorder> => {
  const recorder = createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 1_000,
    capacity: 200,
    minLevel: "trace",
  });
  recorder.startSession(
    startSession({
      id: "s20260921T100000-abc123",
      scenarioId: "T00",
      scenarioName: "Install check",
      startedAt: NOW,
      build: createBuildInfo({ channel: "diagnostic" }),
    }),
  );
  recorder.infoEvent("runtime", "probe", { note: "hello" });
  return recorder;
};

const makeDeps = (recorder: ReturnType<typeof createDiagnosticRecorder>) => ({
  build: createBuildInfo({ channel: "diagnostic" }),
  recorder,
  config: () => ({ automation: { mode: "assist" } }),
  sections: () => ({ "queue.json": { tasks: [] } }),
  health: () => ({
    storageHealthy: true,
    lockOwner: "this-tab",
    humanVerificationEncountered: false,
  }),
  environment: () => ({ url: "https://www.zhipin.com/web/geek/job" }),
  now: () => NOW,
});

describe("createBundleExporter", () => {
  it("delivers the built bundle under its deterministic filename", async () => {
    const recorder = makeRecorder();
    const delivered: Array<{ fileName: string; bytes: Uint8Array }> = [];
    const exporter = createBundleExporter(makeDeps(recorder), async (fileName, bytes) => {
      delivered.push({ fileName, bytes });
    });

    const result = await exporter.exportBundle();

    expect(result.ok).toBe(true);
    expect(delivered).toHaveLength(1);
    const only = delivered[0];
    expect(only?.fileName).toBe(result.fileName);
    expect(only?.fileName).toMatch(/^jobpilot-diag_T00_s20260921T100000-abc123_.*\.zip$/);
    // The delivered bytes are a readable archive carrying the session id.
    const entries = readZip(only?.bytes ?? new Uint8Array());
    const manifest = entries.find((entry) => entry.path.endsWith("manifest.json"));
    expect(manifest?.content).toContain("s20260921T100000-abc123");
  });

  it("redacts secrets planted in the config before delivery", async () => {
    const recorder = makeRecorder();
    const secret = "ghp_supersecret-token-value";
    let delivered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const deps = {
      ...makeDeps(recorder),
      config: () => ({ automation: { mode: "assist" }, cookie: secret }),
    };
    const exporter = createBundleExporter(deps, async (_fileName, bytes) => {
      delivered = bytes;
    });

    const result = await exporter.exportBundle();

    expect(result.ok).toBe(true);
    const text = new TextDecoder().decode(delivered);
    expect(text).not.toContain(secret);
  });

  it("reports delivery failure without throwing and keeps recorder memory", async () => {
    const recorder = makeRecorder();
    const exporter = createBundleExporter(makeDeps(recorder), async () => {
      throw new Error("save cancelled by operator");
    });

    const result = await exporter.exportBundle();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("save cancelled by operator");
    // Evidence is NOT cleared by a failed export.
    expect(recorder.events().length).toBeGreaterThan(0);
    expect(recorder.currentSession()?.status).toBe("running");
  });

  it("reports build failure without throwing", async () => {
    const recorder = makeRecorder();
    const deps = {
      ...makeDeps(recorder),
      // Force the pipeline to fail: sections() that throws is an assembly bug
      // the exporter must surface, not propagate.
      sections: () => {
        throw new Error("sections exploded");
      },
    };
    const exporter = createBundleExporter(deps, async () => {});

    const result = await exporter.exportBundle();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sections exploded");
  });
});
