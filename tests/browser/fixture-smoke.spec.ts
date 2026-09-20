/**
 * Harness smoke tests.
 *
 * Proves the fixture server + harness page work at all: every fixture on disk
 * renders, the userscript is served and executes, and nothing throws an uncaught
 * error. If this file fails, every other browser test is meaningless.
 *
 * LOCAL FIXTURES ONLY — see `README.md`.
 */

import { expect, test } from "@playwright/test";
import {
  existingFixtures,
  HOST_MAPPING_ARGS,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  SERVER_ORIGIN,
} from "./harness";

// Alias the hostname the adapter's guard accepts onto loopback for THIS spec.
// Applied per-spec so the shared `playwright.config.ts` needs no edit.
test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

test.describe("fixture harness smoke", () => {
  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
  });

  const fixtures = existingFixtures();

  test("at least one fixture is present", () => {
    // A guard against silently testing nothing if the fixture directory moves.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    test(`renders ${fixture} without uncaught errors`, async ({ page }) => {
      const result = await loadHarness(page, fixture);

      // The userscript must have been served and executed by the harness.
      expect(result.userscriptError, `userscript script tag failed: ${fixture}`).toBeNull();
      expect(result.userscriptLoaded).toBe(true);

      // The fixture's own markup is present in the DOM, unmodified.
      await expect(page.locator("#fixture-root")).toBeVisible();
      expect(await page.locator("#fixture-root").innerHTML()).not.toBe("");

      // No uncaught exception during parse or bootstrap. Asserted as a readable
      // list so a failure shows the actual stack rather than a bare count.
      expect(
        result.pageErrors.map((error) => error.stack ?? error.message),
        `uncaught page errors for ${fixture}`,
      ).toEqual([]);
    });
  }

  test("serves a healthy readiness endpoint", async ({ request }) => {
    const response = await request.get("http://127.0.0.1:43117/health");
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("serves the built userscript with a JavaScript content type", async ({ request }) => {
    // `request` runs in Node, so it cannot use the browser's resolver alias.
    // The server accepts the loopback Host directly, which is what we want here:
    // this test is about the *server*, not the browser.
    const response = await request.get(`${SERVER_ORIGIN}/jobpilot.user.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/javascript");
  });

  test("rejects fixture names that attempt path traversal", async ({ request }) => {
    const response = await request.get(`${SERVER_ORIGIN}/fixtures/..%2F..%2Fpackage.json`);
    expect(response.status()).toBe(404);
    // The traversal must not have leaked repository content.
    expect(await response.text()).not.toContain('"name": "jobpilot"');
  });

  test("rejects an unrecognised Host header", async ({ request }) => {
    const response = await request.get(`${SERVER_ORIGIN}/health`, {
      headers: { Host: "evil.example.com" },
    });
    expect(response.status()).toBe(421);
  });

  test("no outbound request leaves the loopback fixture server", async ({ page }) => {
    // Enforces the suite's hard rule: CI must never depend on the live site.
    // Every request a harness page makes must target the fixture server. If a
    // future edit introduces a real URL, this test fails loudly.
    const external: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      const isLoopback =
        url.hostname === "127.0.0.1" ||
        // Aliased to 127.0.0.1 by Chromium's resolver rule; never DNS-resolved.
        url.hostname === "www.zhipin.com";
      if (!isLoopback && !url.protocol.startsWith("data") && !url.protocol.startsWith("blob")) {
        external.push(request.url());
      }
    });

    await loadHarness(page, "job-list.html");

    expect(external, "only the local fixture server may be contacted").toEqual([]);
  });
});
