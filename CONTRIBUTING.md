# Contributing

How to build, test and submit a change to JobPilot.

Read this before your first pull request. §5 is the section that matters most:
**this repository is public**, and the thing JobPilot handles is other people's
private data.

---

## 1. Prerequisites

| Requirement | Version | Where it comes from |
|---|---|---|
| Node.js | `^20.19.0 \|\| >=22.12.0` | `engines.node` in `package.json`. Vite 7 sets the floor |
| pnpm | `11` — pinned as `pnpm@11.9.0` | `packageManager` in `package.json` |
| Chromium | installed on demand | Only for the browser suite: `npx playwright install chromium` |

```bash
node --version     # v20.19+ or v22.12+
corepack enable    # makes `pnpm` resolve to the pinned version
pnpm --version     # 11.9.0
```

Node 22 is what CI runs (`.github/workflows/ci.yml` pins `node-version: 22`).
There is no other toolchain dependency: Biome lints and formats, Vitest runs
tests, Playwright drives the browser suite, and `tsc` is used only for type
checking.

---

## 2. Setup

```bash
git clone https://github.com/jacek4yang/jobpilot.git
cd jobpilot
pnpm install
```

The lockfile is committed and CI installs with `--frozen-lockfile`, so **a
dependency change must include the `pnpm-lock.yaml` change in the same commit**.
A PR that edits `package.json` without the lockfile will fail its install step.

First run of the browser suite only:

```bash
pnpm build                                 # the browser suite drives the built bundle
npx playwright install chromium
```

---

## 3. The gates

Every one of these is a real entry in `package.json`. Nothing here is
aspirational.

| Gate | Command | Fails when |
|---|---|---|
| Types | `pnpm typecheck` | Any type error in `src/`, `tests/`, `scripts/` or the Node config files |
| Lint | `pnpm lint` | A Biome rule violation, a formatting difference, or unorganised imports |
| Unit + integration | `pnpm test` | Any test in `tests/unit` or `tests/integration` fails |
| Browser | `pnpm test:browser` | Any Playwright spec fails. **Requires `pnpm build` first** |
| Build | `pnpm build` | Vite cannot emit `dist/jobpilot.user.js` |
| Artifact | `pnpm verify:dist` | The userscript is missing a metadata field, mismatches `package.json`'s version, requests an unexpected grant or match, contains `@require`/`@resource`/`eval(`, is not the only runtime file, or exceeds the size budget |
| Diagnostic build | `pnpm build:diagnostic` | The diagnostic channel cannot be built |
| Diagnostic artifact | `pnpm verify:diagnostic` | The diagnostic artifact violates the same checks as `verify:dist` |
| Diagnostics self-test | `pnpm diag:selftest` | The analyzer's own detectors regress |
| **Everything** | `pnpm check` | Any of the above |

`pnpm check` is the aggregate:

```bash
pnpm check
# == pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm verify:dist
#    && pnpm build:diagnostic && pnpm verify:diagnostic && pnpm diag:selftest
```

**Run `pnpm check` before you push.** The order is load-bearing: `verify:dist`
reads `dist/jobpilot.user.js`, so running it alone against a stale `dist/`
verifies the wrong artifact.

The browser suite is **not** part of `pnpm check` — it needs Chromium and a build.
CI runs it as its own job. Run it locally when your change touches anything the
bundle does at runtime:

```bash
pnpm build && pnpm test:browser
```

Individual test layers, when you need to isolate a failure:

```bash
pnpm test:unit            # vitest run tests/unit
pnpm test:integration     # vitest run tests/integration
pnpm test:watch           # watch mode
```

Formatting is part of `pnpm lint`. Do not fight it:

```bash
pnpm format      # rewrite
pnpm lint:fix    # the same, plus safe lint fixes
```

---

## 4. The required workflow

**Every change goes through a branch and a pull request.** Direct pushes to
`main` are refused by the repository ruleset — including for the owner.

```
main (current)
  ├─ git switch -c <prefix>/<topic>
  ├─ commit
  ├─ git push -u origin <prefix>/<topic>
  ├─ gh pr create --fill --base main
  ├─ gh pr checks <n> --watch
  └─ gh pr merge <n> --squash --delete-branch
```

Branch prefixes: `diag/<topic>`, `fix/<topic>`, `hardening/<topic>`,
`test/<topic>`, `live/<scenario>`, `docs/<topic>`.

A PR cannot merge until all four required status checks are green:

- `Typecheck and lint`
- `Unit and integration tests`
- `Build and verify artifact`
- `Browser tests`

Squash merge only. The PR title and body become the commit message on `main`, so
write them as the commit message you want.

The full rules — the ruleset, its id, the merge settings and the `gh` commands
that inspect them — are in
[`docs/development/GITHUB_WORKFLOW.md`](docs/development/GITHUB_WORKFLOW.md).

---

## 5. Privacy requirements

**This is the most important section in this document. The repository is public.**

JobPilot handles a real person's resume, a real person's conversations and a real
person's session. A contribution that puts any of that into the repository is a
disclosure, and it is in a public git history permanently — deleting the file in
a later commit does not remove it.

### Never commit any of these

| Never commit | Examples |
|---|---|
| **Diagnostic bundles** | `*.diagnostic.zip`, `*.diag.zip`, anything from `test-results/` |
| **Real page captures** | Saved BOSS HTML, `outerHTML` dumps, screenshots of a logged-in page |
| **Cookies, tokens, session identifiers** | `Cookie:`, `Authorization: Bearer …`, `sessionid=…`, CSRF values |
| **Real resume or chat content** | Resume text, recruiter messages, drafts, conversation exports |
| **Personal identifiers** | User ids, phone numbers, national id numbers, email addresses, real names, real company names where they identify a person |
| **Local absolute paths** | `C:\Users\<name>\…`, `/home/<name>/…` |

`*.diagnostic.zip`, `*.diag.zip`, `test-results/live/`, `diagnostic-analysis/`
and `artifacts/live-test/*/*.zip` are gitignored. **The gitignore is a backstop,
not permission.** It will not catch a renamed file, a pasted HTML blob or a
screenshot.

### What may be committed

Only **sanitized, minimal fixtures** under:

```
tests/fixtures/boss/regression/<issue-id>/
```

### The rule

> **Reduce the failing evidence to the minimum that reproduces it, then sanitize
> it, then commit only that.**

All three steps, in that order:

1. **Reduce.** From the bundle's DOM and selector diagnostics, extract the single
   structural fact that broke — the element, its attributes, its ancestry, the
   selector that missed. Not the page. Not the flow. The one fact.
2. **Sanitize.** Remove everything in the never-commit list above. Replace
   identifying text with neutral placeholders that preserve the *shape* the
   selector depends on.
3. **Commit only that.** If you are unsure whether a fixture is minimal enough,
   it is not. Reduce it further or keep it out of the repository.

A fixture that would be a disclosure if it leaked is a fixture that should not
exist. The regression test needs the structure, not the content.

### Bundle handling

- **A bundle is private evidence.** Export it, keep it locally, analyse it
  locally.
- **Never attach a bundle to a public issue or a public PR.** Not as a
  reproduction, not "just the small one".
- If a maintainer needs a bundle to diagnose something, attach it to a **private
  security advisory** — see [`SECURITY.md`](SECURITY.md) §4 — and review it
  yourself first.
- A bundle is designed to be safe to share with a developer, and a CI gate
  asserts that. It is still evidence from a real account, so treat it as
  sensitive until you have looked at it.

---

## 6. Fixture sanitization guidance

Fixtures live in `tests/fixtures/boss/*.html` and, for regression cases tied to a
reported issue, in `tests/fixtures/boss/regression/<issue-id>/`.

**Strip, always:**

- recruiter names and recruiter profile links;
- real company names, where the company is identifiable;
- message text, draft text and any conversation content;
- ids — job ids, user ids, conversation ids, message ids;
- avatars, image URLs, tracking parameters;
- anything not required to reproduce the structural failure.

**Keep, always:**

- the element hierarchy the selector depends on;
- the attributes the selector matches — `data-*` (especially `data-jobpilot-*`),
  class names that are part of the contract, `role`, `aria-*`;
- the ambiguity or absence that caused the failure. If the bug is that two
  elements matched where one was required, the fixture must still contain two.

**Replace identifying text with placeholders that preserve shape.** A selector
that depends on a label being present needs *a* label, not the real one.

**Give every element you intend to match a `data-jobpilot-*` hook** in
hand-authored fixtures. That is what makes a selector `fixture-only` rather than
`unverified`: the fixture asserts JobPilot's own contract rather than imitating a
real class name.

**Register the fixture.** Add the file name to `KNOWN_FIXTURES` in
`tests/browser/harness.ts` (for the smoke test) and to the `BossFixture` union in
`tests/integration/boss-harness.ts` if an integration test uses it.

---

## 7. Test requirements

Choose the cheapest layer that can genuinely observe the behaviour. The full
guide is [`docs/development.md`](docs/development.md) §6.

| Layer | Required for | Location |
|---|---|---|
| **Unit** | Domain and application logic — rules, scoring, parsers, reducer transitions, migrations, gates, the queue | `tests/unit/`, mirroring the source path |
| **Integration** | The BOSS adapter, against local fixtures | `tests/integration/`, using `boss-harness.ts` |
| **Browser** | Behaviour that depends on the built bundle in a real browser — mounting, shadow-DOM isolation, fail-closed guarantees | `tests/browser/` |

**Unit tests are required for domain and application logic.** A rule, a scoring
change, a reducer transition or a gate has unit tests or it does not land.

**Integration tests for the BOSS adapter run against local fixtures only.** Use
`tests/integration/boss-harness.ts` rather than constructing a DOM by hand — it
handles the happy-dom quirks documented in its header.

**Browser tests must use local fixtures only.** The suite drives a loopback
fixture server on `127.0.0.1:43117`, served as `http://www.zhipin.com:43117` with
a host-resolver rule mapping the name to loopback, so the production host guard
runs unmodified and no packet leaves the machine. `tests/browser/fixture-smoke.spec.ts`
**fails the suite** if any request targets a non-loopback host. Never add a step
that reaches the real site.

### Two rules that are not negotiable

**Do not modify `src/` to make a test pass.** If a production guard blocks a test,
set up the test environment to satisfy the guard — as the host mapping already
does. Weakening the guard to make the test green removes the thing the guard
exists to protect.

**A fix ships with the regression test that fails without it.** The test stays in
the suite. A defect fixed without a test will come back.

---

## 8. Hard rules

These are constraints, not conventions. A PR that weakens any of them will be
rejected, regardless of what it fixes.

| Rule | Detail |
|---|---|
| **No CAPTCHA bypass** | On a CAPTCHA or security-verification page JobPilot stops. No code path solves, dismisses, retries through or navigates around a verification page. No interaction with verification widgets |
| **No anti-bot circumvention** | No spoofed headers, no identifier rotation, no defeating rate limiting or detection. Risk-control and rate-limit responses are blocking states |
| **No fingerprint spoofing** | No fingerprint spoofing and no browser fingerprinting |
| **No telemetry** | `telemetryEnabled` is hard-defaulted to `false` and no code path turns it on. Nothing is transmitted anywhere |
| **No remote code loading** | The artifact is self-contained. `pnpm verify:dist` fails on `@require`, `@resource` or `eval(` |
| **No weakening a safety invariant** | The invariants in `src/application/gates.ts` are the reason a duplicate send or a send into the wrong conversation cannot happen. They are not configurable and not negotiable |
| **No diagnostics sink outside the recorder** | The recorder is where write-time redaction happens. A parallel logger or export path bypasses it. The recorder is the single sink |
| **Fail closed** | An unrecognised page is `unknown`, not a guess. An unmatched selector is a miss with a reason, not a text-based fallback. A partial parse throws rather than returning partial data as complete |
| **No optimistic outcome** | Absent confirmation is `needs-confirmation`, never `submitted`. A clicked button is never evidence of a send. `uncertain` is never rounded to success or to failure, and is never auto-retried |

If your change needs an exception to any of these, the answer is no — but say so
in the PR, and describe what you were trying to achieve. There is usually a way
to get there without weakening the invariant.

---

## 9. Diagnostic bundles

- **A bundle is private evidence.** It is produced by the diagnostic build
  (`pnpm build:diagnostic`), exported from the panel, and analysed locally with
  `pnpm diag:analyze <bundle.zip>`.
- **Bundles are never attached to public issues or PRs.** They are gitignored,
  and the gitignore is a backstop rather than permission. See §5.
- **Redaction happens at write time**, in the recorder — values are sanitized
  before they enter any buffer. A digest is recorded in place of content, so "did
  this change between runs?" stays answerable without the content. The full
  policy is in [`docs/diagnostics/PRIVACY.md`](docs/diagnostics/PRIVACY.md).
- **What a contribution may carry forward from a bundle** is a *sanitized
  fixture* (§6), never the bundle.
- **If a bundle contains something it should not**, that is a defect in the
  redaction policy. Do not share it and do not edit the archive — report which
  field and which file. The fix is a new redaction rule plus a new assertion in
  the privacy test.

---

## 10. Reporting a security or privacy issue

Do not open a public issue. Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/jacek4yang/jobpilot/security/advisories/new)**.

The full policy — scope, what must never be posted, supported versions — is in
[`SECURITY.md`](SECURITY.md).

---

## 11. Related documents

| Document | Covers |
|---|---|
| [`SECURITY.md`](SECURITY.md) | Reporting, what must never be posted, supported versions |
| [`docs/development/GITHUB_WORKFLOW.md`](docs/development/GITHUB_WORKFLOW.md) | The ruleset, required checks, branch names, the merge flow |
| [`docs/development.md`](docs/development.md) | Every script, adding a rule, adding an adapter, adding a test, the fixture workflow |
| [`docs/diagnostics/PRIVACY.md`](docs/diagnostics/PRIVACY.md) | What diagnostics record and never record, and how that is enforced in code |
| [`docs/live-testing/RUNBOOK.md`](docs/live-testing/RUNBOOK.md) | The live-scenario procedure |
| [`docs/live-testing/TEST_MATRIX.md`](docs/live-testing/TEST_MATRIX.md) | The staged live-scenario matrix |
| [`docs/boss-adapter.md`](docs/boss-adapter.md) | The BOSS adapter and the selector confidence vocabulary |

---

## License

MIT. By contributing, you agree your contribution is licensed under the same
terms.
