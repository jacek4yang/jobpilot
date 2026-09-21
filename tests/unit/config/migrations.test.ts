import { describe, expect, it } from "vitest";
import type { JobPilotConfig } from "../../../src/config";
import {
  CURRENT_SCHEMA_VERSION,
  createDefaultConfig,
  isCurrentVersion,
  migratePersistedRoot,
} from "../../../src/config";

/** Realistic history payload — this is the data that must survive migration. */
const APPLICATIONS = [
  {
    id: "app_1a2b3c4d",
    jobId: "job_100",
    platform: "boss",
    status: "submitted",
    reasons: ["score 82 >= threshold 70"],
    attempts: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  },
  {
    id: "app_5e6f7a8b",
    jobId: "job_101",
    platform: "boss",
    status: "verified",
    reasons: [],
    attempts: 2,
    createdAt: 1_700_000_200_000,
    updatedAt: 1_700_000_300_000,
  },
];

const STATISTICS = { scanned: 42, accepted: 7, applied: 2, rejected: 35, failed: 0 };

const expectOk = (input: unknown) => {
  const result = migratePersistedRoot(input);
  if (!result.ok) throw new Error(`expected migration to succeed, got: ${result.error}`);
  return result;
};

const expectFail = (input: unknown): string => {
  const result = migratePersistedRoot(input);
  if (result.ok) throw new Error("expected migration to fail, but it succeeded");
  return result.error;
};

/**
 * Reads the migrated config back as a typed value.
 *
 * `migratePersistedRoot` hands back `config` as `unknown` on purpose, so the
 * test asserts on the documented shape via a cast confined to this helper.
 */
const migratedConfig = (input: unknown): JobPilotConfig => {
  const result = expectOk(input);
  return result.root.config as JobPilotConfig;
};

describe("migratePersistedRoot — version detection", () => {
  it("treats a document with no schemaVersion as v1 and migrates it", () => {
    const result = expectOk({
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.appliedSteps.length).toBeGreaterThan(0);
    expect(result.appliedSteps[0]).toMatch(/^v1 -> v2/);
    expect(result.appliedSteps.at(-1)).toMatch(/^v4 -> v5/);
  });

  it("migrates an explicit v1 document", () => {
    const result = expectOk({
      schemaVersion: 1,
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.appliedSteps).toHaveLength(4);
  });

  it("migrates a v2 document with three steps", () => {
    const result = expectOk({
      schemaVersion: 2,
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.appliedSteps).toHaveLength(3);
    expect(result.appliedSteps[0]).toMatch(/^v2 -> v3/);
    expect(result.appliedSteps[1]).toMatch(/^v3 -> v4/);
    expect(result.appliedSteps[2]).toMatch(/^v4 -> v5/);
  });

  it("migrates a v4 document with a single step to v5", () => {
    const result = expectOk({
      schemaVersion: 4,
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.schemaVersion).toBe(5);
    expect(result.appliedSteps).toHaveLength(1);
    expect(result.appliedSteps[0]).toMatch(/^v4 -> v5/);
  });

  it("names every applied step, so diagnostics can explain the upgrade", () => {
    const result = expectOk({ schemaVersion: 1 });
    expect(result.appliedSteps.length).toBeGreaterThan(1);
    for (const name of result.appliedSteps) {
      expect(name).toMatch(/^v\d+ -> v\d+: \S/);
    }
  });

  it("is idempotent when the document is already current", () => {
    const source = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    };
    const first = expectOk(source);
    expect(first.appliedSteps).toEqual([]);
    expect(isCurrentVersion(source)).toBe(true);

    // Re-migrating the already-migrated document must be a no-op.
    const second = expectOk(first.root);
    expect(second.appliedSteps).toEqual([]);
    expect(second.root.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(second.root.applications).toEqual(APPLICATIONS);
    expect(second.root.statistics).toEqual(STATISTICS);
  });

  it("reports isCurrentVersion false for older and invalid documents", () => {
    expect(isCurrentVersion({ schemaVersion: 1 })).toBe(false);
    expect(isCurrentVersion({})).toBe(false);
    expect(isCurrentVersion(null)).toBe(false);
    expect(isCurrentVersion("nope")).toBe(false);
  });
});

describe("migratePersistedRoot — refuses to guess", () => {
  it("rejects a future schema version with a clear error", () => {
    const error = expectFail({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      config: createDefaultConfig(),
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(error).toMatch(/newer than this build supports/);
    expect(error).toContain(String(CURRENT_SCHEMA_VERSION + 1));
    expect(error).toMatch(/refusing to downgrade/i);
  });

  it("rejects a wildly future version without touching the payload", () => {
    expect(expectFail({ schemaVersion: 99, applications: APPLICATIONS })).toMatch(/99/);
  });

  it("rejects a non-integer schemaVersion", () => {
    expect(expectFail({ schemaVersion: "2" })).toMatch(/must be an integer/);
    expect(expectFail({ schemaVersion: 1.5 })).toMatch(/must be an integer/);
    expect(expectFail({ schemaVersion: Number.NaN })).toMatch(/must be an integer/);
  });

  it("rejects a version below 1", () => {
    expect(expectFail({ schemaVersion: 0 })).toMatch(/>= 1/);
    expect(expectFail({ schemaVersion: -3 })).toMatch(/>= 1/);
  });

  it("rejects a non-object root without throwing", () => {
    expect(() => migratePersistedRoot(null)).not.toThrow();
    expect(expectFail(null)).toMatch(/not an object/);
    expect(expectFail([])).toMatch(/not an object/);
    expect(expectFail("root")).toMatch(/not an object/);
  });
});

describe("migratePersistedRoot — user data is never destroyed", () => {
  it("carries applications and statistics through a v1 migration verbatim", () => {
    const result = expectOk({ applications: APPLICATIONS, statistics: STATISTICS });
    expect(result.root.applications).toEqual(APPLICATIONS);
    expect(result.root.statistics).toEqual(STATISTICS);
  });

  it("carries history through a v2 migration", () => {
    const result = expectOk({
      schemaVersion: 2,
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.applications).toEqual(APPLICATIONS);
    expect(result.root.statistics).toEqual(STATISTICS);
  });

  it("keeps history even when the config section is missing entirely", () => {
    const result = expectOk({ applications: APPLICATIONS, statistics: STATISTICS });
    expect(result.root.applications).toEqual(APPLICATIONS);
    expect(result.root.statistics).toEqual(STATISTICS);
  });

  it("keeps history even when the config section is corrupt", () => {
    const result = expectOk({
      schemaVersion: 1,
      config: "totally not a config",
      applications: APPLICATIONS,
      statistics: STATISTICS,
    });
    expect(result.root.applications).toEqual(APPLICATIONS);
    expect(result.root.statistics).toEqual(STATISTICS);
    // The corrupt config is replaced by defaults rather than blocking the load.
    expect(
      migratedConfig({ schemaVersion: 1, config: "totally not a config" }).automation.mode,
    ).toBe("assist");
  });

  it("does not invent a history that was never there", () => {
    const result = expectOk({ schemaVersion: 2 });
    expect(result.root.applications).toBeUndefined();
    expect(result.root.statistics).toBeUndefined();
  });

  it("survives a hostile document without throwing", () => {
    const hostile: readonly unknown[] = [
      undefined,
      42,
      true,
      [],
      { schemaVersion: 1, config: null, applications: null },
      { schemaVersion: 2, applications: [null, 1, "x"] },
      { schemaVersion: 3, config: { automation: { mode: [] } } },
    ];
    for (const input of hostile) {
      expect(() => migratePersistedRoot(input)).not.toThrow();
    }
  });
});

describe("migratePersistedRoot — v1 -> v2 field migration", () => {
  it("lifts pacing knobs out of the v1 automation section", () => {
    const config = migratedConfig({
      schemaVersion: 1,
      config: {
        automation: {
          mode: "assist",
          minActionDelayMs: 3000,
          maxActionDelayMs: 7000,
          maxRetries: 4,
        },
      },
      applications: APPLICATIONS,
    });
    expect(config.rateLimit.minNavigationDelayMs).toBe(2000);
    expect(config.automation.minActionDelayMs).toBe(3000);
    expect(config.automation.maxActionDelayMs).toBe(7000);
    expect(config.automation.maxRetries).toBe(4);
  });

  it("keeps a rateLimit section that the v1 document already had", () => {
    const config = migratedConfig({
      schemaVersion: 1,
      config: {
        automation: { minActionDelayMs: 3000 },
        rateLimit: { failureBackoffMs: 12345 },
      },
    });
    expect(config.rateLimit.failureBackoffMs).toBe(12345);
  });

  it("still yields a complete config when v1 had no automation section", () => {
    const config = migratedConfig({ schemaVersion: 1, config: { ui: { showPanel: false } } });
    expect(config.ui.showPanel).toBe(false);
    expect(config.rateLimit.failureBackoffMs).toBe(30000);
  });
});

describe("migratePersistedRoot — v2 -> v3 automation gate", () => {
  it("steps an ungated automatic mode back to assist during migration", () => {
    const config = migratedConfig({
      schemaVersion: 2,
      config: { automation: { mode: "automatic" } },
    });
    expect(config.automation.acknowledgeRisks).toBe(false);
    expect(config.automation.mode).toBe("assist");
  });

  it("honours an explicit acknowledgement carried in a v2 document", () => {
    const config = migratedConfig({
      schemaVersion: 2,
      config: { automation: { mode: "automatic", acknowledgeRisks: true } },
    });
    expect(config.automation.mode).toBe("automatic");
    expect(config.automation.acknowledgeRisks).toBe(true);
  });

  it("adds the acknowledgement flag as false to a plain v2 document", () => {
    const config = migratedConfig({ schemaVersion: 2, config: { automation: { mode: "assist" } } });
    expect(config.automation.acknowledgeRisks).toBe(false);
  });

  it("leaves manual and assist untouched", () => {
    expect(
      migratedConfig({ schemaVersion: 2, config: { automation: { mode: "manual" } } }).automation
        .mode,
    ).toBe("manual");
    expect(
      migratedConfig({ schemaVersion: 2, config: { automation: { mode: "assist" } } }).automation
        .mode,
    ).toBe("assist");
  });
});

describe("migratePersistedRoot — the upgraded config is usable", () => {
  it("produces a config with the conservative defaults after a v1 upgrade", () => {
    const config = migratedConfig({ schemaVersion: 1 });
    expect(config).toMatchObject({
      automation: {
        mode: "assist",
        acknowledgeRisks: false,
        minActionDelayMs: 4000,
        maxActionDelayMs: 9000,
        maxRetries: 2,
        maxApplicationsPerSession: 20,
        maxApplicationsPerHour: 15,
      },
      logging: { level: "info", telemetryEnabled: false },
    });
  });

  it("keeps user settings that were already valid", () => {
    const config = migratedConfig({
      schemaVersion: 1,
      config: { automation: { maxApplicationsPerSession: 5 }, logging: { level: "debug" } },
    });
    expect(config.automation.maxApplicationsPerSession).toBe(5);
    expect(config.logging.level).toBe("debug");
  });
});

describe("migratePersistedRoot — v3 -> v4 search profiles", () => {
  it("adds an empty profiles list without inventing a search", () => {
    const result = migratePersistedRoot({
      schemaVersion: 3,
      config: { general: { locale: "zh-CN" } },
      applications: [{ jobId: "j1" }],
      statistics: { contacted: 3 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A v3 document had no way to express a search intent, so the list must
    // start empty. Deriving one from the flat filters would make JobPilot
    // search for something the user never asked for.
    expect((result.root.config as Record<string, unknown>)["profiles"]).toEqual([]);
    expect(result.appliedSteps).toContain("v3 -> v4: add search profiles");
  });

  it("preserves existing user data across the upgrade", () => {
    const result = migratePersistedRoot({
      schemaVersion: 3,
      config: {},
      applications: [{ jobId: "keep-me" }],
      statistics: { contacted: 9 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.applications).toEqual([{ jobId: "keep-me" }]);
    expect(result.root.statistics).toEqual({ contacted: 9 });
  });

  it("does not overwrite profiles that are already present", () => {
    const existing = [{ id: "p1", name: "Rust", keywords: ["rust"] }];
    const result = migratePersistedRoot({
      schemaVersion: 3,
      config: { profiles: existing },
      applications: [],
      statistics: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The profile survives with its user-supplied fields intact; the migration
    // only fills in the fields a v3 document could not have carried.
    const profiles = (result.root.config as Record<string, unknown>)["profiles"] as readonly Record<
      string,
      unknown
    >[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.["id"]).toBe("p1");
    expect(profiles[0]?.["name"]).toBe("Rust");
    expect(profiles[0]?.["keywords"]).toEqual(["rust"]);
  });

  it("replaces a non-array profiles value rather than trusting it", () => {
    const result = migratePersistedRoot({
      schemaVersion: 3,
      config: { profiles: "not an array" },
      applications: [],
      statistics: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.root.config as Record<string, unknown>)["profiles"]).toEqual([]);
  });
});

describe("migratePersistedRoot — v4 -> v5 panel geometry and display name", () => {
  it("preserves existing displayName and layout preferences when present", () => {
    const result = migratePersistedRoot({
      schemaVersion: 4,
      config: {
        general: { locale: "zh-CN", displayName: "测试称呼" },
        ui: {
          showPanel: true,
          panelPosition: "top-left",
          panelWidth: 500,
          panelHeight: 700,
        },
      },
      applications: [{ jobId: "j1" }],
      statistics: { contacted: 5 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.root.config as JobPilotConfig;
    expect(config.general.displayName).toBe("测试称呼");
    expect(config.ui.panelWidth).toBe(500);
    expect(config.ui.panelHeight).toBe(700);
    expect(config.ui.panelPosition).toBe("top-left");
    expect(result.appliedSteps).toContain(
      "v4 -> v5: add panel layout geometry and personal display name",
    );
  });

  it("safely defaults missing layout fields while preserving v4 document", () => {
    const result = migratePersistedRoot({
      schemaVersion: 4,
      config: {
        general: { locale: "en" },
        ui: { showPanel: true },
      },
      applications: [],
      statistics: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.root.config as JobPilotConfig;
    expect(config.general.locale).toBe("en");
    expect(config.general.displayName).toBeUndefined();
    expect(config.ui.panelPosition).toBe("bottom-right");
  });
});

describe("migratePersistedRoot — in-flight transaction is carried through", () => {
  /**
   * Regression: the section-repair step rebuilt the root from an explicit field
   * list and silently dropped `pendingIntent`.
   *
   * That is a safety regression rather than a data one. A lost
   * `send-attempted` record is indistinguishable from "never sent", so a
   * migration could enable a second click on a job that had already been
   * contacted.
   */
  const intent = {
    id: "intent-1",
    jobId: "job-1",
    sourceUrl: "https://www.zhipin.com/web/geek/job",
    phase: "send-attempted",
    messageText: "您好",
    outgoingBaseline: 0,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_180_000,
    sendAttemptedAt: 1_700_000_000_000,
    clickDispatched: 1_700_000_000_500,
  };

  it("survives a migration that runs", () => {
    const result = migratePersistedRoot({
      schemaVersion: 3,
      config: {},
      applications: [],
      statistics: {},
      pendingIntent: intent,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A dropped record here could authorise a duplicate send.
    expect(result.root.pendingIntent).toEqual(intent);
  });

  it("survives a document that is already current", () => {
    const result = migratePersistedRoot({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      config: {},
      applications: [],
      statistics: {},
      pendingIntent: intent,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.pendingIntent).toEqual(intent);
  });

  it("stays absent when no transaction is in flight", () => {
    const result = migratePersistedRoot({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      config: {},
      applications: [],
      statistics: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("pendingIntent" in result.root).toBe(false);
  });
});
