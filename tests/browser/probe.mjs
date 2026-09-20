/**
 * Probe the built userscript's observable panel state against every fixture.
 *
 * NOT a test — this file is deliberately not named `*.spec.ts`, so Playwright
 * never collects it. It is a diagnostic tool for exactly one question:
 *
 *     "What does the panel ACTUALLY report for fixture X right now?"
 *
 * Use it before writing or changing an assertion. Every expectation in the
 * browser suite was derived by reading these real values, not by guessing class
 * names or attribute names from the source. `src/ui/panel.ts` has been rewritten
 * more than once during this project, and each rewrite silently invalidated
 * selectors that had been inferred rather than observed.
 *
 * Usage (server must already be running, or start it via `pnpm test:browser`):
 *     node tests/browser/probe.mjs
 *
 * Reads only; writes nothing; contacts only the loopback fixture server.
 */

import { chromium } from "@playwright/test";

const ORIGIN = "http://www.zhipin.com:43117";
const HOST_MAPPING = "--host-resolver-rules=MAP www.zhipin.com 127.0.0.1";

const FIXTURES = [
  "job-list.html",
  "job-detail.html",
  "empty-list.html",
  "captcha.html",
  "login.html",
  "unsupported.html",
  "risk-page.html",
  "success-modal.html",
  "chat-conversation.html",
];

/** Reads the panel's observable state out of the shadow root. */
const readPanel = (fixture) => {
  const host = document.querySelector("[data-jobpilot-host]");
  const root = host?.shadowRoot ?? null;
  if (host === null || root === null) return { mounted: false };
  const panelEl = root.querySelector(".jobpilot-root");
  const buttons = {};
  for (const button of Array.from(root.querySelectorAll("button.jobpilot-btn"))) {
    buttons[(button.textContent ?? "").trim()] = button.disabled;
  }
  return {
    mounted: true,
    pageKind: root.querySelector(".jobpilot-page-chip")?.getAttribute("data-page-kind") ?? null,
    safety: root.querySelector(".jobpilot-safety-chip")?.getAttribute("data-safety") ?? null,
    mode: root.querySelector(".jobpilot-mode-chip")?.textContent ?? null,
    dotState: root.querySelector(".jobpilot-dot")?.getAttribute("data-state") ?? null,
    expanded: panelEl !== null && !panelEl.classList.contains("jobpilot-hidden"),
    buttons,
    fixture,
  };
};

const browser = await chromium.launch({ args: [HOST_MAPPING] });
const context = await browser.newContext();

try {
  for (const fixture of FIXTURES) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${ORIGIN}/harness?fixture=${fixture}`);
      // A fixed settle is acceptable HERE (a diagnostic, not a test): we want a
      // stable snapshot, not a synchronisation guarantee.
      await page.waitForTimeout(1200);
      const state = await page.evaluate(readPanel, fixture);
      const shadowPierced = await page.locator(".jobpilot-page-chip").count();
      console.log(
        fixture.padEnd(26),
        JSON.stringify(state).padEnd(150),
        `shadowPierced=${shadowPierced}`,
        errors.length > 0 ? `ERRORS=${errors[0]}` : "",
      );
    } catch (error) {
      console.log(fixture.padEnd(26), "FAILED:", error.message.split("\n")[0]);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
