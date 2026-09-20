# JobPilot

A local-first, rule-driven job-application assistant that runs as a userscript in
your own browser tab.

JobPilot reads the job listings already rendered in front of you, scores them
against rules you write, explains every decision, and — if you explicitly ask it
to — contacts recruiters on your behalf. It runs entirely inside the page you
opened. There is no server, no account, and no telemetry: the configuration
schema contains a `telemetryEnabled` field that is hard-defaulted to `false` and
has no code path that turns it on.

---

## Status

JobPilot is a working, tested program whose interaction with the **real BOSS
Zhipin site is unverified**. That distinction matters more than any feature list,
so it comes first.

| Area | Status | Detail |
| --- | --- | --- |
| Domain rules, scoring, two-stage matching | **Verified** | Pure TypeScript, covered by unit tests under `tests/unit/domain`, `tests/unit/matching` |
| Config schema, validation, migrations v1→v2→v3 | **Verified** | Unit-tested in `tests/unit/config` |
| State machine (reducer + effects) | **Verified** | `tests/unit/application/state-machine.test.ts` |
| Application history / dedup | **Verified** | `tests/unit/application/history.test.ts`, `tests/unit/history` |
| Storage adapters (GM + in-memory) | **Verified** | `tests/unit/storage/storage.test.ts` |
| Communication transaction (intent phases) | **Verified as logic** | `tests/unit/communication/intent.test.ts` |
| Panel mounting, shadow DOM isolation, fail-closed on a CAPTCHA page | **Verified in Chromium** | `tests/browser/` against local fixtures, driving the built bundle |
| **BOSS adapter: page classification** | **Fixture-only** | `tests/integration/boss-page-detection.test.ts`. Recognises *our synthetic HTML*, not the live site |
| **BOSS adapter: list/detail parsing** | **Fixture-only** | `tests/integration/boss-parser.test.ts`. Same caveat |
| **BOSS adapter: applying to a job** | **Fixture-only + unverified selectors** | `tests/unit/...` and fixtures only. The live apply flow was never observed |
| **BOSS adapter: sending a message** | **Fixture-only + unverified selectors** | The real chat DOM, send button, success dialog and failure markers were never inspected |
| **BOSS city code table** | **Vendored, not verified live** | Derived from a public MIT-licensed table (374 entries); not confirmed against BOSS's own API |

**The real BOSS Zhipin DOM was never inspected while writing the BOSS adapter.**
Every selector in `src/adapters/boss/selectors.ts` carries a `confidence` field
that is either `fixture-only` or `unverified` — there is no `verified` value in
the type. `BOSS_METADATA.automationVerified` is the literal `false`, typed as a
literal so that a false claim cannot be made to compile.

A passing test suite proves the parser plumbing works. It proves nothing about
whether JobPilot recognises the live site — the fixtures were hand-authored to
match the selectors, not captured from the site.

Do not install this expecting it to work on BOSS Zhipin today. Do install it if
you intend to help verify it. See [`docs/boss-adapter.md`](docs/boss-adapter.md).

---

## Features

**Discovery and evaluation**

- Search profiles: named, reusable sets of keywords, cities, salary band,
  experience and degree requirements.
- Two-stage evaluation. Stage A filters on card data alone, so a rejected job
  never costs a navigation. Stage B opens only survivors and reads the full
  posting.
- City validation. A city name resolves against a vendored 374-entry BOSS code
  table or discovery refuses to start. There is no default city — an unknown name
  fails explicitly with suggestions.
- Every accept and reject carries an ordered rule trace. There is no score
  without reasons.

**Execution**

- A visible queue with per-item control: pause, resume, skip, stop after this.
- An explicit automation mode ladder: `manual` → `assist` (default) →
  `automatic`. Switching to `automatic` requires an explicit risk
  acknowledgement that the validator enforces — a hand-edited config file cannot
  quietly enable it.
- Session, hourly and consecutive-failure limits, checked when an action is
  armed rather than when it is clicked.
- A watchdog that pauses the machine if a state stalls past its budget.

**Communication transaction**

- Sending a first message is modelled as a persisted transaction with an explicit
  `send-attempted` point of no return.
- Chat identity is verified before anything is typed: a job-id match is
  authoritative, otherwise the title plus the company or recruiter is required. A
  bare editor never authorises a send.
- Success is only ever reported from an observed outgoing-message delta. A
  clicked button is not evidence.

**Persistence**

- One storage key, `jobpilot:root:v1`, namespaced `jobpilot:` so it cannot
  collide with another userscript.
- A versioned schema with real migrations (v1→v2→v3), each additive. Unknown
  fields are carried through; a document claiming a newer version is refused
  rather than downgraded and guessed at.
- History is authoritative: a job that reached `submitted` or `verified` cannot
  transition back to a pre-submission state.

**Interface**

- A panel in an open shadow root, so the host page's CSS cannot reach in and
  JobPilot's cannot leak out.
- Blocked states replace the panel body with a plain-language explanation, the
  reason in the largest text on screen, and a Resume control.
- An `uncertain` send is a first-class state with a dedicated badge. It is never
  rounded to success and never auto-retried.

---

## Safety model

These are design invariants, not settings. They are enforced in the domain and
application layers and are covered by tests.

| Invariant | Where it lives |
| --- | --- |
| **Never bypasses CAPTCHA, risk control or login.** No code path dismisses, solves, retries through or navigates around a verification page | `src/adapters/boss/guards.ts`; `UNSCANNABLE_PAGES` in `src/application/orchestrator.ts` |
| **Fails closed.** An unrecognised page is `unknown`, not a guess. An unmatched apply button is `selector-missing`, with no text-based fallback | `src/adapters/boss/parser/page-kind.ts`, `src/adapters/boss/actions/apply-action.ts` |
| **Never sends into an unverified chat.** Identity must be confirmed from a job id, or a title plus company/recruiter. `insufficient` evidence is treated exactly like a mismatch | `src/domain/communication/identity.ts` |
| **Never overwrites a draft.** A non-empty editor is reported and left untouched, and the check runs again immediately before the click | `prepareMessage` / `dispatchSend` in `src/adapters/boss/communication/communication-action.ts` |
| **Never retries an uncertain send.** Once an intent reaches `send-attempted`, the only legal continuation is verification. `canClickSend` returns `false` forever after | `src/domain/communication/intent.ts` |
| **Never infers success.** An unconfirmed click is `needs-confirmation`; an unobserved message is `uncertain`. Neither is ever `submitted` / `verified` | `readApplyEvidence`; `observeSend` |
| **Prefers a false skip over a duplicate send.** Five independent dedup layers; if the platform's own state is ambiguous, the job is skipped and labelled as assumed-contacted so you can override deliberately | `src/application/orchestrator.ts`, `src/application/history.ts`, `src/application/discovery.ts` |
| **Yields to the user.** A draft, a route change, or a control the user touches interrupts automation rather than competing with it | `PAGE_CHANGED` and `DRAFT_DETECTED` transitions |

JobPilot deliberately does **not** do any of the following, all of which appear
in comparable tools: connect over the Chrome DevTools Protocol, reuse or copy a
browser profile, deobfuscate anti-scraping fonts, call undocumented in-page APIs,
or optimise for being "harder to flag as automated traffic". See
[`docs/research/boss-reference-analysis.md`](docs/research/boss-reference-analysis.md)
for the reasoning, including which ideas were adopted and which were explicitly
rejected.

**You are responsible for how you use this.** Unattended messaging may violate a
platform's terms of service. The `automatic` mode exists because some users
accept that trade-off knowingly; the default is `assist`, which does not send
without a human.

---

## Installation

JobPilot is not published to any userscript registry. Build it and load the
built file.

```bash
git clone <repository-url> jobpilot
cd jobpilot
pnpm install
pnpm build
```

`pnpm build` writes exactly one runtime file, `dist/jobpilot.user.js`. It also
nests a copy under `dist/<name>/` because of how pnpm resolves the userscript
manifest; `dist/jobpilot.user.js` at the top level is the one to install.

Then, with Tampermonkey or Violentmonkey installed:

1. Open the extension's dashboard.
2. Choose **Create a new script** (Tampermonkey) or **Create a new script**
   (Violentmonkey) and clear the template.
3. Paste the contents of `dist/jobpilot.user.js`.
4. Save, then reload a `zhipin.com` tab.

Alternatively, drag `dist/jobpilot.user.js` onto the browser window and accept the
install prompt.

The userscript header requests four grants and nothing else — `GM_getValue`,
`GM_setValue`, `GM_deleteValue`, `GM_registerMenuCommand` — and matches only
`https://www.zhipin.com/*` and `https://zhipin.com/*`. `pnpm verify:dist` fails
the build if either set grows.

If the GM storage APIs are unavailable (for example when you load the file as a
plain script during development), JobPilot falls back to in-memory storage and
logs a warning. The panel still works; nothing survives a reload.

---

## Development

Requires **Node `^20.19.0 || >=22.12.0`** and **pnpm 11** (the exact version is
pinned in `package.json`'s `packageManager` field). See
[`docs/development.md`](docs/development.md) for the full workflow.

```bash
pnpm install          # install dependencies
pnpm dev              # Vite dev server with HMR for the userscript bundle
pnpm check            # the full gate: typecheck, lint, test, build, verify:dist
```

Quality gates, individually:

```bash
pnpm typecheck        # tsc --noEmit over tsconfig.json and tsconfig.node.json
pnpm lint             # biome check .
pnpm format           # biome format --write .  (moves files, does not fail)
pnpm test             # vitest run: unit + integration, no browser needed
```

---

## Build

```bash
pnpm build            # vite build -> dist/jobpilot.user.js
pnpm verify:dist      # asserts the artifact is installable and safe to ship
```

`pnpm verify:dist` runs `scripts/verify-build.ts`, which checks that the artifact
exists, that the `==UserScript==` block has every required field, that
`@version` matches `package.json`, that `@grant` is exactly the least-privilege
set, that `@match` stays inside `zhipin.com`, that there is no `@require`,
`@resource` or `eval(`, that exactly one runtime file was emitted, that no bare
module import or external stylesheet survived bundling, and that the artifact is
within a 4 KiB – 512 KiB size budget.

---

## Architecture

JobPilot is hexagonal. Dependencies point inward; the domain knows nothing about
the DOM, storage or the browser.

```
              ┌─────────────────────────────────────────┐
              │                  UI                     │
              │        src/ui/panel.ts, sections.ts     │
              └────────────────────┬────────────────────┘
                                   │ view models + callbacks
                                   v
              ┌─────────────────────────────────────────┐
              │             APPLICATION                 │
              │  controller · reducer · orchestrator    │
              │  state · events · discovery · history   │
              └────────────────────┬────────────────────┘
                                   │
                                   v
              ┌─────────────────────────────────────────┐
              │                DOMAIN                   │
              │  rules · engine · matching · job ·      │
              │  communication/intent · application     │
              └─────────────────────────────────────────┘
                     ^                          ^
                     │ implements               │ implements
              ┌──────┴───────┐           ┌──────┴────────┐
              │   ADAPTERS   │           │ INFRASTRUCTURE│
              │ boss · storage│          │ logs · observer│
              │              │           │ queue · retry  │
              └──────┬───────┘           └──────┬─────────┘
                     │                          │
                     └────────────┬─────────────┘
                                  v
                         ┌─────────────────┐
                         │      PORTS      │
                         │ JobPlatform ·   │
                         │ Storage · Lock ·│
                         │ Logger          │
                         └─────────────────┘
```

The rules, in full:

- **UI → Application → Domain.** The panel renders view models it is handed and
  reports user intent through callbacks. It never reaches into automation,
  storage or an adapter.
- **Adapters → Ports ← Application.** An adapter implements a port the
  application depends on. The application never imports an adapter.
- **`src/bootstrap/container.ts` is the only composition root.** It is the single
  place where concrete adapters are constructed and wired.

Adding a platform means adding an adapter. It never means changing the domain,
the state machine, the queue or storage. Full module inventory, the reducer's
effect model, the persistence schema and the multi-tab lock design are in
[`docs/architecture.md`](docs/architecture.md).

---

## Configuration

Configuration is a single versioned document stored under `jobpilot:root:v1`.
There is no settings file to edit by hand, though the persisted JSON is
hand-editable and is validated on every load.

**The mode defaults to `assist`.** `DEFAULT_AUTOMATION_MODE` in
`src/config/schema.ts` carries a comment telling you not to change it, and the
validator refuses `mode: "automatic"` unless `acknowledgeRisks` is `true`.

| Section | What it controls |
| --- | --- |
| `general` | Master `enabled` switch, `locale`, `enabledPlatforms`, `pauseOnNavigation` |
| `filters` | Hard filters: cities, salary bounds, education, experience, include/exclude keywords, company blacklist, `excludeOutsourcing`, `excludeHeadhunter`, `skipProcessed` |
| `scoring` | `baseScore`, `acceptThreshold`, `maxScore`, and weighted keyword lists for titles, descriptions, skills and cities |
| `automation` | `mode`, `acknowledgeRisks`, per-session and per-hour caps, `maxRetries`, action delay range, `verifyAfterSubmit`, `stopOnUnknownDom` |
| `rateLimit` | `minNavigationDelayMs`, `failureBackoffMs`, `maxConsecutiveFailures`, `stopOnCircuitBreak` |
| `ui` | `showPanel`, `panelPosition`, `showReasons`, `compactMode` |
| `logging` | `level`, ring-buffer `maxEntries`, `persistLogs`, and the reserved `telemetryEnabled` |

Migration policy: migrations are **additive and never destroy user data**. A
document with no `schemaVersion` is treated as v1. A document claiming a version
newer than this build supports is refused outright and left on disk untouched,
because downgrading by guessing would drop fields the current build cannot see.

---

## Testing

```bash
pnpm test              # vitest run — unit + integration (happy-dom + Node, no browser)
pnpm test:unit         # vitest run tests/unit
pnpm test:integration  # vitest run tests/integration
pnpm test:browser      # playwright test — requires a build first
```

`pnpm test:browser` drives the **built** userscript (`dist/jobpilot.user.js`) in
Chromium, so run `pnpm build` first. It needs Playwright's browser once:

```bash
npx playwright install chromium
```

Browser tests run against a loopback fixture server (`tests/browser/server.mjs`
on `127.0.0.1:43117`). They never touch the live site. The harness is served from
`http://www.zhipin.com:43117` with `--host-resolver-rules=MAP www.zhipin.com
127.0.0.1`, which makes `location.hostname` genuinely `www.zhipin.com` while
resolving before DNS — so the production host guard runs unmodified, and no
packet leaves the machine. `fixture-smoke.spec.ts` installs a request listener
that fails the suite if any request targets a non-loopback host.

| Suite | Covers |
| --- | --- |
| `tests/unit/` | Domain rules, matching, config validation and migrations, the reducer, history, storage, the intent machine, the communication runner, identity matching |
| `tests/integration/` | The BOSS adapter against synthetic fixtures in happy-dom: page classification and list/detail parsing |
| `tests/browser/` | The built bundle in Chromium: panel mount and isolation, page-kind chip, and the fail-closed guarantee that Start on a CAPTCHA page dispatches zero events |

---

## Known limitations

These are real and current.

1. **No live-site verification.** The BOSS adapter has never been run against
   the real BOSS Zhipin DOM. Roughly one in three selectors is an outright guess.
   See [`docs/boss-adapter.md`](docs/boss-adapter.md).
2. **Only one platform.** BOSS Zhipin. The port is designed for more; there is
   one implementation.
3. **Apply flows are not driven end to end in a browser test.** No browser spec
   completes a real apply; the safety specs assert that JobPilot does *nothing*
   on a blocked page.
4. **The panel is not fully wired.** The tab strip renders all eight tabs, but
   `Matches` and `Queue` are rendered from empty arrays in
   `src/bootstrap/bootstrap.ts`. Discovery exists
   (`src/application/discovery.ts`) and is unit-tested, but is not yet reachable
   from the panel.
5. **Communication is not reachable from the UI.** The runner and the adapter
   action exist and are unit-tested, but nothing in `bootstrap.ts` calls them yet.
6. **The history-driven "uncertain send" decision list is a placeholder.** It
   currently derives from records with status `submitted`, not from a persisted
   `CommunicationIntent`, because the intent is not yet persisted to storage.
7. **Multi-tab locking is specified and not implemented.** The `Lock` port and an
   in-memory implementation exist (`src/ports/lock.ts`); no
   `navigator.locks`-backed implementation is wired into bootstrap, so two BOSS
   tabs would both be live today.
8. **Recruiter activity parsing is conservative and often yields `unknown`.**
   Contradictory labels resolve to the least-active state.
9. **City codes are vendored, not fetched.** If BOSS changes its taxonomy the
   table goes stale silently; nothing checks it against the site.
10. **No telemetry, and therefore no crash reporting.** Diagnostics stay in the
    browser. If something fails on the live site, only your own logs will say so.

---

## Roadmap

Ordered by what most increases confidence in the thing that is currently
unverified.

1. **Verify selectors against the real site**, capture by capture, promoting each
   entry out of `fixture-only`/`unverified` with cited evidence. This is the only
   work that can move `automationVerified` off `false`.
2. **Persist the `CommunicationIntent`** to storage and recover it on boot, so
   the `send-attempted` → verify-only path survives a reload in practice and not
   only in the reducer.
3. **Wire the UI to discovery and the queue**, replacing the empty arrays in
   `bootstrap.ts`.
4. **Implement `navigator.locks` behind the `Lock` port** and make a second tab
   render read-only.
5. **Drive a full apply and a full send in a browser test** against fixtures.
6. **A second platform adapter**, to prove the port boundary is real.
7. **Import from BOSS Helper settings**, non-destructively, with a field-by-field
   review before anything is written.

---

## License

MIT. See [`LICENSE`](LICENSE).
