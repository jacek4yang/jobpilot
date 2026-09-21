import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  HOST_MAPPING_ARGS,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  PANEL_HOST,
  PANEL_ROOT,
  waitForPanel,
} from "./harness";

test.use({
  launchOptions: { args: HOST_MAPPING_ARGS },
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

test.describe("Render screenshots for README", () => {
  const outputDir = resolve(process.cwd(), "docs/images");

  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
    mkdirSync(outputDir, { recursive: true });
  });

  test("captures the single current-page workflow", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    const panelRoot = page.locator(PANEL_HOST).first().locator(PANEL_ROOT).first();
    await expect(panelRoot).toBeVisible();
    await page.locator('button[data-action="discover-jobs"]').click();
    await expect(page.locator(".jobpilot-step-match-row")).toHaveCount(4);

    await page.screenshot({
      path: resolve(outputDir, "jobpilot-overview.png"),
      fullPage: false,
    });
    await panelRoot.screenshot({ path: resolve(outputDir, "jobpilot-home.png") });
  });
});
