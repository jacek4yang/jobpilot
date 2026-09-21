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
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

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
 * IMPORTANT — the panel lives in an open Shadow DOM.
 * `src/ui/panel.ts` creates a host element `div[data-jobpilot-host]`, attaches
 * `attachShadow({ mode: "open" })`, and renders everything inside it. Playwright's
 * CSS engine pierces *open* shadow roots for descendant combinators, so the
 * selectors below work from the page level without explicit shadow traversal.
 * If a selector ever stops matching, verify against the real shadow tree first —
 * `panel.ts` was refactored once already (the old `.jobpilot-badge` readout was
 * replaced by `.jobpilot-dot`), and guessing at class names wastes a CI cycle.
 *
 * Panel structure (verified against the built bundle):
 *   div[data-jobpilot-host]        <- host, `all: initial` to isolate from host CSS
 *     #shadow-root
 *       style
 *       .jobpilot-launcher          <- collapsed-state pill (hidden when expanded)
 *       .jobpilot-root              <- the panel, `display:flex` when expanded
 *         .jobpilot-header > .jobpilot-title
 *         .jobpilot-dot[data-state] <- the state readout
 *         .jobpilot-tabs > .jobpilot-tab
 *         .jobpilot-actions > button.jobpilot-btn (Start/Pause/Resume/Skip/Stop)
 *
 * A `.jobpilot-hidden` class (`display: none !important`) marks the collapsed
 * element, so visibility assertions are meaningful.
 */
export const PANEL_HOST = "[data-jobpilot-host]";
export const PANEL_ROOT = ".jobpilot-root";
/** State readout on the LAUNCHER dot. `data-state` mirrors the state machine. */
export const PANEL_DOT = ".jobpilot-dot";
/**
 * Header chips. NOTE the attribute names differ per chip:
 *   `.jobpilot-safety-chip[data-safety]`     safe | auto | paused | blocked
 *   `.jobpilot-page-chip[data-page-kind]`    job-list | job-detail | captcha |
 *                                            login-required | empty-result | ...
 *   `.jobpilot-mode-chip`                    text only
 * Reading `data-state` off a chip will always yield null — that attribute
 * belongs to the launcher dot.
 */
export const PANEL_SAFETY_CHIP = ".jobpilot-safety-chip";
export const PANEL_PAGE_CHIP = ".jobpilot-page-chip";
export const PANEL_MODE_CHIP = ".jobpilot-mode-chip";
export const PANEL_TITLE = ".jobpilot-title";
export const PANEL_ACTIONS = ".jobpilot-actions";
export const PANEL_LAUNCHER = ".jobpilot-launcher";
export const PANEL_START = '.jobpilot-actions button.jobpilot-btn[data-action="start"]';
export const PANEL_PAUSE = '.jobpilot-actions button.jobpilot-btn[data-action="pause"]';
export const PANEL_STOP = '.jobpilot-actions button.jobpilot-btn[data-action="stop"]';

/**
 * Page kinds observed from the built userscript, per fixture, on the loopback
 * harness served from the guard-accepted hostname.
 *
 * These were READ OFF the running product, not derived from the fixtures: run
 * the scratch probe described in README.md if they ever drift. Two results are
 * counter-intuitive and worth keeping in mind:
 *   - `unsupported.html` reports `unknown`, NOT `unsupported`. The host IS
 *     supported (`www.zhipin.com`), so the host gate does not fire and the
 *     classifier falls through to structural evidence, which finds nothing.
 *     `unsupported` is only reachable from a NON-BOSS hostname.
 *   - `risk-page.html` reports `captcha`, because the CAPTCHA guard outranks
 *     risk-control in the precedence chain in `parser/page-kind.ts`.
 */
export const OBSERVED_PAGE_KIND: Readonly<Record<string, string>> = {
  "job-list.html": "job-list",
  "job-detail.html": "job-detail",
  "empty-list.html": "empty-result",
  "captcha.html": "captcha",
  "login.html": "login-required",
  "unsupported.html": "unknown",
  "risk-page.html": "captcha",
  // Communication fixtures, observed while probing.
  "success-modal.html": "job-detail",
  "chat-conversation.html": "unknown",
};

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

/** How long to wait for bootstrap to settle before reading collected errors. */
export const PANEL_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Attaches error collectors, navigates to `/harness?fixture=<name>`, and waits
 * for the userscript's deterministic load signal.
 *
 * Synchronisation uses the `jobpilot:userscript-loaded` event and
 * `expect.poll` (in the specs), never `waitForTimeout`.
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

  if (waitForUserscript && state.loaded) {
    // The script tag loading is NOT the same as bootstrap finishing: bootstrap
    // is async (it awaits the storage repository before mounting the panel).
    // Wait for the panel host to appear so that `pageErrors` collected by the
    // caller covers the whole of bootstrap, not just module evaluation.
    // Collection is best-effort: a page where JobPilot correctly declines to
    // mount is legitimate, so a timeout here is not an error.
    await page
      .locator(PANEL_HOST)
      .first()
      .waitFor({ state: "attached", timeout: PANEL_SETTLE_TIMEOUT_MS })
      .catch(() => undefined);
  }

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
 * guaranteed to exist the instant the script finishes executing. The host
 * element is the mount signal because it is appended synchronously by
 * `bootstrap()` once the repository has loaded.
 */
export const waitForPanel = async (page: Page, timeoutMs = 10_000): Promise<boolean> => {
  try {
    await page.locator(PANEL_HOST).first().waitFor({ state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
};

/** A snapshot of the panel's observable state, read through the shadow root. */
export interface PanelSnapshot {
  /** Whether the shadow host exists at all. */
  readonly mounted: boolean;
  /** `data-state` of the launcher dot, or null when unmounted. */
  readonly state: string | null;
  /** `data-safety` of the safety chip (safe|auto|paused|blocked), or null. */
  readonly safety: string | null;
  /** `data-page-kind` of the page chip (job-list|captcha|...), or null. */
  readonly pageKind: string | null;
  /** Whether `.jobpilot-root` is rendered (not carrying `.jobpilot-hidden`). */
  readonly expanded: boolean;
  /** Button label -> disabled flag, for the action row. */
  readonly buttons: Readonly<Record<string, boolean>>;
}

/**
 * Reads the panel's state directly from the shadow tree.
 *
 * Used where a test needs the *value* of the state machine rather than a
 * visibility assertion, and where going through Playwright's shadow-piercing
 * CSS would make the intent less obvious.
 *
 * Note the two distinct attributes: `data-state` lives on the launcher dot,
 * `data-safety` on the safety chip. Both are read here under separate keys so a
 * test can never confuse them.
 */
export const readPanelState = async (page: Page): Promise<PanelSnapshot> =>
  page.evaluate(() => {
    const host = document.querySelector("[data-jobpilot-host]");
    const root = host?.shadowRoot ?? null;
    if (host === null || root === null) {
      return {
        mounted: false,
        state: null,
        safety: null,
        pageKind: null,
        expanded: false,
        buttons: {},
      };
    }
    const panelEl = root.querySelector(".jobpilot-root");
    const buttons: Record<string, boolean> = {};
    for (const button of Array.from(root.querySelectorAll("button.jobpilot-btn"))) {
      const text = (button.textContent ?? "").trim();
      const action = button.getAttribute("data-action");
      const disabled = (button as HTMLButtonElement).disabled;
      if (text) buttons[text] = disabled;
      if (action) {
        const capitalized = action.charAt(0).toUpperCase() + action.slice(1);
        buttons[capitalized] = disabled;
        buttons[action] = disabled;
      }
    }
    return {
      mounted: true,
      state: root.querySelector(".jobpilot-dot")?.getAttribute("data-state") ?? null,
      safety: root.querySelector(".jobpilot-safety-chip")?.getAttribute("data-safety") ?? null,
      pageKind: root.querySelector(".jobpilot-page-chip")?.getAttribute("data-page-kind") ?? null,
      expanded: panelEl !== null && !panelEl.classList.contains("jobpilot-hidden"),
      buttons,
    };
  });

/**
 * Installs a capture-phase recorder for every synthetic activation the page sees.
 *
 * Must run before the userscript executes (via `addInitScript`) so nothing is
 * missed. Also patches `HTMLElement.prototype.click` because a programmatic
 * click would otherwise be indistinguishable from a real one in some flows, and
 * we want an unmissable record of any automated interaction.
 *
 * Returns a reader bound to the page; call it with `reset: true` to clear the
 * log after a deliberate user action.
 */
export const installActivationRecorder = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const record: Array<{ type: string; target: string }> = [];
    (globalThis as unknown as { __jobpilotActivations: typeof record }).__jobpilotActivations =
      record;

    const describe = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return String(target);
      const id = target.id === "" ? "" : `#${target.id}`;
      const cls =
        typeof target.className === "string" && target.className.trim() !== ""
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

    const originalClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function patchedClick(this: HTMLElement) {
      record.push({ type: "HTMLElement.click()", target: describe(this) });
      return originalClick.call(this);
    };
  });
};

/** Reads (and optionally clears) the activation log installed above. */
export const readActivations = async (
  page: Page,
  options: { reset?: boolean } = {},
): Promise<ReadonlyArray<{ type: string; target: string }>> =>
  page.evaluate((reset) => {
    const log = (
      globalThis as unknown as { __jobpilotActivations?: Array<{ type: string; target: string }> }
    ).__jobpilotActivations;
    if (log === undefined) return [];
    const snapshot = [...log];
    if (reset) log.length = 0;
    return snapshot;
  }, options.reset ?? false);
