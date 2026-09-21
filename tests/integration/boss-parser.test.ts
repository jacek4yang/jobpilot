/**
 * BOSS adapter — list parsing, detail parsing, platform facade and abort
 * handling, exercised against the synthetic fixtures in `tests/fixtures/boss/`.
 *
 * These fixtures are hand-authored to match `src/adapters/boss/selectors.ts`.
 * Passing proves the parser plumbing and the fail-closed contracts; it proves
 * nothing about the live BOSS Zhipin DOM (`automationVerified` is `false`).
 */

import { describe, expect, it } from "vitest";
import { BOSS_METADATA, BOSS_PLATFORM_ID, createBossPlatform } from "../../src/adapters/boss/index";
import { parseBossJobDetail } from "../../src/adapters/boss/parser/detail-parser";
import { parseBossJobList } from "../../src/adapters/boss/parser/list-parser";
import { detectBossPageKind } from "../../src/adapters/boss/parser/page-kind";
import type { JobSummary } from "../../src/domain/job/job";
import type { PageKind } from "../../src/ports/job-platform";
import {
  abortedSignal,
  asParseRoot,
  BOSS_URL,
  type BossFixture,
  createRecordingLogger,
  documentOf,
  FIXED_NOW,
  loadFixture,
  loadFixtureAt,
  makeDeps,
  makeWindow,
  type ParseRoot,
  readFixture,
  reverseCards,
} from "./boss-harness";

/** Parses a fixture's job list, returning both the cards and the raw result. */
const parseList = (fixture: BossFixture) => {
  const window = loadFixture(fixture);
  const root = documentOf(window);
  return { window, result: parseBossJobList(root, BOSS_PLATFORM_ID) };
};

const idsOf = (jobs: readonly JobSummary[]): readonly string[] => jobs.map((job) => job.id);

/** First element, failing loudly rather than yielding `undefined` in TS. */
const first = <T>(items: readonly T[]): T => {
  const [head] = items;
  if (head === undefined) throw new Error("expected at least one item");
  return head;
};

describe("boss list parsing — job-list.html", () => {
  it("yields at least one summary and skips none", () => {
    const { result, window } = parseList("job-list.html");
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.considered).toBe(4);
    expect(result.skipped).toBe(0);
    // The page must actually be classified as a list, otherwise a scan is
    // unreachable no matter how well the parser behaves.
    expect(
      detectBossPageKind(documentOf(window), window.location as unknown as Location),
    ).toBe<PageKind>("job-list");
  });

  it("gives every summary a non-empty title, company and id", () => {
    const { result } = parseList("job-list.html");
    for (const job of result.jobs) {
      expect(job.title.length).toBeGreaterThan(0);
      expect(job.companyName.length).toBeGreaterThan(0);
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.platform).toBe(BOSS_PLATFORM_ID);
    }
  });

  it("reads the platform-native id from the card attribute", () => {
    const { result } = parseList("job-list.html");
    const titles = result.jobs.map((job) => job.title);
    expect(titles).toContain("前端开发工程师");
    expect(titles).toContain("资深产品经理");
    // Every card in this fixture carries data-job-id, so no id is a pure
    // positional accident and every one is reported as platform-native.
    expect(result.jobs.every((job) => job.idIsPlatformNative)).toBe(true);
    expect(result.jobs.map((job) => job.platformJobId)).toEqual([
      "boss-1001",
      "boss-1002",
      "boss-1003",
      "boss-1004",
    ]);
  });

  it("keeps raw salary and location text intact for downstream rules", () => {
    const { result } = parseList("job-list.html");
    const frontend = first(result.jobs.filter((job) => job.title === "前端开发工程师"));
    expect(frontend.salaryRaw).toBe("20-35K·14薪");
    expect(frontend.locationRaw).toBe("北京·朝阳区·望京");
  });

  it("produces identical ids when the same fixture is parsed twice", () => {
    const a = parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID);
    const b = parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID);
    expect(idsOf(a.jobs)).toEqual(idsOf(b.jobs));
    expect(idsOf(a.jobs).length).toBeGreaterThan(0);
  });

  it("produces identical ids when the same document is parsed twice", () => {
    const window = loadFixture("job-list.html");
    const root = documentOf(window);
    const a = parseBossJobList(root, BOSS_PLATFORM_ID);
    const b = parseBossJobList(root, BOSS_PLATFORM_ID);
    // Parsing is read-only and pure, so a repeated scan cannot drift.
    expect(idsOf(a.jobs)).toEqual(idsOf(b.jobs));
  });

  it("is order-independent: reversing the cards preserves the id set", () => {
    const window = loadFixture("job-list.html");
    const root = documentOf(window);
    const before = parseBossJobList(root, BOSS_PLATFORM_ID);
    reverseCards(root);
    const after = parseBossJobList(root, BOSS_PLATFORM_ID);

    expect(after.jobs.length).toBe(before.jobs.length);
    // Ids must not encode position: deduplication across reloads depends on it.
    expect([...idsOf(after.jobs)].sort()).toEqual([...idsOf(before.jobs)].sort());
    const titlesBefore = before.jobs.map((job) => job.title).sort();
    const titlesAfter = after.jobs.map((job) => job.title).sort();
    expect(titlesAfter).toEqual(titlesBefore);
  });

  it("keeps the fixture's relative detail links query-free even when not absolute", () => {
    const result = parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    // The fixture's href carries a `?ka=` tracking param. Tracking params must
    // never survive into the canonical URL, or one posting splits into several
    // identities across pages.
    const url = first(result.jobs).url ?? "";
    expect(url).toContain("/job_detail/boss-1001.html");
    expect(url).not.toContain("?");
    expect(url).not.toContain("ka=");
    expect(url).not.toContain("lid=");
  });

  it("leaves a card's own href untouched (read-only contract)", () => {
    const window = loadFixture("job-list.html");
    const root = documentOf(window);
    parseBossJobList(root, BOSS_PLATFORM_ID);
    const anchor = root.querySelector("a.job-name");
    expect(anchor?.getAttribute("href")).toBe("/job_detail/boss-1001.html?ka=search-list-1&lid=x9");
  });

  it("assigns a distinct id to each posting", () => {
    const { result } = parseList("job-list.html");
    const ids = idsOf(result.jobs);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("boss list parsing — fail closed", () => {
  it("returns an empty array (without throwing) for empty-list.html", () => {
    const { result, window } = parseList("empty-list.html");
    expect(result.jobs).toEqual([]);
    expect(result.considered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(
      detectBossPageKind(documentOf(window), window.location as unknown as Location),
    ).toBe<PageKind>("empty-result");
  });

  it("returns an empty array (without throwing) for unsupported.html", () => {
    const { result, window } = parseList("unsupported.html");
    expect(result.jobs).toEqual([]);
    expect(result.considered).toBe(0);
    expect(
      detectBossPageKind(documentOf(window), window.location as unknown as Location),
    ).toBe<PageKind>("unknown");
  });

  it("returns an empty array (without throwing) for captcha.html and login.html", () => {
    for (const fixture of ["captcha.html", "login.html"] as const) {
      const { result } = parseList(fixture);
      expect(result.jobs).toEqual([]);
    }
  });

  it("returns an empty array for a blank document", () => {
    const window = makeWindow();
    const result = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID);
    expect(result.jobs).toEqual([]);
    expect(result.considered).toBe(0);
  });

  it("skips a card that has no title or company instead of inventing one", () => {
    const window = loadFixture("job-list.html");
    const root = documentOf(window);
    // Strip the company block from the first card only.
    const firstCard = first(Array.from(root.querySelectorAll(".job-card-wrap")));
    firstCard.querySelector(".boss-info")?.remove();

    const result = parseBossJobList(root, BOSS_PLATFORM_ID);
    expect(result.considered).toBe(4);
    expect(result.jobs.length).toBe(3);
    expect(result.skipped).toBe(1);
    // The remaining cards are untouched — one bad card cannot abort a scan.
    expect(result.jobs.every((job) => job.companyName.length > 0)).toBe(true);
  });
});

describe("boss detail parsing — job-detail.html", () => {
  const detail = () => {
    const window = loadFixture("job-detail.html");
    const summary = first(
      parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID).jobs,
    );
    const parsed = parseBossJobDetail(documentOf(window), summary, FIXED_NOW);
    if (parsed === null) throw new Error("expected the detail fixture to parse");
    return { window, summary, parsed };
  };

  it("classifies the fixture as a job detail page", () => {
    const window = loadFixture("job-detail.html");
    expect(
      detectBossPageKind(documentOf(window), window.location as unknown as Location),
    ).toBe<PageKind>("job-detail");
  });

  it("extracts title, company and description", () => {
    const { parsed } = detail();
    expect(parsed.title).toBe("前端开发工程师");
    expect(parsed.companyName).toBe("未来科技有限公司");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.company.name).toBe("未来科技有限公司");
  });

  it("parses the salary string into a numeric monthly range", () => {
    const { parsed } = detail();
    expect(parsed.salaryRaw).toBe("20-35K·14薪");
    expect(parsed.salary.parsed).toBe(true);
    expect(parsed.salary.period).toBe("month");
    expect(parsed.salary.monthsPerYear).toBe(14);
    expect(parsed.salary.min).toBe(20);
    expect(parsed.salary.max).toBe(35);
    expect(typeof parsed.salary.min).toBe("number");
    expect(typeof parsed.salary.max).toBe("number");
    expect(parsed.salary.max).toBeGreaterThan(parsed.salary.min ?? 0);
  });

  it("maps the qualification chips onto the domain unions", () => {
    const { parsed } = detail();
    expect(parsed.education).toBe("bachelor");
    expect(parsed.experience).toBe("3-5");
  });

  it("preserves the summary's id rather than minting a new one", () => {
    const { summary, parsed } = detail();
    expect(parsed.id).toBe(summary.id);
    expect(parsed.platform).toBe(summary.platform);
    expect(parsed.url).toBe(summary.url);
  });

  it("records the injected clock value and the optional extras", () => {
    const { parsed } = detail();
    expect(parsed.capturedAt).toBe(FIXED_NOW);
    expect(parsed.location.city).toBe("北京");
    expect(parsed.requirements.length).toBeGreaterThan(0);
    expect(parsed.skills).toEqual(["TypeScript", "React", "Webpack"]);
    expect(first(parsed.recruiters).name).toBe("李思远");
  });
});

describe("boss detail parsing — fail closed", () => {
  const summaryFor = (fixture: BossFixture): JobSummary =>
    first(parseBossJobList(documentOf(loadFixture(fixture)), BOSS_PLATFORM_ID).jobs);

  it("returns null for empty-list.html without throwing", () => {
    const window = loadFixture("empty-list.html");
    expect(
      parseBossJobDetail(documentOf(window), summaryFor("job-list.html"), FIXED_NOW),
    ).toBeNull();
  });

  it("returns null for unsupported.html without throwing", () => {
    const window = loadFixture("unsupported.html");
    expect(
      parseBossJobDetail(documentOf(window), summaryFor("job-list.html"), FIXED_NOW),
    ).toBeNull();
  });

  it("returns null for a detail page missing the company anchor", () => {
    const window = loadFixture("job-detail.html");
    const root = documentOf(window);
    for (const element of root.querySelectorAll(
      "[itemprop='hiringOrganization'], .job-detail__company-name",
    )) {
      element.remove();
    }
    expect(parseBossJobDetail(root, summaryFor("job-list.html"), FIXED_NOW)).toBeNull();
  });

  it("returns null for a detail page missing the qualification chips", () => {
    const window = loadFixture("job-detail.html");
    const root = documentOf(window);
    root.querySelector("[data-jobpilot-field='job-tags']")?.remove();
    expect(parseBossJobDetail(root, summaryFor("job-list.html"), FIXED_NOW)).toBeNull();
  });

  it("returns null for a blank document", () => {
    const window = makeWindow();
    expect(
      parseBossJobDetail(documentOf(window), summaryFor("job-list.html"), FIXED_NOW),
    ).toBeNull();
  });
});

describe("boss platform facade", () => {
  it("exposes the stable platform id and display name", () => {
    const window = loadFixture("job-list.html");
    const platform = createBossPlatform(makeDeps(window));
    expect(platform.id).toBe("boss");
    expect(platform.displayName).toBe("BOSS Zhipin");
  });

  it("reports automationVerified === false — never claimed as verified", () => {
    // A correctness guarantee, not an implementation detail: this adapter has
    // never been validated against the real BOSS Zhipin DOM.
    expect(BOSS_METADATA.automationVerified).toBe(false);
    expect(BOSS_METADATA.id).toBe("boss");
    expect(BOSS_METADATA.matches).toContain("https://www.zhipin.com/*");
  });

  it("detectPage() classifies each fixture", () => {
    const expectations: readonly { readonly fixture: BossFixture; readonly kind: PageKind }[] = [
      { fixture: "job-list.html", kind: "job-list" },
      { fixture: "job-detail.html", kind: "job-detail" },
      { fixture: "login.html", kind: "login-required" },
      { fixture: "captcha.html", kind: "captcha" },
      { fixture: "empty-list.html", kind: "empty-result" },
      { fixture: "unsupported.html", kind: "unknown" },
    ];
    for (const { fixture, kind } of expectations) {
      const platform = createBossPlatform(makeDeps(loadFixture(fixture)));
      expect(platform.detectPage()).toBe(kind);
    }
  });

  it("scans the job list and returns the parsed summaries", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const jobs = await platform.scanJobs();
    expect(jobs.length).toBe(4);
    expect(jobs.every((job) => job.platform === "boss")).toBe(true);
  });

  it("scans a listing even when the detail drawer is open over it", async () => {
    // Live regression 2026-09-21: with a card selected, the page classifies
    // as job-detail (the drawer root is positive detail evidence) and the old
    // kind !== "job-list" guard emptied the scan — "the page has jobs but the
    // run says none". The drawer never replaces the listing, so scanning must
    // proceed whenever the list container is present.
    const drawer = `
      <div class="job-detail-container">
        <div class="job-detail-box">
          <div class="job-detail-op clearfix">
            <a href="javascript:;" class="op-btn op-btn-like">收藏</a>
            <a href="javascript:;" class="op-btn op-btn-chat">立即沟通</a>
          </div>
          <div class="job-boss-info"><h2 class="name">测试招聘者</h2></div>
        </div>
      </div>`;
    const window = loadFixture("job-list.html");
    window.document.body.insertAdjacentHTML("beforeend", drawer);
    const platform = createBossPlatform(makeDeps(window));
    expect(platform.detectPage()).toBe("job-detail");
    const jobs = await platform.scanJobs();
    expect(jobs.length).toBe(4);
  });

  it("honours the scan limit", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const limited = await platform.scanJobs({ limit: 2 });
    expect(limited.length).toBe(2);
    // A non-positive limit yields nothing rather than silently meaning "all".
    expect((await platform.scanJobs({ limit: 0 })).length).toBe(0);
    expect((await platform.scanJobs({ limit: -1 })).length).toBe(0);
  });

  it("fails closed on the captcha fixture: empty scan, no throw", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("captcha.html")));
    expect(platform.detectPage()).toBe("captcha");
    await expect(platform.scanJobs()).resolves.toEqual([]);
  });

  it("fails closed on login, empty-result and unsupported pages", async () => {
    for (const fixture of ["login.html", "empty-list.html", "unsupported.html"] as const) {
      const platform = createBossPlatform(makeDeps(loadFixture(fixture)));
      await expect(platform.scanJobs()).resolves.toEqual([]);
    }
  });

  it("fails closed when the document is served from an untrusted origin", async () => {
    // Markup and location come from the same window, so the document really is
    // at a foreign origin rather than a BOSS document with a doctored location.
    const platform = createBossPlatform(
      makeDeps(loadFixtureAt("job-list.html", "https://evil.example.com/web/geek/job")),
    );
    expect(platform.detectPage()).toBe("unsupported");
    await expect(platform.scanJobs()).resolves.toEqual([]);
  });

  it("rejects an unverified zhipin.com subdomain too", async () => {
    const platform = createBossPlatform(
      makeDeps(loadFixtureAt("job-list.html", "https://m.zhipin.com/web/geek/job")),
    );
    expect(platform.detectPage()).toBe("unsupported");
    await expect(platform.scanJobs()).resolves.toEqual([]);
  });

  it("loadJob returns a detail for a detail page and preserves the id", async () => {
    const listPlatform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const summary = first(await listPlatform.scanJobs());

    const detailPlatform = createBossPlatform(makeDeps(loadFixture("job-detail.html")));
    const loaded = await detailPlatform.loadJob(summary);
    expect(loaded.id).toBe(summary.id);
    expect(loaded.companyName).toBe("未来科技有限公司");
    expect(loaded.salary.parsed).toBe(true);
  });

  it("loadJob throws on a page it would not parse rather than fabricating a detail", async () => {
    const listPlatform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const summary = first(await listPlatform.scanJobs());

    // Documented failure mode of loadJob: a hard stop, never a partial detail.
    const emptyPlatform = createBossPlatform(makeDeps(loadFixture("empty-list.html")));
    await expect(emptyPlatform.loadJob(summary)).rejects.toThrow(/expected a job-detail page/);
  });
});

describe("boss scan abort handling", () => {
  it("rejects with the signal's abort reason when the signal already fired", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const controller = new AbortController();
    controller.abort();
    const { signal } = controller;

    await expect(platform.scanJobs({ signal })).rejects.toThrowError();
    // Asserting on `name` rather than the message pins the real contract:
    // `throwIfAborted` re-throws the signal's reason, so a DOMException from
    // `controller.abort()` keeps `AbortError` as its name.
    const rejection: unknown = await platform.scanJobs({ signal }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).name).toBe("AbortError");
  });

  it("rejects with a normalised AbortError when the abort reason is not an Error", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const rejection: unknown = await platform.scanJobs({ signal: abortedSignal("why") }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).name).toBe("AbortError");
    expect((rejection as Error).message).toContain("aborted");
  });

  it("does not throw on a non-aborted signal", async () => {
    const platform = createBossPlatform(makeDeps(loadFixture("job-list.html")));
    const controller = new AbortController();
    await expect(platform.scanJobs({ signal: controller.signal })).resolves.toHaveLength(4);
  });

  it("checkpoints the abort by rejecting before touching the page", async () => {
    const window = loadFixture("job-list.html");
    const logger = createRecordingLogger();
    const platform = createBossPlatform({ ...makeDeps(window), logger });

    // `scanJobs` calls `throwIfAborted` before detection, so an aborted scan
    // produces NO log entry at all: it never claims to have looked at the page.
    await expect(platform.scanJobs({ signal: abortedSignal() })).rejects.toThrowError();
    expect(logger.entries()).toEqual([]);
  });

  it("logs the classification for a completed scan without leaking page content", async () => {
    const window = loadFixture("job-list.html");
    const logger = createRecordingLogger();
    const platform = createBossPlatform({ ...makeDeps(window), logger });

    // `scanJobs` classifies via `detectBossPageKind` directly rather than via
    // `detectPage()`, so no `boss.detect` entry is emitted on the scan path.
    const jobs = await platform.scanJobs({ signal: new AbortController().signal });
    expect(jobs.length).toBe(4);

    const serialised = JSON.stringify(logger.entries());
    // Job titles and company names from the fixture must never reach diagnostics.
    expect(serialised).not.toContain("前端开发工程师");
    expect(serialised).not.toContain("未来科技有限公司");
  });

  it("emits a detection entry from detectPage() and keeps page content out of it", () => {
    const window = loadFixture("job-list.html");
    const logger = createRecordingLogger();
    const platform = createBossPlatform({ ...makeDeps(window), logger });

    expect(platform.detectPage()).toBe("job-list");

    const messages = logger.entries().map((entry) => `${entry.component} ${entry.message}`);
    expect(messages.some((text) => text.includes("boss.detect"))).toBe(true);
    const serialised = JSON.stringify(logger.entries());
    expect(serialised).not.toContain("前端开发工程师");
    expect(serialised).not.toContain("未来科技有限公司");
    // The URL is logged query-stripped, so search terms never reach the log.
    expect(serialised).not.toContain("?");
  });
});

describe("boss list parsing — baseHref resolution", () => {
  /**
   * REGRESSION GUARD for a previously-shipped bug.
   *
   * `parseBossJobList(root, platformId, options)` now takes an explicit
   * `baseHref`, and `createBossPlatform` always passes
   * `{ baseHref: location.href }`. Before that, `readBaseHref` derived the base
   * solely from `root.ownerDocument.location`, which is `null` when the root IS
   * the document — the production path — so relative card hrefs stayed
   * relative and the same posting produced two different ids depending on the
   * root the caller happened to pass.
   *
   * These tests pin the fixed behaviour, so the defect cannot silently return.
   */
  it("absolutises relative card links when a baseHref is supplied", () => {
    const result = parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    expect(first(result.jobs).url).toBe("https://www.zhipin.com/job_detail/boss-1001.html");
  });

  it("produces one identity for a posting regardless of which root is parsed", () => {
    const window = loadFixture("job-list.html");
    const viaDocument = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    const viaBody = parseBossJobList(asParseRoot(window), BOSS_PLATFORM_ID, { baseHref: BOSS_URL });

    // This is the invariant the bug broke: same posting, same url, same id,
    // whatever root the caller handed in.
    expect(idsOf(viaBody.jobs)).toEqual(idsOf(viaDocument.jobs));
    expect(viaBody.jobs.map((job) => job.url)).toEqual(viaDocument.jobs.map((job) => job.url));
    expect(first(viaDocument.jobs).url).toBe("https://www.zhipin.com/job_detail/boss-1001.html");
  });

  it("resolves against the supplied base, not the document's own location", () => {
    const window = loadFixture("job-list.html");
    const result = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID, {
      baseHref: "https://mirror.example.com/some/search",
    });
    // The base is the one we were TOLD about, which is what makes the parse
    // reproducible and independent of ambient state.
    expect(first(result.jobs).url).toBe("https://mirror.example.com/job_detail/boss-1001.html");
  });

  it("shows why an explicit baseHref is required, not merely convenient", () => {
    // Without `baseHref` the two roots disagree, because `readBaseHref` can
    // resolve a base from a body root (`ownerDocument` is non-null) but not
    // from a `Document` root (`ownerDocument` is `null`). Native-id cards are
    // NOT immune: `parseBossJobCard` fingerprints `canonicalUrl: url ?? nativeId`,
    // so the unresolved relative url is folded into the hash anyway, while
    // `idIsPlatformNative: true` still claims a native id was found.
    const window = loadFixture("job-list.html");
    const viaDocument = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID);
    const viaBody = parseBossJobList(asParseRoot(window), BOSS_PLATFORM_ID);

    expect(first(viaDocument.jobs).idIsPlatformNative).toBe(true);
    expect(first(viaBody.jobs).idIsPlatformNative).toBe(true);
    expect(first(viaDocument.jobs).url).toBe("/job_detail/boss-1001.html");
    expect(first(viaBody.jobs).url).toBe("https://www.zhipin.com/job_detail/boss-1001.html");
    expect(idsOf(viaBody.jobs)).not.toEqual(idsOf(viaDocument.jobs));

    // Supplying the base reconciles them — this is exactly what the fix bought.
    const fixedDocument = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    const fixedBody = parseBossJobList(asParseRoot(window), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    expect(idsOf(fixedBody.jobs)).toEqual(idsOf(fixedDocument.jobs));
  });

  it("still yields a deterministic id set from each root in isolation", () => {
    for (const useDocument of [true, false]) {
      const parse = () => {
        const window = loadFixture("job-list.html");
        const root: ParseRoot = useDocument ? documentOf(window) : asParseRoot(window);
        return parseBossJobList(root, BOSS_PLATFORM_ID, { baseHref: BOSS_URL });
      };
      expect(idsOf(parse().jobs)).toEqual(idsOf(parse().jobs));
    }
  });

  it("resolves relative links the same way through the platform facade", () => {
    // The production guarantee: `scanJobs` passes `{ baseHref: location.href }`,
    // so this is the path real callers actually take.
    const window = loadFixture("job-list.html");
    const platform = createBossPlatform(makeDeps(window));
    const expected = parseBossJobList(documentOf(window), BOSS_PLATFORM_ID, {
      baseHref: BOSS_URL,
    });
    return platform.scanJobs().then((jobs) => {
      expect(idsOf(jobs)).toEqual(idsOf(expected.jobs));
      expect(first(jobs).url).toBe("https://www.zhipin.com/job_detail/boss-1001.html");
    });
  });

  /**
   * DOCUMENTED RESIDUAL LIMITATION (asserts current behaviour, not a wish).
   *
   * With NO `baseHref` and the root being the `Document`, the fixture's
   * origin-relative href stays relative:
   *
   *   | root          | baseHref | resulting url                |
   *   | `Document`    | omitted  | `/job_detail/boss-1001.html` |
   *   | `Document`    | supplied | `https://www.zhipin.com/…`   |
   *   | `window.body` | omitted  | `https://www.zhipin.com/…`   |
   *
   * `readBaseHref(root)` still returns `undefined` for a `Document` root
   * (`root.ownerDocument` is `null`), and a relative href alone carries no
   * origin — so nothing is invented. This is the honest fallback rather than a
   * fabrication; callers that care must pass `baseHref`, as the facade does.
   */
  it("leaves a relative href relative when no baseHref is supplied", () => {
    const result = parseBossJobList(documentOf(loadFixture("job-list.html")), BOSS_PLATFORM_ID);
    const url = first(result.jobs).url ?? "";
    expect(url).toBe("/job_detail/boss-1001.html");
    expect(url.startsWith("/")).toBe(true);
    // Tracking params are still stripped even on the unresolved path.
    expect(url).not.toContain("?");
  });

  it("does not invent an origin for a relative href from a blank document", () => {
    const result = parseBossJobList(documentOf(makeWindow()), BOSS_PLATFORM_ID);
    expect(result.jobs).toEqual([]);
  });
});

describe("boss fixture sanity", () => {
  it("reads the fixtures as non-empty documents", () => {
    for (const fixture of [
      "job-list.html",
      "job-detail.html",
      "captcha.html",
      "empty-list.html",
      "login.html",
      "unsupported.html",
    ] as const) {
      expect(readFixture(fixture).length).toBeGreaterThan(0);
    }
  });
});
