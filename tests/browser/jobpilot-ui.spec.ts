/**
 * JobPilot mounted-UI tests.
 *
 * Drives the BUILT userscript (`dist/jobpilot.user.js`) inside a real browser
 * against `tests/fixtures/boss/job-list.html`, served from a loopback origin
 * aliased to `www.zhipin.com` so the adapter's host guard (`isSupportedHost`)
 * accepts the page without any change to `src/`.
 *
 * What this file proves:
 *   - the panel mounts inside its shadow root and renders its own DOM
 *   - the panel loads INERT: state `idle`, Start enabled, Pause/Stop disabled
 *   - the host page's own layout survives the injection untouched
 *
 * What it CANNOT prove: that any of this works on the real zhipin.com DOM. The
 * fixtures are synthetic. See `README.md`.
 */

import { expect, test } from "@playwright/test";
import {
  fixtureExists,
  HOST_MAPPING_ARGS,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  PANEL_ACTIONS,
  PANEL_DOT,
  PANEL_HOST,
  PANEL_LAUNCHER,
  PANEL_PAGE_CHIP,
  PANEL_PAUSE,
  PANEL_ROOT,
  PANEL_SAFETY_CHIP,
  PANEL_START,
  PANEL_STOP,
  PANEL_TITLE,
  RUNNING_STATES,
  readPanelState,
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

    // The panel is mounted inside an open shadow root on `[data-jobpilot-host]`.
    expect(
      await waitForPanel(page),
      "JobPilot panel should mount: bootstrap() appends it unconditionally",
    ).toBe(true);
    await expect(page.locator(PANEL_HOST).first()).toBeAttached();

    // `.jobpilot-root` is inside the shadow tree; Playwright pierces open shadow
    // roots, so this asserts visibility of the real panel, not the host wrapper.
    const panel = page.locator(PANEL_ROOT).first();
    await expect(panel).toBeVisible();

    // The header renders the product name and version from the build.
    await expect(page.locator(PANEL_TITLE).first()).toContainText("JobPilot");

    // Controls exist and are wired.
    await expect(page.locator(PANEL_ACTIONS).first()).toBeVisible();
    await expect(page.locator(PANEL_START).first()).toBeVisible();
    await expect(page.locator(PANEL_STOP).first()).toBeAttached();

    // The collapsed-state launcher exists but is hidden while expanded. This
    // guards the panel's own collapse/expand contract, not the host page.
    await expect(page.locator(PANEL_LAUNCHER).first()).toBeHidden();

    // ---- Host page integrity ------------------------------------------------
    // The fixture's original job card must still be present and visible: the
    // panel is an addition, never a replacement, and must not break the page.
    await expect(page.locator("#fixture-root .job-card").first()).toBeVisible();

    // The fixture's list container is untouched.
    await expect(page.locator("#fixture-root [data-jobpilot-list]").first()).toBeVisible();

    // The panel is mounted in its own shadow host appended to <body>, NOT nested
    // inside the fixture markup. This is the isolation guarantee: the panel
    // cannot inherit or leak host styles.
    const hostParentIsBody = await page.evaluate(() => {
      const host = document.querySelector("[data-jobpilot-host]");
      return host?.parentElement?.tagName === "BODY";
    });
    expect(hostParentIsBody, "panel host should be appended to <body>").toBe(true);

    // The panel's internals are NOT in the light DOM — they live in the shadow
    // root, which is what keeps `all: initial` isolation meaningful.
    expect(
      await page.locator("#fixture-root .jobpilot-root").count(),
      "panel must not be injected into the host content",
    ).toBe(0);
  });

  test("loads idle and does not start automating by itself", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Wait for the state readout to settle, then assert on the value.
    const dot = page.locator(PANEL_DOT).first();
    await expect(dot).toHaveAttribute("data-state", "idle");

    const snapshot = await readPanelState(page);
    expect(snapshot.mounted).toBe(true);
    expect(snapshot.expanded, "panel starts expanded").toBe(true);
    expect(RUNNING_STATES).not.toContain(snapshot.state);

    // Assist mode is the default: Start is available, and every action that
    // would only make sense mid-run is disabled until Start is pressed.
    expect(snapshot.buttons.Start, "Start should be enabled while idle").toBe(false);
    expect(snapshot.buttons.Pause, "Pause should be disabled while idle").toBe(true);
    expect(snapshot.buttons.Resume, "Resume should be disabled while idle").toBe(true);
    expect(snapshot.buttons.Stop, "Stop should be disabled while idle").toBe(true);

    // Cross-check the same facts through the DOM, not just the JS snapshot.
    await expect(page.locator(PANEL_START).first()).toBeEnabled();
    await expect(page.locator(PANEL_PAUSE).first()).toBeDisabled();
    await expect(page.locator(PANEL_STOP).first()).toBeDisabled();
  });

  test("is served from the hostname the adapter's guard accepts", async ({ page }) => {
    // The load-bearing assumption for this entire suite: the host-resolver
    // alias really does present `www.zhipin.com`, so the guard runs unmodified
    // and we are exercising the supported path rather than the fail-closed one.
    await page.goto("http://www.zhipin.com:43117/health");
    expect(await page.evaluate(() => location.hostname)).toBe("www.zhipin.com");
  });

  test("reports page-kind 'job-list' for the job-list fixture", async ({ page }) => {
    // The panel exposes the page classification as a machine-readable element:
    // `.jobpilot-page-chip[data-page-kind]`, set from `panel.setPageKind()`.
    //
    // This test previously carried a `test.fixme` because no such hook existed
    // and asserting on rendered label copy would have been a change-detector.
    // The hook now exists, so the fixme is retired.
    //
    // The chip lives inside the shadow root. Playwright's CSS engine pierces
    // OPEN shadow roots for CSS selectors, so `.jobpilot-page-chip` resolves
    // from page level — verified empirically before relying on it rather than
    // assumed. `readPanelState` reads the same value through the shadowRoot as
    // a cross-check that the two paths agree.
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page), "panel should mount").toBe(true);

    const chip = page.locator(PANEL_PAGE_CHIP).first();
    await expect(chip).toBeAttached();

    // `toBeAttached` + attribute assertion also proves shadow piercing worked.
    await expect(chip).toHaveAttribute("data-page-kind", "job-list");

    const snapshot = await readPanelState(page);
    expect(snapshot.pageKind, "shadowRoot read should agree with the locator").toBe("job-list");

    // The safety chip uses a DIFFERENT attribute (`data-safety`). Asserting it
    // here pins the distinction so a future edit cannot silently swap them.
    await expect(page.locator(PANEL_SAFETY_CHIP).first()).toHaveAttribute("data-safety", "safe");
  });

  test("reports page-kind 'captcha' on the captcha fixture", async ({ page }) => {
    // End-to-end fail-closed classification: the same classifier that the unit
    // and integration suites exercise under happy-dom must also produce
    // "captcha" in a real browser, through the real bootstrap path.
    //
    // Observed value, not an assumption: the built userscript reports
    // `data-page-kind="captcha"` for captcha.html.
    test.skip(!fixtureExists("captcha.html"), "captcha fixture is not present");

    await loadHarness(page, "captcha.html");
    expect(await waitForPanel(page), "panel should mount").toBe(true);

    await expect(page.locator(PANEL_PAGE_CHIP).first()).toHaveAttribute(
      "data-page-kind",
      "captcha",
    );

    const snapshot = await readPanelState(page);
    expect(snapshot.pageKind).toBe("captcha");

    // Classifying the page as a CAPTCHA is a *detection* result, not on its own
    // proof that automation stopped — `safety.spec.ts` asserts the stopping.
    // Here we only pin that detection is wired through to the UI.
    expect(snapshot.state, "panel must not be running on a CAPTCHA page").toBe("idle");
  });
});
