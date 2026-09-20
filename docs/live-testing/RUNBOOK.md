# Live-testing runbook

The operational procedure for exercising JobPilot against a live BOSS Zhipin
session.

> **Read this before you start: nothing in this runbook has been executed.**
> No JobPilot build has been run against the real BOSS site. The selectors are
> `fixture-only` or `unverified` (there is no `verified` value in the confidence
> type), and `BOSS_METADATA.automationVerified` is the literal `false`. This
> runbook describes the procedure **you would follow to begin verifying it**. It
> is not a report of results.

The loop this runbook implements:

```
build diagnostic build
  -> install ONLY the diagnostic build
  -> open BOSS
  -> start a named session
  -> perform exactly the listed steps for one scenario
  -> stop immediately on unexpected behaviour
  -> Finish Test & Export
  -> file the ZIP under the results directory
  -> run the analyzer
  -> read the report
  -> reproduce with a fixture
  -> fix root cause
  -> add regression test
  -> run all gates
  -> repeat the SAME scenario
  -> only advance once it passes twice
```

---

## 0. Before you begin — prerequisites and preconditions

1. **Node `^20.19.0 || >=22.12.0`** and **pnpm 11** (`packageManager` pins
   `pnpm@11.9.0`).
2. `pnpm install` has been run.
3. `pnpm check` passes on the commit you are about to test. Do not start a live
   test on a commit that does not pass its own gates — you will not be able to
   tell a product failure from a broken build.
4. A userscript manager (Tampermonkey or Violentmonkey) is installed.
5. **The production build is not installed, and no other JobPilot copy is
   enabled.** Two copies driving one page is a duplicate-send risk. Verify this
   before every run.
6. You know which scenario ID you are running, and you have read its row in
   [`TEST_MATRIX.md`](./TEST_MATRIX.md). If the row says the scenario requires the
   previous scenario to have passed twice, confirm that it has.
7. You have a browser profile you are willing to use for testing, and a BOSS
   session you are willing to log into **by hand**.

**Do not start if any of these is false.** A run started from the wrong
preconditions produces a bundle that cannot be attributed to a scenario.

---

## 1. Build the diagnostic build

```bash
pnpm build:diagnostic
```

This writes `dist/jobpilot.diagnostic.user.js`. It is a standalone userscript
with no CDN runtime dependency.

To confirm the artifact is installable and safe to ship, and that its grants and
matches have not grown beyond the least-privilege set:

```bash
pnpm verify:diagnostic
```

The diagnostic build differs from production in exactly these ways, and no
others:

| Aspect | production | diagnostic |
|---|---|---|
| `__JOBPILOT_CHANNEL__` | `"production"` | `"diagnostic"` |
| minify | yes | yes |
| event buffer | 500 | 20 000 |
| `trace` level | discarded | recorded |
| bundle export | menu command, minimal | full support bundle |
| diagnostics tab | hidden | shown |

**Safety behaviour is identical in both channels.** Diagnostic mode observes
more; it does not behave less safely. This is asserted by a test that channel
selection does not alter any guard, timeout or mode default.

1. Confirm the build produced the file:

   ```bash
   ls -l dist/jobpilot.diagnostic.user.js
   ```

2. Record the build identity you are testing. You will need it for the run
   directory name and to prove which artefact produced a bundle:

   ```bash
   git rev-parse HEAD
   ```

   If git is unavailable, the build records `gitCommit: "unknown"` in its
   `BuildInfo`. That value is never faked; record `unknown` and move on.

---

## 2. Install ONLY the diagnostic build

1. Open the userscript manager's dashboard.
2. **Disable or remove any existing JobPilot script**, production or otherwise.
3. Create a new script, clear the template, and paste the contents of
   `dist/jobpilot.diagnostic.user.js`. Save.
4. Confirm the diagnostic build is the only JobPilot script enabled. The
   diagnostics tab only appears on the diagnostic channel, so its presence is
   your confirmation.
5. Reload a `zhipin.com` tab and confirm the panel mounts.

---

## 3. Open BOSS and start a named session

1. Navigate to `https://www.zhipin.com/` and **log in by hand**. JobPilot never
   logs in for you and has no credentials.
2. Open the JobPilot panel and go to the **Diagnostics** tab.
3. **Start a named session.** Enter the scenario ID exactly as written in
   [`TEST_MATRIX.md`](./TEST_MATRIX.md) (e.g. `T44`) and a short scenario name.
   The session ID is stamped onto every event, transition, snapshot, DOM
   diagnostic and onto the bundle filename.
4. Confirm the panel shows the session as running before you do anything else.

**A session is started deliberately, never on page load.** If you skip this step,
your events are recorded under the synthetic `pre-session` id and the analyzer
cannot attribute a failure to a scenario. A bundle with `sessionId:
"pre-session"` is a run that must be repeated.

> Events recorded *before* the session starts are still kept — a crash during
> startup is captured — but they are not part of your scenario.

---

## 4. Perform exactly the listed steps

Do only what the scenario row says. Nothing extra.

- Do not explore. Do not "just check" another page. Every action you take lands
  in the bundle and makes the timeline harder to attribute.
- Keep a note of the **wall-clock time** of each step. It makes the first
  divergence obvious when you read the report.
- Take one action at a time and let the page settle before the next.
- If a step produces a behaviour the row's **Expected** column does not
  describe, **stop** — go to §5.

For Stage 4 and later, the matrix marks the point at which you must stop before
an irreversible action. Respect it: the goal of this phase is to observe, not to
send. **No live BOSS communication is performed during this phase** unless the
scenario is explicitly a Stage 6 send scenario and every precondition in the
"Definition of ready" checklist in [`TEST_MATRIX.md`](./TEST_MATRIX.md) is
satisfied.

---

## 5. Stop immediately on unexpected behaviour

The moment anything below happens, **stop the scenario**. Do not retry, do not
work around it, do not continue to the next step to "see if it recovers".

Stop conditions:

- a **CAPTCHA** or security-verification page appears;
- an **unexpected modal** appears — any dialog the scenario does not name;
- a **send outcome is ambiguous** in any way;
- storage health is reported **`DEGRADED_READ_ONLY`**;
- the panel shows a state you cannot explain from the scenario row;
- JobPilot clicks, types or navigates somewhere the row's **Forbidden** column
  lists;
- the page stops responding to the scenario's next intended action (a stall).

On any of these:

1. Stop interacting with the page.
2. Note the wall-clock time and what you saw.
3. In the panel, set the session status to reflect reality: `blocked` if JobPilot
   stopped itself, `failed` if it did something wrong, `aborted` if you stopped
   it. If it was a clean pass, use `completed`.
4. Go to §6 and export.

**Never discard diagnostic memory.** The evidence for a failure is the whole
reason the run happened. Even a scenario you aborted on purpose produces a bundle
worth keeping.

---

## 6. Finish Test & Export

1. In the panel, finish the session with the correct status (§5 step 3).
2. Run **Finish Test & Export**.
3. Watch for the destination:
   - **Preferred:** you are asked to pick a directory. JobPilot writes the bundle
     under a dated, scenario-scoped path inside the root you grant. It never
     writes outside that root, and it never claims filesystem access it does not
     have.
   - **Fallback:** a normal browser download, with the deterministic filename
     shown in the panel.
4. **Copy the exact filename** the panel shows. You are told the name precisely
   so that a mismatch is obvious — a filename that does not match is a sign the
   wrong bundle was filed.

Expected filename shape (see
[`../diagnostics/BUNDLE_FORMAT.md`](../diagnostics/BUNDLE_FORMAT.md) §7):

```
jobpilot-diag_T44_s20260921T101530-3f9a01_20260921T101800Z_0.1.0-unknown.zip
```

### If the export fails

Work through these in order. **Do not close the tab** at any point until you have
your evidence out.

1. **Retry the export.** Transient failures happen — a permissions prompt
   dismissed, a directory handle revoked. Retry once from the panel.
2. If the destination picker is the problem, choose the **fallback download**
   path instead.
3. If the bundle export still fails, use the **raw JSON emergency export**. It
   writes the underlying sections as plain JSON/dumps rather than a ZIP, and it
   does not depend on the ZIP writer or on a directory grant. It is less
   convenient to analyse, but it preserves the evidence.
4. If *that* fails, **do not reload the page and do not close the tab.** Copy
   what the panel shows by hand, note the session ID, and treat the run as a
   diagnostics failure — file it as such.
5. Under no circumstances discard diagnostic memory to "clean up" or to try
   again from a fresh page. A lost bundle cannot be reconstructed.

### File the ZIP

Create the run directory and move the bundle into it:

```
test-results/live/<YYYY-MM-DD>/<Txx-name>/run-<NNN>/
```

- `<YYYY-MM-DD>` is the **local** date you ran the test — the date your calendar
  shows, which is why `localDateDirectory` uses local time rather than UTC.
- `<Txx-name>` is the scenario ID and a short slug, e.g. `T44-chat-identity`.
- `run-<NNN>` is zero-padded and increments per attempt at that scenario on that
  day. Run 001, 002, 003 — one directory per attempt, **never overwritten**.

A worked example:

```
test-results/live/2026-09-21/T44-chat-identity/run-001/
└── jobpilot-diag_T44_s20260921T101530-3f9a01_20260921T101800Z_0.1.0-unknown.zip
```

Alongside the ZIP, write a short `notes.md` in the same run directory: the
scenario ID, the build commit, the session ID, the wall-clock times of each step,
what you expected, what happened, and whether you stopped early and why. The
bundle says what happened; only you can say what you were trying to do.

---

## 7. Gitignore rule for results

- **`test-results/` is gitignored.** Never commit it.
- **Real session bundles are never committed.** They contain route history,
  timings and configuration from a real account.
- **Only sanitized, minimal fixtures may be committed** — a hand-authored
  snippet that reproduces one structural fact (a selector miss, an unexpected
  DOM shape), with all account-specific, personal and identifying content
  removed. Fixtures under `tests/fixtures/boss/` follow this rule today.
- If you are unsure whether a fixture is minimal enough, it is not. Reduce it
  further or keep it out of the repository.

---

## 8. Run the analyzer

> **Script aliases.** The commands below are the analyzer's specified interface
> (`ARCHITECTURE.md` §14). If `pnpm diag:analyze` is not yet registered in
> `package.json` on your build, run the underlying script directly:
> `pnpm tsx scripts/analyze-bundle.ts <bundle.zip>`. Do not invent an equivalent
> command — if the alias is missing, say so rather than substituting a tool that
> produces a different report.

```bash
pnpm diag:analyze test-results/live/2026-09-21/T44-chat-identity/run-001/jobpilot-diag_T44_....zip
```

The analyzer validates the schema, verifies checksums, then reconstructs the
event timeline, the state transitions, the queue lifecycle and each communication
transaction, and summarises selector misses, timeouts, retries, route changes,
storage problems and lock problems. It identifies the **first divergence** and any
invariant violation.

Output:

```
diagnostic-analysis/<session-id>/
├── report.md
├── timeline.md
├── selector-report.md
├── transaction-report.md
└── machine-summary.json
```

The analyzer **labels every finding `confirmed`, `likely` or `unknown`** with
evidence references, and does not invent a diagnosis when the evidence is thin.
Take that labelling seriously — see
[`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md) for what each label means and what to
do about it.

To compare against a previous attempt at the same scenario:

```bash
pnpm diag:compare <a.zip> <b.zip>
```

> **`diag:compare` is specified but not yet implemented** on this build. In the
> meantime, compare two runs by reading `machine-summary.json` from each
> `diagnostic-analysis/<session-id>/` directory side by side. Do not treat a
> comparison you performed by hand as equivalent to the tool's output — record it
> as manual.

`compare` is specified to answer the iteration questions: did the selector
failure disappear, did the workflow progress further, did a new failure appear,
did timing regress.

To sanity-check the analyzer itself:

```bash
pnpm diag:selftest
```

---

## 9. Read the report

Read in this order:

1. **`summary.txt`** inside the ZIP. It is the entry point and answers "what went
   wrong" without opening the event log. Version, commit, scenario, session,
   final status and state, route, current job, queue counts, transaction status,
   fatal error, first important failure, whether human verification was hit,
   storage health, lock owner, event and snapshot counts.
2. **`report.md`** — the analyzer's narrative, with the first divergence and any
   invariant violation.
3. **`timeline.md`** — the ordered event stream. Use `sequence`, not timestamps.
4. **`selector-report.md`** — if the failure is a selector miss or ambiguity.
5. **`transaction-report.md`** — if the failure involves a communication.

Then go to [`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md) and match your symptom to a
failure class. It tells you which file to open first for each class.

---

## 10. Reproduce with a fixture

Before changing any code, reproduce the failure **offline**.

1. From the bundle's DOM and selector diagnostics, extract the minimal structural
   fact that broke — the element, its attributes, its ancestry, the selector that
   missed.
2. Add a minimal, sanitized fixture under `tests/fixtures/boss/` that captures
   **only** that fact. No real names, no account data, no conversation content.
3. Write a failing test that uses the fixture.

A failure you cannot reproduce from a fixture is a failure you cannot prove you
fixed. If you genuinely cannot reproduce it, say so explicitly and keep the
bundle — a non-reproducible failure is itself a finding, and it belongs in the
report rather than in a speculative fix.

---

## 11. Fix root cause, then add a regression test

1. Fix the **root cause**, in the module that is actually wrong. Do not patch the
   symptom at the call site.
2. Keep the domain pure: adapters implement ports, the domain knows nothing about
   the DOM, storage or the browser. If a selector is wrong, fix the selector
   registry entry; do not add a text-based fallback — JobPilot fails closed and an
   unmatched apply button is `selector-missing` with no fallback, by design.
3. Promote nothing to "verified" on the strength of one passing run. Selector
   confidence is raised on cited evidence, not optimism.
4. Turn the fixture test from §10 into a **regression test** that fails without
   your fix and passes with it. It stays in the suite.

---

## 12. Run all gates

```bash
pnpm check
```

which runs, in order: `typecheck`, `lint`, `test`, `build`, `verify:dist`,
`build:diagnostic`, `verify:diagnostic`.

Individually, if you need to isolate a failure:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:dist
pnpm build:diagnostic
pnpm verify:diagnostic
```

A live test is not finished until every gate passes **and** you have verified
your fix against the same scenario live. If a gate fails, fix it before
re-running the scenario — a red build makes the next bundle uninterpretable.

The browser suite requires a build first and never touches the live site:

```bash
pnpm build
pnpm test:browser
```

It runs against a loopback fixture server on `127.0.0.1:43117`, served as
`http://www.zhipin.com:43117` with a host-resolver rule mapping the name to
loopback, so the production host guard runs unmodified and no packet leaves the
machine. A request listener fails the suite if any request targets a non-loopback
host.

---

## 13. Repeat the same scenario, then advance

1. **Repeat the identical scenario** from §1. Same build, same steps, same
   preconditions. File it as `run-002`.
2. Compare:

   ```bash
   pnpm diag:compare run-001/….zip run-002/….zip
   ```

3. **Only advance to the next scenario once the current one has passed twice**
   from a clean build — see the repetition rule in
   [`TEST_MATRIX.md`](./TEST_MATRIX.md).

**If a scenario fails, every later higher-risk stage is blocked.** For example:
if `T44` fails, `T60` (the first real send) must not run — see
[`TEST_MATRIX.md`](./TEST_MATRIX.md) §Progression rules. There is no exception
for "I just want to see if sending works".

---

## 14. Stop conditions, collected

Stop the run immediately — do not continue, do not retry, do not work around —
if any of these occurs:

- CAPTCHA or security verification appears.
- An unexpected modal appears.
- A send outcome is ambiguous in any way.
- Storage health is `DEGRADED_READ_ONLY`.
- The page appears to block or stall silently.
- JobPilot does anything the scenario row lists as forbidden.
- You are unsure whether the last action had an effect.

When you stop: record the wall-clock time, set the session status honestly, and
export (§6). A stopped run with a bundle is evidence. A continued run without one
is nothing.
