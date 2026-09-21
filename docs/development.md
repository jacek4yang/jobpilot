# Development

Everything needed to build, test and extend JobPilot.

---

## 1. Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `^20.19.0 \|\| >=22.12.0` | Declared in `package.json`'s `engines`. Vite 7 requires the higher floor |
| pnpm | 11 | Pinned exactly as `pnpm@11.9.0` in `package.json`'s `packageManager`; `corepack enable` picks it up automatically |
| Chromium | installed on demand | Only for the browser suite: `npx playwright install chromium` |

Node 22 is the current stable line and what CI runs. There is no other toolchain
dependency: Biome is the linter and formatter, Vitest is the test runner, and
`tsc` is used only for type checking.

```bash
node --version     # v22.x or v20.19+
corepack enable    # makes `pnpm` resolve to the pinned version
pnpm --version     # 11.9.0
```

---

## 2. Setup

```bash
git clone <repository-url> jobpilot
cd jobpilot
pnpm install
```

The repository is a single pnpm package (there is no workspace to build). The
lockfile is committed; CI installs with `--frozen-lockfile`, so a dependency
change must be accompanied by a lockfile change in the same commit.

First run of the browser suite:

```bash
pnpm build                    # the browser suite drives the built bundle
npx playwright install chromium
```

---

## 3. Every script

All of these are real entries in `package.json`. Nothing here is aspirational.

| Script | Command | What it does |
| --- | --- | --- |
| `pnpm dev` | `vite` | Vite dev server with HMR for the userscript bundle |
| `pnpm build` | `vite build` | Produces `dist/jobpilot.user.js` |
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` | Type-checks both the source and the Node-side config files |
| `pnpm lint` | `biome check .` | Lint + format check + import organisation. Exits non-zero on a violation |
| `pnpm lint:fix` | `biome check --write .` | The same, applying safe fixes |
| `pnpm format` | `biome format --write .` | Rewrites files. Does not fail on diffs |
| `pnpm test` | `vitest run` | Unit + integration tests once, then exit |
| `pnpm test:unit` | `vitest run tests/unit` | Unit tests only |
| `pnpm test:integration` | `vitest run tests/integration` | Integration tests only |
| `pnpm test:watch` | `vitest` | Watch mode |
| `pnpm test:browser` | `playwright test` | Browser suite. Needs `pnpm build` first |
| `pnpm verify:dist` | `tsx scripts/verify-build.ts` | Asserts the built artifact is installable and safe to ship |
| `pnpm recon:dom` | `tsx scripts/recon/live-dom-recon.ts` | **Maintainer-only** live-DOM reconnaissance. Contacts the real zhipin.com; see the boundary rules below |
| `pnpm check` | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm verify:dist` | The full gate. Run this before pushing |

`pnpm check` builds, and `pnpm verify:dist` reads `dist/jobpilot.user.js`, so the
order in `check` is load-bearing: running `verify:dist` on its own against a stale
`dist/` verifies the stale bundle.

### 3.1 `pnpm recon:dom` — the live-DOM reconnaissance harness

`scripts/recon/live-dom-recon.ts` is **maintainer-only development tooling**. It
exists for exactly one reason: the BOSS adapter's selectors are written down with
explicit `fixture-only`/`unverified` confidence, and the only honest way to
promote one is cited evidence from the real DOM. The harness reads that DOM.

It is governed by hard boundaries, stated in its header comment and repeated
here because they are load-bearing:

- **Never runs in CI.** It contacts the live site. A guard refuses to start
  when `CI` is set. CI stays loopback-only.
- **Never shipped.** Nothing under `src/` imports it; it is not part of any
  build output.
- **Anti-detection lives here, and only here.** The harness launches Camoufox
  (a Firefox-based automation browser, devDependency) because an unmodified
  automation Chromium is risk-flagged by the site before any structure can be
  read. The shipped userscript still runs in the user's own real browser and
  does no fingerprint spoofing whatsoever — the "Safety model" list in
  README.md binds the product, not this dev tool.
- **Read-only on the site.** It never clicks a communicate/send control, never
  opens a conversation, never types into an editor. Navigation and DOM reads
  only; login (including any CAPTCHA) is completed by hand.
- **Output stays private.** Captures are written under
  `test-results/live/<date>/recon/` (gitignored). Only a reduced, sanitized
  fixture may be committed, per [`../docs/diagnostics/PRIVACY.md`](../docs/diagnostics/PRIVACY.md).

Usage: `pnpm recon:dom [output-dir]`. A headed browser opens on zhipin.com;
log in by hand, then the harness captures the search list (several cities), one
job detail, and the chat list automatically. The profile persists under the run
directory, so re-runs do not need a new login.

---

## 4. Adding a rule

Rules live in the domain and are pure: they take a `JobDetail` and a
`RuleContext`, and return a `RuleResult`. No DOM, no storage, no clock reads.

**1. Write the rule.** A hard rule rejects outright; a soft rule contributes
score and always passes.

```ts
// src/domain/hard-filters.ts
import { rejection, hardPass, type Rule } from "./rule";

export const noInternshipRule: Rule = {
  id: "hard.no-internship",
  kind: "hard",
  evaluate(job, context) {
    if (job.title.includes("实习")) {
      return rejection("hard.no-internship", "title advertises an internship");
    }
    return hardPass("hard.no-internship", "not an internship");
  },
};
```

Use the constructors from `src/domain/rule.ts` rather than building the object
literal by hand. `rejection` and `hardPass` set `kind` and `passed` correctly, and
`softScore(ruleId, delta, message)` does the same for a weighted contribution.

**2. Register it.** Add it to the ordered registry in
`src/domain/rules-index.ts`. Order matters for hard rules: the engine
short-circuits on the first failure, so the most decisive rule should run first
and the reason the user sees should be the most specific one.

**3. Configure it.** If the rule needs a setting, add the field to
`FiltersConfig` or `ScoringConfigSection` in `src/config/schema.ts`, give it a
default in `createDefaultConfig()`, and add a reader in
`src/config/validate.ts`. Follow the existing contract: a missing field takes the
default, a wrong-typed field is an error, and every problem is collected rather
than thrown.

**4. Test it.** Add a case to `tests/unit/domain/rule-engine.test.ts` for the
decision, and to `tests/unit/config/validate.test.ts` if you added a field.

A soft rule appears in the panel's explanation automatically: the engine pushes
every non-zero `delta` into `Evaluation.reasons`, and the panel renders the
ordered trace.

---

## 5. Adding a platform adapter

An adapter implements `JobPlatform` from `src/ports/job-platform.ts` and nothing
else changes — no domain edit, no reducer edit, no storage edit. That is the
whole value of the port boundary.

```ts
// src/adapters/example/index.ts
import type {
  ApplyOptions, ApplyResult, JobDetail, JobPlatform,
  JobSummary, PageKind, ScanOptions, VerificationResult,
} from "../../ports/job-platform";

export const EXAMPLE_PLATFORM_ID = "example";

export const EXAMPLE_METADATA = {
  id: EXAMPLE_PLATFORM_ID,
  displayName: "Example Jobs",
  matches: ["https://example.com/*"] as readonly string[],
  automationVerified: false as const,
  notes: "Fresh adapter. No selector here has been checked against the live site.",
} as const;

export const createExamplePlatform = (deps: {
  readonly document: Document;
  readonly location: Location;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly version: string;
}): JobPlatform => ({
  id: EXAMPLE_PLATFORM_ID,
  displayName: EXAMPLE_METADATA.displayName,

  detectPage(): PageKind {
    // Return "unknown" rather than guessing. Callers fail closed on it.
    return "unknown";
  },

  async scanJobs(options?: ScanOptions): Promise<readonly JobSummary[]> {
    return [];
  },

  async loadJob(job: JobSummary, options?: ApplyOptions): Promise<JobDetail> {
    // Throw rather than fabricate. A JobDetail must never be invented.
    throw new Error("example.loadJob: not implemented");
  },

  async apply(job: JobDetail, options?: ApplyOptions): Promise<ApplyResult> {
    throw new Error("example.apply: not implemented");
  },

  async verifyApplication(job: JobDetail, options?: ApplyOptions): Promise<VerificationResult> {
    throw new Error("example.verifyApplication: not implemented");
  },
});
```

**The five contract rules every adapter must honour:**

1. **`detectPage()` never throws.** An unreadable page is `"unknown"`.
2. **`scanJobs()` returns `[]` when it is not certain** — a non-list page, an
   empty list, or an aborted signal. It never falls back to parsing "whatever is
   there".
3. **`loadJob()` throws rather than returning a partial detail.** A required
   anchor that is missing is a hard stop (`unknown-dom`), not a best guess.
4. **`apply()` only clicks an element an explicit selector matched.** A miss is
   `BlockReason: "selector-missing"`. There is no text-based fallback for a
   destructive action.
5. **Never infer success.** Absent confirmation evidence is
   `needs-confirmation`, never `submitted`.

**Then:** construct it in `src/bootstrap/container.ts` (the only composition
root), add its host pattern to the userscript `match` list in `vite.config.ts` and
to the `allowedMatch` pattern in `scripts/verify-build.ts`, and list its id in
`config.general.enabledPlatforms` when you want it enabled by default.

**Selector discipline.** Give every selector an explicit confidence and a note
explaining the candidate ordering and what is unknown. The vocabulary is
`"fixture-only"` (asserted by our own synthetic fixture, says nothing about the
real site) and `"unverified"` (a heuristic guess). There is no `"verified"` value,
and it must not be added without evidence captured from the live site.

---

## 6. Adding a test

The suite has three layers. Choose the cheapest one that can genuinely observe
the behaviour.

**A unit test** for anything pure — a rule, a parser helper, a reducer
transition, a migration step. Put it under `tests/unit/`, mirroring the source
path.

```ts
// tests/unit/domain/rule-engine.test.ts
import { describe, expect, it } from "vitest";
import { createRuleEngine } from "../../../src/domain/engine";

describe("rule engine", () => {
  it("short-circuits on the first failing hard rule", () => {
    const engine = createRuleEngine({
      hard: { /* ... */ },
      scoring: { baseScore: 50, acceptThreshold: 70, /* ... */ },
    });

    const evaluation = engine.evaluate({ job, context });

    expect(evaluation.accepted).toBe(false);
    expect(evaluation.rejections).toHaveLength(1);
  });
});
```

**An integration test** for the BOSS adapter against a fixture. Use
`tests/integration/boss-harness.ts` rather than constructing a DOM by hand — it
handles the two happy-dom quirks documented in its header.

```ts
// tests/integration/boss-parser.test.ts
import { describe, expect, it } from "vitest";
import { createBossPlatform } from "../../src/adapters/boss";
import { loadFixture, makeDeps } from "./boss-harness";

describe("boss list parsing", () => {
  it("parses every card in the list fixture", async () => {
    const window = loadFixture("job-list.html");
    const platform = createBossPlatform(makeDeps(window));

    const jobs = await platform.scanJobs();

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]?.id).toBeDefined();
  });
});
```

**A browser test** only when the behaviour depends on the built bundle running in
a real browser: mounting, shadow-DOM isolation, or the fail-closed guarantee.
Add specs under `tests/browser/` and reuse `harness.ts`.

```ts
// tests/browser/safety.spec.ts
import { expect, test } from "@playwright/test";
import { HOST_MAPPING_ARGS, loadHarness, waitForPanel } from "./harness";

test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });

test("Start on a CAPTCHA page dispatches nothing", async ({ page }) => {
  await loadHarness(page, "captcha.html", { host: "guarded" });
  await waitForPanel(page);
  // ...assert no click/mousedown/submit event was observed
});
```

**Rules for browser tests.** They must never reach a non-loopback host — the
harness enforces this and `fixture-smoke.spec.ts` fails the suite if it is
broken. Do not modify `src/` to make a test pass; if a production guard blocks
the test, set up the test environment to satisfy the guard (as the host mapping
does) rather than weakening the guard.

---

## 7. The fixture workflow

Fixtures are the only input the adapter integration and browser suites have.

**Where they live.** `tests/fixtures/boss/*.html`.

**What they are.** Synthetic HTML, hand-authored to match
`src/adapters/boss/selectors.ts` and
`src/adapters/boss/communication/selectors.ts`. They are **not** captured from
the live site. A fixture passing proves the parser plumbing works; it proves
nothing about the real site.

Current fixtures:

```
job-list.html              job-detail.html          empty-list.html
captcha.html               login.html               risk-page.html
unsupported.html           success-modal.html       unknown-modal.html
chat-conversation.html     chat-with-draft.html     chat-message-sent.html
chat-message-failed.html   chat-wrong-conversation.html
chat-textarea-editor.html
```

**Adding one.**

1. Write the HTML in `tests/fixtures/boss/`.
2. Give every element you intend to match a `data-jobpilot-*` hook, so the
   fixture asserts *our* contract rather than imitating a real class name. A
   `data-jobpilot-*` hook is what earns a selector `fixture-only` rather than
   `unverified`.
3. Add the file name to `KNOWN_FIXTURES` in `tests/browser/harness.ts` for the
   smoke test, and to the `BossFixture` union in
   `tests/integration/boss-harness.ts` if an integration test uses it.
4. If a fixture's page kind is counter-intuitive, record the observed value in
   `OBSERVED_PAGE_KIND` in `tests/browser/harness.ts` with a comment explaining
   why. Two are already surprising (`unsupported.html` reports `unknown` because
   the host is supported; `risk-page.html` reports `captcha` because the CAPTCHA
   guard outranks risk control).

**Skips are deliberate.** The browser suite only asserts against fixtures that
exist on disk. A spec naming a fixture another contributor has not written yet is
*skipped with a reason*, never silently passed and never failed. If you see a
skipped browser test, check whether the fixture file is present.

**Read the real DOM before asserting.** Run a probe (or the harness's
`readPanelState`) and read the actual values, then write the assertion. The panel
has been refactored at least once — `.jobpilot-badge` was replaced by
`.jobpilot-dot` — and every selector that had been inferred from source rather
than observed in the DOM broke silently.

---

## 8. Quality gates

`pnpm check` is the gate, and CI runs its stages in parallel jobs.

| Gate | Command | Fails when |
| --- | --- | --- |
| Types | `pnpm typecheck` | Any type error in `src/`, `tests/`, `scripts/` or the Node config files |
| Lint | `pnpm lint` | A Biome rule violation, a formatting difference, or unorganised imports |
| Tests | `pnpm test` | Any unit or integration test fails |
| Build | `pnpm build` | Vite cannot emit `dist/jobpilot.user.js` |
| Artifact | `pnpm verify:dist` | The bundle is missing a metadata field, mismatches `package.json`'s version, requests an unexpected grant or match, contains `@require`/`@resource`/`eval(`, is not the only runtime file, or falls outside the size budget |

What Biome enforces that is worth knowing before you write code:

- Double quotes, semicolons, trailing commas, 100-column lines, LF endings.
- `noExplicitAny`, `noNonNullAssertion`, `noDoubleEquals`, `useConst`,
  `useTemplate` and `noParameterAssign` are **errors**.
- `noUnusedVariables` and `noUnusedImports` are errors.
- `noConsole` is a warning, and `console.log` is the only allowed call.
  Exceptions: `scripts/**` and `tests/browser/**` may use any `console` method.
- Formatting is part of `biome check`, so `pnpm lint` fails on a format diff. Run
  `pnpm format` (or `pnpm lint:fix`) rather than fighting it.

`dist/`, `node_modules/`, `coverage/`, `tests/fixtures/`, `playwright-report/` and
`test-results/` are excluded from Biome.

---

## 9. Project layout

```
.github/workflows/   ci.yml, release.yml
docs/                architecture.md, development.md, boss-adapter.md,
                     troubleshooting.md, product/, research/
scripts/             verify-build.ts
src/adapters/        boss/, storage/
src/application/     controller, reducer, orchestrator, state, events,
                     discovery, history, repository, communication-runner
src/bootstrap/       bootstrap.ts, container.ts
src/config/          schema, validate, migrations, persisted, index
src/domain/          application/, communication/, company/, history/, job/,
                     matching/, recruiter/, search-profile/, support/
src/infrastructure/  logging/, observer/, queue/, rate-limit/, retry/, watchdog/
src/ports/           job-platform, storage, lock, logger
src/ui/              panel.ts, sections.ts, styles.ts, view-model.ts
tests/browser/       Playwright specs, harness.ts, server.mjs
tests/fixtures/boss/ synthetic HTML
tests/integration/   adapter tests against fixtures
tests/unit/          pure logic
```

---

## 10. Debugging

**The panel does not appear.** Check that the userscript loaded (the
`==UserScript==` block should list the two `zhipin.com` patterns) and that
`general.enabled` is `true`. See
[`troubleshooting.md`](./troubleshooting.md).

**Storage is not persisting.** If GM grants are missing, `createRuntimeDeps`
falls back to `MemoryStorage` and logs a warning: settings and history will not
survive a reload. That is usually a sign the file was loaded as a plain script
rather than installed through a userscript manager.

**Browser tests skip everything.** The build is missing. Run `pnpm build`; the
fixture server returns a `404` with that hint, and the specs skip with an
actionable message rather than failing confusingly.

**The browser tests cannot find the panel.** The panel lives in an **open shadow
root** at `div[data-jobpilot-host]`. Playwright pierces open shadow roots for CSS
selectors, so `page.locator(".jobpilot-page-chip")` works from page level. If a
selector stops matching, read the real shadow tree — the class names have changed
once already, and guessing wastes a CI cycle.
