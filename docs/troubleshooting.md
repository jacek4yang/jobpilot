# Troubleshooting

Practical guidance for the things that actually go wrong, in the order you are
likely to hit them.

Each entry gives the **symptom**, the **cause**, and **what to do**.

---

## The panel does not appear

**Symptom.** You loaded a `zhipin.com` tab and there is no `JP` launcher in the
corner, or nothing happens when you click it.

**Cause.** One of four things, roughly in order of likelihood.

1. The userscript is not running on this URL. The header matches only
   `https://www.zhipin.com/*` and `https://zhipin.com/*`. A subdomain such as
   `m.zhipin.com` or `www.zhipin.com` on a different port is not matched.
2. `general.enabled` is `false`, so the runtime stays completely inert. This is
   the master switch and it short-circuits everything.
3. `ui.showPanel` is `false`.
4. The script failed to install or to parse. A userscript manager silently
   refuses a file whose `==UserScript==` block is malformed.

**What to do.**

1. Confirm the script is installed and enabled in the userscript manager's
   dashboard, and that the manager's own log shows an execution on this page.
   Tampermonkey shows it in the dashboard's **Installed Userscripts** entry;
   Violentmonkey shows it under the script's **Log** tab.
2. Open the manager's console (`Ctrl+Shift+I` → Console) and look for a line from
   the `bootstrap` component. `JobPilot ready` is logged at `info` on success.
   A `bootstrap` error line names the failure.
3. Check the URL's exact hostname:
   ```js
   location.hostname      // must be exactly "zhipin.com" or "www.zhipin.com"
   ```
4. If `general.enabled` is false, set it back to `true` in the stored document.
   The key is `jobpilot:root:v1`; the field is `config.general.enabled`.

**Note.** The panel is deliberately **not** mounted on a page it does not
recognise. If you see the launcher but the page-kind chip reads `unknown`, that
is the fail-closed behaviour working, not a bug — see the next entry.

---

## The page kind reads `unknown`

**Symptom.** The panel mounts, but the page-kind chip (`.jobpilot-page-chip`,
`data-page-kind` attribute) says `unknown`, and Start does nothing useful.

**Cause.** `unknown` means the classifier found **no positive structural
evidence**. It is a deliberate first-class outcome, not an error. Specifically,
`detectBossPageKindFromSignals` fell all the way through:

- `supportedHost` was true (otherwise you would see `unsupported`),
- no CAPTCHA / risk-control / login signal fired,
- no `SELECTORS.guards.jobDetailRoot` match,
- no `SELECTORS.guards.jobListRoot` match,
- no cards parsed from any `SELECTORS.list.card` candidate,
- no empty-result marker.

**What to do.**

1. First, determine whether this is *correct*. On a page that genuinely is not a
   job list or a job detail — a profile page, a settings page, an interstitial —
   `unknown` is the right answer and nothing should be done about it.
2. If it is a job list that should be recognised, the cause is almost certainly
   that none of the card candidates matched:
   ```
   [data-jobpilot-card]  [itemprop='jobPosting']  ul.job-list > li.job-card  li.job-card
   ```
   Run this in the console to confirm:
   ```js
   console.table([
     "[data-jobpilot-card]", "[itemprop='jobPosting']",
     "ul.job-list > li.job-card", "li.job-card",
   ].map((s) => ({ selector: s, matches: document.querySelectorAll(s).length })));
   ```
   All four at zero on a page you believe is a job list is exactly the
   unverified-selector risk described in
   [`boss-adapter.md`](boss-adapter.md) §8.3.
3. **Do not "fix" this by adding a wildcard selector.** The registry's ordering
   exists for a reason, and a `[class*='...']` primary anchor is one of the
   patterns this project explicitly refuses to adopt.
4. If you have captured the live markup, promote the selector properly: update
   the entry's `confidence` and `note` in `src/adapters/boss/selectors.ts`, cite
   the evidence, and leave `automationReady`/`automationVerified` alone until the
   whole flow is confirmed.

**Related.** `unsupported.html` in the fixture suite reports `unknown`, not
`unsupported`, because the host gate does not fire on a supported hostname.
`unsupported` is only reachable from a non-BOSS origin. Do not be surprised by
that in a test.

---

## Discovery stops on a blocked page

**Symptom.** You start discovery and the panel replaces its body with a blocked
explanation. The reason is one of `CAPTCHA`, `RISK_CONTROL`, `LOGIN_REQUIRED`, or
`UNRECOGNISED PAGE STRUCTURE`.

**Cause.** The guard chain fired, or the page kind was one discovery refuses to
scan. `BLOCKING_PAGES` in `src/application/discovery.ts` is:

```ts
const BLOCKING_PAGES: readonly PageKind[] =
  ["captcha", "login-required", "unsupported", "unknown"];
```

The check runs **before any DOM work**, so nothing was touched. The same list
appears as `UNSCANNABLE_PAGES` in the orchestrator, so the two paths fail closed
identically.

The guards over-report on purpose. `[class*='risk']`, `[id*='captcha']` and the
visible-text fallbacks (`请完成安全验证`, `操作过于频繁`, `登录后查看`, …) will match
decorative or unrelated markup. A false positive costs you one manual click; a
false negative could drive automation through a verification page.

**What to do.**

1. **Read the reason first.** It is the largest text on the panel and it names
   the signal.
2. **If it is genuinely a CAPTCHA or a risk-control page, resolve it yourself in
   the page.** JobPilot will not dismiss, solve, retry through or navigate around
   it — that is a hard design invariant, not a missing feature. Complete the
   verification in the page, then press **Resume**.
3. **If it is `LOGIN_REQUIRED`, sign in again.** JobPilot never logs in on your
   behalf.
4. **If it is a false positive**, the diagnostic evidence tells you which
   selector matched. Toggle the guard entry's `confidence`/`note`, not the guard
   logic — the `[class*='...']` candidates are documented as the fragile part of
   the registry, and narrowing them is a real change that needs evidence.
5. **Resume always restarts from `scanning`.** The machine never resumes
   mid-action, because a half-completed apply must be re-verified from the top.

**One counter-intuitive case.** A page with both a CAPTCHA signal and a risk
signal classifies as `captcha`, because the CAPTCHA guard outranks risk control in
the precedence chain. And `risk-control` maps to `kind: "unknown"` (with
`reason: "risk-control-guard"`) — so you may see an "unrecognised page structure"
message whose underlying block reason is `risk-control`. The block reason in the
pause message is authoritative.

---

## A job was skipped and I want to know why

**Symptom.** A job you expected to be considered is not in the queue, or a queue
item is marked skipped.

**Cause.** One of the evaluation stages rejected it, or one of the dedup layers
fired. Skips are never silent — the reason is recorded — but it may be on a
different surface than you are looking at.

**What to do.**

1. **Read the rule trace.** Every accept and reject carries an ordered reason
   list; there is no score without reasons. Expand the row in **Matches** for the
   full trace:
   ```
   Score 86  (threshold 65)

   + 20  preferred skill "Rust" present
   + 10  salary 20-35K is above the target minimum of 15K
   -  —  score 63 is below the accept threshold of 70
   ```
2. **Check which stage decided.** `Match.decidedAt` is `"A"` or `"B"`. A
   stage-A rejection never opened the job, so the reason comes from card data
   only — and stage A is deliberately conservative: a card with no salary is
   **not** rejected for salary, because the card may simply not render it.
3. **Check the dedup layers.** The five layers, in order:
   ```
   1  platform state      "继续沟通" / "已沟通"  -> treat as contacted
   2  application history job id already contacted/verified
   3  live intent         an active intent exists for this job id
   4  outgoing message    the intended text already exists in the chat
   5  queue dedup         job id cannot be enqueued twice
   ```
   Layer 1 is the usual culprit, and it is deliberately conservative: when the
   platform's state is **ambiguous**, the job is skipped and labelled
   *already contacted (assumed)* so you can override it by hand. The policy is
   **prefer a false skip over a duplicate send**.
4. **Check the company and title blacklists.** A match on either rejects at stage
   A, before anything is opened.
5. **Check the exclude keywords.** Stage A checks title and company; stage B
   checks title, description, skills and requirements. The reason names the
   keyword that matched, so a too-broad exclude word is visible immediately.
6. **Check recruiter activity.** A contradictory set of activity labels resolves
   to the **least** active state, on purpose. If you have `skipUnknownActivity`
   on, an unreadable activity label skips the job.

---

## A send is marked `uncertain`

**Symptom.** A queue item shows the `uncertain` badge, and the panel says a
message may have been sent.

**Cause.** This is the designed behaviour, not a failure. `send-attempted` was
persisted and the send click was dispatched, but no outgoing message matching the
intended text was observed within the polling budget (default 10 s, polling every
250 ms). The click may have been lost; or it landed and the message rendered
differently than expected; or the count was read from a stale DOM.

**What to do.**

1. **Open the conversation and look.** This is the only way to resolve it.
   Nothing in JobPilot can substitute for your reading the actual chat.
2. **Do not re-run the job.** This is the one thing you must not do. Once an
   intent reaches `send-attempted`, `canClickSend` is `false` forever:
   ```ts
   export const canClickSend = (intent: CommunicationIntent): boolean =>
     intent.phase === "prepared" && intent.sendAttemptedAt === undefined;
   ```
   `dispatchSend` consults it first and returns `{ kind: "refused" }`. Re-running
   cannot produce a second message — but it also cannot help, and it muddies the
   history.
3. **Resolve it from the panel.** The two resolutions are **Mark as sent** and
   **Mark as not sent**, both recorded with the user's decision noted. An
   `uncertain` item cannot be retried, skipped or auto-cleared until you resolve
   it — that is the single most important queue behaviour.
4. **If you are unsure, treat it as sent.** A duplicate message to a recruiter is
   worse than a missed one, which is the same reasoning behind the dedup layers'
   preference for a false skip.

**Why `uncertain` and not `failed`?** Because "failed" would license a retry, and
a retry is exactly what must not happen. `SEND_OBSERVED` with a count that does
**not** exceed the baseline yields `uncertain`; `SEND_UNOBSERVED` yields
`uncertain`; `CHAT_CHANGED` mid-send yields `uncertain`; and an intent that
expires after a send yields `uncertain`. Four different roads, one destination,
so that no code path can round the outcome to a retryable failure.

**Related.** An *apply* that produces no confirmation evidence gets
`needs-confirmation` rather than `submitted`, and pauses with reason
`ambiguous-state`. Same principle, different flow: the click is not evidence.

---

## "JobPilot is active in another tab"

**Symptom.** The panel in this tab says JobPilot is running in another tab, or
JobPilot behaves in a second tab in a way you did not expect.

**Cause.** Two BOSS tabs must never drive the same queue. The `Lock` port in
`src/ports/lock.ts` exists for exactly this, and it is designed so a tab that
cannot take the lock renders **read-only** rather than queueing work it cannot
perform.

**What to do.**

1. **Use one tab.** This is the reliable answer today.
2. **Close the other tab.** A lease has a 30 s TTL and a 10 s heartbeat, so a
   crashed or closed tab's lease is reclaimable within one TTL. If a tab was
   force-killed, wait out the TTL rather than assuming the lock is stuck.
3. **If you intend to take over, be aware of what taking over must not do:**
   replay an ambiguous send. The new owner re-reads the live
   `CommunicationIntent`; `send-attempted` becomes `uncertain` and awaits you;
   anything earlier is abandoned safely.

**Be aware of the current implementation status.** The `Lock` port and a
deterministic `createMemoryLock` implementation both exist and are unit-tested,
and the lease defaults (`DEFAULT_LOCK_TTL_MS`, `DEFAULT_LOCK_HEARTBEAT_MS`) are
defined. **No `navigator.locks`-backed implementation is wired into bootstrap
yet.** In the running userscript today, two BOSS tabs are both live. Treat a
second BOSS tab as a genuine duplicate-send risk and close it.

---

## The build fails on `index.html`

**Symptom.** `pnpm build` fails complaining that it cannot resolve `index.html`,
or Vite reports no input, or the output is split into chunks instead of one file.

**Cause.** `vite-plugin-monkey` works by replacing Vite's default Rollup input
with the userscript entry point. If the plugin does not run — because the version
is incompatible with the installed Vite major — Vite falls back to its default
behaviour of looking for an `index.html` entry, which this project does not have.

The pairing in `package.json` is:

```json
"vite": "7.3.6",
"vite-plugin-monkey": "7.1.9"
```

vite-plugin-monkey 7.x requires Vite 7.x. A major mismatch on either side is the
usual cause of this failure.

**What to do.**

1. **Confirm the pair is intact.** Check `package.json` against the lockfile; a
   partially-applied upgrade is a common cause:
   ```bash
   pnpm why vite
   pnpm why vite-plugin-monkey
   ```
2. **Reinstall from the lockfile** rather than letting a range resolve:
   ```bash
   pnpm install --frozen-lockfile
   ```
3. **Do not "fix" it by adding an `index.html`.** That reintroduces Vite's
   default entry, splits the bundle, and breaks the single-file guarantee that
   `pnpm verify:dist` enforces (`single-runtime-file`). The `vite.config.ts`
   comment on `build.rollupOptions` says exactly this.
4. **Do not override `build.rollupOptions`.** Same reason.
5. If you must move a Vite major, move `vite-plugin-monkey` in the same change,
   and re-run `pnpm build && pnpm verify:dist` before anything else. The
   verification script will catch a bundle that became two files, gained a bare
   import, or acquired an external stylesheet.

**A related symptom.** If `pnpm verify:dist` reports `single-runtime-file:
expected exactly one runtime file, found 2`, you have almost certainly introduced
a second entry point or a dynamic import. The runtime is meant to be a single
file with no dynamic import chunks.

---

## Playwright browsers are missing

**Symptom.** `pnpm test:browser` fails with a message like *"Executable doesn't
exist at … Please run the following command to download new browsers"*, or the
browser launches and immediately dies.

**Cause.** Playwright ships its own browser builds and does not use your
installed Chrome. A fresh clone has the `@playwright/test` package but no browser
binaries.

**What to do.**

```bash
npx playwright install chromium
```

Add `--with-deps` on Linux when system libraries may be missing — that is what CI
runs:

```bash
npx playwright install --with-deps chromium
```

**Other browser-suite problems, in order of likelihood:**

1. **Every spec skips with a message about `dist/jobpilot.user.js`.** The browser
   suite drives the **built** bundle. Run `pnpm build` first. The fixture server
   returns a `404` with that hint, and specs skip with an actionable message
   rather than failing confusingly.
2. **The fixture server port is busy.** The suite expects `127.0.0.1:43117`.
   Locally it reuses an existing server (`reuseExistingServer: !process.env.CI`);
   in CI it does not. Kill a stale `node tests/browser/server.mjs` before
   re-running.
3. **The panel cannot be found.** It lives in an **open shadow root** at
   `div[data-jobpilot-host]`. Playwright pierces open shadow roots for CSS
   selectors, so `page.locator(".jobpilot-page-chip")` resolves from page level.
   `readPanelState()` in the harness reads the same values through `shadowRoot`
   as an independent cross-check. If a selector stops matching, read the real
   shadow tree — `.jobpilot-badge` was replaced by `.jobpilot-dot` at one point,
   and assertions inferred from source rather than observed in the DOM broke
   silently.
4. **A request to a non-loopback host fails the suite.** That is intentional.
   `fixture-smoke.spec.ts` installs a request listener and fails if any harness
   page reaches beyond loopback. If a spec you added hits a real URL, add a
   fixture instead.

**On the host mapping.** The browser harness loads from
`http://www.zhipin.com:43117` with
`--host-resolver-rules=MAP www.zhipin.com 127.0.0.1`. That maps the name to
loopback **before DNS resolution**, so no lookup happens and no packet leaves the
machine, while `location.hostname` genuinely is `www.zhipin.com` — which
satisfies the production host guard without weakening it. If the mapping is
missing from a spec's `launchOptions`, the host guard will correctly classify the
page as `unsupported` and the test will fail for a reason that looks nothing like
the actual problem.

---

## Storage is not persisting

**Symptom.** Settings and history reset every time you reload.

**Cause.** The `GM_getValue` / `GM_setValue` globals were not available, so
`createRuntimeDeps` fell back to `MemoryStorage`. This happens when the file is
loaded as a plain script rather than through a userscript manager, or when the
manager did not apply the `@grant` directives.

**What to do.**

1. Check the console for the warning `bootstrap: GM storage unavailable; using
   in-memory storage`. The log entry names the consequence: *"settings and
   application history will not survive a reload"*.
2. Confirm the installed script's header lists all four grants:
   ```
   // @grant GM_getValue
   // @grant GM_setValue
   // @grant GM_deleteValue
   // @grant GM_registerMenuCommand
   ```
   `pnpm verify:dist` fails the build if this set is wrong, so a mismatch means
   the installed file is not the built one.
3. Reinstall from `dist/jobpilot.user.js` rather than pasting an edited copy.

**Note on key enumeration.** `GM_listValues` is not part of every host's API
surface. When it is missing, `keys()` returns an empty list rather than guessing.
Diagnostics and export will report "no keys", which is honest; it does not mean
storage is broken.

---

## The persisted config was rejected

**Symptom.** A warning on load says `config invalid: …` or `migration failed: …`,
and JobPilot has come up with defaults.

**Cause.** This is the fail-closed persistence policy working. The document under
`jobpilot:root:v1` is untrusted input: it may be truncated, hand-edited, written
by a future version, or hostile. Every load runs migration then validation, and
neither ever throws — they return a result and the repository falls back to
defaults with a warning.

The two cases behave differently and the distinction matters:

- **`config invalid`** — migration succeeded, validation found problems. Missing
  fields took their defaults; wrong-typed fields are errors, because coercing
  `"yes"` into `true` would hide your real intent. Your history is intact.
- **`migration failed`** — the document as a whole was refused. This happens when
  `schemaVersion` is present but not an integer, is below 1, or **is newer than
  this build supports**. A newer document is refused rather than downgraded,
  because guessing at a downgrade would discard fields this build cannot see.

**What to do.**

1. **Do not panic about your history.** Migrations are additive and never destroy
   user data. A missing section is filled from defaults, never removed.
2. **Read the collected errors.** Validation reports *everything* it found, not
   just the first problem, precisely so you can fix them in one pass.
3. **If the document came from a newer build**, do not hand-edit the version down.
   Wait for the newer build, or move the document aside. Downgrading by editing
   the number is exactly the data-loss path the refusal exists to prevent.
4. **If you want a clean slate**, `createRepository(...).clear()` deletes the key
   outright. That is the honest, explicit way to reset — not by corrupting the
   document.
