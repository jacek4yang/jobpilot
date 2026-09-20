/**
 * Zero-dependency fixture server for the JobPilot Playwright browser suite.
 *
 * ============================ HARD RULE ============================
 * This server exists so that browser tests NEVER touch the live
 * zhipin.com. It serves ONLY:
 *   - a health endpoint for Playwright's `webServer` readiness probe
 *   - the synthetic fixtures under `tests/fixtures/boss/`
 *   - the built userscript from `dist/jobpilot.user.js`
 *   - a harness page that composes the two
 * There is no outbound network access anywhere in this file.
 * ===================================================================
 *
 * WHY THE HOSTNAME MATTERS
 * ------------------------
 * `src/adapters/boss/guards.ts#isSupportedHost` accepts ONLY the exact
 * hostnames `zhipin.com` and `www.zhipin.com`; anything else (including
 * `127.0.0.1`) classifies as `unsupported`. The userscript's host guard is a
 * fail-closed safety feature we must NOT weaken or work around by editing src/.
 *
 * So this server binds the loopback address and additionally accepts requests
 * whose `Host` header is `www.zhipin.com:<port>`. The browser suite maps that
 * name onto 127.0.0.1 at the *browser* level via Chromium's
 * `--host-resolver-rules` launch flag (set per-spec with `test.use()`), which
 * means:
 *   - no DNS lookup ever happens (the rule is applied before resolution),
 *   - no packet leaves the machine,
 *   - `location.hostname` is genuinely `www.zhipin.com`, so the real guard
 *     logic runs unmodified and the tests exercise production code paths.
 *
 * The health probe from `playwright.config.ts` uses
 * `http://127.0.0.1:43117/health`, so both host forms must be served.
 */

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 43117;
const HOST = "127.0.0.1";

/** Repository root, derived from this file's location (`tests/browser/`). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "boss");
const USERSCRIPT_PATH = path.join(ROOT, "dist", "jobpilot.user.js");

/**
 * Hostnames allowed in the `Host` header.
 *
 * `www.zhipin.com` is listed so the suite can present the exact host the
 * adapter's guard requires while still being served by this loopback process.
 * The mapping happens in the browser, not here; this list only prevents the
 * server from being used as an open redirect/host-header echo.
 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "www.zhipin.com", "zhipin.com"]);

/** Fixture names are validated against this allow-list shape (no traversal). */
const FIXTURE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.html$/i;

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };
const JS_HEADERS = { "Content-Type": "application/javascript; charset=utf-8" };
const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8" };

/** Sends a response with a fixed body, disabling caching so reruns stay honest. */
const send = (res, status, headers, body) => {
  res.writeHead(status, { ...headers, "Cache-Control": "no-store" });
  res.end(body);
};

/** Escapes a string for safe interpolation into an HTML attribute. */
const escapeAttribute = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Reads one fixture file, rejecting anything that is not a plain `.html` name
 * inside the fixture directory (defence against `../` path traversal).
 */
const readFixture = async (name) => {
  if (!FIXTURE_NAME_PATTERN.test(name)) return null;
  const resolved = path.join(FIXTURE_DIR, name);
  // `path.resolve` + prefix check is the traversal guard.
  if (!path.resolve(resolved).startsWith(path.resolve(FIXTURE_DIR) + path.sep)) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
};

/** Reads the built userscript, or `null` when `pnpm build` has not run. */
const readUserscript = async () => {
  try {
    const info = await stat(USERSCRIPT_PATH);
    if (!info.isFile()) return null;
    return await readFile(USERSCRIPT_PATH, "utf8");
  } catch {
    return null;
  }
};

/**
 * Builds the harness page for a fixture.
 *
 * The fixture markup is injected verbatim into `<body>` (its own `<head>` is
 * left in place by the caller serving it as a full document inside a same-origin
 * iframe-free page). The userscript is then appended as a classic `<script>`,
 * which runs it against the fixture DOM exactly as a userscript manager would
 * after `document-idle`.
 *
 * `jobpilot:userscript-loaded` / `jobpilot:userscript-error` are dispatched on
 * `window` so tests can await a deterministic signal instead of sleeping.
 */
const buildHarnessPage = (fixtureName, fixtureHtml) => {
  const safeName = escapeAttribute(fixtureName);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>JobPilot harness — ${safeName}</title>
  </head>
  <body>
    <div id="fixture-root">${fixtureHtml}</div>
    <script>
      // Signals for deterministic test synchronisation; no polling, no timers.
      window.__jobpilotHarness = { fixture: ${JSON.stringify(fixtureName)}, loaded: false, error: null };
    </script>
    <script src="/jobpilot.user.js"
      onload="window.__jobpilotHarness.loaded = true; window.dispatchEvent(new Event('jobpilot:userscript-loaded'));"
      onerror="window.__jobpilotHarness.error = 'userscript failed to load'; window.dispatchEvent(new Event('jobpilot:userscript-error'));"
    ></script>
  </body>
</html>`;
};

/** Minimal standalone page that reports a missing build actionably. */
const missingBuildPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>JobPilot build missing</title></head>
<body style="font:14px system-ui;padding:2rem">
  <h1>dist/jobpilot.user.js not found</h1>
  <p>The browser suite loads the <em>built</em> userscript. Run <code>pnpm build</code> first.</p>
  <p>Expected at: <code>${escapeAttribute(USERSCRIPT_PATH)}</code></p>
</body></html>`;

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  } catch {
    send(res, 400, TEXT_HEADERS, "bad request");
    return;
  }

  // Host allow-list: refuses unknown Host headers rather than echoing them.
  const hostname = (req.headers.host ?? "").split(":")[0].toLowerCase();
  if (hostname.length > 0 && !ALLOWED_HOSTS.has(hostname)) {
    send(res, 421, TEXT_HEADERS, `misdirected request: unexpected Host "${hostname}"`);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, TEXT_HEADERS, "method not allowed");
    return;
  }

  const pathname = url.pathname;

  // Playwright webServer readiness probe -----------------------------------
  if (pathname === "/health") {
    send(res, 200, TEXT_HEADERS, "ok");
    return;
  }

  // The built userscript ---------------------------------------------------
  if (pathname === "/jobpilot.user.js") {
    const source = await readUserscript();
    if (source === null) {
      send(
        res,
        404,
        TEXT_HEADERS,
        "dist/jobpilot.user.js not found — run `pnpm build` before `pnpm test:browser`.",
      );
      return;
    }
    send(res, 200, JS_HEADERS, source);
    return;
  }

  // Raw fixture passthrough (used by fixture-smoke tests) -------------------
  if (pathname.startsWith("/fixtures/")) {
    const name = decodeURIComponent(pathname.slice("/fixtures/".length));
    const html = await readFixture(name);
    if (html === null) {
      send(res, 404, TEXT_HEADERS, `fixture not found: ${name}`);
      return;
    }
    send(res, 200, HTML_HEADERS, html);
    return;
  }

  // Composed harness page --------------------------------------------------
  if (pathname === "/harness") {
    const name = url.searchParams.get("fixture") ?? "";
    const html = await readFixture(name);
    if (html === null) {
      send(res, 404, TEXT_HEADERS, `fixture not found: ${name}`);
      return;
    }
    const script = await readUserscript();
    if (script === null) {
      send(res, 200, HTML_HEADERS, missingBuildPage());
      return;
    }
    send(res, 200, HTML_HEADERS, buildHarnessPage(name, html));
    return;
  }

  // Root: a tiny index so a human debugging the server sees what is available.
  if (pathname === "/") {
    send(
      res,
      200,
      HTML_HEADERS,
      `<!doctype html><html><body style="font:14px system-ui;padding:2rem">
       <h1>JobPilot fixture server</h1>
       <ul>
         <li><a href="/health">/health</a></li>
         <li><a href="/harness?fixture=job-list.html">/harness?fixture=job-list.html</a></li>
         <li><a href="/fixtures/job-list.html">/fixtures/job-list.html</a></li>
       </ul></body></html>`,
    );
    return;
  }

  send(res, 404, TEXT_HEADERS, "not found");
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[jobpilot-fixtures] listening on http://${HOST}:${PORT}`);
});

/** Closes the listener so Playwright can stop the webServer without a timeout. */
const shutdown = () => {
  server.close(() => process.exit(0));
  // Safety net: if keep-alive sockets linger, exit anyway.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
