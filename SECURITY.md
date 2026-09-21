# Security policy

How to report a security or privacy issue in JobPilot, what must never be posted
publicly, and what the project does and does not do by design.

JobPilot is a browser userscript that runs inside a page you opened on BOSS
Zhipin. It has no server, no account and no telemetry. It handles content that is
private to you — your resume, your conversations, your session — so privacy is
treated here as a security property, not as a preference.

---

## 1. Reporting a vulnerability

**Use GitHub's private vulnerability reporting.** That is the primary and
preferred channel:

1. Open the repository's **Security** tab:
   <https://github.com/jacek4yang/jobpilot/security>
2. Choose **Report a vulnerability** to open a private security advisory.
3. Describe the issue, the version or commit, and the impact.

A private advisory is visible only to you and the maintainer until it is
published. That is what makes it safe to include details that must not appear in
a public issue.

**There is no dedicated security email address.** If one is added later, it will
be listed in this section by the maintainer; do not assume an address is live
until it appears here.

Do **not** open a public issue, a public PR or a discussion for a security or
privacy problem. A public report of a redaction bypass is itself a disclosure of
whatever the bypass exposes.

### What to include

- The affected version or commit (`git rev-parse HEAD`, or the version in the
  userscript header).
- The class of issue: a redaction bypass, a safety-invariant bypass, a way to
  trigger an unintended action, a dependency problem.
- The smallest reproduction you can construct. A sanitized fixture or a
  hand-written description is worth more than a bundle.
- Which artefact shows it — a file name and field name inside a bundle is
  usually enough. See §3 before attaching anything.

### What to expect

This is a pre-1.0 project maintained by one person. There is no response-time
commitment. What you can expect:

- An acknowledgement on the advisory.
- An assessment of whether the report is a real defect, and why.
- A fix with a regression test, or a written explanation of why the behaviour is
  intended.
- Credit on the published advisory, unless you prefer otherwise.

---

## 2. Scope

**In scope.** Anything that lets JobPilot:

- record, export or transmit data it claims never to record
  ([`docs/diagnostics/PRIVACY.md`](docs/diagnostics/PRIVACY.md) §3 lists the
  categories: cookies, tokens, session ids, passwords, resume contents, chat
  history, recruiter messages, user drafts, full message bodies, complete page
  HTML);
- perform an action the user did not ask for, or bypass one of the safety
  invariants in `src/application/gates.ts`;
- send into a conversation that was not verified as the intended one, or send a
  second time after a send attempt was already persisted;
- write outside the destination directory the operator granted, or claim
  filesystem access it does not have;
- weaken the host guard so the script runs on a page it should not.

**Out of scope.** The following are not vulnerabilities:

- The fact that the BOSS adapter is unverified against the live site. That is the
  documented state of the project — see §5 and
  [`README.md` §Known limitations](README.md#known-limitations).
- A selector that does not match the live DOM. That is a bug; report it as an
  ordinary issue, or via [`docs/live-testing/FAILURE_TRIAGE.md`](docs/live-testing/FAILURE_TRIAGE.md).
- The behaviour of BOSS Zhipin itself, including its own CAPTCHA or risk
  controls.
- The fact that a user who installs the diagnostic build and exports a bundle
  then chooses to share it. That is the user's decision; §3 covers how to make it
  a safe one.

---

## 3. What must never be posted publicly

The repository is public. Everything in this list must stay out of issues, pull
requests, discussions, commit messages, code comments and fixtures:

| Never post | Why |
|---|---|
| **Real diagnostic bundles (ZIPs)** | Route history, timings, selector outcomes and configuration from a real account. Treat as a machine log from your own machine |
| **Cookies, tokens, authorization headers, session identifiers** | Direct account compromise |
| **Real resume content** | Personal data, and often a third party's data too |
| **Private chat or recruiter messages** | Two-party content that is not yours to publish |
| **Complete captured BOSS HTML** | Contains the page as it was, including any account-specific and personal content in it |
| **Personal account identifiers** | User ids, phone numbers, national id numbers, email addresses |
| **Local absolute paths** | `C:\Users\<name>\...` discloses a name and a machine layout for no diagnostic benefit |

If you need to show a structure, reduce it to the structural fact and sanitize it
first — see §4 and
[`CONTRIBUTING.md` §5](CONTRIBUTING.md#5-privacy-requirements). The rule is:
**reduce to the minimum that reproduces it, sanitize that, commit only that.**

If a secret has already been committed, treat it as compromised. Rotate it. The
commit is in a public history and removing the file does not remove the exposure.
Enable push protection is on for this repository and will refuse the most common
shapes, but it is not a substitute for not staging the file.

---

## 4. Diagnostic bundles and privacy

JobPilot's diagnostic bundle is **designed to be safe to share with a
developer**. That is a design goal with a CI gate behind it, not a promise in
prose. The full policy is in
[`docs/diagnostics/PRIVACY.md`](docs/diagnostics/PRIVACY.md); the parts that
matter for reporting are:

- **Redaction happens at write time, in the recorder.** Values are sanitized
  before they enter any buffer, not when the bundle is exported. The recorder's
  `toSafeData` runs on every write path, so a value that never enters a buffer
  cannot leak through a later export path. A second redaction pass runs at export
  time as defence in depth.
- **Content-bearing fields are replaced by a fingerprint** (a length plus a
  digest), not deleted, so questions like "was the draft empty?" and "did the
  message change between runs?" stay answerable without reading the content.
- **Credentials never enter the buffer at all.** Keys matching `cookie`, `token`,
  `password`, `secret`, `credential` or `authorization` are replaced outright;
  every string is additionally scanned for credential shapes and scrubbed.
- **A privacy test runs as a CI gate.** It plants fake secrets in every write
  path and asserts none of them appears anywhere in the archive. A failure blocks
  the change.

**A bundle is still sensitive until you have reviewed it.** The claim above is
about specific classes of data, and the test asserts those classes, in the sinks
that exist today. It is not a claim that no possible secret can ever leak. So:

1. Export the bundle and keep it locally.
2. Open it yourself and look at what is in it — at minimum `summary.txt`,
   `environment.json` and `config.redacted.json`.
3. Decide what the report actually needs. Usually it needs a field name, a
   selector outcome and a sequence number, not the archive.
4. Attach the whole bundle to a **private security advisory**, not to a public
   issue. Even then, only if the maintainer asks for it.
5. **Never attach a bundle to a public issue or PR.** `*.diagnostic.zip`,
   `*.diag.zip` and `test-results/` are gitignored for this reason; the
   gitignore is a backstop, not permission.

If you believe a bundle contains something it should not, **stop and report it as
a defect in the redaction policy**. Do not share the bundle. Keep it, and say
which field and which file. The correct fix is a new redaction rule plus a new
assertion in the privacy test — not a manual edit of the archive.

---

## 5. Non-goals that are also security properties

These are things JobPilot **does not do**. They are stated as design constraints,
and a change that weakens any of them is a security regression:

| Non-goal | What that means |
|---|---|
| **Does not bypass CAPTCHA** | On a CAPTCHA or security-verification page JobPilot stops. There is no code path that solves, dismisses, retries through or navigates around a verification page, and no interaction with verification widgets |
| **Does not circumvent anti-bot controls** | JobPilot observes and reports the state it finds. It does not spoof headers, rotate identifiers, defeat rate limiting or evade detection. Rate-limit and risk-control responses are blocking states, not obstacles |
| **Does not spoof fingerprints** | There is no fingerprint spoofing and no browser fingerprinting. The lock tracer's `tabId` is opaque by design; `environment.json` records browser and page context without identifying the user |
| **Does not upload anything, anywhere** | **Zero telemetry, no server.** The configuration schema has a `telemetryEnabled` field that is hard-defaulted to `false` with no code path that turns it on. A bundle is written to a local destination you choose and is never transmitted. There is no account, no backend and no network egress of JobPilot's own |
| **Does not load remote code** | The built userscript is self-contained. `pnpm verify:dist` fails the build if a `@require`, `@resource` or `eval(` appears in the artifact |
| **Does not act without being asked** | Discovery never enqueues. A score always carries its rule trace. An irreversible action requires a persisted intent, a verified conversation, healthy storage and queue ownership |

One consequence, stated plainly: **with no telemetry there is no crash
reporting.** If something fails on the live site, diagnostics stay in your
browser and only your own exported bundle will say what happened. That is the
accepted cost of the property above.

---

## 6. Supported versions

- JobPilot is **pre-1.0**. The current version is `0.1.0`.
- **Only the tip of `main` is supported.** There are no maintained release
  branches and no backports. Fixes land on `main` and are released as a tag
  matching `package.json`'s version.
- **No version has been verified against the live BOSS Zhipin site.** No
  JobPilot build has been run against the real site. Every selector is
  `fixture-only` or `unverified`, and `BOSS_METADATA.automationVerified` is the
  literal `false`. Do not treat any release as verified for live use.
- A fix for a reported vulnerability will be made on `main` and tagged. There is
  no separate security-release channel.

---

## 7. Note for contributors

This repository is public, and contributions are public the moment they are
pushed to a branch. That applies to documentation and issue comments as much as
to code.

- **Do not commit real-site evidence.** No bundles, no captured HTML, no
  screenshots of a real account, no session identifiers, no local absolute paths.
  Only sanitized, minimal fixtures under
  `tests/fixtures/boss/regression/<issue-id>/` may be committed, and only after
  reduction and sanitization.
- **Do not weaken a safety invariant to make a test pass.** If a production guard
  blocks a test, set up the test environment to satisfy the guard. The browser
  suite already does this by mapping the production host name to loopback rather
  than weakening the guard.
- **Do not add a diagnostics sink outside the recorder.** The recorder is the
  single write path, and it is where write-time redaction happens. A parallel
  logger or export path bypasses it entirely.
- **Do not add remote code loading**, telemetry, or anything that transmits data
  off the machine.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full set of rules and the
commands that enforce them.

---

## 8. Related documents

| Document | Covers |
|---|---|
| [`docs/diagnostics/PRIVACY.md`](docs/diagnostics/PRIVACY.md) | What diagnostics record and never record, enforced in code |
| [`docs/diagnostics/BUNDLE_FORMAT.md`](docs/diagnostics/BUNDLE_FORMAT.md) | The bundle archive: files, checksums, what each section holds |
| [`docs/diagnostics/ARCHITECTURE.md`](docs/diagnostics/ARCHITECTURE.md) | The diagnostics design and the governing principle |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, gates, privacy requirements for contributions |
| [`docs/development/GITHUB_WORKFLOW.md`](docs/development/GITHUB_WORKFLOW.md) | Branch protection, required checks, the merge flow |
| [`docs/live-testing/RUNBOOK.md`](docs/live-testing/RUNBOOK.md) | The live-scenario procedure and bundle handling |
