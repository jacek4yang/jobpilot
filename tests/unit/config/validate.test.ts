import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  validateConfig,
  validateConfigJson,
} from "../../../src/config";

/** Narrowing helper: fails the test with the reported errors when invalid. */
const expectOk = (input: unknown) => {
  const result = validateConfig(input);
  if (!result.ok) throw new Error(`expected valid config, got: ${result.errors.join("; ")}`);
  return result.value;
};

const expectErrors = (input: unknown): readonly string[] => {
  const result = validateConfig(input);
  if (result.ok) throw new Error("expected validation to fail, but it succeeded");
  return result.errors;
};

describe("validateConfig — acceptance", () => {
  it("accepts the default config unchanged", () => {
    const value = expectOk(createDefaultConfig());
    expect(value).toEqual(createDefaultConfig());
  });

  it("accepts an empty object and fills every section from defaults", () => {
    expect(expectOk({})).toEqual(createDefaultConfig());
  });

  it("accepts a partial document and keeps the supplied values", () => {
    const value = expectOk({ general: { locale: "en-US" }, automation: { maxRetries: 5 } });
    expect(value.general.locale).toBe("en-US");
    expect(value.automation.maxRetries).toBe(5);
    // Untouched neighbours still come from the defaults.
    expect(value.automation.mode).toBe("assist");
    expect(value.ui.showPanel).toBe(true);
  });

  it("ignores unknown extra keys for forward compatibility", () => {
    const value = expectOk({ general: { locale: "en-US" }, somethingFromTheFuture: 42 });
    expect(value.general.locale).toBe("en-US");
    expect("somethingFromTheFuture" in value).toBe(false);
    // Unknown keys inside a known section are tolerated too.
    expect(validateConfig({ ui: { showPanel: false, futureKnob: true } }).ok).toBe(true);
  });
});

describe("validateConfig — conservative defaults", () => {
  it("defaults to assist mode, never automatic", () => {
    expect(createDefaultConfig().automation.mode).toBe("assist");
    expect(createDefaultConfig().automation.acknowledgeRisks).toBe(false);
  });

  it("rejects automatic mode without an explicit risk acknowledgement", () => {
    const errors = expectErrors({ automation: { mode: "automatic" } });
    expect(errors.join("\n")).toMatch(/acknowledgeRisks/);
  });

  it("rejects automatic mode when the acknowledgement is explicitly false", () => {
    const errors = expectErrors({ automation: { mode: "automatic", acknowledgeRisks: false } });
    expect(errors.join("\n")).toMatch(/acknowledgeRisks/);
  });

  it("accepts automatic mode once the risks are acknowledged", () => {
    const value = expectOk({ automation: { mode: "automatic", acknowledgeRisks: true } });
    expect(value.automation.mode).toBe("automatic");
  });

  it("does not require an acknowledgement for manual or assist", () => {
    expect(expectOk({ automation: { mode: "manual" } }).automation.mode).toBe("manual");
    expect(expectOk({ automation: { mode: "assist" } }).automation.mode).toBe("assist");
  });

  it("rejects an unknown automation mode", () => {
    expect(expectErrors({ automation: { mode: "yolo" } }).join("\n")).toMatch(/automation\.mode/);
  });

  it("rejects archived telemetry opt-ins", () => {
    expect(expectErrors({ logging: { telemetryEnabled: true } }).join("\n")).toMatch(/telemetry/);
  });
});

describe("validateConfig — wrong types are errors", () => {
  it("reports a string where a boolean is expected", () => {
    const errors = expectErrors({ general: { enabled: "yes" } });
    expect(errors).toContain("general.enabled must be a boolean");
  });

  it("reports a number where a string is expected", () => {
    expect(expectErrors({ general: { locale: 7 } })).toContain("general.locale must be a string");
  });

  it("reports a string where an array is expected", () => {
    const errors = expectErrors({ filters: { cities: "Beijing" } });
    expect(errors.join("\n")).toMatch(/filters\.cities must be an array/);
  });

  it("reports an array of non-strings", () => {
    const errors = expectErrors({ filters: { cities: ["Beijing", 42] } });
    expect(errors).toContain("filters.cities must contain only strings");
  });

  it("reports a non-numeric numeric field", () => {
    const errors = expectErrors({ automation: { maxRetries: "2" } });
    expect(errors.join("\n")).toMatch(/automation\.maxRetries must be a finite number/);
  });

  it("reports NaN and Infinity, which would silently disable a limit", () => {
    expect(expectErrors({ automation: { maxRetries: Number.NaN } }).join("\n")).toMatch(
      /finite number/,
    );
    expect(expectErrors({ automation: { maxRetries: Number.POSITIVE_INFINITY } }).join("\n")).toMatch(
      /finite number/,
    );
  });

  it("reports a section that is present but not an object", () => {
    expect(expectErrors({ automation: "automatic" })).toContain("automation must be an object");
    expect(expectErrors({ ui: [1, 2, 3] })).toContain("ui must be an object");
  });

  it("reports malformed keyword weight entries", () => {
    const errors = expectErrors({
      scoring: { titleKeywords: [{ keyword: "ts" }, { weight: 3 }, "typescript"] },
    });
    expect(errors.join("\n")).toMatch(/scoring\.titleKeywords entries must be/);
  });

  it("accepts well-formed keyword weights", () => {
    const value = expectOk({ scoring: { titleKeywords: [{ keyword: " rust ", weight: 4 }] } });
    expect(value.scoring.titleKeywords).toEqual([{ keyword: "rust", weight: 4 }]);
  });

  it("reports every problem rather than only the first", () => {
    const errors = expectErrors({
      general: { enabled: "yes", locale: 7 },
      automation: { maxRetries: "many", mode: "yolo" },
      logging: { level: "verbose" },
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
    const joined = errors.join("\n");
    for (const fragment of [
      "general.enabled",
      "general.locale",
      "automation.maxRetries",
      "automation.mode",
      "logging.level",
    ]) {
      expect(joined).toContain(fragment);
    }
  });
});

describe("validateConfig — range checks", () => {
  it("rejects negative durations", () => {
    expect(expectErrors({ automation: { minActionDelayMs: -1 } }).join("\n")).toMatch(
      /minActionDelayMs must be >= 0/,
    );
    expect(expectErrors({ rateLimit: { failureBackoffMs: -5 } }).join("\n")).toMatch(
      /failureBackoffMs must be >= 0/,
    );
  });

  it("rejects a minimum delay above the maximum delay", () => {
    const errors = expectErrors({
      automation: { minActionDelayMs: 9000, maxActionDelayMs: 4000 },
    });
    expect(errors.join("\n")).toMatch(/minActionDelayMs must be <= automation\.maxActionDelayMs/);
  });

  it("accepts equal min and max delays (a fixed pause)", () => {
    expect(
      expectOk({ automation: { minActionDelayMs: 5000, maxActionDelayMs: 5000 } }).automation,
    ).toMatchObject({ minActionDelayMs: 5000, maxActionDelayMs: 5000 });
  });

  it("rejects negative session limits", () => {
    expect(
      expectErrors({ automation: { maxApplicationsPerSession: -1 } }).join("\n"),
    ).toMatch(/maxApplicationsPerSession must be >= 0/);
    expect(expectErrors({ automation: { maxApplicationsPerHour: -3 } }).join("\n")).toMatch(
      /maxApplicationsPerHour must be >= 0/,
    );
    expect(expectErrors({ automation: { maxRetries: -1 } }).join("\n")).toMatch(
      /maxRetries must be >= 0/,
    );
  });

  it("rejects non-integer counts", () => {
    expect(expectErrors({ automation: { maxApplicationsPerSession: 1.5 } }).join("\n")).toMatch(
      /must be an integer/,
    );
  });

  it("allows zero, which is the documented \"no bound\" sentinel", () => {
    const value = expectOk({
      filters: { minSalaryK: 0, maxSalaryK: 0 },
      automation: { maxApplicationsPerSession: 0, maxApplicationsPerHour: 0, maxRetries: 0 },
    });
    expect(value.automation.maxApplicationsPerSession).toBe(0);
    expect(value.filters.maxSalaryK).toBe(0);
  });

  it("rejects inverted salary bounds when both are real", () => {
    const errors = expectErrors({ filters: { minSalaryK: 40, maxSalaryK: 20 } });
    expect(errors.join("\n")).toMatch(/minSalaryK must be <= filters\.maxSalaryK/);
  });

  it("does not complain about an inverted salary range when one side is unbounded", () => {
    expect(validateConfig({ filters: { minSalaryK: 40, maxSalaryK: 0 } }).ok).toBe(true);
  });

  it("rejects an accept threshold above the maximum score", () => {
    const errors = expectErrors({ scoring: { acceptThreshold: 200, maxScore: 100 } });
    expect(errors.join("\n")).toMatch(/acceptThreshold must be <= scoring\.maxScore/);
  });

  it("rejects an unknown log level", () => {
    expect(expectErrors({ logging: { level: "loud" } }).join("\n")).toMatch(/logging\.level/);
  });

  it("rejects an unknown panel position", () => {
    expect(expectErrors({ ui: { panelPosition: "middle" } }).join("\n")).toMatch(
      /ui\.panelPosition/,
    );
  });

  it("caps the numeric sanity of the remaining guards", () => {
    expect(expectErrors({ rateLimit: { maxConsecutiveFailures: -1 } }).join("\n")).toMatch(
      /maxConsecutiveFailures must be >= 0/,
    );
    expect(expectErrors({ logging: { maxEntries: -10 } }).join("\n")).toMatch(
      /maxEntries must be >= 0/,
    );
    expect(expectErrors({ scoring: { baseScore: -1 } }).join("\n")).toMatch(
      /baseScore must be >= 0/,
    );
  });
});

describe("validateConfig — hostile input must never throw", () => {
  const hostile: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a boolean", true],
    ["a bare string", "not json"],
    ["an empty array", []],
    ["an array of objects", [{ automation: { mode: "automatic" } }]],
    ["NaN", Number.NaN],
    ["a function", () => undefined],
    ["a symbol-ish record", { general: Symbol("x") }],
  ];

  for (const [label, input] of hostile) {
    it(`does not throw for ${label}`, () => {
      expect(() => validateConfig(input)).not.toThrow();
      expect(validateConfig(input).ok).toBe(false);
    });
  }

  it("does not throw on deeply nested junk", () => {
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let depth = 0; depth < 200; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor["nested"] = next;
      cursor = next;
    }
    expect(() => validateConfig({ general: nested, automation: nested, filters: [nested] })).not.toThrow();
  });

  it("does not throw on a self-referencing object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => validateConfig(cyclic)).not.toThrow();
    expect(() => validateConfig({ automation: cyclic })).not.toThrow();
  });

  it("does not throw on an array nested where an object is expected", () => {
    const result = validateConfig({ automation: [], ui: [[]], logging: { level: {} } });
    expect(result.ok).toBe(false);
  });
});

describe("validateConfigJson", () => {
  it("returns a clean error for invalid JSON instead of throwing", () => {
    let result: ReturnType<typeof validateConfigJson> | undefined;
    expect(() => {
      result = validateConfigJson("{ not json ");
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(result.errors[0]).toMatch(/not valid JSON/);
    }
  });

  it("round-trips a default config through JSON", () => {
    const text = JSON.stringify(createDefaultConfig());
    const result = validateConfigJson(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(createDefaultConfig());
  });

  it("reports a shape error for syntactically valid but wrong JSON", () => {
    const result = validateConfigJson('{"automation":{"maxRetries":"two"}}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/maxRetries/);
  });

  it("rejects JSON that is a bare array or literal", () => {
    expect(validateConfigJson("[]").ok).toBe(false);
    expect(validateConfigJson("null").ok).toBe(false);
    expect(validateConfigJson('"config"').ok).toBe(false);
  });
});
