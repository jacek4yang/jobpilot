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
import { CURRENT_SCHEMA_VERSION, createDefaultConfig } from "../../src/config/schema";
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
  PANEL_MODAL,
  PANEL_MODAL_BODY,
  PANEL_MODAL_RECHECK,
  PANEL_MODAL_STOP,
  PANEL_MODAL_TITLE,
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

const finiteBatchRoot = () => {
  const config = createDefaultConfig();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: {
      ...config,
      automation: { ...config.automation, minActionDelayMs: 0, maxActionDelayMs: 0 },
    },
    applications: [],
    statistics: {},
  };
};

test.describe("JobPilot panel on a job-list fixture", () => {
  test.describe.configure({ mode: "serial" });
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
    await expect(page.locator("#fixture-root .job-card-wrap").first()).toBeVisible();

    // The fixture's list container is untouched.
    await expect(page.locator("#fixture-root .job-list-container").first()).toBeVisible();

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

    // A finite explicit selection is mandatory. Before scanning, Start and all
    // mid-run controls are disabled.
    expect(snapshot.buttons["Start-batch"], "Start should require a selection").toBe(true);
    expect(snapshot.buttons["暂停"], "Pause should be disabled while idle").toBe(true);
    expect(snapshot.buttons["继续"], "Resume should be disabled while idle").toBe(true);
    expect(snapshot.buttons["停止"], "Stop should be disabled while idle").toBe(true);

    // Cross-check the same facts through the DOM, not just the JS snapshot.
    await expect(page.locator(PANEL_START).first()).toBeDisabled();
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
    // Here we pin that detection is wired through to the UI.
    //
    // The state is now `paused` rather than `idle`, because detecting a
    // challenge actively blocks and pauses rather than sitting idle. That is
    // the stronger outcome, and asserting it also proves the detection reached
    // the panel rather than merely being computed.
    expect(
      RUNNING_STATES,
      `panel must not be running on a CAPTCHA page, was "${snapshot.state}"`,
    ).not.toContain(snapshot.state);
    expect(["paused", "blocked", "failed"]).toContain(snapshot.state);
  });

  test("renders Chinese-first UI by default with calm tone and localized controls", async ({
    page,
  }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // Header chips in Chinese
    await expect(page.locator(".jobpilot-mode-chip").first()).toHaveText("辅助模式");
    await expect(page.locator(".jobpilot-safety-chip").first()).toHaveText("安全运行");

    // Action buttons in Chinese
    const startBtn = page.locator('button[data-action="start-batch"]').first();
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveText("开始投递");

    const pauseBtn = page.locator('button[data-action="pause-batch"]').first();
    await expect(pauseBtn).toHaveText("暂停");

    const stopBtn = page.locator('button[data-action="stop-batch"]').first();
    await expect(stopBtn).toHaveText("停止");

    // Production exposes one operation surface, not a dashboard of dead tabs.
    await expect(page.locator(".jobpilot-tabs")).toBeHidden();
    await expect(page.locator('.jobpilot-panel[data-panel="home"]')).toBeVisible();

    // Three-step batch flow on Home page. Step ② (选择职位) only renders after
    // a scan has produced matches, so a fresh panel shows ① then ③; the full
    // three-title order is pinned by the home-page unit test.
    const stepTitles = page.locator(".jobpilot-step-title");
    await expect(stepTitles.nth(0)).toBeVisible();
    await expect(stepTitles.nth(0)).toHaveText("搜索岗位");
    await expect(stepTitles.nth(1)).toHaveText("批量投递");
  });

  test("scans the current page into an explicit finite selection", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    await page.locator('button[data-action="discover-jobs"]').click();
    const checkboxes = page.locator(".jobpilot-step-match-row input[type=checkbox]");
    await expect(checkboxes).toHaveCount(4);
    await expect(checkboxes.first()).toBeChecked();
    await expect(page.locator(PANEL_START).first()).toBeEnabled();
    await expect(page.locator(".jobpilot-step-count")).toContainText("4");

    await checkboxes.first().uncheck();
    await expect(page.locator(".jobpilot-step-count")).toContainText("3");
  });

  test("read-only scan does not monopolise execution ownership", async ({ page, context }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);
    await page.locator('button[data-action="discover-jobs"]').click();
    await expect(page.locator(".jobpilot-step-match-row input[type=checkbox]")).toHaveCount(4);

    const other = await context.newPage();
    await loadHarness(other, "job-list.html");
    expect(await waitForPanel(other)).toBe(true);
    await other.locator('button[data-action="discover-jobs"]').click();
    await expect(other.locator(".jobpilot-step-match-row input[type=checkbox]")).toHaveCount(4);
    await other.close();
  });

  test("Home updates in place during host DOM churn", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);
    await page.locator('button[data-action="discover-jobs"]').click();
    const checkbox = page.locator('.jobpilot-step-match-row input[type="checkbox"]').nth(1);
    await checkbox.focus();
    await page.evaluate(() => {
      const host = document.querySelector("[data-jobpilot-host]");
      const box = host?.shadowRoot?.activeElement ?? null;
      (
        globalThis as unknown as { __jobpilotFocusedCheckbox?: Element | null }
      ).__jobpilotFocusedCheckbox = box;
      const churn = document.createElement("div");
      churn.dataset["fixtureChurn"] = "1";
      document.querySelector("#fixture-root")?.append(churn);
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const previous = (globalThis as unknown as { __jobpilotFocusedCheckbox?: Element | null })
            .__jobpilotFocusedCheckbox;
          const active = document.querySelector("[data-jobpilot-host]")?.shadowRoot?.activeElement;
          return previous !== undefined && previous !== null && active === previous;
        }),
      )
      .toBe(true);
  });

  test("reload recovery clears a durable intent that never reached send", async ({ page }) => {
    const now = Date.now();
    const persistedRoot = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      config: createDefaultConfig(),
      applications: [],
      statistics: {},
      pendingIntent: {
        id: "txn-reload-before-commit",
        jobId: "boss-1001",
        sourceUrl: "/job_detail/boss-1001.html",
        phase: "armed",
        messageText: "不会发送的恢复测试消息",
        outgoingBaseline: 0,
        createdAt: now,
        expiresAt: now + 180_000,
      },
    };
    await loadHarness(page, "job-list.html", {
      gmValues: { "jobpilot:jobpilot:root:v1": JSON.stringify(persistedRoot) },
    });
    expect(await waitForPanel(page)).toBe(true);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("__jobpilot_browser_gm__:jobpilot:jobpilot:root:v1");
          if (raw === null) return "missing";
          return Object.hasOwn(JSON.parse(raw) as object, "pendingIntent") ? "pending" : "cleared";
        }),
      )
      .toBe("cleared");
  });

  test("supports collapsing to launcher pill and expanding back", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    const panelRoot = page.locator(PANEL_ROOT).first();
    const launcher = page.locator(PANEL_LAUNCHER).first();

    // Starts expanded
    await expect(panelRoot).toBeVisible();
    await expect(launcher).toBeHidden();

    // Click collapse button
    await page.locator('button[data-action="collapse"]').first().click();
    await expect(panelRoot).toBeHidden();
    await expect(launcher).toBeVisible();
    await expect(launcher.locator(".jobpilot-launcher-monogram")).toHaveText("JP");

    // Click launcher pill to expand
    await launcher.click();
    await expect(panelRoot).toBeVisible();
    await expect(launcher).toBeHidden();
  });

  test("provides resize handles and corner indicator", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    // All resize handles are present
    await expect(
      page.locator('.jobpilot-resize-handle[data-resize-handle="se"]').first(),
    ).toBeAttached();
    await expect(
      page.locator('.jobpilot-resize-handle[data-resize-handle="e"]').first(),
    ).toBeAttached();
    await expect(
      page.locator('.jobpilot-resize-handle[data-resize-handle="s"]').first(),
    ).toBeAttached();
    await expect(page.locator(".jobpilot-resize-indicator").first()).toBeAttached();
  });
});

test.describe("blocking modal on human-verification pages", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  test("floats the modal inside the panel on a CAPTCHA page", async ({ page }) => {
    // The CAPTCHA fixture makes JobPilot proactively pause with a captcha
    // pause reason at load (see safety.spec.ts); the panel must surface that
    // as the floating modal, not just the in-flow Home card.
    test.skip(!fixtureExists("captcha.html"), "captcha fixture is not present");

    await loadHarness(page, "captcha.html");
    expect(await waitForPanel(page), "panel should mount on the captcha fixture").toBe(true);

    const modal = page.locator(PANEL_MODAL).first();
    await expect(modal).toBeAttached({ timeout: 10_000 });

    // The modal lives inside the panel's open shadow root, i.e. inside
    // [data-jobpilot-host], above the tab sections.
    const insideShadow = await page.evaluate(() => {
      const host = document.querySelector("[data-jobpilot-host]");
      return host?.shadowRoot?.querySelector(".jobpilot-modal-overlay") !== null;
    });
    expect(insideShadow, "modal must render inside [data-jobpilot-host]").toBe(true);
    await expect(modal).toBeVisible();

    // The title is the largest text on screen; the body reuses the
    // plain-language pause reason (describePauseReason output).
    await expect(modal.locator(PANEL_MODAL_TITLE)).toHaveText("需要你的处理");
    await expect(modal.locator(PANEL_MODAL_BODY)).toContainText("验证");

    // Two-step recovery controls — validate (re-check) or abort (stop) — and
    // no close affordance: a block clears only when the operator acts.
    const recheckBtn = modal.locator(PANEL_MODAL_RECHECK);
    const stopBtn = modal.locator(PANEL_MODAL_STOP);
    await expect(recheckBtn).toHaveText("重新检查页面");
    await expect(stopBtn).toHaveText("停止本次任务");
    await expect(modal.locator('button[data-action="close"]')).toHaveCount(0);
  });

  test("modal re-check validates without resuming, and stopping dismisses it", async ({ page }) => {
    test.skip(!fixtureExists("captcha.html"), "captcha fixture is not present");

    await loadHarness(page, "captcha.html");
    expect(await waitForPanel(page), "panel should mount on the captcha fixture").toBe(true);

    const modal = page.locator(PANEL_MODAL).first();
    await expect(modal).toBeAttached({ timeout: 10_000 });

    // Step one of the two-step recovery: re-check only VALIDATES. On a page
    // that is still a CAPTCHA it reports back via the warn toast and never
    // resumes; the modal stays until the block truly resolves.
    await modal.locator(PANEL_MODAL_RECHECK).click();
    const toast = page.locator(".jobpilot-toast[data-tone='warn']").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("cannot resume yet");
    await expect(modal).toBeAttached();
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute(
      "data-state",
      /paused|blocked|failed/,
    );

    // Stopping the task is the explicit abort: the block clears and the
    // modal is dismissed with it.
    await modal.locator(PANEL_MODAL_STOP).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "idle");
  });
});

test.describe("built finite-batch production composition", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  const loadFinite = async (page: import("@playwright/test").Page, variant = "success") => {
    await loadHarness(page, "finite-batch-e2e.html", {
      query: { variant },
      gmValues: { "jobpilot:jobpilot:root:v1": JSON.stringify(finiteBatchRoot()) },
    });
    expect(await waitForPanel(page)).toBe(true);
    await page.locator('button[data-action="discover-jobs"]').click();
    await expect(page.locator(".jobpilot-step-match-row input[type=checkbox]")).toHaveCount(2);
  };

  /**
   * Stands in for the operator at the human-gated contact step. The real site
   * rejects synthetic clicks on 立即沟通 (an isTrusted-class guard, live-verified
   * 2026-09-22), so JobPilot highlights that control and waits for a trusted
   * click instead of clicking it. Playwright input IS trusted, so a production
   * browser test must click the highlighted control itself; the batch then
   * continues through the unchanged identity/draft/send flow.
   *
   * Runs until the panel reaches a terminal state, so it must be awaited after
   * the test's own assertions.
   */
  const runBatchAsOperator = async (page: import("@playwright/test").Page): Promise<void> => {
    // One round-trip per iteration: a single evaluate reads both the panel
    // state and the highlight, so the loop cannot queue protocol chatter
    // behind the batch's own work. Bounded by wall time as well, so it can
    // never outlive the test that spawned it.
    const deadline = Date.now() + 60_000;
    let started = false;
    // A page that stays idle for ~3s straight never started (the losing tab
    // in the ownership race): exit instead of spinning for the deadline.
    let idleTicks = 0;
    while (Date.now() < deadline) {
      const snapshot = await page
        .evaluate(() => {
          // The panel renders inside its host's shadow root.
          const root = document.querySelector("[data-jobpilot-host]")?.shadowRoot ?? document;
          const dot = root.querySelector(".jobpilot-dot");
          const control = document.querySelector("[data-jobpilot-action='apply']");
          return {
            state: dot?.getAttribute("data-state") ?? null,
            highlighted: control instanceof HTMLElement && control.style.outlineWidth === "3px",
          };
        })
        .catch(() => null);
      if (snapshot === null) return; // page went away (test finished or failed)
      const { state, highlighted } = snapshot;
      if (state === null || state === "paused" || state === "blocked" || state === "failed") {
        return;
      }
      if (state === "idle") {
        if (started) return;
        idleTicks += 1;
        if (idleTicks >= 30) return;
        await page.waitForTimeout(100).catch(() => {});
        continue;
      }
      idleTicks = 0;
      started = true;
      if (highlighted) {
        const control = page.locator("[data-jobpilot-action='apply']").first();
        await control.click().catch(() => {});
      } else {
        await page.waitForTimeout(100).catch(() => {});
      }
    }
  };

  test("scans, selects two, sends each once and explicitly finishes", async ({ page }) => {
    await loadFinite(page);
    const operator = runBatchAsOperator(page);
    await page.locator(PANEL_START).click();

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
                .__finiteBatchFixture?.sendClicks ?? -1,
          ),
        { timeout: 15_000 },
      )
      .toBe(2);
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "idle");
    const outcome = await page.evaluate(() => {
      const fixture = (
        globalThis as unknown as {
          __finiteBatchFixture?: { sendClicks: number; openedJobs: string[]; sentJobs: string[] };
        }
      ).__finiteBatchFixture;
      const raw = localStorage.getItem("__jobpilot_browser_gm__:jobpilot:jobpilot:root:v1");
      const applications =
        raw === null ? [] : (JSON.parse(raw) as { applications?: unknown[] }).applications;
      return { fixture, applicationCount: applications?.length ?? 0 };
    });
    expect(outcome.fixture?.sendClicks).toBe(2);
    expect(outcome.fixture?.openedJobs).toEqual(["e2e-1001", "e2e-1002"]);
    expect(outcome.fixture?.sentJobs).toEqual(["e2e-1001", "e2e-1002"]);
    expect(outcome.applicationCount).toBe(2);
    await operator;
  });

  test("double Start still runs one finite batch", async ({ page }) => {
    await loadFinite(page);
    const operator = runBatchAsOperator(page);
    await page.evaluate(() => {
      const button = document
        .querySelector("[data-jobpilot-host]")
        ?.shadowRoot?.querySelector(
          'button[data-action="start-batch"]',
        ) as HTMLButtonElement | null;
      button?.click();
      button?.click();
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
                .__finiteBatchFixture?.sendClicks ?? -1,
          ),
        { timeout: 15_000 },
      )
      .toBe(2);
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "idle");
    await operator;
  });

  test("Stop during a pending load cancels before send", async ({ page }) => {
    await loadFinite(page, "slow-detail");
    await page.locator(PANEL_START).click();
    await expect(page.locator(PANEL_STOP)).toBeEnabled();
    await page.locator(PANEL_STOP).click();
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "idle");
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __finiteBatchFixture?: { openedJobs: string[] } })
                .__finiteBatchFixture?.openedJobs.length ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
            .__finiteBatchFixture?.sendClicks ?? -1,
      ),
    ).toBe(0);
  });

  test("rapid Pause and Resume never duplicates a send", async ({ page }) => {
    await loadFinite(page, "slow-detail");
    await page.locator(PANEL_START).click();
    await expect(page.locator(PANEL_PAUSE)).toBeEnabled();
    // Pause while the first drawer load is still in flight.
    await page.locator(PANEL_PAUSE).click();
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "paused");
    // Resume restarts the batch from the top. The invariant under test is NOT
    // "the batch pauses again" — a healthy resume proceeds and may complete
    // the batch. It is that the pause/resume race can never produce a
    // duplicate send and the batch still terminates deterministically.
    await page.locator('button[data-action="resume-batch"]').click();
    await expect(page.locator(PANEL_DOT).first()).not.toHaveAttribute("data-state", "paused");
    const operator = runBatchAsOperator(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
                .__finiteBatchFixture?.sendClicks ?? -1,
          ),
        { timeout: 30_000 },
      )
      .toBeLessThanOrEqual(2);
    // Every recorded click maps to a distinct job: no double-send.
    const outcome = await page.evaluate(() => {
      const fixture = (
        globalThis as unknown as {
          __finiteBatchFixture?: { sendClicks: number; sentJobs: string[]; openedJobs: string[] };
        }
      ).__finiteBatchFixture;
      return {
        clicks: fixture?.sendClicks ?? -1,
        sent: fixture?.sentJobs ?? [],
        opened: fixture?.openedJobs ?? [],
      };
    });
    const sentJobs = [...outcome.sent];
    expect(new Set(sentJobs).size).toBe(sentJobs.length);
    // The batch terminates rather than rescanning forever.
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute(
      "data-state",
      /^(idle|paused|blocked|failed)$/,
      { timeout: 60_000 },
    );
    await operator;
  });

  test("two tabs starting concurrently produce one finite batch", async ({ context, page }) => {
    await loadFinite(page);
    const other = await context.newPage();
    await loadFinite(other);

    // Only the tab that wins queue ownership runs a batch; the other stays
    // inert. Whichever tab highlights 立即沟通 gets the operator's click.
    const operators = [runBatchAsOperator(page), runBatchAsOperator(other)];
    await Promise.all([page.locator(PANEL_START).click(), other.locator(PANEL_START).click()]);
    await expect
      .poll(
        async () => {
          const counts = await Promise.all(
            [page, other].map((candidate) =>
              candidate.evaluate(
                () =>
                  (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
                    .__finiteBatchFixture?.sendClicks ?? 0,
              ),
            ),
          );
          return counts.reduce((total, count) => total + count, 0);
        },
        { timeout: 15_000 },
      )
      .toBe(2);
    const finalCounts = await Promise.all(
      [page, other].map((candidate) =>
        candidate.evaluate(
          () =>
            (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
              .__finiteBatchFixture?.sendClicks ?? 0,
        ),
      ),
    );
    expect(finalCounts.sort()).toEqual([0, 2]);
    await Promise.all(operators);
    await other.close();
  });

  for (const failure of [
    { variant: "wrong-chat", clicks: 0 },
    { variant: "draft", clicks: 0 },
    { variant: "captcha", clicks: 0 },
    { variant: "uncertain", clicks: 1 },
  ] as const) {
    test(`${failure.variant} fails closed without a duplicate send`, async ({ page }) => {
      await loadFinite(page, failure.variant);
      // The operator DOES click 立即沟通 (trusted input); the variant's fault
      // then stops the batch fail-closed before any duplicate send.
      const operator = runBatchAsOperator(page);
      await page.locator(PANEL_START).click();
      await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "paused", {
        timeout: failure.variant === "uncertain" ? 20_000 : 10_000,
      });
      const clicks = await page.evaluate(
        () =>
          (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
            .__finiteBatchFixture?.sendClicks ?? -1,
      );
      expect(clicks).toBe(failure.clicks);
      await operator;
    });
  }

  test("storage failure immediately before intent persistence sends zero messages", async ({
    page,
  }) => {
    await loadFinite(page);
    await page.evaluate(() => {
      const original = (globalThis as unknown as { GM_setValue: (...args: unknown[]) => unknown })
        .GM_setValue;
      let failed = false;
      Object.defineProperty(globalThis, "GM_setValue", {
        configurable: true,
        value: (...args: unknown[]) => {
          if (!failed) {
            failed = true;
            throw new Error("synthetic storage failure");
          }
          return original(...args);
        },
      });
    });
    await page.locator(PANEL_START).click();
    await expect(page.locator(PANEL_DOT).first()).toHaveAttribute("data-state", "paused", {
      timeout: 10_000,
    });
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { __finiteBatchFixture?: { sendClicks: number } })
            .__finiteBatchFixture?.sendClicks ?? -1,
      ),
    ).toBe(0);
  });
});
