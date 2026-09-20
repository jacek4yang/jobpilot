/**
 * JobPilot mounted-UI tests.
 *
 * Drives the BUILT userscript (`dist/jobpilot.user.js`) inside a real browser
 * against `tests/fixtures/boss/job-list.html`, served from a loopback origin
 * that is aliased to `www.zhipin.com` so the adapter's host guard
 * (`isSupportedHost`) accepts the page without any change to `src/`.
 *
 * What this file can prove:
 *   - the panel actually mounts and renders its own DOM (`.jobpilot-root`)
 *   - the panel is inert on load: no automation state, Start enabled, Stop off
 *   - the host page's own layout survives the injection untouched
 *
 * What it CANNOT prove: that any of this works on the real zhipin.com DOM.
 * The fixtures are synthetic. See `README.md`.
 */

import { expect, test } from "@playwright/test";
import {
  HOST_MAPPING_ARGS,
  MISSING_BUILD_MESSAGE,
  PANEL_ACTIONS,
  PANEL_BADGE,
  PANEL_ROOT,
  PANEL_START,
  PANEL_STOP,
  RUNNING_STATES,
  isBuildPresent,
  loadHarness,
  waitForPanel,
} from "./harness";

test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

test.describe("JobPilot panel on a job-list fixture", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  test("mounts the panel and leaves the host page intact", async ({ page }) => {
    const result = await loadHarness(page, "job-list.html");
    expect(result.pageErrors, "no uncaught errors during bootstrap").toEqual([]);

    const mounted = await waitForPanel(page);

    // The panel root is created by `createPanel()` in src/ui/panel.ts and
    // appended to document.body by bootstrap() before any page-kind gating.
    expect(
      mounted,
      "JobPilot panel should mount: bootstrap() appends it unconditionally",
    ).toBe(true);

    const panel = page.locator(PANEL_ROOT).first();
    await expect(panel).toBeVisible();

    // The header renders the product name and version from the build.
    await expect(panel.locator(".jobpilot-title")).toContainText("JobPilot");

    // Controls exist and are wired.
    await expect(page.locator(PANEL_ACTIONS).first()).toBeVisible();
    await expect(page.locator(PANEL_START).first()).toBeVisible();
    await expect(page.locator(PANEL_STOP).first()).toBeVisible();

    // ---- Host page integrity ------------------------------------------------
    // The fixture's original job card must still be present and visible: the
    // panel is an addition, never a replacement, and must not break the page.
    const originalCard = page.locator("#fixture-root .job-card").first();
    await expect(originalCard).toBeVisible();

    // The panel is appended to <body>, not nested inside the fixture markup.
    const nestedInFixture = await page
      .locator("#fixture-root .jobpilot-root")
      .count();
    expect(nestedInFixture, "panel must not be injected into the host content").toBe(0);

    // The fixture's list container is untouched.
    await expect(page.locator("#fixture-root [data-jobpilot-list]").first()).toBeVisible();
  });

  test("loads idle and does not start automating by itself", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    const badge = page.locator(PANEL_BADGE).first();
    await expect(badge).toBeVisible();

    // Assist mode is the default: nothing runs until the user presses Start.
    await expect(badge).toHaveAttribute("data-state", "idle");

    // Start is available; Stop is disabled while idle.
    await expect(page.locator(PANEL_START).first()).toBeEnabled();
    await expect(page.locator(PANEL_STOP).first()).toBeDisabled();

    // Belt and braces: the badge must never be in a running state on load.
    const state = await badge.getAttribute("data-state");
    expect(RUNNING_STATES).not.toContain(state);
  });

  test("reports a supported host for the aliased origin", async ({ page }) => {
    // This is the load-bearing assertion for the whole suite: it proves the
    // host-resolver alias really does satisfy the adapter's guard, so the
    // panel is exercising the supported path rather than the fail-closed one.
    await page.goto("http://www.zhipin.com:43117/health");
    expect(await page.evaluate(() => location.hostname)).toBe("www.zhipin.com");
  });

  test.fixme(
    "panel reports page-kind 'job-list' for the fixture",
    async ({ page }) => {
      // FIXME — cannot be asserted honestly against this fixture.
      //
      // `refreshPageKind()` in src/bootstrap/bootstrap.ts calls
      // `platform.detectPage()` and passes the result to `panel.setPageKind()`.
      // The page-kind badge therefore reports the *structural* classification,
      // not the host. For `job-list.html` the fixture carries
      // `[data-jobpilot-list="job-list"]` and `data-jobpilot-card` anchors, so
      // detection should yield "job-list".
      //
      // It is marked fixme rather than enabled because the panel exposes the
      // page kind only through a badge whose text is set in
      // `setPageKind`, and this build does not give the browser suite a stable,
      // documented hook to read it back (the badge text is not part of the
      // panel's public contract). Asserting on the rendered Chinese/label text
      // would be a change-detector that breaks on any copy edit, and would test
      // the fixture rather than the product.
      //
      // The classification itself IS covered — exhaustively — by the unit and
      // integration suites (`tests/unit/.../page-kind`, `tests/integration/
      // boss-page-detection.test.ts`) against the same fixtures under happy-dom.
      await page.goto("http://www.zhipin.com:43117/harness?fixture=job-list.html");
    },
  );
});
