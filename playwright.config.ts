import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against locally served fixtures only.
 * CI must never depend on the live BOSS Zhipin website.
 */
export default defineConfig({
  testDir: "./tests/browser",
  // The production bundle holds a real origin-scoped Web Lock. Running fixture
  // pages concurrently would make unrelated tests look like competing tabs
  // and turn UI coverage into ownership-race coverage. Dedicated cross-tab
  // tests create their tabs explicitly; ordinary journeys run serially.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:43117/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
