/**
 * Shared harness for the BOSS adapter integration tests.
 *
 * Loads the synthetic fixtures under `tests/fixtures/boss/` into a real
 * happy-dom `Window` and exposes the adapter's injected dependencies.
 *
 * Two environment facts are handled explicitly here, because both silently
 * break the adapter's text-based guards under happy-dom and would otherwise
 * make fail-closed assertions pass for the WRONG reason:
 *
 *   1. happy-dom's `Document.textContent` is always `""` (never propagated from
 *      the document element), while the parser reads `root.textContent` in
 *      `textHas`/`matchText`. `asParseRoot` therefore yields a body-shaped view
 *      whose `textContent` is real, so text fallbacks exercise the same code
 *      path they would in a browser.
 *   2. Fixtures are written to the document WITHOUT a doctype, which makes
 *      happy-dom parse them in quirks mode and drop all descendant text nodes.
 *      `doctype: "parsed"` prepends `<!doctype html>` before writing, which is
 *      also the honest environment: `www.zhipin.com` serves standards mode.
 *
 * Neither workaround changes adapter behaviour; they only make the test DOM
 * behave like the browser DOM the adapter is written against.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import type { BossPlatformDeps } from "../../src/adapters/boss/index";
import type { Clock } from "../../src/domain/support/shared";
import type { LogEntry, Logger } from "../../src/ports/logger";

/** Host the fixtures' `@match` targets — required by `isSupportedHost`. */
export const BOSS_URL = "https://www.zhipin.com/web/geek/job";

/** The six synthetic fixtures, by file name. */
export type BossFixture =
  | "job-list.html"
  | "job-detail.html"
  | "job-list-and-captcha.html"
  | "login.html"
  | "captcha.html"
  | "empty-list.html"
  | "unsupported.html";

/** Reads a fixture verbatim (no newline normalisation, so sizes stay exact). */
export const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/boss/${name}`, import.meta.url)), "utf8");

/** Whether a written document should carry an explicit standards-mode doctype. */
export type DoctypeMode = "parsed" | "none";

/** Options accepted by every harness builder. */
export interface HarnessOptions {
  /** Placement of the fixture markup. Defaults to `"document"`. */
  readonly root?: "document" | "body";
  /**
   * `"parsed"` (default) prepends `<!doctype html>` so happy-dom keeps text
   * nodes; `"none"` writes the fixture exactly as-is.
   */
  readonly doctype?: DoctypeMode;
}

/**
 * A DOM scope the parsers accept.
 *
 * `Document` for the production path, an `HTMLElement` (the parsed body) for
 * text-fallback cases — the adapter types its roots as `ParentNode`/`Document`
 * and reads both positionally and via `textContent`.
 */
export type ParseRoot = Document | HTMLElement;

/** Builds a happy-dom window at `BOSS_URL`, or an explicit URL. */
export const makeWindow = (url: string = BOSS_URL): Window =>
  new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true },
  });

const writeFixture = (window: Window, html: string, doctype: DoctypeMode): void => {
  if (doctype === "none") {
    window.document.write(html);
    return;
  }
  // `document.write` does not switch happy-dom out of quirks mode on its own;
  // an explicit doctype token makes the parser keep text nodes.
  window.document.write(`<!doctype html>\n${html}`);
};

/** Parses `html` and returns the window holding it. */
export const loadHtml = (
  html: string,
  url: string = BOSS_URL,
  options: HarnessOptions = {},
): Window => {
  const window = makeWindow(url);
  writeFixture(window, html, options.doctype ?? "parsed");
  return window;
};

/** Loads one of the checked-in fixtures into a fresh window. */
export const loadFixture = (name: BossFixture, options: HarnessOptions = {}): Window =>
  loadHtml(readFixture(name), BOSS_URL, options);

/**
 * Loads fixture markup into a window whose location is `url`.
 *
 * Needed because a happy-dom `Location` is bound to its window and cannot be
 * detached: building the DOM and the location from the same `Window` is the
 * only way to model "this markup is being served from that origin".
 */
export const loadFixtureAt = (name: BossFixture, url: string): Window =>
  loadHtml(readFixture(name), url);

/**
 * happy-dom ships its OWN DOM class declarations, which are structurally
 * compatible with but nominally distinct from the global `lib.dom` types the
 * adapter is written against (e.g. happy-dom's `Document` is missing the
 * deprecated `all`/`alinkColor` members of the global `Document`). There is no
 * assertion that both is sound, so the boundary is crossed by one explicit cast
 * per direction. `expectTypeOf` cannot help here; `satisfies` cannot either.
 *
 * These are the ONLY casts in the suite that cross that seam, and each is
 * confined to a `happy-dom` -> `lib.dom` conversion at a call boundary.
 */
type HappyDomDocument = Window["document"];
type HappyDomElement = ReturnType<Window["document"]["createElement"]>;

/** The window's document, typed as the global `Document` the adapter expects. */
export const documentOf = (window: Window): Document => window.document as unknown as Document;

/**
 * Text-faithful view of the parsed document body, for the paths that read
 * `root.textContent`. See the file-level note.
 */
export const asParseRoot = (window: Window): HTMLElement =>
  window.document.body as unknown as HTMLElement;

/** The window's location, typed as the global `Location` the adapter expects. */
export const locationOf = (window: Window): Location => window.location as unknown as Location;

/**
 * Narrows a root to `Document` for the few APIs that insist on one
 * (`detectBossPageKind`) while a body-shaped root is what actually needs to be
 * passed, so the text fallbacks can see real text. Same boundary cast as above.
 */
export const asDocument = (root: ParseRoot): Document => root as unknown as Document;

/** Re-exports used by the parse-root union and the fixture mutators. */
export type { HappyDomDocument, HappyDomElement };

/** Options for `makeDeps`. */
export interface DepsOptions {
  /** Document handed to the adapter. Defaults to the window's document. */
  readonly document?: Document;
  /** Replaces the injected location entirely (e.g. a foreign window's). */
  readonly location?: Location;
  /** Shorthand for injecting a location with just this href. */
  readonly url?: string;
  /** Fixed clock value. Defaults to a frozen 2024-01-01T00:00:00Z. */
  readonly now?: number;
}

/** The location to inject: an explicit one, a URL-derived one, or the window's. */
const resolveLocation = (window: Window, options: DepsOptions): Location => {
  if (options.location !== undefined) return options.location;
  if (options.url !== undefined) return locationOf(loadHtml("", options.url));
  return locationOf(window);
};

/** An injected clock that never advances, so `capturedAt` is assertable. */
export const fixedClock = (now: number): Clock => ({ now: () => now });

/** A recording logger: keeps every entry so tests can assert on redaction. */
export interface RecordingLogger extends Logger {
  readonly entries: () => readonly LogEntry[];
}

export const createRecordingLogger = (): RecordingLogger => {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry["level"]) => (component: string, message: string) => {
    entries.push({ timestamp: 0, level, component, message });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    entries: () => entries,
    clear: () => {
      entries.length = 0;
    },
  };
};

/** A logger that discards everything, for tests that do not inspect logs. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: () => [],
  clear: () => {},
};

/** Frozen clock value used by default: 2024-01-01T00:00:00Z. */
export const FIXED_NOW = 1_704_067_200_000;

/** Assembles `BossPlatformDeps` from a window, with everything injectable. */
export const makeDeps = (window: Window, options: DepsOptions = {}): BossPlatformDeps => ({
  document: options.document ?? documentOf(window),
  location: resolveLocation(window, options),
  logger: silentLogger,
  clock: fixedClock(options.now ?? FIXED_NOW),
  version: "test",
});

/** An `AbortSignal` that has already fired, with a deterministic reason. */
export const abortedSignal = (reason?: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

/** Reverses the order of the job cards in a list document, in place. */
export const reverseCards = (root: ParseRoot): void => {
  const cards = Array.from(root.querySelectorAll(".job-card-wrap"));
  const parent = cards[0]?.parentNode;
  if (parent === null || parent === undefined) return;
  for (const card of [...cards].reverse()) parent.appendChild(card);
};
