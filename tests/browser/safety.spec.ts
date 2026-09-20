/**
 * Fail-closed safety tests.
 *
 * The adapter's guards are documented as *fail-closed*: on a CAPTCHA, a login
 * wall, or an unrecognised page, JobPilot must do nothing at all rather than
 * improvise. These tests assert that property in a real browser against the
 * synthetic fixtures, and — critically — they assert it by *observing*, not by
 * trusting a label.
 *
 * Instrumentation: before the userscript runs we install capture-phase listeners
 * that record every synthetic pointer/keyboard activation, and we watch for any
 * element the userscript might have clicked. If JobPilot attempted automation on
 * a blocked page, `dispatched` would be non-empty.
 *
 * A note on the host: these pages are served from the guard-accepted alias
 * (`www.zhipin.com` -> 127.0.0.1) so that the ONLY thing keeping JobPilot inert
 * is the page's own content-based guards. That is the property under test. A
 * separate test below confirms the same pages also stay inert on a non-BOSS
 * origin, where the fail-closed trigger is the host guard instead.
 */

import { expect, test } from "@playwright/test";
import {
  HOST_MAPPING_ARGS,
  MISSING_BUILD_MESSAGE,
  PANEL_BADGE,
  PANEL_ROOT,
  PANEL_STOP,
  RUNNING_STATES,
  SERVER_ORIGIN,
  fixtureExists,
  isBuildPresent,
  loadHarness,
  waitForPanel,
} from "./harness";

test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

/** Fixtures that must never trigger automation, by name and rationale. */
const BLOCKED_FIXTURES: ReadonlyArray<{ name: string; why: string }> = [
  { name: "captcha.html", why: "CAPTCHA / human-verification challenge" },
  { name: "login.html", why: "login wall — JobPilot never signs in for the user" },
  { name: "unsupported.html", why: "no recognisable job-board structure" },
];

/**
 * Installs capture-phase listeners that record every activation the page sees.
 *
 * Must be added before the userscript executes so nothing is missed.
 */
const installActivationRecorder = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    const record: Array<{ type: string; target: string }> = [];
    (globalThis as unknown as { __jobpilotActivations: typeof record }).__jobpilotActivations =
      record;

    const describe = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return String(target);
      const id = target.id === "" ? "" : `#${target.id}`;
      const cls =
        typeof target.className === "string" && target.className !== ""
          ? `.${target.className.trim().split(/\s+/).join(".")}`
          : "";
      return `${target.tagName.toLowerCase()}${id}${cls}`;
    };

    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "submit"]) {
      document.addEventListener(
        type,
        (event) => {
          record.push({ type, target: describe(event.target) });
        },
        { capture: true },
      );
    }
    // Element.prototype.click() called programmatically still dispatches a
    // click event, so the listener above catches it. Record direct calls too,
    // in case a caller suppresses propagation.
    const originalClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function patchedClick(this: HTMLElement) {
      record.push({ type: "HTMLElement.click()", target: describe(this) });
      return originalClick.call(this);
    };
  });
};

test.describe("JobPilot fails closed on blocked pages", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  for (const { name, why } of BLOCKED_FIXTURES) {
    test.describe(`${name} (${why})`, () => {
      test("does not automate and leaves the page alone", async ({ page }) => {
        // Optionally skip a fixture that has not been authored yet.
        test.skip(!fixtureExists(name), `fixture ${name} is not present`);

        await installActivationRecorder(page);
        const result = await loadHarness(page, name);

        // Bootstrap must not throw on a blocked page.
        expect(result.pageErrors, `uncaught errors on ${name}`).toEqual([]);

        const mounted = await waitForPanel(page);

        if (!mounted) {
          // Correct outcome #1: JobPilot declined to mount at all. Nothing can
          // have been automated, and the page is untouched.
          await expect(page.locator(PANEL_ROOT)).toHaveCount(0);
          return;
        }

        // Correct outcome #2: the panel mounted (bootstrap mounts it before any
        // page-kind gating) but is INERT.
        const badge = page.locator(PANEL_BADGE).first();
        await expect(badge).toBeVisible();

        const state = await badge.getAttribute("data-state");
        expect(
          RUNNING_STATES,
          `panel must not be running on ${name}, was "${state}"`,
        ).not.toContain(state);
        expect(state).toBe("idle");

        // Stop is disabled: there is nothing running to stop.
        await expect(page.locator(PANEL_STOP).first()).toBeDisabled();

        // No activation was ever dispatched at the page.
        const activations = await page.evaluate(
          () =>
            (globalThis as unknown as { __jobpilotActivations?: unknown[] })
              .__jobpilotActivations ?? [],
        );
        expect(activations, `no synthetic activation expected on ${name}`).toEqual([]);

        // The fixture's own blocking element is still on screen and untouched.
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
      const state = await page.locator(PANEL_BADGE).first().getAttribute("data-state");
      expect(RUNNING_STATES).not.toContain(state);
      await expect(page.locator(PANEL_STOP).first()).toBeDisabled();
    }

    const activations = await page.evaluate(
      () =>
        (globalThis as unknown as { __jobpilotActivations?: unknown[] }).__jobpilotActivations ??
        [],
    );
    expect(activations, "no automation on an unsupported host").toEqual([]);
  });

  test("clicking Start on a CAPTCHA page does not begin applying", async ({ page }) => {
    // The strongest form of the safety claim: even when the USER presses Start,
    // the guards must prevent a scan/apply. `UNSCANNABLE_PAGES` in
    // src/application/orchestrator.ts includes "captcha", so the run must abort
    // before any DOM interaction.
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const captchaPath = fileURLToPath(new URL("../fixtures/boss/captcha.html", import.meta.url));
    test.skip(!fs.existsSync(captchaPath), "captcha fixture is not present");

    await installActivationRecorder(page);
    await loadHarness(page, "captcha.html");

    const badge = page.locator(PANEL_BADGE).first();

    if (!(await waitForPanel(page))) {
      test.skip(true, "panel did not mount; nothing to press Start on");
      return;
    }

    // Record the user's own Start click so it can be excluded from the
    // assertion, then clear the log. Anything recorded AFTER this point is
    // JobPilot acting on the page, which must never happen on a CAPTCHA.
    await page
      .locator(PANEL_ROOT)
      .first()
      .locator('button.jobpilot-btn:has-text("Start")')
      .first()
      .click();
    await page.evaluate(() => {
      const log = (globalThis as unknown as { __jobpilotActivations?: unknown[] })
        .__jobpilotActivations;
      if (log !== undefined) log.length = 0;
    });

    // Wait for the application to settle, then assert it never entered a
    // running state. The guards are synchronous, so if it were going to run it
    // would have done so by the time the badge paints "paused"/"idle".
    await expect(badge).toHaveAttribute("data-state", /idle|paused|blocked|failed/, {
      timeout: 10_000,
    });

    const finalState = await badge.getAttribute("data-state");
    expect(RUNNING_STATES).not.toContain(finalState);

    // The decisive assertion: after Start, JobPilot dispatched no activation at
    // the CAPTCHA page whatsoever. The panel's own buttons were not touched, so
    // any entry here would be automation the guard failed to stop.
    const activations = await page.evaluate(
      () =>
        (globalThis as unknown as { __jobpilotActivations?: unknown[] })
          .__jobpilotActivations ?? [],
    );
    expect(activations, "JobPilot must not touch the CAPTCHA page after Start").toEqual([]);
  });
});
