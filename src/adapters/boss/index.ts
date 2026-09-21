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
  JobPlatform,
  PageKind,
  PlatformOperationOptions,
  ScanOptions,
} from "../../ports/job-platform";
import type { Logger } from "../../ports/logger";
import { isAborted, throwIfAborted } from "./actions/abort";
import { parseBossJobDetail, parseBossJobDetailFromDrawer } from "./parser/detail-parser";
import { parseBossJobList } from "./parser/list-parser";
import { detectBossPageKind } from "./parser/page-kind";
import { queryFirst, SELECTORS } from "./selectors";

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
  /**
   * Poll budget for the drawer-open wait in `loadJob`, in milliseconds.
   * Defaults to {@link DRAWER_OPEN_TIMEOUT_MS}; tests shrink it so the
   * navigation fallback stays fast.
   */
  readonly drawerTimeoutMs?: number;
  /** Poll cadence for the drawer wait. Defaults to 250ms. */
  readonly drawerPollIntervalMs?: number;
}

/** How long `loadJob` waits for the clicked card's drawer to render. */
const DRAWER_OPEN_TIMEOUT_MS = 8_000;
/** Poll cadence while waiting for the drawer. */
const DRAWER_POLL_INTERVAL_MS = 250;

/** The pathname of a URL, tolerating relative hrefs. */
const urlPathnameOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname;
  } catch {
    const withoutHash = url.split("#")[0] ?? url;
    const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
    return withoutQuery.length > 0 ? withoutQuery : undefined;
  }
};

/**
 * Finds the listing card for `job`, when the current page is a listing.
 *
 * Iterates `.job-card-wrap` cards and matches the card's `/job_detail/{id}`
 * link href against the summary id (or its canonical URL path). Returns null
 * when no card matches — callers then use another load strategy.
 */
const findJobCard = (root: ParentNode, job: JobSummary): Element | null => {
  const id = String(job.id);
  const platformJobId = job.platformJobId;
  const urlPath = job.url === undefined ? undefined : urlPathnameOf(job.url);
  for (const card of Array.from(root.querySelectorAll(".job-card-wrap"))) {
    const anchor = card.querySelector("a[href*='/job_detail/']");
    const href = anchor?.getAttribute("href");
    if (href === null || href === undefined) continue;
    if (platformJobId !== undefined && href.includes(`/job_detail/${platformJobId}`)) return card;
    if (href.includes(`/job_detail/${id}`)) return card;
    if (urlPath !== undefined && href.includes(urlPath)) return card;
  }
  return null;
};

/**
 * Builds a `JobPlatform` for BOSS Zhipin.
 *
 * Failure modes:
 *   - `detectPage()` never throws; unreadable structure yields `"unknown"`
 *   - `scanJobs()` returns `[]` when no job-list container is present (even if
 *     a detail drawer is open over the listing), on an empty list, or on an
 *     aborted signal — it never falls back to parsing "whatever is there"
 *   - `loadJob()` throws when the detail cannot be parsed or the page is not a
 *     detail page, because a `JobDetail` cannot honestly be fabricated
 *   - communication is deliberately absent here; only CommunicationRunner may
 *     cross the irreversible send boundary
 */
export const createBossPlatform = (deps: BossPlatformDeps): JobPlatform => {
  const { document: doc, location, logger, clock, version } = deps;

  const logDetection = (kind: PageKind): PageKind => {
    logger.debug("boss.detect", "page classified", {
      kind,
      version,
      url: location.href.split("?")[0] ?? "",
    });
    return kind;
  };

  /**
   * Clicks the listing card and polls for the drawer's parsed detail.
   *
   * The click is a real site interaction: the live SPA opens the detail
   * drawer in place. This helper only runs from `loadJob`, which only runs
   * from the operator-started batch pipeline — there is no autonomous path
   * here.
   *
   * Fail-closed and non-throwing: returns null when the signal aborts, the
   * drawer does not render within the poll budget, or the drawer's title
   * anchor does not match `job`. The caller falls back to the navigation
   * flow, which enforces its own fail-closed checks.
   */
  const tryLoadFromDrawer = async (
    card: Element,
    job: JobSummary,
    options?: PlatformOperationOptions,
  ): Promise<JobDetail | null> => {
    // Synthetic clicks must use the document's own Event constructor: the
    // adapter is also exercised under happy-dom, where the global MouseEvent
    // does not exist.
    const view = doc.defaultView;
    card.dispatchEvent(
      view === null
        ? new MouseEvent("click", { bubbles: true })
        : new view.MouseEvent("click", { bubbles: true }),
    );

    const timeoutMs = deps.drawerTimeoutMs ?? DRAWER_OPEN_TIMEOUT_MS;
    const intervalMs = deps.drawerPollIntervalMs ?? DRAWER_POLL_INTERVAL_MS;
    // The drawer renders on the site's own schedule, so the budget is
    // wall-clock; the injected clock may be frozen in tests.
    const startedAt = Date.now();
    for (;;) {
      if (isAborted(options?.signal)) return null;
      const drawer = queryFirst(doc, SELECTORS.detail.root);
      if (drawer !== null) {
        const detail = parseBossJobDetailFromDrawer(drawer.element, job, clock.now());
        if (detail !== null) return detail;
      }
      if (Date.now() - startedAt >= timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  return {
    id: BOSS_PLATFORM_ID,
    displayName: BOSS_DISPLAY_NAME,

    /** Pure w.r.t. the injected document and location; performs no writes. */
    detectPage(): PageKind {
      return logDetection(detectBossPageKind(doc, location));
    },

    /** Scans the current page. Returns `[]` unless a job list is present. */
    async scanJobs(options?: ScanOptions): Promise<readonly JobSummary[]> {
      throwIfAborted(options?.signal);

      const kind = detectBossPageKind(doc, location);
      // A listing with the detail drawer open classifies as "job-detail" (the
      // drawer root is positive detail evidence), but the listing itself is
      // still on screen and the drawer never replaces it. Scan whenever the
      // list container is actually present; stay fail-closed otherwise. The
      // page-kind check doubles as the host guard: "unsupported" never scans,
      // whatever the DOM contains.
      const listPresent =
        kind === "job-list" ||
        (kind === "job-detail" && doc.querySelector(".job-list-container") !== null);
      if (!listPresent) {
        logger.info("boss.scan", "scan skipped: no job list on this page", { kind });
        return [];
      }

      // The injected location is passed explicitly so relative hrefs resolve
      // against the real page URL rather than an ambient document, which keeps
      // job identities stable across routes.
      const result = parseBossJobList(doc, BOSS_PLATFORM_ID, { baseHref: location.href });
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
     * Opens the detail for `job`, DRAWER FIRST.
     *
     * When the listing card for `job` is on screen, clicking it opens the
     * job's detail drawer in place (the live SPA behaviour, recon-verified
     * 2026-09-21), which avoids a full-page navigation. The click is a REAL
     * site interaction: it can only ever run here, inside `loadJob`, which
     * the operator-started batch pipeline alone invokes — never autonomously.
     * If the drawer does not render in time, or its title anchor does not
     * match `job`, this falls back to the navigation flow unchanged.
     *
     * Failure mode: throws rather than returning a partial detail. Callers are
     * expected to check `detectPage()` first; a null parse means the required
     * anchors were missing, which is a hard stop (`unknown-dom`).
     */
    async loadJob(job: JobSummary, options?: PlatformOperationOptions): Promise<JobDetail> {
      throwIfAborted(options?.signal);

      // Drawer-first: a visible listing card is the fastest, least disruptive
      // route to the detail. No card (e.g. a standalone detail page is
      // already open) falls straight through to the navigation flow.
      const card = findJobCard(doc, job);
      if (card !== null) {
        const drawerDetail = await tryLoadFromDrawer(card, job, options);
        if (drawerDetail !== null) return drawerDetail;
        // A null here also covers a cancelled wait (the signal aborted while
        // polling). Falling through would then race the user's PAUSE/STOP:
        // the drawer opened in the meantime, the page type check passes, and
        // a stale detail is produced against an aborted operation. Abort
        // before the navigation fallback.
        throwIfAborted(options?.signal);
        logger.debug("boss.loadJob", "drawer wait timed out; falling back to navigation");
      }

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
  };
};

export type { BossDiagnosticReport } from "./diagnostics/boss-diagnostics";
export { collectBossDiagnostics, formatBossDiagnostics } from "./diagnostics/boss-diagnostics";
export { SELECTORS } from "./selectors";
