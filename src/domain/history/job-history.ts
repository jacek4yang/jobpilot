/**
 * Job history.
 *
 * A compact, local record of what JobPilot did with each job. Deliberately
 * stores the *minimum* needed to answer "have I dealt with this, and how did it
 * go?" — never full chat content, never recruiter replies.
 *
 * This is also the second layer of duplicate-send prevention: a job with a
 * `contacted` outcome is never enqueued again.
 */
import type { JobId, PlatformId } from "../support/ids";

export type HistoryOutcome =
  | "rejected"
  | "skipped"
  | "contacted"
  | "failed"
  /** Send attempted, outcome unobservable. Requires user resolution. */
  | "uncertain";

export const HISTORY_OUTCOMES: readonly HistoryOutcome[] = [
  "rejected",
  "skipped",
  "contacted",
  "failed",
  "uncertain",
];

/**
 * Outcomes that mean the job must not be contacted again.
 *
 * `uncertain` is included: we do not know whether a message went out, so
 * retrying could duplicate it. Only an explicit user decision may clear it.
 */
export const BLOCKING_OUTCOMES: readonly HistoryOutcome[] = ["contacted", "uncertain"];

export const blocksFurtherContact = (outcome: HistoryOutcome): boolean =>
  BLOCKING_OUTCOMES.includes(outcome);

export interface JobHistoryRecord {
  readonly jobId: JobId;
  readonly platform: PlatformId;
  readonly title: string;
  readonly company: string;
  readonly score?: number;
  readonly outcome: HistoryOutcome;
  /** Human-readable explanation, e.g. the deciding rule or failure. */
  readonly reason?: string;
  /** Typed failure code when the outcome is `failed` or `uncertain`. */
  readonly failureCode?: string;
  readonly firstSeenAt: number;
  readonly lastProcessedAt: number;
}

export interface HistoryQuery {
  readonly text?: string;
  readonly outcomes?: readonly HistoryOutcome[];
  readonly since?: number;
  readonly limit?: number;
}

/** Case-insensitive search over title and company only. */
const matchesText = (record: JobHistoryRecord, needle: string): boolean => {
  const text = needle.trim().toLowerCase();
  if (text.length === 0) return true;
  return record.title.toLowerCase().includes(text) || record.company.toLowerCase().includes(text);
};

export interface JobHistory {
  /** Records or updates an entry, preserving `firstSeenAt`. */
  record(
    entry: Omit<JobHistoryRecord, "firstSeenAt" | "lastProcessedAt"> & {
      readonly now: number;
    },
  ): JobHistoryRecord;
  get(jobId: JobId): JobHistoryRecord | undefined;
  /** Job ids that must not be contacted again. */
  blockedJobIds(): ReadonlySet<string>;
  query(query?: HistoryQuery): readonly JobHistoryRecord[];
  all(): readonly JobHistoryRecord[];
  /** Number of records per outcome. */
  counts(): Readonly<Record<HistoryOutcome, number>>;
  clear(): void;
  /** Removes only records that are safe to forget. */
  clearNonBlocking(): number;
  hydrate(records: readonly JobHistoryRecord[]): void;
  serialize(): readonly JobHistoryRecord[];
}

const emptyCounts = (): Record<HistoryOutcome, number> => ({
  rejected: 0,
  skipped: 0,
  contacted: 0,
  failed: 0,
  uncertain: 0,
});

export const createJobHistory = (initial: readonly JobHistoryRecord[] = []): JobHistory => {
  let records = new Map<string, JobHistoryRecord>(initial.map((record) => [record.jobId, record]));

  return {
    record(entry) {
      const existing = records.get(entry.jobId);
      const next: JobHistoryRecord = {
        jobId: entry.jobId,
        platform: entry.platform,
        title: entry.title,
        company: entry.company,
        outcome: entry.outcome,
        firstSeenAt: existing?.firstSeenAt ?? entry.now,
        lastProcessedAt: entry.now,
        ...(entry.score === undefined ? {} : { score: entry.score }),
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(entry.failureCode === undefined ? {} : { failureCode: entry.failureCode }),
      };
      records = new Map(records).set(entry.jobId, next);
      return next;
    },

    get: (jobId) => records.get(jobId),

    blockedJobIds() {
      const ids = new Set<string>();
      for (const record of records.values()) {
        if (blocksFurtherContact(record.outcome)) ids.add(record.jobId);
      }
      return ids;
    },

    query(query = {}) {
      let out = [...records.values()];

      if (query.text !== undefined) {
        out = out.filter((record) => matchesText(record, query.text ?? ""));
      }
      if (query.outcomes !== undefined && query.outcomes.length > 0) {
        out = out.filter((record) => query.outcomes?.includes(record.outcome) === true);
      }
      if (query.since !== undefined) {
        out = out.filter((record) => record.lastProcessedAt >= (query.since ?? 0));
      }

      out.sort((a, b) => b.lastProcessedAt - a.lastProcessedAt);
      return query.limit === undefined ? out : out.slice(0, query.limit);
    },

    all: () => [...records.values()],

    counts() {
      const counts = emptyCounts();
      for (const record of records.values()) counts[record.outcome] += 1;
      return counts;
    },

    clear() {
      records = new Map();
    },

    clearNonBlocking() {
      const before = records.size;
      // Never forget a contacted or uncertain job: forgetting a `contacted`
      // record would allow a duplicate message, and forgetting an `uncertain`
      // one would hide a message the user still has to check.
      records = new Map(
        [...records.entries()].filter(([, record]) => blocksFurtherContact(record.outcome)),
      );
      return before - records.size;
    },

    hydrate(next) {
      records = new Map(next.map((record) => [record.jobId, record]));
    },

    serialize: () => [...records.values()],
  };
};

const OUTCOME_SET: ReadonlySet<string> = new Set(HISTORY_OUTCOMES);

/**
 * Rehydrates history from untrusted JSON.
 *
 * Malformed records are dropped. A dropped `contacted` record could allow a
 * duplicate message, so the count of dropped records is reported for
 * diagnostics rather than swallowed.
 */
export const deserializeJobHistory = (
  input: unknown,
): { readonly records: readonly JobHistoryRecord[]; readonly dropped: number } => {
  if (!Array.isArray(input)) return { records: [], dropped: 0 };

  const records: JobHistoryRecord[] = [];
  let dropped = 0;

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      dropped += 1;
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const jobId = candidate["jobId"];
    const platform = candidate["platform"];
    const title = candidate["title"];
    const company = candidate["company"];
    const outcome = candidate["outcome"];
    const firstSeenAt = candidate["firstSeenAt"];
    const lastProcessedAt = candidate["lastProcessedAt"];

    if (typeof jobId !== "string" || jobId.length === 0) {
      dropped += 1;
      continue;
    }
    if (typeof platform !== "string" || platform.length === 0) {
      dropped += 1;
      continue;
    }
    if (typeof outcome !== "string" || !OUTCOME_SET.has(outcome)) {
      dropped += 1;
      continue;
    }
    if (typeof firstSeenAt !== "number" || !Number.isFinite(firstSeenAt)) {
      dropped += 1;
      continue;
    }
    if (typeof lastProcessedAt !== "number" || !Number.isFinite(lastProcessedAt)) {
      dropped += 1;
      continue;
    }

    const score = candidate["score"];
    const reason = candidate["reason"];
    const failureCode = candidate["failureCode"];

    records.push({
      jobId: jobId as JobId,
      platform: platform as PlatformId,
      title: typeof title === "string" ? title : "",
      company: typeof company === "string" ? company : "",
      outcome: outcome as HistoryOutcome,
      firstSeenAt,
      lastProcessedAt,
      ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
      ...(typeof failureCode === "string" ? { failureCode } : {}),
    });
  }

  return { records, dropped };
};

/** Session and daily statistics derived from history plus live counters. */
export interface Statistics {
  readonly discovered: number;
  readonly evaluated: number;
  readonly matched: number;
  readonly queued: number;
  readonly contacted: number;
  readonly skipped: number;
  readonly failed: number;
}

export const emptyStatistics: Statistics = {
  discovered: 0,
  evaluated: 0,
  matched: 0,
  queued: 0,
  contacted: 0,
  skipped: 0,
  failed: 0,
};

/** Derives the contacted count for a day from history, for daily limits. */
export const contactedSince = (records: readonly JobHistoryRecord[], since: number): number =>
  records.filter(
    (record) =>
      (record.outcome === "contacted" || record.outcome === "uncertain") &&
      record.lastProcessedAt >= since,
  ).length;
