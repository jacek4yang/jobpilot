# Live-testing progress

The tracking table for live-scenario execution against BOSS Zhipin.

> **The table is currently EMPTY, and that is the correct initial state.**
> No live scenario has been run. No JobPilot build has been executed against the
> real BOSS Zhipin site. This is not a gap in this document — it is the accurate
> record of where the project is.
>
> Every row in [`TEST_MATRIX.md`](./TEST_MATRIX.md) is a **plan**. The first row
> to execute is T00. Until a scenario has been run, recorded and triaged, it does
> not appear below.

Read [`RUNBOOK.md`](./RUNBOOK.md) before executing any scenario, and read the
scenario's own row in [`TEST_MATRIX.md`](./TEST_MATRIX.md) for its preconditions,
operator actions, expected result, forbidden behaviour and pass criteria.

---

## 1. Progress table

| Scenario | Commit | Run | Result | Session ID (sanitized) | Root-cause class | Fix PR | Regression test | Repeats required | Next unlocked |
|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — |

**No rows.** The first entry will be T00 — see §5.

### Column definitions

| Column | Holds |
|---|---|
| `Scenario` | The scenario id from [`TEST_MATRIX.md`](./TEST_MATRIX.md), e.g. `T00`. One row per **run**, not per scenario — a scenario run twice has two rows |
| `Commit` | The full 40-character commit the build under test was produced from (`git rev-parse HEAD`), or `unknown` if the build recorded `gitCommit: "unknown"`. Never guess, never abbreviate to something ambiguous |
| `Run` | The run directory index from the runbook: `run-001`, `run-002`, … Zero-padded, never reused, never overwritten |
| `Result` | One of the four values in §3 |
| `Session ID (sanitized)` | The session id from the bundle manifest. Sanitize per §6 — the parts of a session id that encode a scenario and a timestamp, never anything account-specific |
| `Root-cause class` | One of the classes in §4. `N/A` for a clean pass |
| `Fix PR` | The PR number that fixed the root cause, linked as `#123`. `—` if no fix was needed |
| `Regression test` | The path of the regression test that fails without the fix, e.g. `tests/integration/boss-parser.test.ts`. `—` if no fix was needed |
| `Repeats required` | How many further consecutive passes are needed before the scenario may be marked `STABLE` — see §7. A `critical` row needs two passes after its final fix |
| `Next unlocked` | The scenario id that becomes runnable once this row satisfies the progression rule, or `blocked` if this row's result blocks it |

---

## 2. How to add a row

1. Confirm the scenario's `Next allowed` precondition in
   [`TEST_MATRIX.md`](./TEST_MATRIX.md) is satisfied. A row may only run if its
   predecessor has passed the required number of times.
2. Run the scenario per [`RUNBOOK.md`](./RUNBOOK.md).
3. File the bundle under `test-results/live/<YYYY-MM-DD>/<Txx-name>/run-<NNN>/`
   and write `notes.md` alongside it. `test-results/` is gitignored — the bundle
   stays local.
4. Append one row here, with the metadata only. See §6 for what may and may not
   appear.
5. If the result is `FAIL` or `BLOCKED`, go to
   [`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md) and match the symptom to a failure
   class before changing any code.

Add rows in execution order. Do not reorder, and do not delete a row — a failed
run is the evidence that the fix was needed.

---

## 3. Legend — `Result` values

| Value | Means |
|---|---|
| `PASS` | The scenario's **Pass** criteria in the matrix were met in full, **and** nothing in its **Forbidden** column occurred, **and** the required evidence is present in the bundle. A pass that also broke a forbidden rule is a `FAIL` |
| `FAIL` | The scenario ran and the observed behaviour did not match the expected result — the pass criteria were not met, or something in the forbidden column happened. Requires triage and a fix |
| `BLOCKED` | The scenario could not be completed, and the cause is external to JobPilot's correctness — a CAPTCHA appeared, login was required, a rate limit fired, storage went unhealthy, or the operator stopped the run. **A `BLOCKED` with evidence is progress**, not a failure to report |
| `NOT RUN` | The scenario has not been attempted. This is the default state and the state of every row in the matrix today |

Note the distinction between `FAIL` and `BLOCKED`. A CAPTCHA is `BLOCKED`: JobPilot
detecting it and stopping is the scenario working. A CAPTCHA is `FAIL` only if
JobPilot did something other than stop.

**A `BLOCKED` scenario still blocks everything after it** until it is re-run and
passes. "Blocked" describes why the run stopped, not whether it counts.

---

## 4. Legend — root-cause classes

Assigned from the bundle after triage. Match the symptom in
[`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md) before assigning one.

| Class | Means | Typical fix |
|---|---|---|
| `PRODUCT_BUG` | JobPilot's own logic is wrong. The evidence shows a decision, a gate or a state transition contradicting the specification | Fix the module that is wrong, not the call site. Add a regression test asserting the invariant |
| `SELECTOR_DRIFT` | A selector that previously matched no longer does — the site changed, or the selector was promoted on evidence that has since expired | Fix the selector registry entry. Do not add a text-based fallback. Confidence is raised only on cited evidence |
| `DOM_CHANGE` | The page structure differs from what was assumed — an unexpected layout, a nested or iframed detail, a re-render mid-flow | Establish miss vs. ambiguity first; they have different fixes. Fails closed |
| `EXPECTED_BLOCK` | A deliberate, correct stop: CAPTCHA, security verification, login required, operation-too-frequent, an unknown modal, or storage `DEGRADED_READ_ONLY` | No code change. Confirm zero action events in the window and record the pass |
| `TEST_ENVIRONMENT` | The failure is in the harness, the fixture server, the browser profile or the toolchain — not in JobPilot | Fix the environment, then re-run. Do not "fix" `src/` to satisfy a broken environment |
| `USER_INTERRUPTION` | The operator changed something mid-scenario — switched a conversation, typed into the editor, navigated away | Usually a legitimate pass: the expected behaviour is a clean abort with the user's content intact. Confirm the abort direction was correct |
| `INSUFFICIENT_EVIDENCE` | The bundle does not say what happened. The relevant window was truncated, a section is missing, or an expected event is absent entirely | **Do not guess.** Record the gap, improve the diagnostics, re-run. This is a finding about the diagnostics |
| `UNKNOWN` | The failure is real and reproducible, but the cause is not yet determined | Keep the bundle. Investigate further. Do not round to a plausible class |

`FAILURE_TRIAGE.md` labels individual findings `confirmed`, `likely` or `unknown`.
Those are evidence-quality labels; the classes above are failure-category labels.
Both apply, and they answer different questions.

---

## 5. The first scenario: T00

Taken from [`TEST_MATRIX.md`](./TEST_MATRIX.md) §Stage 0. Read the row there
before running it — this is a summary.

| Field | Value |
|---|---|
| **ID** | T00 |
| **Name** | Install the diagnostic build and confirm the channel |
| **Stage** | 0 — Installation and observation |
| **Risk** | low |
| **Preconditions** | `pnpm build:diagnostic` succeeded; no other JobPilot script is enabled |
| **Operator actions** | Paste `dist/jobpilot.diagnostic.user.js` into the userscript manager; save; reload a `zhipin.com` tab |
| **Expected** | The script installs; exactly one JobPilot script is enabled; the Diagnostics tab is present, which only the diagnostic channel shows |
| **Pass** | Channel is `diagnostic`; the recorded commit matches the build you recorded; only one script is enabled |
| **Forbidden** | Any other JobPilot copy remaining enabled; a production build present; two JobPilot scripts running |
| **Evidence** | `manifest.json` shows `channel: "diagnostic"`, `bundleFormatVersion: 1`; `build.json` matches the recorded commit |
| **Bundle** | required |
| **Next allowed** | T01 |

Why this one first: it is the cheapest possible check that the artifact under
test is the artifact you think it is. Every later bundle's `manifest.json` is
only attributable to a build if this has been confirmed. A run whose manifest
says `channel: "production"`, or whose `build.json` names a different commit, is
void — and finding that out at T00 costs one reload instead of a full scenario.

Record the commit **before** installing:

```bash
git rev-parse HEAD
```

If git is unavailable the build records `gitCommit: "unknown"`. That value is
never faked; record `unknown` in the `Commit` column and move on.

---

## 6. Hard rule — this file is in a PUBLIC repository

`docs/live-testing/PROGRESS.md` is committed. The repository is public.

**This document must contain ONLY safe metadata.** Specifically, never write into
it:

| Never | Why |
|---|---|
| **Real company names** | Identifies a specific posting and, by inference, a specific employer's interaction |
| **Recruiter names, titles, profile links** | Third-party personal data |
| **Message content** | A two-party private conversation, in any form, including a short "example" |
| **URLs containing identifiers** | Job ids, user ids, conversation ids — a URL is a link back to an account |
| **Job titles that identify a specific posting** | Combine with a timestamp and they identify an employer's interaction |
| **Session identifiers, cookies, tokens** | Session ids in a bundle are already opaque; do not paste anything else |
| **Personal data of any kind** | Names, contact details, account identifiers, resume fragments |
| **Local absolute paths** | `C:\Users\<name>\…` discloses a name and a machine layout |
| **Screenshots of a logged-in page** | Every pixel is a potential disclosure |

**The `Session ID (sanitized)` column is sanitized.** Record only the scenario id
and the timestamp part — the parts that make a run identifiable within this
table. Do not paste a raw session id if it carries anything account-derived.

The bundle itself never comes here. It goes to
`test-results/live/<YYYY-MM-DD>/<Txx-name>/run-<NNN>/`, which is gitignored. See
[`RUNBOOK.md`](./RUNBOOK.md) §6–§7 and [`../../SECURITY.md`](../../SECURITY.md) §3.

**If a row cannot be written without one of the above, the row does not get
written.** Reduce it to a scenario id, a commit and a result.

---

## 7. Progression rule

Straight from [`TEST_MATRIX.md`](./TEST_MATRIX.md) §Progression rules. These are
not advisory.

```
Stage 0  ->  Stage 1  ->  Stage 2  ->  Stage 3
                                        |
                                        v
                                    Stage 4  ->  Stage 5  ->  Stage 6
                                                                |
                                                                v
                                     Stage 10 <- Stage 9 <- Stage 8 <- Stage 7
```

1. **One scenario at a time.** A row may only run if its `Next allowed`
   precondition is satisfied. The rows are not independent; `Next allowed` is the
   dependency edge.
2. **A failed scenario blocks all later higher-risk stages.** You may not work
   around a failure to reach a more interesting row. There is no exception for "I
   just want to see if sending works".
3. **Critical scenarios must pass twice after their final fix before being marked
   stable.** One pass is an anecdote. The two passes must be on the **same
   build**, from a clean build, each filed as a separate run directory, with a
   bundle for each.
4. **Lower-risk rows in the same stage may continue** if the failure does not
   invalidate their preconditions. Higher-risk stages never may.
5. **If T44 (chat identity verification) fails, T60 must not run.** Identity
   verification is the gate that prevents sending into the wrong conversation.
   Proceeding to a real send with a known-broken identity check is exactly the
   failure the whole safety model exists to prevent.
6. **If a Stage 7 interruption row fails, Stages 8–10 are blocked.** An
   interruption bug around the send boundary is a duplicate-send bug.
7. **A blocked stage is legitimate.** Record it, export the bundle, and go to
   [`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md). A stage blocked with evidence is
   progress; a stage skipped without one is not.
8. **A regression returns a scenario to `UNSTABLE`** and restarts the two-pass
   count.

The `Repeats required` column tracks requirement 3 per row. It reaches `0` only
after two consecutive passes on the same build with nothing forbidden and no new
failure introduced by `pnpm diag:compare`.

---

## 8. Current state

| | |
|---|---|
| Scenarios run | **0** |
| Scenarios passed | 0 |
| Scenarios failed | 0 |
| Scenarios blocked | 0 |
| Stages complete | none |
| Next scenario to run | **T00 — Install the diagnostic build** |
| Live sends performed | **0** |

**No live-site verification has occurred.** The BOSS adapter has never been run
against the real BOSS Zhipin DOM. Every selector remains `fixture-only` or
`unverified`, and `BOSS_METADATA.automationVerified` is the literal `false`. This
document does not change that, and nothing should be added to it that suggests
otherwise until there is a row to prove it.

---

## 9. Related documents

| Document | Covers |
|---|---|
| [`TEST_MATRIX.md`](./TEST_MATRIX.md) | The scenario rows: preconditions, expected, forbidden, pass, evidence |
| [`RUNBOOK.md`](./RUNBOOK.md) | The procedure: build, install, session, export, analyze, fix, repeat |
| [`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md) | Mapping a bundle to a failure class and a diagnosis |
| [`../diagnostics/PRIVACY.md`](../diagnostics/PRIVACY.md) | What diagnostics record and never record |
| [`../diagnostics/BUNDLE_FORMAT.md`](../diagnostics/BUNDLE_FORMAT.md) | The bundle archive, its files and its checksums |
| [`../../SECURITY.md`](../../SECURITY.md) | What must never be posted publicly |
