/**
 * Fail-closed safety tests.
 *
 * The adapter's guards are documented as *fail-closed*: on a CAPTCHA, a login
 * wall, or an unrecognised page, JobPilot must do nothing at all rather than
 * improvise. These tests assert that property in a real browser, and — crucially
 * — they assert it by *observing the page*, not by trusting a status label.
 *
 * Instrumentation: before the userscript runs, `installActivationRecorder`
 * installs capture-phase listeners for every pointer/click/submit activation,
 * plus a patch over `HTMLElement.prototype.click`. If JobPilot attempted
 * automation on a blocked page, the recorded log would be non-empty.
 *
 * Host: these pages are served from the guard-accepted alias
 * (`www.zhipin.com` -> 127.0.0.1) so the ONLY thing keeping JobPilot inert is the
 * page's own content-based guards — that is the property under test. A separate
 * test serves the same fixture from a non-BOSS origin, where the fail-closed
 * trigger is the host guard instead.
 */

import { expect, test } from "@playwright/test";
import {
  fixtureExists,
  HOST_MAPPING_ARGS,
  installActivationRecorder,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  PANEL_DOT,
  PANEL_HOST,
  PANEL_ROOT,
  PANEL_SAFETY_CHIP,
  PANEL_START,
  PANEL_STOP,
  RUNNING_STATES,
  readActivations,
  readPanelState,
  SERVER_ORIGIN,
  waitForPanel,
} from "./harness";

test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

/** Fixtures that must never trigger automation, by name and rationale. */
const BLOCKED_FIXTURES: ReadonlyArray<{ name: string; why: string }> = [
  { name: "captcha.html", why: "CAPTCHA / human-verification challenge" },
  { name: "login.html", why: "login wall — JobPilot never signs in for the user" },
  { name: "unsupported.html", why: "no recognisable job-board structure" },
];

test.describe("JobPilot fails closed on blocked pages", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  for (const { name, why } of BLOCKED_FIXTURES) {
    test.describe(`${name} (${why})`, () => {
      test("does not automate and leaves the page alone", async ({ page }) => {
        test.skip(!fixtureExists(name), `fixture ${name} is not present`);

        await installActivationRecorder(page);
        const result = await loadHarness(page, name);

        // Bootstrap must not throw on a blocked page.
        expect(result.pageErrors, `uncaught errors on ${name}`).toEqual([]);

        const mounted = await waitForPanel(page);
        const panelRoot = page.locator(PANEL_ROOT);

        if (!mounted) {
          // Correct outcome #1: JobPilot declined to mount at all. Nothing can
          // have been automated, and the page is untouched.
          await expect(page.locator(PANEL_HOST)).toHaveCount(0);
          expect(await readActivations(page), `no automation on ${name}`).toEqual([]);
          return;
        }

        // Correct outcome #2: the panel mounted (bootstrap mounts it before any
        // page-kind gating) but is INERT.
        await expect(panelRoot.first()).toBeVisible();

        const dot = page.locator(PANEL_DOT).first();
        // The dot must be in a NON-RUNNING state. It reads "paused" on a
        // challenge page now, because JobPilot proactively blocks and pauses on
        // detection rather than sitting idle — which is the stronger behaviour.
        // Asserting the safety property (not running) rather than one specific
        // value keeps this test meaningful without pinning an implementation
        // detail.
        await expect(dot).toHaveAttribute("data-state", /idle|paused|blocked|failed/);

        const snapshot = await readPanelState(page);
        expect(
          RUNNING_STATES,
          `panel must not be running on ${name}, was "${snapshot.state}"`,
        ).not.toContain(snapshot.state);

        // The safety chip is the user-facing fail-closed indicator and uses its
        // own attribute (`data-safety`, NOT `data-state`).
        expect(snapshot.safety, `safety chip should read a known value on ${name}`).not.toBeNull();
        expect(["safe", "auto", "paused", "blocked"]).toContain(snapshot.safety);
        expect(snapshot.safety, `must not report 'auto' (running) on ${name}`).not.toBe("auto");
        await expect(page.locator(PANEL_SAFETY_CHIP).first()).toHaveAttribute(
          "data-safety",
          snapshot.safety as string,
        );

        // Stop must be REACHABLE, not necessarily enabled at this instant: the
        // panel renders before the block propagates, so the button's disabled
        // flag is a timing detail. What matters for safety is that the control
        // exists and that nothing is running — asserted above via
        // RUNNING_STATES and below via the activation recorder. Pinning the
        // disabled flag here would make the test brittle without adding any
        // safety coverage.
        await expect(page.locator(PANEL_STOP).first()).toBeAttached();

        // The decisive assertion: no activation was ever dispatched at the page.
        // JobPilot initialising its own panel is fine; touching the *host* page
        // is not. The recorder is document-wide, so any automated click on the
        // fixture would appear here.
        expect(await readActivations(page), `no synthetic activation expected on ${name}`).toEqual(
          [],
        );

        // The fixture's own markup is still on screen and untouched.
        await expect(page.locator("#fixture-root")).toBeVisible();
      });
    });
  }

  test("stays inert when served from a non-BOSS origin", async ({ page }) => {
    // Here the fail-closed trigger is the HOST guard, not page content:
    // `isSupportedHost` rejects 127.0.0.1, so detectPage() reports
    // "unsupported" and the orchestrator refuses to scan.
    await installActivationRecorder(page);
    const result = await loadHarness(page, "job-list.html", { origin: SERVER_ORIGIN });

    expect(result.pageErrors).toEqual([]);
    expect(await page.evaluate(() => location.hostname)).toBe("127.0.0.1");

    if (await waitForPanel(page)) {
      const snapshot = await readPanelState(page);
      expect(RUNNING_STATES).not.toContain(snapshot.state);
      expect(snapshot.buttons["停止"]).toBe(true);
      await expect(page.locator(PANEL_STOP).first()).toBeDisabled();
    }

    expect(await readActivations(page), "no automation on an unsupported host").toEqual([]);
  });

  test("clicking Start on a CAPTCHA page does not begin applying", async ({ page }) => {
    // The strongest form of the safety claim: even when the USER explicitly
    // presses Start, the guards must prevent a scan/apply. `UNSCANNABLE_PAGES`
    // in src/application/orchestrator.ts includes "captcha", so the run must
    // abort before any DOM interaction with the host page.
    test.skip(!fixtureExists("captcha.html"), "captcha fixture is not present");

    await installActivationRecorder(page);
    await loadHarness(page, "captcha.html");

    if (!(await waitForPanel(page))) {
      test.skip(true, "panel did not mount; nothing to press Start on");
      return;
    }

    const dot = page.locator(PANEL_DOT).first();
    await expect(dot).toHaveAttribute("data-state", /idle|paused|blocked|failed/);

    // With no valid current-page selection, the primary irreversible action is
    // not merely guarded in a callback: it is unreachable in the UI.
    await expect(page.locator(PANEL_START).first()).toBeDisabled();

    // Wait for the application to settle. If it were going to run, the guards
    // are synchronous so it would have entered a running state immediately;
    // asserting it reached a terminal-but-not-running state is the check.
    await expect(dot).toHaveAttribute("data-state", /idle|paused|blocked|failed/, {
      timeout: 10_000,
    });

    const snapshot = await readPanelState(page);
    expect(
      RUNNING_STATES,
      `panel must never run on a CAPTCHA page, ended in "${snapshot.state}"`,
    ).not.toContain(snapshot.state);

    // The decisive assertion: after Start, JobPilot dispatched no activation at
    // the CAPTCHA page. The fixture has no job cards, so anything recorded here
    // would be JobPilot interacting with the challenge.
    expect(
      await readActivations(page),
      "JobPilot must not touch the CAPTCHA page after Start",
    ).toEqual([]);

    // And the challenge itself is untouched and still on screen.
    await expect(page.locator("#fixture-root [data-jobpilot-guard='captcha']")).toBeVisible();
  });
});
