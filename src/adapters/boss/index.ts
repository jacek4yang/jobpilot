/**
 * BOSS Zhipin adapter entry point.
 *
 * ============================ HONESTY NOTICE ============================
 * `BOSS_METADATA.automationVerified` is `false` and MUST stay `false`. The real
 * BOSS Zhipin DOM was never inspected while writing this adapter: it is
 * validated exclusively against synthetic fixtures under `tests/fixtures/boss/`.
 * The adapter is structurally complete and fails closed everywhere it is unsure,
 * but real-site automation is UNVERIFIED. Do not describe it as working.
 * =======================================================================
 *
 * Fail-closed summary:
 *   - an unrecognised page kind returns an empty scan / a `blocked` apply
 *   - a missing required anchor returns `null` from the detail parser, surfaced
 *     as `BlockReason: "unknown-dom"`
 *   - an unconfirmed click returns `needs-confirmation`, never `submitted`
 */

import type { JobDetail, JobSummary } from "../../domain/job/job";
import type { Clock } from "../../domain/support/shared";
import type {
  ApplyOptions,
  ApplyResult,
  JobPlatform,
  PageKind,
  ScanOptions,
  VerificationResult,
} from "../../ports/job-platform";
import type { Logger } from "../../ports/logger";
import { isAborted, throwIfAborted } from "./actions/abort";
import { createApplyAction } from "./actions/apply-action";
import { parseBossJobDetail } from "./parser/detail-parser";
import { parseBossJobList } from "./parser/list-parser";
import { detectBossPageKind } from "./parser/page-kind";

/** Stable adapter id, used as the `PlatformId` for every job it produces. */
export const BOSS_PLATFORM_ID = "boss";

/** Human-readable adapter name for the UI and diagnostics. */
export const BOSS_DISPLAY_NAME = "BOSS Zhipin";

/**
 * Machine-readable adapter metadata.
 *
 * `automationVerified: false` is the important field: it is a literal type, so
 * any attempt to claim otherwise fails to compile. `matches` lists the hosts the
 * adapter *believes* it supports; only the first two were chosen deliberately,
 * and even those were not validated against the live site.
 */
export const BOSS_METADATA = {
  id: BOSS_PLATFORM_ID,
  displayName: BOSS_DISPLAY_NAME,
  matches: ["https://www.zhipin.com/*", "https://zhipin.com/*"] as readonly string[],
  automationVerified: false as const,
  notes:
    "Selectors and guards are validated only against synthetic fixtures in tests/fixtures/boss/. The real BOSS Zhipin DOM was never inspected, so scanning, parsing and applying on the live site are unverified. Every uncertain path fails closed (blocked / unknown / needs-confirmation).",
} as const;

/** Dependencies injected into the adapter. All optional-but-explicit for tests. */
export interface BossPlatformDeps {
  /** Document used for detection and parsing. Read-only by contract. */
  readonly document: Document;
  /** Location used for host checks. */
  readonly location: Location;
  readonly logger: Logger;
  readonly clock: Clock;
  /** JobPilot version string, surfaced in diagnostics. */
  readonly version: string;
}

/**
 * Builds a `JobPlatform` for BOSS Zhipin.
 *
 * Failure modes:
 *   - `detectPage()` never throws; unreadable structure yields `"unknown"`
 *   - `scanJobs()` returns `[]` on any non-list page, an empty list, or an
 *     aborted signal — it never falls back to parsing "whatever is there"
 *   - `loadJob()` throws when the detail cannot be parsed or the page is not a
 *     detail page, because a `JobDetail` cannot honestly be fabricated
 *   - `apply()` / `verifyApplication()` delegate to the fail-closed action
 */
export const createBossPlatform = (deps: BossPlatformDeps): JobPlatform => {
  const { document: doc, location, logger, clock, version } = deps;

  const applyAction = createApplyAction({ root: doc, clock, logger });

  const logDetection = (kind: PageKind): PageKind => {
    logger.debug("boss.detect", "page classified", {
      kind,
      version,
      url: location.href.split("?")[0] ?? "",
    });
    return kind;
  };

  return {
    id: BOSS_PLATFORM_ID,
    displayName: BOSS_DISPLAY_NAME,

    /** Pure w.r.t. the injected document and location; performs no writes. */
    detectPage(): PageKind {
      return logDetection(detectBossPageKind(doc, location));
    },

    /** Scans the current page. Returns `[]` unless the page is a job list. */
    async scanJobs(options?: ScanOptions): Promise<readonly JobSummary[]> {
      throwIfAborted(options?.signal);

      const kind = detectBossPageKind(doc, location);
      if (kind !== "job-list") {
        logger.info("boss.scan", "scan skipped: page is not a job list", { kind });
        return [];
      }

      const result = parseBossJobList(doc, BOSS_PLATFORM_ID);
      if (result.skipped > 0) {
        logger.warn("boss.scan", "some job cards were skipped", {
          considered: result.considered,
          parsed: result.jobs.length,
          skipped: result.skipped,
        });
      }

      if (isAborted(options?.signal)) return [];

      const limit = options?.limit;
      if (limit === undefined || limit >= result.jobs.length) return result.jobs;
      return limit <= 0 ? [] : result.jobs.slice(0, limit);
    },

    /**
     * Opens (re-parses) the currently displayed detail page for `job`.
     *
     * Failure mode: throws rather than returning a partial detail. Callers are
     * expected to check `detectPage()` first; a null parse means the required
     * anchors were missing, which is a hard stop (`unknown-dom`).
     */
    async loadJob(job: JobSummary, options?: ApplyOptions): Promise<JobDetail> {
      throwIfAborted(options?.signal);

      const kind = detectBossPageKind(doc, location);
      if (kind !== "job-detail") {
        throw new Error(
          `boss.loadJob: expected a job-detail page but detected "${kind}"; refusing to parse a page we do not recognise`,
        );
      }

      const detail = parseBossJobDetail(doc, job, clock.now());
      if (detail === null) {
        throw new Error(
          "boss.loadJob: required detail anchors missing (title/company/description/qualification chips not found)",
        );
      }
      return detail;
    },

    apply(job: JobDetail, options?: ApplyOptions): Promise<ApplyResult> {
      return applyAction.apply(job, options);
    },

    verifyApplication(job: JobDetail, options?: ApplyOptions): Promise<VerificationResult> {
      return applyAction.verifyApplication(job, options);
    },
  };
};

export type { BossDiagnosticReport } from "./diagnostics/boss-diagnostics";
export { collectBossDiagnostics, formatBossDiagnostics } from "./diagnostics/boss-diagnostics";
export { SELECTORS } from "./selectors";
