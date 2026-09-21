# GitHub workflow

The repository configuration that governs every change to JobPilot, and the
commands that produce and inspect it.

This documents the **actual** configured state of
[`jacek4yang/jobpilot`](https://github.com/jacek4yang/jobpilot). Every rule id,
status-check context and setting below was read back from the GitHub API, not
transcribed from intent. If you change one, update this file in the same PR.

---

## 1. Repository

| Property | Value |
|---|---|
| Repository | `jacek4yang/jobpilot` |
| Visibility | **public** |
| Default branch | `main` |
| Squash merge | **allowed** |
| Merge commit | **disallowed** |
| Rebase merge | **disallowed** |
| Delete branch on merge | **enabled** |
| Squash commit title | `PR_TITLE` |
| Squash commit message | `PR_BODY` |
| Wiki | disabled |
| Projects | disabled |
| Secret scanning | enabled |
| Secret scanning push protection | enabled |

The repository is **public**. Everything described in
[`../../SECURITY.md`](../../SECURITY.md) and
[`../diagnostics/PRIVACY.md`](../diagnostics/PRIVACY.md) follows from that
single fact: nothing that identifies a person, an account or a real
conversation may enter it.

---

## 2. Branch protection: the `protect-main` ruleset

Branch protection is a **repository ruleset**, not the legacy branch-protection
API.

| Field | Value |
|---|---|
| Name | `protect-main` |
| Ruleset id | `23748787` |
| Target | `branch` |
| Source type | `Repository` |
| Enforcement | `active` |
| Included refs | `refs/heads/main` |
| Excluded refs | none |
| Bypass actors | none |
| `current_user_can_bypass` | **`never`** |

The rules in force:

| Rule | Effect |
|---|---|
| `deletion` | Deleting `refs/heads/main` is blocked |
| `non_fast_forward` | Force-pushing `main` is blocked |
| `pull_request` | A pull request is required; see the parameters below |
| `required_status_checks` | Four checks must pass; see the contexts below |

`pull_request` parameters as configured:

| Parameter | Value | Why |
|---|---|---|
| `required_approving_review_count` | **0** | Solo-maintainer repository. A required approval would be unmeetable |
| `dismiss_stale_reviews_on_push` | false | Follows from the zero-approval count |
| `required_reviewers` | `[]` | — |
| `require_code_owner_review` | false | — |
| `require_last_push_approval` | false | — |
| `required_review_thread_resolution` | false | — |
| `allowed_merge_methods` | `["squash"]` | Matches the repository setting: one commit per PR on `main` |

`required_status_checks` parameters as configured:

| Parameter | Value |
|---|---|
| `strict_required_status_checks_policy` | `false` |
| `do_not_enforce_on_create` | `false` |
| `required_status_checks` | exactly four contexts, listed below |

The four required contexts, and the CI job each one comes from in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):

| Required context | Job id | Workflow |
|---|---|---|
| `Typecheck and lint` | `quality` | `CI` |
| `Unit and integration tests` | `test` | `CI` |
| `Build and verify artifact` | `build` | `CI` |
| `Browser tests` | `browser` | `CI` |

These strings are the jobs' `name:` fields. **Renaming a job in `ci.yml` breaks
the required-check gate** — the context the ruleset waits for would never be
reported, and no PR could merge. If you rename a job, update the ruleset in the
same change.

`strict_required_status_checks_policy: false` means the branch does not have to
be up to date with `main` before merging. With `delete_branch_on_merge` and a
single maintainer that is a deliberate trade: it avoids a rebase-and-re-run cycle
on every merge. Squash merge means the PR's own CI result is the one that lands.

### The owner cannot bypass

`current_user_can_bypass` is `never` and `bypass_actors` is empty. The
repository owner pushing directly to `main` is refused, exactly like anyone else.
This is intentional: the gate that protects `main` must not have an exception
that only the person most likely to be in a hurry can use.

---

## 3. Branch naming conventions

Branch names in use:

| Prefix | For | Example |
|---|---|---|
| `diag/<topic>` | Diagnostics, tracing, bundle format, analyzer | `diag/complete-live-observability` |
| `fix/<topic>` | A defect fix — preferably with the regression test that proves it | `fix/duplicate-intent-on-recovery` |
| `hardening/<topic>` | Safety invariants, gates, refusal paths | `hardening/storage-unhealthy-gate` |
| `test/<topic>` | Tests and fixtures only | `test/t44-chat-identity-fixture` |
| `live/<scenario>` | Live-scenario work tied to a matrix row | `live/t00-install-diagnostic-build` |
| `docs/<topic>` | Documentation only | `docs/github-workflow` |

Rules:

- One topic per branch. A branch that fixes a defect **and** refactors a module
  is two branches.
- A fix branch carries the regression test that fails without the fix. See
  [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
- A `live/<scenario>` branch names the scenario id from
  [`../live-testing/TEST_MATRIX.md`](../live-testing/TEST_MATRIX.md). It contains
  the fix and the sanitized fixture — **never** the bundle. Bundles are private
  evidence and are gitignored.

---

## 4. The required flow

```
main (up to date)
  │
  ├─ git switch main && git pull --ff-only
  ├─ git switch -c <prefix>/<topic>
  ├─ edit, commit
  ├─ git push -u origin <prefix>/<topic>
  ├─ gh pr create --fill --base main
  ├─ wait for CI: gh pr checks <n> --watch        # all four contexts green
  ├─ gh pr merge <n> --squash --delete-branch
  └─ git switch main && git pull --ff-only
```

Every step is load-bearing:

1. **Branch from current `main`.** `git pull --ff-only` first, so the branch
   starts from what is actually on the remote.
2. **Commit.** Small, descriptive commits. A squash merge collapses them, so the
   value of a good message is in review, not in the permanent history.
3. **Push the branch.** Direct pushes to `main` are refused by the ruleset.
4. **Open a pull request.** Required by the `pull_request` rule.
5. **Wait for CI.** The four required contexts must be reported and green. Use
   `--watch`; do not poll by hand and do not merge on the strength of a local
   `pnpm check` alone.
6. **Squash merge.** The only permitted merge method. The PR title and body
   become the commit message (`squash_merge_commit_title: PR_TITLE`,
   `squash_merge_commit_message: PR_BODY`), so write them as the commit message
   you want on `main`.
7. **Delete the branch.** Set automatically by `delete_branch_on_merge: true`;
   `--delete-branch` states it explicitly.
8. **Pull `main`.** Otherwise the next branch starts from a stale base.

---

## 5. The commands

### Inspect the configuration

Read the ruleset list, then the ruleset itself:

```bash
gh api repos/jacek4yang/jobpilot/rulesets
gh api repos/jacek4yang/jobpilot/rulesets/23748787
```

The second command returns the full rule set including the `pull_request` and
`required_status_checks` parameters and `current_user_can_bypass`.

Read the repository settings:

```bash
gh api repos/jacek4yang/jobpilot \
  --jq '{visibility, default_branch, allow_squash_merge, allow_merge_commit,
         allow_rebase_merge, delete_branch_on_merge, squash_merge_commit_title,
         squash_merge_commit_message, has_wiki, has_projects, security_and_analysis}'
```

### Inspect a pull request

```bash
gh pr checks <n>            # the current state of the required contexts
gh pr checks <n> --watch    # block until they resolve
gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup
```

`statusCheckRollup` is the authoritative view: it shows the contexts GitHub is
actually gating on, which is what the ruleset matches against.

Watch a specific workflow run instead:

```bash
gh run list --workflow=ci.yml --limit 10
gh run watch <run-id>
```

### Merge

```bash
gh pr merge <n> --squash --delete-branch
```

Do **not** pass `--admin`. The ruleset reports `current_user_can_bypass: never`
precisely so that this flag has nothing to override, and reaching for it is a
signal that something is wrong with the change, not with the gate.

### Releases

Releases are tag-driven and are **not** part of this workflow. Pushing a semver
tag matching `package.json`'s `version` triggers
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) (workflow
name `Release`, job `Build and publish`), which re-runs the gates, verifies the
tag equals the package version, writes `dist/SHA256SUMS`, and creates a GitHub
Release. The tag must match `package.json` character for character.

---

## 6. What an operator must not do

These are not style preferences. Each one either bypasses a gate or produces a
history that cannot be attributed to a reviewed change.

| Never | Why |
|---|---|
| **Push directly to `main`** | Refused by the ruleset (`pull_request` rule, `deletion`, `non_fast_forward`, and no bypass). Do not look for a way around it |
| **Force-push `main`** | Blocked by `non_fast_forward`. A force-push rewrites shared history and can discard a merged fix without review |
| **Merge a red PR** | The four required contexts exist to stop exactly this. A red `Browser tests` job means the built bundle does something the safety specs forbid |
| **Weaken or remove a required status check to get a merge through** | The check is the gate. If it is wrong, fix the check (or the job name) in its own reviewed PR — never in the PR it is blocking |
| **Rename a CI job without updating the ruleset** | The required context would never be reported and no PR could ever merge. See §2 |
| **Enable merge commits or rebase merges** | `allowed_merge_methods` is `["squash"]`. One commit per PR is what makes `main` bisectable |
| **Use `--admin` to merge** | Nothing to bypass by design. See §5 |
| **Commit a diagnostic bundle, a real page capture or any run artefact** | The repository is public. See [`../../SECURITY.md`](../../SECURITY.md) §3 and [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) §5 |

A blocked merge is information. It is never an obstacle to route around.

---

## 7. Related documents

| Document | Covers |
|---|---|
| [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) | Setup, gates, test requirements, privacy rules for contributions |
| [`../../SECURITY.md`](../../SECURITY.md) | Reporting, what must never be posted, supported versions |
| [`../../docs/development.md`](../development.md) | Every script, the fixture workflow, the quality gates |
| [`../diagnostics/PRIVACY.md`](../diagnostics/PRIVACY.md) | What diagnostics record and never record, and how that is enforced |
| [`../live-testing/RUNBOOK.md`](../live-testing/RUNBOOK.md) | The live-scenario procedure and where bundles go |
| [`../live-testing/PROGRESS.md`](../live-testing/PROGRESS.md) | Live-scenario progress tracking |
