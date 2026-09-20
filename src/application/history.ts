import type { ApplicationRecord, ApplicationStatus } from "../domain/application/application";
import {
  applyTransition,
  canTransitionTo,
  isSubmissionFinal,
} from "../domain/application/application";
import { createApplicationRecord } from "../domain/application/application";
import type { JobId, PlatformId } from "../domain/support/ids";
import { asJobId } from "../domain/support/ids";

/**
 * Application history.
 *
 * This is the authoritative record of what JobPilot has done. The queue is
 * only a scheduler; the history is what prevents a confirmed application from
 * ever being submitted twice.
 */
export interface ApplicationHistory {
  all(): readonly ApplicationRecord[];
  get(jobId: JobId): ApplicationRecord | undefined;
  /** True when the job is known in any state (used by the dedup hard filter). */
  has(jobId: JobId): boolean;
  /** Job ids that must not be re-submitted. */
  submittedJobIds(): ReadonlySet<string>;
  /**
   * Records a job as discovered, creating the record if new.
   * Returns the record unchanged when it already exists.
   */
  discover(platform: PlatformId, jobId: JobId, now: number): ApplicationRecord;
  /**
   * Applies a status transition, refusing illegal ones.
   *
   * Returns the updated record, or the existing record when the transition is
   * not permitted. Refusing silently is intentional: a late async callback
   * must never corrupt history.
   */
  transition(
    jobId: JobId,
    status: ApplicationStatus,
    options: {
      readonly now: number;
      readonly score?: number;
      readonly reasons?: readonly string[];
      readonly error?: string;
      readonly incrementAttempts?: boolean;
    },
  ): ApplicationRecord | undefined;
  /** Number of records in each status, for the UI and diagnostics. */
  counts(): Readonly<Record<ApplicationStatus, number>>;
  /** Replaces all records, used when hydrating from storage. */
  hydrate(records: readonly ApplicationRecord[]): void;
  /** Plain serialisable snapshot for persistence. */
  serialize(): readonly ApplicationRecord[];
}

const emptyCounts = (): Record<ApplicationStatus, number> => ({
  discovered: 0,
  evaluated: 0,
  rejected: 0,
  approved: 0,
  opened: 0,
  submitted: 0,
  verified: 0,
  failed: 0,
});

export const createApplicationHistory = (
  initial: readonly ApplicationRecord[] = [],
): ApplicationHistory => {
  let records = new Map<string, ApplicationRecord>(initial.map((record) => [record.jobId, record]));

  return {
    all: () => [...records.values()],
    get: (jobId) => records.get(jobId),
    has: (jobId) => records.has(jobId),

    submittedJobIds() {
      const ids = new Set<string>();
      for (const record of records.values()) {
        // A record that reached submitted/verified is permanently locked.
        if (isSubmissionFinal(record.status)) ids.add(record.jobId);
      }
      return ids;
    },

    discover(platform, jobId, now) {
      const existing = records.get(jobId);
      if (existing !== undefined) return existing;
      const created = createApplicationRecord({ platform, jobId, now });
      records = new Map(records).set(jobId, created);
      return created;
    },

    transition(jobId, status, options) {
      const existing = records.get(jobId);
      if (existing === undefined) return undefined;

      // Never move a confirmed submission backwards, and never re-submit.
      if (isSubmissionFinal(existing.status) && status !== "failed") return existing;
      if (!canTransitionTo(existing.status, status)) {
        // Allow the idempotent no-op of re-asserting the current status.
        if (existing.status === status) return existing;
        return existing;
      }

      const updated = applyTransition(existing, status, {
        now: options.now,
        ...(options.score === undefined ? {} : { score: options.score }),
        ...(options.reasons === undefined ? {} : { reasons: options.reasons }),
        ...(options.error === undefined ? {} : { error: options.error }),
        ...(options.incrementAttempts === undefined
          ? {}
          : { incrementAttempts: options.incrementAttempts }),
      });
      records = new Map(records).set(jobId, updated);
      return updated;
    },

    counts() {
      const counts = emptyCounts();
      for (const record of records.values()) counts[record.status] += 1;
      return counts;
    },

    hydrate(next) {
      records = new Map(next.map((record) => [record.jobId, record]));
    },

    serialize: () => [...records.values()],
  };
};

/**
 * Rehydrates a history from untrusted persisted JSON.
 *
 * Anything malformed is dropped rather than trusted: a corrupted record must
 * never be able to authorise a duplicate submission.
 */
export const deserializeHistory = (input: unknown): ApplicationRecord[] => {
  if (!Array.isArray(input)) return [];
  const records: ApplicationRecord[] = [];

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const jobId = candidate["jobId"];
    const platform = candidate["platform"];
    const status = candidate["status"];
    const createdAt = candidate["createdAt"];

    if (typeof jobId !== "string" || jobId.length === 0) continue;
    if (typeof platform !== "string" || platform.length === 0) continue;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
    if (!isApplicationStatus(status)) continue;

    const updatedAt = candidate["updatedAt"];
    const score = candidate["score"];
    const attempts = candidate["attempts"];
    const reasons = candidate["reasons"];
    const lastError = candidate["lastError"];

    records.push({
      id: typeof candidate["id"] === "string" ? (candidate["id"] as ApplicationRecord["id"]) : createApplicationRecord({ platform, jobId: asJobId(jobId), now: createdAt }).id,
      jobId: asJobId(jobId),
      platform: platform as ApplicationRecord["platform"],
      status,
      attempts: typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 0,
      reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
      createdAt,
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : createdAt,
      ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
      ...(typeof lastError === "string" ? { lastError } : {}),
    });
  }

  return records;
};

const STATUS_SET: ReadonlySet<string> = new Set([
  "discovered",
  "evaluated",
  "rejected",
  "approved",
  "opened",
  "submitted",
  "verified",
  "failed",
]);

const isApplicationStatus = (value: unknown): value is ApplicationStatus =>
  typeof value === "string" && STATUS_SET.has(value);
