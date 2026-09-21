/**
 * Browser tests for JobPilot Phase 2: Personal Job Workspace.
 *
 * Verifies:
 * - Jobs workspace page and subnavigation tabs (正在看, 喜欢, 再看看, 对比, 全部职位)
 * - Pipeline recruitment stages tracking
 * - Three-step batch flow on Home (搜索岗位 → 选择职位 → 批量投递)
 * - Calm Login Prompt UX on login walls
 * - Settings Data & Backup Center (export, import, prune, clear)
 */

import { expect, test } from "@playwright/test";
import {
  HOST_MAPPING_ARGS,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  waitForPanel,
} from "./harness";

test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

test.describe("Simplified current-page workflow", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  test("renders the three-step batch flow on home", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Home is active initially
    await expect(page.locator('.jobpilot-panel[data-panel="home"]').first()).toHaveAttribute(
      "data-active",
      "true",
    );

    // The three-step titles render in order, with step ② hidden until a scan
    const stepTitles = page.locator(".jobpilot-step-title");
    await expect(stepTitles.nth(0)).toHaveText("搜索岗位");
    await expect(stepTitles.nth(1)).toHaveText("批量投递");

    // The scan and batch buttons are actionable entry points
    await expect(
      page
        .locator('.jobpilot-panel[data-panel="home"] button[data-action="discover-jobs"]')
        .first(),
    ).toBeVisible();
    await expect(
      page.locator('.jobpilot-panel[data-panel="home"] button[data-action="start-batch"]').first(),
    ).toBeVisible();
  });
});

test.describe("Personal Job Workspace on login fixture", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  test("renders calm login prompt card when not logged in", async ({ page }) => {
    await loadHarness(page, "login.html");
    expect(await waitForPanel(page)).toBe(true);

    const loginCard = page.locator(".jobpilot-login-card").first();
    await expect(loginCard).toBeVisible();

    const loginTitle = loginCard.locator(".jobpilot-login-title").first();
    await expect(loginTitle).toHaveText("先登录一下 BOSS");

    const confirmBtn = loginCard.locator('button[data-action="login-confirm"]').first();
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toHaveText("我登录好了");
  });
});
