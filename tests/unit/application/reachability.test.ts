import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against unreachable safety code.
 *
 * `gates.ts` and `human-verification.ts` encode the guarantees the safety model
 * claims. If nothing in the production entry path imports them, those
 * guarantees are dead code in the shipped artifact — they pass their unit tests
 * while enforcing nothing at runtime.
 *
 * This was a real defect: `communication-service.ts` (which owns every gate and
 * every invariant enforcement point) had no production importer, so the runner
 * was being called directly with no gate evaluated. A source scan is the only
 * way to catch that class of gap, because each module's own tests pass.
 */
const ROOT = join(import.meta.dirname, "../../..");

/** Everything reachable from the userscript entry point, by import graph. */
const reachableFrom = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }

    // Only relative imports matter: a bare specifier is a dependency, not one
    // of our modules.
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const base = join(current, "..", specifier);
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        try {
          if (statSync(candidate).isFile()) queue.push(candidate);
        } catch {
          // Not a real path; try the next candidate.
        }
      }
    }
  }

  return seen;
};

const normalized = (paths: Set<string>): string[] =>
  [...paths].map((path) => path.replace(/\\/g, "/"));

describe("safety code is reachable from production", () => {
  const reachable = normalized(reachableFrom(join(ROOT, "src/main.ts")));

  const requires = (moduleSuffix: string): void => {
    const found = reachable.some((path) => path.endsWith(moduleSuffix));
    expect(
      found,
      `${moduleSuffix} is not reachable from src/main.ts, so its guarantees are dead code in the shipped artifact`,
    ).toBe(true);
  };

  it("reaches the execution gates", () => {
    // The gate module is only useful if something calls it.
    requires("src/application/gates.ts");
  });

  it("reaches the communication service, which owns every gate", () => {
    requires("src/application/communication-service.ts");
  });

  it("reaches the human-verification controller", () => {
    // A gate reading an unconstructed controller evaluates to "not blocked",
    // which is the unsafe default.
    requires("src/application/human-verification.ts");
  });

  it("reaches the diagnostic recorder", () => {
    requires("src/diagnostics/recorder.ts");
  });

  it("reaches the storage-health tracer", () => {
    // Without it, the storage-health gate has no live value to consult.
    requires("src/diagnostics/trace.ts");
  });

  it("reaches the communication runner only through the service", () => {
    // The runner must be reachable (it performs the send) but must not be
    // called directly from bootstrap, or a path could click without gates.
    requires("src/application/communication-runner.ts");

    const bootstrap = readFileSync(join(ROOT, "src/bootstrap/bootstrap.ts"), "utf8");
    const directRun = /communicationRunner\.run\(/.test(bootstrap);
    const viaService = /runner: communicationRunner/.test(bootstrap);
    expect(viaService, "the service must receive the runner").toBe(true);
    expect(
      directRun,
      "bootstrap calls communicationRunner.run() directly, bypassing the gates in communication-service.ts",
    ).toBe(false);
  });

  it("keeps every critical production-composition edge connected", () => {
    const bootstrap = readFileSync(join(ROOT, "src/bootstrap/bootstrap.ts"), "utf8");
    const edges: ReadonlyArray<readonly [RegExp, string]> = [
      [/createRepository\(tracedStorage\.storage,/, "repository -> traced storage health"],
      [
        /createCommunicationRunner\(\{[\s\S]*?action: communicationAction,/,
        "runner -> BOSS action",
      ],
      [
        /createCommunicationService\(\{[\s\S]*?runner: communicationRunner,/,
        "service -> sole runner",
      ],
      [/platform: platformForRun,/, "finite selected platform -> orchestrator"],
      [/orchestrator: traceOrchestrator\(orchestrator,/, "diagnostic trace -> controller"],
      [/createPanel\(\{[\s\S]*?callbacks:/, "production callbacks -> mounted panel"],
    ];

    for (const [pattern, label] of edges) {
      expect(pattern.test(bootstrap), `critical production wiring missing: ${label}`).toBe(true);
    }
  });

  it("finds a meaningful graph rather than an empty set", () => {
    // Guards the scan itself: an empty or one-element set would make every
    // assertion above vacuously true.
    expect(reachable.length).toBeGreaterThan(20);
  });
});
