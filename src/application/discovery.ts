/**
 * Discovery: turn a search profile into a list of evaluated matches.
 *
 * Orchestrates the pipeline the product spec describes:
 *
 *   profile -> apply search -> parse cards -> stage A -> stage B -> matches
 *
 * Two properties matter more than throughput:
 *  - Stage A runs before anything is opened, so a rejected job never costs a
 *    navigation.
 *  - Discovery NEVER enqueues. It returns matches for human review; the caller
 *    builds the queue from an explicit selection.
 */
import type { JobDetail, JobSummary } from "../domain/job/job";
import type { Logger } from "../ports/logger";
import type { JobPlatform, PageKind } from "../ports/job-platform";
import { evaluateStageA, evaluateStageB } from "../domain/matching/two-stage";
import type { SearchProfile } from "../domain/search-profile/profile";
import type { RecruiterActivity } from "../domain/recruiter/activity";
import type { ActivityPreference } from "../domain/search-profile/profile";
import type { StageReason } from "../domain/matching/two-stage";

/** A discovered job, with the decision that was made about it. */
export interface Match {
  readonly summary: JobSummary;
  /** Present only when the job survived stage A and was opened. */
  readonly detail?: JobDetail;
  readonly accepted: boolean;
  readonly score: number;
  readonly reasons: readonly StageReason[];
  /** Which stage produced the terminal decision. */
  readonly decidedAt: "A" | "B";
}

export type DiscoveryFailure =
  | { readonly kind: "page-kind"; readonly pageKind: PageKind }
  | { readonly kind: "city"; readonly city: string; readonly suggestions: readonly string[] }
  | { readonly kind: "no-jobs" }
  | { readonly kind: "aborted" }
  | { readonly kind: "error"; readonly message: string };

export type DiscoveryResult =
  | {
      readonly ok: true;
      readonly matches: readonly Match[];
      /** Cards seen but not parsed. Reported so partial parses are visible. */
      readonly unparsed: number;
    }
  | { readonly ok: false; readonly failure: DiscoveryFailure };

export interface DiscoveryDeps {
  readonly platform: JobPlatform;
  readonly logger: Logger;
  /** Resolves a profile's city names to platform city codes. */
  readonly resolveCities: (
    cities: readonly string[],
  ) => { readonly ok: true; readonly codes: readonly string[] } | { readonly ok: false; readonly city: string; readonly suggestions: readonly string[] };
  readonly contactedJobIds: ReadonlySet<string>;
  readonly companyBlacklist: readonly string[];
  readonly titleBlacklist: readonly string[];
  readonly scoring: {
    readonly baseScore: number;
    readonly acceptThreshold: number;
    readonly preferredSkills: readonly { readonly keyword: string; readonly weight: number }[];
    readonly preferredIndustries: readonly { readonly keyword: string; readonly weight: number }[];
  };
  readonly activityPreference: ActivityPreference;
  readonly skipUnknownActivity: boolean;
  /** Reads recruiter activity for a job; adapters may return undefined. */
  readonly readActivity: (job: JobDetail) => RecruiterActivity | undefined;
  readonly signal?: AbortSignal;
}

/** Pages on which discovery cannot proceed. */
const BLOCKING_PAGES: readonly PageKind[] = [
  "captcha",
  "login-required",
  "unsupported",
  "unknown",
];

export interface DiscoveryService {
  run(profile: SearchProfile): Promise<DiscoveryResult>;
}

export const createDiscoveryService = (deps: DiscoveryDeps): DiscoveryService => {
  const isAborted = (): boolean => deps.signal?.aborted === true;

  const run = async (profile: SearchProfile): Promise<DiscoveryResult> => {
    if (isAborted()) return { ok: false, failure: { kind: "aborted" } };

    // 1. Validate the profile's cities before doing anything else. An unknown
    //    city must stop discovery rather than silently searching elsewhere.
    if (profile.cities.length > 0) {
      const resolved = deps.resolveCities(profile.cities);
      if (!resolved.ok) {
        deps.logger.warn("discovery", "unknown city in profile", { city: resolved.city });
        return {
          ok: false,
          failure: {
            kind: "city",
            city: resolved.city,
            suggestions: resolved.suggestions,
          },
        };
      }
    }

    // 2. Fail closed on a page we do not understand, before touching the DOM.
    const pageKind = deps.platform.detectPage();
    if (BLOCKING_PAGES.includes(pageKind)) {
      deps.logger.warn("discovery", "refusing to scan an unusable page", { pageKind });
      return { ok: false, failure: { kind: "page-kind", pageKind } };
    }

    // 3. Scan.
    let summaries: readonly JobSummary[];
    try {
      summaries = await deps.platform.scanJobs(
        deps.signal === undefined ? {} : { signal: deps.signal },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error("discovery", "scan failed", { error: message });
      return { ok: false, failure: { kind: "error", message } };
    }

    if (isAborted()) return { ok: false, failure: { kind: "aborted" } };

    if (summaries.length === 0) {
      deps.logger.info("discovery", "no jobs found", { pageKind });
      return { ok: false, failure: { kind: "no-jobs" } };
    }

    // 4. Stage A on card data only.
    const matches: Match[] = [];
    const survivors: JobSummary[] = [];

    for (const summary of summaries) {
      const outcome = evaluateStageA({
        summary,
        profile,
        contactedJobIds: deps.contactedJobIds,
        companyBlacklist: deps.companyBlacklist,
        titleBlacklist: deps.titleBlacklist,
      });
      if (outcome.kind === "rejected") {
        matches.push({
          summary,
          accepted: false,
          score: 0,
          reasons: outcome.reasons,
          decidedAt: "A",
        });
      } else {
        survivors.push(summary);
      }
    }

    deps.logger.info("discovery", "stage A complete", {
      considered: summaries.length,
      survivors: survivors.length,
      rejected: matches.length,
    });

    // 5. Stage B, only for survivors, and only by opening each one.
    for (const summary of survivors) {
      if (isAborted()) return { ok: false, failure: { kind: "aborted" } };

      let detail: JobDetail;
      try {
        detail = await deps.platform.loadJob(
          summary,
          deps.signal === undefined ? {} : { signal: deps.signal },
        );
      } catch (error) {
        // A job we cannot open is recorded as rejected with a reason, not
        // silently dropped, so the user can see why it is missing.
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn("discovery", "could not open job", { jobId: summary.id, error: message });
        matches.push({
          summary,
          accepted: false,
          score: 0,
          reasons: [
            {
              code: "DETAIL_TIMEOUT",
              stage: "B",
              message: `could not open the posting: ${message}`,
              delta: 0,
            },
          ],
          decidedAt: "B",
        });
        continue;
      }

      const activity = deps.readActivity(detail);
      const evaluation = evaluateStageB({
        job: detail,
        profile,
        ...(activity === undefined ? {} : { activity }),
        activityPreference: deps.activityPreference,
        skipUnknownActivity: deps.skipUnknownActivity,
        preferredSkills: deps.scoring.preferredSkills,
        preferredIndustries: deps.scoring.preferredIndustries,
        baseScore: deps.scoring.baseScore,
        acceptThreshold: deps.scoring.acceptThreshold,
      });

      matches.push({
        summary,
        detail,
        accepted: evaluation.accepted,
        score: evaluation.score,
        reasons: evaluation.reasons,
        decidedAt: "B",
      });
    }

    return { ok: true, matches, unparsed: 0 };
  };

  return { run };
};

/** Convenience: the accepted matches only, for the default selection. */
export const acceptedMatches = (matches: readonly Match[]): readonly Match[] =>
  matches.filter((match) => match.accepted);

/** Job ids of accepted matches. */
export const acceptedJobIds = (matches: readonly Match[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const match of matches) {
    if (match.accepted) ids.add(String(match.summary.id));
  }
  return ids;
};

/** Formats a rule trace for display, newest-relevant first is not required. */
export const formatReasons = (reasons: readonly StageReason[]): readonly string[] =>
  reasons
    .filter((reason) => reason.delta !== 0 || reason.code !== "location")
    .map((reason) => {
      if (reason.delta > 0) return `+${reason.delta} ${reason.message}`;
      if (reason.delta < 0) return `${reason.delta} ${reason.message}`;
      return reason.message;
    });
