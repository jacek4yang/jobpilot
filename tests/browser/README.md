# JobPilot browser tests

End-to-end browser tests driven by [Playwright](https://playwright.dev), running
the **built** userscript (`dist/jobpilot.user.js`) inside Chromium.

## The hard rule

**These tests never touch the live zhipin.com, or any network host at all.**

Every request goes to a loopback fixture server (`tests/browser/server.mjs`) bound
to `127.0.0.1:43117`. CI must never depend on the real site. If you find yourself
reaching for a real URL here, stop — add a fixture instead.

## Running

```bash
pnpm build               # REQUIRED: the suite drives the built userscript
npx playwright install chromium   # first time only
npx playwright test
```

`pnpm test:browser` is an alias for `npx playwright test`.

If `dist/jobpilot.user.js` is missing, every spec skips with an actionable
message rather than failing confusingly. The fixture server also returns a
`404` with a "run `pnpm build`" hint.

## How the harness works

`server.mjs` is a zero-dependency Node HTTP server that serves:

| Route | Purpose |
| --- | --- |
| `GET /health` | Readiness probe used by `webServer` in `playwright.config.ts` |
| `GET /jobpilot.user.js` | The built userscript (`404` + hint if not built) |
| `GET /fixtures/<name>` | A synthetic fixture, verbatim |
| `GET /harness?fixture=<name>` | Fixture injected into `<body>`, then the userscript injected as a `<script>` |

The harness dispatches `jobpilot:userscript-loaded` / `jobpilot:userscript-error`
and sets `window.__jobpilotHarness`, so tests synchronise on a real event instead
of sleeping.

### Why the tests load `www.zhipin.com`

`src/adapters/boss/guards.ts#isSupportedHost` accepts **only** the exact hostnames
`zhipin.com` and `www.zhipin.com`. That guard is a deliberate fail-closed safety
feature, and these tests do not weaken it or edit `src/` to accommodate them.

Instead, the harness is loaded from `http://www.zhipin.com:43117`, and Chromium is
launched per-spec with:

```
--host-resolver-rules=MAP www.zhipin.com 127.0.0.1
```

This maps the name onto loopback **before DNS resolution**, so:

- no DNS lookup happens and no packet leaves the machine,
- `location.hostname` really is `www.zhipin.com`,
- the production guard, page classifier, and orchestrator run **unmodified**.

This works because a userscript injected as a plain `<script>` does not enforce
`@match`; only the runtime host guard applies, and the alias satisfies it. The
alias is set with `test.use({ launchOptions })` inside each spec, so the shared
`playwright.config.ts` is untouched.

A dedicated test in `safety.spec.ts` loads the harness from plain `127.0.0.1` to
confirm the *host* guard also fails closed.

## What is covered

### `fixture-smoke.spec.ts`
Every fixture present on disk renders through the harness, the userscript loads
and executes, and no uncaught `pageerror` occurs. Also covers server hygiene:
`/health`, the JS content type, and path-traversal rejection.

Fixtures added by other agents (`chat-*.html`, `*-modal.html`, `risk-page.html`)
are picked up automatically when present and skipped with a reason when absent —
no test fails because a fixture is missing.

### `jobpilot-ui.spec.ts`
Against `job-list.html`: the panel (`.jobpilot-root`) mounts, renders its title
and controls, loads in the `idle` state with **Start enabled and Stop disabled**,
and does not start automating on its own. Also asserts **host-page integrity** —
the fixture's original `.job-card` and list container are still present and
visible, and the panel is appended to `<body>` rather than injected into the host
content.

### `safety.spec.ts`
For `captcha.html`, `login.html`, and `unsupported.html`, plus a non-BOSS origin:

- no uncaught error during bootstrap,
- if the panel mounts, it is `idle` and Stop is disabled,
- **no synthetic activation is dispatched**. A capture-phase recorder installed
  before the userscript runs logs every `click`/`mousedown`/`mouseup`/
  `pointerdown`/`submit`, including direct `HTMLElement.click()` calls.

The strongest case presses **Start on a CAPTCHA page** and asserts that JobPilot
still dispatches nothing and never enters a running state — the fail-closed
guarantee that `UNSCANNABLE_PAGES` in the orchestrator provides.

## What is explicitly NOT covered

- **Real zhipin.com behaviour.** The fixtures under `tests/fixtures/boss/` are
  synthetic and hand-authored to match `src/adapters/boss/selectors.ts`. They are
  not captured from the live site (see the "HONESTY NOTICE" headers in
  `guards.ts` and `page-kind.ts`). **Passing these tests does not demonstrate
  that JobPilot works on the real BOSS Zhipin DOM.** Real-site DOM recognition
  remains unverified.
- **Actually submitting an application.** No test drives a real apply flow; the
  fixtures for messaging and modals are still being authored by other agents.
- **Panel page-kind badge text.** `jobpilot-ui.spec.ts` contains a `test.fixme`
  explaining why: the panel does not expose a stable hook for reading back the
  detected page kind, and asserting on rendered label copy would be a
  change-detector. Classification is covered exhaustively by the unit and
  integration suites against the same fixtures.
- **CAPTCHA solving, login automation, or risk-control bypass.** These are
  out of scope by design; the tests assert the opposite.

## Adding a fixture

Drop the file in `tests/fixtures/boss/`. Add its name to `KNOWN_FIXTURES` in
`harness.ts` if you want it smoke-tested; specs otherwise skip absent fixtures
automatically.
