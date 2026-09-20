/**
 * Persistence repository.
 *
 * Owns the single storage key JobPilot writes. Every read goes through
 * migration + validation, so a document written by an older build (or a
 * corrupted one) can never be trusted blindly.
 */
import type { Storage } from "../ports/storage";
import type { Logger } from "../ports/logger";
import type { PersistedRoot } from "../config/persisted";
import { CURRENT_SCHEMA_VERSION, createDefaultConfig } from "../config/schema";
import type { JobPilotConfig } from "../config/schema";
import { migratePersistedRoot } from "../config/migrations";
import { validateConfig } from "../config/validate";
import type { ApplicationRecord } from "../domain/application/application";
import type { JobId, PlatformId } from "../domain/support/ids";
import { asJobId } from "../domain/support/ids";
import { createApplicationRecord } from "../domain/application/application";
import { deserializeHistory } from "../application/history";

export const STORAGE_KEY = "jobpilot:root:v1";

export interface LoadResult {
  readonly config: JobPilotConfig;
  readonly applications: readonly ApplicationRecord[];
  /** Non-fatal problems encountered while loading, for diagnostics. */
  readonly warnings: readonly string[];
  /** True when no persisted document existed. */
  readonly fresh: boolean;
}

export interface Repository {
  load(): Promise<LoadResult>;
  save(root: { config: JobPilotConfig; applications: readonly ApplicationRecord[] }): Promise<void>;
  /** Wipes the persisted document. Used by the "reset" action. */
  clear(): Promise<void>;
}

/**
 * Serialises application records into a JSON-safe shape.
 *
 * Kept explicit rather than relying on `JSON.stringify` of live objects, so a
 * future field addition cannot silently leak internal state into storage.
 */
const serializeApplications = (records: readonly ApplicationRecord[]): unknown =>
  records.map((record) => ({
    id: record.id,
    jobId: record.jobId,
    platform: record.platform,
    status: record.status,
    attempts: record.attempts,
    reasons: record.reasons,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.score === undefined ? {} : { score: record.score }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  }));

/**
 * Reads and rehydrates the persisted document.
 *
 * Failure policy: every failure path yields a usable default rather than
 * throwing, because a userscript that refuses to start is worse than one that
 * starts with defaults. Failures are surfaced as warnings so they appear in
 * diagnostics instead of being swallowed.
 */
export const createRepository = (storage: Storage, logger: Logger): Repository => {
  return {
    async load(): Promise<LoadResult> {
      const warnings: string[] = [];
      const raw = await storage.get<unknown>(STORAGE_KEY);

      if (raw === undefined) {
        return {
          config: createDefaultConfig(),
          applications: [],
          warnings,
          fresh: true,
        };
      }

      const migrated = migratePersistedRoot(raw);
      if (!migrated.ok) {
        logger.error("repository", "migration failed", { error: migrated.error });
        warnings.push(`migration failed: ${migrated.error}`);
        return { config: createDefaultConfig(), applications: [], warnings, fresh: false };
      }

      if (migrated.appliedSteps.length > 0) {
        warnings.push(`applied migrations: ${migrated.appliedSteps.join(", ")}`);
      }

      const validated = validateConfig(migrated.root.config);
      if (!validated.ok) {
        logger.warn("repository", "stored config invalid, using defaults", {
          errors: validated.errors,
        });
        warnings.push(`config invalid: ${validated.errors.join("; ")}`);
      }

      const applications = deserializeHistory(migrated.root.applications);
      const expectedCount = Array.isArray(migrated.root.applications)
        ? migrated.root.applications.length
        : 0;
      if (expectedCount > applications.length) {
        warnings.push(
          `dropped ${expectedCount - applications.length} malformed application record(s)`,
        );
      }

      return {
        config: validated.ok ? validated.value : createDefaultConfig(),
        applications,
        warnings,
        fresh: false,
      };
    },

    async save({ config, applications }) {
      const root: PersistedRoot = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config,
        applications: serializeApplications(applications),
        statistics: {},
      };
      await storage.set(STORAGE_KEY, root);
    },

    async clear() {
      await storage.delete(STORAGE_KEY);
    },
  };
};

/** Re-exported so the bootstrap does not need to import two modules. */
export { createApplicationRecord, asJobId };
export type { JobId, PlatformId };
