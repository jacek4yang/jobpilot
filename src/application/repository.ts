/**
 * Persistence repository.
 *
 * Owns the single storage key JobPilot writes. Every read goes through
 * migration + validation, so a document written by an older build (or a
 * corrupted one) can never be trusted blindly.
 */

import { deserializeHistory } from "../application/history";
import { migratePersistedRoot } from "../config/migrations";
import type { PersistedRoot } from "../config/persisted";
import type { JobPilotConfig } from "../config/schema";
import { CURRENT_SCHEMA_VERSION, createDefaultConfig } from "../config/schema";
import { validateConfig } from "../config/validate";
import type { ApplicationRecord } from "../domain/application/application";
import { createApplicationRecord } from "../domain/application/application";
import type { CommunicationIntent } from "../domain/communication/intent";
import { deserializeIntent, serializeIntent } from "../domain/communication/intent";
import type { JobId, PlatformId } from "../domain/support/ids";
import { asJobId } from "../domain/support/ids";
import type { Logger } from "../ports/logger";
import type { Storage } from "../ports/storage";

export const STORAGE_KEY = "jobpilot:root:v1";

export interface LoadResult {
  readonly config: JobPilotConfig;
  readonly applications: readonly ApplicationRecord[];
  /** Non-fatal problems encountered while loading, for diagnostics. */
  readonly warnings: readonly string[];
  /** True when no persisted document existed. */
  readonly fresh: boolean;
  /**
   * True when the stored document could NOT be read safely — most importantly
   * when it was written by a newer schema version and the migration chain
   * refused to touch it.
   *
   * When this is true the caller MUST NOT save. The in-memory defaults are a
   * placeholder for rendering, not a replacement for the user's data: writing
   * them back would destroy an intact document that a future build can still
   * read.
   */
  readonly writeBlocked: boolean;
  /**
   * The in-flight communication transaction recovered from storage, if any.
   *
   * A transaction in `send-attempted` here means a send may already have been
   * dispatched before the page went away. The caller must resolve it by
   * observation, never by re-sending.
   */
  readonly pendingIntent: CommunicationIntent | undefined;
}

export interface Repository {
  load(): Promise<LoadResult>;
  /**
   * Persists the document.
   *
   * Refuses (without throwing) once a blocked load has been observed, so a
   * document we could not interpret is never overwritten by defaults.
   */
  save(root: {
    config: JobPilotConfig;
    applications: readonly ApplicationRecord[];
    /** The in-flight transaction, or undefined when none is active. */
    pendingIntent?: CommunicationIntent | undefined;
  }): Promise<{ readonly saved: boolean; readonly reason?: string }>;
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
  /**
   * Set once a load reveals a document we could not read. Sticky for the
   * lifetime of the repository: a single blocked load means the on-disk data
   * is not ours to replace, even if a later load happens to succeed.
   */
  let writesBlocked = false;

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
          writeBlocked: false,
          pendingIntent: undefined,
        };
      }

      const migrated = migratePersistedRoot(raw);
      if (!migrated.ok) {
        // The stored document exists but we cannot interpret it. Refusing to
        // migrate is the correct, data-preserving choice — so we must also
        // refuse to WRITE, otherwise the next save would overwrite a document
        // that a newer build could still read. Return defaults for rendering
        // only, with writes blocked.
        writesBlocked = true;
        logger.error("repository", "migration failed; writes blocked to preserve data", {
          error: migrated.error,
        });
        warnings.push(
          `stored data could not be read (${migrated.error}); JobPilot is running read-only and will not overwrite it`,
        );
        return {
          config: createDefaultConfig(),
          applications: [],
          warnings,
          fresh: false,
          writeBlocked: true,
          // The document is unreadable, so we cannot trust anything in it —
          // including any intent. Reporting none keeps the runner from acting
          // on a half-parsed transaction; the read-only warning explains why.
          pendingIntent: undefined,
        };
      }

      if (migrated.appliedSteps.length > 0) {
        warnings.push(`applied migrations: ${migrated.appliedSteps.join(", ")}`);
      }

      // Reaching here means the document was readable, so writes stay allowed.
      const validated = validateConfig(migrated.root.config);
      if (!validated.ok) {
        logger.warn("repository", "stored config invalid, using defaults", {
          errors: validated.errors,
        });
        warnings.push(`config invalid: ${validated.errors.join("; ")}`);
      }

      // Recover the in-flight transaction. `deserializeIntent` validates
      // strictly and returns undefined for anything it cannot fully parse, so a
      // corrupt intent is dropped rather than guessed at — which errs toward
      // asking the user instead of toward an unintended send.
      const recoveredIntent = deserializeIntent(migrated.root.pendingIntent);
      if (migrated.root.pendingIntent !== undefined && recoveredIntent === undefined) {
        warnings.push("a stored communication transaction was unreadable and has been discarded");
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
        writeBlocked: false,
        pendingIntent: recoveredIntent,
      };
    },

    async save({ config, applications, pendingIntent }) {
      if (writesBlocked) {
        // Silently refusing is deliberate: the caller may be a timer or an
        // effect, and throwing would surface an error the user cannot act on.
        // The load-time warning is what tells the user why nothing persists.
        logger.warn("repository", "save refused: stored data could not be read", {
          consequence: "the existing document is preserved unchanged",
        });
        return { saved: false, reason: "stored data could not be read" };
      }

      const root: PersistedRoot = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config,
        applications: serializeApplications(applications),
        statistics: {},
        // Omitted entirely when there is no transaction, so storage does not
        // accumulate a stale intent after one completes.
        ...(pendingIntent === undefined ? {} : { pendingIntent: serializeIntent(pendingIntent) }),
      };
      await storage.set(STORAGE_KEY, root);
      return { saved: true };
    },

    async clear() {
      await storage.delete(STORAGE_KEY);
    },
  };
};

export type { JobId, PlatformId };
/** Re-exported so the bootstrap does not need to import two modules. */
export { asJobId, createApplicationRecord };
