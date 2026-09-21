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

test.describe("Personal Job Workspace on job-list fixture", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  test("renders jobs workspace with subnavigation", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Click "职位" tab
    const jobsTab = page.locator('.jobpilot-tab[data-tab="jobs"]').first();
    await expect(jobsTab).toHaveText("职位");
    await jobsTab.click();

    const jobsPanel = page.locator('.jobpilot-panel[data-panel="jobs"]').first();
    await expect(jobsPanel).toHaveAttribute("data-active", "true");

    // Subnavigation tabs exist
    const subnav = jobsPanel.locator(".jobpilot-subnav");
    await expect(subnav).toBeVisible();

    const currentSubBtn = subnav.locator('button[data-subtab="current"]').first();
    const favSubBtn = subnav.locator('button[data-subtab="favorites"]').first();
    const considerSubBtn = subnav.locator('button[data-subtab="considering"]').first();
    const compareSubBtn = subnav.locator('button[data-subtab="compare"]').first();
    const archiveSubBtn = subnav.locator('button[data-subtab="archive"]').first();

    await expect(currentSubBtn).toBeVisible();
    await expect(favSubBtn).toBeVisible();
    await expect(considerSubBtn).toBeVisible();
    await expect(compareSubBtn).toBeVisible();
    await expect(archiveSubBtn).toBeVisible();

    // Click favorites subnav
    await favSubBtn.click();
    await expect(favSubBtn).toHaveClass(/jobpilot-subnav-btn-active/);

    // Click compare subnav
    await compareSubBtn.click();
    await expect(compareSubBtn).toHaveClass(/jobpilot-subnav-btn-active/);
  });

  test("renders pipeline stage overview and cards", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Click "进展" tab
    const pipelineTab = page.locator('.jobpilot-tab[data-tab="pipeline"]').first();
    await expect(pipelineTab).toHaveText("进展");
    await pipelineTab.click();

    const pipelinePanel = page.locator('.jobpilot-panel[data-panel="pipeline"]').first();
    await expect(pipelinePanel).toHaveAttribute("data-active", "true");

    const stageGrid = pipelinePanel.locator(".jobpilot-stage-grid").first();
    await expect(stageGrid).toBeVisible();
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

  test("provides local storage data and backup center in settings", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Switch to settings tab
    await page.locator('.jobpilot-tab[data-tab="settings"]').first().click();

    const backupSection = page.locator('[data-section="backup"]').first();
    await expect(backupSection).toBeVisible();

    const exportBtn = backupSection.locator('button[data-action="export-backup"]').first();
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toHaveText("导出备份");

    const importBtn = backupSection.locator('button[data-action="import-backup"]').first();
    await expect(importBtn).toBeVisible();
    await expect(importBtn).toHaveText("导入备份");

    const pruneBtn = backupSection.locator('button[data-action="prune-data"]').first();
    await expect(pruneBtn).toBeVisible();
    await expect(pruneBtn).toHaveText("清理临时数据");

    const clearAllBtn = backupSection.locator('button[data-action="clear-all-data"]').first();
    await expect(clearAllBtn).toBeVisible();
    await expect(clearAllBtn).toHaveText("清空全部本地数据");
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
