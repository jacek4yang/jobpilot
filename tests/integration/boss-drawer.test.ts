/**
 * BOSS adapter — DETAIL DRAWER parsing and drawer-first `loadJob`, exercised
 * against `tests/fixtures/boss/job-list-with-drawer.html` (the real job-list
 * fixture shape plus an open drawer for boss-1002).
 *
 * Proves the drawer plumbing and the fail-closed contracts only; the real BOSS
 * Zhipin DOM was validated solely by the 2026-09-21 read-only recon capture
 * (`automationVerified` is `false`).
 */

import { describe, expect, it } from "vitest";
import { createBossPlatform } from "../../src/adapters/boss/index";
import { parseBossJobDetailFromDrawer } from "../../src/adapters/boss/parser/detail-parser";
import { detectBossPageKind } from "../../src/adapters/boss/parser/page-kind";
import type { JobSummary } from "../../src/domain/job/job";
import type { PageKind } from "../../src/ports/job-platform";
import { type BossFixture, documentOf, FIXED_NOW, loadFixture, makeDeps } from "./boss-harness";

const DRAWER_FIXTURE: BossFixture = "job-list-with-drawer.html";

/** First element, failing loudly rather than yielding `undefined` in TS. */
const first = <T>(items: readonly T[]): T => {
  const [head] = items;
  if (head === undefined) throw new Error("expected at least one item");
  return head;
};

/** The summary the fixture's drawer is open for (boss-1002), built by scanning. */
const summary1002 = async (
  platform: ReturnType<typeof createBossPlatform>,
): Promise<JobSummary> => {
  const jobs = await platform.scanJobs();
  const found = jobs.find((job) => job.title === "高级后端开发工程师（Java）");
  if (found === undefined) throw new Error("expected the fixture to contain the boss-1002 job");
  return found;
};

const drawerRootOf = (root: ParentNode): Element => {
  const drawer = root.querySelector(".job-detail-container");
  if (drawer === null) throw new Error("expected the fixture drawer to be present");
  return drawer;
};

describe("boss drawer parsing — job-list-with-drawer.html", () => {
  it("classifies the fixture as a job-detail page (drawer open over the listing)", () => {
    const window = loadFixture(DRAWER_FIXTURE);
    expect(
      detectBossPageKind(documentOf(window), window.location as unknown as Location),
    ).toBe<PageKind>("job-detail");
  });

  it("matches the drawer to the clicked summary and excludes the online tag from the recruiter name", async () => {
    const window = loadFixture(DRAWER_FIXTURE);
    const platform = createBossPlatform(makeDeps(window));
    const summary = await summary1002(platform);

    const parsed = parseBossJobDetailFromDrawer(
      drawerRootOf(documentOf(window)),
      summary,
      FIXED_NOW,
    );
    if (parsed === null) throw new Error("expected the drawer fixture to parse");

    // Required anchor: the drawer's title is exactly the clicked job's title.
    expect(parsed.title).toBe("高级后端开发工程师（Java）");
    expect(parsed.id).toBe(summary.id);
    // The drawer carries no company anchor: the summary value is the fallback.
    expect(parsed.companyName).toBe("云图网络技术有限公司");
    // The description comes from the drawer's job-sec-text block.
    expect(parsed.description).toContain("高并发订单与结算链路");
    // The recruiter name must not include the nested online-status tag.
    expect(parsed.recruiters).toHaveLength(1);
    expect(first(parsed.recruiters).name).toBe("测试招聘者");
    // Qualification chips map onto the domain unions.
    expect(parsed.education).toBe("master");
    expect(parsed.experience).toBe("5-10");
  });

  it("returns null when the drawer title does not match the requested summary", async () => {
    const window = loadFixture(DRAWER_FIXTURE);
    const platform = createBossPlatform(makeDeps(window));
    // A job ON the listing whose title is NOT what the drawer shows.
    const jobs = await platform.scanJobs();
    const other = jobs.find((job) => job.title === "前端开发工程师");
    if (other === undefined) throw new Error("expected the fixture to contain the boss-1001 job");

    expect(
      parseBossJobDetailFromDrawer(drawerRootOf(documentOf(window)), other, FIXED_NOW),
    ).toBeNull();
  });
});

describe("boss drawer-first loadJob", () => {
  it("clicks the matching card and returns the drawer detail with summary fallbacks", async () => {
    const window = loadFixture(DRAWER_FIXTURE);
    const platform = createBossPlatform(makeDeps(window));
    const summary = await summary1002(platform);
    const root = documentOf(window);

    // Attach listeners before the load so the real dispatched click is observed.
    const clicked: string[] = [];
    for (const card of Array.from(root.querySelectorAll(".job-card-wrap"))) {
      const id = card.getAttribute("data-job-id") ?? "";
      card.addEventListener("click", () => clicked.push(id));
    }

    const loaded = await platform.loadJob(summary);

    // The wrap for the requested job was clicked — no other card was.
    expect(clicked).toEqual(["boss-1002"]);
    expect(loaded.id).toBe(summary.id);
    expect(loaded.title).toBe("高级后端开发工程师（Java）");
    expect(loaded.companyName).toBe("云图网络技术有限公司");
    expect(loaded.description).toContain("高并发订单与结算链路");
    expect(first(loaded.recruiters).name).toBe("测试招聘者");
    expect(loaded.capturedAt).toBe(FIXED_NOW);
  });

  it("falls back to the navigation flow (and fails closed) when the drawer shows another job", async () => {
    const window = loadFixture(DRAWER_FIXTURE);
    // Shrink the poll budget so the timeout path stays fast.
    const platform = createBossPlatform(
      makeDeps(window, { drawerTimeoutMs: 60, drawerPollIntervalMs: 10 }),
    );
    const jobs = await platform.scanJobs();
    const other = jobs.find((job) => job.title === "前端开发工程师");
    if (other === undefined) throw new Error("expected the fixture to contain the boss-1001 job");

    // The drawer anchor mismatches, the drawer wait times out, and the
    // navigation flow cannot parse a standalone detail from this DOM — the
    // documented hard stop, never a fabricated detail.
    await expect(platform.loadJob(other)).rejects.toThrow(/required detail anchors missing/);
  });

  it("still scans the listing with the drawer open", async () => {
    const window = loadFixture(DRAWER_FIXTURE);
    const platform = createBossPlatform(makeDeps(window));
    const jobs = await platform.scanJobs();
    expect(jobs).toHaveLength(4);
  });

  it("aborts instead of returning a stale detail when the signal fires during the drawer wait", async () => {
    // Regression: a PAUSE/STOP during the drawer-open wait used to fall
    // through to the navigation fallback. In a real SPA the drawer then
    // renders, the page type check passes, and loadJob resolves with a
    // detail the caller has already cancelled — the batch's stale-result
    // guard swallows it silently, and a browser pause/resume journey can
    // surface an unrelated "failed" terminal state instead.
    //
    // Reproduced here by moving the drawer out of the document and
    // re-inserting it mid-wait, the way the live SPA renders it after the
    // card click.
    const window = loadFixture(DRAWER_FIXTURE);
    const root = documentOf(window);
    const platform = createBossPlatform(
      makeDeps(window, { drawerTimeoutMs: 2_000, drawerPollIntervalMs: 10 }),
    );
    const summary = await summary1002(platform);
    const rootList = root.querySelector(".job-list-container");
    const drawer = root.querySelector(".job-detail-container");
    if (drawer === null || rootList === null) {
      throw new Error("expected the fixture to ship a list container and a drawer node");
    }

    // The host renders the detail drawer asynchronously: it is absent while
    // the wait starts, and appears mid-wait — after the abort has fired.
    drawer.remove();
    setTimeout(() => rootList.append(drawer), 30);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    await expect(platform.loadJob(summary, { signal: controller.signal })).rejects.toThrow();
  });
});
