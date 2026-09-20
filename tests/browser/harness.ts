/**
 * Shared plumbing for the JobPilot browser suite.
 *
 * ============================ TESTING BOUNDARY ============================
 * Everything here talks to the loopback fixture server started by
 * `playwright.config.ts` (command: `node tests/browser/server.mjs`). No test in
 * this directory may contact zhipin.com or any other network host. The hostname
 * `www.zhipin.com` appears below only as a *browser-level resolver alias* for
 * 127.0.0.1, so that `src/adapters/boss/guards.ts#isSupportedHost` sees the host
 * it requires without us weakening the guard.
 * =========================================================================
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

/** Port/host the fixture server binds (must match `server.mjs`). */
export const SERVER_ORIGIN = "http://127.0.0.1:43117";

/**
 * Origin that makes the adapter's host guard pass.
 *
 * Chromium is launched per-spec with
 * `--host-resolver-rules=MAP www.zhipin.com 127.0.0.1` (see `HOST_MAPPING_ARGS`)
 * so this name resolves to the local fixture server with no DNS lookup and no
 * outbound packet. `location.hostname` is then genuinely `www.zhipin.com`, which
 * is the only hostname `isSupportedHost` accepts.
 */
export const GUARDED_ORIGIN = "http://www.zhipin.com:43117";

/** Chromium launch args that alias the accepted hostname onto loopback. */
export const HOST_MAPPING_ARGS = [
  "--host-resolver-rules=MAP www.zhipin.com 127.0.0.1, MAP zhipin.com 127.0.0.1",
];

/** Absolute path of the built userscript the browser suite drives. */
export const USERSCRIPT_PATH = fileURLToPath(
  new URL("../../dist/jobpilot.user.js", import.meta.url),
);

/** Repository-relative display path, for actionable skip messages. */
export const USERSCRIPT_RELATIVE = "dist/jobpilot.user.js";

/**
 * True when `pnpm build` has produced the userscript.
 *
 * When false, every spec skips with an actionable message rather than failing
 * on a confusing 404 from the fixture server.
 */
export const isBuildPresent = (): boolean => existsSync(USERSCRIPT_PATH);

/** Message shown when the suite is skipped because the build is absent. */
export const MISSING_BUILD_MESSAGE =
  `${USERSCRIPT_RELATIVE} is missing — the browser suite drives the BUILT userscript. ` +
  `Run \`pnpm build\` first, then re-run \`pnpm test:browser\`.`;

/**
 * Fixtures that ship in the repository today.
 *
 * The browser suite only asserts against files that actually exist on disk, so
 * a spec referencing a fixture another agent has not written yet will neither
 * fail nor silently pass — it is skipped with a reason.
 */
export const KNOWN_FIXTURES = [
  "job-list.html",
  "job-detail.html",
  "login.html",
  "captcha.html",
  "empty-list.html",
  "unsupported.html",
  // Concurrently authored — may or may not exist when this suite runs.
  "chat-conversation.html",
  "chat-with-draft.html",
  "chat-message-sent.html",
  "chat-message-failed.html",
  "chat-wrong-conversation.html",
  "success-modal.html",
  "unknown-modal.html",
  "risk-page.html",
] as const;

/** Path of the fixture on disk (used for existence checks). */
export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/boss/${name}`, import.meta.url));

/** Whether a fixture file is present. */
export const fixtureExists = (name: string): boolean => existsSync(fixturePath(name));

/** Only the fixtures currently on disk. */
export const existingFixtures = (): readonly string[] => KNOWN_FIXTURES.filter(fixtureExists);

/**
 * Playwright selectors for JobPilot's own mounted UI.
 *
 * Sourced from `src/ui/panel.ts`, which creates a root `div.jobpilot-root`.
 * Kept here so a panel rename is a single-file change.
 */
export const PANEL_ROOT = ".jobpilot-root";
export const PANEL_BADGE = ".jobpilot-root .jobpilot-badge";
export const PANEL_MESSAGE = ".jobpilot-root .jobpilot-message";
export const PANEL_START = '.jobpilot-root button.jobpilot-btn:has-text("Start")';
export const PANEL_STOP = '.jobpilot-root button.jobpilot-btn:has-text("Stop")';
export const PANEL_ACTIONS = ".jobpilot-root .jobpilot-actions";

/** Panel states that mean "actively driving the page". */
export const RUNNING_STATES = [
  "scanning",
  "evaluating",
  "opening",
  "validating",
  "applying",
  "verifying",
  "cooldown",
] as const;

/** Outcome of loading a harness page. */
export interface HarnessLoad {
  /** Uncaught page errors observed during load and bootstrap. */
  readonly pageErrors: readonly Error[];
  /** Console error text, for diagnostics when a test fails. */
  readonly consoleErrors: readonly string[];
  /** Whether the userscript `<script>` tag reported `onload`. */
  readonly userscriptLoaded: boolean;
  /** Non-null when the userscript `<script>` reported `onerror`. */
  readonly userscriptError: string | null;
}

export interface LoadHarnessOptions {
  /**
   * Origin to load the harness from. Defaults to `GUARDED_ORIGIN` so bootstrap
   * exercises the supported-host path. Pass `SERVER_ORIGIN` to observe the
   * fail-closed `unsupported` path.
   */
  readonly origin?: string;
  /** Extra querystring parameters appended to the harness URL. */
  readonly query?: Record<string, string>;
  /**
   * Wait for the userscript to finish loading before resolving. Defaults to
   * `true`; set `false` for pages where the script is expected to be absent.
   */
  readonly waitForUserscript?: boolean;
}

/**
 * Attaches error collectors, navigates to `/harness?fixture=<name>`, and waits
 * for the userscript's deterministic load signal.
 *
 * Synchronisation uses the `jobpilot:userscript-loaded` event and
 * `expect.poll`, never `waitForTimeout`.
 */
export const loadHarness = async (
  page: Page,
  fixture: string,
  options: LoadHarnessOptions = {},
): Promise<HarnessLoad> => {
  const { origin = GUARDED_ORIGIN, query = {}, waitForUserscript = true } = options;

  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const params = new URLSearchParams({ fixture, ...query });
  await page.goto(`${origin}/harness?${params.toString()}`, { waitUntil: "domcontentloaded" });

  if (waitForUserscript) {
    // The userscript is a classic script; wait until window.__jobpilotHarness
    // reports it settled. Polling an in-page flag is deterministic here because
    // the flag is set by the script element's own load handler.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const harness = (
              globalThis as unknown as {
                __jobpilotHarness?: { loaded: boolean; error: string | null };
              }
            ).__jobpilotHarness;
            if (harness === undefined) return "pending";
            if (harness.error !== null) return "error";
            return harness.loaded ? "loaded" : "pending";
          }),
        {
          message: `userscript should load for fixture ${fixture}`,
          timeout: 10_000,
        },
      )
      .not.toBe("pending");
  }

  const state = await page.evaluate(() => {
    const harness = (
      globalThis as unknown as {
        __jobpilotHarness?: { loaded: boolean; error: string | null };
      }
    ).__jobpilotHarness;
    return { loaded: harness?.loaded ?? false, error: harness?.error ?? null };
  });

  return {
    pageErrors,
    consoleErrors,
    userscriptLoaded: state.loaded,
    userscriptError: state.error,
  };
};

/**
 * Waits until JobPilot has mounted its panel, or resolves `false` on timeout.
 *
 * Bootstrap is async (config load -> panel creation), so the panel is not
 * guaranteed to exist the instant the script finishes executing.
 */
export const waitForPanel = async (page: Page, timeoutMs = 10_000): Promise<boolean> => {
  try {
    await page.locator(PANEL_ROOT).first().waitFor({ state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
};
