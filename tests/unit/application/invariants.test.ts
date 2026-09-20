import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVARIANTS } from "../../../src/application/gates";

/**
 * Guards against decorative invariants.
 *
 * `INVARIANTS` is a list of guarantees the safety model claims to provide. A
 * constant that is declared but never referenced anywhere in `src/` looks like
 * coverage in review while enforcing nothing — which is worse than not listing
 * it, because it invites false confidence.
 *
 * This test walks the source tree and requires every declared invariant to be
 * referenced from production code. It is deliberately a source scan rather than
 * a behavioural test: the question is "is this guarantee wired up at all",
 * which no single behavioural test can answer for all of them.
 */
const SOURCE_ROOT = join(import.meta.dirname, "../../../src");

const collectSources = (directory: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      out.push(...collectSources(path));
      continue;
    }
    if (path.endsWith(".ts")) out.push(path);
  }
  return out;
};

const allSource = collectSources(SOURCE_ROOT)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

describe("production invariants", () => {
  it("declares a non-trivial set", () => {
    expect(Object.keys(INVARIANTS).length).toBeGreaterThanOrEqual(10);
  });

  it("references every declared invariant from production code", () => {
    // gates.ts only declares them, so the enforcement must live elsewhere.
    // Searching for the identifier (rather than the string value) also catches
    // a site that inlines the literal instead of using the constant, which
    // would drift the moment the identifier changed.
    const unreferenced = Object.entries(INVARIANTS).filter(([name]) => {
      const accessor = `INVARIANTS.${name}`;
      const occurrences = allSource.split(accessor).length - 1;
      return occurrences === 0;
    });

    expect(
      unreferenced.map(([name]) => name),
      "these invariants are declared but never enforced anywhere in src/",
    ).toEqual([]);
  });

  it("has a unique identifier for each entry", () => {
    const values = Object.values(INVARIANTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses identifiers that are readable in a report", () => {
    for (const value of Object.values(INVARIANTS)) {
      // The analyzer prints these verbatim into a findings report.
      expect(value).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});
