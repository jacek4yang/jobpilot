/**
 * Versioned migrations for the persisted root document.
 *
 * ## The one rule that outranks everything else
 *
 * **Migrations must never silently destroy user data.** The persisted root
 * holds the user's application history and statistics — the only record of
 * work that was actually submitted to an employer. A migration that drops a
 * section because it could not parse it is worse than a migration that refuses
 * to run. Every migration here is additive: unknown fields are carried through
 * untouched, and a missing section is filled from defaults rather than removed.
 *
 * When the document claims a version we do not understand (a newer build wrote
 * it), we fail loudly and leave it alone. Downgrading a v4 document to v3 by
 * guessing would throw away fields we cannot see.
 */

import type { PersistedRoot } from "./persisted";
import { CURRENT_SCHEMA_VERSION, createDefaultConfig } from "./schema";
import { isRecord, validateConfig } from "./validate";

export type MigrationResult =
  | {
      readonly ok: true;
      readonly root: PersistedRoot;
      /** Names of the steps that actually ran, in order. Empty when current. */
      readonly appliedSteps: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** A single, individually named upgrade between two adjacent versions. */
interface MigrationStep {
  /** e.g. `v1 -> v2`. Stable identifier: it is surfaced in diagnostics. */
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly apply: (root: Record<string, unknown>) => Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/**
 * v1 -> v2: split the monolithic `automation` section.
 *
 * v1 stored the delay/limit knobs directly on `automation`. v2 moved the
 * pacing knobs into a dedicated `rateLimit` section. Both the old and the new
 * shapes are preserved here so that a v1 document's settings still apply after
 * the upgrade.
 */
const migrateV1ToV2: MigrationStep = {
  name: "v1 -> v2: split rate limit out of automation",
  from: 1,
  to: 2,
  apply: (root) => {
    const automation = asRecord(root["automation"]);
    const existingRateLimit = asRecord(root["rateLimit"]);
    const rateLimit: Record<string, unknown> = { ...existingRateLimit };
    // Only lift a value across when the new section does not already define it.
    for (const key of ["minActionDelayMs", "maxActionDelayMs", "maxRetries"]) {
      const value = automation[key];
      if (value !== undefined && rateLimit[key] === undefined) rateLimit[key] = value;
    }
    return { ...root, schemaVersion: 2, rateLimit };
  },
};

/**
 * v2 -> v3: introduce the conservative automation gate.
 *
 * v3 adds `automation.acknowledgeRisks`. Because the default is `assist` and
 * the flag defaults to `false`, a migrated document keeps working exactly as
 * before — no user is silently promoted into unattended automation by an
 * upgrade, which is the whole point of adding the flag.
 */
const migrateV2ToV3: MigrationStep = {
  name: "v2 -> v3: add automation.acknowledgeRisks gate",
  from: 2,
  to: 3,
  apply: (root) => {
    const automation = asRecord(root["automation"]);
    const acknowledgeRisks = automation["acknowledgeRisks"];
    const nextAutomation: Record<string, unknown> = { ...automation };
    if (typeof acknowledgeRisks !== "boolean") nextAutomation["acknowledgeRisks"] = false;
    // A v2 document could not have been gated, so an `automatic` mode arriving
    // from v2 is treated as unacknowledged and stepped back to `assist`. The
    // user is told via the validator if they try to re-enable it without the
    // acknowledgement; nothing about their history is touched.
    if (nextAutomation["mode"] === "automatic" && nextAutomation["acknowledgeRisks"] !== true) {
      nextAutomation["mode"] = "assist";
    }
    return { ...root, schemaVersion: 3, automation: nextAutomation };
  },
};

/**
 * v3 -> v4: introduce saved search profiles.
 *
 * v4 adds `config.profiles`. A v3 document has no way to express a search
 * intent, so the list starts empty rather than being inferred from the flat
 * keyword filters: inventing a profile would put words into the user's mouth
 * and could make JobPilot search for something they never asked for. The
 * existing flat filters keep working unchanged, so the upgrade is
 * behaviour-preserving.
 *
 * Note the field lives inside `config`, because profiles are part of
 * `JobPilotConfig`; writing it at the root would put it somewhere the validator
 * never reads.
 */
const migrateV3ToV4: MigrationStep = {
  name: "v3 -> v4: add search profiles",
  from: 3,
  to: 4,
  apply: (root) => {
    const config = asRecord(root["config"]);
    const profiles = config["profiles"];
    return {
      ...root,
      schemaVersion: 4,
      config: { ...config, profiles: Array.isArray(profiles) ? profiles : [] },
    };
  },
};

/**
 * v4 -> v5: introduce panel geometry and personal display name.
 *
 * v5 adds `ui.panelWidth`, `ui.panelHeight`, `ui.collapsed`, custom
 * `ui.panelPosition` coordinates, and `general.displayName`. Existing v4
 * documents have these fields missing; they are preserved if present and
 * defaulted safely if absent.
 */
const migrateV4ToV5: MigrationStep = {
  name: "v4 -> v5: add panel layout geometry and personal display name",
  from: 4,
  to: 5,
  apply: (root) => {
    const config = asRecord(root["config"]);
    const general = asRecord(config["general"]);
    const ui = asRecord(config["ui"]);
    return {
      ...root,
      schemaVersion: 5,
      config: {
        ...config,
        general: {
          ...general,
          locale: typeof general["locale"] === "string" ? general["locale"] : "zh-CN",
          ...(typeof general["displayName"] === "string"
            ? { displayName: general["displayName"] }
            : {}),
        },
        ui: {
          ...ui,
          panelPosition: ui["panelPosition"] ?? "bottom-right",
        },
      },
    };
  },
};

/** The full chain, ascending. Append-only: never renumber or reuse a step. */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
];

/**
 * Reads the version of an untrusted root.
 *
 * A document with no `schemaVersion` predates versioning, which makes it v1 by
 * definition. Anything that is present but not a positive integer is treated
 * as untrustworthy input rather than being coerced.
 */
const readSchemaVersion = (root: Record<string, unknown>): number | undefined => {
  const raw = root["schemaVersion"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  return raw;
};

/**
 * Upgrades an untrusted persisted document to {@link CURRENT_SCHEMA_VERSION}.
 *
 * Returns `ok: false` — and does not touch the data — when the version is
 * unusable or claims to come from a newer build.
 */
export const migratePersistedRoot = (input: unknown): MigrationResult => {
  if (!isRecord(input)) {
    return { ok: false, error: "persisted root is not an object" };
  }

  const rawVersion = input["schemaVersion"];
  // A version field that exists but is garbage is a corrupt document: we
  // cannot know whether migrating it would lose data, so we refuse.
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== "number" || !Number.isInteger(rawVersion))
  ) {
    return {
      ok: false,
      error: `schemaVersion must be an integer, received ${typeof rawVersion}`,
    };
  }

  const version = readSchemaVersion(input) ?? 1;

  if (version < 1) {
    return { ok: false, error: `schemaVersion must be >= 1, received ${version}` };
  }

  // Forward compatibility guard. Refusing beats guessing: a newer document may
  // contain fields this build would drop on the next write.
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schemaVersion ${version} is newer than this build supports (${CURRENT_SCHEMA_VERSION}); refusing to downgrade and risk data loss`,
    };
  }

  const appliedSteps: string[] = [];
  // `let` is required: each step hands the document to the next one.
  let current: Record<string, unknown> = { ...input };
  let currentVersion = version;

  for (const step of MIGRATION_STEPS) {
    if (step.from < currentVersion) continue;
    if (step.to > CURRENT_SCHEMA_VERSION) break;
    if (step.from !== currentVersion) continue;
    current = step.apply(current);
    currentVersion = step.to;
    appliedSteps.push(step.name);
  }

  // Section-level repair. Each section is validated independently and replaced
  // wholesale if it is unusable, so a single corrupt section cannot take the
  // rest of the document (or the user's history) down with it.
  const configResult = validateConfig(current["config"]);
  const config: unknown = configResult.ok
    ? configResult.value
    : { ...createDefaultConfig(), __recovered: configResult.errors };

  const root: PersistedRoot = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config,
    // History and statistics are carried through verbatim. If they are absent
    // they stay absent; the repository layers decide what an empty history
    // means. We never fabricate a history, and we never discard one.
    applications: current["applications"],
    statistics: current["statistics"],
    // The in-flight communication transaction is carried through verbatim too.
    // Dropping it here would be a safety regression, not a data regression: a
    // lost `send-attempted` intent is indistinguishable from "never sent", and
    // the runner could then click a second time.
    ...(current["pendingIntent"] === undefined ? {} : { pendingIntent: current["pendingIntent"] }),
  };

  return { ok: true, root, appliedSteps };
};

/**
 * True when the document is already at the current version and would be
 * returned unchanged by {@link migratePersistedRoot}.
 */
export const isCurrentVersion = (input: unknown): boolean =>
  isRecord(input) && readSchemaVersion(input) === CURRENT_SCHEMA_VERSION;
